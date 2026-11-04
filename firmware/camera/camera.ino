// MINEWATCH payload camera (AI-Thinker ESP32-CAM) - Team H, SatForge UAE 2026
//
// Looks down through the floor port, finds red balls (confirmed mines) and yellow
// balls (candidates) on the demo tray, turns their image position into a lat/lon
// inside a box over the Strait of Hormuz, and sends one line per object to the
// flight computer over the U0T/U0R pins (115200 baud):
//   D,lat,lon,conf      conf 0.80-0.99 for red, 0.50-0.79 for yellow
//   S,records           every 2 s: number of detections logged to the SD card
// Every detection is also appended to /detections.csv on the micro SD card.
//
// Flash it BEFORE mounting the board (the U0T/U0R pins are also the upload port):
//   Board "AI Thinker ESP32-CAM", use the ESP32-CAM-MB USB board, or the second
//   ESP32 / a USB-serial adapter with IO0 tied to GND during reset.
// SD card: up to 32 GB, FAT32, inserted before mounting.

#include "esp_camera.h"
#include "SD_MMC.h"
#include "img_converters.h"

// AI-Thinker camera pins
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

// Image corners mapped to a box over the shipping lane (demo scale)
const double LAT_TOP = 26.60, LAT_BOTTOM = 26.20;
const double LON_LEFT = 56.20, LON_RIGHT = 56.90;

const int W = 160, H = 120;            // QQVGA
const int CELL = 4, GW = W / CELL, GH = H / CELL;
const int MIN_CELL_HITS = 6;           // of 16 pixels in a cell
const int MIN_BLOB_CELLS = 6;          // ignore specks
const bool DEBUG = true;               // prints one '#' line per frame for tuning; set false for the demo

bool sdOk = false;
long records = 0;
unsigned long lastStatus = 0, lastScan = 0;

uint8_t grid[GH][GW];                  // 0 none, 1 red, 2 yellow
int16_t label[GH][GW];

// HSV from 8-bit RGB. h in degrees, s and v 0..1
void rgbToHsv(uint8_t R, uint8_t G, uint8_t B, float &h, float &s, float &v) {
  float r = R / 255.0, g = G / 255.0, b = B / 255.0;
  float mx = max(r, max(g, b)), mn = min(r, min(g, b)), d = mx - mn;
  v = mx; s = mx > 0 ? d / mx : 0;
  if (d == 0) { h = 0; return; }
  if (mx == r) h = 60 * fmod((g - b) / d, 6);
  else if (mx == g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
}

// The JPEG decoder writes pixels as B,G,R (bitmap order)
uint8_t classify(const uint8_t *p) {
  float h, s, v;
  rgbToHsv(p[2], p[1], p[0], h, s, v);
  if (s > 0.50 && v > 0.30 && (h < 15 || h > 335)) return 1;   // red
  if (s > 0.50 && v > 0.35 && h > 40 && h < 64) return 2;      // yellow (stops short of light green)
  return 0;
}

uint8_t *rgb = nullptr;                 // decoded frame, W*H*3 bytes

void logDetection(double lat, double lon, float conf, int cls) {
  if (!sdOk) return;
  File f = SD_MMC.open("/detections.csv", FILE_APPEND);
  if (!f) return;
  f.printf("%lu,%s,%.6f,%.6f,%.2f\n", millis(), cls == 1 ? "red" : "yellow", lat, lon, conf);
  f.close();
  records++;
}

void scanFrame() {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) { if (DEBUG) Serial.println("# no frame from camera (check the ribbon cable)"); return; }
  bool ok = fb->width == W && fb->height == H && fmt2rgb888(fb->buf, fb->len, fb->format, rgb);
  esp_camera_fb_return(fb);
  if (!ok) { if (DEBUG) Serial.println("# frame decode failed"); return; }
  for (int gy = 0; gy < GH; gy++)
    for (int gx = 0; gx < GW; gx++) {
      int red = 0, yel = 0;
      for (int y = 0; y < CELL; y++)
        for (int x = 0; x < CELL; x++) {
          uint8_t c = classify(rgb + ((gy * CELL + y) * W + gx * CELL + x) * 3);
          if (c == 1) red++; else if (c == 2) yel++;
        }
      grid[gy][gx] = red >= MIN_CELL_HITS ? 1 : (yel >= MIN_CELL_HITS ? 2 : 0);
      label[gy][gx] = -1;
    }
  if (DEBUG) {                                          // what the centre of the image sees
    const uint8_t *p = rgb + ((H / 2) * W + W / 2) * 3;
    float h, sa, v;
    rgbToHsv(p[2], p[1], p[0], h, sa, v);
    int reds = 0, yels = 0;
    for (int gy = 0; gy < GH; gy++) for (int gx = 0; gx < GW; gx++) { reds += grid[gy][gx] == 1; yels += grid[gy][gx] == 2; }
    Serial.printf("# centre R%d G%d B%d -> h%.0f s%.2f v%.2f | red cells %d yellow cells %d\n",
                  p[2], p[1], p[0], h, sa, v, reds, yels);
  }

  // flood fill blobs on the cell grid
  static int16_t qx[GW * GH], qy[GW * GH];
  for (int sy = 0; sy < GH; sy++)
    for (int sx = 0; sx < GW; sx++) {
      if (!grid[sy][sx] || label[sy][sx] >= 0) continue;
      uint8_t cls = grid[sy][sx];
      int head = 0, tail = 0, n = 0; long sumx = 0, sumy = 0;
      qx[tail] = sx; qy[tail++] = sy; label[sy][sx] = 1;
      while (head < tail) {
        int x = qx[head], y = qy[head++];
        n++; sumx += x; sumy += y;
        const int dx[4] = {1, -1, 0, 0}, dy[4] = {0, 0, 1, -1};
        for (int k = 0; k < 4; k++) {
          int nx = x + dx[k], ny = y + dy[k];
          if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
          if (grid[ny][nx] != cls || label[ny][nx] >= 0) continue;
          label[ny][nx] = 1; qx[tail] = nx; qy[tail++] = ny;
        }
      }
      if (n < MIN_BLOB_CELLS) continue;
      double cx = (sumx / (double)n + 0.5) / GW, cy = (sumy / (double)n + 0.5) / GH;
      double lat = LAT_TOP + (LAT_BOTTOM - LAT_TOP) * cy;
      double lon = LON_LEFT + (LON_RIGHT - LON_LEFT) * cx;
      float size = min(1.0, n / 40.0);                 // bigger, solid blobs score higher
      float conf = cls == 1 ? 0.80 + 0.19 * size : 0.50 + 0.29 * size;
      Serial.printf("D,%.6f,%.6f,%.2f\n", lat, lon, conf);
      logDetection(lat, lon, conf, cls);
    }
}

