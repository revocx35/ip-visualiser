// ip-visualiser hub UI — vanilla ES module, no build step.

import { clampPan, clampZoom, zoomAt } from './viewmath.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  user: null,
  settings: { lineColor: '#35e0ff', timeWindowMinutes: 120, retentionHours: 168 },
  servers: [],
  agents: [],
  connections: [],
  stats: { events: 0, lines: 0, topHosts: [] },
  windowMinutes: 120,
  page: 'map',
  mode: 'login',
  lastFetch: 0,
  live: false,
};

const WINDOW_MIN = 2;
const WINDOW_MAX = 1440;

/* ---------------------------------------------------------------- helpers */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDuration(min) {
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) {
    const h = min / 60;
    return `${h % 1 === 0 ? h : h.toFixed(1)}h`;
  }
  const d = min / 1440;
  return `${d % 1 === 0 ? d : d.toFixed(1)}d`;
}

function fmtAgo(seconds) {
  if (!seconds) return 'never';
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function fmtCount(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

function colorToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return { r: 53, g: 224, b: 255 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgba(hex, alpha) {
  const { r, g, b } = colorToRgb(hex);
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/setup')) {
    showAuth('login');
    throw new Error('not signed in');
  }
  if (!res.ok) {
    let msg = `request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data && data.error) msg = data.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

/* ------------------------------------------------------------------ modal */

function closeModal() {
  $('#modal-root').innerHTML = '';
}

function openModal({ title, sub, body, actions }) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true">
        <h2>${esc(title)}</h2>
        ${sub ? `<p class="modal-sub">${sub}</p>` : ''}
        <div class="modal-body">${body}</div>
        <div class="modal-actions">${actions}</div>
      </div>
    </div>`;
  $('#modal-backdrop').addEventListener('mousedown', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });
  return root;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

/* ------------------------------------------------------------------- auth */

function showAuth(mode) {
  state.mode = mode;
  const setup = mode === 'setup';
  $('#main').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  $('#auth-title').textContent = setup ? 'Create the admin account' : 'Sign in';
  $('#auth-sub').textContent = setup
    ? 'This hub has no admin yet. Pick a username and a strong password.'
    : 'Welcome back.';
  $('#auth-pass2-wrap').classList.toggle('hidden', !setup);
  $('#auth-pass2').required = setup;
  $('#auth-pass').autocomplete = setup ? 'new-password' : 'current-password';
  $('#auth-submit').textContent = setup ? 'Create account' : 'Sign in';
  $('#auth-error').classList.add('hidden');
  setTimeout(() => $('#auth-user').focus(), 50);
}

function hideAuth() {
  $('#auth').classList.add('hidden');
  $('#main').classList.remove('hidden');
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#auth-error');
  err.classList.add('hidden');
  const username = $('#auth-user').value.trim();
  const password = $('#auth-pass').value;
  if (state.mode === 'setup') {
    if (password.length < 10) return showErr('Password must be at least 10 characters.');
    if (password !== $('#auth-pass2').value) return showErr('Passwords do not match.');
  }
  const btn = $('#auth-submit');
  btn.disabled = true;
  try {
    const path = state.mode === 'setup' ? '/api/setup' : '/api/login';
    const data = await api(path, { method: 'POST', body: { username, password } });
    state.user = data.user;
    $('#auth-pass').value = '';
    $('#auth-pass2').value = '';
    await enterApp();
  } catch (ex) {
    showErr(ex.message);
  } finally {
    btn.disabled = false;
  }
  function showErr(msg) {
    err.textContent = msg;
    err.classList.remove('hidden');
  }
});

/* -------------------------------------------------------------- app shell */

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  setPage(btn.dataset.page);
});

function setPage(page) {
  state.page = page;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.page === page));
  for (const name of ['map', 'servers', 'agents', 'settings']) {
    $(`#page-${name}`).classList.toggle('hidden', name !== page);
  }
  if (page === 'servers') renderServers();
  if (page === 'agents') renderAgents();
  if (page === 'settings') renderSettings();
  if (page === 'map') requestAnimationFrame(() => map.resize());
}

$('#logout-btn').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch { /* ignore */ }
  state.user = null;
  showAuth('login');
});

async function enterApp() {
  hideAuth();
  await Promise.all([loadStatic(), refresh(true)]);
  setPage('map');
  const s = Math.min(WINDOW_MAX, Math.max(WINDOW_MIN, state.settings.timeWindowMinutes || 120));
  setWindow(s, { refetch: false });
  startPolling();
}

async function loadStatic() {
  const data = await api('/api/state?window=' + encodeURIComponent(state.windowMinutes));
  applyState(data);
}

function applyState(data) {
  state.settings = data.settings || state.settings;
  state.servers = data.servers || [];
  state.agents = data.agents || [];
  state.connections = data.connections || [];
  state.stats = data.stats || state.stats;
  state.serverTime = data.serverTime || Math.floor(Date.now() / 1000);
  state.lastFetch = Date.now();
  state.live = true;
  updateHud();
  if (state.page === 'servers') renderServers();
  if (state.page === 'agents') renderAgents();
}

async function refresh(first = false) {
  try {
    const data = await api('/api/state?window=' + encodeURIComponent(state.windowMinutes));
    applyState(data);
  } catch (err) {
    state.live = false;
    const pill = $('#live-pill');
    pill.classList.remove('on');
    pill.classList.add('err');
    $('#live-label').textContent = 'offline';
    if (first) throw err;
  }
}

