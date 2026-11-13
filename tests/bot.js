/* Wickbound: a simple bot, for tuning and for hunting degenerate cases.
 *
 *   node tests/bot.js [runs] [strategy ...]
 *
 * The bot tries each legal action in the real engine and looks at what it would do. Its rules, in order:
 *   1. take a strike that costs nothing (a sneak attack that kills, an enemy that has just stepped up);
 *   2. Flare an awake Tinder Beetle before it arrives;
 *   3. pay for a strike when it is worth it (an awake archer or beetle beside it, a sleeping ooze);
 *   4. otherwise walk towards its goal without stepping where it would be hit, which also means it
 *      lets enemies come to it. Goals: the free relic, sleepers, embers and chests it has room for,
 *      the braziers, then the stairs.
 * It only acts on what a player could know (lit things, remembered things, eyes), with one exception:
 * it sees the true result of a move, so it never walks into a hit from something unseen. That makes it
 * a rough upper bound on careful play, not a model of a person.
 *
 * Strategies differ only in how they use the cup:
 *   bright   never cups
 *   stealth  the intended loop: walk bright, cup when a sleeper stirs, strike from the dark
 *   strobe   uncovers the flame one turn in four, whatever is around (looking for a flicker exploit)
 *   dark     stays cupped unless something is awake (looking for a "never look" exploit)
 */
'use strict';
const C = require('../config.js');
const E = require('../engine.js');
const { T, ST, N, idx, xOf, yOf, DX, DY } = E;

const TURN_CAP = 5000;
const known = (s, e) => E.enemyView(s, e) !== 'hidden';

// Steps from (sx, sy) to every floor tile, ignoring enemies. Chests block only if the bot knows about
// them; "ks" is the state whose knowledge counts (the present one, even when judging a future one).
function distances(s, sx, sy, ks) {
  ks = ks || s;
  const dm = new Array(N).fill(999), q = [idx(sx, sy)];
  dm[q[0]] = 0;
  for (let h = 0; h < q.length; h++) {
    const x = xOf(q[h]), y = yOf(q[h]);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (!E.inb(nx, ny)) continue;
      const n = idx(nx, ny);
      if (dm[n] !== 999) continue;
      const t = s.tiles[n];
      const walk = t === T.FLOOR || (t === T.STAIRS && s.stairs.open) || (t === T.CHEST && !E.chestKnown(ks, n));
      if (!walk) continue;
      dm[n] = dm[q[h]] + 1;
      if (t !== T.STAIRS) q.push(n);            // the stairs are a way out, not a way through
    }
  }
  return dm;
}
// Steps to stand on a tile, or beside it if it is solid.
function reach(s, dm, x, y) {
  const i = idx(x, y);
  if (dm[i] !== 999) return dm[i];
  let best = 999;
  for (let d = 0; d < 4; d++) {
    const nx = x + DX[d], ny = y + DY[d];
    if (E.inb(nx, ny) && s.tiles[idx(nx, ny)] !== T.STAIRS) best = Math.min(best, dm[idx(nx, ny)] + 1);   // not from the stairs: standing there is leaving
  }
  return best;
}

// What the bot is walking towards.
function goalOf(s, strat) {
  const p = s.p, dm = distances(s, p.x, p.y), room = p.max - p.flame, out = [];
  const add = (kind, x, y, pri) => { const d = reach(s, dm, x, y); if (d < 999) out.push({ kind: kind, x: x, y: y, d: d, pri: pri }); };
  const embers = [], chests = [];
  for (let i = 0; i < N; i++) {
    const seen = s.lit[i] ? s.embers[i] : s.memE[i];
    if (seen > 0 && s.embers[i] > 0 && !s.fire[i]) embers.push(i);
    if (E.chestKnown(s, i)) chests.push(i);
  }
  // an ember within two steps is worth the detour whenever there is room for it
  if (room >= 1) for (const i of embers) if (dm[i] <= 2) add('ember', xOf(i), yOf(i), 0);
  // the free relic
  for (const a of s.altars) if (!a.used) add('altar', a.x, a.y, 1);
  // sleepers it has seen (the bright bot lets everything come to it instead)
  if (strat !== 'bright') {
    const br = E.brazierRadius(s) + 0.5;
    for (const e of s.enemies) {
      if (e.st === ST.AWAKE || e.t === 'beetle' || !known(s, e)) continue;
      const doomed = s.braziers.some(b => !b.lit && (b.x - e.x) * (b.x - e.x) + (b.y - e.y) * (b.y - e.y) <= br * br);
      if (room >= 1 || doomed) add('hunt', e.x, e.y, 2);
    }
  }
  // flame lying around, when there is room for it
  if (room >= 2) for (const i of embers) add('ember', xOf(i), yOf(i), 3);
  if (room >= 3) for (const i of chests) add('chest', xOf(i), yOf(i), 3);
  for (const b of s.braziers) if (!b.lit) add('brazier', b.x, b.y, 4);
  // a last sweep before leaving
  if (room >= 1) {
    for (const i of embers) add('ember', xOf(i), yOf(i), 5);
    for (const i of chests) add('chest', xOf(i), yOf(i), 5);
  }
  if (s.stairs.open) add('stairs', s.stairs.x, s.stairs.y, 6);
  out.sort((a, b) => (a.pri - b.pri) || (a.d - b.d));
  return out[0] || null;
}

