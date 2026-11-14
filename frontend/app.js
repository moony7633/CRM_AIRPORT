/* Аэрофлот · Диспетчер ОТО */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = sec => {
  if (sec == null) return '—';
  sec = Math.max(0, Math.round(sec));
  return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
};
const clockHM = simSec => {
  const base = new Date(); base.setHours(6, 0, 0, 0);
  const t = new Date(base.getTime() + (simSec || 0) * 1000);
  return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
};
const NS = 'http://www.w3.org/2000/svg';
const QCOL = {'Планер': 'var(--glider)', 'Двигатель': 'var(--engine)', 'Авионика': 'var(--avionics)'};
const AC_COL = {inbound: '#5D8568', parked: '#577491', departing: '#AC7444'};
const NORM = 900;

let AIR = null, S = null, ws = null;
let role = 'dispatcher';
try { role = localStorage.getItem('role') || 'dispatcher'; } catch (e) {}
let selReq = null, selTech = null, selAircraft = null;
let showGps = true;
try { showGps = localStorage.getItem('showGps') !== 'false'; } catch (e) {}
const openCands = new Set();
const cache = {};
const mapEl = {edges: {}, stands: {}, techs: {}, aircraft: {}, gse: {}};
let vb = {x: 0, y: 0, w: 1, h: 1};

/* Кеш карточки правой панели. Учитываем наличие gps в снапшоте —
   чтобы карточка перерисовалась, если gps появился позже. */
let _detailCache = { id: null, status: null, sp: null, hasGps: null, hidden: true };

window.addEventListener('error', e => {
  console.error('[JS error]', e.message, (e.filename || '') + ':' + (e.lineno || ''));
});

/* ---------- сеть ---------- */
async function api(path, body) {
  const opts = {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Role': role}};
  if (body !== undefined) opts.body = JSON.stringify(body);
  try {
    const r = await fetch(path, opts);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.detail || 'Ошибка сервера');
    }
    return await r.json();
  } catch (e) { toast(e.message, true); throw e; }
}
function toast(text, bad) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = text;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => (t.hidden = true), 3500);
}
function connect() {
  try {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => { const c = $('#conn'); if (c) c.className = 'conn on'; };
    ws.onmessage = ev => {
      try {
        S = JSON.parse(ev.data);
        try {
          localStorage.setItem('snapshot', ev.data);
          localStorage.setItem('snapshot_ts', new Date().toLocaleTimeString());
        } catch (e) {}
        render();
      } catch (e) { console.error(e); }
    };
    ws.onclose = () => {
      const c = $('#conn'); if (c) c.className = 'conn off';
      setTimeout(connect, 1500);
    };
    ws.onerror = () => {};
  } catch (e) {
    console.error('WS error', e);
    setTimeout(connect, 1500);
  }
}

/* ---------- смещение GSE от оси дороги ---------- */
function laneOffsetPoint(x, y, headingDeg, lane) {
  if (!lane) return [x, y];
  const rad = (headingDeg - 90) * Math.PI / 180;
  return [x + Math.cos(rad) * lane, y + Math.sin(rad) * lane];
}
function offsetPolyline(points, lane) {
  if (!lane || points.length < 2) return points;
  const out = [];
  for (let i = 0; i < points.length; i++) {
    let dx, dy;
    if (i === 0) { dx = points[1][0] - points[0][0]; dy = points[1][1] - points[0][1]; }
    else if (i === points.length - 1) { dx = points[i][0] - points[i-1][0]; dy = points[i][1] - points[i-1][1]; }
    else { dx = points[i+1][0] - points[i-1][0]; dy = points[i+1][1] - points[i-1][1]; }
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    out.push([points[i][0] + nx * lane, points[i][1] + ny * lane]);
  }
  return out;
}
function avoidPlanes(x, y, planes, radius, push) {
  let ox = 0, oy = 0;
  for (const p of planes) {
    const dx = x - p.x, dy = y - p.y;
    const d = Math.hypot(dx, dy);
    if (d < radius && d > 0.01) {
      const k = (radius - d) / radius * push;
      ox += (dx / d) * k;
      oy += (dy / d) * k;
    }
  }
  return [ox, oy];
}

/* ---------- карта ---------- */
function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
const PLANE = 'M0,-40 L6,-10 L40,10 L40,18 L6,8 L4,30 L16,38 L16,44 L0,40 L-16,44 L-16,38 L-4,30 L-6,8 L-40,18 L-40,10 L-6,-10 Z';