let pollTimer = null;
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    refresh().catch(() => {});
  }, 10000);
}

/* --------------------------------------------------------------- map view */

const DAY = 86400;

const map = {
  canvas: null,
  ctx: null,
  land: null,
  base: null,
  rect: { x0: 0, y0: 0, scale: 1 },
  view: { zoom: 1, ox: 0, oy: 0 },
  hits: [],
  hover: null,
  width: 0,
  height: 0,
  dpr: 1,
  dirty: true,
  pointers: new Map(),
  drag: null,
  pinch: null,

  init() {
    this.canvas = $('#map');
    this.ctx = this.canvas.getContext('2d');
    new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement);
    this.resize();
    this.loadLand();

    this.canvas.addEventListener('mousemove', (e) => this.onHover(e));
    this.canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      $('#tooltip').classList.add('hidden');
    });
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('dblclick', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.zoomBy(1.7, { x: e.clientX - r.left, y: e.clientY - r.top });
    });
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));

    $('#zoom-in').addEventListener('click', () => this.zoomBy(1.6));
    $('#zoom-out').addEventListener('click', () => this.zoomBy(1 / 1.6));
    $('#zoom-reset').addEventListener('click', () => this.resetView());

    const loop = () => {
      requestAnimationFrame(loop);
      try {
        this.draw();
      } catch (err) {
        console.warn('map draw failed', err);
      }
    };
    requestAnimationFrame(loop);
  },

  async loadLand() {
    try {
      const res = await fetch('/world.json');
      this.land = await res.json();
      this.dirty = true;
    } catch { /* map still works without land */ }
  },

  resize() {
    const parent = this.canvas.parentElement;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = w;
    this.height = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const padX = w < 700 ? 8 : 28;
    const padY = w < 700 ? 72 : 44;
    const availW = Math.max(50, w - padX * 2);
    const availH = Math.max(50, h - padY * 2);
    const scale = Math.min(availW / 360, availH / 180);
    this.rect = {
      scale,
      x0: (w - 360 * scale) / 2,
      y0: (h - 180 * scale) / 2,
    };
    this.clampView();
    this.base = null;
    this.dirty = true;
  },

  centre() {
    return { x: this.width / 2, y: this.height / 2 };
  },

  /** Projected map rectangle at the current zoom, before panning. */
  bounds() {
    const { x0, y0, scale } = this.rect;
    const c = this.centre();
    const z = this.view.zoom;
    const left = c.x + (x0 - c.x) * z;
    const top = c.y + (y0 - c.y) * z;
    return { left, top, right: left + 360 * scale * z, bottom: top + 180 * scale * z };
  },

  clampView() {
    const { ox, oy } = clampPan(
      this.bounds(),
      { width: this.width, height: this.height },
      this.view.ox,
      this.view.oy,
    );
    this.view.ox = ox;
    this.view.oy = oy;
  },

  projectRaw(lon, lat) {
    const { x0, y0, scale } = this.rect;
    const c = this.centre();
    const z = this.view.zoom;
    const bx = x0 + (lon + 180) * scale;
    const by = y0 + (90 - lat) * scale;
    return [c.x + (bx - c.x) * z, c.y + (by - c.y) * z];
  },

  project(lon, lat) {
    const [x, y] = this.projectRaw(lon, lat);
    return [x + this.view.ox, y + this.view.oy];
  },

  unproject(x, y) {
    const c = this.centre();
    const z = this.view.zoom;
    const bx = (x - this.view.ox - c.x) / z + c.x;
    const by = (y - this.view.oy - c.y) / z + c.y;
    const { x0, y0, scale } = this.rect;
    return { lon: (bx - x0) / scale - 180, lat: 90 - (by - y0) / scale };
  },

  buildBase() {
    // The base is drawn for the current zoom AND pan, then blitted 1:1, so panning never
    // exposes an uncovered strip at the canvas edge.
    const { width: w, height: h, dpr } = this;
    const ox = this.view.ox;
    const oy = this.view.oy;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * dpr));
    c.height = Math.max(1, Math.round(h * dpr));
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const z = this.view.zoom;
    const raw = this.bounds();
    const b = { left: raw.left + ox, top: raw.top + oy, right: raw.right + ox, bottom: raw.bottom + oy };
    const pj = (lon, lat) => {
      const [x, y] = this.projectRaw(lon, lat);
      return [x + ox, y + oy];
    };

    // ocean plate
    ctx.save();
    ctx.fillStyle = 'rgba(11, 23, 38, 0.72)';
    ctx.strokeStyle = 'rgba(96, 150, 200, 0.22)';
    ctx.beginPath();
    ctx.roundRect(b.left, b.top, b.right - b.left, b.bottom - b.top, Math.max(4, 10 * Math.min(z, 2)));
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // graticule — denser as you zoom in
    const step = z < 1.6 ? 30 : z < 3.5 ? 15 : z < 7 ? 10 : 5;
    ctx.save();
    ctx.strokeStyle = 'rgba(96, 140, 190, 0.14)';
    ctx.lineWidth = 1;
    for (let lon = -180; lon <= 180; lon += step) {
      const [x] = pj(lon, 0);
      ctx.beginPath();
      ctx.moveTo(x, b.top);
      ctx.lineTo(x, b.bottom);
      ctx.stroke();
    }
    for (let lat = -90; lat <= 90; lat += step) {
      const [, y] = pj(0, lat);
      if (y < b.top - 1 || y > b.bottom + 1) continue;
      ctx.beginPath();
      ctx.moveTo(b.left, y);
      ctx.lineTo(b.right, y);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(120, 170, 220, 0.24)';
    const [, eqY] = pj(0, 0);
    ctx.beginPath();
    ctx.moveTo(b.left, eqY);
    ctx.lineTo(b.right, eqY);
    ctx.stroke();
    ctx.restore();

    // land
    if (this.land && this.land.features) {
      ctx.save();
      ctx.beginPath();
      for (const f of this.land.features) {
        const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        for (const poly of polys) {
          for (const ring of poly) {
            let prevLon = null;
            for (const [lon, lat] of ring) {
              const [px, py] = pj(lon, lat);
              // A ring crossing the antimeridian would otherwise draw a stripe across the map.
              if (prevLon === null || Math.abs(lon - prevLon) > 180) ctx.moveTo(px, py);
              else ctx.lineTo(px, py);
              prevLon = lon;
            }
          }
        }
      }
      const landGrad = ctx.createLinearGradient(0, b.top, 0, b.bottom);
      landGrad.addColorStop(0, '#1d2f42');
      landGrad.addColorStop(0.45, '#182a3c');
      landGrad.addColorStop(1, '#1b2c3e');
      ctx.fillStyle = landGrad;
      ctx.fill('evenodd');
      ctx.strokeStyle = 'rgba(126, 178, 228, 0.42)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      ctx.restore();
    }

    // frame
    ctx.strokeStyle = 'rgba(96, 140, 190, 0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(b.left + 0.5, b.top + 0.5, b.right - b.left - 1, b.bottom - b.top - 1);
    return c;
  },

  draw() {
    if (!this.ctx || this.width < 2 || this.height < 2) return;
    const ctx = this.ctx;
    if (!this.base || !this.base.width || this.dirty) {
      this.base = this.buildBase();
      this.dirty = false;
    }
    if (!this.base || !this.base.width) return;

    const c = this.centre();
    ctx.clearRect(0, 0, this.width, this.height);

    // backdrop glow stays in screen space so it does not travel while panning
    const glow = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, Math.max(this.width, this.height) * 0.62);
    glow.addColorStop(0, 'rgba(20, 44, 74, 0.5)');
    glow.addColorStop(1, 'rgba(8, 15, 26, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.drawImage(this.base, 0, 0, this.width, this.height);

    const now = Math.floor(Date.now() / 1000);
    const windowSec = Math.max(60, state.windowMinutes * 60);
    const servers = new Map(state.servers.map((s) => [s.id, s]));
    const defaultColor = state.settings.lineColor || '#35e0ff';
    this.hits = [];

    const drawn = state.connections
      .filter((c) => c.lastTs >= now - windowSec)
      .slice(0, 1200);

    // ---- lines
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const c of drawn) {
      const server = servers.get(c.serverId);
      if (!server) continue;
      const age = Math.max(0, now - c.lastTs);
      const frac = Math.max(0, 1 - age / windowSec);
      const alpha = 0.05 + 0.95 * Math.pow(frac, 1.7);
      const color = server.color || defaultColor;
      const [sx, sy] = this.project(c.lon, c.lat);
      const [tx, ty] = this.project(server.lon, server.lat);
      if (Math.abs(c.lon - server.lon) > 180) continue;

      const dist = Math.hypot(tx - sx, ty - sy);
      const cx = (sx + tx) / 2;
      const cy = (sy + ty) / 2 - dist * 0.16;

      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(cx, cy, tx, ty);
      ctx.strokeStyle = rgba(color, alpha);
      ctx.lineWidth = 0.5 + 1.7 * Math.pow(frac, 1.4) + Math.min(2, Math.log10(1 + c.count) * 0.55);
      ctx.lineCap = 'round';
      ctx.stroke();

      this.hits.push({ type: 'ip', x: sx, y: sy, data: c, server, alpha });
    }
    ctx.restore();

    // ---- ip dots
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const hit of this.hits) {
      if (hit.type !== 'ip') continue;
      const r = 1.4 + 2.4 * hit.alpha;
      const color = hit.server.color || defaultColor;
      const g = ctx.createRadialGradient(hit.x, hit.y, 0, hit.x, hit.y, r * 3.4);
      g.addColorStop(0, rgba(color, 0.55 * hit.alpha));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(hit.x, hit.y, r * 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(232, 248, 255, ${(0.35 + 0.6 * hit.alpha).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(hit.x, hit.y, r * 0.68, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // ---- servers
    let pulse = 0;
    for (const server of state.servers) {
      const [x, y] = this.project(server.lon, server.lat);
      const recent = drawn.some((c) => c.serverId === server.id);
      pulse = (Date.now() % 2400) / 2400;
      this.drawServer(ctx, x, y, server, defaultColor, recent, pulse);
      this.hits.push({ type: 'server', x, y, data: server });
    }

    // ---- hover ring
    if (this.hover) {
      ctx.save();
      ctx.strokeStyle = this.hover.type === 'server' ? 'rgba(255,255,255,0.55)' : rgba(this.hover.server?.color || defaultColor, 0.8);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(this.hover.x, this.hover.y, this.hover.type === 'server' ? 22 : 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  },

  drawServer(ctx, x, y, server, defaultColor, recent, pulse) {
    const color = server.color || defaultColor;
    const size = 24;
    ctx.save();
    if (recent) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, 30);
      g.addColorStop(0, rgba(color, 0.26 * (1 - pulse)));
      g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 30, 0, Math.PI * 2);
      ctx.fill();
    }
    const r = 7;
    const x0 = x - size / 2;
    const y0 = y - size / 2;
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0);
    ctx.arcTo(x0 + size, y0, x0 + size, y0 + size, r);
    ctx.arcTo(x0 + size, y0 + size, x0, y0 + size, r);
    ctx.arcTo(x0, y0 + size, x0, y0, r);
    ctx.arcTo(x0, y0, x0 + size, y0, r);
    ctx.closePath();
    ctx.fillStyle = '#060b12';
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.9);
    ctx.lineWidth = 1.3;
    ctx.stroke();

    ctx.fillStyle = rgba(color, 0.95);
    for (let i = 0; i < 2; i += 1) {
      const ry = y0 + 6 + i * 8;
      ctx.beginPath();
      ctx.roundRect(x0 + 6, ry, size - 12, 5, 1.6);
      ctx.fill();
    }
    ctx.fillStyle = recent ? '#eafcff' : rgba(color, 0.4);
    ctx.beginPath();
    ctx.arc(x0 + size - 8.4, y0 + 8.6, 1.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = '600 11.5px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const label = server.name;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(6, 11, 18, 0.78)';
    ctx.beginPath();
    ctx.roundRect(x - tw / 2 - 7, y + size / 2 + 4, tw + 14, 18, 6);
    ctx.fill();
    ctx.fillStyle = 'rgba(226, 240, 252, 0.92)';
    ctx.fillText(label, x, y + size / 2 + 7);
    ctx.restore();
  },

  /* ------------------------------------------------------------ zoom / pan */

  setView(view) {
    this.view = { zoom: clampZoom(view.zoom), ox: view.ox, oy: view.oy };
    this.clampView();
    this.base = null;
    this.dirty = true;
    this.zoomLabel();
  },

  zoomBy(factor, anchor) {
    const next = clampZoom(this.view.zoom * factor);
    if (next === this.view.zoom) return;
    const v = zoomAt(this.view, next, anchor, this.centre());
    this.setView(v);
  },

  resetView() {
    this.setView({ zoom: 1, ox: 0, oy: 0 });
  },

  zoomLabel() {
    const el = $('#zoom-level');
    if (el) el.textContent = `${this.view.zoom.toFixed(1)}×`;
    const reset = $('#zoom-reset');
    if (reset) reset.disabled = this.view.zoom === 1 && this.view.ox === 0 && this.view.oy === 0;
  },

  onWheel(e) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const unit = e.deltaMode === 1 ? 0.03 : 0.0015;
    const factor = Math.exp(-e.deltaY * unit);
    this.zoomBy(factor, { x: e.clientX - r.left, y: e.clientY - r.top });
  },

  onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.drag = { x: e.clientX, y: e.clientY, ox: this.view.ox, oy: this.view.oy, moved: false };
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        zoom: this.view.zoom,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
      this.drag = null;
    }
  },

  onPointerMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size >= 2) {
      if (!this.pinch) return;
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const r = this.canvas.getBoundingClientRect();
      const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      const next = clampZoom(this.pinch.zoom * (dist / Math.max(1, this.pinch.dist)));
      const v = zoomAt({ zoom: this.pinch.zoom, ox: this.view.ox, oy: this.view.oy }, next, mid, this.centre());
      this.setView(v);
      return;
    }

    if (!this.drag) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    if (!this.drag.moved && Math.abs(dx) + Math.abs(dy) > 3) {
      this.drag.moved = true;
      this.canvas.classList.add('dragging');
      $('#tooltip').classList.add('hidden');
    }
    if (this.drag.moved) {
      this.view.ox = this.drag.ox + dx;
      this.view.oy = this.drag.oy + dy;
      this.clampView();
    }
  },

  onPointerUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) {
      this.drag = null;
      this.canvas.classList.remove('dragging');
    }
  },

  onHover(e) {
    if (this.drag && this.drag.moved) return;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best = null;
    let bestDist = 16;
    for (const hit of this.hits) {
      const d = Math.hypot(hit.x - mx, hit.y - my);
      const limit = hit.type === 'server' ? 22 : 12;
      if (d < limit && d < bestDist) {
        best = hit;
        bestDist = d;
      }
    }
    const serverHit = this.hits.filter((h) => h.type === 'server').find((h) => Math.hypot(h.x - mx, h.y - my) < 24);
    if (serverHit) best = serverHit;
    this.hover = best;
    const tip = $('#tooltip');
    if (!best) {
      tip.classList.add('hidden');
      return;
    }
    tip.innerHTML = best.type === 'server' ? serverTip(best.data) : ipTip(best.data, best.server);
    tip.classList.remove('hidden');
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let tx = mx + 16;
    let ty = my - th / 2;
    if (tx + tw > this.width - 8) tx = mx - tw - 16;
    ty = Math.max(8, Math.min(this.height - th - 8, ty));
    tip.style.left = `${tx}px`;
    tip.style.top = `${ty}px`;
  },
};