function wantCup(s, strat, mem) {
  if (strat === 'bright') return false;
  if (E.anyAwake(s)) return false;               // needs to see the red tiles
  if (strat === 'dark') return true;
  if (strat === 'strobe') return (mem.turns % 4) !== 3;
  // stealth: cup whenever a sleeper it knows about is stirring or would be lit
  const p = s.p, r = E.openRadius(s) + 0.5;
  for (const e of s.enemies) {
    if (e.st === ST.AWAKE) continue;
    if (e.st === ST.STIRRING) return true;
    if (!known(s, e)) continue;
    if ((e.x - p.x) * (e.x - p.x) + (e.y - p.y) * (e.y - p.y) <= r * r) return true;
  }
  return false;
}

function decide(s, strat, mem) {
  if (s.mode === 'altar') {
    const a = E.altarAt(s, xOf(s.altarAt), yOf(s.altarAt));
    const free = a.offers.findIndex(o => o.free);
    return free >= 0 ? { t: 'take', i: free } : { t: 'leave' };
  }
  if (wantCup(s, strat, mem) !== s.p.cupped) return { t: 'cup' };
  const p = s.p, goal = goalOf(s, strat);
  const impatient = mem.idle > 25, desperate = mem.idle > 60;

  // What would each action actually do?
  const opts = [];
  for (const a of E.legalActions(s)) {
    if (a.t === 'cup' || a.t === 'spark') continue;
    const o = { a: a, kind: a.t, target: null, blind: false, x: p.x, y: p.y };
    if (a.t === 'move') {
      const x = p.x + DX[a.d], y = p.y + DY[a.d], i = idx(x, y), t = s.tiles[i];
      const e = E.enemyAt(s, x, y);
      if (t === T.STAIRS && !(goal && goal.kind === 'stairs')) continue;                                    // do not leave early
      if (t === T.CHEST && E.chestKnown(s, i) && !(goal && goal.kind === 'chest') && !impatient) continue;   // do not waste a chest
      if (e && known(s, e)) { o.kind = 'strike'; o.target = e; }
      else if (e || t === T.CHEST) { o.blind = true; o.x = x; o.y = y; }                                    // it thinks this is bare floor
    } else if (a.t === 'flare') {
      const path = E.flarePath(s, a.d, true);
      if (path.end !== 'enemy') continue;                                                                   // sparks are for enemies it can see
      o.target = E.enemyAt(s, path.x, path.y);
    }
    o.r = E.step(s, a);
    if (!o.r.changed) continue;
    o.dead = o.r.state.mode === 'dead';
    o.hurt = 0; o.gain = 0;
    for (const e of o.r.events) {
      if (e.e === 'hurt') o.hurt += e.dmg;
      else if (e.e === 'pickup') o.gain += e.v;
      else if (e.e === 'chest' || e.e === 'gain') o.gain += (e.gain || e.n || 0);
    }
    opts.push(o);
  }
  const alive = opts.filter(o => !o.dead);
  if (!alive.length) return opts.length ? opts[0].a : { t: 'wait' };

  // 1. A strike that costs nothing.
  let pick = null;
  for (const o of alive) {
    if (o.kind !== 'strike' || o.hurt > 0) continue;
    const kills = !o.r.state.enemies.some(e => e.id === o.target.id);
    const rank = (o.target.st === ST.AWAKE ? 2 : 0) + (kills ? 1 : 0);
    if (!pick || rank > pick.rank) pick = { o: o, rank: rank };
  }
  if (pick) return pick.o.a;

  // 2. Flare an awake Tinder Beetle before it arrives, or a sleeping one that takes friends with it.
  for (const o of alive) {
    if (o.kind !== 'flare' || o.hurt > 0 || o.target.t !== 'beetle') continue;
    if (o.target.st === ST.AWAKE || s.enemies.length - o.r.state.enemies.length >= 2) return o.a;
  }

  // 3. A strike worth paying for.
  for (const o of alive) {
    if (o.kind !== 'strike') continue;
    const left = o.r.state.p.flame, t = o.target;
    if (t.st === ST.AWAKE && (t.t === 'archer' || t.t === 'beetle') && left >= 3) return o.a;
    if (t.st !== ST.AWAKE && t.t === 'ooze' && o.hurt <= 1 && left >= 3) return o.a;
    if (impatient && left >= 2) return o.a;
  }

  // 4. Walk towards the goal without getting hit. Waiting when a step would be punished is what
  //    lets enemies come to it.
  let best = null, bestV = -Infinity;
  for (const o of alive) {
    if (o.kind === 'flare' || (o.kind === 'strike' && !desperate)) continue;
    const n = o.r.state;
    let v = 20 * o.gain - (impatient ? 6 : 100) * (o.blind ? 0 : o.hurt);
    if (n.floor !== s.floor || n.mode === 'won') v += 1000;
    else if (goal) {
      const dm = o.blind ? distances(s, o.x, o.y) : distances(n, n.p.x, n.p.y, s);
      const d = Math.min(80, reach(o.blind ? s : n, dm, goal.x, goal.y));
      v -= d;
      if (impatient && d > goal.d) v -= 12;      // no dithering once it has run out of patience
    }
    if (n.mode === 'altar') v += 50;
    if (o.a.t === 'wait') v -= impatient ? 12 : 0.4;
    if (v > bestV) { bestV = v; best = o; }
  }
  return best ? best.a : alive[0].a;
}

