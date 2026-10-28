// MINEWATCH mission control.
// Data flows as JSON packets (see README.md). In SIM mode a built-in simulator
// generates the same packets the CubeSat will send, so the dashboard code path
// is identical for simulated and live data.
"use strict";

/* ------------------------------------------------------------------ config */

const REGIONS = {
  hormuz: {
    name: "Strait of Hormuz",
    bounds: [[25.2, 55.4], [27.2, 57.6]],
    // Approximate shipping corridor centreline (illustrative, not navigational).
    lane: [[26.20, 55.70], [26.45, 56.10], [26.62, 56.45], [26.45, 56.75], [26.05, 56.85], [25.60, 57.05]],
    spawns: [[26.05, 55.75], [26.40, 55.55], [26.55, 56.05], [26.10, 57.05], [25.95, 56.95], [26.40, 56.95]],
    drift: [0.35, -0.94], // surface inflow into the Gulf (lat, lon unit vector)
  },
  redsea: {
    name: "Southern Red Sea",
    bounds: [[12.2, 40.8], [16.3, 44.0]],
    lane: [[12.55, 43.40], [13.20, 42.95], [14.00, 42.35], [15.00, 41.75], [16.00, 41.40]],
    spawns: [[13.30, 43.15], [13.00, 43.15], [13.70, 42.95], [12.85, 43.30], [14.30, 42.65], [13.50, 42.70]],
    drift: [0.90, -0.43], // mines released near Mokha drift north into the main lane
  },
};

const ORBIT_S = 94.6 * 60;        // orbital period at ~500 km
const ECLIPSE_START = 0.64;        // fraction of orbit where eclipse begins (~36% in shadow)
const PASS_PHASE = 0.20;           // pass over the region happens in daylight
const PASS_S = 90;                 // time for the swath to sweep the region
const PASS_EVERY = 2;              // orbits between passes (compressed for demo)
const SWATH_HALF_KM = 45;
const LANE_HALF_KM = 6;
const KN = 0.5144;                 // m/s per knot

/* ------------------------------------------------------------------ helpers */

const $ = (id) => document.getElementById(id);
const rand = (a, b) => a + Math.random() * (b - a);
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const KM_PER_DEG = 111.32;

function toXY(lat, lon, lat0) { // local flat projection in km
  return [lon * KM_PER_DEG * Math.cos(lat0 * Math.PI / 180), lat * KM_PER_DEG];
}
function distKm(a, b) {
  const lat0 = (a[0] + b[0]) / 2;
  const [x1, y1] = toXY(a[0], a[1], lat0), [x2, y2] = toXY(b[0], b[1], lat0);
  return Math.hypot(x2 - x1, y2 - y1);
}
function distToPolylineKm(p, line) {
  let best = Infinity;
  const lat0 = p[0];
  const [px, py] = toXY(p[0], p[1], lat0);
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = toXY(line[i][0], line[i][1], lat0);
    const [bx, by] = toXY(line[i + 1][0], line[i + 1][1], lat0);
    const dx = bx - ax, dy = by - ay;
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1);
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}
const fmtLat = (v) => `${Math.abs(v).toFixed(3)}°${v >= 0 ? "N" : "S"}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(3)}°${v >= 0 ? "E" : "W"}`;
const fmtHM = (ms) => new Date(ms).toISOString().slice(11, 16);
function fmtDur(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}
function bearingDeg(dLatKm, dLonKm) {
  return (Math.atan2(dLonKm, dLatKm) * 180 / Math.PI + 360) % 360;
}

/* ------------------------------------------------------------------ simulator */

class Simulator {
  constructor(regionKey, emit) {
    this.region = REGIONS[regionKey];
    this.emit = emit;
    this.t = 0;                         // sim seconds since start
    this.epoch = Date.now();
    this.soc = 0.78;
    this.temp = 18;
    this.yaw = 0;
    this.sd = 0;
    this.nextTele = 0;
    this.mines = [];
    this.pass = null;
    this.lastPassOrbit = -1;
    this.mineSeq = 0;
    for (let i = 0; i < 4; i++) this.spawnMine();
  }
  now() { return this.epoch + this.t * 1000; }
  phase() { return (this.t % ORBIT_S) / ORBIT_S; }
  sunlit() { return this.phase() < ECLIPSE_START; }
  nextTransitionS() {
    const p = this.phase();
    const target = p < ECLIPSE_START ? ECLIPSE_START : 1;
    return (target - p) * ORBIT_S;
  }

