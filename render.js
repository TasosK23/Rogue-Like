/* Wickbound: the canvas renderer.
 *
 * Draws the board from an engine state and plays engine events as animation. Everything here is
 * presentation: nothing in this file can change the rules. All motion is driven by elapsed time,
 * never by frame count, so it plays the same at 60 Hz and 120 Hz. Sparks and smoke use their own
 * random numbers (Math.random), kept apart from the game's seeded generator so they cannot change a run.
 */
(function () {
  'use strict';
  const C = window.WICK_CONFIG, E = window.WickEngine;
  const CFG = C.CONFIG, FEEL = CFG.feel, ENEMIES = C.ENEMIES;
  const W = E.W, H = E.H, N = E.N, T = E.T, ST = E.ST, DX = E.DX, DY = E.DY, idx = E.idx;
  const TAU = Math.PI * 2;

  const PAL = {
    floor: ['#55483a', '#5c4f3f', '#4e4235', '#584a39'], mortar: '#241d15', crack: '#3a3024',
    wallTop: '#7d7058', wallTop2: '#877960', wallFace: '#463d2c', wallEdge: '#b3a37d', wallDark: '#272117', bone: '#c9bc97',
    wax: '#f3e5ba', waxLight: '#fff6d8', waxShade: '#d9c690', waxDark: '#9f8a55', ink: '#3a2a12',
    flameOuter: '#ff8a1e', flameMid: '#ffc247', flameCore: '#fff3c9',
    ember: '#ffb23e', gold: '#ffd35a',
    violet: '#7b86ee', violetDark: '#4a4fa8', teal: '#35bfa9', tealLight: '#8cebd9', tealDark: '#1d7f73',
    bonePale: '#bccbf0', boneShade: '#8492c4', shell: '#5448a8', shellDark: '#352d78',
    eye: '#eef3ff', eyeGlow: '#bcd0ff',
    danger: '#ff3b3b', dangerPale: '#ffd9d9',
    iron: '#4b4958', ironLight: '#7d7a92', ironDark: '#2b2a35', stone: '#6a6377', stoneLight: '#8a839c',
    wood: '#7a5530', woodDark: '#4c331a',
    oil: '#0a1014', sheen: '#2f8d99', sheen2: '#6f55b5',
    ghost: '#262c4d', ghostLine: '#4a5488'
  };
  const DARK = 0.86;          // how dark an unlit tile is drawn: the floor's shape stays faintly visible
  const MASK_SCALE = 0.5;     // the darkness layer is drawn at half size and scaled up: it is all soft edges anyway
  const NODASH = [], DASH = [4, 4];
  const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const STEP = ['#0c0b09', '#1c1914', '#2c271f', '#3d362b'];        // stair treads, deepest first
  // Font strings are built once, so the render loop never has to make one.
  const FONT_B = [], FONT_Z = [];
  for (let n = 0; n <= 160; n++) { FONT_B.push('800 ' + n + 'px system-ui, sans-serif'); FONT_Z.push('italic 700 ' + n + 'px Georgia, serif'); }
  const fontB = px => FONT_B[px < 1 ? 1 : px > 160 ? 160 : Math.round(px)];
  const fontZ = px => FONT_Z[px < 1 ? 1 : px > 160 ? 160 : Math.round(px)];

  let cv = null, ctx = null, dpr = 1, TS = 48, bw = 0, bh = 0;
  let floorCv = null, structCv = null, snapCv = null, maskCv = null, maskCtx = null, glowCv = null, coldCv = null, hatchCv = null;
  let st = null, floorKey = '', lit = null, threat = null, blast = null;
  let clock = 0, lastNow = 0, pauseUntil = 0;
  let reduced = false;

  const darkCur = new Float32Array(N), darkTgt = new Float32Array(N);      // 0 lit .. 1 dark, eased, for things drawn over the darkness
  const emberAt = new Float64Array(N), fireAt = new Float64Array(N), litAtB = new Float64Array(N);
  const oilShape = new Float32Array(N * 8), tileSeed = new Float32Array(N);
  const anims = new Map();      // actor id (0 is me) -> motion
  const marks = new Map();      // enemy id -> { kind, t0 }  ('!' on waking, '?' on stirring)
  const ghosts = [];            // things that are gone from the state but still on screen for a moment
  const sched = [];             // { at, fn }
  const fx = [];                // one-off effects: rings, streaks
  let shakeT0 = -1e9, shakeMag = 0;
  let cupAmt = 0, cupTgt = 0, flameShown = 10;
  let aim = false, inspectI = -1, inspectInfo = null;
  const aimPaths = [null, null, null, null];
  let occupiedSeen = new Uint8Array(N), occupiedOld = new Uint8Array(N);
  let threatOld = null, blastOld = null, warnSwapAt = -1e9;
  let snapT0 = -1e9, unsealAt = -1e9, deathAt = -1, wonAt = -1, flashAt = -1e9, hurtAt = -1e9, waitAt = -1e9;
  let hudX = 0, hudY = -20;

  // ---------------------------------------------------------------------------------------------
  // Particles: one fixed pool, no allocation while playing
  // ---------------------------------------------------------------------------------------------
  const PMAX = FEEL.particles;
  const px = new Float32Array(PMAX), py = new Float32Array(PMAX), pvx = new Float32Array(PMAX), pvy = new Float32Array(PMAX),
        plife = new Float32Array(PMAX), pmax = new Float32Array(PMAX), psize = new Float32Array(PMAX), pkind = new Uint8Array(PMAX),
        ptx = new Float32Array(PMAX), pty = new Float32Array(PMAX), psx = new Float32Array(PMAX), psy = new Float32Array(PMAX);
  const PCOL = ['#ffb23e', '#fff3c9', '#8a8478', '#ffd35a', '#bcd0ff', '#ff6a3a'];
  let pnext = 0;
  function spawn(kind, x, y, vx, vy, life, size, tx, ty) {
    const i = pnext; pnext = (pnext + 1) % PMAX;
    px[i] = x; py[i] = y; pvx[i] = vx; pvy[i] = vy; plife[i] = life; pmax[i] = life; psize[i] = size; pkind[i] = kind;
    ptx[i] = tx || 0; pty[i] = ty || 0; psx[i] = x; psy[i] = y;
  }
  // kinds: 0 spark, 1 pale spark, 2 smoke, 3 gold, 4 cold, 5 hot, 6 ember flying to the meter
  function burst(kind, tx, ty, n, speed, life, size) {
    if (reduced) n = Math.ceil(n / 3);
    const cx = (tx + 0.5) * TS, cy = (ty + 0.5) * TS;
    for (let k = 0; k < n; k++) {
      const a = Math.random() * TAU, sp = speed * (0.35 + Math.random() * 0.65) * TS;
      spawn(kind, cx, cy, Math.cos(a) * sp, Math.sin(a) * sp - (kind === 2 ? 0.25 * TS : 0), life * (0.6 + Math.random() * 0.4), size * TS * (0.7 + Math.random() * 0.6));
    }
  }
  function stepParticles(dt) {
    const s = dt / 1000, dampSmoke = Math.exp(-4.9 * s), dampSpark = Math.exp(-1.8 * s);
    for (let i = 0; i < PMAX; i++) {
      if (plife[i] <= 0) continue;
      plife[i] -= dt;
      const k = pkind[i];
      if (k === 6) {                       // an ember arcing to the flame meter: a curve from where it lay
        const f = clamp01(1 - plife[i] / pmax[i]), e = f * f, a = (1 - e) * (1 - e), b = 2 * (1 - e) * e, c = e * e;
        px[i] = a * psx[i] + b * (psx[i] + pvx[i] * 0.22) + c * ptx[i];
        py[i] = a * psy[i] + b * (psy[i] + pvy[i] * 0.22) + c * pty[i];
        continue;
      }
      px[i] += pvx[i] * s; py[i] += pvy[i] * s;
      if (k === 2) { pvx[i] *= dampSmoke; pvy[i] -= 0.9 * TS * s; psize[i] += 0.55 * TS * s; }
      else { pvy[i] += 2.6 * TS * s; pvx[i] *= dampSpark; }
    }
  }
  function drawParticles() {
    for (let i = 0; i < PMAX; i++) {
      if (plife[i] <= 0) continue;
      const k = pkind[i], f = plife[i] / pmax[i], r = psize[i];
      if (k === 2) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 0.34 * f;
        ctx.fillStyle = PCOL[2];
        ctx.beginPath(); ctx.arc(px[i], py[i], r, 0, TAU); ctx.fill();
      } else {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, f * 1.6);
        ctx.fillStyle = PCOL[k === 6 ? 0 : k];
        const q = k === 6 ? r : r * (0.4 + 0.6 * f);
        ctx.fillRect(px[i] - q, py[i] - q, q * 2, q * 2);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // Floating numbers: a small fixed pool.
  const FMAX = 16;
  const floats = [];
  for (let i = 0; i < FMAX; i++) floats.push({ text: '', x: 0, y: 0, t0: -1e9, color: '#fff', size: 1, dur: 700 });
  let fnext = 0;
  function floatText(text, tx, ty, color, size, at, dur) {
    const f = floats[fnext]; fnext = (fnext + 1) % FMAX;
    f.text = text; f.x = tx; f.y = ty; f.color = color; f.size = size || 1; f.t0 = at; f.dur = dur || 700;
  }

  // ---------------------------------------------------------------------------------------------
  // Small drawing helpers
  // ---------------------------------------------------------------------------------------------
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  const easeOut = t => 1 - (1 - t) * (1 - t) * (1 - t);
  const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) * (2 - 2 * t) / 2);
  function hash(a, b) { let h = Math.imul(a + 374761393, 668265263) ^ Math.imul(b + 2246822519, 3266489917); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function rr(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  function ell(x, y, rx, ry) { ctx.beginPath(); ctx.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), 0, 0, TAU); }
  function circ(x, y, r) { ctx.beginPath(); ctx.arc(x, y, Math.max(0.01, r), 0, TAU); }
  function line(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
  function flamePath(x, y, w, h, sway) {
    ctx.beginPath();
    ctx.moveTo(x + sway, y - h);
    ctx.bezierCurveTo(x + w * 0.85, y - h * 0.5, x + w * 1.15, y - h * 0.04, x, y);
    ctx.bezierCurveTo(x - w * 1.15, y - h * 0.04, x - w * 0.85, y - h * 0.5, x + sway, y - h);
    ctx.closePath();
  }
  // A flame standing on (x, y). gutter 0..1 makes it sputter.
  function drawFlame(x, y, h, t, seed, gutter) {
    let hh = h * (1 + 0.07 * Math.sin(t * 0.021 + seed * 3) + 0.04 * Math.sin(t * 0.047 + seed));
    let sway = Math.sin(t * 0.006 + seed) * h * 0.09 + Math.sin(t * 0.017 + seed * 2) * h * 0.04;
    if (gutter > 0) {
      const g = Math.sin(t * 0.09 + seed) * Math.sin(t * 0.031 + seed * 5);
      hh *= 1 - gutter * (0.25 + 0.3 * Math.max(0, g));
      sway += gutter * Math.sin(t * 0.05 + seed) * h * 0.2;
    }
    const w = hh * 0.36;
    flamePath(x, y, w, hh, sway); ctx.fillStyle = PAL.flameOuter; ctx.fill();
    flamePath(x, y - hh * 0.03, w * 0.64, hh * 0.7, sway * 0.7); ctx.fillStyle = PAL.flameMid; ctx.fill();
    flamePath(x, y - hh * 0.05, w * 0.32, hh * 0.4, sway * 0.4); ctx.fillStyle = PAL.flameCore; ctx.fill();
  }
  // Two eyes do most of the acting. open: 0 shut, 0.5 half, 1 open.
  function eyes(x, y, gap, r, open, t, seed, color) {
    const blink = open > 0.9 && ((t * 0.001 + seed * 7) % 4.3) < 0.12;
    for (let k = -1; k <= 1; k += 2) {
      const ex = x + k * gap;
      if (open <= 0.05 || blink) {
        ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, r * 0.55); ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(ex, y - r * 0.2, r, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ell(ex, y, r, r * open); ctx.fill();
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Sprites. (cx, cy) is the centre of the tile, u the tile size, o the options:
  //   { st, f, seed, ghost, rest }
  // ---------------------------------------------------------------------------------------------
  function drawWick(cx, cy, u, t, frac, flame, cup, o) {
    const sq = o.squash || 0;                      // -1..1: squash and stretch on moves
    const bwid = u * 0.4 * (1 + sq * 0.16), bhgt = u * 0.44 * (1 - sq * 0.16);
    const base = cy + u * 0.42, top = base - bhgt, left = cx - bwid / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ell(cx, base, bwid * 0.62, u * 0.055); ctx.fill();
    rr(left, top, bwid, bhgt, u * 0.07); ctx.fillStyle = o.hurt ? '#ffffff' : PAL.wax; ctx.fill();
    if (!o.hurt) {
      ctx.fillStyle = PAL.waxShade;
      rr(left + bwid * 0.66, top + u * 0.02, bwid * 0.34, bhgt - u * 0.02, u * 0.06); ctx.fill();
      ctx.fillStyle = PAL.waxLight;
      ell(cx, top + u * 0.025, bwid * 0.5, u * 0.045); ctx.fill();
      rr(left - u * 0.012, top + u * 0.02, u * 0.07, bhgt * 0.42, u * 0.035); ctx.fill();      // a drip of wax
      // eyes look the way I last moved
      const lx = o.dir === 1 ? 1 : o.dir === 3 ? -1 : 0, ly = o.dir === 0 ? -1 : o.dir === 2 ? 1 : 0;
      eyes(cx + lx * u * 0.03 - bwid * 0.04, top + bhgt * 0.52 + ly * u * 0.02, bwid * 0.2, u * 0.036, o.dead ? 0 : 1, t, 0.3, PAL.ink);
    }
    ctx.strokeStyle = PAL.ink; ctx.lineWidth = u * 0.03; ctx.lineCap = 'round';
    line(cx, top + u * 0.02, cx, top - u * 0.055);
    const fy = top - u * 0.04;
    if (flame > 0 && !o.dead) {
      const h = u * (0.16 + 0.3 * frac) * (1 - 0.42 * cup);
      drawFlame(cx, fy, h, t, 1.7, flame <= 2 ? 1 : 0);
    }
    if (cup > 0.02) {                               // two hands closing over the flame
      const r = u * (0.2 - 0.03 * cup), hy = fy - u * 0.1, a0 = ctx.globalAlpha;
      ctx.globalAlpha = a0 * clamp01(cup * 1.4);
      ctx.strokeStyle = PAL.waxShade; ctx.lineWidth = u * 0.085; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(cx, hy, r, 0.6 * Math.PI, (1.02 + 0.44 * cup) * Math.PI); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, hy, r, 0.4 * Math.PI, (-0.02 - 0.44 * cup) * Math.PI, true); ctx.stroke();
      ctx.strokeStyle = PAL.wax; ctx.lineWidth = u * 0.04;
      ctx.beginPath(); ctx.arc(cx, hy, r, 0.62 * Math.PI, (1.0 + 0.44 * cup) * Math.PI); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, hy, r, 0.38 * Math.PI, (0.0 - 0.44 * cup) * Math.PI, true); ctx.stroke();
      ctx.globalAlpha = a0;
    }
  }

  function drawGnawer(cx, cy, u, t, o) {
    const f = o.f, awake = o.st === ST.AWAKE;
    const c1 = o.ghost ? PAL.ghost : PAL.violet, c2 = o.ghost ? PAL.ghostLine : PAL.bonePale;
    const bob = awake ? Math.sin(t * 0.012 + o.seed) * u * 0.014 : Math.sin(t * 0.0025 + o.seed) * u * 0.008;
    const by = cy + u * 0.2 + bob;
    ctx.strokeStyle = c1; ctx.lineWidth = u * 0.04; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - f * u * 0.2, by + u * 0.05);
    ctx.quadraticCurveTo(cx - f * u * 0.46, by + u * 0.1, cx - f * u * 0.4, by - u * 0.16 + (awake ? Math.sin(t * 0.01 + o.seed) * u * 0.04 : 0)); ctx.stroke();
    ctx.fillStyle = c1;
    ell(cx - f * u * 0.03, by, u * 0.25, u * 0.155); ctx.fill();
    circ(cx + f * u * 0.2, by - u * 0.07, u * 0.13); ctx.fill();
    ell(cx + f * u * 0.32, by - u * 0.035, u * 0.075, u * 0.055); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx + f * u * 0.1, by - u * 0.15); ctx.lineTo(cx + f * u * 0.13, by - u * 0.29); ctx.lineTo(cx + f * u * 0.22, by - u * 0.18); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = c2; ctx.lineWidth = u * 0.025;                          // bare ribs
    for (let k = 0; k < 3; k++) { const rx = cx - f * u * (0.14 - k * 0.09); ctx.beginPath(); ctx.arc(rx, by + u * 0.02, u * 0.09, 1.15 * Math.PI, 1.85 * Math.PI); ctx.stroke(); }
    if (!o.ghost) {
      const open = awake ? 1 : o.st === ST.STIRRING ? 0.5 : 0;
      ctx.fillStyle = PAL.eye;
      if (open > 0) { ell(cx + f * u * 0.23, by - u * 0.09, u * 0.036, u * 0.036 * open); ctx.fill(); }
      else { ctx.strokeStyle = PAL.eye; ctx.lineWidth = u * 0.022; line(cx + f * u * 0.19, by - u * 0.085, cx + f * u * 0.27, by - u * 0.085); }
    }
  }

  function drawOoze(cx, cy, u, t, o) {
    const awake = o.st === ST.AWAKE, flat = (o.rest || !awake) ? 1 : 0;
    const c1 = o.ghost ? PAL.ghost : PAL.teal, c2 = o.ghost ? PAL.ghostLine : PAL.tealLight;
    const pul = Math.sin(t * (awake ? 0.006 : 0.002) + o.seed) * 0.05;
    const w = u * 0.31 * (1 + pul * 0.7 + flat * 0.1), h = u * 0.44 * (1 - pul - flat * 0.22), base = cy + u * 0.36;
    ctx.fillStyle = c1;
    ctx.beginPath();
    ctx.moveTo(cx - w, base);
    ctx.bezierCurveTo(cx - w * 1.08, base - h * 1.3, cx + w * 1.08, base - h * 1.3, cx + w, base);
    ctx.quadraticCurveTo(cx + w * 0.72, base + u * 0.06, cx + w * 0.42, base);
    ctx.quadraticCurveTo(cx + w * 0.1, base + u * 0.07, cx - w * 0.25, base);
    ctx.quadraticCurveTo(cx - w * 0.62, base + u * 0.06, cx - w, base);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = c2; ctx.lineWidth = u * 0.035; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(cx - w * 0.1, base - h * 0.42, w * 0.62, 1.1 * Math.PI, 1.45 * Math.PI); ctx.stroke();
    if (!o.ghost) {
      const open = awake ? (o.rest ? 0.45 : 1) : o.st === ST.STIRRING ? 0.5 : 0;
      eyes(cx, base - h * 0.5, w * 0.36, u * 0.045, open, t, o.seed, PAL.eye);
      if (open > 0.3) { ctx.fillStyle = '#0c2a26'; circ(cx - w * 0.36, base - h * 0.5, u * 0.018); ctx.fill(); circ(cx + w * 0.36, base - h * 0.5, u * 0.018); ctx.fill(); }
    }
  }

  function drawBeetle(cx, cy, u, t, o) {
    const awake = o.st === ST.AWAKE, f = o.f;
    const c1 = o.ghost ? PAL.ghost : PAL.shell, c2 = o.ghost ? PAL.ghostLine : PAL.shellDark;
    const by = cy + u * 0.15 + (awake ? Math.sin(t * 0.03 + o.seed) * u * 0.008 : 0);
    ctx.strokeStyle = o.ghost ? PAL.ghostLine : PAL.violet; ctx.lineWidth = u * 0.03; ctx.lineCap = 'round';
    for (let k = -1; k <= 1; k++) {
      const lx = cx + k * u * 0.13, wig = awake ? Math.sin(t * 0.03 + k * 2 + o.seed) * u * 0.02 : 0;
      line(lx, by - u * 0.12, lx + k * u * 0.03 + wig, by - u * 0.25);
      line(lx, by + u * 0.12, lx + k * u * 0.03 - wig, by + u * 0.25);
    }
    ctx.fillStyle = c2; ell(cx + f * u * 0.24, by, u * 0.09, u * 0.1); ctx.fill();
    ctx.fillStyle = c1; ell(cx, by, u * 0.25, u * 0.19); ctx.fill();
    ctx.strokeStyle = c2; ctx.lineWidth = u * 0.025; line(cx - u * 0.24, by, cx + u * 0.2, by);
    if (!o.ghost) {
      const glow = 0.55 + 0.45 * Math.sin(t * (awake ? 0.012 : 0.004) + o.seed), a0 = ctx.globalAlpha;       // the tinder it carries
      ctx.globalAlpha = a0 * (0.55 + 0.45 * glow);
      ctx.fillStyle = PAL.ember; circ(cx - f * u * 0.03, by, u * 0.085); ctx.fill();
      ctx.fillStyle = PAL.flameCore; circ(cx - f * u * 0.03, by, u * 0.04); ctx.fill();
      ctx.globalAlpha = a0;
      const open = awake ? 1 : o.st === ST.STIRRING ? 0.5 : 0;
      if (open > 0) { ctx.fillStyle = PAL.eye; ell(cx + f * u * 0.28, by - u * 0.045, u * 0.024, u * 0.024 * open); ctx.fill(); ell(cx + f * u * 0.28, by + u * 0.045, u * 0.024, u * 0.024 * open); ctx.fill(); }
    }
  }

  function drawArcher(cx, cy, u, t, o) {
    const awake = o.st === ST.AWAKE, f = o.f;
    const c1 = o.ghost ? PAL.ghost : PAL.bonePale, c2 = o.ghost ? PAL.ghostLine : PAL.boneShade;
    const sway = awake ? Math.sin(t * 0.004 + o.seed) * u * 0.012 : 0, sag = awake ? 0 : u * 0.05;
    ctx.strokeStyle = c2; ctx.lineWidth = u * 0.04; ctx.lineCap = 'round';
    line(cx, cy - u * 0.04 + sag, cx, cy + u * 0.34);
    for (let k = 0; k < 3; k++) { const ry = cy + u * (0.08 + k * 0.085) + sag * 0.5, rw = u * (0.15 - k * 0.025); ctx.beginPath(); ctx.moveTo(cx - rw, ry + u * 0.02); ctx.quadraticCurveTo(cx, ry - u * 0.035, cx + rw, ry + u * 0.02); ctx.stroke(); }
    // the bow, held on the side it faces
    ctx.strokeStyle = o.ghost ? PAL.ghostLine : PAL.teal; ctx.lineWidth = u * 0.04;
    const bx = cx + f * u * 0.2, byy = cy + u * 0.1 + sag * 0.5, br = u * 0.25;
    ctx.beginPath(); if (f > 0) ctx.arc(bx - u * 0.1, byy, br, -1.05, 1.05); else ctx.arc(bx + u * 0.1, byy, br, Math.PI - 1.05, Math.PI + 1.05); ctx.stroke();
    ctx.lineWidth = u * 0.015;
    const sx = bx - f * u * 0.1 + f * br * Math.cos(1.05), sy = br * Math.sin(1.05);
    line(sx, byy - sy, sx, byy + sy);
    // skull
    const hx = cx + sway, hy = cy - u * 0.33 + sag;
    ctx.fillStyle = c1; rr(hx - u * 0.155, hy, u * 0.31, u * 0.25, u * 0.1); ctx.fill();
    rr(hx - u * 0.09, hy + u * 0.21, u * 0.18, u * 0.08, u * 0.025); ctx.fill();
    if (!o.ghost) {
      ctx.fillStyle = '#141a33';
      ell(hx - u * 0.065, hy + u * 0.125, u * 0.045, u * 0.055); ctx.fill(); ell(hx + u * 0.065, hy + u * 0.125, u * 0.045, u * 0.055); ctx.fill();
      const open = awake ? 1 : o.st === ST.STIRRING ? 0.5 : 0;
      if (open > 0) { ctx.fillStyle = PAL.tealLight; circ(hx - u * 0.065 + f * u * 0.01, hy + u * 0.13, u * 0.02 * (0.5 + open * 0.5)); ctx.fill(); circ(hx + u * 0.065 + f * u * 0.01, hy + u * 0.13, u * 0.02 * (0.5 + open * 0.5)); ctx.fill(); }
      ctx.strokeStyle = '#141a33'; ctx.lineWidth = u * 0.014;
      for (let k = -1; k <= 1; k++) line(hx + k * u * 0.045, hy + u * 0.225, hx + k * u * 0.045, hy + u * 0.275);
    }
  }
  const SPRITE = { gnawer: drawGnawer, ooze: drawOoze, beetle: drawBeetle, archer: drawArcher };

  function drawBrazier(cx, cy, u, t, litAmt, ghost, seed) {
    const iron = ghost ? PAL.ghost : PAL.iron, hi = ghost ? PAL.ghostLine : PAL.ironLight;
    ctx.fillStyle = ghost ? PAL.ghost : PAL.ironDark;
    ctx.beginPath(); ctx.moveTo(cx - u * 0.07, cy + u * 0.1); ctx.lineTo(cx + u * 0.07, cy + u * 0.1); ctx.lineTo(cx + u * 0.17, cy + u * 0.38); ctx.lineTo(cx - u * 0.17, cy + u * 0.38); ctx.closePath(); ctx.fill();
    ctx.fillStyle = iron;
    ctx.beginPath(); ctx.moveTo(cx - u * 0.31, cy - u * 0.04); ctx.lineTo(cx + u * 0.31, cy - u * 0.04); ctx.quadraticCurveTo(cx + u * 0.27, cy + u * 0.19, cx, cy + u * 0.2); ctx.quadraticCurveTo(cx - u * 0.27, cy + u * 0.19, cx - u * 0.31, cy - u * 0.04); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = hi; ctx.lineWidth = u * 0.035; ctx.lineCap = 'round'; line(cx - u * 0.31, cy - u * 0.04, cx + u * 0.31, cy - u * 0.04);
    if (ghost) return;
    if (litAmt > 0.01) {
      ctx.fillStyle = PAL.ember; ell(cx, cy - u * 0.045, u * 0.2 * litAmt, u * 0.035); ctx.fill();
      drawFlame(cx, cy - u * 0.03, u * 0.44 * litAmt, t, seed * 9 + 2, 0);
    } else {
      ctx.fillStyle = '#17161c';
      circ(cx - u * 0.1, cy - u * 0.06, u * 0.05); ctx.fill(); circ(cx + u * 0.02, cy - u * 0.07, u * 0.06); ctx.fill(); circ(cx + u * 0.13, cy - u * 0.055, u * 0.045); ctx.fill();
    }
  }
  function drawAltar(cx, cy, u, t, used, ghost) {
    ctx.fillStyle = ghost ? PAL.ghost : PAL.stone;
    rr(cx - u * 0.22, cy + u * 0.02, u * 0.44, u * 0.36, u * 0.03); ctx.fill();
    ctx.fillStyle = ghost ? PAL.ghostLine : PAL.stoneLight;
    rr(cx - u * 0.3, cy - u * 0.05, u * 0.6, u * 0.1, u * 0.03); ctx.fill();
    if (ghost) return;
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; rr(cx - u * 0.22, cy + u * 0.05, u * 0.44, u * 0.05, 0); ctx.fill();
    if (used) return;
    const by = cy - u * 0.24 + Math.sin(t * 0.003) * u * 0.03, s = u * 0.1;      // an offering, waiting
    ctx.fillStyle = PAL.gold;
    ctx.beginPath(); ctx.moveTo(cx, by - s * 1.25); ctx.lineTo(cx + s, by); ctx.lineTo(cx, by + s * 1.25); ctx.lineTo(cx - s, by); ctx.closePath(); ctx.fill();
    ctx.fillStyle = PAL.flameCore;
    ctx.beginPath(); ctx.moveTo(cx, by - s * 1.25); ctx.lineTo(cx + s * 0.35, by); ctx.lineTo(cx, by + s * 0.3); ctx.lineTo(cx - s, by); ctx.closePath(); ctx.fill();
  }
  function drawStairs(x, y, u, t, openAmt, ghost) {
    // steps going down into the dark
    for (let k = 0; k < 4; k++) {
      ctx.fillStyle = ghost ? (k % 2 ? PAL.ghost : '#1a1f3a') : STEP[k];
      ctx.fillRect(x + u * 0.1, y + u * (0.1 + k * 0.2), u * 0.8, u * 0.2 + 1);
    }
    if (ghost) return;
    const a0 = ctx.globalAlpha;
    if (openAmt < 0.99) {                           // sealed: an iron grate
      ctx.globalAlpha = a0 * (1 - openAmt);
      ctx.strokeStyle = PAL.ironLight; ctx.lineWidth = u * 0.06; ctx.lineCap = 'butt';
      for (let k = 0; k < 4; k++) line(x + u * (0.2 + k * 0.2), y + u * 0.08, x + u * (0.2 + k * 0.2), y + u * 0.92);
      line(x + u * 0.08, y + u * 0.34, x + u * 0.92, y + u * 0.34); line(x + u * 0.08, y + u * 0.68, x + u * 0.92, y + u * 0.68);
      ctx.fillStyle = PAL.iron; circ(x + u * 0.5, y + u * 0.51, u * 0.11); ctx.fill();
      ctx.fillStyle = PAL.ironDark; circ(x + u * 0.5, y + u * 0.51, u * 0.045); ctx.fill();
    }
    if (openAmt > 0.01) {                           // open: a warm rim and a beckoning mark
      const pulse = 0.55 + 0.45 * Math.sin(t * 0.005);
      ctx.globalAlpha = a0 * openAmt * (0.5 + 0.5 * pulse);
      ctx.strokeStyle = PAL.gold; ctx.lineWidth = u * 0.045; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      rr(x + u * 0.07, y + u * 0.07, u * 0.86, u * 0.86, u * 0.08); ctx.stroke();
      for (let k = 0; k < 2; k++) { const yy = y + u * (0.38 + k * 0.2) + pulse * u * 0.03; ctx.beginPath(); ctx.moveTo(x + u * 0.36, yy); ctx.lineTo(x + u * 0.5, yy + u * 0.13); ctx.lineTo(x + u * 0.64, yy); ctx.stroke(); }
    }
    ctx.globalAlpha = a0;
  }
  function drawChest(cx, cy, u, t, ghost) {
    const wood = ghost ? PAL.ghost : PAL.wood, dark = ghost ? '#1a1f3a' : PAL.woodDark, band = ghost ? PAL.ghostLine : PAL.gold;
    ctx.fillStyle = wood; rr(cx - u * 0.27, cy + u * 0.02, u * 0.54, u * 0.3, u * 0.03); ctx.fill();
    ctx.fillStyle = dark;
    ctx.beginPath(); ctx.moveTo(cx - u * 0.29, cy + u * 0.05); ctx.lineTo(cx - u * 0.29, cy - u * 0.04); ctx.quadraticCurveTo(cx, cy - u * 0.22, cx + u * 0.29, cy - u * 0.04); ctx.lineTo(cx + u * 0.29, cy + u * 0.05); ctx.closePath(); ctx.fill();
    ctx.fillStyle = band;
    ctx.fillRect(cx - u * 0.29, cy + u * 0.03, u * 0.58, u * 0.04);
    rr(cx - u * 0.05, cy, u * 0.1, u * 0.12, u * 0.02); ctx.fill();
    ctx.fillRect(cx - u * 0.2, cy - u * 0.12, u * 0.035, u * 0.42); ctx.fillRect(cx + u * 0.165, cy - u * 0.12, u * 0.035, u * 0.42);
  }
  function drawEmbers(cx, cy, u, t, n, seedv, dim) {
    const k = Math.min(n, 3), a0 = ctx.globalAlpha;
    for (let j = 0; j < k; j++) {
      const a = seedv * 6 + j * 2.1, ox = k === 1 ? 0 : Math.cos(a) * u * 0.15, oy = k === 1 ? 0 : Math.sin(a) * u * 0.1;
      const bob = dim ? 0 : Math.sin(t * 0.005 + a) * u * 0.03, x = cx + ox, y = cy + u * 0.08 + oy + bob, s = u * 0.085;
      if (!dim) { ctx.globalAlpha = a0 * 0.3; ctx.fillStyle = PAL.ember; circ(x, y, s * 2.1); ctx.fill(); ctx.globalAlpha = a0; }
      ctx.fillStyle = dim ? PAL.ghostLine : PAL.ember;
      ctx.beginPath(); ctx.moveTo(x, y - s * 1.2); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s * 1.2); ctx.lineTo(x - s, y); ctx.closePath(); ctx.fill();
      if (!dim) { ctx.fillStyle = PAL.flameCore; ctx.beginPath(); ctx.moveTo(x, y - s * 0.55); ctx.lineTo(x + s * 0.45, y); ctx.lineTo(x, y + s * 0.55); ctx.lineTo(x - s * 0.45, y); ctx.closePath(); ctx.fill(); }
    }
    if (n > 3) { ctx.fillStyle = dim ? PAL.ghostLine : PAL.flameCore; ctx.font = fontB(u * 0.24); ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic'; ctx.fillText(DIGITS[Math.min(9, n)], cx + u * 0.44, cy + u * 0.42); }
  }
  function oilPath(i, x, y, u) {
    const cx = x + u * 0.5, cy = y + u * 0.5;
    ctx.beginPath();
    for (let k = 0; k <= 8; k++) {
      const a0 = (k % 8) / 8 * TAU, a1 = ((k + 1) % 8) / 8 * TAU, r0 = oilShape[i * 8 + (k % 8)] * u, r1 = oilShape[i * 8 + ((k + 1) % 8)] * u;
      const mx = cx + (Math.cos(a0) * r0 + Math.cos(a1) * r1) / 2, my = cy + (Math.sin(a0) * r0 * 0.78 + Math.sin(a1) * r1 * 0.78) / 2;
      if (k === 0) ctx.moveTo(mx, my);
      else ctx.quadraticCurveTo(cx + Math.cos(a0) * r0, cy + Math.sin(a0) * r0 * 0.78, mx, my);
    }
    ctx.closePath();
  }
  function drawOil(i, x, y, u, dim) {
    oilPath(i, x, y, u);
    if (dim) { ctx.strokeStyle = PAL.ghostLine; ctx.lineWidth = u * 0.03; ctx.setLineDash(DASH); ctx.stroke(); ctx.setLineDash(NODASH); return; }
    ctx.fillStyle = PAL.oil; ctx.fill();
    ctx.lineCap = 'round'; ctx.lineWidth = u * 0.035;
    ctx.strokeStyle = PAL.sheen; ctx.beginPath(); ctx.arc(x + u * 0.44, y + u * 0.47, u * 0.2, 1.1 * Math.PI, 1.6 * Math.PI); ctx.stroke();
    ctx.strokeStyle = PAL.sheen2; ctx.beginPath(); ctx.arc(x + u * 0.56, y + u * 0.55, u * 0.17, 0.05 * Math.PI, 0.45 * Math.PI); ctx.stroke();
  }
  function drawFire(i, x, y, u, t, amt) {
    ctx.globalAlpha = 0.32 * amt; ctx.fillStyle = PAL.flameOuter; rr(x + u * 0.04, y + u * 0.3, u * 0.92, u * 0.66, u * 0.2); ctx.fill(); ctx.globalAlpha = 1;
    const sd = tileSeed[i] * 10;
    drawFlame(x + u * 0.26, y + u * 0.9, u * 0.5 * amt, t, sd + 1, 0);
    drawFlame(x + u * 0.74, y + u * 0.88, u * 0.44 * amt, t, sd + 4, 0);
    drawFlame(x + u * 0.5, y + u * 0.95, u * 0.66 * amt, t, sd + 7, 0);
  }

  // ---------------------------------------------------------------------------------------------
  // Pre-rendered layers
  // ---------------------------------------------------------------------------------------------
  function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }

  function buildSprites() {
    // a soft warm glow and a cold one, drawn once and stamped wherever a light is
    for (const which of [0, 1]) {
      const c = makeCanvas(256, 256), g = c.getContext('2d');
      const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
      if (which === 0) { grad.addColorStop(0, 'rgba(255,190,96,0.95)'); grad.addColorStop(0.35, 'rgba(255,150,50,0.42)'); grad.addColorStop(1, 'rgba(255,120,20,0)'); }
      else { grad.addColorStop(0, 'rgba(190,208,255,0.9)'); grad.addColorStop(0.4, 'rgba(120,140,255,0.3)'); grad.addColorStop(1, 'rgba(90,110,255,0)'); }
      g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
      if (which === 0) glowCv = c; else coldCv = c;
    }
    // the hatch that marks a threatened tile (danger is never shown by red alone)
    const hs = Math.round(TS * dpr);
    hatchCv = makeCanvas(hs, hs);
    const h = hatchCv.getContext('2d');
    h.strokeStyle = 'rgba(255,70,70,0.6)'; h.lineWidth = Math.max(1, hs * 0.045);
    for (let k = -hs; k < hs * 2; k += hs * 0.24) { h.beginPath(); h.moveTo(k, hs); h.lineTo(k + hs, 0); h.stroke(); }
    maskCv = makeCanvas(bw * MASK_SCALE, bh * MASK_SCALE); maskCtx = maskCv.getContext('2d');
    snapCv = makeCanvas(bw * dpr, bh * dpr);
  }

  // The floor is drawn once per floor: flagstones, walls, the bones in them.
  function buildFloor() {
    floorCv = makeCanvas(bw * dpr, bh * dpr);
    structCv = makeCanvas(bw * dpr, bh * dpr);
    const g = floorCv.getContext('2d'), s2 = structCv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); s2.setTransform(dpr, 0, 0, dpr, 0, 0);
    const u = TS, sd = (st.seed ^ (st.floor * 7919)) >>> 0;
    const isWall = (x, y) => E.inb(x, y) && st.tiles[idx(x, y)] === T.WALL;
    for (let i = 0; i < N; i++) {
      const x = i % W, y = (i / W) | 0, X = x * u, Y = y * u;
      tileSeed[i] = hash(sd + i, 11);
      for (let k = 0; k < 8; k++) oilShape[i * 8 + k] = 0.3 + hash(sd + i * 8 + k, 5) * 0.16;
      if (st.tiles[i] !== T.WALL) {
        g.fillStyle = PAL.floor[(hash(sd + i, 1) * 4) | 0];
        g.fillRect(X, Y, u, u);
        // two or three flagstones per tile
        g.strokeStyle = PAL.mortar; g.lineWidth = Math.max(1, u * 0.03);
        const r = hash(sd + i, 2);
        g.beginPath();
        if (r < 0.34) { g.moveTo(X + u * (0.35 + r), Y); g.lineTo(X + u * (0.35 + r), Y + u); }
        else if (r < 0.68) { g.moveTo(X, Y + u * (0.1 + r * 0.6)); g.lineTo(X + u, Y + u * (0.1 + r * 0.6)); }
        else { g.moveTo(X + u * 0.5, Y); g.lineTo(X + u * 0.5, Y + u * 0.55); g.moveTo(X, Y + u * 0.55); g.lineTo(X + u, Y + u * 0.55); }
        g.stroke();
        g.strokeRect(X + 0.5, Y + 0.5, u - 1, u - 1);
        if (hash(sd + i, 3) < 0.3) {                 // a crack
          g.strokeStyle = PAL.crack; g.lineWidth = Math.max(1, u * 0.02);
          const cx0 = X + u * (0.2 + hash(sd + i, 4) * 0.5), cy0 = Y + u * (0.2 + hash(sd + i, 6) * 0.5);
          g.beginPath(); g.moveTo(cx0, cy0); g.lineTo(cx0 + u * 0.12, cy0 + u * 0.1); g.lineTo(cx0 + u * 0.1, cy0 + u * 0.24); g.stroke();
        }
      } else {
        const below = isWall(x, y + 1), face = below ? 0 : u * 0.26;
        g.fillStyle = hash(sd + i, 7) < 0.5 ? PAL.wallTop : PAL.wallTop2;
        g.fillRect(X, Y, u, u - face);
        if (face) { g.fillStyle = PAL.wallFace; g.fillRect(X, Y + u - face, u, face); g.fillStyle = PAL.wallDark; g.fillRect(X, Y + u - Math.max(1, u * 0.04), u, Math.max(1, u * 0.04)); }
        g.strokeStyle = PAL.wallEdge; g.lineWidth = Math.max(1, u * 0.035);
        g.beginPath();
        if (!isWall(x, y - 1)) { g.moveTo(X, Y + 1); g.lineTo(X + u, Y + 1); }
        if (!isWall(x - 1, y)) { g.moveTo(X + 1, Y); g.lineTo(X + 1, Y + u - face); }
        g.stroke();
        g.strokeStyle = PAL.wallDark; g.lineWidth = Math.max(1, u * 0.03);
        g.beginPath();
        if (!isWall(x + 1, y)) { g.moveTo(X + u - 1, Y); g.lineTo(X + u - 1, Y + u); }
        g.moveTo(X, Y + (u - face) * 0.5); g.lineTo(X + u, Y + (u - face) * 0.5);
        const off = hash(sd + i, 8) * 0.4 + 0.3;
        g.moveTo(X + u * off, Y); g.lineTo(X + u * off, Y + (u - face) * 0.5);
        g.moveTo(X + u * (1 - off), Y + (u - face) * 0.5); g.lineTo(X + u * (1 - off), Y + u - face);
        g.stroke();
        if (hash(sd + i, 9) < 0.34) {                // a skull mortared into the wall
          const kx = X + u * 0.5, ky = Y + (u - face) * 0.48, r = u * 0.13;
          g.fillStyle = PAL.bone; g.beginPath(); g.arc(kx, ky, r, 0, TAU); g.fill(); g.fillRect(kx - r * 0.55, ky + r * 0.5, r * 1.1, r * 0.7);
          g.fillStyle = PAL.wallDark; g.beginPath(); g.arc(kx - r * 0.42, ky, r * 0.27, 0, TAU); g.arc(kx + r * 0.42, ky, r * 0.27, 0, TAU); g.fill();
        }
        // the same wall as a cold outline, shown over the darkness so the floor's shape is always readable
        s2.fillStyle = '#0c0e1b'; s2.fillRect(X, Y, u, u - face);
        if (face) { s2.fillStyle = '#060711'; s2.fillRect(X, Y + u - face, u, face); }
        s2.strokeStyle = '#2a3157'; s2.lineWidth = Math.max(1, u * 0.035);
        s2.beginPath();
        if (!isWall(x, y - 1)) { s2.moveTo(X, Y + 1); s2.lineTo(X + u, Y + 1); }
        if (!isWall(x - 1, y)) { s2.moveTo(X + 1, Y); s2.lineTo(X + 1, Y + u - face); }
        if (!isWall(x + 1, y)) { s2.moveTo(X + u - 1, Y); s2.lineTo(X + u - 1, Y + u - face); }
        s2.stroke();
      }
    }
    floorKey = st.seed + ':' + st.floor;
  }

  // ---------------------------------------------------------------------------------------------
  // Light
  // ---------------------------------------------------------------------------------------------
  // The darkness is one layer with a soft-edged hole cut for every light. A hole is clear out to the
  // light's reach (radius + 0.5 tiles, the same number the rules use), so a tile whose centre is lit
  // always looks lit, and fades to dark over the next half tile.
  const holes = {};
  function holeFor(reach) {
    const key = Math.round(reach * 2);
    if (holes[key]) return holes[key];
    const c = makeCanvas(256, 256), g = c.getContext('2d'), full = reach + 0.5;
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(Math.min(0.98, 0.5 * reach / full), 'rgba(0,0,0,1)');
    grad.addColorStop(Math.min(0.985, reach / full), 'rgba(0,0,0,0.74)');
    grad.addColorStop(Math.min(0.99, (reach + 0.2) / full), 'rgba(0,0,0,0.34)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
    holes[key] = c;
    return c;
  }
  let myReach = 0, myReachTgt = 0, myHole = null;
  const brReach = new Float32Array(N);
  // Called whenever the state changes: where the light is going, and which tiles are (un)lit.
  function lightTargets() {
    const dead = st.mode === 'dead';
    myReachTgt = dead ? 0 : E.lightRadius(st) + CFG.light.reach;
    if (!dead) myHole = holeFor(myReachTgt);
    for (let i = 0; i < N; i++) darkTgt[i] = lit[i] ? 0 : 1;
  }
  function snapLight() {
    myReach = myReachTgt;
    for (let i = 0; i < N; i++) { darkCur[i] = darkTgt[i]; brReach[i] = 0; }
    for (const b of st.braziers) if (b.lit) brReach[idx(b.x, b.y)] = E.brazierRadius(st) + CFG.light.reach;
  }
  function stepLight(dt) {
    const k = reduced ? 1 : 1 - Math.exp(-dt / FEEL.lightEaseMs), slow = reduced ? 1 : 1 - Math.exp(-dt / (FEEL.lightEaseMs * 2.4));
    myReach += (myReachTgt - myReach) * (st.mode === 'dead' ? slow : k);
    for (let i = 0; i < N; i++) darkCur[i] += (darkTgt[i] - darkCur[i]) * k;
    const full = E.brazierRadius(st) + CFG.light.reach;
    for (const b of st.braziers) {
      const i = idx(b.x, b.y);
      brReach[i] = b.lit ? full * (reduced ? 1 : easeOut(clamp01((clock - litAtB[i]) / FEEL.bloomMs))) : 0;
    }
  }
  function cutHole(sprite, cx, cy, reach, k) {
    if (reach < 0.04) return;
    const r = (reach + 0.5) * TS * k;
    maskCtx.drawImage(sprite, cx * k - r, cy * k - r, r * 2, r * 2);
  }
  function drawDarkness(t, mx, my) {
    const mw = maskCv.width, mh = maskCv.height, k = mw / bw;
    const flick = reduced ? 1 : 1 + (Math.sin(t * 0.011) * 0.5 + Math.sin(t * 0.027 + 1.3) * 0.3 + Math.sin(t * 0.053 + 2.1) * 0.2) * 0.022;
    maskCtx.globalCompositeOperation = 'source-over';
    maskCtx.clearRect(0, 0, mw, mh);
    maskCtx.globalAlpha = DARK; maskCtx.fillStyle = '#000'; maskCtx.fillRect(0, 0, mw, mh);
    maskCtx.globalAlpha = 1; maskCtx.globalCompositeOperation = 'destination-out';
    const bh0 = holeFor(E.brazierRadius(st) + CFG.light.reach);
    for (const b of st.braziers) { const r = brReach[idx(b.x, b.y)]; if (r > 0) cutHole(bh0, (b.x + 0.5) * TS, (b.y + 0.5) * TS, r * (2 - flick), k); }
    if (myHole) cutHole(myHole, mx, my, myReach * flick, k);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(maskCv, 0, 0, bw, bh);
  }

  // ---------------------------------------------------------------------------------------------
  // Motion
  // ---------------------------------------------------------------------------------------------
  let offX = 0, offY = 0, offSquash = 0;
  function actorOffset(id) {
    offX = 0; offY = 0; offSquash = 0;
    const a = anims.get(id);
    if (!a) return;
    const f = clamp01((clock - a.t0) / a.dur);
    if (a.kind === 0) {                 // slide in from where it was
      const e = 1 - easeOut(f);
      offX = a.dx * e; offY = a.dy * e;
      offSquash = Math.sin(f * Math.PI) * -0.5;
    } else {                            // lunge and return
      const e = Math.sin(f * Math.PI);
      offX = a.dx * e; offY = a.dy * e;
      offSquash = e * 0.35;
    }
    if (f >= 1) anims.delete(id);
  }
  function slide(id, fx0, fy0, tx, ty, t0, dur) { anims.set(id, { kind: 0, dx: fx0 - tx, dy: fy0 - ty, t0: t0, dur: reduced ? 1 : dur }); }
  function lunge(id, dx, dy, amp, t0, dur) { if (!reduced) anims.set(id, { kind: 1, dx: dx * amp, dy: dy * amp, t0: t0, dur: dur }); }
  function later(at, fn) { sched.push({ at: at, fn: fn }); }
  function shake(mag, at) { if (reduced) return; later(at, () => { shakeT0 = clock; shakeMag = mag; }); }
  function ring(tx, ty, at, color, size, dur) { fx.push({ kind: 'ring', x: tx, y: ty, t0: at, dur: dur || 260, color: color, size: size }); }

  // ---------------------------------------------------------------------------------------------
  // Playing a turn's events
  // ---------------------------------------------------------------------------------------------
  function derive() {
    threatOld = threat; blastOld = blast;
    const swap = occupiedOld; occupiedOld = occupiedSeen; occupiedSeen = swap;
    lit = st.lit;
    threat = E.threatMap(st);
    blast = E.blastMap(st);
    for (let d = 0; d < 4; d++) aimPaths[d] = E.flarePath(st, d, true);
    occupiedSeen.fill(0);
    for (const e of st.enemies) if (lit[idx(e.x, e.y)]) occupiedSeen[idx(e.x, e.y)] = 1;
  }

  // Snap to a state with no animation (a new run, a loaded save, a resize).
  function setState(s) {
    st = s;
    derive();
    anims.clear(); marks.clear(); ghosts.length = 0; sched.length = 0; fx.length = 0;
    threatOld = null; blastOld = null; warnSwapAt = -1e9;
    for (let i = 0; i < PMAX; i++) plife[i] = 0;
    for (let i = 0; i < FMAX; i++) floats[i].t0 = -1e9;
    for (let i = 0; i < N; i++) { emberAt[i] = -1e9; fireAt[i] = -1e9; litAtB[i] = -1e9; }
    unsealAt = -1e9; deathAt = s.mode === 'dead' ? clock - 5000 : -1; wonAt = -1; snapT0 = -1e9; hurtAt = -1e9; flashAt = -1e9;
    cupTgt = cupAmt = s.p.cupped ? 1 : 0;
    flameShown = s.p.flame;
    if (bw && floorKey !== s.seed + ':' + s.floor) buildFloor();
    lightTargets();
    snapLight();
  }

  // Animate from the state on screen to state s. Returns how long input should wait, in ms.
  function play(s, events) {
    const prev = st, t0 = clock;
    const stepP = FEEL.playerMs, stepE = FEEL.enemyMs;
    let pAct = false, eAct = false, world = false, floorChange = false;
    for (const e of events) {
      if (e.ph === 0 && (e.e === 'move' || e.e === 'strike' || e.e === 'flare' || e.e === 'dazzle' || e.e === 'bump')) pAct = true;
      if (e.ph === 1 && (e.e === 'emove' || e.e === 'attack')) eAct = true;
      if (e.ph === 2) world = true;
      if (e.e === 'floor') floorChange = true;
    }
    const t1 = t0 + (pAct ? stepP * 0.8 : 0), t2 = t1 + (eAct ? stepE * 0.8 : 0);
    let end = t2 + (eAct ? stepE * 0.3 : 0) + (world ? FEEL.worldMs : 0);

    if (floorChange && cv) {             // keep the old floor on screen to fade out of
      const g = snapCv.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, snapCv.width, snapCv.height); g.drawImage(cv, 0, 0);
      snapT0 = t0;
    }
    st = s;
    derive();
    if (floorChange) {
      anims.clear(); marks.clear(); ghosts.length = 0; fx.length = 0;
      for (let i = 0; i < N; i++) { emberAt[i] = -1e9; fireAt[i] = -1e9; litAtB[i] = -1e9; }
      unsealAt = -1e9;
      buildFloor();
    }

    let impact = t0;
    for (const e of events) {
      const tp = e.ph === 0 ? t0 : e.ph === 1 ? t1 : t2;
      switch (e.e) {
        case 'move':
          if (!floorChange) slide(0, e.fx, e.fy, e.tx, e.ty, t0, stepP);
          break;
        case 'bump': lunge(0, DX[e.d], DY[e.d], e.what === 'wall' || e.what === 'edge' ? 0.1 : 0.22, t0, 110); break;
        case 'wait': waitAt = t0; break;
        case 'strike':
          lunge(0, DX[e.d], DY[e.d], 0.36, t0, 120);
          impact = t0 + 42;
          later(impact, () => { pauseUntil = lastNow + (reduced ? 0 : FEEL.hitPauseMs); burst(e.sneak ? 3 : 1, e.x, e.y, e.sneak ? 14 : 8, 3.2, 300, 0.04); });
          if (e.sneak) floatText('sneak', e.x, e.y - 0.5, PAL.gold, 0.8, impact, 650);
          break;
        case 'hit':
          { const at = e.by === 'fire' ? tp : impact, id = e.id;
            later(at, () => { marks.set(id, { kind: 'hit', t0: clock }); });
            if (e.by !== 'strike') later(at, () => burst(5, e.x, e.y, 6, 2.4, 260, 0.035));
            floatText('-' + e.dmg, e.x, e.y - 0.2, PAL.eye, 0.9, at, 600);
            end = Math.max(end, at + 60); }
          break;
        case 'die':
          { const at = e.by === 'fire' ? tp : impact;
            const old = prev && prev.enemies.find(o => o.id === e.id);
            ghosts.push({ kind: 'enemy', t: e.t, x: e.x, y: e.y, f: old ? old.f : 1, st: old ? old.st : ST.AWAKE, id: e.id, until: at, fade: 150 });
            later(at, () => burst(2, e.x, e.y, 7, 0.9, 520, 0.09));
            end = Math.max(end, at + 90); }
          break;
        case 'drop': emberAt[idx(e.x, e.y)] = Math.max(impact, tp) + 60; break;
        case 'explode':
          impact += 45;
          { const at = impact; later(at, () => { burst(5, e.x, e.y, 22, 5.5, 380, 0.05); burst(2, e.x, e.y, 6, 1.2, 600, 0.12); });
            ring(e.x, e.y, at, PAL.flameMid, 1.6, 300); shake(0.16, at); end = Math.max(end, at + 120); }
          break;
        case 'ignite':
          fireAt[idx(e.x, e.y)] = Math.max(impact, tp);
          later(Math.max(impact, tp), () => burst(0, e.x, e.y, 8, 2.2, 340, 0.035));
          break;
        case 'burnout': later(tp, () => burst(2, e.x, e.y, 4, 0.6, 600, 0.1)); break;
        case 'flare':
          { const last = e.tiles[e.tiles.length - 1], lx = last % W, ly = (last / W) | 0, dur = 34 * e.tiles.length;
            fx.push({ kind: 'streak', x: prev ? prev.p.x : s.p.x, y: prev ? prev.p.y : s.p.y, x2: lx, y2: ly, t0: t0, dur: dur, color: PAL.flameMid });
            impact = t0 + dur;
            later(impact, () => burst(0, lx, ly, 12, 3.4, 320, 0.04));
            lunge(0, DX[e.d], DY[e.d], -0.1, t0, 120);
            end = Math.max(end, impact + 70); }
          break;
        case 'dazzle':
          ring(s.p.x, s.p.y, t0, PAL.flameCore, E.openRadius(s) + 0.8, 320); flashAt = t0;
          later(t0, () => burst(1, s.p.x, s.p.y, 18, 6, 300, 0.035));
          break;
        case 'emove': slide(e.id, e.fx, e.fy, e.tx, e.ty, t1, stepE); break;
        case 'attack':
          { const dx = Math.sign(e.tx - e.x), dy = Math.sign(e.ty - e.y), at = t1 + stepE * 0.5;
            if (e.how === 'arrow') fx.push({ kind: 'streak', x: e.x, y: e.y, x2: e.tx, y2: e.ty, t0: t1, dur: stepE * 0.5, color: PAL.tealLight });
            else lunge(e.id, dx, dy, 0.34, t1, stepE * 1.3);
            impact = at; }
          break;
        case 'hurt':
          { const at = e.by === 'fire' ? tp : impact;
            later(at, () => { hurtAt = clock; burst(5, s.p.x, s.p.y, 9, 3.2, 300, 0.04); });
            shake(0.1 + 0.05 * e.dmg, at);
            floatText('-' + e.dmg, s.p.x, s.p.y - 0.55, PAL.danger, 1.25, at, 800);
            end = Math.max(end, at + 80); }
          break;
        case 'burn':
          floatText('-1', s.p.x + 0.34, s.p.y - 0.5, '#c9a15a', 0.8, tp, 800);
          later(tp, () => burst(2, s.p.x, s.p.y - 0.35, 3, 0.4, 700, 0.07));
          break;
        case 'pickup':
          { const at = e.ph === 0 ? t0 + stepP * 0.6 : tp;
            later(at, () => { for (let k = 0; k < 5; k++) spawn(6, (e.x + 0.5) * TS, (e.y + 0.5) * TS, (Math.random() - 0.5) * 5 * TS, -(2 + Math.random() * 3) * TS, 420 + k * 40, TS * 0.045, hudX, hudY); });
            if (e.v > 0) floatText('+' + e.v, s.p.x - 0.3, s.p.y - 0.55, PAL.ember, 0.95, at + 60, 700); }
          break;
        case 'gain': floatText('+' + e.n, s.p.x - 0.3, s.p.y - 0.55, PAL.ember, 0.95, tp + 80, 700); break;
        case 'chest':
          ghosts.push({ kind: 'chest', x: e.x, y: e.y, until: t0 + 50, fade: 140 });
          later(t0 + 50, () => burst(3, e.x, e.y, 16, 3.4, 420, 0.045));
          if (e.gain > 0) floatText('+' + e.gain, s.p.x - 0.3, s.p.y - 0.55, PAL.ember, 1.1, t0 + 90, 800);
          if (e.spill > 0) emberAt[idx(e.x, e.y)] = t0 + 110;
          break;
        case 'brazier':
          { const at = Math.max(impact, t0 + 40);
            litAtB[idx(e.x, e.y)] = at;
            later(at, () => burst(0, e.x, e.y - 0.2, 14, 2.6, 520, 0.04));
            ring(e.x, e.y, at, PAL.flameMid, 2.6, FEEL.bloomMs); }
          break;
        case 'unseal': unsealAt = Math.max(impact, tp) + 120; break;
        case 'cup': cupTgt = e.on ? 1 : 0; break;
        case 'stir': { const id = e.id; later(t2, () => marks.set(id, { kind: 'stir', t0: clock })); } break;
        case 'wake': { const id = e.id, at = e.why === 'hit' ? impact : t2; later(at, () => marks.set(id, { kind: 'wake', t0: clock })); } break;
        case 'relic': later(t0, () => burst(3, e.x, e.y - 0.2, 16, 2.6, 520, 0.04)); break;
        case 'lastgasp': ring(s.p.x, s.p.y, impact, PAL.flameCore, 1.6, 360); break;
        case 'snuffed':
          deathAt = Math.max(impact, tp) + 60;
          later(deathAt, () => burst(2, s.p.x, s.p.y - 0.3, 12, 0.7, 1100, 0.11));
          end = Math.max(end, deathAt + FEEL.deathMs);
          break;
        case 'won': wonAt = t0; end = t0 + 700; break;
        default: break;
      }
    }
    lightTargets();
    if (floorChange) { snapLight(); end = Math.max(end, t0 + 240); }
    // the red tiles I acted on stay up until the enemies have visibly moved; then the new ones appear
    warnSwapAt = floorChange || !threatOld || !(pAct || eAct) ? t0 : Math.min(end, t2 + stepE * 0.6);
    return Math.max(0, end - t0);
  }

  // ---------------------------------------------------------------------------------------------
  // The frame
  // ---------------------------------------------------------------------------------------------
  const OPT = { st: 0, f: 1, seed: 0, ghost: false, rest: false };
  const WOPT = { squash: 0, hurt: false, dead: false, dir: 0 };
  const GH = { id: 0, t: 'gnawer', x: 0, y: 0, st: 2, f: 1, hp: 0, cd: 0, stun: 0 };

  function drawEnemy(e, x, y, t, ghost, alpha) {
    const u = TS, cx = (x + 0.5) * u, cy = (y + 0.5) * u;
    const m = marks.get(e.id);
    const o = OPT; o.st = e.st; o.f = e.f || 1; o.seed = (e.id % 17) * 0.37; o.ghost = ghost; o.rest = e.cd > 0;
    const a = alpha;
    ctx.globalAlpha = a;
    if (!ghost) { ctx.fillStyle = 'rgba(0,0,0,0.3)'; ell(cx, cy + u * 0.38, u * 0.26, u * 0.05); ctx.fill(); }
    SPRITE[e.t](cx, cy, u, t, o);
    if (!ghost && m && m.kind === 'hit' && clock - m.t0 < 90) {          // a white flash when struck
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.7 * (1 - (clock - m.t0) / 90);
      ctx.fillStyle = '#fff'; circ(cx, cy + u * 0.08, u * 0.34); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = a;
    // health pips for anything that takes more than one hit
    const maxHp = ENEMIES[e.t].hp;
    if (!ghost && maxHp > 1) {
      const pw = u * 0.085, gap = u * 0.03, tot = maxHp * pw + (maxHp - 1) * gap;
      for (let k = 0; k < maxHp; k++) {
        ctx.fillStyle = k < e.hp ? PAL.eye : 'rgba(238,243,255,0.22)';
        ctx.fillRect(cx - tot / 2 + k * (pw + gap), cy + u * 0.43, pw, u * 0.05);
      }
    }
    // state marks: z asleep, ? stirring, ! on waking, dots when dazed
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (e.st === ST.ASLEEP) {
      const ph = (t * 0.0006 + o.seed) % 1;
      ctx.globalAlpha = a * (ghost ? 0.8 : 1) * (1 - ph);
      ctx.fillStyle = ghost ? PAL.ghostLine : PAL.eyeGlow;
      ctx.font = fontZ(u * (0.2 + ph * 0.08));
      ctx.fillText('z', cx + u * (0.24 + ph * 0.1), cy - u * (0.2 + ph * 0.2));
    } else if (e.st === ST.STIRRING) {
      const pop = m && m.kind === 'stir' ? 1 + 0.6 * Math.max(0, 1 - (clock - m.t0) / 220) : 1;
      ctx.globalAlpha = a * (0.75 + 0.25 * Math.sin(t * 0.012));
      ctx.fillStyle = ghost ? PAL.ghostLine : PAL.gold;
      ctx.font = fontB(u * 0.34 * pop);
      ctx.fillText('?', cx + u * 0.3, cy - u * 0.3);
    } else if (m && m.kind === 'wake' && clock - m.t0 < 600) {
      const f = (clock - m.t0) / 600;
      ctx.globalAlpha = a * (1 - f * f);
      ctx.fillStyle = PAL.dangerPale;
      ctx.font = fontB(u * (0.4 + 0.2 * Math.max(0, 1 - f * 4)));
      ctx.fillText('!', cx + u * 0.3, cy - u * 0.32);
    }
    if (!ghost && e.st === ST.AWAKE && e.stun > 0) {
      ctx.globalAlpha = a; ctx.fillStyle = PAL.gold;
      for (let k = 0; k < 3; k++) { const an = t * 0.006 + k * TAU / 3; circ(cx + Math.cos(an) * u * 0.2, cy - u * 0.34 + Math.sin(an) * u * 0.06, u * 0.03); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
  }

  function drawEyesInDark(x, y, t, seed) {
    const u = TS, cx = (x + 0.5) * u, cy = (y + 0.5) * u + Math.sin(t * 0.004 + seed) * u * 0.02;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5; ctx.drawImage(coldCv, cx - u * 0.36, cy - u * 0.36, u * 0.72, u * 0.72);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    eyes(cx, cy, u * 0.11, u * 0.05, 1, t, seed, PAL.eye);
  }

  function threatTile(x, y, n) {
    const u = TS, X = x * u, Y = y * u;
    ctx.globalAlpha = 0.2; ctx.fillStyle = PAL.danger; ctx.fillRect(X, Y, u, u);
    ctx.globalAlpha = 0.9; ctx.drawImage(hatchCv, X, Y, u, u);
    ctx.strokeStyle = 'rgba(255,90,90,0.85)'; ctx.lineWidth = Math.max(1.5, u * 0.035);
    ctx.strokeRect(X + u * 0.03, Y + u * 0.03, u * 0.94, u * 0.94);
    ctx.globalAlpha = 1;
    ctx.font = fontB(u * 0.3); ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.lineWidth = Math.max(2, u * 0.07); ctx.strokeStyle = 'rgba(40,0,0,0.9)'; ctx.lineJoin = 'round';
    const s = DIGITS[Math.min(9, n)];
    ctx.strokeText(s, X + u * 0.09, Y + u * 0.06); ctx.fillStyle = PAL.dangerPale; ctx.fillText(s, X + u * 0.09, Y + u * 0.06);
  }

  function outlineTile(i, u, color, dash) {
    const x = i % W, y = (i / W) | 0;
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, u * 0.05); ctx.setLineDash(dash ? DASH : NODASH);
    rr(x * u + u * 0.05, y * u + u * 0.05, u * 0.9, u * 0.9, u * 0.1); ctx.stroke(); ctx.setLineDash(NODASH);
  }
  function drawInspect(u) {
    const info = inspectInfo;
    if (info.threat) for (let k = 0; k < info.threat.length; k++) outlineTile(info.threat[k], u, 'rgba(255,90,90,0.9)', true);
    if (info.blast) for (let k = 0; k < info.blast.length; k++) outlineTile(info.blast[k], u, 'rgba(255,178,62,0.9)', true);
    outlineTile(inspectI, u, '#ffffff', false);
  }
  // Where a Flare would go in each direction, from what I can see.
  function drawAim(u, t) {
    const p = st.p;
    for (let d = 0; d < 4; d++) {
      const path = aimPaths[d];
      for (let k = 0; k < path.tiles.length; k++) {
        const i = path.tiles[k], x = i % W, y = (i / W) | 0, last = k === path.tiles.length - 1;
        const ph = ((t * 0.004) - k * 0.25) % 1;
        ctx.globalAlpha = 0.45 + 0.4 * (ph < 0 ? ph + 1 : ph);
        ctx.fillStyle = PAL.flameMid;
        const cx = (x + 0.5) * u, cy = (y + 0.5) * u, s = u * 0.11;
        ctx.beginPath();                         // a small arrowhead pointing along the path
        ctx.moveTo(cx + DX[d] * s * 1.3, cy + DY[d] * s * 1.3);
        ctx.lineTo(cx - DX[d] * s + DY[d] * s, cy - DY[d] * s + DX[d] * s);
        ctx.lineTo(cx - DX[d] * s - DY[d] * s, cy - DY[d] * s - DX[d] * s);
        ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 1;
        if (last && path.end !== 'fizzle') outlineTile(i, u, PAL.gold, false);
      }
    }
    outlineTile(idx(p.x, p.y), u, 'rgba(255,211,90,0.6)', true);
  }

  function frame(now) {
    if (!cv || !st) return;
    let dt = now - lastNow; lastNow = now;
    if (dt < 0 || dt > 100) dt = 16;
    if (now < pauseUntil) dt = 0;                    // hit pause: the whole board holds its breath
    clock += dt;
    const t = clock, u = TS, p = st.p;

    // run anything whose time has come
    for (let i = 0; i < sched.length;) { if (sched[i].at <= clock) { const f = sched[i].fn; sched.splice(i, 1); f(); } else i++; }
    stepLight(dt); stepParticles(dt);
    cupAmt += (cupTgt - cupAmt) * (reduced ? 1 : 1 - Math.exp(-dt / 55));
    flameShown += (p.flame - flameShown) * (1 - Math.exp(-dt / 90));
    const isDead = deathAt >= 0 && clock >= deathAt;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, bw, bh);
    ctx.save();
    const sh = clock - shakeT0;
    if (sh < FEEL.shakeMs) { const m = shakeMag * u * (1 - sh / FEEL.shakeMs); ctx.translate(Math.sin(sh * 0.11) * m, Math.cos(sh * 0.13) * m); }

    ctx.drawImage(floorCv, 0, 0, bw, bh);

    // ---- on the floor, under the light: scorch, oil, chests, stairs, altars, braziers, enemies ----
    for (let i = 0; i < N; i++) {
      const x = i % W, y = (i / W) | 0, X = x * u, Y = y * u, tt = st.tiles[i];
      if (st.scorch[i]) { ctx.globalAlpha = 0.5; ctx.fillStyle = '#000'; ell(X + u * 0.5, Y + u * 0.55, u * 0.4, u * 0.3); ctx.fill(); ctx.globalAlpha = 1; }
      if (lit[i] && (st.oil[i] || (st.fire[i] > 0 && clock < fireAt[i]))) drawOil(i, X, Y, u, false);
      if (tt === T.STAIRS) drawStairs(X, Y, u, t, st.stairs.open ? clamp01((clock - unsealAt) / 400) : 0, false);
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = idx(x, y), tt = st.tiles[i], cx = (x + 0.5) * u, cy = (y + 0.5) * u;
        if (tt === T.BRAZIER) { const b = E.brazierAt(st, x, y); drawBrazier(cx, cy, u, t, b.lit ? easeOut(clamp01((clock - litAtB[i]) / 300)) : 0, false, tileSeed[i]); }
        else if (tt === T.ALTAR) drawAltar(cx, cy, u, t, E.altarAt(st, x, y).used, false);
        else if (tt === T.CHEST && lit[i]) drawChest(cx, cy, u, t, false);
      }
      for (const e of st.enemies) {
        if (e.y !== y || !lit[idx(e.x, e.y)]) continue;
        actorOffset(e.id);
        drawEnemy(e, e.x + offX, e.y + offY, t, false, 1);
      }
    }
    for (let g = 0; g < ghosts.length;) {             // the just-killed, the just-opened
      const gh = ghosts[g], left = gh.until + gh.fade - clock;
      if (left <= 0) { ghosts.splice(g, 1); continue; }
      const a = clock < gh.until ? 1 : left / gh.fade;
      if (gh.kind === 'chest') { ctx.globalAlpha = a; drawChest((gh.x + 0.5) * u, (gh.y + 0.5) * u, u, t, false); ctx.globalAlpha = 1; }
      else { GH.id = gh.id; GH.t = gh.t; GH.st = gh.st; GH.f = gh.f; GH.hp = 0; GH.cd = 0; GH.stun = 0; actorOffset(gh.id); drawEnemy(GH, gh.x + offX, gh.y + offY, t, false, a); }
      g++;
    }

    actorOffset(0);
    const pxx = (p.x + 0.5 + offX) * u, pyy = (p.y + 0.5 + offY) * u, sq = offSquash;
    drawDarkness(t, pxx, pyy - u * 0.12);

    // ---- over the darkness: what I remember, and what gives its own light ----
    for (let i = 0; i < N; i++) {
      const x = i % W, y = (i / W) | 0, X = x * u, Y = y * u, tt = st.tiles[i], d = darkCur[i];
      if (tt === T.WALL && d > 0.02) { ctx.globalAlpha = d * 0.9; ctx.drawImage(structCv, X * dpr, Y * dpr, u * dpr, u * dpr, X, Y, u, u); ctx.globalAlpha = 1; }
      if (d > 0.02 && !lit[i]) {
        ctx.globalAlpha = d;
        if (tt === T.BRAZIER) { if (!E.brazierAt(st, x, y).lit) drawBrazier(X + u * 0.5, Y + u * 0.5, u, t, 0, true, 0); }
        else if (tt === T.ALTAR) drawAltar(X + u * 0.5, Y + u * 0.5, u, t, true, true);
        else if (tt === T.STAIRS) drawStairs(X, Y, u, t, 0, true);
        else if (tt === T.CHEST && st.memC[i]) drawChest(X + u * 0.5, Y + u * 0.5, u, t, true);
        if (st.memO[i] && st.oil[i]) drawOil(i, X, Y, u, true);
        if (st.memE[i] > 0) drawEmbers(X + u * 0.5, Y + u * 0.5, u, t, st.memE[i], tileSeed[i], true);
        ctx.globalAlpha = 1;
      }
      if (st.fire[i] > 0 && clock >= fireAt[i]) drawFire(i, X, Y, u, t, Math.min(1, 0.55 + st.fire[i] * 0.15) * clamp01((clock - fireAt[i]) / 120 + 0.3));
      if (lit[i] && st.embers[i] > 0 && clock >= emberAt[i]) drawEmbers(X + u * 0.5, Y + u * 0.5, u, t, st.embers[i], tileSeed[i], false);
    }
    for (const e of st.enemies) {
      const v = E.enemyView(st, e);
      if (v === 'memory') drawEnemy(e, e.x, e.y, t, true, 0.95);
      else if (v === 'eyes') { actorOffset(e.id); drawEyesInDark(e.x + offX, e.y + offY, t, (e.id % 13) * 0.7); }
    }

    // ---- warm light blooming from every flame ----
    ctx.globalCompositeOperation = 'lighter';
    const flick = reduced ? 1 : 1 + Math.sin(t * 0.013) * 0.04 + Math.sin(t * 0.031 + 1) * 0.03;
    for (const b of st.braziers) {
      const reach = brReach[idx(b.x, b.y)];
      if (reach <= 0) continue;
      const r = (reach + 0.6) * u * flick;
      ctx.globalAlpha = 0.2; ctx.drawImage(glowCv, (b.x + 0.5) * u - r, (b.y + 0.42) * u - r, r * 2, r * 2);
    }
    if (myReach > 0.05) {
      const r = (myReach + 0.6) * u * flick;
      ctx.globalAlpha = 0.24 * (1 - 0.5 * cupAmt); ctx.drawImage(glowCv, pxx - r, pyy - u * 0.28 - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;

    // ---- warnings: where I would be hit, where a blast would reach ----
    if (st.mode === 'play' || st.mode === 'altar') {
      const old = clock < warnSwapAt && threatOld && blastOld;
      const th = old ? threatOld : threat, bl = old ? blastOld : blast, occ = old ? occupiedOld : occupiedSeen;
      for (let i = 0; i < N; i++) {
        const x = i % W, y = (i / W) | 0;
        if (bl[i] > 0 && !th[i]) {
          ctx.strokeStyle = 'rgba(255,178,62,0.75)'; ctx.lineWidth = Math.max(1.5, u * 0.035); ctx.setLineDash(DASH);
          ctx.strokeRect(x * u + u * 0.08, y * u + u * 0.08, u * 0.84, u * 0.84); ctx.setLineDash(NODASH);
        }
        if (th[i] > 0 && !occ[i]) threatTile(x, y, th[i]);
      }
    }
    if (inspectI >= 0 && inspectInfo) drawInspect(u);
    if (aim) drawAim(u, t);

    // ---- me ----
    const hurting = clock - hurtAt < 110;
    WOPT.squash = sq + (clock - waitAt < 160 ? Math.sin((clock - waitAt) / 160 * Math.PI) * 0.5 : 0);
    WOPT.hurt = hurting; WOPT.dead = isDead; WOPT.dir = p.dir;
    drawWick(pxx, pyy, u, t, clamp01(flameShown / p.max), isDead ? 0 : Math.max(p.flame, flameShown > 0.5 ? 1 : 0), cupAmt, WOPT);

    // ---- effects on top ----
    for (let i = 0; i < fx.length;) {
      const f = fx[i], k = (clock - f.t0) / f.dur;
      if (k >= 1) { fx.splice(i, 1); continue; }
      if (k >= 0) {
        if (f.kind === 'ring') {
          ctx.globalAlpha = (1 - k) * 0.8; ctx.strokeStyle = f.color; ctx.lineWidth = u * 0.07 * (1 - k) + 1;
          circ((f.x + 0.5) * u, (f.y + 0.5) * u, u * f.size * easeOut(k)); ctx.stroke();
        } else {
          const x1 = (f.x + 0.5) * u, y1 = (f.y + 0.3) * u, x2 = (f.x2 + 0.5) * u, y2 = (f.y2 + 0.4) * u;
          const a = clamp01(k), b = clamp01(k - 0.35);
          ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = f.color; ctx.lineCap = 'round'; ctx.lineWidth = u * 0.09;
          line(x1 + (x2 - x1) * b, y1 + (y2 - y1) * b, x1 + (x2 - x1) * a, y1 + (y2 - y1) * a);
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.globalAlpha = 1;
      }
      i++;
    }
    drawParticles();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    for (let i = 0; i < FMAX; i++) {
      const f = floats[i], k = (clock - f.t0) / f.dur;
      if (k < 0 || k >= 1) continue;
      const fs = Math.round(u * 0.36 * f.size * (1 + 0.35 * Math.max(0, 1 - k * 6)));
      ctx.globalAlpha = 1 - k * k;
      ctx.font = fontB(fs);
      const fx0 = (f.x + 0.5) * u, fy0 = (f.y + 0.5) * u - easeOut(k) * u * 0.55;
      ctx.lineWidth = Math.max(2, fs * 0.22); ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.strokeText(f.text, fx0, fy0);
      ctx.fillStyle = f.color; ctx.fillText(f.text, fx0, fy0);
    }
    ctx.globalAlpha = 1;
    if (clock - flashAt < 200) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.28 * (1 - (clock - flashAt) / 200); ctx.fillStyle = PAL.flameCore; ctx.fillRect(0, 0, bw, bh); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; }
    if (hurting) { ctx.globalAlpha = 0.1 * (1 - (clock - hurtAt) / 110); ctx.fillStyle = PAL.danger; ctx.fillRect(0, 0, bw, bh); ctx.globalAlpha = 1; }
    if (wonAt >= 0) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.5 * clamp01((clock - wonAt) / 700); ctx.fillStyle = PAL.flameMid; ctx.fillRect(0, 0, bw, bh); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; }
    ctx.restore();

    // the floor I just left, fading away
    if (clock - snapT0 < 260) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1 - easeInOut(clamp01((clock - snapT0) / 260));
      ctx.drawImage(snapCv, 0, 0);
      ctx.globalAlpha = 1;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Public
  // ---------------------------------------------------------------------------------------------
  function attach(canvas) { cv = canvas; ctx = cv.getContext('2d', { alpha: false }); }
  function resize(tile, ratio) {
    TS = tile; dpr = ratio; bw = W * TS; bh = H * TS;
    cv.width = Math.round(bw * dpr); cv.height = Math.round(bh * dpr);
    cv.style.width = bw + 'px'; cv.style.height = bh + 'px';
    buildSprites();
    floorKey = '';
    if (st) buildFloor();
  }
  // Which tile is under a point on the page?
  function tileAt(clientX, clientY) {
    const r = cv.getBoundingClientRect();
    const x = Math.floor((clientX - r.left) / r.width * W), y = Math.floor((clientY - r.top) / r.height * H);
    return E.inb(x, y) ? { x: x, y: y } : null;
  }

  // The candle on the title and summary screens.
  function drawPortrait(canvas, now, flame, max, out) {
    const save = ctx, g = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height, u = Math.min(w, h * 0.62);
    ctx = g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h - u * 0.5;
    if (!out && glowCv) {
      const gy = cy - u * 0.3, fl = reduced ? 1 : 1 + Math.sin(now * 0.013) * 0.03 + Math.sin(now * 0.031 + 1) * 0.02;
      const r = Math.min(w / 2, gy, h - gy) * 0.97 * fl;                 // the glow dies away before the canvas ends
      g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.6; g.drawImage(glowCv, cx - r, gy - r, r * 2, r * 2);
      g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    }
    WOPT.squash = 0; WOPT.hurt = false; WOPT.dead = !!out; WOPT.dir = 2;
    drawWick(cx, cy, u, now, clamp01(flame / max), out ? 0 : flame, 0, WOPT);
    if (out) {                                     // a last thread of smoke
      g.strokeStyle = 'rgba(160,160,170,0.5)'; g.lineWidth = u * 0.02; g.lineCap = 'round';
      g.beginPath();
      const top = cy - u * 0.08;
      g.moveTo(cx, top);
      for (let k = 1; k <= 12; k++) g.lineTo(cx + Math.sin(now * 0.002 + k * 0.7) * u * 0.03 * k * 0.3, top - k * u * 0.03);
      g.stroke();
    }
    ctx = save;
  }

  window.WickRender = {
    attach: attach, resize: resize, setState: setState, play: play, frame: frame, tileAt: tileAt,
    drawPortrait: drawPortrait,
    setAim: v => { aim = !!v; },
    setInspect: (i, info) => { inspectI = i; inspectInfo = info; },
    setReduced: v => { reduced = !!v; },
    setHudTarget: (x, y) => { hudX = x; hudY = y; },
    tile: () => TS,
    PAL: PAL
  };
})();
