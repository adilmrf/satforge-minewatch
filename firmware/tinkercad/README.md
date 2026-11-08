# MINEWATCH in Tinkercad Circuits

Rule: use the real part if Tinkercad has it; otherwise its alternative; if neither, find a way only when it is
crucial to the mission, else skip it.

| Real part | In Tinkercad | Why |
|---|---|---|
| ESP32-WROOM-32 | **Arduino Uno R3** | Alternative |
| LDR | **Photoresistor** + 10 kΩ | Same part |
| DHT-22 | **Temperature Sensor [TMP36]** | Alternative |
| MPU-6050 | **Tilt sensor** | Alternative (attitude flag only) |
| ESP32-CAM | **Ultrasonic Distance Sensor (4-pin)** | Crucial (detection). Object < 150 cm = "mine" |
| HC-12 433 MHz radio | **Serial Monitor** | Crucial (downlink). Prints the real packet format |
| INA219, solar panels, 18650, TP4056 charger, MT3608 boost | skipped | Power is shown in **Multisim** |
| Micro SD | skipped | Not crucial |
| N20 + L9110S (reaction wheel) | skipped | Optional |

## Wiring (one Arduino Uno)

| Part | Part pin | Uno |
|---|---|---|
| TMP36 | +Vs / Vout / GND | 5V / **A0** / GND |
| Photoresistor | one leg to 5V, other leg to **A1** and through 10 kΩ to GND | **A1** |
| Tilt sensor | one leg / other leg | **D4** / GND |
| Ultrasonic (4-pin) | VCC / TRIG / ECHO / GND | 5V / **D7** / **D6** / GND |

Code: `satellite_tinkercad.ino`. Paste it into the Uno's Code panel (Text mode), Start Simulation, open the Serial Monitor.

## Test cases (`team_circuit_updated.ino`, the circuit in the team Tinkercad)
Start the simulation and open the Serial Monitor. A telemetry block prints every second.
Start state for every test: light slider high (sunlit), tilt sensor upright, ultrasonic target at 250 cm.

| # | Test | Do | Pass if |
|---|---|---|---|
| 1 | Detection | Move the ultrasonic target to 100 cm, then back to 250 cm | At 100 cm: `Hazard alert: OBJECT DETECTED`, LED on D13 lights. At 250 cm: `NO OBJECT`, LED off. The 150 cm threshold sits between the two. |
| 2 | Eclipse | Target at 100 cm. Drag the light slider down until `Light reading` is 250 or less, then back up | Dark: `Mode: ECLIPSE (low power, camera off)`, `NO OBJECT`, LED off even with the target close. Light again: detection comes back. |
| 3 | Attitude | Target at 100 cm, sunlit. Toggle the tilt sensor, then toggle it back | Tilted: `Attitude: OFF-POINTING (imaging paused)`, `NO OBJECT`, LED off. Upright: `NADIR`, detection comes back. If it reads the wrong way round, flip the `LOW` check on line 48. |
| 4 | Temperature | Set the TMP36 slider to about 25 °C, then about 60 °C | `Temperature (C)` follows within about ±1 °C. Telemetry keeps printing in both sunlit and eclipse mode. |

Status: tests 1–4 to be run by the team (30 Oct). Record the result here when done.