  spawnMine() {
    const s = this.region.spawns[Math.floor(Math.random() * this.region.spawns.length)];
    const speed = rand(0.3, 0.7) * KN / 1000;   // km/s
    const [dlat, dlon] = this.region.drift;
    const ang = Math.atan2(dlon, dlat) + rand(-0.5, 0.5);
    this.mines.push({
      n: ++this.mineSeq,
      lat: s[0] + rand(-0.06, 0.06), lon: s[1] + rand(-0.06, 0.06),
      vN: Math.cos(ang) * speed, vE: Math.sin(ang) * speed,   // km/s north/east
      life: rand(20, 36) * 3600,
    });
  }

  startPass() {
    // Passes are targeted at the shipping lane (area of interest), not random sea.
    const [[s, w], [n, e]] = this.region.bounds;
    const lp = this.region.lane[Math.floor(Math.random() * this.region.lane.length)];
    const lonC = clamp(lp[1] + rand(-0.3, 0.3), w + 0.4, e - 0.4);
    this.pass = {
      t0: this.t,
      a: [n + 0.4, lonC + 0.3],   // descending (southbound) sun-synchronous track
      b: [s - 0.4, lonC - 0.3],
      checked: new Set(),
      falseAlarm: null,
    };
    // Occasional false alarm (debris, whitecap) near the lanes so it stays over water.
    if (Math.random() < 0.3) {
      const lp = this.region.lane[Math.floor(Math.random() * this.region.lane.length)];
      const lat = lp[0] + rand(-0.1, 0.1), lon = lp[1] + rand(-0.1, 0.1);
      const { u, cross } = this.project(lat, lon);
      if (u > 0 && u < 1 && Math.abs(cross) <= SWATH_HALF_KM) this.pass.falseAlarm = { u, lat, lon };
    }
  }

  // Position along the current pass track, u in [0,1].
  trackPoint(u) {
    const { a, b } = this.pass;
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  }
  passFraction() { return this.pass ? clamp((this.t - this.pass.t0) / PASS_S, 0, 1) : 0; }

  // Along-track fraction and signed cross-track distance (km) of a point.
  project(lat, lon) {
    const { a, b } = this.pass;
    const lat0 = (a[0] + b[0]) / 2;
    const [ax, ay] = toXY(a[0], a[1], lat0), [bx, by] = toXY(b[0], b[1], lat0), [px, py] = toXY(lat, lon, lat0);
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const u = ((px - ax) * dx + (py - ay) * dy) / L2;
    const cross = ((px - ax) * dy - (py - ay) * dx) / Math.sqrt(L2);
    return { u, cross };
  }

  detect(lat, lon, conf) {
    const nN = gauss() * 0.4, nE = gauss() * 0.4; // ~0.4 km position noise
    const latN = lat + nN / KM_PER_DEG;
    const lonN = lon + nE / (KM_PER_DEG * Math.cos(lat * Math.PI / 180));
    this.sd++;
    this.emit({ type: "detection", t: this.now(), lat: latN, lon: lonN, conf: +conf.toFixed(2), pass_id: this.lastPassOrbit });
  }