function countryName(code) {
  if (!code) return '';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

function ipTip(c, server) {
  const now = Math.floor(Date.now() / 1000);
  const place = [c.city, c.region && !c.city ? c.region : null, countryName(c.country)].filter(Boolean).join(', ') || 'unknown location';
  const hosts = (c.hosts || []).map((h) => `${esc(h.host)} <b>${fmtCount(h.count)}</b>`).join('<br>');
  return `<div class="tt-title mono">${esc(c.ip)}</div>
    <div class="tt-row"><span>place</span><b>${esc(place)}</b></div>
    <div class="tt-row"><span>server</span><b>${esc(server.name)}</b></div>
    <div class="tt-row"><span>requests</span><b>${fmtCount(c.count)}</b></div>
    <div class="tt-row"><span>last seen</span><b>${fmtAgo(now - c.lastTs)}</b></div>
    ${hosts ? `<div class="tt-row" style="margin-top:4px"><span>hosts</span><span style="text-align:right">${hosts}</span></div>` : ''}`;
}

function serverTip(server) {
  const agents = state.agents.filter((a) => a.serverId === server.id);
  const now = Math.floor(Date.now() / 1000);
  const agentRows = agents
    .map((a) => `${esc(a.name)} <b>${a.lastSeen ? fmtAgo(now - a.lastSeen) : 'never'}</b>`)
    .join('<br>');
  return `<div class="tt-title">${esc(server.name)}</div>
    <div class="tt-row"><span>location</span><b class="mono">${server.lat.toFixed(2)}, ${server.lon.toFixed(2)}</b></div>
    <div class="tt-row"><span>agents</span><b>${agents.length}</b></div>
    ${agentRows ? `<div class="tt-row" style="margin-top:4px"><span>last push</span><span style="text-align:right">${agentRows}</span></div>` : ''}`;
}

/* ------------------------------------------------------------- map controls */

function sliderToMinutes(v) {
  const maxMin = Math.min(WINDOW_MAX, (state.settings.retentionHours || 168) * 60);
  const minMin = WINDOW_MIN;
  if (maxMin <= minMin) return minMin;
  return Math.round(minMin * Math.pow(maxMin / minMin, v / 100));
}

function minutesToSlider(min) {
  const maxMin = Math.min(WINDOW_MAX, (state.settings.retentionHours || 168) * 60);
  const minMin = WINDOW_MIN;
  if (maxMin <= minMin) return 0;
  const v = (Math.log(min / minMin) / Math.log(maxMin / minMin)) * 100;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function setWindow(min, { refetch = true } = {}) {
  state.windowMinutes = Math.max(WINDOW_MIN, Math.min(WINDOW_MAX, Math.round(min)));
  $('#window-slider').value = String(minutesToSlider(state.windowMinutes));
  $('#window-label').textContent = fmtDuration(state.windowMinutes);
  updateHud();
  if (refetch) scheduleRefresh();
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(() => {}), 220);
}

$('#window-slider').addEventListener('input', (e) => {
  setWindow(sliderToMinutes(Number(e.target.value)), { refetch: false });
});
$('#window-slider').addEventListener('change', () => {
  setWindow(sliderToMinutes(Number($('#window-slider').value)));
});

function updateHud() {
  const now = Math.floor(Date.now() / 1000);
  const windowSec = state.windowMinutes * 60;
  const visible = state.connections.filter((c) => c.lastTs >= now - windowSec);
  $('#stat-lines').textContent = fmtCount(visible.length);
  const ips = new Set(visible.map((c) => c.ip)).size;
  $('#stat-ips').textContent = fmtCount(ips);
  const events = visible.reduce((sum, c) => sum + c.count, 0);
  $('#stat-events').textContent = fmtCount(events);

  const hosts = $('#top-hosts');
  const top = (state.stats.topHosts || []).slice(0, 7);
  hosts.innerHTML = top.length
    ? top.map((h) => `<li><span class="h-name" title="${esc(h.host)}">${esc(h.host)}</span><span class="h-count">${fmtCount(h.count)}</span></li>`).join('')
    : '<li class="empty">no traffic yet</li>';

  const pill = $('#live-pill');
  pill.classList.toggle('on', state.live);
  pill.classList.toggle('err', !state.live);
  $('#live-label').textContent = state.live ? 'live' : 'offline';

  const empty = $('#empty-hint');
  if (!state.servers.length) {
    empty.classList.remove('hidden');
    $('#empty-hint-text').textContent = 'Add your first server in the Servers tab, then attach an agent.';
  } else if (!visible.length) {
    empty.classList.remove('hidden');
    $('#empty-hint-text').textContent = 'No mapped connections in this window — agents are idle or the window is too short.';
  } else {
    empty.classList.add('hidden');
  }
}

/* ----------------------------------------------------------------- servers */

async function renderServers() {
  const grid = $('#servers-grid');
  if (!state.servers.length) {
    grid.innerHTML = `<div class="card"><div class="card-title">No servers yet</div><p class="card-body">Add the places that receive traffic — your home Nginx Proxy Manager box, your VPS, anything with an agent.</p><div class="card-actions"><button class="primary" id="empty-add">Add server</button></div></div>`;
    $('#empty-add').addEventListener('click', () => serverModal());
    return;
  }
  grid.innerHTML = state.servers
    .map((s) => {
      const agents = state.agents.filter((a) => a.serverId === s.id);
      const color = s.color || state.settings.lineColor;
      return `<article class="card" data-id="${s.id}">
        <div class="card-top">
          <span class="dot" style="background:${esc(color)};color:${esc(color)}"></span>
          <div>
            <div class="card-title">${esc(s.name)}</div>
            <div class="card-sub mono">${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}</div>
          </div>
          <span class="badge" style="margin-left:auto">${agents.length} agent${agents.length === 1 ? '' : 's'}</span>
        </div>
        <div class="card-body">
          ${agents.length ? agents.map((a) => `${esc(a.name)} · ${a.lastSeen ? fmtAgo(Math.floor(Date.now() / 1000) - a.lastSeen) : 'never connected'}`).join('<br>') : 'no agent attached yet'}
        </div>
        <div class="card-actions">
          <button class="ghost small" data-act="agent">Add agent</button>
          <button class="ghost small" data-act="edit">Edit</button>
          <span class="spacer"></span>
          <button class="danger small" data-act="delete">Delete</button>
        </div>
      </article>`;
    })
    .join('');

  grid.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const card = btn.closest('[data-id]');
    const id = Number(card.dataset.id);
    const server = state.servers.find((s) => s.id === id);
    if (!server) return;
    if (btn.dataset.act === 'edit') return serverModal(server);
    if (btn.dataset.act === 'delete') return deleteServer(server);
    if (btn.dataset.act === 'agent') return createAgent(server);
  };
}