function buildMap() {
  const svg = $('#map');
  if (!svg) return;
  svg.innerHTML = '';
  const N = Object.fromEntries(AIR.nodes.map(n => [n.id, n]));
  const standPts = (AIR.stands || []).map(s => N[s.node]).filter(Boolean);
  if (standPts.length) {
    const xs = standPts.map(p => p.x), ys = standPts.map(p => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    let w = Math.max(...xs) - Math.min(...xs) + 700;
    let h = Math.max(...ys) - Math.min(...ys) + 700;
    const ar = (window.innerWidth || 16) / (window.innerHeight || 9);
    if (w / h < ar) w = h * ar; else h = w / ar;
    vb = {x: cx - w / 2, y: cy - h / 2, w, h};
  } else {
    vb = {x: 0, y: 0, w: AIR.width, h: AIR.height};
  }
  applyVB();
  const gA = el('g', {}, svg), gP = el('g', {id: 'parking'}, svg),
        gR = el('g', {}, svg), gE = el('g', {}, svg),
        gAlt = el('g', {id: 'alt'}, svg), gRoute = el('g', {id: 'routes'}, svg);
  const gB = el('g', {}, svg), gS = el('g', {}, svg),
        gGSE = el('g', {id: 'gse'}, svg),
        gAC = el('g', {id: 'aircraft'}, svg),
        gT = el('g', {id: 'techs'}, svg);

  (AIR.areas || []).forEach(a => {
    const p = el('polygon', {points: a.points.map(q => q.join(',')).join(' '), class: 'area-' + a.kind}, gA);
    p.setAttribute('stroke-width', 4);
    el('title', {}, p).textContent = a.name || a.kind;
  });
  (AIR.parking || []).forEach(p => {
    el('polygon', {points: p.points.map(q => q.join(',')).join(' '), class: 'parking'}, gP);
  });
  (AIR.runways || []).forEach(r => {
    const pts = r.points.map(q => q.join(',')).join(' ');
    el('polyline', {points: pts, class: 'rwy', 'stroke-width': r.width || 45}, gR);
    el('polyline', {points: pts, class: 'rwy-mark', 'stroke-width': 4}, gR);
    el('title', {}, gR.lastChild).textContent = 'ВПП ' + (r.name || '');
  });
  AIR.edges.forEach(e => {
    const a = N[e.a], b = N[e.b];
    const line = el('line', {x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'edge ' + (e.kind || ''),
      'stroke-width': e.kind === 'apron' ? 22 : 30}, gE);
    el('title', {}, line).textContent = (e.name ? 'РД ' + e.name : e.id) + ', ' + Math.round(e.length) + ' м';
    el('line', {x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'edge-hit', 'data-edge': e.id}, gE);
    mapEl.edges[e.id] = line;
  });
  AIR.bases.forEach(b => {
    const n = N[b.node], g = el('g', {class: 'base', transform: `translate(${n.x},${n.y})`}, gB);
    el('rect', {x: -28, y: -28, width: 56, height: 56, rx: 8}, g);
    el('text', {y: 82}, g).textContent = b.name;
  });
  AIR.stands.forEach(s => {
    const n = N[s.node], g = el('g', {class: 'stand', 'data-stand': s.id, transform: `translate(${n.x},${n.y})`}, gS);
    el('circle', {class: 'ring', r: 38}, g);
    el('path', {class: 'plane', d: PLANE, transform: `rotate(${s.heading ?? 0}) scale(0.5)`}, g);
    el('text', {y: 52, 'font-size': '22', 'text-anchor': 'middle', 'font-weight': 'bold', fill: '#4A4335'}, g).textContent = s.id;
    el('title', {}, g).textContent = 'Стоянка ' + s.id;
    mapEl.stands[s.id] = g;
  });
  if (S) {
    (S.techs || []).forEach(t => techEl(t, gT));
    (S.aircraft || []).forEach(a => aircraftEl(a, gAC));
    (S.gse || []).forEach(g => gseEl(g, gGSE));
  }
}
function techEl(t, parent) {
  const g = el('g', {class: 'tech', 'data-tech': t.id}, parent || $('#techs'));
  el('circle', {r: 30, fill: QCOL[t.qual]}, g);
  el('text', {}, g).textContent = t.id;
  el('text', {class: 'tech-gps', y: 60}, g).textContent = '';
  el('title', {}, g).textContent = `${t.name}, ${t.qual}, ${t.speed} м/с`;
  mapEl.techs[t.id] = g;
  return g;
}
function aircraftEl(a, parent) {
  const g = el('g', {class: 'aircraft ' + a.status, 'data-aircraft': a.id}, parent || $('#aircraft'));
  const wrap = el('g', {class: 'ac-plane-wrap'}, g);
  el('path', {class: 'ac-plane', d: PLANE, transform: 'scale(0.35)'}, wrap);
  el('text', {class: 'ac-label', y: -30}, g).textContent = a.flight;
  el('text', {class: 'ac-gps', y: 50}, g).textContent = '';
  el('title', {}, g).textContent = `${a.flight} ${a.model} — ${a.status_ru}${a.stand ? ' (' + a.stand + ')' : ''}`;
  mapEl.aircraft[a.id] = g;
  return g;
}
function gseEl(g, parent) {
  const grp = el('g', {class: 'gse ' + g.status, 'data-gse': g.id}, parent || $('#gse'));
  const wrap = el('g', {class: 'gse-wrap'}, grp);
  el('rect', {class: 'gse-body', x: -18, y: -12, width: 36, height: 24, rx: 4,
              fill: g.color}, wrap);
  el('text', {class: 'gse-label', y: 3}, wrap).textContent = g.short;
  el('text', {class: 'gse-gps', y: 30}, grp).textContent = '';
  el('title', {}, grp).textContent = `${g.label} — ${g.status_ru}`;
  mapEl.gse[g.id] = grp;
  return grp;
}
function applyVB() {
  const m = $('#map');
  if (m) m.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
}
function zoom(k, cx, cy) {
  if (!AIR) return;
  const full = AIR.width;
  const nw = Math.min(Math.max(vb.w * k, full / 12), full * 1.2), kk = nw / vb.w;
  cx = cx ?? vb.x + vb.w / 2; cy = cy ?? vb.y + vb.h / 2;
  vb = {x: cx - (cx - vb.x) * kk, y: cy - (cy - vb.y) * kk, w: nw, h: vb.h * kk};
  applyVB();
}
function svgPoint(ev) {
  const svg = $('#map'), pt = svg.createSVGPoint();
  pt.x = ev.clientX; pt.y = ev.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}
function initMapEvents() {
  const svg = $('#map');
  if (!svg) return;
  svg.addEventListener('wheel', ev => {
    ev.preventDefault();
    const p = svgPoint(ev);
    zoom(ev.deltaY < 0 ? 0.87 : 1.15, p.x, p.y);
  }, {passive: false});
  let drag = null;
  svg.addEventListener('pointerdown', ev => {
    drag = {x: ev.clientX, y: ev.clientY, vx: vb.x, vy: vb.y, moved: false};
    svg.setPointerCapture(ev.pointerId);
  });
  svg.addEventListener('pointermove', ev => {
    if (!drag) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) { drag.moved = true; svg.classList.add('drag'); }
    if (!drag.moved) return;
    const r = svg.getBoundingClientRect(), s = Math.max(vb.w / r.width, vb.h / r.height);
    vb.x = drag.vx - dx * s; vb.y = drag.vy - dy * s;
    applyVB();
  });
  svg.addEventListener('pointerup', ev => {
    const moved = drag && drag.moved;
    drag = null; svg.classList.remove('drag');
    if (moved) return;

    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    const acEl = t && t.closest('[data-aircraft]');
    const edge = t && t.closest('[data-edge]');
    const st   = t && t.closest('[data-stand]');

    if (acEl) {
      const id = +acEl.dataset.aircraft;
      selAircraft = selAircraft === id ? null : id;
      selReq = null;
      _detailCache = {id: null, status: null, sp: null, hasGps: null, hidden: true};
      render();
      return;
    }
    if (role !== 'dispatcher') return;
    if (st) openDialog(st.getAttribute('data-stand'));
    else if (edge) {
      const id = edge.getAttribute('data-edge');
      api(`/api/edges/${id}/block`, {blocked: !S.blocked.includes(id)}).catch(() => {});
    } else { selAircraft = null; selReq = null; render(); }
  });
  const zi = $('#zin'); if (zi) zi.onclick = () => Map3D.isActive() ? Map3D.zoom(0.8) : zoom(0.8);
  const zo = $('#zout'); if (zo) zo.onclick = () => Map3D.isActive() ? Map3D.zoom(1.25) : zoom(1.25);
  const zf = $('#zfit'); if (zf) zf.onclick = () => {
    if (Map3D.isActive()) { Map3D.fit(false); return; }
    vb = {x: 0, y: 0, w: AIR.width, h: AIR.height}; applyVB();
  };
  const v3 = $('#view3d'); if (v3) v3.onclick = () => Map3D.setActive(!Map3D.isActive());
}
function renderMap() {
  const seenAc = new Set();
  (S.aircraft || []).forEach(a => {
    seenAc.add(a.id);
    const g = mapEl.aircraft[a.id] || aircraftEl(a);
    g.style.transform = `translate(${a.x}px, ${a.y}px)`;
    const wrap = g.querySelector('.ac-plane-wrap');
    if (wrap) wrap.style.transform = `rotate(${a.heading}deg)`;

    const gpsEl = g.querySelector('.ac-gps');
    if (gpsEl) {
      if (showGps && a.gps) {
        gpsEl.textContent = `${a.gps.lat.toFixed(5)}, ${a.gps.lon.toFixed(5)}`;
        gpsEl.style.display = '';
      } else {
        gpsEl.style.display = 'none';
      }
    }

    let cls = 'aircraft ' + a.status;
    if (selAircraft === a.id) cls += ' sel';
    g.setAttribute('class', cls);
    const t = g.querySelector('title');
    if (t) t.textContent = `${a.flight} ${a.model} — ${a.status_ru}${a.stand ? ' (' + a.stand + ')' : ''}`;
  });
  for (const id in mapEl.aircraft) {
    if (!seenAc.has(+id)) { mapEl.aircraft[id].remove(); delete mapEl.aircraft[id]; }
  }

  const planes = (S.aircraft || []).filter(a => a.status !== 'departing');

  const seenGse = new Set();
  (S.gse || []).forEach(g => {
    seenGse.add(g.id);
    const el2 = mapEl.gse[g.id] || gseEl(g);
    const lane = (S.gse_types?.[g.gtype]?.lane) ?? g.lane ?? 0;
    let [px, py] = laneOffsetPoint(g.x, g.y, g.heading, lane);
    const [ox, oy] = avoidPlanes(g.x, g.y, planes, 110, 30);
    px += ox; py += oy;
    el2.style.transform = `translate(${px}px, ${py}px)`;
    const wrap = el2.querySelector('.gse-wrap');
    if (wrap) wrap.style.transform = `rotate(${g.heading}deg)`;

    const gpsEl = el2.querySelector('.gse-gps');
    if (gpsEl) {
      if (showGps && g.gps) {
        gpsEl.textContent = `${g.gps.lat.toFixed(5)}, ${g.gps.lon.toFixed(5)}`;
        gpsEl.style.display = '';
      } else {
        gpsEl.style.display = 'none';
      }
    }

    el2.setAttribute('class', 'gse ' + g.status);
    const t = el2.querySelector('title');
    if (t) t.textContent = `${g.label} — ${g.status_ru}${g.target ? ' (борт ' + g.target + ')' : ''}`;
  });
  for (const id in mapEl.gse) {
    if (!seenGse.has(+id)) { mapEl.gse[id].remove(); delete mapEl.gse[id]; }
  }

  (S.techs || []).forEach(t => {
    const g = mapEl.techs[t.id] || techEl(t);
    g.style.transform = `translate(${t.x}px, ${t.y}px)`;

    const gpsEl = g.querySelector('.tech-gps');
    if (gpsEl) {
      if (showGps && t.gps) {
        gpsEl.textContent = `${t.gps.lat.toFixed(5)}, ${t.gps.lon.toFixed(5)}`;
        gpsEl.style.display = '';
      } else {
        gpsEl.style.display = 'none';
      }
    }

    g.setAttribute('class', 'tech ' + t.status + (selTech === t.id ? ' sel' : ''));
  });

  const alt = $('#alt'); if (alt) {
    alt.innerHTML = '';
    const sel = selReq ? S.active.find(r => r.id === selReq) : null;
    if (sel && sel.candidates) {
      sel.candidates.forEach(c => {
        if (!c.path || c.path.length < 2) return;
        if (c.reason && c.reason.startsWith('выбран')) return;
        const tech = S.techs.find(t => t.id === c.tech_id);
        const col = tech ? QCOL[tech.qual] : '#8A8272';
        el('polyline', {class: 'alt-route', points: c.path.map(p => p.join(',')).join(' '), stroke: col}, alt);
      });
    }
  }

  const r = $('#routes'); if (r) {
    r.innerHTML = '';
    (S.techs || []).forEach(t => {
      if (t.route.length > 1)
        el('polyline', {class: 'route', points: t.route.map(p => p.join(',')).join(' '), stroke: QCOL[t.qual]}, r);
    });
    (S.aircraft || []).forEach(a => {
      if (a.route && a.route.length > 1)
        el('polyline', {class: 'ac-route', points: a.route.map(p => p.join(',')).join(' ')}, r);
    });
    (S.gse || []).forEach(g => {
      if (g.route && g.route.length > 1) {
        const lane = (S.gse_types?.[g.gtype]?.lane) ?? g.lane ?? 0;
        const off = offsetPolyline(g.route, lane);
        el('polyline', {class: 'gse-route', stroke: g.color,
                        points: off.map(p => p.join(',')).join(' ')}, r);
      }
    });
  }

  for (const id in mapEl.edges) mapEl.edges[id].classList.toggle('blocked', S.blocked.includes(id));
  const hot = {};
  S.active.forEach(q => { if (!hot[q.stand] || q.priority === 'emergency') hot[q.stand] = q.priority; });
  const selStand = S.active.find(q => q.id === selReq)?.stand;
  const parked = {};
  (S.aircraft || []).forEach(a => { if (a.stand && a.status === 'parked') parked[a.stand] = a; });
  for (const id in mapEl.stands) {
    const cls = 'stand'
      + (hot[id] ? ' hot' : '')
      + (hot[id] === 'emergency' ? ' em' : '')
      + (selStand === id ? ' sel' : '')
      + (parked[id] ? ' has-plane' : '');
    mapEl.stands[id].setAttribute('class', cls);
  }
}

