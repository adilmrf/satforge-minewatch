// MINEWATCH CubeSat: Tinkercad Circuits version (Arduino Uno stands in for the ESP32)
//
//   Photoresistor  = LDR (sun / eclipse)          A1
//   TMP36          = temperature sensor            A0
//   Tilt sensor    = MPU-6050 (attitude flag)      D4
//   Ultrasonic     = ESP32-CAM (object < 150 cm = "mine")  TRIG D7, ECHO D6
//   Serial Monitor = LoRa downlink to the ground station
//
// Prints the same CSV packets as the real CubeSat; fields not simulated here are 0:
//   T,temp_c,solar_mw,power_mw,bus_v,current_ma,batt_v,soc,ldr,roll,pitch,yaw,cam_on,sd_records
//   D,lat,lon,conf

const int PIN_TEMP = A0, PIN_LDR = A1;
const int PIN_TILT = 4, PIN_ECHO = 6, PIN_TRIG = 7;

const int DETECT_CM = 150;     // object closer than this = detection
const int SUNLIT_LDR = 1000;   // on the 0-4095 scale the dashboard expects

unsigned long packets = 0;

float readTempC() {
  float v = analogRead(PIN_TEMP) * 5.0 / 1023.0;
  return (v - 0.5) * 100.0;    // TMP36: 10 mV per degree, 500 mV at 0 C
}

long readDistanceCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  long us = pulseIn(PIN_ECHO, HIGH, 30000);
  return us == 0 ? -1 : us / 58;
}

void setup() {
  Serial.begin(9600);
  pinMode(PIN_TILT, INPUT_PULLUP);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  Serial.println("# MINEWATCH CubeSat (Tinkercad): downlink open");
}

void loop() {
  float tempC = readTempC();
  int ldr = analogRead(PIN_LDR) * 4;                 // 10-bit -> ESP32-style 12-bit
  bool sunlit = ldr > SUNLIT_LDR;
  bool camOn = sunlit;                               // image in sunlight only; eclipse = low-power mode
  int pitch = digitalRead(PIN_TILT) == LOW ? 30 : 0; // flip if your tilt sensor reads the other way

  packets++;
  Serial.print("T,");
  Serial.print(tempC, 2);
  Serial.print(",0,0,0,0,0,0,");
  Serial.print(ldr);
  Serial.print(",0,");
  Serial.print(pitch);
  Serial.print(",0,");
  Serial.print(camOn ? 1 : 0);
  Serial.print(',');
  Serial.println(packets);

  long dist = camOn ? readDistanceCm() : -1;
  if (dist > 0 && dist < DETECT_CM) {
    // Map the object's distance into the Hormuz box, like the water-tray demo
    float lat = 26.20 + (float)dist / DETECT_CM * 0.30;
    float conf = 0.95 - 0.40 * dist / DETECT_CM;
    Serial.print("D,");
    Serial.print(lat, 6);
    Serial.print(",56.700000,");
    Serial.println(conf, 2);
  }

  delay(1000);
}
