
const int TRIG_PIN = 7;
const int ECHO_PIN = 6;
const int LDR_PIN = A1;
const int TEMP_PIN = A0;
const int TILT_PIN = 4;      // tilt sensor stands in for the MPU-6050 (other leg to GND)
const int ALERT_LED = 13;

const float HAZARD_DISTANCE_CM = 150.0;
const int SUNLIT_THRESHOLD = 250;   // tune with the photoresistor light slider

void setup() {
  Serial.begin(9600);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(ALERT_LED, OUTPUT);
  pinMode(TILT_PIN, INPUT_PULLUP);

  digitalWrite(TRIG_PIN, LOW);
  digitalWrite(ALERT_LED, LOW);

  Serial.println("MINEWATCH 1U - SIMULATION");
  Serial.println("--------------------------");
}

void loop() {
  // Measure distance using the ultrasonic sensor
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000UL);
  float distance = duration * 0.0343 / 2.0;

  // Read light level: sunlit = imaging mode, dark = eclipse (camera off, low power)
  int lightLevel = analogRead(LDR_PIN);
  bool sunlit = lightLevel > SUNLIT_THRESHOLD;

  // Read temperature from TMP36
  int rawTemp = analogRead(TEMP_PIN);
  float voltage = rawTemp * (5.0 / 1023.0);
  float temperatureC = (voltage - 0.5) * 100.0;

  // Attitude: tilted = satellite not pointing at the sea, so skip imaging
  bool tilted = digitalRead(TILT_PIN) == LOW;   // flip if your tilt sensor reads the other way

  bool objectDetected =
      sunlit && !tilted && duration > 0 && distance <= HAZARD_DISTANCE_CM;

  digitalWrite(ALERT_LED, objectDetected ? HIGH : LOW);

  Serial.println();
  Serial.println("=== MINEWATCH TELEMETRY ===");

  Serial.print("Mode: ");
  Serial.println(sunlit ? "SUNLIT (imaging)" : "ECLIPSE (low power, camera off)");

  Serial.print("Attitude: ");
  Serial.println(tilted ? "OFF-POINTING (imaging paused)" : "NADIR (pointing at sea)");

  Serial.print("Distance (cm): ");
  if (duration == 0) {
    Serial.println("No echo");
  } else {
    Serial.println(distance, 1);
  }

  Serial.print("Light reading: ");
  Serial.println(lightLevel);

  Serial.print("Temperature (C): ");
  Serial.println(temperatureC, 1);

  Serial.print("Hazard alert: ");
  Serial.println(objectDetected ? "OBJECT DETECTED" : "NO OBJECT");

  Serial.println("Downlink: SIMULATED - NOT REAL RADIO");

  delay(1000);
}