/* ---------- списки ---------- */
function setHTML(id, html) {
  const node = $(id);
  if (!node) return;
  if (cache[id] === html) return;
  cache[id] = html;
  node.innerHTML = html;
}
function reqCard(r) {
  const em = r.priority === 'emergency';
  const act = {
    enroute: ['arrive', 'Отметить прибытие'], arrived: ['start', 'Начать работу'], working: ['resolve', 'Дефект устранён'],
  }[r.status];
  const left = r.status === 'enroute' ? `<span data-live="left" data-id="${r.id}">—</span>`
    : r.status === 'waiting' ? 'ждёт' : 'на месте';
  const cands = (r.candidates || []).map(c => {
    const pick = c.reason && c.reason.startsWith('выбран');
    const delay = c.delay ? `<span class="muted"> +${fmt(c.delay)} простой</span>` : '';
    return `<tr class="${pick ? 'pick' : ''}">
      <td>${esc(c.name)}</td>
      <td>${c.dist == null ? '—' : c.dist + ' м'}</td>
      <td>${c.eta == null ? '—' : fmt(c.eta)}${delay}</td>
      <td>${esc(c.reason || 'подходит')}</td></tr>`;
  }).join('');
  return `<article class="req st-${r.status}${em ? ' em' : ''}${selReq === r.id ? ' sel' : ''}" data-id="${r.id}">
    <header>
      <span class="id">#${r.id}</span>
      ${r.flight ? `<span class="flight-tag">${esc(r.flight)}</span>` : ''}
      <span class="stand-tag">${esc(r.stand)}</span>
      <span class="qual q-${esc(r.qual)}">${esc(r.qual)}</span>
      ${em ? '<span class="badge em">ЧС</span>' : ''}
      <span class="status">${esc(r.status_ru)}</span>
    </header>
    <p class="desc">${esc(r.description)}${r.extra ? `<br><small class="muted">${esc(r.extra)}</small>` : ''}</p>
    ${r.note ? `<p class="note">${esc(r.note)}</p>` : ''}
    <dl class="kv">
      <div><dt>Техник</dt><dd>${esc(r.tech_name || '—')}</dd></div>
      <div><dt>До прибытия</dt><dd>${left}</dd></div>
      <div><dt>С момента вызова</dt><dd data-live="elapsed" data-id="${r.id}">${fmt(r.elapsed)}</dd></div>
    </dl>
    <div class="bar"><i data-live="bar" data-id="${r.id}"></i></div>
    <div class="actions dispatcher-only">
      ${act ? `<button class="primary" data-act="${act[0]}" data-id="${r.id}">${act[1]}</button>` : ''}
      <button class="danger" data-act="cancel" data-id="${r.id}">Отменить</button>
    </div>
    ${cands ? `<details data-det="${r.id}" ${openCands.has(r.id) ? 'open' : ''}>
      <summary>Почему выбран этот техник</summary>
      <table><tr><th>Техник</th><th>Путь</th><th>ETA</th><th>Решение</th></tr>${cands}</table></details>` : ''}
  </article>`;
}
function flightRow(a) {
  const eta = a.status === 'inbound' ? '→ стоянка' : a.status === 'departing' ? '→ вылет' : 'на перроне';
  return `<tr class="ac-${a.status}${selAircraft === a.id ? ' sel' : ''}" data-ac-row="${a.id}">
    <td><b>${esc(a.flight)}</b></td>
    <td>${esc(a.model)}</td>
    <td>${esc(a.stand || '—')}</td>
    <td>${esc(a.status_ru)}<small class="muted"> ${eta}</small></td>
  </tr>`;
}
function renderFlights() {
  const list = (S.aircraft || []).slice().sort((a, b) => a.id - b.id);
  if (!list.length) return '<p class="empty">Активных рейсов нет. Нажмите «+ Рейс» или подождите — борта прилетают автоматически.</p>';
  return `<table class="flights-table">
    <tr><th>Рейс</th><th>Тип ВС</th><th>Стоянка</th><th>Статус</th></tr>
    ${list.map(flightRow).join('')}
  </table>`;
}
function boardRow(a) {
  const b = a.brief || {};
  const origin = b.origin?.iata || '—';
  const dest = b.destination?.iata || '—';
  const route = `${origin} → ${dest}`;
  const schedTime = a.sched_arr_sim != null ? clockHM(a.sched_arr_sim) : '—';
  const actualTime = a.actual_arr_sim != null ? clockHM(a.actual_arr_sim) : null;
  const delaySec = a.delay_arr_sec || 0;
  const delayed = delaySec > 60;
  const airline = b.airline || '—';
  const reg = b.registration || '—';

  let badgeCls = 'bd-badge st-' + a.status;
  let badgeTxt = a.status_ru;
  if (a.status === 'inbound' && delayed) {
    badgeCls = 'bd-badge st-delayed';
    badgeTxt = `Задержан +${Math.round(delaySec/60)}м`;
  } else if (a.status === 'inbound') {
    badgeCls = 'bd-badge st-inbound';
    badgeTxt = 'В воздухе';
  } else if (a.status === 'parked') {
    const prog = a.services_progress || 0;
    badgeTxt = prog >= 100 ? 'Готов к вылету' : 'Обслуживание';
    if (prog >= 100) badgeCls = 'bd-badge st-ready';
  }

  const svcBar = a.services && a.services.length
    ? `<div class="board-bar"><i style="width:${a.services_progress || 0}%"></i></div>` : '';

  const when = actualTime
    ? `<b class="bd-time">${actualTime}</b><span class="bd-sched">факт</span>`
    : `<b class="bd-time">${schedTime}</b>${delayed
        ? `<span class="bd-delay">+${Math.round(delaySec / 60)}м</span>`
        : `<span class="bd-sched">план</span>`}`;

  return `<button type="button" class="board-row ac-${a.status}${selAircraft === a.id ? ' sel' : ''}" data-ac-row="${a.id}">
    <span class="bd-when">${when}</span>
    <span class="bd-main">
      <span class="bd-line">
        <b class="bd-flight">${esc(a.flight)}</b>
        <span class="bd-airline">${esc(airline)}</span>
        <span class="bd-reg">${esc(reg)}</span>
      </span>
      <span class="bd-sub">
        <span class="bd-route">${route}</span>
        <span class="bd-model">${esc(a.model)}</span>
        <span class="bd-stand">Стоянка ${esc(a.stand || '—')}</span>
        ${b.gate ? `<span class="bd-gate">Выход ${esc(b.gate)}</span>` : ''}
      </span>
    </span>
    <span class="bd-status"><span class="${badgeCls}">${esc(badgeTxt)}</span>${svcBar}</span>
  </button>`;
}
function renderBoard() {
  const list = (S.aircraft || []).slice().sort((a, b) => a.id - b.id);
  const header = `
    <div class="board-head">
      <div class="board-title">Табло рейсов</div>
      <div class="board-time">${new Date().toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'})}
        <small>местное время</small></div>
    </div>`;
  if (!list.length) {
    return header + '<p class="empty">Рейсов нет. Борта прилетают автоматически или по кнопке «+ Рейс».</p>';
  }
  const rows = list.map(boardRow).join('');
  return header + `<div class="board-list">${rows}</div>`;
}
function techRow(t) {
  const st = t.status === 'free' ? 'Свободен' : 'Занят';
  return `<div class="trow${selTech === t.id ? ' sel' : ''}" data-tech-row="${t.id}">
    <span class="dot" style="background:${QCOL[t.qual]}"></span>
    <div class="grow"><b>${esc(t.name)}</b><small>${esc(t.qual)} · ${(t.types || []).join(', ') || 'все типы'} · ${t.speed} м/с</small></div>
    <div>${st}${t.request_id ? `<small>заявка #${t.request_id}</small>` : ''}</div></div>`;
}
function render() {
  if (!AIR || !S) return;
  const st = S.stats;
  const cards = [
    [st.aircraft_total, 'бортов'],
    [st.aircraft_parked, 'на стоянках'],
    [st.aircraft_inbound, 'на заходе'],
    [st.techs_free + '/' + st.techs_total, 'техников'],
    [st.gse_busy + '/' + st.gse_total, 'техники ОТО'],
    [st.norm_pct == null ? '—' : st.norm_pct + '%', 'в норматив'],
  ];
  setHTML('#stats', cards.map(c => `<div class="stat"><b>${c[0]}</b><span>${c[1]}</span></div>`).join(''));

  if (S.llm) {
    const pill = $('#llmPill');
    const m = $('#llmModel');
    if (m) m.textContent = S.llm.mode === 'llm' ? S.llm.model : 'встроенный';
    if (pill) pill.title = S.llm.mode === 'llm'
      ? `Провайдер: ${S.llm.url} · модель ${S.llm.model}`
      : 'LLM не подключена, используется встроенный генератор. Задайте LLM_BASE_URL для подключения.';
  }

  const cA = $('#cActive'); if (cA) cA.textContent = S.active.length ? `(${S.active.length})` : '';
  const cAc = $('#cFlights');
  if (cAc) cAc.textContent = (S.aircraft && S.aircraft.length) ? `(${S.aircraft.length})` : '';
  const sp = $('#speed'); if (sp && document.activeElement !== sp) sp.value = String(S.sim_speed);

  setHTML('#pane-board', renderBoard());
  setHTML('#pane-active', S.active.length ? S.active.map(reqCard).join('')
    : '<p class="empty">Активных заявок нет. Нажмите «Создать заявку» или кликните по стоянке на карте.</p>');
  setHTML('#pane-flights', renderFlights());
  setHTML('#pane-techs', (S.techs || []).map(techRow).join(''));
  setHTML('#pane-log', S.events.map(e => `<div class="ev ${esc(e.kind)}"><time>${esc(e.ts)}</time><span>${esc(e.text)}</span></div>`).join('')
    + '<div class="tools dispatcher-only"><button class="danger" data-act="reset">Сбросить демо-данные</button></div>');

  renderLive();
  renderDetail();
  renderMap();
  if (typeof Map3D !== 'undefined') Map3D.update(S, {
    tech: selTech, aircraft: selAircraft,
    stand: selReq ? (S.active.find(q => q.id === selReq)?.stand || null) : null,
  });
}
function renderLive() {
  // Заявки: ETA / время / прогресс-бар
  S.active.forEach(r => {
    const q = k => $(`[data-live="${k}"][data-id="${r.id}"]`);
    if (q('left')) q('left').textContent = fmt(r.eta_left);
    if (q('elapsed')) q('elapsed').textContent = fmt(r.elapsed);
    const b = q('bar');
    if (b) {
      b.style.width = Math.min(100, r.elapsed / NORM * 100) + '%';
      b.className = r.elapsed > NORM ? 'over' : r.elapsed > NORM * 0.7 ? 'warn' : '';
    }
  });

  // Карточка самолёта: GPS, курс, ETA, время до вылета — обновляем в реальном времени
  if (selAircraft != null) {
    const a = (S.aircraft || []).find(x => x.id === selAircraft);
    if (a) {
      document.querySelectorAll(`[data-live-gps="${a.id}"]`).forEach(node => {
        node.textContent = a.gps
          ? `${a.gps.lat.toFixed(6)}, ${a.gps.lon.toFixed(6)}`
          : 'Ожидание данных от сервера…';
      });
      document.querySelectorAll(`[data-live-heading="${a.id}"]`).forEach(node => {
        node.textContent = `${(a.heading ?? 0).toFixed(1)}°`;
      });
      document.querySelectorAll(`[data-live-eta-left="${a.id}"]`).forEach(node => {
        if (a.eta_left != null) node.textContent = fmt(a.eta_left);
      });
      document.querySelectorAll(`[data-live-parked-left="${a.id}"]`).forEach(node => {
        if (a.parked_left != null) node.textContent = fmt(a.parked_left);
      });
    }
  }
}