$('#add-server-btn').addEventListener('click', () => serverModal());

async function deleteServer(server) {
  openModal({
    title: `Delete ${server.name}?`,
    sub: 'Its agents stop working and all stored connection data for this server is removed.',
    body: '',
    actions: `<button class="ghost" id="m-cancel">Cancel</button><button class="danger" id="m-ok">Delete server</button>`,
  });
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-ok').addEventListener('click', async () => {
    try {
      await api(`/api/servers/${server.id}`, { method: 'DELETE' });
      closeModal();
      await refresh();
      renderServers();
    } catch (err) {
      alert(err.message);
    }
  });
}

function miniMapHtml(id) {
  return `<div class="mini-map-wrap"><canvas class="mini-map" id="${id}"></canvas><span class="mini-map-hint">click the map to place the server</span></div>`;
}

function drawMini(canvas, land, lat, lon) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 420;
  const h = canvas.clientHeight || 190;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const scale = Math.min((w - 8) / 360, (h - 8) / 180);
  const x0 = (w - 360 * scale) / 2;
  const y0 = (h - 180 * scale) / 2;
  const px = (lo) => x0 + (lo + 180) * scale;
  const py = (la) => y0 + (90 - la) * scale;

  ctx.fillStyle = '#08111c';
  ctx.fillRect(0, 0, w, h);
  if (land && land.features) {
    ctx.beginPath();
    for (const f of land.features) {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) {
        for (const ring of poly) {
          let prevLon = null;
          for (const [lo, la] of ring) {
            const X = px(lo);
            const Y = py(la);
            if (prevLon === null || Math.abs(lo - prevLon) > 180) ctx.moveTo(X, Y);
            else ctx.lineTo(X, Y);
            prevLon = lo;
          }
        }
      }
    }
    ctx.fillStyle = '#16232f';
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(120, 168, 214, 0.25)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const cx = px(lon);
    const cy = py(lat);
    ctx.strokeStyle = 'rgba(53, 224, 255, 0.9)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#35e0ff';
    ctx.beginPath();
    ctx.arc(cx, cy, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
  canvas.dataset.scale = String(scale);
  canvas.dataset.x0 = String(x0);
  canvas.dataset.y0 = String(y0);
  return { scale, x0, y0 };
}

