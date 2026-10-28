// MINEWATCH ground station (ESP32 + Ra-02 SX1278 LoRa, 433 MHz)
//
// Receives compact CSV packets from the CubeSat over LoRa, adds link quality
// (RSSI/SNR), and prints one JSON packet per line over USB at 115200 baud.
// The dashboard reads those lines with the "Connect ground station" button.
//
// TEST_MODE 1: no LoRa needed. Prints fake telemetry + detections so the
//              USB -> dashboard chain can be tested before the CubeSat exists.
// TEST_MODE 0: real ground station. Needs the "LoRa" library by Sandeep Mistry
//              (Arduino IDE > Library Manager > search "LoRa").
//
// CubeSat packet formats (must stay under 255 bytes, keep them short):
//   T,temp_c,solar_mw,power_mw,bus_v,current_ma,batt_v,soc,ldr,roll,pitch,yaw,cam_on,sd_records
//   D,lat,lon,conf

#define TEST_MODE 1

#if !TEST_MODE
#include <SPI.h>
#include <LoRa.h>

// Ra-02 wiring to ESP32 (VSPI). Ra-02 runs on 3.3 V only.
const int PIN_SCK = 18, PIN_MISO = 19, PIN_MOSI = 23;
const int PIN_NSS = 5, PIN_RST = 14, PIN_DIO0 = 2;
const long LORA_FREQ = 433E6;
const int LORA_SYNC = 0x12;   // must match the CubeSat
#endif

// ---------------------------------------------------------------- helpers

// Split a CSV line into fields; returns the number of fields.
int splitCsv(String line, String *out, int maxFields) {
  int n = 0, start = 0;
  for (int i = 0; i <= (int)line.length() && n < maxFields; i++) {
    if (i == (int)line.length() || line[i] == ',') {
      out[n++] = line.substring(start, i);
      start = i + 1;
    }
  }
  return n;
}

void printTelemetry(String *f, int rssi, float snr) {
  // f[0] == "T"
  Serial.printf(
    "{\"type\":\"telemetry\",\"temp_c\":%s,\"solar_mw\":%s,\"power_mw\":%s,"
    "\"bus_v\":%s,\"current_ma\":%s,\"batt_v\":%s,\"soc\":%s,\"ldr\":%s,"
    "\"roll\":%s,\"pitch\":%s,\"yaw\":%s,\"cam_on\":%s,\"pass\":%s,"
    "\"sd_records\":%s,\"rssi\":%d,\"snr\":%.1f}\n",
    f[1].c_str(), f[2].c_str(), f[3].c_str(), f[4].c_str(), f[5].c_str(),
    f[6].c_str(), f[7].c_str(), f[8].c_str(), f[9].c_str(), f[10].c_str(),
    f[11].c_str(), f[12] == "1" ? "true" : "false", f[12] == "1" ? "true" : "false",
    f[13].c_str(), rssi, snr);
}

void printDetection(String *f) {
  Serial.printf("{\"type\":\"detection\",\"lat\":%s,\"lon\":%s,\"conf\":%s}\n",
                f[1].c_str(), f[2].c_str(), f[3].c_str());
}

void handleLine(const String &line, int rssi, float snr) {
  String f[16];
  int n = splitCsv(line, f, 16);
  if (n == 14 && f[0] == "T") printTelemetry(f, rssi, snr);
  else if (n == 4 && f[0] == "D") printDetection(f);
  else Serial.println("# unknown packet: " + line);   // '#' lines are ignored by the dashboard
}

// ---------------------------------------------------------------- test mode

#if TEST_MODE
// Two fake mines drifting slowly NW near the Strait of Hormuz lane.
// Real time is used for drift, so steps are tiny: ~1.5 km/h toward the NW.
double mineLat[2] = {26.30, 26.40};
double mineLon[2] = {56.95, 56.62};
unsigned long lastTele = 0, lastDet = 0;
int sd = 0, detIdx = 0;

String fakeTelemetry() {
  float t = millis() / 1000.0;
  bool sunlit = fmod(t, 90.0) < 58.0;          // 90 s "orbit", ~36% eclipse
  bool cam = fmod(t, 45.0) < 10.0;             // short imaging windows
  float solar = sunlit ? 1100 + random(-50, 50) : 0;
  float load = 380 + (cam ? 650 : 0) + random(0, 25);
  float soc = 70 + 10 * sin(t / 60.0);
  char buf[160];
  snprintf(buf, sizeof(buf), "T,%.2f,%d,%d,%.2f,%d,%.2f,%.1f,%d,%.1f,%.1f,%.1f,%d,%d",
           sunlit ? 23.5 + random(-5, 5) / 10.0 : 8.0 + random(-5, 5) / 10.0,
           (int)solar, (int)load, 5.0, (int)(load / 5.0), 3.3 + 0.009 * soc, soc,
           sunlit ? 3000 + random(-200, 200) : 120 + random(-40, 40),
           random(-20, 20) / 10.0, random(-15, 15) / 10.0, fmod(t * 2, 360.0),
           cam ? 1 : 0, ++sd);
  return String(buf);
}

String fakeDetection() {
  int i = detIdx++ % 2;
  mineLat[i] += 0.00003;                       // ~3 m north per sighting (16 s apart)
  mineLon[i] -= 0.00006;                       // ~6 m west per sighting
  char buf[64];
  snprintf(buf, sizeof(buf), "D,%.6f,%.6f,%.2f", mineLat[i], mineLon[i], 0.75 + random(0, 20) / 100.0);
  return String(buf);
}
#endif

// ---------------------------------------------------------------- setup / loop

void setup() {
  Serial.begin(115200);
  delay(500);
#if TEST_MODE
  Serial.println("# MINEWATCH ground station: TEST MODE (fake data)");
  randomSeed(esp_random());
#else
  SPI.begin(PIN_SCK, PIN_MISO, PIN_MOSI, PIN_NSS);
  LoRa.setPins(PIN_NSS, PIN_RST, PIN_DIO0);
  if (!LoRa.begin(LORA_FREQ)) {
    Serial.println("# LoRa init failed. Check wiring and 3.3 V supply");
    while (true) delay(1000);
  }
  LoRa.setSyncWord(LORA_SYNC);
  Serial.println("# MINEWATCH ground station: listening on 433 MHz");
#endif
}

void loop() {
#if TEST_MODE
  if (millis() - lastTele >= 1000) {
    lastTele = millis();
    handleLine(fakeTelemetry(), -100 + random(-6, 6), 7.0 + random(-10, 10) / 10.0);
  }
  if (millis() - lastDet >= 8000) {
    lastDet = millis();
    handleLine(fakeDetection(), 0, 0);
  }
#else
  int size = LoRa.parsePacket();
  if (size) {
    String line;
    while (LoRa.available()) line += (char)LoRa.read();
    handleLine(line, LoRa.packetRssi(), LoRa.packetSnr());
  }
#endif
}