/* ---------- Правая панель ---------- */
function renderDetail() {
  const p = $('#detailPanel');
  if (!p) return;

  if (selAircraft == null) {
    p.hidden = true;
    p.classList.remove('open');
    _detailCache = {id: null, status: null, sp: null, hasGps: null, hidden: true};
    return;
  }
  const a = (S.aircraft || []).find(x => x.id === selAircraft);
  if (!a) {
    selAircraft = null;
    p.hidden = true;
    p.classList.remove('open');
    _detailCache = {id: null, status: null, sp: null, hasGps: null, hidden: true};
    return;
  }

  // Кеш: если тот же самолёт, тот же статус, тот же прогресс и то же наличие gps —
  // не пересобираем HTML (иначе сбрасывается скролл и мигает содержимое).
  // GPS, курс, ETA обновляются через renderLive() каждые 0.4 сек.
  const hasGpsNow = !!a.gps;
  if (_detailCache.id === a.id &&
      _detailCache.status === a.status &&
      _detailCache.sp === a.services_progress &&
      _detailCache.hasGps === hasGpsNow) {
    if (p.hidden || !p.classList.contains('open')) {
      p.hidden = false;
      requestAnimationFrame(() => p.classList.add('open'));
      _detailCache.hidden = false;
    }
    return;
  }

  _detailCache = {id: a.id, status: a.status, sp: a.services_progress, hasGps: hasGpsNow, hidden: false};

  const reqs = [...S.active, ...S.history].filter(r => r.aircraft_id === a.id);
  const b = a.brief || {};

  const etaBlock = a.status === 'inbound' && a.eta_left != null
    ? `<div><dt>Прибытие через</dt><dd data-live-eta-left="${a.id}">${fmt(a.eta_left)}</dd></div>` : '';
  const parkedBlock = a.status === 'parked' && a.parked_left != null
    ? `<div><dt>Вылет через</dt><dd data-live-parked-left="${a.id}">${fmt(a.parked_left)}</dd></div>` : '';

  const servicesHtml = (a.services || []).length
    ? `<ul class="svc-list">
        ${a.services.map(s => {
          const meta = S.gse_types?.[s.gtype] || {};
          return `<li class="svc-item st-${s.status}">
            <span class="svc-dot" style="background:${meta.color || '#888'}"></span>
            <span class="svc-name">${esc(meta.label || s.gtype)}</span>
            <span class="svc-status">${
              s.status === 'pending' ? 'ожидает' :
              s.status === 'active'  ? 'в работе' : 'готово'
            }</span>
          </li>`;
        }).join('')}
      </ul>` : '<p class="empty small">Сервисные работы не запланированы.</p>';

  const schedArr = a.sched_arr_sim != null ? clockHM(a.sched_arr_sim) : '—';
  const actualArr = a.actual_arr_sim != null ? clockHM(a.actual_arr_sim) : null;
  const delaySec = a.delay_arr_sec || 0;
  const delayLabel = delaySec > 60
    ? `<span class="delay-badge">+${Math.round(delaySec/60)} мин</span>` : '';
  const schedDep = a.sched_dep_sim != null ? clockHM(a.sched_dep_sim) : '—';

  const srcTag = a.brief
    ? `<span class="src-tag ${a.brief.source === 'llm' ? 'llm' : ''}">
         ${a.brief.source === 'llm' ? '🤖 LLM' : 'шаблон'}
       </span>`
    : `<span class="src-tag">…</span>`;

  // GPS-блок рендерится ВСЕГДА. Если данных ещё нет — покажет заглушку,
  // а renderLive() подставит реальные координаты, как только они появятся.
  const gpsCard = `
    <section class="dp-gps-card">
      <div class="dp-gps-head">
        <span class="dp-gps-dot"></span>
        <span>GPS · координаты в реальном времени</span>
      </div>
      <div class="dp-gps-value" data-live-gps="${a.id}">${
        a.gps ? `${a.gps.lat.toFixed(6)}, ${a.gps.lon.toFixed(6)}` : 'Ожидание данных от сервера…'
      }</div>
      <div class="dp-gps-meta">
        <span>Курс: <b data-live-heading="${a.id}">${(a.heading ?? 0).toFixed(1)}°</b></span>
        <span>Стоянка: <b>${esc(a.stand || '—')}</b></span>
        <span>${esc(a.status_ru)}</span>
      </div>
    </section>`;

  const briefHtml = `
    <section class="dp-brief">
      <h4>Карточка рейса ${srcTag}</h4>

      <div class="brief-header">
        <div class="brief-airline">${esc(b.airline || '—')}</div>
        <div class="brief-flight">${esc(a.flight)}</div>
      </div>

      <div class="brief-route">
        <div class="brief-point">
          <div class="bp-iata">${esc(b.origin?.iata || '—')}</div>
          <div class="bp-city">${esc(b.origin?.city || '')}</div>
          <div class="bp-airport">${esc(b.origin?.airport || '')}</div>
        </div>
        <div class="brief-arrow">✈</div>
        <div class="brief-point">
          <div class="bp-iata">${esc(b.destination?.iata || '—')}</div>
          <div class="bp-city">${esc(b.destination?.city || '')}</div>
          <div class="bp-airport">${esc(b.destination?.airport || '')}</div>
        </div>
      </div>

      <div class="brief-times">
        <div><span>По расписанию</span><b>${schedArr}</b></div>
        <div><span>Фактически</span><b>${actualArr || '—'} ${delayLabel}</b></div>
        <div><span>Вылет план</span><b>${schedDep}</b></div>
      </div>

      <div class="brief-grid">
        <div><span>Тип ВС</span><b>${esc(a.model)}</b></div>
        <div><span>Регистрация</span><b>${esc(b.registration || '—')}</b></div>
        <div><span>Выход</span><b>${esc(b.gate || '—')}</b></div>
        <div><span>Стоянка</span><b>${esc(a.stand || '—')}</b></div>
        <div><span>Пассажиры</span><b>${b.passengers ?? '—'}</b></div>
        <div><span>Экипаж</span><b>${b.crew ?? '—'}</b></div>
        <div><span>Груз</span><b>${b.cargo_kg != null ? b.cargo_kg + ' кг' : '—'}</b></div>
        <div><span>Сервисы</span><b>${a.services_progress || 0}%</b></div>
      </div>

      ${b.note ? `<p class="brief-note">${esc(b.note)}</p>` : ''}
    </section>`;

  const departBtn = (a.status === 'parked' && role === 'dispatcher')
    ? `<button class="primary" data-ac-depart="${a.id}">Отправить на вылет</button>` : '';

  p.innerHTML = `
    <header class="dp-head">
      <div class="dp-title">
        <span class="dp-flight">${esc(a.flight)}</span>
        <span class="dp-model">${esc(a.model)}${b.registration ? ' · ' + esc(b.registration) : ''}</span>
      </div>
      <button class="dp-close" data-ac-close aria-label="Закрыть">×</button>
    </header>

    ${gpsCard}

    <div class="dp-status st-${a.status}">
      <span class="dot" style="background:${AC_COL[a.status]}"></span>
      <span>${esc(a.status_ru)}</span>
    </div>

    <dl class="dp-kv">
      ${a.stand ? `<div><dt>Стоянка</dt><dd>${esc(a.stand)}</dd></div>` : ''}
      ${b.gate ? `<div><dt>Выход</dt><dd>${esc(b.gate)}</dd></div>` : ''}
      ${etaBlock}
      ${parkedBlock}
    </dl>

    ${briefHtml}

    <section class="dp-services">
      <h4>Обслуживание на перроне</h4>
      ${servicesHtml}
    </section>

    ${departBtn ? `<div class="dp-actions">${departBtn}</div>` : ''}

    <section class="dp-reqs">
      <h4>Заявки по борту</h4>
      ${reqs.length ? reqs.map(r => `
        <div class="dp-req st-${r.status}${r.priority === 'emergency' ? ' em' : ''}">
          <b>#${r.id}</b>
          <span class="dp-req-q qual q-${esc(r.qual)}">${esc(r.qual)}</span>
          <span class="dp-req-st">${esc(r.status_ru)}</span>
          <div class="dp-req-desc">${esc(r.description)}</div>
        </div>`).join('')
      : '<p class="empty small">Нет заявок на этот борт.</p>'}
    </section>
  `;
  p.hidden = false;
  requestAnimationFrame(() => p.classList.add('open'));
}

