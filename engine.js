/* Wickbound: the rules engine.
 *
 * Pure rules: no DOM, no timers, no Math.random. Everything the game is lives in one plain JSON state
 * object. step(state, action) returns a new state and a list of events for the renderer to animate.
 * The same seed and the same actions always give the same run.
 *
 * Actions:  {t:'move', d}  {t:'wait'}  {t:'cup'}  {t:'flare', d}  {t:'spark'}
 *           {t:'take', i}  {t:'leave'}  (at an altar)      {t:'abandon'}
 * Directions d: 0 up, 1 right, 2 down, 3 left.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./config.js'));
  else root.WickEngine = factory(root.WICK_CONFIG);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  const CFG = C.CONFIG, ENEMIES = C.ENEMIES, RELICS = C.RELICS, CANDLES = C.CANDLES,
        ZONES = C.ZONES, TEXT = C.TEXT;
  const W = CFG.board.w, H = CFG.board.h, N = W * H;
  const T = { FLOOR: 0, WALL: 1, BRAZIER: 2, ALTAR: 3, STAIRS: 4, CHEST: 5 };
  const ST = { ASLEEP: 0, STIRRING: 1, AWAKE: 2 };
  const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
  const RARITY = { common: 0, uncommon: 1, rare: 2 };

  const idx = (x, y) => y * W + x;
  const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  const xOf = i => i % W;
  const yOf = i => (i / W) | 0;
  const zeros = () => new Array(N).fill(0);

  // ==========================================================================================
  // Randomness: one generator (mulberry32) whose whole state is the integer s.rng
  // ==========================================================================================
  function rnd(s) {
    let t = (s.rng = (s.rng + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const ri = (s, n) => Math.floor(rnd(s) * n);
  function hash32(a, b) {
    let h = (a >>> 0) ^ Math.imul((b >>> 0) + 0x9E3779B9, 0x85EBCA6B);
    h ^= h >>> 16; h = Math.imul(h, 0x7FEB352D);
    h ^= h >>> 15; h = Math.imul(h, 0x846CA68B);
    h ^= h >>> 16;
    return h >>> 0;
  }
  function pickWeighted(s, items, weightOf) {
    let total = 0;
    for (const it of items) total += weightOf(it);
    let r = rnd(s) * total;
    for (const it of items) { r -= weightOf(it); if (r < 0) return it; }
    return items[items.length - 1];
  }

  // ==========================================================================================
  // Small helpers
  // ==========================================================================================
  const clone = s => JSON.parse(JSON.stringify(s));
  const has = (s, id) => s.relics.indexOf(id) >= 0;
  function enemyAt(s, x, y) {
    for (const e of s.enemies) if (e.x === x && e.y === y) return e;
    return null;
  }
  function brazierAt(s, x, y) {
    for (const b of s.braziers) if (b.x === x && b.y === y) return b;
    return null;
  }
  function altarAt(s, x, y) {
    for (const a of s.altars) if (a.x === x && a.y === y) return a;
    return null;
  }
  // Solid tiles stop movement.
  function solid(s, i) {
    const t = s.tiles[i];
    return t === T.WALL || t === T.BRAZIER || t === T.ALTAR || t === T.CHEST || (t === T.STAIRS && !s.stairs.open);
  }
  // Only things that never change stop an arrow: walls, braziers and altars. Arrows pass over chests
  // and the stair. If a chest could block a shot, opening it would expose me to a hit that no red tile
  // had warned of, and a chest I have not seen would give itself away by the shape of a threat line.
  function stopsShot(s, i) {
    const t = s.tiles[i];
    return t === T.WALL || t === T.BRAZIER || t === T.ALTAR;
  }
  function ordinal(n) {
    const t = n % 100;
    if (t >= 11 && t <= 13) return n + 'th';
    return n + (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  }

  // Events carry the phase they happened in: 0 my action, 1 enemies, 2 the world.
  let PH = 0;
  function emit(ev, o) { o.ph = PH; ev.push(o); return o; }

  // ==========================================================================================
  // Light
  // ==========================================================================================
  function baseRadius(flame) {
    let r = 0;
    for (const b of CFG.light.bands) if (flame >= b[0]) r = b[1];
    return r;
  }
  // My light radius with the flame uncovered.
  function openRadius(s) {
    const r = baseRadius(s.p.flame) + CANDLES[s.candle].lightMod + (has(s, 'mirror') ? 1 : 0);
    return r < 1 ? 1 : r;
  }
  // Cupped, the light covers my own tile only.
  const lightRadius = s => (s.p.cupped ? 0 : openRadius(s));
  const brazierRadius = () => CFG.light.brazierRadius;
  function within(ax, ay, bx, by, r) {
    const dx = ax - bx, dy = ay - by, m = r + CFG.light.reach;
    return dx * dx + dy * dy <= m * m;
  }
  const inMyLight = (s, x, y) => within(x, y, s.p.x, s.p.y, lightRadius(s));
  function inBrazierLight(s, x, y) {
    const r = brazierRadius(s);
    for (const b of s.braziers) if (b.lit && within(x, y, b.x, b.y, r)) return true;
    return false;
  }
  function computeLit(s) {
    const lit = zeros(), r = lightRadius(s);
    for (let i = 0; i < N; i++) {
      const x = xOf(i), y = yOf(i);
      if (within(x, y, s.p.x, s.p.y, r) || inBrazierLight(s, x, y)) lit[i] = 1;
    }
    return lit;
  }
  // Recompute what is lit, and remember what the light shows.
  function relight(s) {
    s.lit = computeLit(s);
    for (const e of s.enemies) if (s.lit[idx(e.x, e.y)]) e.seen = 1;
    for (let i = 0; i < N; i++) {
      if (s.lit[i]) { s.memE[i] = s.embers[i]; s.memO[i] = s.oil[i]; s.memC[i] = s.tiles[i] === T.CHEST ? 1 : 0; }
    }
  }
  // Chests, like enemies and embers, are only known once the light has shown them.
  const chestKnown = (s, i) => s.tiles[i] === T.CHEST && (!!s.lit[i] || !!s.memC[i]);
  // Uncovering the flame mid-turn counts as light for this turn's wake check (no free peeking).
  function expose(s) {
    if (!CFG.wake.peekCounts) return;
    for (const e of s.enemies) if (e.st !== ST.AWAKE && s.lit[idx(e.x, e.y)]) e.exp = 1;
  }

  // ==========================================================================================
  // Floor generation
  // ==========================================================================================
  const SHAPES = [
    { w: 3,   c: [[0, 0]] },
    { w: 2,   c: [[0, 0], [1, 0]] },
    { w: 2,   c: [[0, 0], [0, 1]] },
    { w: 1.5, c: [[0, 0], [1, 0], [2, 0]] },
    { w: 1,   c: [[0, 0], [0, 1], [0, 2]] },
    { w: 1,   c: [[0, 0], [1, 0], [0, 1]] },
    { w: 1,   c: [[0, 0], [1, 0], [1, 1]] },
    { w: 0.6, c: [[0, 0], [1, 0], [0, 1], [1, 1]] }
  ];

  function tableValue(table, floor) {
    let row = table[0];
    for (const r of table) if (floor >= r[0]) row = r;
    return row;
  }
  // Which floor tiles can be walked to from (sx, sy)?
  function flood(tiles, sx, sy) {
    const seen = zeros(), q = [idx(sx, sy)];
    seen[q[0]] = 1;
    for (let h = 0; h < q.length; h++) {
      const x = xOf(q[h]), y = yOf(q[h]);
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (!inb(nx, ny)) continue;
        const n = idx(nx, ny);
        if (seen[n] || tiles[n] !== T.FLOOR) continue;
        seen[n] = 1; q.push(n);
      }
    }
    return seen;
  }
  function touches(seen, x, y) {
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (inb(nx, ny) && seen[idx(nx, ny)]) return true;
    }
    return false;
  }
  function allFloorReached(tiles, seen) {
    for (let i = 0; i < N; i++) if (tiles[i] === T.FLOOR && !seen[i]) return false;
    return true;
  }

  // A floor is completable if, walking only on floor from the start, I can stand beside every
  // brazier, altar and chest and the stairs. Enemies never wall anything off: they can be killed.
  function floorOk(f) {
    if (f.tiles[idx(f.start.x, f.start.y)] !== T.FLOOR) return false;
    const seen = flood(f.tiles, f.start.x, f.start.y);
    if (!allFloorReached(f.tiles, seen)) return false;
    if (!touches(seen, f.stairs.x, f.stairs.y)) return false;
    for (const b of f.braziers) if (!touches(seen, b.x, b.y)) return false;
    for (const a of f.altars) if (!touches(seen, a.x, a.y)) return false;
    for (let i = 0; i < N; i++) if (f.tiles[i] === T.CHEST && !touches(seen, xOf(i), yOf(i))) return false;
    for (const e of f.enemies) if (!seen[idx(e.x, e.y)]) return false;
    return true;
  }

  function rollOffers(s) {
    const pool = Object.keys(RELICS).filter(id => !has(s, id));
    const offers = [];
    while (offers.length < CFG.altar.offers && pool.length) {
      const id = pickWeighted(s, pool, k => CFG.altar.weight[RELICS[k].rarity]);
      pool.splice(pool.indexOf(id), 1);
      offers.push({ id: id, free: false });
    }
    // The plainest of the three is the free one.
    let best = -1;
    for (let i = 0; i < offers.length; i++) {
      if (best < 0 || RARITY[RELICS[offers[i].id].rarity] < RARITY[RELICS[offers[best].id].rarity]) best = i;
    }
    if (best >= 0) offers[best].free = true;
    return offers;
  }

  function buildFloor(s) {
    const g = CFG.gen, tiles = zeros();
    const sx = 1 + ri(s, W - 2), sy = H - 1;

    // Keep a clear pocket around the start.
    const keep = zeros();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (inb(sx + dx, sy + dy)) keep[idx(sx + dx, sy + dy)] = 1;
    }

    // Walls: pillars and short runs, sometimes mirrored left to right, never cutting the floor in two.
    const target = g.walls[0] + ri(s, g.walls[1] - g.walls[0] + 1);
    const mirror = rnd(s) < g.mirrorChance;
    let placed = 0;
    for (let tries = 0; placed < target && tries < 80; tries++) {
      const shape = pickWeighted(s, SHAPES, sh => sh.w);
      const ox = ri(s, W), oy = ri(s, H);
      const cells = [];
      let ok = true;
      for (const c of shape.c) {
        const list = mirror ? [[ox + c[0], oy + c[1]], [W - 1 - (ox + c[0]), oy + c[1]]] : [[ox + c[0], oy + c[1]]];
        for (const q of list) {
          if (!inb(q[0], q[1])) { ok = false; break; }
          const i = idx(q[0], q[1]);
          if (tiles[i] !== T.FLOOR || keep[i]) { ok = false; break; }
          if (cells.indexOf(i) < 0) cells.push(i);
        }
        if (!ok) break;
      }
      if (!ok || placed + cells.length > g.walls[1]) continue;
      for (const i of cells) tiles[i] = T.WALL;
      if (allFloorReached(tiles, flood(tiles, sx, sy))) placed += cells.length;
      else for (const i of cells) tiles[i] = T.FLOOR;
    }

    // Stairs: top row, far from the start.
    let ex = -1;
    const ey = 0;
    for (let tries = 0; tries < 12 && ex < 0; tries++) {
      const x = ri(s, W), i = idx(x, ey);
      if (tiles[i] !== T.FLOOR) continue;
      tiles[i] = T.STAIRS;
      const seen = flood(tiles, sx, sy);
      if (allFloorReached(tiles, seen) && touches(seen, x, ey)) ex = x;
      else tiles[i] = T.FLOOR;
    }
    if (ex < 0) return null;

    // Braziers, the altar and chests: solid things that must stay reachable and must not cut the floor.
    const objs = [];
    function placeObj(kind, rowMin, rowMax) {
      for (let tries = 0; tries < 40; tries++) {
        const x = ri(s, W), y = rowMin + ri(s, rowMax - rowMin + 1), i = idx(x, y);
        if (tiles[i] !== T.FLOOR || keep[i]) continue;
        if (Math.abs(x - sx) + Math.abs(y - sy) < 3) continue;
        let crowded = false;
        for (const o of objs) if (Math.abs(o.x - x) <= 1 && Math.abs(o.y - y) <= 1) crowded = true;
        if (crowded) continue;
        tiles[i] = kind;
        const seen = flood(tiles, sx, sy);
        let fine = allFloorReached(tiles, seen) && touches(seen, x, y) && touches(seen, ex, ey);
        for (const o of objs) if (!touches(seen, o.x, o.y)) fine = false;
        if (fine) { objs.push({ kind: kind, x: x, y: y }); return true; }
        tiles[i] = T.FLOOR;
      }
      return false;
    }
    const nb = tableValue(g.braziers, s.floor)[1];
    for (let k = 0; k < nb; k++) {
      const lo = 1 + Math.floor(k * 6 / nb), hi = Math.floor((k + 1) * 6 / nb);
      if (!placeObj(T.BRAZIER, lo, Math.max(lo, hi))) return null;
    }
    const offers = rollOffers(s);
    if (offers.length && !placeObj(T.ALTAR, 1, 6)) return null;
    const chestRow = tableValue(g.chests, s.floor);
    const chests = chestRow[1] + ri(s, chestRow[2] - chestRow[1] + 1);
    for (let k = 0; k < chests; k++) placeObj(T.CHEST, 0, H - 2);    // a chest that will not fit is simply left out

    // Oil pools.
    const oil = zeros();
    const poolRow = tableValue(g.oilPools, s.floor);
    const pools = poolRow[1] + ri(s, poolRow[2] - poolRow[1] + 1);
    for (let k = 0; k < pools; k++) {
      let seed = -1;
      for (let tries = 0; tries < 20 && seed < 0; tries++) {
        const i = ri(s, N);
        if (tiles[i] === T.FLOOR && !keep[i] && !oil[i]) seed = i;
      }
      if (seed < 0) continue;
      const size = g.oilPoolSize[0] + ri(s, g.oilPoolSize[1] - g.oilPoolSize[0] + 1);
      const pool = [seed];
      oil[seed] = 1;
      for (let tries = 0; pool.length < size && tries < 30; tries++) {
        const from = pool[ri(s, pool.length)], d = ri(s, 4);
        const nx = xOf(from) + DX[d], ny = yOf(from) + DY[d];
        if (!inb(nx, ny)) continue;
        const n = idx(nx, ny);
        if (tiles[n] !== T.FLOOR || oil[n] || n === idx(sx, sy)) continue;
        oil[n] = 1; pool.push(n);
      }
    }

    // Enemies, bought from a budget that grows with depth.
    const zone = ZONES[s.zone];
    const eb = g.enemyBudget;
    let budget = Math.min(eb.max, eb.base + eb.perFloor * (s.floor - 1));
    const types = zone.enemies.filter(t => ENEMIES[t].minFloor <= s.floor);
    const enemies = [];
    const taken = zeros();
    while (enemies.length < g.maxEnemies) {
      const affordable = types.filter(t => ENEMIES[t].cost <= budget);
      if (!affordable.length) break;
      const t = pickWeighted(s, affordable, k => ENEMIES[k].weight);
      budget -= ENEMIES[t].cost;
      const spots = [], beside = [];
      for (let i = 0; i < N; i++) {
        if (tiles[i] !== T.FLOOR || taken[i]) continue;
        const x = xOf(i), y = yOf(i);
        if (Math.abs(x - sx) + Math.abs(y - sy) <= g.safeSteps) continue;
        spots.push(i);
        for (const o of enemies) if (Math.abs(o.x - x) + Math.abs(o.y - y) === 1) { beside.push(i); break; }
      }
      if (!spots.length) break;
      const from = (beside.length && rnd(s) < g.clusterChance) ? beside : spots;
      const i = from[ri(s, from.length)];
      taken[i] = 1;
      enemies.push({ t: t, x: xOf(i), y: yOf(i) });
    }

    return {
      tiles: tiles, oil: oil, start: { x: sx, y: sy }, stairs: { x: ex, y: ey },
      braziers: objs.filter(o => o.kind === T.BRAZIER).map(o => ({ x: o.x, y: o.y })),
      altars: objs.filter(o => o.kind === T.ALTAR).map(o => ({ x: o.x, y: o.y, offers: offers })),
      enemies: enemies
    };
  }

  // A plain room that is always valid, used only if the generator somehow fails every attempt.
  function plainFloor(s) {
    const tiles = zeros();
    tiles[idx(3, 0)] = T.STAIRS;
    tiles[idx(1, 3)] = T.BRAZIER;
    const offers = rollOffers(s);
    if (offers.length) tiles[idx(5, 4)] = T.ALTAR;
    return {
      tiles: tiles, oil: zeros(), start: { x: 3, y: H - 1 }, stairs: { x: 3, y: 0 },
      braziers: [{ x: 1, y: 3 }],
      altars: offers.length ? [{ x: 5, y: 4, offers: offers }] : [],
      enemies: [{ t: 'gnawer', x: 3, y: 2 }, { t: 'gnawer', x: 5, y: 1 }],
      plain: true
    };
  }

  function genFloor(s) {
    let f = null;
    for (let a = 0; a < CFG.gen.maxAttempts && !f; a++) {
      const c = buildFloor(s);
      if (c && floorOk(c)) f = c;
    }
    if (!f) f = plainFloor(s);
    return f;
  }

  function install(s, f) {
    s.tiles = f.tiles;
    s.oil = f.oil;
    s.fire = zeros(); s.scorch = zeros(); s.embers = zeros(); s.memE = zeros(); s.memO = zeros(); s.memC = zeros();
    s.p.x = f.start.x; s.p.y = f.start.y;
    s.stairs = { x: f.stairs.x, y: f.stairs.y, open: f.braziers.length === 0 };
    s.braziers = f.braziers.map(b => ({ x: b.x, y: b.y, lit: false }));
    s.altars = f.altars.map(a => ({ x: a.x, y: a.y, used: false, offers: a.offers }));
    s.enemies = f.enemies.map(e => ({
      id: s.nextId++, t: e.t, x: e.x, y: e.y, hp: ENEMIES[e.t].hp,
      st: ST.ASLEEP, dark: 0, cd: 0, stun: 0, seen: 0, exp: 0, f: e.x < f.start.x ? 1 : -1
    }));
    s.plain = !!f.plain;
  }

  function zoneFor() { return 'ossuary'; }   // stage 1: the Ossuary goes all the way down

  function enterFloor(s, n, ev) {
    s.floor = n;
    s.zone = zoneFor(n);
    s.kind = 'hall';
    s.rng = hash32(s.seed, n);       // each floor draws from the run seed and its own number
    install(s, genFloor(s));
    s.p.gasp = false; s.p.shield = false;
    s.mode = 'play'; s.altarAt = -1;
    relight(s);
    if (ev) emit(ev, { e: 'floor', n: n });
  }

  function newRun(opts) {
    opts = opts || {};
    const id = opts.candle || 'tallow', c = CANDLES[id];
    const s = {
      v: CFG.saveVersion, build: CFG.version,
      seed: (opts.seed >>> 0) || 1, rng: 0, candle: id, wick: opts.wick || 1,
      floor: 0, zone: 'ossuary', kind: 'hall', turn: 0, mode: 'play', plain: false,
      tiles: [], oil: [], fire: [], scorch: [], embers: [], lit: [], memE: [], memO: [], memC: [],
      p: { x: 0, y: 0, flame: c.max, max: c.max, cupped: false, burn: c.burnEvery, jar: 0, gasp: false, shield: false, dir: 0 },
      enemies: [], braziers: [], altars: [], stairs: { x: 0, y: 0, open: false },
      relics: [], altarAt: -1, nextId: 1,
      stats: { turns: 0, kills: 0, sneaks: 0, braziers: 0, embers: 0, chests: 0, hurt: 0, sparks: 0, floors: 0 },
      hurts: [], death: null, won: null
    };
    enterFloor(s, 1, null);
    return s;
  }

  // ==========================================================================================
  // Flame
  // ==========================================================================================
  const burnEvery = s => CANDLES[s.candle].burnEvery;

  function logHurt(s, n, src) {
    s.hurts.push({ n: n, by: src.kind, t: src.t || null, turn: s.turn, floor: s.floor });
    if (s.hurts.length > 6) s.hurts.shift();
  }
  function die(s, src, ev) {
    s.mode = 'dead';
    s.altarAt = -1;
    s.death = { by: src.kind, t: src.t || null, floor: s.floor, turn: s.turn };
    emit(ev, { e: 'snuffed', by: src.kind, t: src.t || null });
  }
  function gainFlame(s, n, why, ev) {
    const p = s.p, before = p.flame;
    p.flame = Math.min(p.max, p.flame + n);
    if (p.flame > before) emit(ev, { e: 'gain', n: p.flame - before, why: why, flame: p.flame });
  }
  function hurtPlayer(s, dmg, src, ev) {
    const p = s.p;
    if (s.mode === 'dead' || p.shield || dmg <= 0) return;
    if ((src.kind === 'fire' || src.kind === 'explosion') && has(s, 'waxseal')) {
      emit(ev, { e: 'immune', by: src.kind });
      return;
    }
    if (p.flame - dmg <= 0 && has(s, 'lastgasp') && !p.gasp) {
      // Last Gasp: once per floor, survive on 1 flame, stun everything beside me, and take nothing more this turn.
      const lost = p.flame - 1;
      p.gasp = true; p.shield = true; p.flame = 1;
      s.stats.hurt += lost;
      logHurt(s, lost, src);
      emit(ev, { e: 'hurt', dmg: lost, by: src.kind, t: src.t || null, flame: 1 });
      emit(ev, { e: 'lastgasp' });
      for (const e of s.enemies) {
        if (Math.abs(e.x - p.x) + Math.abs(e.y - p.y) === 1) e.stun = Math.max(e.stun, CFG.relics.lastGaspStun);
      }
      return;
    }
    const lost = Math.min(dmg, p.flame);
    p.flame -= lost;
    s.stats.hurt += lost;
    logHurt(s, lost, src);
    emit(ev, { e: 'hurt', dmg: lost, by: src.kind, t: src.t || null, flame: p.flame });
    if (p.flame <= 0) die(s, src, ev);
  }

  // ==========================================================================================
  // Embers
  // ==========================================================================================
  function dropEmbers(s, x, y, n, ev) {
    if (n <= 0) return;
    const i = idx(x, y);
    s.embers[i] += n;
    // Something dying right beside me leaves embers I know about, even with my flame cupped.
    if (Math.abs(x - s.p.x) + Math.abs(y - s.p.y) <= 1) s.memE[i] = s.embers[i];
    emit(ev, { e: 'drop', x: x, y: y, n: n });
  }
  function takeEmber(s, i, ev) {
    const p = s.p;
    let v = CFG.flame.ember;
    if (has(s, 'jar')) {
      p.jar++;
      if (p.jar >= CFG.relics.jarEvery) { p.jar = 0; v += 1; }
    }
    s.embers[i]--;
    if (s.memE[i] > s.embers[i]) s.memE[i] = s.embers[i];      // I know I took it
    const before = p.flame;
    p.flame = Math.min(p.max, p.flame + v);
    s.stats.embers++;
    emit(ev, { e: 'pickup', x: xOf(i), y: yOf(i), v: p.flame - before, flame: p.flame });
  }
  // At max flame embers stay where they lie.
  function collect(s, ev) {
    const p = s.p, i = idx(p.x, p.y);
    while (s.embers[i] > 0 && p.flame < p.max) takeEmber(s, i, ev);
  }
  function greedyPull(s, ev) {
    const p = s.p, reach = CFG.relics.greedyReach;
    for (let i = 0; i < N && p.flame < p.max; i++) {
      if (!s.embers[i]) continue;
      const d = Math.abs(xOf(i) - p.x) + Math.abs(yOf(i) - p.y);
      if (d === 0 || d > reach) continue;
      while (s.embers[i] > 0 && p.flame < p.max) takeEmber(s, i, ev);
    }
  }

  // ==========================================================================================
  // Fire and oil
  // ==========================================================================================
  function ignite(s, x, y, ev) {
    const i = idx(x, y);
    if (!s.oil[i] || s.fire[i] > 0) return;
    s.oil[i] = 0;
    s.fire[i] = CFG.oil.burnTurns;
    emit(ev, { e: 'ignite', x: x, y: y });
  }
  function hazardTick(s, ev) {
    const burning = [];
    for (let i = 0; i < N; i++) if (s.fire[i] > 0) burning.push(i);
    if (!burning.length) return;
    // 1. Burning tiles hurt whatever stands in them.
    for (const i of burning) {
      const x = xOf(i), y = yOf(i);
      if (s.p.x === x && s.p.y === y) hurtPlayer(s, CFG.oil.damage, { kind: 'fire' }, ev);
      const e = enemyAt(s, x, y);
      if (e) damageEnemy(s, e, CFG.oil.damage, { kind: 'fire', fire: true }, ev);
    }
    // 2. Fire spreads to touching oil.  3. Each burning tile burns down.
    for (const i of burning) {
      const x = xOf(i), y = yOf(i);
      for (let d = 0; d < 4; d++) if (inb(x + DX[d], y + DY[d])) ignite(s, x + DX[d], y + DY[d], ev);
      if (--s.fire[i] <= 0) {
        s.fire[i] = 0; s.scorch[i] = 1;
        emit(ev, { e: 'burnout', x: x, y: y });
      }
    }
  }

  // ==========================================================================================
  // Hurting enemies
  // ==========================================================================================
  function wake(s, e, why, ev) {
    e.st = ST.AWAKE; e.dark = 0; e.cd = 0;
    if (has(s, 'beacon') && inMyLight(s, e.x, e.y)) e.stun = Math.max(e.stun, 1);
    emit(ev, { e: 'wake', id: e.id, x: e.x, y: e.y, why: why });
  }
  function damageEnemy(s, e, dmg, src, ev) {
    if (e.hp <= 0) return;
    e.hp -= dmg;
    emit(ev, { e: 'hit', id: e.id, x: e.x, y: e.y, dmg: dmg, by: src.kind, hp: Math.max(0, e.hp) });
    if (e.hp <= 0) killEnemy(s, e, src, ev);
    else if (e.st !== ST.AWAKE) wake(s, e, 'hit', ev);     // a sleeper that is hit and survives wakes at once
  }
  function killEnemy(s, e, src, ev) {
    const def = ENEMIES[e.t];
    s.enemies.splice(s.enemies.indexOf(e), 1);
    s.stats.kills++;
    emit(ev, { e: 'die', id: e.id, t: e.t, x: e.x, y: e.y, by: src.kind });
    dropEmbers(s, e.x, e.y, def.embers + (src.fire && has(s, 'tinderbox') ? 1 : 0), ev);
    if (def.explode) explode(s, e.x, e.y, def.explode.dmg, e.t, ev);
  }
  function explode(s, x, y, dmg, type, ev) {
    emit(ev, { e: 'explode', x: x, y: y });
    ignite(s, x, y, ev);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (!inb(nx, ny)) continue;
      ignite(s, nx, ny, ev);
      if (s.p.x === nx && s.p.y === ny) hurtPlayer(s, dmg, { kind: 'explosion', t: type }, ev);
      const o = enemyAt(s, nx, ny);
      if (o) damageEnemy(s, o, dmg, { kind: 'explosion', fire: true }, ev);
    }
  }

  // ==========================================================================================
  // My actions
  // ==========================================================================================
  // What a strike would do to this enemy right now.
  function strikeInfo(s, e) {
    const c = CANDLES[s.candle], p = s.p;
    const sneak = e.st !== ST.AWAKE;
    let dmg = c.strike * (sneak ? c.sneakMult : 1);
    if (has(s, 'sunstone') && p.flame >= p.max) dmg += 1;
    if (has(s, 'smoulder') && p.flame * 2 <= p.max) dmg += 1;
    if (has(s, 'hearth') && inBrazierLight(s, p.x, p.y)) dmg += 1;
    return { dmg: dmg, sneak: sneak, kills: dmg >= e.hp };
  }

  function lightBrazier(s, b, ev) {
    b.lit = true;
    s.stats.braziers++;
    emit(ev, { e: 'brazier', x: b.x, y: b.y });
    if (has(s, 'tongs')) gainFlame(s, CFG.relics.tongsFlame, 'tongs', ev);
    if (!s.stairs.open && s.braziers.every(o => o.lit)) {
      s.stairs.open = true;
      emit(ev, { e: 'unseal', x: s.stairs.x, y: s.stairs.y });
    }
  }

  // A chest gives flame; what I cannot hold spills onto its tile as embers.
  function openChest(s, x, y, ev) {
    const p = s.p, i = idx(x, y), worth = CFG.flame.chest;
    const gain = Math.min(worth, p.max - p.flame);
    s.tiles[i] = T.FLOOR;
    s.memC[i] = 0;
    p.flame += gain;
    s.embers[i] += worth - gain;
    s.memE[i] = s.embers[i];
    s.stats.chests++;
    emit(ev, { e: 'chest', x: x, y: y, gain: gain, spill: worth - gain, flame: p.flame });
  }

  function descend(s, ev) {
    s.stats.floors++;
    s.turn++; s.stats.turns++;
    if (s.floor >= CFG.run.floors) {            // the bottom of the Undercroft
      s.mode = 'won';
      s.won = { floor: s.floor, turn: s.turn };
      emit(ev, { e: 'won' });
      return;
    }
    emit(ev, { e: 'descend', from: s.floor });
    enterFloor(s, s.floor + 1, ev);
  }

  // Returns 0 nothing happened, 1 changed without taking a turn, 2 took a turn, 3 went downstairs.
  function doMove(s, d, ev) {
    const p = s.p, x = p.x + DX[d], y = p.y + DY[d];
    p.dir = d;
    if (!inb(x, y)) { emit(ev, { e: 'bump', d: d, what: 'edge' }); return 0; }
    const i = idx(x, y), t = s.tiles[i];
    const e = enemyAt(s, x, y);
    if (e) {
      const info = strikeInfo(s, e);
      if (info.sneak) s.stats.sneaks++;
      emit(ev, { e: 'strike', d: d, id: e.id, x: x, y: y, dmg: info.dmg, sneak: info.sneak });
      damageEnemy(s, e, info.dmg, { kind: 'strike' }, ev);
      return 2;
    }
    if (t === T.WALL) { emit(ev, { e: 'bump', d: d, what: 'wall' }); return 0; }
    if (t === T.BRAZIER) {
      const b = brazierAt(s, x, y);
      if (b.lit) { emit(ev, { e: 'bump', d: d, what: 'lit' }); return 0; }
      emit(ev, { e: 'bump', d: d, what: 'brazier' });
      lightBrazier(s, b, ev);
      return 2;
    }
    if (t === T.ALTAR) {
      const a = altarAt(s, x, y);
      if (a.used) { emit(ev, { e: 'bump', d: d, what: 'spent' }); return 0; }
      s.mode = 'altar'; s.altarAt = i;
      emit(ev, { e: 'bump', d: d, what: 'altar' });
      emit(ev, { e: 'altar', x: x, y: y });
      return 1;
    }
    if (t === T.CHEST) {
      emit(ev, { e: 'bump', d: d, what: 'chest' });
      openChest(s, x, y, ev);
      return 2;
    }
    if (t === T.STAIRS) {
      if (!s.stairs.open) { emit(ev, { e: 'bump', d: d, what: 'sealed' }); return 0; }
      emit(ev, { e: 'move', fx: p.x, fy: p.y, tx: x, ty: y, d: d });
      p.x = x; p.y = y;
      descend(s, ev);
      return 3;
    }
    emit(ev, { e: 'move', fx: p.x, fy: p.y, tx: x, ty: y, d: d });
    p.x = x; p.y = y;
    collect(s, ev);
    return 2;
  }

  function uncup(s, ev) {
    if (!s.p.cupped) return;
    s.p.cupped = false;
    emit(ev, { e: 'cup', on: false });
  }
  function toggleCup(s, ev) {
    s.p.cupped = !s.p.cupped;
    emit(ev, { e: 'cup', on: s.p.cupped });
    relight(s);
    if (!s.p.cupped) expose(s);
    return 1;
  }
  const canSpend = (s, cost) => s.p.flame - cost >= 1;      // never the last flame

  // Where a Flare thrown in direction d would go. Shared by the rule and the aiming overlay; with
  // asSeen the path is drawn from what I know, so it gives away nothing the dark is hiding.
  function flarePath(s, d, asSeen) {
    const fl = CFG.sparks.flare, out = { tiles: [], end: 'fizzle', x: -1, y: -1 };
    let x = s.p.x, y = s.p.y;
    for (let k = 0; k < fl.range; k++) {
      x += DX[d]; y += DY[d];
      if (!inb(x, y)) break;
      const i = idx(x, y), t = s.tiles[i];
      if (t === T.WALL || t === T.ALTAR || (t === T.STAIRS && !s.stairs.open)) break;
      if (t === T.CHEST && (!asSeen || chestKnown(s, i))) break;
      if (t === T.BRAZIER) {
        out.tiles.push(i);
        out.end = brazierAt(s, x, y).lit ? 'fizzle' : 'brazier'; out.x = x; out.y = y;
        break;
      }
      out.tiles.push(i);
      const e = enemyAt(s, x, y);
      if (e && (!asSeen || enemyView(s, e) !== 'hidden')) { out.end = 'enemy'; out.x = x; out.y = y; break; }
    }
    return out;
  }
  function doFlare(s, d, ev) {
    const fl = CFG.sparks.flare, p = s.p;
    if (!canSpend(s, fl.cost)) { emit(ev, { e: 'refuse', why: 'lastFlame' }); return 0; }
    const path = flarePath(s, d);
    if (!path.tiles.length) { emit(ev, { e: 'refuse', why: 'noDir' }); return 0; }
    p.flame -= fl.cost; p.dir = d;
    s.stats.sparks++;
    uncup(s, ev);
    emit(ev, { e: 'flare', d: d, tiles: path.tiles, end: path.end, flame: p.flame });
    for (const i of path.tiles) if (s.tiles[i] === T.FLOOR) ignite(s, xOf(i), yOf(i), ev);
    if (path.end === 'enemy') {
      damageEnemy(s, enemyAt(s, path.x, path.y), fl.damage, { kind: 'flare', fire: true }, ev);
    } else if (path.end === 'brazier') {
      lightBrazier(s, brazierAt(s, path.x, path.y), ev);
    }
    return 2;
  }
  // Dazzle reaches every awake enemy inside my uncovered light. (Awake enemies are never hidden: in
  // the dark they show as eyes, so knowing whether any is in reach gives nothing away.)
  function dazzleTargets(s) {
    const p = s.p, r = openRadius(s);
    return s.enemies.filter(e => e.st === ST.AWAKE && within(e.x, e.y, p.x, p.y, r));
  }
  function doSpark(s, ev) {
    const p = s.p, kind = CANDLES[s.candle].spark;
    if (kind !== 'dazzle') return 0;
    const dz = CFG.sparks.dazzle;
    if (!canSpend(s, dz.cost)) { emit(ev, { e: 'refuse', why: 'lastFlame' }); return 0; }
    const targets = dazzleTargets(s);
    if (!targets.length) { emit(ev, { e: 'refuse', why: 'noDazzle' }); return 0; }      // never 2 flame for nothing
    uncup(s, ev);
    const ids = [];
    for (const e of targets) { e.stun = Math.max(e.stun, dz.turns); ids.push(e.id); }
    p.flame -= dz.cost;
    s.stats.sparks++;
    emit(ev, { e: 'dazzle', ids: ids, flame: p.flame });
    return 2;
  }

  // ----- Altars: looking is free, and so is taking; nothing moves while I choose. -----
  function relicPrice(s, offer) {
    if (offer.free) return 0;
    const r = RELICS[offer.id];
    return r.price != null ? r.price : CFG.altar.price[r.rarity];
  }
  function altarAction(s, action, ev) {
    const a = altarAt(s, xOf(s.altarAt), yOf(s.altarAt));
    if (action.t === 'leave' || !a) {
      s.mode = 'play'; s.altarAt = -1;
      emit(ev, { e: 'altarClose' });
      return 1;
    }
    if (action.t !== 'take') return 0;
    const offer = a.offers[action.i | 0];
    if (!offer) return 0;
    const cost = relicPrice(s, offer);
    if (cost > 0 && !canSpend(s, cost)) { emit(ev, { e: 'refuse', why: 'lastFlame' }); return 0; }
    s.p.flame -= cost;
    s.relics.push(offer.id);
    a.used = true;
    s.mode = 'play'; s.altarAt = -1;
    emit(ev, { e: 'relic', id: offer.id, cost: cost, x: a.x, y: a.y, flame: s.p.flame });
    relight(s);
    expose(s);       // a brighter light counts for this turn, like any other uncovering
    return 1;
  }

  // ==========================================================================================
  // Enemies
  // ==========================================================================================
  // The tiles an enemy can hit from where it stands: only ever tiles I could be standing on. Used
  // for the rule AND for the red tiles on screen, so what is drawn is exactly what can happen.
  function patternTiles(s, e) {
    const def = ENEMIES[e.t], out = [];
    if (def.pattern === 'line') {
      for (let d = 0; d < 4; d++) {
        let x = e.x, y = e.y;
        for (let k = 0; k < def.range; k++) {
          x += DX[d]; y += DY[d];
          if (!inb(x, y) || stopsShot(s, idx(x, y))) break;
          if (s.tiles[idx(x, y)] === T.FLOOR) out.push(idx(x, y));
        }
      }
    } else {
      for (let d = 0; d < 4; d++) {
        const x = e.x + DX[d], y = e.y + DY[d];
        if (inb(x, y) && s.tiles[idx(x, y)] === T.FLOOR) out.push(idx(x, y));
      }
    }
    return out;
  }
  const inPattern = (s, e, px, py) => patternTiles(s, e).indexOf(idx(px, py)) >= 0;
  const willAct = e => e.st === ST.AWAKE && e.stun <= 0 && e.cd <= 0;
  const enemyFloor = (s, i) => s.tiles[i] === T.FLOOR;
  const occupied = (s, x, y) => (s.p.x === x && s.p.y === y) || !!enemyAt(s, x, y);

  // Steps to me from every tile, walking on floor only.
  function distMap(s) {
    const dm = new Array(N).fill(99), q = [idx(s.p.x, s.p.y)];
    dm[q[0]] = 0;
    for (let h = 0; h < q.length; h++) {
      const x = xOf(q[h]), y = yOf(q[h]);
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (!inb(nx, ny)) continue;
        const n = idx(nx, ny);
        if (dm[n] !== 99 || !enemyFloor(s, n)) continue;
        dm[n] = dm[q[h]] + 1; q.push(n);
      }
    }
    return dm;
  }
  function moveEnemy(s, e, x, y, ev) {
    if (x !== e.x) e.f = x > e.x ? 1 : -1;
    emit(ev, { e: 'emove', id: e.id, fx: e.x, fy: e.y, tx: x, ty: y });
    e.x = x; e.y = y;
  }
  function chaseStep(s, e, dm, ev) {
    const p = s.p, dx = p.x - e.x, dy = p.y - e.y;
    const hd = dx > 0 ? 1 : 3, vd = dy > 0 ? 2 : 0;
    const order = Math.abs(dx) >= Math.abs(dy) ? [hd, vd, (vd + 2) % 4, (hd + 2) % 4] : [vd, hd, (hd + 2) % 4, (vd + 2) % 4];
    let best = -1, bestD = dm[idx(e.x, e.y)];
    for (const d of order) {
      const nx = e.x + DX[d], ny = e.y + DY[d];
      if (!inb(nx, ny)) continue;
      const n = idx(nx, ny);
      if (dm[n] >= bestD || !enemyFloor(s, n) || occupied(s, nx, ny)) continue;
      best = d; bestD = dm[n];
    }
    if (best < 0) return;
    moveEnemy(s, e, e.x + DX[best], e.y + DY[best], ev);
  }
  // Archers walk to the nearest tile that has a clear shot at me instead of chasing.
  function archerStep(s, e, dm, ev) {
    const start = idx(e.x, e.y), prev = new Array(N).fill(-2), q = [start];
    const probe = { t: e.t, x: 0, y: 0 };
    prev[start] = -1;
    let goal = -1;
    for (let h = 0; h < q.length && goal < 0; h++) {
      const i = q[h], x = xOf(i), y = yOf(i);
      if (i !== start) {
        probe.x = x; probe.y = y;
        if (inPattern(s, probe, s.p.x, s.p.y)) { goal = i; break; }
      }
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (!inb(nx, ny)) continue;
        const n = idx(nx, ny);
        if (prev[n] !== -2 || !enemyFloor(s, n) || occupied(s, nx, ny)) continue;
        prev[n] = i; q.push(n);
      }
    }
    if (goal < 0) { chaseStep(s, e, dm, ev); return; }
    let c = goal;
    while (prev[c] !== start) c = prev[c];
    moveEnemy(s, e, xOf(c), yOf(c), ev);
  }

  // Every awake enemy acts, nearest first. Each either attacks from where it stands or moves; never both.
  function enemyPhase(s, ev) {
    const p = s.p;
    const md = e => Math.abs(e.x - p.x) + Math.abs(e.y - p.y);
    const order = s.enemies.filter(e => e.st === ST.AWAKE).sort((a, b) => (md(a) - md(b)) || (a.id - b.id));
    let dm = null;
    for (const e of order) {
      if (s.mode === 'dead') return;
      if (e.hp <= 0 || s.enemies.indexOf(e) < 0) continue;      // died earlier in this phase
      if (e.stun > 0) { e.stun--; emit(ev, { e: 'skip', id: e.id, x: e.x, y: e.y }); continue; }
      if (e.cd > 0) { e.cd--; continue; }
      const def = ENEMIES[e.t];
      if (inPattern(s, e, p.x, p.y)) {
        if (p.x !== e.x) e.f = p.x > e.x ? 1 : -1;
        emit(ev, { e: 'attack', id: e.id, t: e.t, x: e.x, y: e.y, tx: p.x, ty: p.y, how: def.pattern === 'line' ? 'arrow' : 'bite' });
        hurtPlayer(s, def.dmg, { kind: 'enemy', t: e.t }, ev);
      } else {
        if (!dm) dm = distMap(s);
        if (def.ai === 'archer') archerStep(s, e, dm, ev);
        else chaseStep(s, e, dm, ev);
      }
      if (def.period > 1) e.cd = def.period - 1;
    }
  }

  // Sleepers check whether they wake.
  function wakeCheck(s, ev) {
    for (const e of s.enemies) {
      const lit = !!s.lit[idx(e.x, e.y)] || !!e.exp;
      e.exp = 0;
      if (e.st === ST.AWAKE) continue;
      if (e.st === ST.ASLEEP) {
        if (lit) { e.st = ST.STIRRING; e.dark = 0; emit(ev, { e: 'stir', id: e.id, x: e.x, y: e.y }); }
      } else if (lit) {
        wake(s, e, 'light', ev);
      } else if (++e.dark >= CFG.wake.settleTurns) {
        e.st = ST.ASLEEP; e.dark = 0;
        emit(ev, { e: 'settle', id: e.id, x: e.x, y: e.y });
      }
    }
  }

  function burnTick(s, waited, ev) {
    const p = s.p;
    if (p.cupped && has(s, 'hooded')) return;
    if (waited && has(s, 'slowburn')) return;
    if (has(s, 'hearth') && inBrazierLight(s, p.x, p.y)) return;
    if (--p.burn > 0) return;
    p.burn = burnEvery(s);
    p.flame--;
    logHurt(s, 1, { kind: 'burn' });
    emit(ev, { e: 'burn', flame: p.flame });
    if (p.flame <= 0) die(s, { kind: 'burn' }, ev);
  }

  // After my action: enemies, then hazards, then the burn, then sleepers.
  function endTurn(s, waited, ev) {
    PH = 1;
    if (s.mode !== 'dead') enemyPhase(s, ev);
    PH = 2;
    if (s.mode !== 'dead') hazardTick(s, ev);
    if (s.mode !== 'dead') burnTick(s, waited, ev);
    if (s.mode !== 'dead') { collect(s, ev); if (has(s, 'greedy')) greedyPull(s, ev); }
    s.p.shield = false;
    relight(s);
    if (s.mode !== 'dead') wakeCheck(s, ev);
    s.turn++; s.stats.turns++;
  }

  // ==========================================================================================
  // step: the one way the state ever changes
  // ==========================================================================================
  function step(state, action) {
    const ev = [];
    if (!action || !state || state.mode === 'dead' || state.mode === 'won') return { state: state, events: ev, changed: false, turn: false };
    const s = clone(state);
    const d = action.d | 0;
    PH = 0;
    let r = 0;
    if (action.t === 'abandon') { die(s, { kind: 'abandoned' }, ev); r = 1; }
    else if (s.mode === 'altar') r = altarAction(s, action, ev);
    else if (action.t === 'cup') r = toggleCup(s, ev);
    else if (action.t === 'wait') { emit(ev, { e: 'wait' }); r = 2; }
    else if (d < 0 || d > 3) r = 0;
    else if (action.t === 'move') r = doMove(s, d, ev);
    else if (action.t === 'flare') r = doFlare(s, d, ev);
    else if (action.t === 'spark') r = doSpark(s, ev);
    if (r === 0) return { state: state, events: ev, changed: false, turn: false };
    if (r === 2) endTurn(s, action.t === 'wait', ev);
    return { state: s, events: ev, changed: true, turn: r >= 2 };
  }

  // Every action that would do something right now (used by the tests and the bot).
  function legalActions(s) {
    const out = [];
    if (s.mode === 'dead' || s.mode === 'won') return out;
    if (s.mode === 'altar') {
      const a = altarAt(s, xOf(s.altarAt), yOf(s.altarAt));
      out.push({ t: 'leave' });
      if (a) a.offers.forEach((o, i) => { const c = relicPrice(s, o); if (c === 0 || canSpend(s, c)) out.push({ t: 'take', i: i }); });
      return out;
    }
    out.push({ t: 'wait' }, { t: 'cup' });
    const p = s.p;
    for (let d = 0; d < 4; d++) {
      const x = p.x + DX[d], y = p.y + DY[d];
      if (!inb(x, y)) continue;
      const i = idx(x, y), t = s.tiles[i];
      if (enemyAt(s, x, y)) { out.push({ t: 'move', d: d }); continue; }
      if (t === T.WALL) continue;
      if (t === T.BRAZIER && brazierAt(s, x, y).lit) continue;
      if (t === T.ALTAR && altarAt(s, x, y).used) continue;
      if (t === T.STAIRS && !s.stairs.open) continue;
      out.push({ t: 'move', d: d });
    }
    if (canSpend(s, CFG.sparks.flare.cost)) {
      for (let d = 0; d < 4; d++) if (flarePath(s, d).tiles.length) out.push({ t: 'flare', d: d });
    }
    if (CANDLES[s.candle].spark === 'dazzle' && canSpend(s, CFG.sparks.dazzle.cost) && dazzleTargets(s).length) out.push({ t: 'spark' });
    return out;
  }

  // ==========================================================================================
  // Queries for the screen
  // ==========================================================================================
  // How an enemy appears: 'lit' (drawn in full), 'eyes' (awake in the dark), 'memory' (a sleeper
  // I have seen before), or 'hidden'.
  function enemyView(s, e) {
    if (s.lit[idx(e.x, e.y)]) return 'lit';
    if (e.st === ST.AWAKE) return 'eyes';
    return e.seen ? 'memory' : 'hidden';
  }
  // Damage I would take on each tile in the coming enemy phase. By default only from enemies in the
  // light (what the screen shows); pass all=true for the truth (tests and the bot).
  function threatMap(s, all) {
    const th = zeros();
    for (const e of s.enemies) {
      if (!willAct(e)) continue;
      if (!all && !s.lit[idx(e.x, e.y)]) continue;
      const dmg = ENEMIES[e.t].dmg;
      for (const i of patternTiles(s, e)) th[i] += dmg;
    }
    return th;
  }
  // Tiles that would be caught in a blast if a visible exploding enemy died now.
  function blastMap(s) {
    const bl = zeros();
    for (const e of s.enemies) {
      const def = ENEMIES[e.t];
      if (!def.explode || !s.lit[idx(e.x, e.y)]) continue;
      for (let d = 0; d < 4; d++) {
        const x = e.x + DX[d], y = e.y + DY[d];
        if (inb(x, y) && s.tiles[idx(x, y)] === T.FLOOR) bl[idx(x, y)] = Math.max(bl[idx(x, y)], def.explode.dmg);
      }
    }
    return bl;
  }
  const anyAwake = s => s.enemies.some(e => e.st === ST.AWAKE);

  // A walking route to (tx, ty) using only what I know. Solid things I can use (a cold brazier, an
  // altar, a chest I have seen) are walked up to and then moved into. Returns a list of directions, or null.
  function pathTo(s, tx, ty) {
    if (!inb(tx, ty) || s.mode !== 'play') return null;
    const p = s.p, ti = idx(tx, ty), start = idx(p.x, p.y), tt = s.tiles[ti];
    if (ti === start || tt === T.WALL) return null;
    let bump = false;
    if (tt === T.BRAZIER) { if (brazierAt(s, tx, ty).lit) return null; bump = true; }
    else if (tt === T.ALTAR) { if (altarAt(s, tx, ty).used) return null; bump = true; }
    else if (tt === T.CHEST) { if (chestKnown(s, ti)) bump = true; }
    else if (tt === T.STAIRS && !s.stairs.open) return null;
    const blocked = i => {
      const t = s.tiles[i];
      if (t === T.CHEST) { if (chestKnown(s, i)) return true; }       // an unseen chest looks like floor
      else if (t !== T.FLOOR && !(i === ti && tt === T.STAIRS)) return true;
      if (s.fire[i] > 0) return true;
      const e = enemyAt(s, xOf(i), yOf(i));
      return !!(e && enemyView(s, e) !== 'hidden');
    };
    const prev = new Array(N).fill(-2), q = [start];
    prev[start] = -1;
    let goal = -1;
    for (let h = 0; h < q.length && goal < 0; h++) {
      const i = q[h], x = xOf(i), y = yOf(i);
      if (bump ? (Math.abs(x - tx) + Math.abs(y - ty) === 1) : i === ti) { goal = i; break; }
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (!inb(nx, ny)) continue;
        const n = idx(nx, ny);
        if (prev[n] !== -2 || blocked(n)) continue;
        prev[n] = i; q.push(n);
      }
    }
    if (goal < 0) return null;
    const dirs = [];
    const dirOf = (a, b) => { for (let d = 0; d < 4; d++) if (xOf(a) + DX[d] === xOf(b) && yOf(a) + DY[d] === yOf(b)) return d; return -1; };
    for (let c = goal; prev[c] >= 0; c = prev[c]) dirs.unshift(dirOf(prev[c], c));
    if (bump) dirs.push(dirOf(goal, ti));
    return dirs.length ? dirs : null;
  }

  // What a long-press on a tile tells me. Only ever what I can see or remember.
  function inspect(s, x, y) {
    if (!inb(x, y)) return null;
    const i = idx(x, y), p = s.p, lit = !!s.lit[i];
    const th = threatMap(s)[i];
    const warn = th > 0 ? ['Standing here next turn costs ' + th + ' flame.'] : [];
    if (p.x === x && p.y === y) {
      const r = lightRadius(s);
      return {
        kind: 'you', title: 'Wick the ' + ordinal(s.wick),
        lines: [
          'Flame ' + p.flame + ' of ' + p.max + '. It is your life, your light and your purse.',
          p.cupped ? 'Cupped: you light only your own tile, and sleepers do not notice you.' : 'Light radius ' + r + '. Sleepers your light touches begin to stir.',
          'The burn takes 1 flame in ' + p.burn + (p.burn === 1 ? ' turn.' : ' turns.')
        ].concat(warn)
      };
    }
    const e = enemyAt(s, x, y);
    if (e) {
      const v = enemyView(s, e), d = ENEMIES[e.t];
      if (v === 'lit') {
        const si = strikeInfo(s, e);
        const state = e.st === ST.ASLEEP ? 'Asleep. A strike now is a sneak attack.'
          : e.st === ST.STIRRING ? 'Stirring. One more lit turn wakes it; three dark turns settle it.'
          : e.stun > 0 ? 'Awake, but dazed. It loses its next turn.'
          : e.cd > 0 ? 'Awake, and resting this turn.' : 'Awake. It knows where you are.';
        const blast = [];
        if (d.explode) for (let k = 0; k < 4; k++) if (inb(x + DX[k], y + DY[k])) blast.push(idx(x + DX[k], y + DY[k]));
        return {
          kind: 'enemy', title: d.name, hp: e.hp, maxHp: d.hp, dmg: d.dmg,
          lines: [state, d.text, 'Your strike would deal ' + si.dmg + (si.kills ? ' and finish it.' : '.'), d.tip],
          threat: patternTiles(s, e), blast: blast
        };
      }
      if (v === 'memory') {
        return { kind: 'memory', title: d.name + ', as you remember it', lines: ['It was asleep when your light last touched it.', d.text], threat: patternTiles(s, e) };
      }
      if (v === 'eyes') {
        return { kind: 'eyes', title: 'Eyes in the dark', lines: ['Something is awake there. Until your light reaches it you cannot tell what it is or where it can hurt you.'] };
      }
    }
    const t = s.tiles[i];
    if (t === T.WALL) return { kind: 'wall', title: 'Wall', lines: ['Stone and old bone. It stops arrows. It does not stop light.'] };
    if (t === T.BRAZIER) {
      const b = brazierAt(s, x, y);
      return b.lit
        ? { kind: 'brazier', title: 'Lit brazier', lines: ['It lights 2 tiles around it for good, and keeps awake whatever it touches.'] }
        : { kind: 'brazier', title: 'Cold brazier', lines: ['Move into it to light it. That costs nothing, and wakes whatever sleeps nearby.', 'The stair opens when every brazier is lit.'] };
    }
    if (t === T.ALTAR) {
      const a = altarAt(s, x, y);
      return { kind: 'altar', title: 'Altar', lines: [a.used ? 'Spent.' : 'Three relics. One is free; the others are paid for in flame. Looking costs nothing.'] };
    }
    if (t === T.STAIRS) {
      const litN = s.braziers.filter(b => b.lit).length;
      return s.stairs.open
        ? { kind: 'stairs', title: 'The stair down', lines: ['Open. Stepping onto it leaves this floor for good, embers and all.'] }
        : { kind: 'stairs', title: 'Sealed stair', lines: ['It opens when every brazier on the floor is lit: ' + litN + ' of ' + s.braziers.length + ' so far.'] };
    }
    if (t === T.CHEST && chestKnown(s, i)) {
      return { kind: 'chest', title: 'Chest', lines: ['Move into it to open it: +' + CFG.flame.chest + ' flame.', 'What you cannot hold spills out as embers.'] };
    }
    if (s.fire[i] > 0) {
      return { kind: 'fire', title: 'Burning oil', lines: ['1 damage a turn to anything standing in it, you included.', 'Burns out in ' + s.fire[i] + (s.fire[i] === 1 ? ' turn' : ' turns') + ' and spreads to touching oil.'] };
    }
    const lines = [];
    let title = lit ? 'Lit floor' : 'Dark floor';
    const oil = lit ? s.oil[i] : s.memO[i], em = lit ? s.embers[i] : s.memE[i];
    if (oil) { title = 'Oil'; lines.push('Harmless until fire touches it. Then it burns for ' + CFG.oil.burnTurns + ' turns and spreads.'); }
    if (em) {
      title = em > 1 ? em + ' embers' : 'Ember';
      lines.push('+1 flame each. While your flame is full they stay where they lie.');
    }
    if (!lines.length) lines.push(lit ? 'In the light. Anything asleep here would begin to stir.' : 'Your light does not reach here. Enemies and embers in the dark stay hidden.');
    return { kind: 'floor', title: title, lines: lines.concat(warn) };
  }

  // ==========================================================================================
  // The end of a run
  // ==========================================================================================
  function score(s) {
    const k = CFG.score, st = s.stats;
    return st.floors * k.floor + st.braziers * k.brazier + st.kills * k.kill + Math.max(0, s.p.flame) * k.flame +
      (s.mode === 'won' ? k.win : 0);
  }
  function epitaph(s) {
    const d = s.death;
    if (s.mode === 'won') return TEXT.epitaph.won[0].replace('{w}', 'Wick the ' + ordinal(s.wick));
    if (!d) return '';
    let key = 'generic';
    if (d.by === 'abandoned') key = 'abandoned';
    else if (s.floor === 1 && s.stats.turns < 60) key = 'brief';
    else if (d.by === 'burn' || d.by === 'fire' || d.by === 'explosion') key = d.by;
    else if (d.by === 'enemy' && TEXT.epitaph[d.t]) key = d.t;
    const list = TEXT.epitaph[key];
    return list[hash32(s.seed, s.wick) % list.length].replace('{w}', 'Wick the ' + ordinal(s.wick));
  }
  function causeText(src) {
    if (src.by === 'enemy' && ENEMIES[src.t]) {
      const n = ENEMIES[src.t].name;
      return (/^[AEIOU]/.test(n) ? 'an ' : 'a ') + n;
    }
    return TEXT.causes[src.by] || 'the dark';
  }
  // "Wick the 13th: snuffed by a Bone Archer on floor 3, carrying 2 relics"
  function record(s) {
    const d = s.death, n = s.relics.length;
    const carrying = ', carrying ' + (n === 0 ? 'nothing' : n + (n === 1 ? ' relic' : ' relics'));
    if (s.mode === 'won') return 'Wick the ' + ordinal(s.wick) + ': reached the bottom with ' + s.p.flame + ' flame' + carrying;
    if (!d) return '';
    const how = d.by === 'burn' ? 'ran out of flame'
      : d.by === 'abandoned' ? 'pinched out'
      : 'snuffed by ' + causeText(d);
    return 'Wick the ' + ordinal(s.wick) + ': ' + how + ' on floor ' + d.floor + carrying;
  }

  // ==========================================================================================
  // Sanity: everything that must always be true of a state. Used by the tests after every step,
  // and by the app before it trusts a saved run.
  // ==========================================================================================
  function problems(s) {
    const out = [];
    const bad = m => out.push(m);
    try {
      if (!s || typeof s !== 'object') return ['not a state'];
      if (s.v !== CFG.saveVersion) bad('save version ' + s.v);
      for (const k of ['tiles', 'oil', 'fire', 'scorch', 'embers', 'lit', 'memE', 'memO', 'memC']) {
        if (!Array.isArray(s[k]) || s[k].length !== N) bad(k + ' is not a board');
      }
      if (out.length) return out;
      if (['play', 'altar', 'dead', 'won'].indexOf(s.mode) < 0) bad('mode ' + s.mode);
      if (!CANDLES[s.candle]) bad('candle ' + s.candle);
      const p = s.p;
      if (!inb(p.x, p.y)) bad('player off the board');
      else if (s.tiles[idx(p.x, p.y)] !== T.FLOOR && s.mode !== 'won') bad('player on a solid tile');
      if (!(p.flame >= 0 && p.flame <= p.max) || p.flame !== Math.floor(p.flame)) bad('flame ' + p.flame + '/' + p.max);
      if ((p.flame <= 0) !== (s.mode === 'dead') && !(s.death && s.death.by === 'abandoned')) bad('flame ' + p.flame + ' in mode ' + s.mode);
      if (!(p.burn >= 1 && p.burn <= burnEvery(s))) bad('burn counter ' + p.burn);
      const seen = {};
      for (const e of s.enemies) {
        if (!ENEMIES[e.t]) { bad('unknown enemy ' + e.t); continue; }
        if (!inb(e.x, e.y)) { bad('enemy off the board'); continue; }
        const i = idx(e.x, e.y);
        if (s.tiles[i] !== T.FLOOR) bad(e.t + ' on a solid tile');
        if (seen[i]) bad('two enemies on one tile');
        seen[i] = 1;
        if (e.x === p.x && e.y === p.y) bad('enemy on the player');
        if (!(e.hp >= 1)) bad('enemy with ' + e.hp + ' health');
        if ([0, 1, 2].indexOf(e.st) < 0) bad('enemy state ' + e.st);
      }
      for (let i = 0; i < N; i++) {
        if (s.embers[i] < 0) bad('negative embers');
        if (s.fire[i] < 0 || s.fire[i] > CFG.oil.burnTurns) bad('fire timer ' + s.fire[i]);
        if (s.oil[i] && s.fire[i]) bad('oil and fire on one tile');
        if ((s.oil[i] || s.fire[i] || s.embers[i]) && s.tiles[i] !== T.FLOOR) bad('hazard or ember on a solid tile');
      }
      for (const b of s.braziers) if (s.tiles[idx(b.x, b.y)] !== T.BRAZIER) bad('brazier record without a brazier tile');
      for (const a of s.altars) if (s.tiles[idx(a.x, a.y)] !== T.ALTAR) bad('altar record without an altar tile');
      if (s.tiles[idx(s.stairs.x, s.stairs.y)] !== T.STAIRS) bad('stairs record without a stairs tile');
      if (s.stairs.open !== s.braziers.every(b => b.lit)) bad('stairs open does not match the braziers');
      for (const id of s.relics) if (!RELICS[id]) bad('unknown relic ' + id);
      if (new Set(s.relics).size !== s.relics.length) bad('duplicate relic');
      if (s.mode === 'altar' && !(s.altarAt >= 0 && s.tiles[s.altarAt] === T.ALTAR)) bad('altar mode without an altar');
    } catch (err) {
      bad('exception: ' + err.message);
    }
    return out;
  }

  return {
    W: W, H: H, N: N, T: T, ST: ST, DX: DX, DY: DY, idx: idx, inb: inb, xOf: xOf, yOf: yOf,
    newRun: newRun, step: step, legalActions: legalActions, clone: clone,
    hash32: hash32, ordinal: ordinal, has: has,
    lightRadius: lightRadius, openRadius: openRadius, baseRadius: baseRadius, brazierRadius: brazierRadius,
    computeLit: computeLit, inBrazierLight: inBrazierLight, inMyLight: inMyLight,
    enemyAt: enemyAt, brazierAt: brazierAt, altarAt: altarAt, enemyView: enemyView, anyAwake: anyAwake,
    chestKnown: chestKnown, patternTiles: patternTiles, threatMap: threatMap, blastMap: blastMap, willAct: willAct,
    strikeInfo: strikeInfo, flarePath: flarePath, relicPrice: relicPrice, canSpend: canSpend,
    sparkReady: s => canSpend(s, CFG.sparks.dazzle.cost) && dazzleTargets(s).length > 0,
    pathTo: pathTo, inspect: inspect, score: score, epitaph: epitaph, record: record, causeText: causeText,
    problems: problems,
    // exposed for the tests
    _gen: { buildFloor: buildFloor, floorOk: floorOk, genFloor: genFloor, flood: flood, plainFloor: plainFloor },
    _refresh: relight
  };
});