  step(dt) {
    this.t += dt;
    const sunlit = this.sunlit();

    // Passes over the region of interest.
    const orbit = Math.floor(this.t / ORBIT_S);
    if (!this.pass && orbit % PASS_EVERY === 0 && orbit !== this.lastPassOrbit && this.phase() >= PASS_PHASE) {
      this.lastPassOrbit = orbit;
      this.startPass();
    }
    if (this.pass) {
      const f = this.passFraction();
      for (const m of this.mines) {
        if (this.pass.checked.has(m.n)) continue;
        const { u, cross } = this.project(m.lat, m.lon);
        if (f >= u) {
          this.pass.checked.add(m.n);
          if (Math.abs(cross) <= SWATH_HALF_KM && Math.random() < 0.85) this.detect(m.lat, m.lon, rand(0.72, 0.97));
        }
      }
      const fa = this.pass.falseAlarm;
      if (fa && f >= fa.u) {
        this.detect(fa.lat, fa.lon, rand(0.40, 0.62));
        this.pass.falseAlarm = null;
      }
      if (f >= 1) this.pass = null;
    }

    // Mines drift; old ones are "cleared" and new ones laid.
    for (const m of this.mines) {
      m.lat += (m.vN * dt) / KM_PER_DEG;
      m.lon += (m.vE * dt) / (KM_PER_DEG * Math.cos(m.lat * Math.PI / 180));
      m.life -= dt;
    }
    this.mines = this.mines.filter((m) => m.life > 0);
    while (this.mines.length < 3) this.spawnMine();
    if (this.mines.length < 6 && Math.random() < dt / (10 * 3600)) this.spawnMine();

    // Power, thermal and attitude models.
    const camOn = !!this.pass;
    this.yaw = (this.yaw + dt * 0.02) % 360;
    const roll = gauss() * 1.2 + (camOn ? 0 : 3 * Math.sin(this.t / 300));
    const pitch = gauss() * 1.0 + (camOn ? 0 : 2 * Math.cos(this.t / 410));
    const solar = sunlit ? clamp(1150 * Math.cos(roll * Math.PI / 180) + gauss() * 40, 0, 1400) : 0;
    const load = 380 + (camOn ? 650 : 0) + Math.abs(gauss()) * 25;
    const net = solar * 0.85 - load;                              // mW
    this.soc = clamp(this.soc + (net * dt / 3600) / 9620, 0, 1);  // 2600 mAh x 3.7 V
    const target = (sunlit ? 24 : 6) + (camOn ? 3 : 0);
    this.temp += (target - this.temp) * (1 - Math.exp(-dt / 900));

    if (this.t >= this.nextTele) {
      this.nextTele = this.t + 60;
      this.sd++;
      const bus = 5.0 + gauss() * 0.02;
      this.emit({
        type: "telemetry", t: this.now(),
        temp_c: +(this.temp + gauss() * 0.15).toFixed(2),
        solar_mw: Math.round(solar), power_mw: Math.round(load),
        bus_v: +bus.toFixed(2), current_ma: Math.round(load / bus),
        batt_v: +(3.3 + 0.9 * this.soc).toFixed(2), soc: +(this.soc * 100).toFixed(1),
        ldr: Math.round(sunlit ? rand(2800, 3400) : rand(80, 200)),
        roll: +roll.toFixed(1), pitch: +pitch.toFixed(1), yaw: +this.yaw.toFixed(1),
        rssi: Math.round(-104 + 7 * Math.sin(this.t / 700) + gauss() * 2), snr: +(7 + gauss()).toFixed(1),
        cam_on: camOn, pass: camOn, sd_records: this.sd,
      });
    }
  }
}

/* ------------------------------------------------------------------ tracker */
// Associates detections into hazard tracks and estimates drift.

class Tracker {
  constructor(region, onAlert) {
    this.region = region;
    this.onAlert = onAlert;
    this.tracks = [];
    this.seq = 0;
    this.detCount = 0;
  }

  estimate(tr, nowMs) {
    const d = tr.dets.slice(-5);
    const last = d[d.length - 1];
    let vN = 0, vE = 0; // km/h
    if (d.length >= 2) {
      const lat0 = last.lat;
      const pts = d.map((p) => ({ h: (p.t - last.t) / 3.6e6, xy: toXY(p.lat, p.lon, lat0) }));
      const mh = pts.reduce((s, p) => s + p.h, 0) / pts.length;
      const mx = pts.reduce((s, p) => s + p.xy[0], 0) / pts.length;
      const my = pts.reduce((s, p) => s + p.xy[1], 0) / pts.length;
      let sxx = 0, sx = 0, sy = 0;
      for (const p of pts) { const dh = p.h - mh; sxx += dh * dh; sx += dh * (p.xy[0] - mx); sy += dh * (p.xy[1] - my); }
      if (sxx > 1e-6) { vE = sx / sxx; vN = sy / sxx; }
    }
    const move = (h) => {
      const dt = (nowMs - last.t) / 3.6e6 + h;
      return [last.lat + (vN * dt) / KM_PER_DEG, last.lon + (vE * dt) / (KM_PER_DEG * Math.cos(last.lat * Math.PI / 180))];
    };
    tr.vN = vN; tr.vE = vE;
    tr.pos = move(0);
    tr.preds = d.length >= 2 ? [6, 12, 24].map((h) => {
      const p = move(h);
      return { h, lat: p[0], lon: p[1], r: 1.5 + 0.3 * h + 0.12 * Math.hypot(vN, vE) * h };
    }) : [];
  }

