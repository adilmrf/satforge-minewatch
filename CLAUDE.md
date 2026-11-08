# MINEWATCH: guide for answering team questions

Team H members use this repo to ask questions and learn how the project works. Many of them are not
software people: some work on hardware, the pitch or the report. When you answer:

- Start with a plain-language answer. Add code detail only when it is useful, and point to it as
  `file:line` so they can open it.
- Say clearly what is **simulated** and what is **real hardware**. The dashboard can run entirely on its
  own simulator (see "Simulated vs live" below).
- Answer only from what is in this repo. The team brief, parts sourcing and notes are deliberately kept
  out of git (see `.gitignore`), so hardware facts that aren't written here may be unknown. Say so
  instead of guessing.
- The code is the source of truth. If a page or README disagrees with the firmware, say so, and say which
  one the code supports.

## What the project is

SatForge UAE 2026 (National University Satellite Engineering Challenge) entry. MINEWATCH is a 1U CubeSat
proof-of-concept (PoC) that **detects** floating naval mines, **predicts** where they will drift and **alerts** shipping.
Demo regions: Strait of Hormuz and the southern Red Sea / Bab el-Mandeb. Tagline: "Find the mine before the ship does."

Honest scope, as the landing page states it: a real 1U camera resolves about 7 m per pixel, so it cannot see a 1 m mine.
The PoC proves the *pipeline*: red and yellow balls float on a water tray, the CubeSat's camera spots them, and
alerts show up on the dashboard. Roadmap: Phase 1 CubeSat PoC → Phase 2 buoys and drones → Phase 3 operational constellation.

## Repo map

| Path | What it is |
|---|---|
| `README.md` | One-paragraph overview |
| `dashboard/index.html`, `main.js`, `styles.css` | Public landing page: problem, mission, hardware, roadmap, sources |
| `dashboard/dashboard.html`, `dashboard.js`, `dashboard.css` | Mission-control dashboard: map, hazards, alerts, satellite health |
| `dashboard/README.md` | How to run, data-source URLs and the **JSON packet format** |
| `firmware/satellite/satellite.ino` | Flight computer (ESP32 DevKit): reads the sensors, relays camera detections, transmits |
| `firmware/camera/camera.ino` | Payload (AI-Thinker ESP32-CAM): finds red and yellow balls and logs them to SD |
| `firmware/ground_station/ground_station.ino` | Ground station (ESP32): radio in, JSON lines out over USB |
| `firmware/tinkercad/` | Simplified Arduino Uno version for Tinkercad Circuits, with team test cases |

The dashboard has no build step and nothing to install. It loads Leaflet (map) from a CDN and Esri map tiles.
Run it locally with `python -m http.server 8765 --directory dashboard` and open `/dashboard.html`.
The public site is deployed by hand: the contents of `dashboard/` are copied to the `gh-pages` branch.
Firmware is built in the Arduino IDE (board names and libraries are listed at the top of each `.ino`).

## Hardware

| Subsystem | Part | Notes |
|---|---|---|
| OBC | ESP32 DevKit (ESP32-WROOM-32) | `satellite.ino` |
| Payload | AI-Thinker ESP32-CAM + micro SD | `camera.ino`, linked to the OBC over UART2 |
| Comms | HC-12, 433 MHz, 9600 baud | Main link. Every packet is also broadcast over **ESP-NOW** (Wi-Fi radio, channel 1) as a backup |
| ADCS | MPU-6050 | Read directly over I2C (no library). Roll and pitch come from the accelerometer, yaw from the integrated gyro |
| Thermal | DHT-22 | |
| EPS | INA219 on the 5 V bus, solar panel, battery | The INA219 measures **load** power. Solar power is only **estimated** from the LDR |
| Sun sensing | LDR | > 1000 (of 4095) counts as sunlit |

The satellite also runs a Wi-Fi access point, `MINEWATCH-SAT`. Opening http://192.168.4.1 returns the last
telemetry line as JSON.

## End-to-end data flow

1. **Camera** (`camera.ino`) grabs a 160×120 frame every 1.5 s and classifies each pixel by colour
   (HSV): **red = confirmed mine**, **yellow = candidate**. It groups matching pixels into blobs, then maps
   each blob's image position to a lat/lon inside a demo box over the Hormuz lane (26.20–26.60 N,
   56.20–56.90 E). For each blob it sends `D,lat,lon,conf` to the OBC (conf 0.80–0.99 for red, 0.50–0.79 for
   yellow) and appends the detection to `/detections.csv` on the SD card. Every 2 s it also sends `S,records`.
2. **Flight computer** (`satellite.ino`) forwards `D,...` lines as they arrive. Every 2 s it builds a
   telemetry line,
   `T,temp_c,solar_mw,power_mw,bus_v,current_ma,batt_v,soc,ldr,roll,pitch,yaw,cam_on,sd_records`.
   `cam_on` means the camera has sent something in the last 5 s. Each line goes out over HC-12 *and* ESP-NOW,
   and is echoed to USB as `TX ...`. Lines must stay under 255 bytes. It replies to `PING` with `# pong`.