function playRun(seed, strat, setup) {
  let s = E.newRun({ seed: seed, wick: 1 });
  if (setup) s = setup(s) || s;
  const mem = { turns: 0, idle: 0 };
  const log = { flameAt: {}, turnsAt: {}, maxIdle: 0, burn: 0 };
  let guard = 0;
  while ((s.mode === 'play' || s.mode === 'altar') && s.stats.turns < TURN_CAP && guard++ < TURN_CAP * 3) {
    // A Wick that has made no progress for 300 turns is not going to: count it as stalled.
    if (mem.idle > 300) { log.stalled = { flame: s.p.flame, floor: s.floor, relics: s.relics.slice() }; s = E.step(s, { t: 'abandon' }).state; break; }
    const a = decide(s, strat, mem);
    let r = E.step(s, a);
    if (!r.changed) r = E.step(s, { t: 'wait' });
    if (r.turn) {
      mem.turns++;
      const n = r.state;
      const milestone = n.floor !== s.floor || n.stats.kills !== s.stats.kills || n.stats.braziers !== s.stats.braziers ||
        n.relics.length !== s.relics.length || n.stats.embers !== s.stats.embers || n.stats.chests !== s.stats.chests || n.mode === 'won';
      mem.idle = milestone ? 0 : mem.idle + 1;
      log.maxIdle = Math.max(log.maxIdle, mem.idle);
      for (const e of r.events) if (e.e === 'burn') log.burn++;
      if (n.floor !== s.floor) { log.flameAt[n.floor] = n.p.flame; log.turnsAt[n.floor] = n.stats.turns; }
    }
    s = r.state;
  }
  return { s: s, log: log, capped: s.mode !== 'dead' && s.mode !== 'won' };
}

const median = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (n, d) => (d ? (100 * n / d).toFixed(0) + '%' : '-');