/* ---------- действия ---------- */
function updateFlightInfo() {
  const stand = $('#fStand').value;
  const info = $('#fFlightInfo');
  if (!info) return;
  const a = (S.aircraft || []).find(x => x.stand === stand && x.status === 'parked');
  if (a) {
    info.textContent = `Борт ${a.flight} · ${a.model}`;
    info.classList.add('has-flight');
  } else {
    info.textContent = 'Борт на стоянке отсутствует — заявка будет привязана к стоянке';
    info.classList.remove('has-flight');
  }
}
function openDialog(stand) {
  if (role !== 'dispatcher') return;
  const fStand = $('#fStand');
  if (!fStand) return;
  fStand.innerHTML = AIR.stands.map(s => `<option>${esc(s.id)}</option>`).join('');
  if (stand) fStand.value = stand;
  const fe = $('#fErr'); if (fe) fe.hidden = true;
  updateFlightInfo();
  const dlg = $('#dlg'); if (dlg) dlg.showModal();
  const fd = $('#fDesc'); if (fd) fd.focus();
}
function initUI() {
  const an = $('#airportName'); if (an) an.textContent = AIR.name + (AIR.source ? ', ' + AIR.source : '');
  const rl = $('#role'); if (rl) {
    rl.value = role;
    document.body.className = role;
    rl.onchange = e => {
      role = e.target.value; document.body.className = role;
      try { localStorage.setItem('role', role); } catch (err) {}
      render();
    };
  }

  const chk = $('#chkGps');
  if (chk) {
    chk.checked = showGps;
    chk.onchange = e => {
      showGps = e.target.checked;
      try { localStorage.setItem('showGps', showGps); } catch (err) {}
      if (typeof Map3D !== 'undefined' && Map3D.setShowGps) Map3D.setShowGps(showGps);
      render();
    };
  }

  const sp = $('#speed'); if (sp) sp.onchange = e => api('/api/sim', {speed: +e.target.value}).catch(() => {});
  const nb = $('#newBtn'); if (nb) nb.onclick = () => openDialog();
  const na = $('#newAcBtn'); if (na) na.onclick = () => api('/api/aircraft/spawn').catch(() => {});
  const fc = $('#fCancel'); if (fc) fc.onclick = () => { const d = $('#dlg'); if (d) d.close(); };
  const fs = $('#fStand'); if (fs) fs.onchange = updateFlightInfo;
  const form = $('#form'); if (form) form.onsubmit = async ev => {
    ev.preventDefault();
    try {
      await api('/api/requests', {
        stand: $('#fStand').value, description: $('#fDesc').value, qual: $('#fQual').value,
        extra: $('#fExtra').value, priority: $('#fEm').checked ? 'emergency' : 'normal',
      });
      const d = $('#dlg'); if (d) d.close();
      form.reset();
    } catch (e) { const fe = $('#fErr'); if (fe) { fe.textContent = e.message; fe.hidden = false; } }
  };
  const tabs = $('#tabs'); if (tabs) tabs.onclick = e => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + b.dataset.tab));
  };
  document.addEventListener('click', e => {
    if (e.target.closest('[data-ac-close]')) { selAircraft = null; render(); return; }
    const dep = e.target.closest('[data-ac-depart]');
    if (dep) { e.stopPropagation(); api(`/api/aircraft/${dep.dataset.acDepart}/depart`).catch(() => {}); return; }
    const b = e.target.closest('[data-act]');
    if (b) {
      e.stopPropagation();
      const id = b.dataset.id;
      if (b.dataset.act === 'reset') {
        if (confirm('Удалить все заявки и журнал?')) api('/api/reset').catch(() => {});
      } else api(`/api/requests/${id}/${b.dataset.act}`).catch(() => {});
      return;
    }
    const acRow = e.target.closest('[data-ac-row]');
    if (acRow) {
      const newId = +acRow.dataset.acRow;
      if (selAircraft !== newId) {
        _detailCache = {id: null, status: null, sp: null, hasGps: null, hidden: true};
      }
      selAircraft = newId;
      selReq = null;
      render();
      return;
    }
    const card = e.target.closest('.req');
    if (card && !e.target.closest('details')) {
      selReq = +card.dataset.id;
      const r = S.active.find(q => q.id === selReq);
      selTech = r ? r.tech_id : null;
      selAircraft = null;
      render(); return;
    }
    const row = e.target.closest('[data-tech-row]');
    if (row) { const id = +row.dataset.techRow; selTech = selTech === id ? null : id; render(); }
  });
  document.addEventListener('toggle', e => {
    const d = e.target.closest && e.target.closest('details[data-det]');
    if (!d) return;
    const id = +d.dataset.det;
    d.open ? openCands.add(id) : openCands.delete(id);
  }, true);
}

(async function main() {
  try {
    AIR = await (await fetch('/api/airport')).json();
    S = await (await fetch('/api/state')).json();

    connect();

    initUI();
    initMapEvents();
    buildMap();
    Map3D.init(AIR, {
      onStand: id => openDialog(id),
      onAircraft: id => {
        if (selAircraft !== id) {
          _detailCache = {id: null, status: null, sp: null, hasGps: null, hidden: true};
        }
        selAircraft = id;
        selReq = null;
        render();
      },
    });
    if (typeof Map3D.setShowGps === 'function') Map3D.setShowGps(showGps);
    if (new URLSearchParams(location.search).get('view') === '3d' || location.hash === '#3d') {
      Map3D.setActive(true);
    }
    render();
  } catch (e) {
    console.error('Ошибка инициализации:', e);
    toast('Ошибка инициализации: ' + e.message, true);
  }
})();
