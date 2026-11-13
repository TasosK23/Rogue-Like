/* Wickbound: headless-browser check.   Run with:  node tests/browser.js [outDir]
 *
 * Needs Playwright with Chromium (not part of the game; set PLAYWRIGHT to its folder if it is not on NODE_PATH).
 * It serves the game from a sub-path, the way GitHub Pages does, opens it at a phone-sized portrait
 * viewport with touch, plays through every screen using real touch events, and saves a screenshot of each.
 * It fails on any console error, any request that leaves the local server, and any element that
 * spills outside the viewport.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
let chromium;
try { chromium = require(process.env.PLAYWRIGHT || 'playwright').chromium; }
catch (e) { console.error('Playwright was not found. Install it (npm i playwright) or set PLAYWRIGHT to its folder.'); process.exit(2); }

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(require('os').tmpdir(), 'wickbound-shots');
const PREFIX = '/Rogue-Like/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const VIEW = { width: 384, height: 832 }, DPR = 2.8125;       // a Galaxy S24+ in portrait

const problems = [];
const note = m => { problems.push(m); console.log('  PROBLEM: ' + m); };

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      if (!url.startsWith(PREFIX)) { res.writeHead(404); res.end('outside the sub-path'); note('request outside the sub-path: ' + url); return; }
      const rel = url.slice(PREFIX.length) || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); if (!/favicon/.test(rel)) note('404 for ' + rel); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port + PREFIX;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: DPR, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') note('console error: ' + m.text()); });
  page.on('pageerror', e => note('page error: ' + e.message));
  page.on('request', r => { if (!r.url().startsWith(base) && !r.url().startsWith('data:')) note('request left the server: ' + r.url()); });
  const cdp = await ctx.newCDPSession(page);
  const shot = async name => { await page.waitForTimeout(350); await page.screenshot({ path: path.join(OUT, name + '.png') }); console.log('  shot ' + name); };
  const touch = async (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type: type, touchPoints: type === 'touchEnd' ? [] : [{ x: x, y: y }] });
  const tap = async (x, y) => { await touch('touchStart', x, y); await page.waitForTimeout(40); await touch('touchEnd', x, y); await page.waitForTimeout(60); };
  const swipe = async (x, y, dx, dy) => { await touch('touchStart', x, y); for (let k = 1; k <= 4; k++) { await touch('touchMove', x + dx * k / 4, y + dy * k / 4); await page.waitForTimeout(8); } await touch('touchEnd', x + dx, y + dy); await page.waitForTimeout(230); };
  const center = async sel => { const b = await page.locator(sel).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const tapOn = async sel => { const c = await center(sel); await tap(c.x, c.y); };
  const tileXY = async (tx, ty) => { const b = await page.locator('#board').boundingBox(); return { x: b.x + (tx + 0.5) * b.width / 7, y: b.y + (ty + 0.5) * b.height / 9 }; };
  const game = fn => page.evaluate(fn);
  // Everything visible must sit inside the viewport, and no text may be cut off by its own box.
  const checkLayout = async label => {
    const bad = await page.evaluate(() => {
      const out = [], W = innerWidth, H = innerHeight;
      for (const el of document.querySelectorAll('#app *')) {
        if (!el.offsetParent && el.tagName !== 'CANVAS') continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const name = el.id || el.className || el.tagName;
        const cut = el.children.length === 0 && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2 && cs.overflowX !== 'hidden';
        if (cut) out.push('text wider than its box: ' + name);
        if (el.closest('.sheet') || el.closest('#summary')) continue;      // these scroll
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) out.push('outside the viewport: ' + name + ' ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
      // the four action buttons must be big enough for a thumb
      for (const b of document.querySelectorAll('.act')) { const r = b.getBoundingClientRect(); if (r.width > 0 && (r.width < 56 || r.height < 56)) out.push('action button smaller than 56 px: ' + b.id + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
      return out;
    });
    for (const b of bad) note(label + ': ' + b);
  };

  console.log('Loading ' + base);
  await page.goto(base);
  await page.waitForFunction(() => window.Wickbound && window.Wickbound.screen === 'title');
  await checkLayout('title'); await shot('01-title');
  const man = await page.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
  if (man.name !== 'Wickbound') note('manifest did not load from the sub-path');

  // One tap from the title to a move.
  await tapOn('#btn-descend');
  await page.waitForFunction(() => window.Wickbound.screen === 'run');
  await checkLayout('run'); await shot('02-run-start');
  const before = await game(() => ({ x: Wickbound.state.p.x, y: Wickbound.state.p.y, turn: Wickbound.state.turn }));
  const mid = await tileXY(3, 4);
  await swipe(mid.x, mid.y, 0, -60);
  const after = await game(() => ({ x: Wickbound.state.p.x, y: Wickbound.state.p.y, turn: Wickbound.state.turn }));
  if (!(after.turn === before.turn + 1 && after.y === before.y - 1)) note('a swipe up did not move the Wick up one tile: ' + JSON.stringify([before, after]));
  // a swipe that starts on a button still moves, and does not press the button
  const cupBtn = await center('#btn-cup');
  await swipe(cupBtn.x, cupBtn.y, 60, 0);        // the tiles around the start are always clear
  const s2 = await game(() => ({ x: Wickbound.state.p.x, cupped: Wickbound.state.p.cupped, turn: Wickbound.state.turn }));
  if (s2.cupped) note('a swipe starting on the Cup button pressed it');
  if (s2.turn !== after.turn + 1) note('a swipe starting on a button did not act');
  // tap own tile waits; tap the Cup button cups (free)
  const me = await game(() => ({ x: Wickbound.state.p.x, y: Wickbound.state.p.y }));
  const myXY = await tileXY(me.x, me.y);
  await tap(myXY.x, myXY.y); await page.waitForTimeout(220);
  if ((await game(() => Wickbound.state.turn)) !== s2.turn + 1) note('tapping my own tile did not wait');
  await tapOn('#btn-cup'); await page.waitForTimeout(260);
  if (!(await game(() => Wickbound.state.p.cupped))) note('tapping Cup did not cup');
  if ((await game(() => Wickbound.state.turn)) !== s2.turn + 1) note('cupping took a turn');
  await shot('03-cupped');
  await tapOn('#btn-cup'); await page.waitForTimeout(200);

  // A staged board: every kind of thing on screen at once, with enemies awake so the red tiles show.
  await game(() => {
    const E = WickEngine, C = WICK_CONFIG;
    const s = E.newRun({ seed: 20261113, wick: 14 });
    s.tiles = new Array(63).fill(0);
    for (const k of ['oil', 'fire', 'scorch', 'embers', 'memE', 'memO', 'memC']) s[k] = new Array(63).fill(0);
    const put = (x, y, t) => { s.tiles[E.idx(x, y)] = t; };
    [[0, 3], [1, 3], [5, 2], [5, 3], [6, 6], [2, 7], [2, 8], [3, 1]].forEach(p => put(p[0], p[1], E.T.WALL));
    put(4, 0, E.T.STAIRS); s.stairs = { x: 4, y: 0, open: false };
    put(1, 5, E.T.BRAZIER); put(5, 0, E.T.BRAZIER); s.braziers = [{ x: 1, y: 5, lit: true }, { x: 5, y: 0, lit: false }];
    put(6, 4, E.T.ALTAR); s.altars = [{ x: 6, y: 4, used: false, offers: [{ id: 'mirror', free: true }, { id: 'hearth', free: false }, { id: 'lastgasp', free: false }] }];
    put(0, 6, E.T.CHEST);
    [[4, 6], [5, 6], [5, 7], [4, 7]].forEach(p => { s.oil[E.idx(p[0], p[1])] = 1; });
    s.fire[E.idx(5, 8)] = 2;
    s.embers[E.idx(2, 4)] = 1; s.embers[E.idx(3, 6)] = 2;
    s.p.x = 3; s.p.y = 5; s.p.flame = 7; s.p.burn = 4; s.relics = ['sunstone', 'greedy', 'tongs'];
    let id = 1;
    s.enemies = [];
    const foe = (t, x, y, st) => s.enemies.push({ id: id++, t: t, x: x, y: y, hp: C.ENEMIES[t].hp, st: st, dark: 0, cd: 0, stun: 0, seen: 0, exp: 0, f: x < 3 ? 1 : -1 });
    foe('gnawer', 3, 3, 2); foe('archer', 0, 4, 2); foe('ooze', 4, 4, 1); foe('beetle', 2, 2, 0); foe('gnawer', 6, 1, 2); foe('archer', 1, 1, 0);
    s.nextId = id;
    E._refresh(s);
    Wickbound.load(s);
  });
  await checkLayout('staged'); await shot('04-staged-board');
  const probs = await game(() => WickEngine.problems(Wickbound.state));
  if (probs.length) note('the staged board is not a valid state: ' + probs.join('; '));

  // Long-press an enemy for its card.
  const arch = await tileXY(0, 4);
  await touch('touchStart', arch.x, arch.y); await page.waitForTimeout(650);
  if (await page.locator('#info').isHidden()) note('long-press did not open an info card');
  await checkLayout('info'); await shot('05-info-card');
  await touch('touchEnd', arch.x, arch.y); await page.waitForTimeout(80);
  const t0 = await game(() => Wickbound.state.turn);
  await tap(arch.x, arch.y); await page.waitForTimeout(200);       // this tap only closes the card
  if (!(await page.locator('#info').isHidden())) note('the next touch did not close the info card');
  if ((await game(() => Wickbound.state.turn)) !== t0) note('the touch that closed the card also acted');

  // Flare: tap the button, then a direction.
  await tapOn('#btn-flare'); await shot('06-flare-aim');
  await swipe(mid.x, mid.y, 0, -60); await page.waitForTimeout(150);
  const fl = await game(() => ({ flame: Wickbound.state.p.flame, gnawers: Wickbound.state.enemies.filter(e => e.t === 'gnawer').length }));
  if (fl.gnawers !== 1) note('Flare upward did not kill the gnawer in its path');
  await shot('07-after-flare');

  // The altar sheet.
  await game(() => { const s = WickEngine.clone(Wickbound.state); s.enemies = s.enemies.filter(e => e.st !== 2); s.p.x = 5; s.p.y = 4; WickEngine._refresh(s); Wickbound.load(s); });
  const here = await tileXY(5, 4);
  await swipe(here.x, here.y, 60, 0); await page.waitForTimeout(500);
  if ((await game(() => Wickbound.sheet)) !== 'altar') note('moving into the altar did not open it');
  await checkLayout('altar'); await shot('08-altar');
  await page.locator('#altar-list .relic').nth(1).tap(); await page.waitForTimeout(120); await shot('09-altar-paid-choice');
  await tapOn('#btn-take'); await page.waitForTimeout(400);
  const got = await game(() => ({ relics: Wickbound.state.relics, flame: Wickbound.state.p.flame, mode: Wickbound.state.mode }));
  if (!got.relics.includes('hearth') || got.mode !== 'play') note('taking the paid relic failed: ' + JSON.stringify(got));
  await shot('10-relic-taken');
  await tapOn('#relics'); await page.waitForTimeout(250); await checkLayout('relics'); await shot('11-relic-list');
  await tapOn('#btn-relics-close');

  // Pause, and the back gesture.
  await tapOn('#btn-pause'); await page.waitForTimeout(250); await checkLayout('pause'); await shot('12-pause');
  await page.goBack(); await page.waitForTimeout(250);
  if ((await game(() => Wickbound.sheet)) !== '') note('back did not close the pause sheet');
  if ((await game(() => Wickbound.screen)) !== 'run') note('back left the run');
  await page.goBack(); await page.waitForTimeout(250);
  if ((await game(() => Wickbound.sheet)) !== 'pause') note('back during play did not pause');
  await tapOn('#btn-resume'); await page.waitForTimeout(150);

  // Save and resume: reload the page mid-run and carry on from the same state.
  const saved = await game(() => JSON.stringify(Wickbound.state));
  await page.reload();
  await page.waitForFunction(() => window.Wickbound && window.Wickbound.screen === 'title');
  await shot('13-title-continue');
  if ((await page.locator('#btn-descend').textContent()) !== 'Continue') note('the title did not offer Continue after a reload');
  await tapOn('#btn-descend'); await page.waitForFunction(() => window.Wickbound.screen === 'run');
  if ((await game(() => JSON.stringify(Wickbound.state))) !== saved) note('the run after a reload is not the run that was saved');

  // A corrupt run save must not touch permanent progress. (The page saves as it unloads, so the
  // damage is done by a script that runs before the game boots on the next load.)
  await ctx.addInitScript(() => { try { if (sessionStorage.getItem('corrupt-next')) { sessionStorage.removeItem('corrupt-next'); localStorage.setItem('wickbound:run', '{"v":1,"state":{"broken":tru'); } } catch (e) { /* storage blocked */ } });
  await game(() => { sessionStorage.setItem('corrupt-next', '1'); });
  const metaBefore = await game(() => localStorage.getItem('wickbound:meta'));
  await page.reload();
  await page.waitForFunction(() => window.Wickbound && window.Wickbound.screen === 'title');
  if ((await page.locator('#btn-descend').textContent()) !== 'Descend') note('a corrupt run save was not discarded');
  if ((await game(() => localStorage.getItem('wickbound:meta'))) !== metaBefore) note('a corrupt run save changed permanent progress');
  if ((await game(() => Wickbound.meta.wicks)) < 1) note('permanent progress was lost with the corrupt run');

  // Death, the summary, and one tap back into a run.
  await tapOn('#btn-descend'); await page.waitForFunction(() => window.Wickbound.screen === 'run');
  await game(() => { const s = WickEngine.clone(Wickbound.state); s.p.flame = 1; s.p.burn = 1; s.stats.kills = 7; s.stats.floors = 2; s.floor = 3; s.relics = ['mirror', 'jar']; WickEngine._refresh(s); Wickbound.load(s); });
  await tapOn('#btn-wait'); await page.waitForTimeout(300); await shot('14-dying');
  await page.waitForFunction(() => window.Wickbound.screen === 'summary', null, { timeout: 5000 });
  await checkLayout('summary'); await shot('15-summary');
  const wicks = await game(() => Wickbound.meta.wicks);
  await tapOn('#btn-again'); await page.waitForFunction(() => window.Wickbound.screen === 'run');
  if ((await game(() => Wickbound.meta.wicks)) !== wicks + 1) note('one tap from the summary did not start the next Wick');
  await shot('16-next-run');

  // Taking the stairs: the next floor arrives, and the last floor ends the run.
  const toStairs = () => game(() => { const E = WickEngine, s = E.clone(Wickbound.state); s.braziers.forEach(b => (b.lit = true)); s.stairs.open = true; s.enemies = [];
    s.p.x = s.stairs.x; s.p.y = 1; s.tiles[E.idx(s.p.x, 1)] = 0; s.oil[E.idx(s.p.x, 1)] = 0; s.fire[E.idx(s.p.x, 1)] = 0; E._refresh(s); Wickbound.load(s); });
  await toStairs();
  await swipe(mid.x, mid.y, 0, -60); await page.waitForTimeout(400);
  if ((await game(() => Wickbound.state.floor)) !== 2) note('stepping onto the open stairs did not lead to floor 2');
  if ((await game(() => WickEngine.problems(Wickbound.state).length)) !== 0) note('floor 2 is not a valid state');
  await shot('16b-floor-2');
  await game(() => { const s = WickEngine.clone(Wickbound.state); s.floor = WICK_CONFIG.CONFIG.run.floors; Wickbound.load(s); });
  await toStairs();
  await swipe(mid.x, mid.y, 0, -60);
  await page.waitForFunction(() => window.Wickbound.screen === 'summary', null, { timeout: 5000 });
  if (!/bottom/.test(await page.locator('#epitaph').textContent())) note('clearing the last floor did not show the end-of-build summary');
  if ((await game(() => Wickbound.meta.wins)) !== 1) note('a cleared run was not counted');
  await checkLayout('summary-cleared'); await shot('16c-summary-cleared');
  await tapOn('#btn-again'); await page.waitForFunction(() => window.Wickbound.screen === 'run');

  // Tap a far tile to walk there while nothing is awake.
  const walk = await game(() => { const s = Wickbound.state, E = WickEngine; for (let y = s.p.y - 1; y >= 0; y--) for (let x = 0; x < 7; x++) { const p = E.pathTo(s, x, y); if (p && p.length >= 3 && p.length <= 5 && s.tiles[E.idx(x, y)] === 0 && !E.enemyAt(s, x, y)) return { x: x, y: y, n: p.length, from: [s.p.x, s.p.y] }; } return null; });
  if (walk) {
    const w = await tileXY(walk.x, walk.y);
    await tap(w.x, w.y); await page.waitForTimeout(1200);
    const pos = await game(() => [Wickbound.state.p.x, Wickbound.state.p.y]);
    if (pos[0] === walk.from[0] && pos[1] === walk.from[1]) note('tapping a far tile did not start a walk');
  } else note('found no far tile to test the tap-to-walk on');

  // With storage blocked, the game must still run (in memory).
  const ctx2 = await browser.newContext({ viewport: VIEW, deviceScaleFactor: DPR, hasTouch: true, isMobile: true });
  await ctx2.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); });
  const page2 = await ctx2.newPage();
  page2.on('pageerror', e => note('page error with storage blocked: ' + e.message));
  await page2.goto(base);
  await page2.waitForFunction(() => window.Wickbound && window.Wickbound.screen === 'title');
  await page2.locator('#btn-descend').tap();
  await page2.waitForFunction(() => window.Wickbound.screen === 'run');
  if (await page2.evaluate(() => Wickbound.store.persistent)) note('storage was not actually blocked in the fallback test');
  await page2.waitForTimeout(300); await page2.screenshot({ path: path.join(OUT, '17-storage-blocked.png') });
  await ctx2.close();

  // Other screen sizes, to check nothing depends on one phone.
  for (const v of [{ name: '18-short-phone', width: 360, height: 640 }, { name: '19-in-browser-with-toolbar', width: 384, height: 730 }, { name: '20-large-phone', width: 430, height: 932 }]) {
    await page.setViewportSize({ width: v.width, height: v.height }); await page.waitForTimeout(300);
    await checkLayout(v.name); await page.screenshot({ path: path.join(OUT, v.name + '.png') }); console.log('  shot ' + v.name);
  }
  await page.setViewportSize(VIEW);

  // How much script time one frame of the board costs (drawing calls included, rasterising not).
  const cost = await game(() => { const t = []; let now = performance.now(); for (let k = 0; k < 300; k++) { const a = performance.now(); WickRender.frame(now += 8.33); t.push(performance.now() - a); } t.sort((a, b) => a - b); return { median: t[150], p95: t[285] }; });
  console.log('  script time per board frame: median ' + cost.median.toFixed(2) + ' ms, 95th percentile ' + cost.p95.toFixed(2) + ' ms (a 120 Hz frame is 8.33 ms)');

  await browser.close(); srv.close();
  console.log('\n' + (problems.length ? 'FAILED with ' + problems.length + ' problem(s)' : 'PASSED: every screen loaded, drew and behaved') + '. Screenshots in ' + OUT);
  process.exit(problems.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