void setup() {
  Serial.begin(115200);
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0; c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM; c.pin_d1 = Y3_GPIO_NUM; c.pin_d2 = Y4_GPIO_NUM; c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM; c.pin_d5 = Y7_GPIO_NUM; c.pin_d6 = Y8_GPIO_NUM; c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM; c.pin_pclk = PCLK_GPIO_NUM; c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href = HREF_GPIO_NUM; c.pin_sccb_sda = SIOD_GPIO_NUM; c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM; c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 10000000;           // 10 MHz: stable on the GC2145/GC0308 sensors these boards ship with
  c.pixel_format = PIXFORMAT_RGB565;   // these sensors cannot make JPEG; fmt2rgb888 handles the byte order
  c.frame_size = FRAMESIZE_QQVGA;
  c.fb_count = 1;
  c.fb_location = CAMERA_FB_IN_PSRAM;
  c.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) {
    Serial.printf("# camera init failed (error 0x%x): check the ribbon cable\n", err);
  } else {
    sensor_t *sen = esp_camera_sensor_get();
    Serial.println("# camera init OK, sensor PID 0x" + String(sen->id.PID, HEX));
    rgb = (uint8_t *)ps_malloc(W * H * 3);
    if (sen->set_vflip) sen->set_vflip(sen, 1);   // camera looks down; keeps image north-up on the tray
  }
  sdOk = SD_MMC.begin("/sdcard", true); // 1-bit mode
  if (sdOk) {
    File f = SD_MMC.open("/detections.csv", FILE_APPEND);
    if (f) { f.println("ms,class,lat,lon,conf"); f.close(); }
  }
  Serial.printf("# camera ready, SD %s\n", sdOk ? "OK" : "MISSING");
}

void loop() {
  if (millis() - lastScan >= 1500) { lastScan = millis(); scanFrame(); }
  if (millis() - lastStatus >= 2000) {
    lastStatus = millis();
    Serial.printf("S,%ld\n", records);
  }
}