async function serverModal(existing) {
  const isEdit = Boolean(existing);
  const initial = existing || { name: '', lat: 48.85, lon: 2.35, color: '' };
  openModal({
    title: isEdit ? `Edit ${existing.name}` : 'Add server',
    sub: 'A server is a destination on the map, not necessarily a physical machine.',
    body: `
      <div class="field"><label for="sv-name">Name</label><input id="sv-name" type="text" maxlength="64" placeholder="home / vps" value="${esc(initial.name)}" /></div>
      <div class="field"><label for="sv-color">Line colour</label>
        <div class="row">
          <input type="color" id="sv-color" value="${esc(initial.color || state.settings.lineColor)}" />
          <input type="text" id="sv-color-hex" class="mono" maxlength="7" value="${esc(initial.color || state.settings.lineColor)}" />
          <button class="ghost small" id="sv-color-clear" type="button">use default</button>
        </div>
      </div>
      <div class="field"><label for="sv-ip">Locate by public IP (optional)</label>
        <div class="row"><input id="sv-ip" type="text" placeholder="e.g. 203.0.113.10" /><button class="ghost small" id="sv-locate" type="button">Look up</button></div>
        <p class="hint" id="sv-locate-hint">or click the map below to place the pin — IP geolocation is only a hint and can be wrong</p>
      </div>
      ${miniMapHtml('sv-mini')}
      <div class="row" style="margin-top:12px">
        <div class="field" style="flex:1;margin:0"><label for="sv-lat">lat</label><input id="sv-lat" type="text" class="mono" value="${initial.lat.toFixed(4)}" /></div>
        <div class="field" style="flex:1;margin:0"><label for="sv-lon">lon</label><input id="sv-lon" type="text" class="mono" value="${initial.lon.toFixed(4)}" /></div>
      </div>`,
    actions: `<button class="ghost" id="m-cancel">Cancel</button><button class="primary" id="m-save">${isEdit ? 'Save' : 'Add server'}</button>`,
  });

  const canvas = $('#sv-mini');
  let lat = Number(initial.lat);
  let lon = Number(initial.lon);
  let explicitColor = Boolean(existing?.color);
  const land = map.land || (await fetch('/world.json').then((r) => r.json()).catch(() => null));

  const paint = () => {
    drawMini(canvas, land, lat, lon);
    $('#sv-lat').value = lat.toFixed(4);
    $('#sv-lon').value = lon.toFixed(4);
  };
  paint();
  requestAnimationFrame(paint);

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const scale = Number(canvas.dataset.scale) || 1;
    const x0 = Number(canvas.dataset.x0) || 0;
    const y0 = Number(canvas.dataset.y0) || 0;
    lon = Math.max(-180, Math.min(180, (x - x0) / scale - 180));
    lat = Math.max(-85, Math.min(85, 90 - (y - y0) / scale));
    paint();
  });

  const syncColor = (value) => {
    $('#sv-color').value = value;
    $('#sv-color-hex').value = value;
  };
  $('#sv-color').addEventListener('input', (e) => {
    explicitColor = true;
    syncColor(e.target.value);
  });
  $('#sv-color-hex').addEventListener('change', (e) => {
    if (/^#[0-9a-f]{6}$/i.test(e.target.value)) {
      explicitColor = true;
      syncColor(e.target.value);
    } else {
      syncColor(explicitColor ? $('#sv-color').value : state.settings.lineColor);
    }
  });
  $('#sv-color-clear').addEventListener('click', () => {
    explicitColor = false;
    syncColor(state.settings.lineColor);
  });

  $('#sv-locate').addEventListener('click', async () => {
    const ip = $('#sv-ip').value.trim();
    if (!ip) return;
    const hint = $('#sv-locate-hint');
    hint.textContent = 'looking up…';
    try {
      const geo = await api('/api/geo?ip=' + encodeURIComponent(ip));
      if (geo.private || geo.lat === null) {
        hint.textContent = 'that address has no public location — click the map instead';
        return;
      }
      lat = geo.lat;
      lon = geo.lon;
      paint();
      hint.textContent = [geo.city, geo.country].filter(Boolean).join(', ') || 'located';
    } catch (err) {
      hint.textContent = err.message;
    }
  });

  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-save').addEventListener('click', async () => {
    const name = $('#sv-name').value.trim();
    if (!name) return alert('Give the server a name.');
    const latN = Number($('#sv-lat').value);
    const lonN = Number($('#sv-lon').value);
    if (!Number.isFinite(latN) || !Number.isFinite(lonN)) return alert('lat/lon must be numbers.');
    const payload = { name, lat: latN, lon: lonN, color: explicitColor ? $('#sv-color-hex').value : null };
    try {
      if (isEdit) await api(`/api/servers/${existing.id}`, { method: 'PATCH', body: payload });
      else await api('/api/servers', { method: 'POST', body: payload });
      closeModal();
      await refresh();
      renderServers();
    } catch (err) {
      alert(err.message);
    }
  });
}

