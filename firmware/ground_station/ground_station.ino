// MINEWATCH ground station (ESP32 + HC-12, 433 MHz)
//
// Receives compact CSV packets from the CubeSat over the HC-12 radio and the
// ESP-NOW (Wi-Fi) backup link (see PREFER_HC12 below for which one wins), and prints
// one JSON packet per line over USB at 115200 baud. The dashboard reads those
// lines with the "Connect ground station" button. The HC-12 gives no signal
// strength, so rssi and snr are sent as 0.
// Anything typed into the USB serial monitor (for example PING) is sent to the
// satellite.
//
// Wiring (jumper wires, no soldering): HC-12 VCC -> 3V3, GND -> GND,
// HC-12 TXD -> GPIO16, HC-12 RXD -> GPIO17, SET left unconnected.
//
// TEST_MODE 1: no radio needed. Prints fake telemetry + detections so the
//              USB -> dashboard chain can be tested before the CubeSat exists.
// TEST_MODE 0: real ground station. No extra library needed.
//
// CubeSat packet formats (must stay under 255 bytes, keep them short):
//   T,temp_c,solar_mw,power_mw,bus_v,current_ma,batt_v,soc,ldr,roll,pitch,yaw,cam_on,sd_records
//   D,lat,lon,conf

#define TEST_MODE 0

// Which link wins when both are working. The satellite sends every packet on both.
//   1 = HC-12 433 MHz radio first, ESP-NOW (Wi-Fi) as backup
//   0 = ESP-NOW first, HC-12 as backup
// The backup link's copy is ignored while the preferred link has delivered a packet
// in the last 5 s. If the preferred link goes quiet, the backup takes over by itself.
// A "# link: ..." line is printed whenever the link in use changes.
#define PREFER_HC12 1

#if !TEST_MODE
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
// Backup link: ESP-NOW packets from the satellite (channel 1). Kept in a small queue.
char nowQ[8][251]; volatile int nowHead = 0, nowTail = 0;
unsigned long lastNowMs = 0, lastHcMs = 0;     // when each link last delivered a packet
int activeLink = 0;                            // 1 = HC-12, 2 = ESP-NOW
const unsigned long LINK_HOLD_MS = 5000;
void onNowRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  int next = (nowHead + 1) % 8;
  if (next == nowTail) return;                 // queue full: drop
  int n = min(len, 250);
  memcpy(nowQ[nowHead], data, n); nowQ[nowHead][n] = 0;
  nowHead = next;
}
const int PIN_HC12_RX = 16, PIN_HC12_TX = 17;   // ESP32 RX <- HC-12 TXD, ESP32 TX -> HC-12 RXD
HardwareSerial HC12(2);
String hcBuf, usbBuf;
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
    "\"roll\":%s,\"pitch\":%s,\"yaw\":%s,\"cam_on\":%s,"
    "\"sd_records\":%s,\"rssi\":%d,\"snr\":%.1f}\n",
    f[1].c_str(), f[2].c_str(), f[3].c_str(), f[4].c_str(), f[5].c_str(),
    f[6].c_str(), f[7].c_str(), f[8].c_str(), f[9].c_str(), f[10].c_str(),
    f[11].c_str(), f[12] == "1" ? "true" : "false",
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

#if !TEST_MODE
// One received line from a link (1 = HC-12, 2 = ESP-NOW). Drops the backup link's
// copy while the preferred link is live, so the dashboard never sees doubles.
void useLine(const String &line, int link) {
  unsigned long now = millis();
  String f[16];                                  // only a complete, valid packet counts as "link live"
  int n = splitCsv(line, f, 16);
  bool packet = (n == 14 && f[0] == "T") || (n == 4 && f[0] == "D");
  if (packet) { if (link == 1) lastHcMs = now; else lastNowMs = now; }
  bool preferred = PREFER_HC12 ? link == 1 : link == 2;
  unsigned long otherMs = link == 1 ? lastNowMs : lastHcMs;
  bool otherLive = otherMs > 0 && now - otherMs < LINK_HOLD_MS;
  if (!preferred && otherLive) return;
  if (packet && link != activeLink) {
    activeLink = link;
    Serial.println(link == 1 ? "# link: HC-12 433 MHz" : "# link: ESP-NOW (Wi-Fi)");
  }
  if (line.startsWith("#")) Serial.println(line);   // satellite status messages
  else handleLine(line, 0, 0);
}
#endif

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
  HC12.begin(9600, SERIAL_8N1, PIN_HC12_RX, PIN_HC12_TX);
  Serial.println("# MINEWATCH ground station: HC-12 listening on 433 MHz (channel 1, 9600)");
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_promiscuous(false);
  if (esp_now_init() == ESP_OK) { esp_now_register_recv_cb(onNowRecv); Serial.println("# ESP-NOW backup link listening"); }
  else Serial.println("# ESP-NOW init failed");
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
  while (nowTail != nowHead) {                           // ESP-NOW packets
    String line = String(nowQ[nowTail]);
    nowTail = (nowTail + 1) % 8;
    line.trim();
    if (line.length()) useLine(line, 2);
  }
  while (HC12.available()) {                             // HC-12 packets
    char c = HC12.read();
    if (c == '\n') {
      hcBuf.trim();
      if (hcBuf.length()) useLine(hcBuf, 1);
      hcBuf = "";
    } else if (c != '\r' && hcBuf.length() < 200) hcBuf += c;
  }
  while (Serial.available()) {                            // commands to the satellite
    char c = Serial.read();
    if (c == '\n') { usbBuf.trim(); if (usbBuf.startsWith("AT")) HC12.print(usbBuf); else if (usbBuf.length()) HC12.println(usbBuf); usbBuf = ""; }
    else if (c != '\r') usbBuf += c;
  }
#endif
}