  assess(tr) {
    const lane = this.region.lane;
    tr.laneKm = distToPolylineKm(tr.pos, lane);
    tr.etaH = null;
    if (tr.laneKm <= LANE_HALF_KM) { tr.risk = "high"; tr.etaH = 0; return; }
    if (tr.preds.length) {
      for (let h = 1; h <= 24; h++) {
        const p = [tr.pos[0] + (tr.vN * h) / KM_PER_DEG, tr.pos[1] + (tr.vE * h) / (KM_PER_DEG * Math.cos(tr.pos[0] * Math.PI / 180))];
        if (distToPolylineKm(p, lane) <= LANE_HALF_KM) { tr.risk = "high"; tr.etaH = h; return; }
      }
    }
    tr.risk = tr.laneKm < 15 ? "med" : "low";
  }

  ingest(det) {
    this.detCount++;
    let best = null, bestD = Infinity;
    for (const tr of this.tracks) {
      this.estimate(tr, det.t);
      const dtH = (det.t - tr.dets[tr.dets.length - 1].t) / 3.6e6;
      // A second object seen on the same pass is a different hazard, not a re-sighting.
      if (det.pass_id != null && tr.lastPass === det.pass_id) continue;
      const gate = Math.min(4 + (tr.dets.length >= 2 ? 1.0 : 2.0) * dtH, 30);
      const d = distKm(tr.pos, [det.lat, det.lon]);
      if (d < gate && d < bestD) { best = tr; bestD = d; }
    }
    if (!best) {
      best = { id: `MW-${String(++this.seq).padStart(2, "0")}`, dets: [], status: "candidate", risk: "low", lastPass: det.pass_id };
      this.tracks.push(best);
      best.dets.push(det);
      this.estimate(best, det.t);
      this.assess(best);
      this.onAlert("med", `New candidate <b>${best.id}</b> at ${fmtLat(det.lat)} ${fmtLon(det.lon)} (conf ${det.conf})`, det.t);
      return best;
    }
    best.dets.push(det);
    best.lastPass = det.pass_id;
    const prevRisk = best.risk;
    this.estimate(best, det.t);
    this.assess(best);
    if (best.status === "candidate") {
      best.status = "confirmed";
      const kn = (Math.hypot(best.vN, best.vE) / 3.6) / KN;
      this.onAlert(best.risk === "high" ? "high" : "med",
        `<b>${best.id}</b> confirmed by re-sighting. Drift ${kn.toFixed(1)} kn toward ${Math.round(bearingDeg(best.vN, best.vE))}°`, det.t);
    } else if (best.status === "stale") {
      best.status = "confirmed";
    }
    if (best.risk === "high" && prevRisk !== "high") this.laneAlert(best, det.t);
    return best;
  }

  laneAlert(tr, t) {
    const msg = tr.etaH === 0
      ? `<b>${tr.id}</b> is inside the shipping lane. Issue navigation warning`
      : `<b>${tr.id}</b> predicted to enter the shipping lane in ~${tr.etaH} h`;
    this.onAlert("high", msg, t);
  }

  tick(nowMs) {
    for (const tr of this.tracks) {
      const prevRisk = tr.risk;
      this.estimate(tr, nowMs);
      this.assess(tr);
      const ageH = (nowMs - tr.dets[tr.dets.length - 1].t) / 3.6e6;
      if (tr.status !== "stale" && ageH > 30) {
        tr.status = "stale";
        this.onAlert("info", `<b>${tr.id}</b> not re-sighted for 30 h; marked stale`, nowMs);
      } else if (tr.status === "confirmed" && tr.risk === "high" && prevRisk !== "high") {
        this.laneAlert(tr, nowMs);
      }
      tr.ageH = ageH;
    }
    this.tracks = this.tracks.filter((tr) => tr.ageH === undefined || tr.ageH < 60);
  }
}

/* ------------------------------------------------------------------ live sources */
// ?source=ws://host:port      WebSocket pushing JSON packets
// ?source=https://.../latest  HTTP endpoint polled every second (object or array)

function connectLive(url, onPacket, onStatus) {
  const handle = (txt) => {
    try {
      const data = JSON.parse(txt);
      (Array.isArray(data) ? data : [data]).forEach(onPacket);
    } catch (e) { console.warn("Bad packet", e); }
  };
  if (/^wss?:/.test(url)) {
    const open = () => {
      const ws = new WebSocket(url);
      ws.onopen = () => onStatus(true);
      ws.onmessage = (ev) => handle(ev.data);
      ws.onclose = () => { onStatus(false); setTimeout(open, 2000); };
      ws.onerror = () => ws.close();
    };
    open();
  } else {
    const poll = async () => {
      try {
        const r = await fetch(url, { cache: "no-store" });
        handle(await r.text());
        onStatus(r.ok);
      } catch { onStatus(false); }
      setTimeout(poll, 1000);
    };
    poll();
  }
}

