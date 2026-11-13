/* Wickbound: headless engine tests.   Run with:  node tests/test.js  [--quick]
 *
 *  1. Rule tests: each core rule checked on a hand-built board.
 *  2. Floors: thousands of generated floors per depth, each proved completable by an independent flood fill.
 *  3. Random runs: full runs with random legal inputs; no exceptions, no invalid states, every run ends.
 *  3b. Bot runs: the same checks on runs that get deep, pick up relics and reach the last floor.
 *  4. Determinism: same seed and inputs give the same run; a run saved and reloaded mid-way matches an
 *     uninterrupted one; step() never changes the state it was given.
 *  5. Fairness: every hit from a lit, awake enemy landed on a tile that was drawn red before the move.
 *  6. Files: version numbers agree, and no file uses an absolute URL.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../config.js');
const E = require('../engine.js');

const QUICK = process.argv.includes('--quick');
const { T, ST, N, W, H, idx, xOf, yOf } = E;
let passed = 0, failed = 0;
const fails = [];

function ok(cond, name) {
  if (cond) passed++;
  else { failed++; if (fails.length < 40) fails.push(name); }
}
function eq(a, b, name) { ok(a === b, name + '  (got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b) + ')'); }
function section(name) { console.log('\n== ' + name); }
const zeros = () => new Array(N).fill(0);

// ---------- hand-built boards ----------
function blank(flame) {
  const s = E.newRun({ seed: 7, wick: 1 });
  s.tiles = zeros(); s.oil = zeros(); s.fire = zeros(); s.scorch = zeros(); s.embers = zeros();
  s.memE = zeros(); s.memO = zeros(); s.memC = zeros();
  s.enemies = []; s.braziers = []; s.altars = [];
  s.tiles[idx(6, 0)] = T.STAIRS;
  s.stairs = { x: 6, y: 0, open: true };
  s.p.x = 3; s.p.y = 8;
  if (flame != null) s.p.flame = flame;
  E._refresh(s);
  return s;
}
function enemy(s, t, x, y, st) {
  const e = { id: s.nextId++, t: t, x: x, y: y, hp: C.ENEMIES[t].hp, st: st || 0, dark: 0, cd: 0, stun: 0, seen: 0, exp: 0, f: 1 };
  s.enemies.push(e);
  E._refresh(s);
  return e;
}
function brazier(s, x, y, lit) {
  s.tiles[idx(x, y)] = T.BRAZIER;
  s.braziers.push({ x: x, y: y, lit: !!lit });
  s.stairs.open = s.braziers.every(b => b.lit);
  E._refresh(s);
}
function wall(s, x, y) { s.tiles[idx(x, y)] = T.WALL; E._refresh(s); }
function chest(s, x, y) { s.tiles[idx(x, y)] = T.CHEST; E._refresh(s); }
function altar(s, x, y, offers) {
  s.tiles[idx(x, y)] = T.ALTAR;
  s.altars.push({ x: x, y: y, used: false, offers: offers });
  E._refresh(s);
}
function place(s, x, y) { s.p.x = x; s.p.y = y; E._refresh(s); }
function give(s, id) { s.relics.push(id); E._refresh(s); }
function act(s, a) { return E.step(s, a); }
function run(s, actions) {
  let events = [];
  for (const a of actions) { const r = E.step(s, a); s = r.state; events = events.concat(r.events); }
  return { s: s, ev: events };
}
const find = (s, id) => s.enemies.find(e => e.id === id);
const WAIT = { t: 'wait' }, CUP = { t: 'cup' };
const mv = d => ({ t: 'move', d: d });
const UP = 0, RIGHT = 1, DOWN = 2, LEFT = 3;
const sound = (s, name) => { const p = E.problems(s); ok(p.length === 0, name + ' leaves a valid state ' + p.join('; ')); };

// ==============================================================================================
section('1. Rules');
// ==============================================================================================
{
  // light radius follows flame
  const want = { 1: 1, 2: 1, 3: 2, 5: 2, 6: 3, 8: 3, 9: 4, 11: 4, 12: 5, 14: 5 };
  for (const f in want) eq(E.baseRadius(+f), want[f], 'light radius at flame ' + f);

  // a tile is lit if its centre is within radius + 0.5
  let s = blank(4); place(s, 3, 4);            // radius 2
  eq(E.lightRadius(s), 2, 'flame 4 gives radius 2');
  eq(s.lit[idx(5, 5)], 1, '(2,1) away is lit at radius 2');
  eq(s.lit[idx(5, 6)], 0, '(2,2) away is dark at radius 2');
  eq(s.lit[idx(6, 4)], 0, '(3,0) away is dark at radius 2');
  eq(s.lit[idx(3, 2)], 1, '(0,2) away is lit at radius 2');

  // walls do not block light
  wall(s, 3, 3);
  eq(s.lit[idx(3, 2)], 1, 'light passes walls');

  // cupping: own tile only, free, instant
  let r = act(s, CUP);
  eq(r.turn, false, 'cupping takes no turn');
  eq(r.state.lit.reduce((a, b) => a + b, 0), 1, 'cupped light covers one tile');
  eq(r.state.lit[idx(3, 4)], 1, 'cupped light covers my own tile');
  eq(r.state.turn, s.turn, 'cupping does not advance the turn counter');
  sound(r.state, 'cup');
}
{
  // asleep -> stirring -> awake
  let s = blank(4); place(s, 3, 6);
  const g = enemy(s, 'gnawer', 3, 4);
  let r = act(s, WAIT);
  eq(find(r.state, g.id).st, ST.STIRRING, 'a lit sleeper stirs at the end of the turn');
  ok(r.events.some(e => e.e === 'stir'), 'stirring raises an event');
  r = act(r.state, WAIT);
  eq(find(r.state, g.id).st, ST.AWAKE, 'lit for a second turn, it wakes');

  // three dark turns settle it
  s = blank(4); place(s, 3, 6);
  const g2 = enemy(s, 'gnawer', 3, 4);
  let x = run(s, [WAIT, CUP, WAIT, WAIT]);
  eq(find(x.s, g2.id).st, ST.STIRRING, 'two dark turns are not enough to settle');
  x = run(x.s, [WAIT]);
  eq(find(x.s, g2.id).st, ST.ASLEEP, 'three dark turns in a row settle it');

  // flickering does not cheat: two dark turns, then light again, wakes it
  x = run(s, [WAIT, CUP, WAIT, WAIT, CUP, WAIT]);
  eq(find(x.s, g2.id).st, ST.AWAKE, 'stir, two dark turns, then light wakes it');

  // no free peek: uncup and recup inside one turn still counts as a lit turn
  s = blank(4); place(s, 3, 6); s.p.cupped = true; E._refresh(s);
  const g3 = enemy(s, 'gnawer', 3, 4);
  x = run(s, [CUP, CUP, WAIT]);
  eq(x.s.p.cupped, true, 'peek: I end the turn cupped');
  eq(find(x.s, g3.id).st, ST.STIRRING, 'peek: uncovering mid-turn still stirs the sleeper');
  ok(find(x.s, g3.id).seen === 1, 'peek: the sleeper is remembered');
  x = run(x.s, [CUP, CUP, WAIT]);
  eq(find(x.s, g3.id).st, ST.AWAKE, 'peek: a second peek wakes it');

  // cupped, I do not wake sleepers even next to them
  s = blank(10); place(s, 3, 5); s.p.cupped = true; E._refresh(s);
  const g4 = enemy(s, 'gnawer', 3, 4);
  x = run(s, [WAIT, WAIT, WAIT]);
  eq(find(x.s, g4.id).st, ST.ASLEEP, 'cupped beside a sleeper, it sleeps on');
  eq(E.enemyView(x.s, find(x.s, g4.id)), 'hidden', 'an unseen sleeper in the dark is hidden');
}
{
  // combat: 1 damage, doubled against sleepers; survivors wake at once
  let s = blank(10); place(s, 3, 5); s.p.cupped = true; E._refresh(s);
  const o = enemy(s, 'ooze', 3, 4);
  let r = act(s, mv(UP));
  eq(find(r.state, o.id).hp, 1, 'sneak attack deals 2');
  eq(find(r.state, o.id).st, ST.AWAKE, 'a sleeper that survives a hit wakes at once');
  ok(r.events.some(e => e.e === 'attack'), 'and it hits back the same turn');
  eq(r.state.stats.sneaks, 1, 'sneak attacks are counted');

  s = blank(10); place(s, 3, 5);
  const o2 = enemy(s, 'ooze', 3, 4, ST.AWAKE);
  r = act(s, mv(UP));
  eq(find(r.state, o2.id).hp, 2, 'a strike on an awake enemy deals 1');

  // kills drop embers; at max flame they stay on the floor
  s = blank(10); place(s, 3, 5);
  enemy(s, 'gnawer', 3, 4, ST.AWAKE);
  r = act(s, mv(UP));
  eq(r.state.enemies.length, 0, 'gnawer dies to one strike');
  eq(r.state.embers[idx(3, 4)], 1, 'and drops an ember');
  eq(r.state.stats.kills, 1, 'kills are counted');
  r = act(r.state, mv(UP));
  eq(r.state.embers[idx(3, 4)], 1, 'at max flame the ember stays on the floor');
  eq(r.state.p.flame, 10, 'and flame is unchanged');
  let s2 = E.clone(r.state); s2.p.flame = 6; E._refresh(s2);
  r = act(s2, mv(UP)); r = act(r.state, mv(DOWN));
  eq(r.state.embers[idx(3, 4)], 0, 'below max, walking onto the ember picks it up');
  eq(r.state.p.flame, 7, 'for +1 flame');
}
{
  // whoever steps next to the other gets hit first
  let s = blank(10); place(s, 3, 6);
  enemy(s, 'gnawer', 3, 4, ST.AWAKE);
  let r = act(s, mv(UP));                       // I step adjacent: it bites
  ok(r.events.some(e => e.e === 'attack'), 'stepping beside an awake enemy gets me bitten');
  eq(r.state.p.flame, 9, 'for 1 flame');
  s = blank(10); place(s, 3, 6);
  const g = enemy(s, 'gnawer', 3, 3, ST.AWAKE);
  r = act(s, WAIT);                             // I wait: it comes to me and cannot bite on the turn it moves
  ok(!r.events.some(e => e.e === 'attack'), 'an enemy that moves does not also attack');
  eq(find(r.state, g.id).y, 4, 'it moved one tile towards me');
  r = act(r.state, WAIT);
  eq(find(r.state, g.id).y, 5, 'and one more');
  ok(!r.events.some(e => e.e === 'attack'), 'still no bite on the turn it arrives');
  r = act(r.state, mv(UP));
  eq(r.state.enemies.length, 0, 'so I strike first');
  eq(r.state.p.flame, 10, 'and take nothing');

  // the ooze acts every other turn
  s = blank(10); place(s, 3, 7);
  const o = enemy(s, 'ooze', 3, 3, ST.AWAKE);
  const ys = [];
  let cur = s;
  for (let k = 0; k < 4; k++) { cur = act(cur, WAIT).state; ys.push(find(cur, o.id).y); }
  eq(ys.join(','), '4,4,5,5', 'ooze moves every other turn');
}
{
  // the tinder beetle
  let s = blank(10); place(s, 3, 5);
  enemy(s, 'beetle', 3, 4, ST.AWAKE);
  const g = enemy(s, 'gnawer', 3, 3, ST.AWAKE);
  s.oil[idx(2, 4)] = 1; E._refresh(s);
  let r = act(s, mv(UP));
  ok(r.events.some(e => e.e === 'explode'), 'a dying beetle explodes');
  eq(r.state.p.flame, 8, 'the blast costs me 2 when I stand beside it');
  ok(!find(r.state, g.id), 'and kills the gnawer beside it');
  ok(r.state.fire[idx(2, 4)] > 0, 'and lights oil beside it');
  // chain reaction
  s = blank(10); place(s, 3, 7);
  enemy(s, 'beetle', 3, 3, ST.AWAKE); enemy(s, 'beetle', 3, 2, ST.AWAKE); enemy(s, 'beetle', 4, 2, ST.AWAKE);
  r = act(s, { t: 'flare', d: UP });
  eq(r.state.enemies.length, 0, 'beetles chain');
  eq(r.state.embers.reduce((a, b) => a + b, 0), 3, 'each drops its ember');
  sound(r.state, 'beetle chain');
}
{
  // the bone archer
  let s = blank(10); place(s, 3, 7);
  enemy(s, 'archer', 3, 2, ST.AWAKE);
  let r = act(s, WAIT);
  ok(r.events.some(e => e.e === 'attack' && e.how === 'arrow'), 'archer shoots along its column at range 5');
  eq(r.state.p.flame, 8, 'for 2');
  s = blank(10); place(s, 3, 8);
  enemy(s, 'archer', 3, 2, ST.AWAKE);
  r = act(s, WAIT);
  ok(!r.events.some(e => e.e === 'attack'), 'range 6 is out of reach');
  s = blank(10); place(s, 3, 7);
  enemy(s, 'archer', 3, 2, ST.AWAKE); wall(s, 3, 4);
  r = act(s, WAIT);
  ok(!r.events.some(e => e.e === 'attack'), 'a wall blocks the shot');
  s = blank(10); place(s, 4, 6);
  const a2 = enemy(s, 'archer', 2, 3, ST.AWAKE);
  r = act(s, WAIT);
  ok(!r.events.some(e => e.e === 'attack'), 'out of line, it does not shoot');
  const m = find(r.state, a2.id);
  ok(m.x !== 2 || m.y !== 3, 'it shuffles to line up instead');
  ok(E.patternTiles(r.state, m).length > 0, 'archer has a threat line');
}
{
  // oil
  let s = blank(10); place(s, 3, 7);
  s.oil[idx(3, 6)] = 1; s.oil[idx(4, 6)] = 1; s.oil[idx(5, 6)] = 1;
  const g = enemy(s, 'gnawer', 4, 6, ST.ASLEEP);
  s.p.cupped = true; E._refresh(s);
  eq(act(s, WAIT).state.fire.reduce((a, b) => a + b, 0), 0, 'oil is harmless until fire touches it');
  let r = act(s, { t: 'flare', d: UP });        // the spark crosses the oil at (3,6)
  ok(r.state.fire[idx(3, 6)] > 0, 'Flare sets oil alight');
  ok(r.state.fire[idx(4, 6)] > 0, 'fire spreads to touching oil on the tick');
  eq(r.state.fire[idx(5, 6)], 0, 'one tile per turn');
  ok(find(r.state, g.id), 'a tile that has only just caught does not burn its occupant yet');
  r = act(r.state, CUP); r = act(r.state, WAIT);
  ok(!find(r.state, g.id), 'the next tick burns whatever still stands in it');
  ok(r.state.fire[idx(5, 6)] > 0, 'and the fire moves on');
  let cur = r.state, turns = 0;
  while (cur.fire.some(f => f > 0) && turns++ < 10) cur = act(cur, WAIT).state;
  eq(cur.oil.reduce((x, y) => x + y, 0), 0, 'all the oil burns away');
  eq(cur.scorch[idx(3, 6)], 1, 'leaving scorch');
  // a single tile burns for exactly three ticks
  s = blank(10); place(s, 3, 7); s.oil[idx(3, 5)] = 1; E._refresh(s);
  cur = act(s, { t: 'flare', d: UP }).state;
  const timers = [cur.fire[idx(3, 5)]];
  for (let k = 0; k < 3; k++) { cur = act(cur, WAIT).state; timers.push(cur.fire[idx(3, 5)]); }
  eq(timers.join(','), '2,1,0,0', 'oil burns for three turns');
  // standing in it costs me 1 a turn
  s = blank(10); place(s, 3, 7); s.fire[idx(3, 6)] = 3; E._refresh(s);
  r = act(s, mv(UP));
  eq(r.state.p.flame, 9, 'burning oil costs 1 a turn');
  ok(r.state.hurts.some(h => h.by === 'fire'), 'and is logged as fire');
}
{
  // flare and the last flame
  let s = blank(1); place(s, 3, 7);
  let r = act(s, { t: 'flare', d: UP });
  eq(r.changed, false, 'I cannot spend my last flame on a Flare');
  s = blank(2); place(s, 3, 7);
  r = act(s, { t: 'flare', d: UP });
  eq(r.state.p.flame, 1, 'Flare costs 1');
  eq(r.turn, true, 'and takes the turn');
  // flare lights a brazier from range and uncups
  s = blank(5); place(s, 3, 7); brazier(s, 3, 4, false); s.p.cupped = true; E._refresh(s);
  r = act(s, { t: 'flare', d: UP });
  eq(r.state.braziers[0].lit, true, 'Flare lights a brazier from range');
  eq(r.state.stairs.open, true, 'which opens the stairs');
  eq(r.state.p.cupped, false, 'Flare uncups me');
  // range 4, first enemy only
  s = blank(5); place(s, 3, 8);
  const far = enemy(s, 'gnawer', 3, 3, ST.AWAKE);
  r = act(s, { t: 'flare', d: UP });
  ok(find(r.state, far.id), 'Flare does not reach 5 tiles');
  s = blank(5); place(s, 3, 8);
  enemy(s, 'ooze', 3, 6, ST.AWAKE); const behind = enemy(s, 'gnawer', 3, 5, ST.AWAKE);
  r = act(s, { t: 'flare', d: UP });
  ok(find(r.state, behind.id), 'Flare stops at the first enemy');
  s = blank(5); place(s, 3, 8); wall(s, 3, 7);
  r = act(s, { t: 'flare', d: UP });
  eq(r.changed, false, 'a Flare straight into a wall is refused and costs nothing');
}
{
  // dazzle
  let s = blank(10); place(s, 3, 6);
  enemy(s, 'gnawer', 3, 5, ST.AWAKE);
  let r = act(s, { t: 'spark' });
  eq(r.state.p.flame, 8, 'Dazzle costs 2');
  ok(!r.events.some(e => e.e === 'attack'), 'dazzled enemies lose the turn it is used');
  eq(E.threatMap(r.state)[idx(3, 6)], 0, 'no red tiles from a dazed enemy');
  r = act(r.state, WAIT);
  ok(!r.events.some(e => e.e === 'attack'), 'and the turn after');
  r = act(r.state, WAIT);
  ok(r.events.some(e => e.e === 'attack'), 'then they act again');
  s = blank(2); place(s, 3, 6); enemy(s, 'gnawer', 3, 5, ST.AWAKE);
  eq(act(s, { t: 'spark' }).changed, false, 'Dazzle is refused when it would take my last flame');
  s = blank(10); place(s, 3, 6); enemy(s, 'gnawer', 3, 5, ST.ASLEEP); enemy(s, 'gnawer', 3, 0, ST.AWAKE);
  r = act(s, { t: 'spark' });
  eq(r.changed, false, 'Dazzle is refused when nothing awake is in my light');
  ok(r.events.some(e => e.e === 'refuse' && e.why === 'noDazzle'), 'and says why');
  ok(!E.legalActions(s).some(a => a.t === 'spark'), 'and is not offered');
  s = blank(10); place(s, 3, 6); s.p.cupped = true; E._refresh(s); const dz = enemy(s, 'gnawer', 3, 4, ST.AWAKE);
  r = act(s, { t: 'spark' });
  eq(r.state.p.cupped, false, 'Dazzle uncups me');
  eq(find(r.state, dz.id).stun, 1, 'and reaches what my uncovered light reaches');
}
{
  // braziers and stairs
  let s = blank(6); place(s, 3, 6); brazier(s, 3, 5, false); brazier(s, 0, 0, false);
  eq(s.stairs.open, false, 'stairs are sealed while a brazier is cold');
  const g = enemy(s, 'gnawer', 5, 4);          // inside the first brazier's light once it is lit
  let r = act(s, mv(UP));
  eq(r.turn, true, 'lighting a brazier takes the turn');
  eq(r.state.p.flame, 6, 'and costs nothing');
  eq(r.state.braziers[0].lit, true, 'the brazier is lit');
  eq(r.state.stairs.open, false, 'one of two is not enough');
  eq(r.state.lit[idx(5, 4)], 1, 'a lit brazier casts radius 2');
  let c = E.clone(r.state); c.p.cupped = true; E._refresh(c);
  eq(c.lit[idx(5, 4)], 1, 'for good, whatever my own light does');
  r = act(act(c, WAIT).state, WAIT);
  eq(find(r.state, g.id).st, ST.AWAKE, 'brazier light wakes what sleeps nearby');
  eq(act(s, mv(UP)).state.p.x, 3, 'I do not move onto the brazier');
  // sealed stairs
  s = blank(6); brazier(s, 0, 4, false); place(s, 6, 1);
  r = act(s, mv(UP));
  eq(r.changed, false, 'sealed stairs cannot be entered');
  ok(r.events.some(e => e.e === 'bump' && e.what === 'sealed'), 'and say so');
  // open stairs lead down
  s = blank(6); place(s, 6, 1);
  r = act(s, mv(UP));
  eq(r.state.floor, 2, 'open stairs lead to the next floor');
  eq(r.state.p.flame, 6, 'flame carries over');
  eq(r.state.stats.floors, 1, 'floors cleared are counted');
  sound(r.state, 'descend');
  // the last floor ends the run
  s = blank(6); place(s, 6, 1); s.floor = C.CONFIG.run.floors;
  r = act(s, mv(UP));
  eq(r.state.mode, 'won', 'clearing the last floor ends the run');
  eq(E.legalActions(r.state).length, 0, 'and nothing more can be done');
  ok(E.score(r.state) >= C.CONFIG.score.win, 'with the bonus for getting there');
  ok(/bottom/.test(E.record(r.state)) && E.epitaph(r.state).length > 0, 'and a record of it');
  sound(r.state, 'the end of the run');
}
{
  // the burn
  let s = blank(10);
  let cur = s;
  for (let k = 0; k < 9; k++) cur = act(cur, WAIT).state;
  eq(cur.p.flame, 10, 'nine turns: no burn yet');
  eq(cur.p.burn, 1, 'the wick meter counts down');
  cur = act(cur, WAIT).state;
  eq(cur.p.flame, 9, 'the tenth turn burns 1 flame');
  eq(cur.p.burn, 10, 'and the wick meter resets');
  s = blank(1); s.p.burn = 1;
  const r = act(s, WAIT);
  eq(r.state.mode, 'dead', 'the burn can snuff me');
  eq(r.state.death.by, 'burn', 'and is named as the cause');
  eq(act(r.state, WAIT).changed, false, 'a dead Wick takes no more actions');
  sound(r.state, 'death');
}
{
  // altars
  const offers = [{ id: 'mirror', free: true }, { id: 'tongs', free: false }, { id: 'lastgasp', free: false }];
  let s = blank(3); place(s, 3, 6); altar(s, 3, 5, offers);
  enemy(s, 'gnawer', 3, 7, ST.AWAKE);
  let r = act(s, mv(UP));
  eq(r.state.mode, 'altar', 'moving into an altar opens it');
  eq(r.turn, false, 'looking takes no turn');
  eq(E.relicPrice(r.state, offers[0]), 0, 'one relic is free');
  eq(E.relicPrice(r.state, offers[1]), 2, 'uncommon relics cost 2');
  eq(E.relicPrice(r.state, offers[2]), 3, 'rare relics cost 3');
  eq(act(r.state, { t: 'take', i: 2 }).changed, false, 'I cannot pay 3 with 3 flame: never the last one');
  let t = act(r.state, { t: 'take', i: 1 });
  eq(t.state.p.flame, 1, 'paying 2 leaves 1');
  ok(t.state.relics.includes('tongs'), 'the relic is mine');
  eq(t.state.altars[0].used, true, 'the altar is spent');
  eq(t.state.mode, 'play', 'and play resumes');
  eq(t.turn, false, 'taking takes no turn');
  eq(act(t.state, mv(UP)).changed, false, 'a spent altar does nothing');
  t = act(r.state, { t: 'leave' });
  eq(t.state.mode, 'play', 'I can walk away');
  eq(t.state.altars[0].used, false, 'and come back later');
  t = act(r.state, { t: 'take', i: 0 });
  eq(E.openRadius(t.state), 3, 'Mirror Shard: +1 light radius');
  sound(t.state, 'altar');
}
{
  // relics
  let s = blank(10); place(s, 3, 5); give(s, 'sunstone');
  let o = enemy(s, 'ooze', 3, 4, ST.AWAKE);
  eq(E.strikeInfo(s, o).dmg, 2, 'Sunstone: +1 at max flame');
  s.p.flame = 9; eq(E.strikeInfo(s, o).dmg, 1, 'Sunstone: nothing below max');

  s = blank(5); place(s, 3, 5); give(s, 'smoulder');
  o = enemy(s, 'ooze', 3, 4, ST.AWAKE);
  eq(E.strikeInfo(s, o).dmg, 2, 'Smoulder: +1 at half flame or less');
  s.p.flame = 6; eq(E.strikeInfo(s, o).dmg, 1, 'Smoulder: nothing above half');
  s.p.flame = 5; o.st = ST.ASLEEP; eq(E.strikeInfo(s, o).dmg, 3, 'bonuses add after the sneak doubling');

  s = blank(10); give(s, 'hooded'); s.p.cupped = true; E._refresh(s);
  let cur = s; for (let k = 0; k < 25; k++) cur = act(cur, WAIT).state;
  eq(cur.p.flame, 10, 'Hooded Wick: no burn while cupped');
  cur = act(cur, CUP).state; for (let k = 0; k < 10; k++) cur = act(cur, WAIT).state;
  eq(cur.p.flame, 9, 'Hooded Wick: burn resumes uncupped');

  s = blank(10); give(s, 'slowburn');
  cur = s; for (let k = 0; k < 25; k++) cur = act(cur, WAIT).state;
  eq(cur.p.flame, 10, 'Slow Burn: waiting does not advance the burn');
  cur = s; for (let k = 0; k < 5; k++) { cur = act(cur, mv(LEFT)).state; cur = act(cur, mv(RIGHT)).state; }
  eq(cur.p.flame, 9, 'Slow Burn: moving still does');

  s = blank(2); place(s, 3, 6); give(s, 'lastgasp');
  enemy(s, 'archer', 3, 2, ST.AWAKE); const gg = enemy(s, 'gnawer', 3, 5, ST.AWAKE);
  let r = act(s, WAIT);
  eq(r.state.p.flame, 1, 'Last Gasp: a snuffing hit leaves 1 flame');
  eq(r.state.mode, 'play', 'Last Gasp: and I live');
  eq(find(r.state, gg.id).stun, 1, 'Last Gasp: enemies beside me are stunned');
  r = act(r.state, WAIT);
  eq(r.state.mode, 'dead', 'Last Gasp: only once per floor');

  s = blank(4); place(s, 3, 5); give(s, 'jar'); s.embers[idx(3, 4)] = 3; E._refresh(s);
  r = act(s, mv(UP));
  eq(r.state.p.flame, 8, 'Ember Jar: the third ember is worth 2');

  s = blank(4); place(s, 3, 5); give(s, 'greedy'); s.embers[idx(3, 3)] = 1; s.embers[idx(5, 5)] = 1; s.embers[idx(6, 5)] = 1; E._refresh(s);
  r = act(s, WAIT);
  eq(r.state.p.flame, 6, 'Greedy Wick: embers within 2 steps fly to me');
  eq(r.state.embers[idx(6, 5)], 1, 'Greedy Wick: 3 steps is too far');

  s = blank(4); place(s, 3, 6); give(s, 'tongs'); brazier(s, 3, 5, false);
  r = act(s, mv(UP));
  eq(r.state.p.flame, 6, "Firekeeper's Tongs: +2 flame for lighting a brazier");

  s = blank(10); place(s, 3, 6); give(s, 'hearth'); brazier(s, 3, 5, true);
  o = enemy(s, 'ooze', 2, 6, ST.AWAKE);
  eq(E.strikeInfo(s, o).dmg, 2, "Hearthstone: +1 strike in a brazier's light");
  s.enemies = []; cur = s; for (let k = 0; k < 25; k++) cur = act(cur, WAIT).state;
  eq(cur.p.flame, 10, "Hearthstone: no burn in a brazier's light");

  s = blank(10); place(s, 3, 7); give(s, 'tinderbox');
  enemy(s, 'gnawer', 3, 5, ST.AWAKE);
  r = act(s, { t: 'flare', d: UP });
  eq(r.state.embers[idx(3, 5)], 2, 'Tinderbox: fire kills drop an extra ember');

  s = blank(10); place(s, 3, 5); give(s, 'waxseal');
  enemy(s, 'beetle', 3, 4, ST.AWAKE); s.fire[idx(3, 5)] = 3; E._refresh(s);
  r = act(s, mv(UP));
  eq(r.state.p.flame, 10, "Wax Seal: fire and explosions don't hurt me");

  s = blank(4); place(s, 3, 6); give(s, 'beacon');
  const sl = enemy(s, 'gnawer', 3, 5);
  r = act(act(s, WAIT).state, WAIT);
  eq(find(r.state, sl.id).st, ST.AWAKE, 'Beacon Oil: it still wakes');
  eq(find(r.state, sl.id).stun, 1, 'Beacon Oil: but loses its first turn');
  r = act(r.state, WAIT);
  ok(!r.events.some(e => e.e === 'attack'), 'Beacon Oil: no attack on that turn');
}
{
  // chests
  let s = blank(5); place(s, 3, 6); chest(s, 3, 5);
  let r = act(s, mv(UP));
  eq(r.state.p.flame, 8, 'a chest gives +3 flame');
  eq(r.turn, true, 'opening it takes the turn');
  eq(r.state.tiles[idx(3, 5)], T.FLOOR, 'and leaves bare floor');
  eq(r.state.p.y, 6, 'I do not move onto it');
  s = blank(9); place(s, 3, 6); chest(s, 3, 5);
  r = act(s, mv(UP));
  eq(r.state.p.flame, 10, 'at 9 of 10 a chest tops me up');
  eq(r.state.embers[idx(3, 5)], 2, 'and the rest spills as embers');
  sound(r.state, 'chest');
  // an unseen chest in the dark gives nothing away
  s = blank(5); place(s, 3, 8); chest(s, 3, 2); chest(s, 3, 6);
  eq(E.inspect(s, 3, 2).kind, 'floor', 'an unseen chest looks like floor');
  eq(E.inspect(s, 3, 6).kind, 'chest', 'a lit chest is a chest');
  eq(E.flarePath(s, UP, true).tiles.length, 1, 'the aiming line stops at a chest I can see');
  let c = act(s, CUP).state;
  eq(E.inspect(c, 3, 6).kind, 'chest', 'a chest I have seen is remembered');
  ok(E.pathTo(s, 3, 2) !== null, 'I can plan a walk onto a tile hiding an unseen chest');
  // arrows pass over chests, so opening one can never expose me to a shot no red tile warned of
  s = blank(5); place(s, 4, 6); chest(s, 3, 6);
  const a = enemy(s, 'archer', 0, 6, ST.AWAKE);
  ok(E.patternTiles(s, a).indexOf(idx(4, 6)) >= 0, 'arrows pass over a chest');
  ok(E.patternTiles(s, a).indexOf(idx(3, 6)) < 0, 'but the chest tile itself is not a threat tile');
  eq(E.threatMap(s, true)[idx(4, 6)], 2, 'so the tile behind a chest is a threat tile');
  s = blank(5); place(s, 2, 1); brazier(s, 1, 0, true); s.tiles[idx(6, 0)] = T.FLOOR; s.tiles[idx(3, 0)] = T.STAIRS; s.stairs = { x: 3, y: 0, open: true };
  const a2 = enemy(s, 'archer', 5, 0, ST.AWAKE);
  ok(E.patternTiles(s, a2).indexOf(idx(2, 0)) >= 0, 'arrows pass over the stair, sealed or open');
  ok(E.patternTiles(s, a2).indexOf(idx(3, 0)) < 0, 'and the stair is never a threat tile: I cannot stand on it');
}
{
  // what I can see
  let s = blank(4); place(s, 3, 7);
  const near = enemy(s, 'gnawer', 3, 5), far = enemy(s, 'gnawer', 3, 1), awake = enemy(s, 'gnawer', 0, 0, ST.AWAKE);
  eq(E.enemyView(s, near), 'lit', 'enemies in the light are drawn');
  eq(E.enemyView(s, far), 'hidden', 'sleepers in the dark are hidden');
  eq(E.enemyView(s, awake), 'eyes', 'awake enemies in the dark are eyes');
  let c = act(s, CUP).state;
  eq(E.enemyView(c, find(c, near.id)), 'memory', 'a sleeper I have seen stays as a memory');
  eq(E.threatMap(s).reduce((a, b) => a + b, 0), 0, 'eyes in the dark show no red tiles');
  ok(E.threatMap(s, true).reduce((a, b) => a + b, 0) > 0, 'though the threat is real');
  eq(E.inspect(s, 0, 0).kind, 'eyes', 'inspecting eyes gives nothing away');
  eq(E.inspect(s, 3, 1).kind, 'floor', 'inspecting a hidden sleeper gives nothing away');
  s.embers[idx(3, 0)] = 2; E._refresh(s);
  ok(!/ember/i.test(E.inspect(s, 3, 0).title), 'inspecting an unseen ember gives nothing away');
  // a kill made in the dark, right beside me, still leaves an ember I know about
  s = blank(6); place(s, 3, 5); s.p.cupped = true; E._refresh(s);
  enemy(s, 'gnawer', 3, 4);
  c = act(s, mv(UP)).state;
  eq(c.lit[idx(3, 4)], 0, 'cupped: the tile beside me is dark');
  eq(c.memE[idx(3, 4)], 1, 'but I remember the ember my own kill dropped there');
  ok(/mber/.test(E.inspect(c, 3, 4).title), 'and it shows on inspection');
  // ember memory is a snapshot
  s = blank(4); place(s, 3, 7); s.embers[idx(3, 6)] = 1; E._refresh(s);
  c = act(s, CUP).state;
  eq(c.memE[idx(3, 6)], 1, 'a seen ember is remembered');
}
{
  // auto-walk routes
  let s = blank(10); place(s, 0, 8); wall(s, 1, 8); wall(s, 1, 7); wall(s, 1, 6);
  let p = E.pathTo(s, 2, 8);
  ok(p && p.length === 8, 'pathTo routes around walls');
  brazier(s, 4, 4, false);
  p = E.pathTo(s, 4, 4);
  let cur = s; for (const d of p) cur = act(cur, mv(d)).state;
  eq(cur.braziers[0].lit, true, 'a route to a cold brazier ends by lighting it');
  eq(E.pathTo(cur, 4, 4), null, 'no route to a lit brazier');
  eq(E.pathTo(s, 1, 7), null, 'no route into a wall');
}

// ==============================================================================================
section('2. Floors: every generated floor is completable');
// ==============================================================================================
{
  const perDepth = QUICK ? 300 : 4000, depths = 12;
  let total = 0, plain = 0, bad = 0, wallSum = 0, enemySum = 0, chestSum = 0;
  const brazierWant = f => (f >= 8 ? 3 : f >= 3 ? 2 : 1);
  const t0 = Date.now();
  // An independent check: flood fill from the start over floor tiles only, written here rather than
  // borrowed from the generator.
  function completable(s) {
    const seen = zeros(), q = [idx(s.p.x, s.p.y)];
    seen[q[0]] = 1;
    for (let h = 0; h < q.length; h++) {
      const x = xOf(q[h]), y = yOf(q[h]);
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = idx(nx, ny);
        if (!seen[n] && s.tiles[n] === T.FLOOR) { seen[n] = 1; q.push(n); }
      }
    }
    const beside = (x, y) => [[0, -1], [1, 0], [0, 1], [-1, 0]].some(([dx, dy]) => {
      const nx = x + dx, ny = y + dy;
      return nx >= 0 && ny >= 0 && nx < W && ny < H && seen[idx(nx, ny)];
    });
    if (!beside(s.stairs.x, s.stairs.y)) return 'stairs';
    for (let i = 0; i < N; i++) if (s.tiles[i] === T.CHEST && !beside(xOf(i), yOf(i))) return 'chest';
    for (const b of s.braziers) if (!beside(b.x, b.y)) return 'brazier';
    for (const a of s.altars) if (!beside(a.x, a.y)) return 'altar';
    for (const e of s.enemies) if (!seen[idx(e.x, e.y)]) return 'enemy';
    for (let i = 0; i < N; i++) if (s.tiles[i] === T.FLOOR && !seen[i]) return 'pocket';
    return '';
  }
  for (let depth = 1; depth <= depths; depth++) {
    for (let k = 0; k < perDepth; k++) {
      const s = E.newRun({ seed: E.hash32(depth * 100003 + k, 99), wick: 1 });
      // jump to the wanted depth by re-entering floors with the same machinery the game uses
      let cur = s;
      if (depth > 1) {
        cur = E.clone(s);
        cur.floor = depth - 1;
        cur.braziers.forEach(b => (b.lit = true)); cur.stairs.open = true; cur.enemies = [];
        cur.p.x = cur.stairs.x; cur.p.y = cur.stairs.y + 1;
        if (cur.tiles[idx(cur.p.x, cur.p.y)] !== T.FLOOR) { cur.tiles[idx(cur.p.x, cur.p.y)] = T.FLOOR; cur.oil[idx(cur.p.x, cur.p.y)] = 0; }
        E._refresh(cur);
        cur = E.step(cur, mv(UP)).state;
      }
      total++;
      if (cur.floor !== depth) { bad++; fails.push('could not reach depth ' + depth); continue; }
      if (cur.plain) plain++;
      const why = completable(cur);
      if (why) { bad++; if (fails.length < 40) fails.push('floor not completable (' + why + ') depth ' + depth + ' seed ' + cur.seed); }
      const probs = E.problems(cur);
      if (probs.length) { bad++; if (fails.length < 40) fails.push('invalid floor: ' + probs[0]); }
      if (cur.braziers.length !== brazierWant(depth)) { bad++; if (fails.length < 40) fails.push('brazier count ' + cur.braziers.length + ' at depth ' + depth); }
      if (cur.p.y !== H - 1 || cur.stairs.y !== 0) { bad++; if (fails.length < 40) fails.push('start or stairs misplaced'); }
      if (cur.altars.length !== 1) { bad++; if (fails.length < 40) fails.push('altar count ' + cur.altars.length); }
      for (const e of cur.enemies) {
        if (Math.abs(e.x - cur.p.x) + Math.abs(e.y - cur.p.y) <= 3) { bad++; if (fails.length < 40) fails.push('enemy within 3 steps of the start'); break; }
        if (e.st !== ST.ASLEEP) { bad++; break; }
      }
      const nChests = cur.tiles.filter(t => t === T.CHEST).length;
      if (nChests > 2) { bad++; if (fails.length < 40) fails.push('more than two chests'); }
      wallSum += cur.tiles.filter(t => t === T.WALL).length;
      enemySum += cur.enemies.length;
      chestSum += nChests;
    }
  }
  ok(bad === 0, total + ' floors: ' + bad + ' failed');
  ok(plain === 0, 'fallback room used ' + plain + ' times');
  console.log('   ' + total + ' floors across depths 1-' + depths + ' in ' + (Date.now() - t0) + ' ms; ' +
    'avg walls ' + (wallSum / total).toFixed(1) + ', enemies ' + (enemySum / total).toFixed(1) + ', chests ' + (chestSum / total).toFixed(2) + ', fallback rooms ' + plain);
}

// ==============================================================================================
section('3. Random runs: no exceptions, no invalid states, every run ends');
// ==============================================================================================
let fairChecks = 0, fairBad = 0;
{
  const runs = QUICK ? 150 : 1500, cap = 6000;
  let ended = 0, steps = 0, threw = 0, invalid = 0, deepest = 0, unchangedLegal = 0;
  const deaths = {};
  const t0 = Date.now();
  for (let k = 0; k < runs; k++) {
    let s = E.newRun({ seed: E.hash32(k, 4242), wick: k + 1 });
    const r = { rng: E.hash32(k, 77) };     // the test's own input stream
    const pick = n => { r.rng = (r.rng + 0x6D2B79F5) >>> 0; let t = r.rng; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) % n; };
    try {
      let n = 0;
      while (s.mode !== 'dead' && s.mode !== 'won' && n++ < cap) {
        const legal = E.legalActions(s);
        // lean towards moving so runs get somewhere; sometimes throw nonsense at it too
        let a;
        const roll = pick(100);
        if (roll < 3) a = [{ t: 'move', d: 9 }, { t: 'take', i: 7 }, { t: 'nonsense' }, null, { t: 'flare' }][pick(5)];
        else {
          const moves = legal.filter(x => x.t === 'move');
          a = (roll < 70 && moves.length) ? moves[pick(moves.length)] : legal[pick(legal.length)];
        }
        const before = JSON.stringify(s);
        const th = E.threatMap(s);
        const was = {};
        for (const e of s.enemies) was[e.id] = { lit: !!s.lit[idx(e.x, e.y)], st: e.st, tiles: E.patternTiles(s, e) };
        const res = E.step(s, a);
        steps++;
        if (JSON.stringify(s) !== before) { invalid++; fails.push('step() changed its input'); break; }
        if (a && roll >= 3 && !res.changed) unchangedLegal++;
        // fairness: a lit, awake enemy only ever hits a tile that was red before my move
        if (res.turn) {
          const me = idx(res.state.p.x, res.state.p.y);
          const floorChanged = res.state.floor !== s.floor;
          for (const e of res.events) {
            if (e.e !== 'attack' || floorChanged) continue;
            const w = was[e.id];
            if (!w || !w.lit || w.st !== ST.AWAKE) continue;
            fairChecks++;
            if (w.tiles.indexOf(me) < 0 || th[me] <= 0) { fairBad++; if (fails.length < 40) fails.push('unfair hit by ' + e.t + ' seed ' + s.seed + ' turn ' + s.turn); }
          }
        }
        s = res.state;
        const probs = E.problems(s);
        if (probs.length) { invalid++; if (fails.length < 40) fails.push('invalid state: ' + probs[0] + ' (seed ' + s.seed + ', turn ' + s.turn + ')'); break; }
      }
      if (s.mode === 'dead' || s.mode === 'won') { ended++; const key = s.mode === 'won' ? 'won' : s.death.by; deaths[key] = (deaths[key] || 0) + 1; }
      deepest = Math.max(deepest, s.floor);
    } catch (err) {
      threw++; if (fails.length < 40) fails.push('exception: ' + err.stack.split('\n').slice(0, 3).join(' | '));
    }
  }
  ok(threw === 0, 'exceptions: ' + threw);
  ok(invalid === 0, 'invalid states: ' + invalid);
  ok(ended === runs, ended + ' of ' + runs + ' runs ended');
  ok(unchangedLegal === 0, 'legalActions offered ' + unchangedLegal + ' actions that did nothing');
  console.log('   ' + runs + ' runs, ' + steps + ' steps in ' + (Date.now() - t0) + ' ms; deepest floor ' + deepest + '; endings ' + JSON.stringify(deaths));
}

// ==============================================================================================
section('3b. Bot runs: the same checks on runs that get deep, pick up relics and reach the end');
// ==============================================================================================
{
  const B = require('./bot.js');
  const runs = QUICK ? 24 : 240, strats = ['bright', 'stealth', 'dark', 'strobe'];
  let ended = 0, threw = 0, invalid = 0, wins = 0, deepest = 0, steps = 0;
  const relicsSeen = new Set();
  const t0 = Date.now();
  for (let k = 0; k < runs; k++) {
    let s = E.newRun({ seed: E.hash32(k, 90210), wick: k + 1 });
    const strat = strats[k % strats.length], mem = { turns: 0, idle: 0 };
    const r = { rng: E.hash32(k, 5) };
    const pick = n => { r.rng = (r.rng + 0x6D2B79F5) >>> 0; let t = r.rng; t = Math.imul(t ^ (t >>> 15), t | 1); return ((t ^ (t >>> 14)) >>> 0) % n; };
    try {
      let n = 0;
      while ((s.mode === 'play' || s.mode === 'altar') && n++ < 20000) {
        const legal = E.legalActions(s);
        // mostly the bot, sometimes a random legal action, and it buys a relic now and then
        let a = pick(100) < 6 ? legal[pick(legal.length)] : B.decide(s, strat, mem);
        if (s.mode === 'altar' && pick(3) === 0) { const takes = legal.filter(x => x.t === 'take'); a = takes[pick(takes.length)]; }
        const th = E.threatMap(s), was = {};
        for (const e of s.enemies) was[e.id] = { lit: !!s.lit[idx(e.x, e.y)], st: e.st, tiles: E.patternTiles(s, e) };
        let res = E.step(s, a);
        if (!res.changed) res = E.step(s, WAIT);
        steps++;
        if (res.turn && res.state.floor === s.floor) {
          const me = idx(res.state.p.x, res.state.p.y);
          for (const e of res.events) {
            if (e.e !== 'attack') continue;
            const w = was[e.id];
            if (!w || !w.lit || w.st !== ST.AWAKE) continue;
            fairChecks++;
            if (w.tiles.indexOf(me) < 0 || th[me] <= 0) { fairBad++; if (fails.length < 40) fails.push('unfair hit by ' + e.t + ' (bot run) seed ' + s.seed + ' turn ' + s.turn); }
          }
        }
        if (res.turn) {
          mem.turns++;
          const q = res.state;
          mem.idle = (q.floor !== s.floor || q.stats.kills !== s.stats.kills || q.stats.braziers !== s.stats.braziers || q.relics.length !== s.relics.length || q.stats.embers !== s.stats.embers || q.stats.chests !== s.stats.chests) ? 0 : mem.idle + 1;
          if (mem.idle > 300 && (res.state.mode === 'play' || res.state.mode === 'altar')) res = E.step(res.state, { t: 'abandon' });
        }
        s = res.state;
        const probs = E.problems(s);
        if (probs.length) { invalid++; if (fails.length < 40) fails.push('invalid state in a bot run: ' + probs[0] + ' (seed ' + s.seed + ', turn ' + s.turn + ')'); break; }
      }
      if (s.mode === 'dead' || s.mode === 'won') ended++;
      if (s.mode === 'won') { wins++; if (E.score(s) <= 0 || !E.epitaph(s) || !E.record(s)) invalid++; }
      else if (s.mode === 'dead' && (!E.epitaph(s) || !E.record(s))) invalid++;
      deepest = Math.max(deepest, s.floor);
      s.relics.forEach(id => relicsSeen.add(id));
    } catch (err) {
      threw++; if (fails.length < 40) fails.push('exception in a bot run: ' + err.stack.split('\n').slice(0, 3).join(' | '));
    }
  }
  ok(threw === 0, 'exceptions: ' + threw);
  ok(invalid === 0, 'invalid states: ' + invalid);
  ok(ended === runs, ended + ' of ' + runs + ' bot runs ended');
  ok(deepest >= (QUICK ? 6 : 12), 'bot runs got deep (deepest floor ' + deepest + ')');
  if (!QUICK) ok(wins > 0, 'at least one bot run cleared the last floor (' + wins + ')');
  if (!QUICK) eq(relicsSeen.size, Object.keys(C.RELICS).length, 'every relic was held in some run');
  console.log('   ' + runs + ' runs, ' + steps + ' steps in ' + (Date.now() - t0) + ' ms; deepest floor ' + deepest + '; ' + wins + ' cleared all ' + C.CONFIG.run.floors + ' floors; ' + relicsSeen.size + ' different relics held');
}

// ==============================================================================================
section('4. Determinism, purity, save and resume');
// ==============================================================================================
{
  const runs = QUICK ? 40 : 300;
  let same = 0, resumed = 0, floorsSame = 0;
  for (let k = 0; k < runs; k++) {
    const seed = E.hash32(k, 31337);
    // record a run
    let s = E.newRun({ seed: seed, wick: 5 });
    const r = { rng: seed };
    const pick = n => { r.rng = (r.rng + 0x6D2B79F5) >>> 0; let t = r.rng; t = Math.imul(t ^ (t >>> 15), t | 1); return ((t ^ (t >>> 14)) >>> 0) % n; };
    const inputs = [];
    let n = 0;
    while (s.mode !== 'dead' && s.mode !== 'won' && n++ < 4000) {
      const legal = E.legalActions(s);
      const moves = legal.filter(x => x.t === 'move');
      const a = (pick(100) < 70 && moves.length) ? moves[pick(moves.length)] : legal[pick(legal.length)];
      inputs.push(a);
      s = E.step(s, a).state;
    }
    const final = JSON.stringify(s);
    // replay it
    let b = E.newRun({ seed: seed, wick: 5 });
    for (const a of inputs) b = E.step(b, a).state;
    if (JSON.stringify(b) === final) same++;
    // replay it with a save and reload in the middle (through text, as the app does)
    let c = E.newRun({ seed: seed, wick: 5 });
    const cut = Math.floor(inputs.length / 2);
    for (let i = 0; i < cut; i++) c = E.step(c, inputs[i]).state;
    c = JSON.parse(JSON.stringify({ v: 1, state: c })).state;
    for (let i = cut; i < inputs.length; i++) c = E.step(c, inputs[i]).state;
    if (JSON.stringify(c) === final) resumed++;
    // the first floor depends on the seed alone
    if (JSON.stringify(E.newRun({ seed: seed, wick: 1 }).tiles) === JSON.stringify(E.newRun({ seed: seed, wick: 2 }).tiles)) floorsSame++;
  }
  eq(same, runs, 'replays that match the original run');
  eq(resumed, runs, 'runs that match after a mid-run save and reload');
  eq(floorsSame, runs, 'same seed gives the same first floor');
  ok(JSON.stringify(E.newRun({ seed: 1 }).tiles) !== JSON.stringify(E.newRun({ seed: 2 }).tiles), 'different seeds give different floors');
  // purity: a deep-frozen state survives every kind of action
  const freeze = o => { Object.freeze(o); for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object' && !Object.isFrozen(o[k])) freeze(o[k]); return o; };
  const fz = freeze(E.newRun({ seed: 9 }));
  let threw = false;
  try { for (const a of [WAIT, CUP, mv(0), mv(1), mv(2), mv(3), { t: 'flare', d: 0 }, { t: 'spark' }, { t: 'abandon' }]) E.step(fz, a); } catch (e) { threw = true; }
  ok(!threw, 'step() never writes to the state it was given');
  console.log('   ' + runs + ' recorded runs replayed and resumed');
}

// ==============================================================================================
section('5. Fairness: hits from lit, awake enemies always landed on red tiles');
// ==============================================================================================
{
  ok(fairChecks > (QUICK ? 50 : 500), 'enough hits were checked (' + fairChecks + ')');
  eq(fairBad, 0, 'hits that landed outside the drawn threat tiles');
  console.log('   ' + fairChecks + ' hits checked');
}

// ==============================================================================================
section('6. Files');
// ==============================================================================================
{
  const root = path.join(__dirname, '..');
  const read = f => fs.readFileSync(path.join(root, f), 'utf8');
  const exists = f => fs.existsSync(path.join(root, f));
  if (exists('version.json')) {
    eq(JSON.parse(read('version.json')).version, C.VERSION, 'version.json matches the build');
  } else ok(false, 'version.json exists');
  if (exists('manifest.webmanifest')) {
    const m = JSON.parse(read('manifest.webmanifest'));
    eq(m.display, 'standalone', 'manifest: standalone');
    eq(m.orientation, 'portrait', 'manifest: portrait');
    ok(/^#000(000)?$/.test(m.theme_color) && /^#000(000)?$/.test(m.background_color), 'manifest: black theme and background');
    ok(!/^(\/|https?:)/.test(m.start_url) && !/^(\/|https?:)/.test(m.scope), 'manifest: start_url and scope are relative');
    for (const ic of m.icons) {
      ok(!/^(\/|https?:)/.test(ic.src), 'manifest: icon ' + ic.src + ' is relative');
      ok(exists(ic.src), 'manifest: icon ' + ic.src + ' exists');
    }
    ok(m.icons.some(i => i.sizes === '192x192') && m.icons.some(i => i.sizes === '512x512') && m.icons.some(i => /maskable/.test(i.purpose || '')), 'manifest: 192, 512 and maskable icons');
  } else ok(false, 'manifest.webmanifest exists');
  if (exists('index.html')) {
    const html = read('index.html');
    const urls = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/g)].map(m => m[1]);
    for (const u of urls) {
      ok(!/^(\/|https?:|\/\/)/.test(u), 'index.html: "' + u + '" is a relative URL');
      const file = u.split('?')[0];
      if (file && !file.startsWith('#')) ok(exists(file), 'index.html: ' + file + ' exists');
    }
    ok(html.includes('?v=' + C.VERSION), 'index.html script URLs carry the build version');
    ok(!html.includes('?v=') || html.split('?v=').slice(1).every(x => x.startsWith(C.VERSION + '"')), 'index.html: every ?v= is the current version');
  } else ok(false, 'index.html exists');
  const code = f => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['engine.js', 'config.js']) ok(!/\b(document|window|localStorage|Math\.random|Date\.now|setTimeout)\b/.test(code(f)), f + ' touches no DOM, clock or Math.random');
  for (const f of ['index.html', 'render.js', 'ui.js', 'engine.js', 'config.js']) {
    if (!exists(f)) { ok(false, f + ' exists'); continue; }
    ok(!/https?:\/\//.test(read(f).replace(/http:\/\/www\.w3\.org\/[^"' ]*/g, '')), f + ' makes no reference to any outside host');
  }
  ok(exists('.nojekyll'), '.nojekyll exists');
}

// ==============================================================================================
console.log('\n' + (failed ? 'FAILED' : 'PASSED') + ': ' + passed + ' checks passed, ' + failed + ' failed');
if (fails.length) console.log(fails.map(f => '  - ' + f).join('\n'));
process.exit(failed ? 1 : 0);
