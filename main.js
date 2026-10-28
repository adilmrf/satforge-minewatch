// Hero animation: a satellite sweeps its sensor swath over the sea, spotting
// drifting "mines" and projecting their drift.
(() => {
  const canvas = document.getElementById("hero-canvas");
  const ctx = canvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let w, h, dpr, stars, mines, t = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    stars = Array.from({ length: Math.round((w * h) / 9000) }, () => ({
      x: Math.random() * w,
      y: Math.random() * h * 0.55,
      r: Math.random() * 1.2 + 0.2,
      p: Math.random() * Math.PI * 2,
    }));

    mines = Array.from({ length: 7 }, () => ({
      x: w * (0.45 + Math.random() * 0.5),
      y: h * (0.66 + Math.random() * 0.28),
      vx: 0.06 + Math.random() * 0.08,
      vy: (Math.random() - 0.5) * 0.03,
      seen: 0,
    }));
  }

  const seaTop = () => h * 0.6;

  function drawSea() {
    const top = seaTop();
    const g = ctx.createLinearGradient(0, top, 0, h);
    g.addColorStop(0, "#0c2238");
    g.addColorStop(1, "#06111f");
    ctx.fillStyle = g;
    ctx.fillRect(0, top, w, h - top);

    ctx.strokeStyle = "rgba(53, 208, 186, 0.08)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 14; i++) {
      const y = top + 10 + i * ((h - top) / 14);
      ctx.beginPath();
      for (let x = 0; x <= w; x += 16) {
        const yy = y + Math.sin(x * 0.012 + t * 0.02 + i) * 2.5;
        x === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
  }

  function drawStars() {
    for (const s of stars) {
      const a = 0.35 + 0.35 * Math.sin(s.p + t * 0.02);
      ctx.fillStyle = `rgba(230, 235, 245, ${a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function satPos() {
    // Satellite moves left to right along a shallow arc, then wraps.
    const period = 1400;
    const u = (t % period) / period;
    const x = -60 + u * (w + 120);
    const y = h * 0.2 + Math.pow((u - 0.5) * 2, 2) * h * 0.08;
    return { x, y };
  }

  function drawOrbit() {
    ctx.strokeStyle = "rgba(148, 160, 184, 0.18)";
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    for (let i = 0; i <= 60; i++) {
      const u = i / 60;
      const x = -60 + u * (w + 120);
      const y = h * 0.2 + Math.pow((u - 0.5) * 2, 2) * h * 0.08;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawSwath(sat) {
    const top = seaTop();
    const half = Math.max(70, w * 0.07);
    const g = ctx.createLinearGradient(0, sat.y, 0, h);
    g.addColorStop(0, "rgba(53, 208, 186, 0.18)");
    g.addColorStop(1, "rgba(53, 208, 186, 0.03)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(sat.x, sat.y + 8);
    ctx.lineTo(sat.x + half, h);
    ctx.lineTo(sat.x - half, h);
    ctx.closePath();
    ctx.fill();
    return { left: (y) => sat.x - half * ((y - sat.y) / (h - sat.y)), right: (y) => sat.x + half * ((y - sat.y) / (h - sat.y)), top };
  }

  function drawSat(sat) {
    ctx.save();
    ctx.translate(sat.x, sat.y);
    ctx.fillStyle = "#35506f";
    ctx.fillRect(-22, -3, 14, 6);
    ctx.fillRect(8, -3, 14, 6);
    ctx.fillStyle = "#d9e1ee";
    ctx.fillRect(-7, -7, 14, 14);
    ctx.fillStyle = "#ff8a3d";
    ctx.beginPath();
    ctx.arc(0, 7, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawMines(swath) {
    for (const m of mines) {
      if (!reduceMotion) {
        m.x += m.vx;
        m.y += m.vy + Math.sin(t * 0.01 + m.x) * 0.02;
      }
      if (m.x > w + 20) { m.x = w * 0.35; m.seen = 0; }
      m.y = Math.min(Math.max(m.y, seaTop() + 12), h - 12);

      const inSwath = m.x > swath.left(m.y) && m.x < swath.right(m.y);
      if (inSwath) m.seen = 1;
      else m.seen = Math.max(0, m.seen - 0.002);

      // mine body
      ctx.fillStyle = "rgba(200, 210, 225, 0.55)";
      ctx.beginPath();
      ctx.arc(m.x, m.y, 3, 0, Math.PI * 2);
      ctx.fill();

      if (m.seen > 0) {
        const a = m.seen;
        // detection ring
        ctx.strokeStyle = `rgba(255, 138, 61, ${a})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(m.x, m.y, 9 + (inSwath ? Math.sin(t * 0.15) * 2 : 0), 0, Math.PI * 2);
        ctx.stroke();
        // predicted drift
        ctx.setLineDash([3, 5]);
        ctx.strokeStyle = `rgba(255, 138, 61, ${a * 0.7})`;
        ctx.beginPath();
        ctx.moveTo(m.x + 10, m.y);
        ctx.lineTo(m.x + m.vx * 600, m.y + m.vy * 600);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  function frame() {
    ctx.clearRect(0, 0, w, h);
    drawStars();
    drawOrbit();
    drawSea();
    const sat = satPos();
    const swath = drawSwath(sat);
    drawMines(swath);
    drawSat(sat);
    t += 1;
    if (!reduceMotion) requestAnimationFrame(frame);
  }

  window.addEventListener("resize", resize);
  resize();
  if (reduceMotion) t = 500;
  frame();
})();

// Fade sections in as they scroll into view.
(() => {
  const targets = document.querySelectorAll(".section h2, .card, .stat, .pipeline li, .comp, .phase, .flow, .callout, .dash-teaser");
  targets.forEach((el) => el.classList.add("reveal"));
  if (!("IntersectionObserver" in window)) {
    targets.forEach((el) => el.classList.add("in"));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    }
  }, { threshold: 0.15 });
  targets.forEach((el) => io.observe(el));
})();