// Ground station over USB (Web Serial, Chrome/Edge). The ground-station ESP32
// prints one JSON packet per line; each line goes through the same onPacket().
async function connectSerial(onPacket, onStatus) {
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: 115200 });
  onStatus(true);
  const reader = port.readable.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue; // ignore boot messages / debug prints
        try { onPacket(JSON.parse(line)); } catch { console.warn("Bad line", line); }
      }
    }
  } finally {
    onStatus(false);
  }
}

/* ------------------------------------------------------------------ UI */

const state = {
  regionKey: "hormuz",
  live: null,
  sim: null,
  tracker: null,
  paused: false,
  speed: 900,
  lastPacketReal: 0,
  firstPacketMs: null,
  lastTele: null,
  spark: { solar: [], load: [], soc: [], temp: [], ldr: [] },
};

const params = new URLSearchParams(location.search);
state.live = params.get("source");

// Map
let map = null, layers = {};
if (window.L) {
  map = L.map("map", { zoomControl: true, attributionControl: true, zoomSnap: 0.25 });
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors",
    maxZoom: 16,
  }).addTo(map);
  layers.static = L.layerGroup().addTo(map);
  layers.pass = L.layerGroup().addTo(map);
  layers.truth = L.layerGroup().addTo(map);
  layers.tracks = L.layerGroup().addTo(map);
} else {
  $("map").innerHTML = '<p style="padding:20px;color:#8d99b3">Map library failed to load (offline?). Telemetry still works.</p>';
}

function drawStatic() {
  if (!map) return;
  const r = REGIONS[state.regionKey];
  layers.static.clearLayers();
  L.rectangle(r.bounds, { color: "#35d0ba", weight: 1, opacity: 0.25, fill: false, dashArray: "4 6" }).addTo(layers.static);
  L.polyline(r.lane, { color: "#35d0ba", weight: 18, opacity: 0.14, lineCap: "round" }).addTo(layers.static);
  L.polyline(r.lane, { color: "#35d0ba", weight: 1.5, opacity: 0.7, dashArray: "6 6" }).addTo(layers.static);
  map.fitBounds(r.bounds, { padding: [10, 10] });
}