/* ------------------------------------------------------------------ agents */

async function renderAgents() {
  const grid = $('#agents-grid');
  if (!state.agents.length) {
    grid.innerHTML = `<div class="card"><div class="card-title">No agents yet</div><p class="card-body">Open a server and press “Add agent” to mint a token, then run the agent container next to Nginx Proxy Manager.</p></div>`;
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  grid.innerHTML = state.agents
    .map((a) => {
      const server = state.servers.find((s) => s.id === a.serverId);
      const age = a.lastSeen ? now - a.lastSeen : null;
      const online = age !== null && age < 90;
      return `<article class="card" data-id="${a.id}">
        <div class="card-top">
          <span class="dot" style="background:${online ? '#34d399' : '#64748b'};color:${online ? '#34d399' : '#64748b'}"></span>
          <div>
            <div class="card-title">${esc(a.name)}</div>
            <div class="card-sub">${esc(server ? server.name : 'server removed')}</div>
          </div>
          <span class="badge ${online ? 'ok' : 'off'}" style="margin-left:auto">${online ? 'online' : 'offline'}</span>
        </div>
        <div class="card-body">
          last push: ${a.lastSeen ? esc(fmtAgo(age)) : 'never'}<br>
          events shipped: ${fmtCount(a.eventsTotal)}<br>
          from: <span class="mono">${esc(a.remoteIp || '—')}</span>${a.version ? ` · v${esc(a.version)}` : ''}
        </div>
        <div class="card-actions">
          <button class="ghost small" data-act="rename">Rename</button>
          <button class="ghost small" data-act="rotate">New token</button>
          <span class="spacer"></span>
          <button class="danger small" data-act="delete">Delete</button>
        </div>
      </article>`;
    })
    .join('');

  grid.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.closest('[data-id]').dataset.id);
    const agent = state.agents.find((a) => a.id === id);
    if (!agent) return;
    if (btn.dataset.act === 'rename') return renameAgent(agent);
    if (btn.dataset.act === 'rotate') return rotateAgent(agent);
    if (btn.dataset.act === 'delete') return deleteAgent(agent);
  };
}

