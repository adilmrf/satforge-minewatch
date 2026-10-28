# MINEWATCH Dashboard

Landing page (`index.html`) + mission control dashboard (`dashboard.html`). Plain HTML/CSS/JS, no build step.

## Run locally
```
python -m http.server 8765 --directory dashboard
```
Open http://127.0.0.1:8765 (landing) or http://127.0.0.1:8765/dashboard.html.

## Deploy (live link for submission)
Any static host works. GitHub Pages: push this folder to a repo → Settings → Pages → deploy from branch.
Netlify Drop: drag the folder onto https://app.netlify.com/drop.

## Data sources
| URL | Mode |
|---|---|
| `dashboard.html` | **SIM**: built-in simulator (Phase 1) |
| `dashboard.html?source=ws://192.168.4.1:81` | **LIVE**: WebSocket pushing JSON packets |
| `dashboard.html?source=https://example.com/latest.json` | **LIVE**: HTTP endpoint polled every 1 s (object or array of packets) |

Note: a page served over HTTPS (GitHub Pages) can't open plain `ws://` / `http://` connections to the ESP32. For the bench demo,
either serve the dashboard locally (`http://`) or relay packets through a cloud broker with `wss://`/`https://`.

## Packet format (what the CubeSat firmware must send)
JSON, one packet per message. `t` is Unix time in ms (optional; the dashboard uses receive time if missing).

### Telemetry (send ~1 Hz)
```json
{
  "type": "telemetry", "t": 1761650000000,
  "temp_c": 24.1,                       // TMP102
  "solar_mw": 1150, "power_mw": 420,    // INA219 on solar input / load
  "bus_v": 5.00, "current_ma": 84,      // INA219
  "batt_v": 3.98, "soc": 76.0,          // battery voltage, state of charge %
  "ldr": 3100,                          // raw ADC 0-4095; >1000 = sunlit
  "roll": 1.2, "pitch": -0.4, "yaw": 87.0,   // MPU-6050, degrees
  "rssi": -101, "snr": 7.2,             // LoRa link quality (ground station side)
  "cam_on": true, "pass": true,         // camera imaging / over target area
  "sd_records": 512                     // rows logged to SD
}
```

### Detection (send when the ESP32-CAM spots an object)
```json
{ "type": "detection", "t": 1761650000000, "lat": 26.512, "lon": 56.430, "conf": 0.86 }
```
For the bench demo, the firmware maps the object's pixel position in the water tray to a lat/lon inside the
region box (e.g. tray corners → `[25.2, 55.4]`…`[27.2, 57.6]` for Hormuz). The dashboard does the rest:
it groups detections into hazard tracks (re-sightings confirm a track), estimates drift from successive
sightings, projects +6/12/24 h positions, and raises shipping-lane alerts.