function drawPass() {
  if (!map) return;
  layers.pass.clearLayers();
  const sim = state.sim;
  if (!sim || !sim.pass) return;
  const f = sim.passFraction();
  const a = sim.trackPoint(0), b = sim.trackPoint(1), c = sim.trackPoint(f);
  L.polyline([a, b], { color: "#8d99b3", weight: 1, opacity: 0.5, dashArray: "2 6" }).addTo(layers.pass);
  // Swept swath polygon
  const off = (p) => SWATH_HALF_KM / (KM_PER_DEG * Math.cos(p[0] * Math.PI / 180));
  const poly = [[a[0], a[1] - off(a)], [c[0], c[1] - off(c)], [c[0], c[1] + off(c)], [a[0], a[1] + off(a)]];
  L.polygon(poly, { color: "#35d0ba", weight: 1, opacity: 0.6, fillOpacity: 0.12 }).addTo(layers.pass);
  L.marker(c, {
    icon: L.divIcon({ className: "", html: '<div style="width:14px;height:14px;background:#e6ebf5;border:2px solid #ff8a3d;border-radius:3px;box-shadow:0 0 12px #35d0ba"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
  }).addTo(layers.pass);
}

function drawTruth() {
  if (!map) return;
  layers.truth.clearLayers();
  if (!$("show-truth").checked || !state.sim) return;
  for (const m of state.sim.mines) {
    L.circleMarker([m.lat, m.lon], { radius: 3, color: "#8d99b3", weight: 1, fillOpacity: 0.6 }).addTo(layers.truth);
  }
}

function drawTracks() {
  if (!map) return;
  layers.tracks.clearLayers();
  for (const tr of state.tracker.tracks) {
    const conf = tr.status === "confirmed";
    const color = tr.status === "stale" ? "#8d99b3" : conf ? "#ff5a5f" : "#ffc94d";
    L.polyline(tr.dets.map((d) => [d.lat, d.lon]), { color, weight: 1, opacity: 0.6 }).addTo(layers.tracks);
    tr.dets.forEach((d) => L.circleMarker([d.lat, d.lon], { radius: 2, color, weight: 1, fillOpacity: 0.8 }).addTo(layers.tracks));
    if (tr.preds.length && tr.status !== "stale") {
      L.polyline([tr.pos, ...tr.preds.map((p) => [p.lat, p.lon])], { color: "#ff8a3d", weight: 1.5, dashArray: "4 5" }).addTo(layers.tracks);
      tr.preds.forEach((p) => L.circle([p.lat, p.lon], { radius: p.r * 1000, color: "#ff8a3d", weight: 1, opacity: 0.5, fillOpacity: 0.05 }).addTo(layers.tracks));
    }
    const mk = L.circleMarker(tr.pos, conf
      ? { radius: 6, color: "#ff5a5f", weight: 2, fillColor: "#ff5a5f", fillOpacity: 0.85 }
      : { radius: 6, color, weight: 2, fillOpacity: 0 });
    mk.bindTooltip(tr.id, { permanent: true, direction: "right", offset: [8, 0], className: "mine-label" });
    mk.bindPopup(() => trackPopup(tr));
    mk.addTo(layers.tracks);
    tr.marker = mk;
  }
}

function trackPopup(tr) {
  const kn = (Math.hypot(tr.vN || 0, tr.vE || 0) / 3.6) / KN;
  const last = tr.dets[tr.dets.length - 1];
  return `<b>${tr.id}</b> · ${tr.status}<br>
    Est. position ${fmtLat(tr.pos[0])} ${fmtLon(tr.pos[1])}<br>
    Sightings ${tr.dets.length} · last conf ${last.conf}<br>
    ${tr.preds.length ? `Drift ${kn.toFixed(2)} kn → ${Math.round(bearingDeg(tr.vN, tr.vE))}°<br>` : "Drift: awaiting 2nd sighting<br>"}
    Distance to lane ${tr.laneKm.toFixed(1)} km`;
}

function renderHazards() {
  const list = state.tracker.tracks.slice().sort((a, b) =>
    ({ high: 0, med: 1, low: 2 }[a.risk] - { high: 0, med: 1, low: 2 }[b.risk]) || (a.status === "stale") - (b.status === "stale"));
  $("haz-count").textContent = list.filter((t) => t.status !== "stale").length;
  if (!list.length) {
    $("hazards").innerHTML = '<p class="empty">No detections yet. Waiting for the next pass…</p>';
    return;
  }
  $("hazards").innerHTML = list.map((tr) => {
    const label = tr.risk === "high" ? (tr.etaH === 0 ? "IN LANE" : `LANE ~${tr.etaH}h`) : tr.risk === "med" ? "NEAR LANE" : "LOW";
    const drift = tr.preds.length ? `${((Math.hypot(tr.vN, tr.vE) / 3.6) / KN).toFixed(1)} kn → ${Math.round(bearingDeg(tr.vN, tr.vE))}°` : "drift: need 2nd sighting";
    return `<div class="haz ${tr.status}" data-id="${tr.id}">
      <div class="haz-top"><span class="haz-id">${tr.id}</span>
        <span class="badge ${tr.status === "stale" ? "low" : tr.risk}">${tr.status === "candidate" ? "CANDIDATE · " : ""}${tr.status === "stale" ? "STALE" : label}</span></div>
      <div class="haz-meta">${fmtLat(tr.pos[0])} ${fmtLon(tr.pos[1])}</div>
      <div class="haz-meta">${tr.dets.length}× seen · ${drift}</div>
    </div>`;
  }).join("");
}

$("hazards").addEventListener("click", (e) => {
  const el = e.target.closest(".haz");
  if (!el || !map) return;
  const tr = state.tracker.tracks.find((t) => t.id === el.dataset.id);
  if (tr) { map.flyTo(tr.pos, 10, { duration: 0.8 }); tr.marker && tr.marker.openPopup(); }
});

function addAlert(level, html, t) {
  const li = document.createElement("li");
  li.className = level;
  li.innerHTML = `<time>${fmtHM(t)}</time>${html}`;
  const list = $("alerts");
  list.prepend(li);
  while (list.children.length > 60) list.lastChild.remove();
}
$("btn-clear").addEventListener("click", () => { $("alerts").innerHTML = ""; });

/* sparklines & horizon */

function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx, w, h];
}