function renameAgent(agent) {
  openModal({
    title: 'Rename agent',
    sub: 'The name is only used in this UI.',
    body: `<div class="field"><label for="ag-name">Name</label><input id="ag-name" type="text" maxlength="48" value="${esc(agent.name)}" /></div>`,
    actions: `<button class="ghost" id="m-cancel">Cancel</button><button class="primary" id="m-save">Save</button>`,
  });
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-save').addEventListener('click', async () => {
    try {
      await api(`/api/agents/${agent.id}`, { method: 'PATCH', body: { name: $('#ag-name').value.trim() } });
      closeModal();
      await refresh();
      renderAgents();
    } catch (err) {
      alert(err.message);
    }
  });
}

function deleteAgent(agent) {
  openModal({
    title: `Delete ${agent.name}?`,
    sub: 'The agent container keeps running but its token stops working.',
    body: '',
    actions: `<button class="ghost" id="m-cancel">Cancel</button><button class="danger" id="m-ok">Delete agent</button>`,
  });
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-ok').addEventListener('click', async () => {
    try {
      await api(`/api/agents/${agent.id}`, { method: 'DELETE' });
      closeModal();
      await refresh();
      renderAgents();
    } catch (err) {
      alert(err.message);
    }
  });
}

async function rotateAgent(agent) {
  try {
    const { token } = await api(`/api/agents/${agent.id}/rotate`, { method: 'POST' });
    showToken(agent, token, 'New token');
  } catch (err) {
    alert(err.message);
  }
}

