// MINEWATCH CubeSat flight computer (ESP32 DevKit, 38-pin) - Team H, SatForge UAE 2026
//
// Wiring matches the printed deck boards (see build guide):
//   I2C  SDA 21, SCL 22  -> INA219 (0x40, deck 1) + MPU-6050 (0x68, deck 3)
//   HC-12 radio          -> UART1: ESP32 RX 19 <- HC-12 TXD, ESP32 TX 18 -> HC-12 RXD, SET 5
//   ESP32-CAM link       -> UART2: ESP32 RX 16 <- CAM U0T, ESP32 TX 17 -> CAM U0R
//   DHT-22 data 23, LDR divider 34 (analog)
//
// Radio packets (one CSV line each, same format the ground station expects):
//   T,temp_c,solar_mw,power_mw,bus_v,current_ma,batt_v,soc,ldr,roll,pitch,yaw,cam_on,sd_records
//   D,lat,lon,conf
// Commands accepted over the radio or USB serial: PING (satellite answers "# pong").
//
// Wi-Fi: the satellite runs an access point "MINEWATCH-SAT" (password minewatch).
// Open http://192.168.4.1 for live telemetry as JSON.
//
// Libraries (Arduino IDE > Library Manager):
//   "Adafruit INA219", "DHT sensor library" (Adafruit)
// Board: "ESP32 Dev Module". Upload speed 921600 or 115200.

#include <Wire.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <WebServer.h>
#include <Adafruit_INA219.h>
#include <DHT.h>

// ---------------------------------------------------------------- pins
const int PIN_SDA = 21, PIN_SCL = 22;
const int PIN_HC12_RX = 19, PIN_HC12_TX = 18, PIN_HC12_SET = 5;
const int PIN_CAM_RX = 16, PIN_CAM_TX = 17;
const int PIN_DHT = 23, PIN_LDR = 34;

const unsigned long TELEMETRY_MS = 2000;

HardwareSerial HC12(1);
HardwareSerial CAM(2);
Adafruit_INA219 ina219;
DHT dht(PIN_DHT, DHT22);
WebServer web(80);

bool inaOk = false, mpuOk = false;
float roll = 0, pitch = 0, yaw = 0;
unsigned long lastGyro = 0, lastTele = 0, lastCamMsg = 0;
long sdRecords = 0;
float lastTemp = NAN;
String lastTeleLine = "";

// ---------------------------------------------------------------- MPU-6050 (no library)
const uint8_t MPU = 0x68;
float gzBias = 0;

bool mpuBegin() {
  Wire.beginTransmission(MPU);
  Wire.write(0x6B); Wire.write(0);          // wake up
  if (Wire.endTransmission() != 0) return false;
  Wire.beginTransmission(MPU);
  Wire.write(0x1B); Wire.write(0x08);       // gyro +-500 deg/s
  Wire.endTransmission();
  // keep the board still for 1 s at start-up: average the gyro to remove its offset
  delay(300);                               // let the gyro settle after wake-up
  float sum = 0; int n = 0;
  for (int i = 0; i < 200; i++) {
    Wire.beginTransmission(MPU); Wire.write(0x47);
    if (Wire.endTransmission(false) == 0 && Wire.requestFrom(MPU, (uint8_t)2) == 2) {
      int16_t raw = (Wire.read() << 8) | Wire.read();
      sum += raw / 65.5; n++;
    }
    delay(5);
  }
  if (n) gzBias = sum / n;
  return true;
}

void mpuRead() {
  Wire.beginTransmission(MPU);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return;
  if (Wire.requestFrom(MPU, (uint8_t)14) != 14) return;
  int16_t v[7];
  for (int i = 0; i < 7; i++) v[i] = (Wire.read() << 8) | Wire.read();
  float ax = v[0] / 16384.0, ay = v[1] / 16384.0, az = v[2] / 16384.0;
  float gz = v[6] / 65.5 - gzBias;          // deg/s at +-500, start-up offset removed
  unsigned long now = millis();
  float dt = lastGyro ? (now - lastGyro) / 1000.0 : 0;
  lastGyro = now;
  roll = atan2(ay, az) * 57.2958;
  pitch = atan2(-ax, sqrt(ay * ay + az * az)) * 57.2958;
  if (fabs(gz) < 1.5) gz = 0;               // ignore slow drift below 1.5 deg/s
  yaw = fmod(yaw + gz * dt + 360.0, 360.0);
}

// ---------------------------------------------------------------- radio helpers
// Backup link: every packet is also broadcast over ESP-NOW (Wi-Fi radio, channel 1)
uint8_t BCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
bool nowOk = false;

void radioSend(const String &line) {
  HC12.println(line);
  if (nowOk) esp_now_send(BCAST, (const uint8_t *)line.c_str(), min((int)line.length(), 250));
  Serial.println("TX " + line);
}