function report(strat, runs, setup, label) {
  const t0 = Date.now();
  const depth = [], turns = [], kills = [], sneaks = [], hurt = [], f4flame = [], f4turns = [], winTurns = [], burnRate = [], firstDeathTurns = [];
  const deaths = {}, capInfo = {}, diedOn = {}, stallRelics = {};
  let capped = 0, wins = 0, worstIdle = 0;
  const reachN = {};
  for (let k = 0; k < runs; k++) {
    const r = playRun(E.hash32(k, 2026), strat, setup), s = r.s;
    depth.push(s.floor); turns.push(s.stats.turns); kills.push(s.stats.kills); sneaks.push(s.stats.sneaks); hurt.push(s.stats.hurt);
    burnRate.push(100 * r.log.burn / Math.max(1, s.stats.turns));
    for (let f = 2; f <= s.floor + (s.mode === 'won' ? 1 : 0); f++) reachN[f] = (reachN[f] || 0) + 1;
    if (r.log.flameAt[4] != null) { f4flame.push(r.log.flameAt[4]); f4turns.push(r.log.turnsAt[4]); }
    worstIdle = Math.max(worstIdle, r.log.maxIdle);
    if (s.mode === 'won') { wins++; winTurns.push(s.stats.turns); }
    else if (r.capped) { capped++; const key = 'flame ' + s.p.flame + '/' + s.p.max + ' floor ' + s.floor; capInfo[key] = (capInfo[key] || 0) + 1; }
    else {
      const key = r.log.stalled ? 'stalled at ' + (r.log.stalled.flame <= 1 ? '1 flame' : 'high flame') : s.death.by === 'enemy' ? s.death.t : s.death.by;
      deaths[key] = (deaths[key] || 0) + 1;
      if (r.log.stalled) { const rk = r.log.stalled.relics.filter(x => x === 'slowburn' || x === 'hooded' || x === 'hearth').sort().join('+') || 'none of the burn-pausing relics'; stallRelics[rk] = (stallRelics[rk] || 0) + 1; }
      else firstDeathTurns.push(s.stats.turns);
      diedOn[s.floor] = (diedOn[s.floor] || 0) + 1;
    }
  }
  console.log('[' + (label || strat) + ']  ' + runs + ' runs, ' + (Date.now() - t0) + ' ms');
  console.log('  floor reached: median ' + median(depth) + ', mean ' + mean(depth).toFixed(1) + '   cleared all ' + C.CONFIG.run.floors + ': ' + pct(wins, runs) + (wins ? ' (median ' + median(winTurns) + ' turns)' : ''));
  console.log('  reached floor 2: ' + pct(reachN[2] || 0, runs) + '  3: ' + pct(reachN[3] || 0, runs) + '  4: ' + pct(reachN[4] || 0, runs) + '  6: ' + pct(reachN[6] || 0, runs) + '  9: ' + pct(reachN[9] || 0, runs));
  console.log('  arriving at floor 4: flame median ' + median(f4flame) + ', after ' + median(f4turns) + ' turns');
  console.log('  per run: turns ' + median(turns) + ', kills ' + mean(kills).toFixed(1) + ' (sneak ' + mean(sneaks).toFixed(1) + '), flame lost to hits ' + mean(hurt).toFixed(1) + ', burn per 100 turns ' + mean(burnRate).toFixed(1));
  console.log('  runs that ended in death: median ' + median(firstDeathTurns) + ' turns');
  console.log('  deaths by cause: ' + (Object.keys(deaths).sort((a, b) => deaths[b] - deaths[a]).map(k => k + ' ' + pct(deaths[k], runs)).join(', ') || 'none'));
  console.log('  deaths by floor: ' + (Object.keys(diedOn).map(f => f + ':' + diedOn[f]).join(' ') || 'none'));
  console.log('  runs still going after ' + TURN_CAP + ' turns: ' + capped + (capped ? '  ' + JSON.stringify(capInfo) : ''));
  if (Object.keys(stallRelics).length) console.log('  stalled runs held: ' + JSON.stringify(stallRelics));
  console.log('  longest spell without progress: ' + worstIdle + ' turns\n');
  return { wins: wins, capped: capped, reach4: reachN[4] || 0 };
}

if (require.main === module) {
  const RUNS = parseInt(process.argv[2], 10) || 300;
  const STRATS = process.argv.slice(3).length ? process.argv.slice(3) : ['bright', 'stealth', 'strobe', 'dark'];
  console.log('Wickbound bot, build ' + C.VERSION + '\n');
  for (const strat of STRATS) report(strat, RUNS);
}

module.exports = { decide: decide, goalOf: goalOf, playRun: playRun, report: report, distances: distances };