3. **Ground station** (`ground_station.ino`) listens on both links. `PREFER_HC12` picks the main link.
   The backup link's copies are dropped while the main link has delivered a complete packet in the last 5 s,
   so the dashboard never gets duplicates. It prints one JSON object per line over USB at 115200 baud, and
   lines starting with `#` (status and debug) are ignored by the dashboard. HC-12 and ESP-NOW report no
   signal strength, so `rssi` and `snr` are 0. Anything typed into the serial monitor is sent up to the satellite.
4. **Dashboard** receives packets from one of these sources. All of them go into the same `onPacket()` (`dashboard.js`):
   - Built-in simulator (default, "SIM")
   - "Connect ground station" button: Web Serial, Chrome/Edge only. It also accepts `TX T,...` / `TX D,...`
     lines from the satellite plugged straight into USB ("bench mode", no radio needed)
   - `?source=ws://…` WebSocket or `?source=https://…` HTTP endpoint polled every second.
     An HTTPS page (GitHub Pages) can't reach a plain `ws://` / `http://` ESP32, so serve the dashboard
     locally for bench demos.

## How the dashboard thinks (`dashboard.js`)

- **`REGIONS`**: the bounding box, an *illustrative* shipping-lane centreline, mine spawn points and the
  prevailing drift direction for each region.
- **`Simulator`**: a ~500 km orbit (94.6 min) with about 36% of each orbit in eclipse. It passes over the
  region every 2 orbits (compressed for the demo), aimed at the shipping lane, with a 90 km wide swath.
  Mines drift at 0.3 to 0.7 kn. Each mine in the swath has an 85% chance of being detected, with about 0.4 km
  position noise, and a pass produces a false alarm 30% of the time. It also models power, battery, temperature
  and attitude, and emits the same kind of packets the hardware does. The "show truth" checkbox draws the
  real simulated mines.
- **`Tracker`**: turns detections into hazard tracks named `MW-01`, `MW-02` and so on.
  - Association: a new detection joins the nearest track within a distance gate that widens over time.
    Two detections with the same `pass_id` are never merged. Only the simulator sends `pass_id`.
  - Status: `candidate` (seen once) → `confirmed` (re-sighted) → `stale` (not seen for 30 h).
    Tracks are dropped after 60 h.
  - Drift: a least-squares velocity fit over the last 5 sightings, projected to +6, +12 and +24 h.
    Uncertainty circles grow with time and speed.
  - Risk: the lane counts as 6 km either side of the centreline. `high` means the hazard is in the lane or
    predicted to enter it within 24 h, `med` means within 15 km of it, and `low` is everything else.
    Each change raises an alert.
  - The dashboard does **not** know red from yellow. That information only survives as the `conf` value.
- **Telemetry panel**: if `batt_v` > 4.4 V, the dashboard assumes the INA219 is reading the 5 V bus rather
  than the cell, and shows "cell not measured". On the real hardware this is the normal case.

## Simulated vs live

- `dashboard.html` with no parameters is **entirely simulated**: orbit, mines, detections and telemetry.
- `ground_station.ino` has `TEST_MODE 0` (real radio). Set it to `1` to print fake telemetry and two fake
  drifting mines, which tests the USB → dashboard chain without the satellite.
- With real hardware, time runs in real time: there is no orbit or pass, and drift is whatever the balls do
  on the tray.

## Tinkercad version (`firmware/tinkercad/`)

The circuit-simulation deliverable uses an Arduino Uno, with stand-ins for parts Tinkercad doesn't have:
TMP36 for temperature, a tilt switch for attitude, an ultrasonic sensor for detection (object < 150 cm =
"mine"), and the Serial Monitor in place of the radio. Power is shown separately in Multisim.
Its README has test cases 1–4, which the team still has to run and record.

## Known loose ends (as of Nov 2026)

- **"Pass" pill on live data:** the ground station no longer sends `pass`, but `dashboard.js` still reads
  `p.pass` for the "PASS · CAM ON" pill, so with ground-station data it always shows "NO PASS".
  Bench-mode parsing and the simulator still set `pass`.
- **Landing page OBC text:** says the OBC "runs detection logic and Wi-Fi downlink". In the firmware,
  detection runs on the ESP32-CAM, and Wi-Fi (ESP-NOW) is only the backup to the HC-12.
- **Tinkercad README part names:** lists "TMP102" and "LoRa SX1278" as the real parts. The flight
  hardware uses a DHT-22 and an HC-12.
- **Telemetry rate:** `dashboard/README.md` says about 1 Hz. The satellite sends every 2 s.
- **Satellite boot message:** two `printf`s run together, giving `# ESP-NOW OK, # INA219 ...` on one line.
  This is cosmetic only.
