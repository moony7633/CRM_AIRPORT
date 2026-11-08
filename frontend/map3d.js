/* Лёгкий 3D-вид перрона: canvas 2D, изометрия с перспективой, без внешних библиотек.
   Специально минимальный: один проход отрисовки по событию, DPR ≤ 1.5, без rAF-цикла. */
const Map3D = (() => {
  const QCOL = {'Планер': '#4F6F91', 'Двигатель': '#B06B43', 'Авионика': '#796289'};
  const AC_COL = {inbound: '#5D8568', parked: '#577491', departing: '#AC7444'};
  const PAPER = '#F3F0E7';
  const FOV = 55 * Math.PI / 180;
  const H_TERMINAL = 20, H_HANGAR = 26;

  let cv = null, ctx = null, W = 0, H = 0, dpr = 1, active = false;
  let AIR = null, S = null, sel = {};
  let yaw = Math.PI / 2 - 0.35, pitch = 0.92, dist = 2200;
  let target = {x: 0, y: 0, z: 0};
  let drag = null, pointers = new Map(), pinch = null;
  let hit = [], raf = 0, cb = {};
  let fitted = false;
  let fast = false, fastTimer = 0;

  const nodes = new Map();
  const stands = [], bases = [];
  let areas = [], runways = [], park = [], edges = [];

  function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; }
  function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
  function dot(a, b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }

  function camera() {
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cam = [target.x + dist*cp*Math.cos(yaw),
                 target.y + dist*cp*Math.sin(yaw),
                 target.z + dist*sp];
    const fwd = norm([target.x-cam[0], target.y-cam[1], target.z-cam[2]]);
    const right = norm(cross([0, 0, 1], fwd));
    const up = cross(fwd, right);
    const f = 0.5 * H / Math.tan(FOV / 2);
    return {cam, fwd, right, up, f};
  }

  function proj(cam, x, y, z) {
    const v = [x-cam.cam[0], y-cam.cam[1], z-cam.cam[2]];
    const depth = dot(v, cam.fwd);
    if (depth < 1) return null;
    return {
      x: W/2 + cam.f * dot(v, cam.right) / depth,
      y: H/2 - cam.f * dot(v, cam.up) / depth,
      d: depth,
    };
  }

  function polyPath(pts) {
    const p = new Path2D();
    p.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x, pts[i].y);
    p.closePath();
    return p;
  }

  function screenScale(cam) { return cam.f / Math.max(dist, 1); }

  function drawGround(cam) {
    // сетка земли — чтобы 3D не «висел в пустоте»
    const step = 250, ext = 6000;
    ctx.strokeStyle = 'rgba(107,94,73,.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = target.x - ext; gx <= target.x + ext; gx += step) {
      const a = proj(cam, gx, target.y - ext, 0), b = proj(cam, gx, target.y + ext, 0);
      if (a && b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    }
    for (let gy = target.y - ext; gy <= target.y + ext; gy += step) {
      const a = proj(cam, target.x - ext, gy, 0), b = proj(cam, target.x + ext, gy, 0);
      if (a && b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    }
    ctx.stroke();

    // перроны
    ctx.fillStyle = '#E6DED0';
    for (const a of areas) {
      if (a.kind !== 'apron') continue;
      const pts = a.points.map(p => proj(cam, p[0], p[1], 0));
      if (pts.some(p => !p)) continue;
      const path = polyPath(pts);
      ctx.fill(path);
      ctx.strokeStyle = 'rgba(135,120,97,.28)';
      ctx.lineWidth = 1;
      ctx.stroke(path);
    }
    // разметка всех мест стоянок (только вблизи, чтобы не тратить кадры)
    if (!fast && dist < 5200) {
      ctx.strokeStyle = 'rgba(141,126,101,.55)';
      ctx.lineWidth = Math.max(0.7, Math.min(2, screenScale(cam) * 4));
      const path = new Path2D();
      for (const p of park) {
        const pts = p.points.map(q => proj(cam, q[0], q[1], 0.2));
        if (pts.some(q => !q)) continue;
        path.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
        path.closePath();
      }
      ctx.stroke(path);
    }
    // ВПП
    const sc = screenScale(cam);
    for (const r of runways) {
      const w = Math.max(2, (r.width || 45) * sc);
      ctx.strokeStyle = '#C3B8A3';
      ctx.lineWidth = w;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      let started = false;
      for (const q of r.points) {
        const p = proj(cam, q[0], q[1], 0.1);
        if (!p) { started = false; continue; }
        if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(251,247,239,.88)';
      ctx.lineWidth = Math.max(1, w * 0.045);
      ctx.setLineDash([Math.max(6, w * 0.8), Math.max(6, w * 0.6)]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // рулёжки + перронные проезды
    const tw = Math.max(0.9, Math.min(26, 22 * sc));
    for (const kind of ['taxiway', 'apron']) {
      const w = kind === 'apron' ? tw * 0.55 : tw;
      ctx.strokeStyle = kind === 'apron' ? '#D6CDBB' : '#C7BDA8';
      ctx.lineWidth = w;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const e of edges) {
        if ((e.kind || 'taxiway') !== kind) continue;
        const a = proj(cam, e.x1, e.y1, 0.3), b = proj(cam, e.x2, e.y2, 0.3);
        if (!a || !b) continue;
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }
  }

  function drawBuildings(cam) {
    const faces = [];
    for (const a of areas) {
      if (a.kind !== 'terminal' && a.kind !== 'hangar') continue;
      const h = a.kind === 'hangar' ? H_HANGAR : H_TERMINAL;
      const base = a.points.map(p => proj(cam, p[0], p[1], 0));
      const top = a.points.map(p => proj(cam, p[0], p[1], h));
      if (base.some(p => !p) || top.some(p => !p)) continue;
      const rgb = a.kind === 'hangar' ? [198, 185, 166] : [207, 196, 178];
      const n = a.points.length;
      const topD = top.reduce((s, p) => s + p.d, 0) / n;
      faces.push({pts: top, d: topD - 0.01, fill: `rgb(${rgb[0]+22},${rgb[1]+21},${rgb[2]+19})`});
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (!base[i] || !base[j] || !top[i] || !top[j]) continue;
        const dx = a.points[j][0] - a.points[i][0], dy = a.points[j][1] - a.points[i][1];
        const l = Math.hypot(dx, dy) || 1;
        const shade = 0.78 + 0.22 * Math.abs((-dy/l) * 0.55 + (dx/l) * 0.83);
        const c = rgb.map(v => Math.round(v * shade));
        faces.push({pts: [base[i], base[j], top[j], top[i]],
                    d: (base[i].d + base[j].d + top[i].d + top[j].d) / 4,
                    fill: `rgb(${c[0]},${c[1]},${c[2]})`});
      }
    }
    faces.sort((a, b) => b.d - a.d);
    ctx.lineJoin = 'round';
    for (const f of faces) {
      const p = polyPath(f.pts);
      ctx.fillStyle = f.fill;
      ctx.fill(p);
      ctx.strokeStyle = 'rgba(129,112,88,.20)';
      ctx.lineWidth = 0.8;
      ctx.stroke(p);
    }
  }

  function drawRoute(cam, pts, color, width) {
    if (!pts || pts.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash([]);
    ctx.beginPath();
    let started = false;
    for (const q of pts) {
      const p = proj(cam, q[0], q[1], 0.9);
      if (!p) { started = false; continue; }
      if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  function drawStands(cam, hot, parked, selStand) {
    const sc = screenScale(cam);
    for (const st of stands) {
      const p = proj(cam, st.x, st.y, 0.4);
      if (!p) continue;
      const r = Math.max(6, Math.min(26, 34 * sc));
      const isHot = hot[st.id], isEm = isHot === 'emergency', isSel = st.id === selStand;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = parked[st.id] ? 'rgba(87,116,145,.14)' : 'rgba(255,252,246,.72)';
      ctx.fill();
      ctx.lineWidth = isSel ? 2.6 : 1.6;
      ctx.strokeStyle = isSel ? '#23221F' : isEm ? '#A9433C' : isHot ? '#C2603F' : '#B5AB98';
      ctx.stroke();
      // крест стоянки
      ctx.strokeStyle = isEm ? '#A9433C' : '#B5AB98';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x - r*0.55, p.y); ctx.lineTo(p.x + r*0.55, p.y);
      ctx.moveTo(p.x, p.y - r*0.55); ctx.lineTo(p.x, p.y + r*0.55);
      ctx.stroke();
      if (!fast && (dist < 3200 || isSel || isHot)) {
        ctx.font = '600 12px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = isEm ? '#A9433C' : '#5D5546';
        ctx.shadowColor = PAPER; ctx.shadowBlur = 4;
        ctx.fillText(st.id, p.x, p.y + r + 14);
        ctx.shadowBlur = 0;
      }
      hit.push({x: p.x, y: p.y, r: Math.max(12, r), type: 'stand', id: st.id});
    }
  }

  function drawBases(cam) {
    for (const b of bases) {
      const p = proj(cam, b.x, b.y, 1.2);
      if (!p) continue;
      const s = 9;
      ctx.fillStyle = 'rgba(252,250,246,.92)';
      ctx.strokeStyle = '#4F7655';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.rect(p.x - s/2, p.y - s/2, s, s);
      ctx.fill(); ctx.stroke();
      if (!fast && dist < 5200) {
        ctx.font = '500 11px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#4F7655';
        ctx.shadowColor = PAPER; ctx.shadowBlur = 4;
        ctx.fillText(b.name, p.x, p.y + 24);
        ctx.shadowBlur = 0;
      }
    }
  }

  function drawTechs(cam) {
    for (const t of S.techs || []) {
      const p = proj(cam, t.x, t.y, 1.8);
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, t.id === sel.tech ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = QCOL[t.qual] || '#8A8272';
      ctx.fill();
      ctx.strokeStyle = 'rgba(252,250,246,.95)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      if (t.route && t.route.length > 1) drawRoute(cam, t.route, (QCOL[t.qual] || '#8A8272') + '88', 2.2);
      hit.push({x: p.x, y: p.y, r: 9, type: 'tech', id: t.id});
    }
  }

  function drawAircraft(cam) {
    for (const a of S.aircraft || []) {
      const p = proj(cam, a.x, a.y, 4);
      if (!p) continue;
      const ahead = proj(cam, a.x + 40 * Math.cos((a.heading - 90) * Math.PI / 180),
                              a.y + 40 * Math.sin((a.heading - 90) * Math.PI / 180), 4);
      const ang = ahead ? Math.atan2(ahead.y - p.y, ahead.x - p.x) : -Math.PI / 2;
      const size = Math.max(7, Math.min(18, 30 * screenScale(cam) * 2));
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(size, 0);
      ctx.lineTo(-size * 0.7, size * 0.55);
      ctx.lineTo(-size * 0.35, 0);
      ctx.lineTo(-size * 0.7, -size * 0.55);
      ctx.closePath();
      ctx.fillStyle = AC_COL[a.status] || '#8A8272';
      ctx.fill();
      ctx.strokeStyle = 'rgba(252,250,246,.92)';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (a.id === sel.aircraft) {
        ctx.beginPath();
        ctx.arc(0, 0, size + 5, 0, Math.PI * 2);
        ctx.strokeStyle = '#C2603F';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();
      if (a.flight) {
        ctx.font = '600 10px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#23221F';
        ctx.shadowColor = PAPER; ctx.shadowBlur = 4;
        ctx.fillText(a.flight, p.x, p.y - size - 6);
        ctx.shadowBlur = 0;
      }
      hit.push({x: p.x, y: p.y, r: 14, type: 'aircraft', id: a.id});
    }
  }

  function drawGse(cam) {
    for (const g of S.gse || []) {
      const p = proj(cam, g.x, g.y, 1.2);
      if (!p) continue;
      const size = Math.max(5, Math.min(12, 18 * screenScale(cam) * 2));
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((g.heading - 90) * Math.PI / 180);
      ctx.fillStyle = g.color || '#A9833E';
      ctx.fillRect(-size/2, -size/3, size, size*0.66);
      ctx.restore();
    }
  }

  function draw() {
    raf = 0;
    if (!active || !ctx || !S) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#F6F2E9'); g.addColorStop(1, '#EAE4D6');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const cam = camera();
    hit = [];
    drawGround(cam);
    drawBuildings(cam);

    const hot = {}, parked = {}, selStand = sel.stand || null;
    for (const q of S.active || []) {
      if (!hot[q.stand] || q.priority === 'emergency') hot[q.stand] = q.priority;
    }
    for (const a of S.aircraft || []) if (a.stand && a.status === 'parked') parked[a.stand] = a;

    drawStands(cam, hot, parked, selStand);
    drawBases(cam);
    // маршруты самолётов и GSE до объектов
    for (const a of S.aircraft || []) if (a.route && a.route.length > 1) drawRoute(cam, a.route, 'rgba(93,133,104,.52)', 2);
    for (const gse of S.gse || []) if (gse.route && gse.route.length > 1) drawRoute(cam, gse.route, (gse.color || '#A9833E') + '66', 1.6);
    drawGse(cam);
    drawAircraft(cam);
    drawTechs(cam);

    ctx.font = '500 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(80,72,58,.62)';
    ctx.fillText('3D · перетащите мышью, колесо — масштаб, двойной клик — к перрону', W - 16, H - 16);
  }

  function schedule() { if (!raf) raf = requestAnimationFrame(draw); }

  function resize() {
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    if (!fitted) fit(false);
    schedule();
  }

  function fit(all) {
    if (!AIR) return;
    let xs, ys;
    if (all) {
      xs = AIR.nodes.map(n => n.x); ys = AIR.nodes.map(n => n.y);
      for (const r of AIR.runways) for (const p of r.points) { xs.push(p[0]); ys.push(p[1]); }
    } else {
      xs = stands.map(s => s.x); ys = stands.map(s => s.y);
    }
    if (!xs.length) return;
    const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
    target = {x: (minx + maxx) / 2, y: (miny + maxy) / 2, z: 0};
    dist = Math.max(420, Math.max(maxx - minx, maxy - miny) * (all ? 1.05 : 1.55) + 260);
    fitted = true;
    schedule();
  }

  function setActive(on) {
    active = !!on;
    if (!cv) return;
    cv.hidden = !active;
    const map = document.getElementById('map');
    if (map) map.style.display = active ? 'none' : '';
    const btn = document.getElementById('view3d');
    if (btn) btn.textContent = active ? '2D' : '3D';
    if (active) { resize(); if (!fitted) fit(false); schedule(); }
  }

  function zoom(k) { dist = Math.min(20000, Math.max(160, dist * k)); schedule(); }

  function init(airport, handlers) {
    AIR = airport; cb = handlers || {};
    cv = document.getElementById('map3d');
    if (!cv) return;
    ctx = cv.getContext('2d', {alpha: false});
    for (const n of AIR.nodes) nodes.set(n.id, n);
    for (const s of AIR.stands) { const n = nodes.get(s.node); if (n) stands.push({...s, x: n.x, y: n.y}); }
    for (const b of AIR.bases) { const n = nodes.get(b.node); if (n) bases.push({...b, x: n.x, y: n.y}); }
    areas = AIR.areas || [];
    runways = AIR.runways || [];
    park = AIR.parking || [];
    edges = (AIR.edges || []).map(e => {
      const a = nodes.get(e.a), b = nodes.get(e.b);
      return a && b ? {kind: e.kind, x1: a.x, y1: a.y, x2: b.x, y2: b.y} : null;
    }).filter(Boolean);

    window.addEventListener('resize', resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(cv);

    cv.addEventListener('wheel', ev => {
      ev.preventDefault();
      dist = Math.min(20000, Math.max(160, dist * Math.exp(ev.deltaY * 0.0012)));
      fast = true;
      clearTimeout(fastTimer);
      fastTimer = setTimeout(() => { fast = false; schedule(); }, 140);
      schedule();
    }, {passive: false});

    cv.addEventListener('pointerdown', ev => {
      cv.setPointerCapture(ev.pointerId);
      pointers.set(ev.pointerId, {x: ev.clientX, y: ev.clientY});
      if (pointers.size === 1) {
        drag = {x: ev.clientX, y: ev.clientY, yaw, pitch, moved: false};
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = {d: Math.hypot(a.x - b.x, a.y - b.y), dist};
        drag = null;
      }
    });

    cv.addEventListener('pointermove', ev => {
      if (!pointers.has(ev.pointerId)) return;
      pointers.set(ev.pointerId, {x: ev.clientX, y: ev.clientY});
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 1) dist = Math.min(20000, Math.max(160, pinch.dist * pinch.d / d));
        fast = true;
        clearTimeout(fastTimer);
        fastTimer = setTimeout(() => { fast = false; schedule(); }, 140);
        schedule();
        return;
      }
      if (!drag) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (!drag.moved) return;
      fast = true;
      yaw = drag.yaw - dx * 0.006;
      pitch = Math.max(0.18, Math.min(1.45, drag.pitch + dy * 0.005));
      schedule();
    });

    const end = ev => {
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinch = null;
      const wasFast = fast;
      fast = false;
      clearTimeout(fastTimer);
      if (pointers.size === 0 && drag) {
        const moved = drag.moved;
        drag = null;
        if (moved) { if (wasFast) schedule(); return; }
        let best = null, bestD = Infinity;
        for (const h of hit) {
          const d = Math.hypot(h.x - ev.clientX, h.y - ev.clientY);
          if (d <= h.r && d < bestD) { best = h; bestD = d; }
        }
        if (best) {
          if (best.type === 'stand' && cb.onStand) cb.onStand(best.id);
          else if (best.type === 'aircraft' && cb.onAircraft) cb.onAircraft(best.id);
        }
        if (wasFast) schedule();
      } else if (wasFast) schedule();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('dblclick', () => fit(false));
    cv.hidden = true;
  }

  function update(state, selection) {
    S = state; sel = selection || {};
    if (active) schedule();
  }

  return {init, update, setActive, zoom, fit, isActive: () => active, resize};
})();