function spark(id, series, colors, range) {
  const c = $(id);
  const [ctx, w, h] = fitCanvas(c);
  ctx.clearRect(0, 0, w, h);
  const all = series.flat();
  if (all.length < 2) return;
  let lo = range ? range[0] : Math.min(...all), hi = range ? range[1] : Math.max(...all);
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  series.forEach((s, i) => {
    ctx.strokeStyle = colors[i];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    s.forEach((v, j) => {
      const x = (j / (s.length - 1)) * w;
      const y = h - 3 - ((v - lo) / (hi - lo)) * (h - 6);
      j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  });
}

function horizon(roll, pitch) {
  const c = $("horizon");
  const [ctx, w, h] = fitCanvas(c);
  ctx.save();
  ctx.fillStyle = "#0b1424";
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-roll * Math.PI / 180);
  const off = pitch * 3;
  ctx.fillStyle = "#1c3a5e";
  ctx.fillRect(-w, -h * 2 + off, w * 2, h * 2);
  ctx.fillStyle = "#3a2a1c";
  ctx.fillRect(-w, off, w * 2, h * 2);
  ctx.strokeStyle = "#e6ebf5";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(-w, off); ctx.lineTo(w, off); ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = "#ff8a3d";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(w / 2 - 30, h / 2); ctx.lineTo(w / 2 - 10, h / 2); ctx.lineTo(w / 2, h / 2 + 6); ctx.lineTo(w / 2 + 10, h / 2); ctx.lineTo(w / 2 + 30, h / 2);
  ctx.stroke();
}

function pushSpark(key, v, n = 180) {
  const a = state.spark[key];
  a.push(v);
  if (a.length > n) a.shift();
}

function setPill(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = "pill" + (cls ? " " + cls : "");
}

/* packet handling */

function onPacket(p) {
  state.lastPacketReal = performance.now();
  if (state.firstPacketMs === null) state.firstPacketMs = p.t || Date.now();
  if (p.type === "telemetry") {
    state.lastTele = p;
    pushSpark("solar", p.solar_mw); pushSpark("load", p.power_mw);
    pushSpark("soc", p.soc); pushSpark("temp", p.temp_c); pushSpark("ldr", p.ldr);
  } else if (p.type === "detection") {
    state.tracker.ingest({ t: p.t || Date.now(), lat: p.lat, lon: p.lon, conf: p.conf ?? 0.5, pass_id: p.pass_id ?? null });
    drawTracks();
    renderHazards();
  }
}

function renderTelemetry() {
  const p = state.lastTele;
  if (!p) return;
  $("v-solar").textContent = `${p.solar_mw} mW`;
  $("v-load").textContent = `${p.power_mw} mW`;
  $("v-bus").textContent = `${p.bus_v.toFixed(2)} V · ${p.current_ma} mA`;
  $("v-soc").textContent = `${p.soc.toFixed(0)}%`;
  $("bar-soc").style.width = `${p.soc}%`;
  $("bar-soc").style.background = p.soc < 30 ? "var(--danger)" : p.soc < 55 ? "var(--warn)" : "var(--ok)";
  $("v-batt").textContent = `${p.batt_v.toFixed(2)} V`;
  $("v-temp").textContent = `${p.temp_c.toFixed(1)} °C`;
  $("v-roll").textContent = `${p.roll.toFixed(1)}°`;
  $("v-pitch").textContent = `${p.pitch.toFixed(1)}°`;
  $("v-yaw").textContent = `${p.yaw.toFixed(0)}°`;
  $("v-ldr").textContent = p.ldr;
  $("v-rssi").textContent = `${p.rssi} dBm / ${p.snr} dB`;
  $("v-cam").textContent = p.cam_on ? "ON · imaging" : "Standby";
  $("v-sd").textContent = p.sd_records;
  $("v-det").textContent = state.tracker.detCount;

  const sunlit = p.ldr > 1000;
  setPill("pill-mode", sunlit ? "SUNLIT" : "ECLIPSE", sunlit ? "ok" : "dim");
  setPill("pill-pass", p.pass ? "PASS · CAM ON" : "NO PASS", p.pass ? "hot" : "");

  spark("sp-power", [state.spark.solar, state.spark.load], ["#ffc94d", "#35d0ba"]);
  spark("sp-soc", [state.spark.soc], ["#4ade80"], [0, 100]);
  spark("sp-temp", [state.spark.temp], ["#ff8a3d"]);
  spark("sp-ldr", [state.spark.ldr], ["#e6ebf5"], [0, 4095]);
  horizon(p.roll, p.pitch);
}

/* main loop */

function reset(regionKey) {
  state.regionKey = regionKey;
  state.tracker = new Tracker(REGIONS[regionKey], addAlert);
  state.firstPacketMs = null;
  state.lastTele = null;
  Object.keys(state.spark).forEach((k) => (state.spark[k] = []));
  $("alerts").innerHTML = "";
  if (!state.live) {
    state.sim = new Simulator(regionKey, onPacket);
    addAlert("info", `Simulation started over the <b>${REGIONS[regionKey].name}</b>`, state.sim.now());
  }
  drawStatic();
  drawTracks();
  renderHazards();
}

let lastFrame = performance.now(), lastUi = 0, lastMap = 0;
function frame(nowReal) {
  const dtReal = Math.min((nowReal - lastFrame) / 1000, 0.25);
  lastFrame = nowReal;
  const sim = state.sim;

  if (sim && !state.paused) {
    const speed = sim.pass ? Math.min(state.speed, 12) : state.speed; // slow-mo during passes
    let dt = dtReal * speed;
    while (dt > 0) { const s = Math.min(dt, 10); sim.step(s); dt -= s; }
  }
  const nowMs = sim ? sim.now() : Date.now();

  if (nowReal - lastUi > 250) {
    lastUi = nowReal;
    renderTelemetry();
    const age = state.lastPacketReal ? (nowReal - state.lastPacketReal) / 1000 : null;
    $("v-age").textContent = age === null ? "–" : `${age.toFixed(1)} s ago`;
    $("utc").textContent = fmtHM(nowMs);
    $("met").textContent = fmtDur(state.firstPacketMs ? (nowMs - state.firstPacketMs) / 1000 : 0);
    if (sim) $("v-next").textContent = `${sim.sunlit() ? "Eclipse" : "Sunrise"} in ${fmtDur(sim.nextTransitionS()).slice(0, 5)}`;
    else $("v-next").textContent = "–";
  }
  if (nowReal - lastMap > (sim && sim.pass ? 100 : 1000)) {
    lastMap = nowReal;
    state.tracker.tick(nowMs);
    drawPass();
    drawTruth();
    drawTracks();
    renderHazards();
  }
  requestAnimationFrame(frame);
}

/* controls */

$("region-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  document.querySelectorAll("#region-seg button").forEach((x) => x.classList.toggle("on", x === b));
  reset(b.dataset.region);
});
$("speed").addEventListener("change", (e) => { state.speed = +e.target.value; });
$("btn-pause").addEventListener("click", (e) => {
  state.paused = !state.paused;
  e.target.textContent = state.paused ? "Resume" : "Pause";
});
$("show-truth").addEventListener("change", drawTruth);