void handleCommand(String cmd) {
  cmd.trim();
  cmd.toUpperCase();
  if (cmd == "PING") radioSend("# pong");
}

// Lines from the ESP32-CAM: "D,lat,lon,conf" detections and "S,records" status.
void handleCamLine(String line) {
  line.trim();
  if (line.length() == 0) return;
  lastCamMsg = millis();
  if (line.startsWith("#")) {                                // camera status/debug
    Serial.println("CAM " + line);
    if (line.startsWith("# centre")) radioSend("CAM " + line);   // also to the ground, for colour tuning
  }
  if (line.startsWith("D,")) radioSend(line);
  else if (line.startsWith("S,")) sdRecords = line.substring(2).toInt();
}

String readLine(Stream &s, String &buf) {
  while (s.available()) {
    char c = s.read();
    if (c == '\n') { String out = buf; buf = ""; return out; }
    if (c != '\r' && buf.length() < 120) buf += c;
  }
  return "";
}

// ---------------------------------------------------------------- telemetry
String buildTelemetry() {
  float busV = 0, shuntmV = 0, mA = 0, mW = 0;
  if (inaOk) {
    busV = ina219.getBusVoltage_V();
    shuntmV = ina219.getShuntVoltage_mV();
    mA = ina219.getCurrent_mA();
    mW = ina219.getPower_mW();
  }
  float battV = busV + shuntmV / 1000.0;
  float soc = constrain((battV - 3.3) / (4.2 - 3.3) * 100.0, 0, 100);
  float t = dht.readTemperature();
  if (!isnan(t)) lastTemp = t;
  int ldr = analogRead(PIN_LDR);                    // 0..4095, higher = brighter
  int solarEst = map(ldr, 0, 4095, 0, 1200);        // estimate only: no sensor on the panel line
  bool camOn = lastCamMsg > 0 && millis() - lastCamMsg < 5000;
  char buf[180];
  snprintf(buf, sizeof(buf), "T,%.2f,%d,%d,%.2f,%d,%.2f,%.1f,%d,%.1f,%.1f,%.1f,%d,%ld",
           isnan(lastTemp) ? -99.0 : lastTemp, solarEst, (int)mW, busV, (int)mA, battV, soc,
           ldr, roll, pitch, yaw, camOn ? 1 : 0, sdRecords);
  return String(buf);
}

void handleRoot() {
  web.send(200, "application/json",
           "{\"last_packet\":\"" + lastTeleLine + "\",\"ina219\":" + (inaOk ? "true" : "false") +
           ",\"mpu6050\":" + (mpuOk ? "true" : "false") + "}");
}

// ---------------------------------------------------------------- setup / loop
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("# MINEWATCH flight computer starting");

  Wire.begin(PIN_SDA, PIN_SCL);
  inaOk = ina219.begin();
  mpuOk = mpuBegin();
  dht.begin();
  analogReadResolution(12);

  pinMode(PIN_HC12_SET, OUTPUT);
  digitalWrite(PIN_HC12_SET, HIGH);         // HIGH = normal transparent mode
  HC12.begin(9600, SERIAL_8N1, PIN_HC12_RX, PIN_HC12_TX);
  CAM.begin(115200, SERIAL_8N1, PIN_CAM_RX, PIN_CAM_TX);

  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP("MINEWATCH-SAT", "minewatch", 1);
  WiFi.setTxPower(WIFI_POWER_8_5dBm);       // short range is enough; lowers current peaks on the battery
  if (esp_now_init() == ESP_OK) {
    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, BCAST, 6);
    peer.channel = 1;
    peer.ifidx = WIFI_IF_AP;
    peer.encrypt = false;
    nowOk = esp_now_add_peer(&peer) == ESP_OK;
  }
  web.on("/", handleRoot);
  web.begin();

  Serial.printf("# ESP-NOW %s", nowOk ? "OK, " : "FAILED, ");
  Serial.printf("# INA219 %s, MPU-6050 %s, Wi-Fi AP %s\n", inaOk ? "OK" : "MISSING",
                mpuOk ? "OK" : "MISSING", WiFi.softAPIP().toString().c_str());
  radioSend("# MINEWATCH online");
}

String hcBuf, camBuf, usbBuf;

void loop() {
  if (mpuOk) mpuRead();

  String l = readLine(HC12, hcBuf);
  if (l.length()) handleCommand(l);
  l = readLine(Serial, usbBuf);             // same commands work from the USB serial monitor
  if (l.length()) handleCommand(l);
  l = readLine(CAM, camBuf);
  if (l.length()) handleCamLine(l);

  if (millis() - lastTele >= TELEMETRY_MS) {
    lastTele = millis();
    lastTeleLine = buildTelemetry();
    radioSend(lastTeleLine);
  }
  web.handleClient();
  delay(5);
}