async function createAgent(server) {
  try {
    const { agent, token } = await api(`/api/servers/${server.id}/agents`, {
      method: 'POST',
      body: { name: server.name },
    });
    await refresh();
    showToken(agent, token, 'Agent created');
  } catch (err) {
    alert(err.message);
  }
}

function showToken(agent, token, title) {
  const origin = window.location.origin;
  const snippet = `services:
  agent:
    image: ip-visualiser-agent:latest
    container_name: ipvis-agent
    restart: unless-stopped
    environment:
      HUB_URL: ${origin}
      AGENT_TOKEN: ${token}
      AGENT_NAME: ${agent.name}
    volumes:
      - /opt/npm/data/logs:/npm-logs:ro
      - /opt/npm/data/nginx:/npm-conf:ro
      - ./state:/state`;
  openModal({
    title,
    sub: 'Copy this token now — it is stored hashed and will not be shown again.',
    body: `
      <div class="code-block">AGENT_TOKEN=${esc(token)}</div>
      <p class="warn">Run this container on the same Docker host as Nginx Proxy Manager.</p>
      <div class="code-block" style="margin-top:10px">${esc(snippet)}</div>`,
    actions: `<button class="primary" id="m-ok">Done</button>`,
  });
  $('#m-ok').addEventListener('click', () => {
    closeModal();
    renderAgents();
  });
}

/* ---------------------------------------------------------------- settings */

function renderSettings() {
  const s = state.settings;
  $('#set-linecolor').value = s.lineColor;
  $('#set-linecolor-hex').value = s.lineColor;
  $('#set-window').value = String(minutesToSlider(s.timeWindowMinutes || 120));
  $('#set-window-label').textContent = fmtDuration(s.timeWindowMinutes || 120);
  $('#set-retention').value = String(s.retentionHours || 168);
  $('#set-username').textContent = state.user ? state.user.username : '—';
  $('#pw-status').textContent = '';
}

async function saveSettings(patch) {
  try {
    const data = await api('/api/settings', { method: 'PATCH', body: patch });
    state.settings = data.settings;
    await refresh();
    map.dirty = true;
    updateHud();
  } catch (err) {
    alert(err.message);
  }
}

$('#set-linecolor').addEventListener('input', (e) => {
  $('#set-linecolor-hex').value = e.target.value;
});
$('#set-linecolor').addEventListener('change', (e) => saveSettings({ lineColor: e.target.value }));
$('#set-linecolor-hex').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (!/^#[0-9a-f]{6}$/i.test(v)) return alert('Use a hex colour like #35e0ff');
  saveSettings({ lineColor: v });
});
$('#set-window').addEventListener('input', (e) => {
  $('#set-window-label').textContent = fmtDuration(sliderToMinutes(Number(e.target.value)));
});
$('#set-window').addEventListener('change', (e) => {
  const min = sliderToMinutes(Number(e.target.value));
  saveSettings({ timeWindowMinutes: min });
  setWindow(min, { refetch: false });
});
$('#set-retention').addEventListener('change', (e) => {
  saveSettings({ retentionHours: Number(e.target.value) }).then(() => {
    setWindow(Math.min(state.windowMinutes, Number(e.target.value) * 60), { refetch: true });
    renderSettings();
  });
});

$('#pw-save').addEventListener('click', async () => {
  const status = $('#pw-status');
  const current = $('#pw-current').value;
  const next = $('#pw-new').value;
  if (next.length < 10) {
    status.textContent = 'New password must be at least 10 characters.';
    return;
  }
  try {
    await api('/api/password', { method: 'POST', body: { current, password: next } });
    $('#pw-current').value = '';
    $('#pw-new').value = '';
    status.textContent = 'Password updated.';
  } catch (err) {
    status.textContent = err.message;
  }
});

/* -------------------------------------------------------------------- boot */

async function boot() {
  map.init();
  try {
    const b = await api('/api/bootstrap');
    if (b.setupRequired) {
      showAuth('setup');
      $('#boot').classList.add('hidden');
      return;
    }
    try {
      const me = await api('/api/me');
      state.user = me.user;
      $('#boot').classList.add('hidden');
      await enterApp();
    } catch {
      $('#boot').classList.add('hidden');
      showAuth('login');
    }
  } catch (err) {
    $('#boot').innerHTML = `<p class="boot-text">hub unreachable: ${esc(err.message)}</p>`;
  }
}

boot();