if ("serial" in navigator) {
  const btn = $("btn-serial");
  btn.hidden = false;
  btn.addEventListener("click", async () => {
    if (state.live === "serial") return;
    try {
      state.live = "serial";
      state.sim = null;
      $("speed").disabled = true;
      $("btn-pause").disabled = true;
      $("show-truth").checked = false;
      reset(state.regionKey);
      addAlert("info", "Waiting for ground station packets over USB…", Date.now());
      await connectSerial(onPacket, (ok) => {
        btn.textContent = ok ? "Ground station connected" : "Ground station lost";
        btn.classList.toggle("on", ok);
        setPill("pill-source", ok ? "LIVE · USB" : "USB · OFFLINE", ok ? "ok" : "warn");
        setPill("pill-link", ok ? "LINK" : "NO LINK", ok ? "ok" : "warn");
      });
    } catch (err) {
      // User closed the port picker or the port failed: fall back to the simulator.
      console.warn(err);
      state.live = null;
      $("speed").disabled = false;
      $("btn-pause").disabled = false;
      btn.textContent = "Connect ground station";
      btn.classList.remove("on");
      setPill("pill-source", "SIM", "hot");
      setPill("pill-link", "LINK", "ok");
      reset(state.regionKey);
    }
  });
}

if (state.live) {
  setPill("pill-source", "LIVE", "warn");
  $("speed").disabled = true;
  $("btn-pause").disabled = true;
  connectLive(state.live, onPacket, (ok) => {
    setPill("pill-source", ok ? "LIVE" : "LIVE · OFFLINE", ok ? "ok" : "warn");
    setPill("pill-link", ok ? "LINK" : "NO LINK", ok ? "ok" : "warn");
  });
} else {
  setPill("pill-source", "SIM", "hot");
  setPill("pill-link", "LINK", "ok");
}

reset(state.regionKey);
requestAnimationFrame(frame);
