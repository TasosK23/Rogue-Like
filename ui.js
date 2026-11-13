/* Wickbound: screens, input and saving. The glue between the rules (engine.js) and the board (render.js). */
(function () {
  'use strict';
  const C = window.WICK_CONFIG, E = window.WickEngine, R = window.WickRender;
  const CFG = C.CONFIG, FEEL = CFG.feel, TEXT = C.TEXT, RELICS = C.RELICS, ENEMIES = C.ENEMIES, CANDLES = C.CANDLES;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const icon = d => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';

  // =============================================================================================
  // Storage. Every key is prefixed: GitHub Pages serves all of one account's sites from one
  // origin, so they share localStorage. If storage is blocked (a sandboxed preview), fall back to
  // memory so the game still runs.
  // =============================================================================================
  const K_META = 'wickbound:meta', K_RUN = 'wickbound:run';
  const store = (() => {
    const mem = {};
    let ok = false;
    try { localStorage.setItem('wickbound:probe', '1'); localStorage.removeItem('wickbound:probe'); ok = true; } catch (e) { ok = false; }
    return {
      persistent: ok,
      get(k) {
        if (Object.prototype.hasOwnProperty.call(mem, k)) return mem[k];
        if (ok) { try { return localStorage.getItem(k); } catch (e) { /* fall through */ } }
        return null;
      },
      set(k, v) {
        if (ok) { try { localStorage.setItem(k, v); delete mem[k]; return; } catch (e) { /* full or blocked: keep it in memory */ } }
        mem[k] = v;
      },
      del(k) {
        delete mem[k];
        if (ok) { try { localStorage.removeItem(k); } catch (e) { /* nothing to do */ } }
      }
    };
  })();

  // Permanent progress and the current run are saved apart, each versioned, so a bad run save can
  // never take permanent progress down with it.
  const META_V = 1, RUN_V = 1;
  const freshMeta = () => ({ v: META_V, wicks: 0, runs: 0, wins: 0, best: { floor: 0, score: 0 }, log: [] });
  function migrateMeta(m) {
    const out = freshMeta();
    if (!m || typeof m !== 'object') return out;
    // Future versions step m.v up one at a time here before the fields are read.
    const n = v => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    out.wicks = n(m.wicks); out.runs = n(m.runs); out.wins = n(m.wins);
    if (m.best) { out.best.floor = n(m.best.floor); out.best.score = n(m.best.score); }
    if (Array.isArray(m.log)) out.log = m.log.filter(x => x && typeof x.text === 'string').slice(0, 20);
    return out;
  }
  function loadMeta() {
    const raw = store.get(K_META);
    if (!raw) return freshMeta();
    try { return migrateMeta(JSON.parse(raw)); }
    catch (e) { store.set(K_META + '.bad', raw); return freshMeta(); }      // keep the unreadable copy rather than destroy it
  }
  function saveMeta() { store.set(K_META, JSON.stringify(meta)); }
  function loadRun() {
    const raw = store.get(K_RUN);
    if (!raw) return null;
    try {
      const o = JSON.parse(raw);
      if (!o || o.v !== RUN_V || !o.state || o.state.v !== CFG.saveVersion) throw new Error('version');
      const s = o.state;
      if (E.problems(s).length || (s.mode !== 'play' && s.mode !== 'altar')) throw new Error('invalid');
      return s;
    } catch (e) { store.del(K_RUN); return null; }
  }
  function saveRun() {
    if (state && (state.mode === 'play' || state.mode === 'altar')) store.set(K_RUN, JSON.stringify({ v: RUN_V, build: C.VERSION, state: state }));
  }

  // =============================================================================================
  // State
  // =============================================================================================
  let meta = loadMeta();
  let state = loadRun();
  let screen = 'title', sheet = '', aim = false, auto = null, pending = null, lockUntil = 0;
  let altarSel = 0, saidFull = false, sumWon = false, lastTile = 0, lastDpr = 0, trapped = false, ignorePop = false;
  let toastTimer = 0, raf = 0;

  const boardCv = $('board'), titleCv = $('title-candle'), sumCv = $('sum-candle');
  const infoEl = $('info'), toastEl = $('toast'), shade = $('shade');

  // =============================================================================================
  // Screens
  // =============================================================================================
  function show(name) {
    for (const s of ['title', 'run', 'summary']) $(s).classList.toggle('on', s === name);
    screen = name;
    layout();
  }
  function refreshTitle() {
    const going = !!state;
    $('btn-descend').textContent = going ? 'Continue' : 'Descend';
    $('title-wick').textContent = 'Wick the ' + E.ordinal(going ? state.wick : meta.wicks + 1);
    $('title-quip').textContent = going
      ? 'Floor ' + state.floor + ' of ' + C.ZONES[state.zone].name + ', ' + state.p.flame + ' flame left.'
      : TEXT.quips[meta.wicks % TEXT.quips.length];
    const fresh = $('btn-fresh');
    fresh.hidden = !going; fresh.textContent = 'Pinch this one out and pour another'; fresh.classList.remove('warn'); fresh.dataset.armed = '';
    $('title-note').textContent = 'v' + C.VERSION + (store.persistent ? '' : '. Saving is blocked here, so progress lasts until this page closes.');
  }
  function goTitle() {
    closeSheet();
    refreshTitle();
    show('title');
    if (trapped) { ignorePop = true; trapped = false; try { history.back(); } catch (e) { ignorePop = false; } }
  }
  const newSeed = () => (((Date.now() % 4294967296) ^ Math.floor(Math.random() * 4294967296)) >>> 0) || 1;

  function startRun() {
    meta.wicks++;
    saveMeta();
    state = E.newRun({ seed: newSeed(), candle: 'tallow', wick: meta.wicks });
    saidFull = false;
    enterRun(true);
  }
  function enterRun(fresh) {
    show('run');
    R.setState(state);
    lockUntil = 0; pending = null; auto = null;
    setAim(false); hideInfo(); closeSheet();
    updateHud(true);
    saveRun();
    pushTrap();
    const first = fresh && meta.wicks === 1;
    toast(first ? 'Swipe to move. Hold on anything to see what it is.' : fresh ? floorLine() : 'Wick the ' + E.ordinal(state.wick) + ' carries on.', first ? 4200 : 2800);
    if (state.mode === 'altar') openAltar();
  }
  function floorLine() {
    const z = C.ZONES[state.zone];
    return state.floor === 1 ? z.lines[0] : 'Floor ' + state.floor + '. ' + z.lines[1 + (E.hash32(state.seed, state.floor) % (z.lines.length - 1))];
  }

  // =============================================================================================
  // Acting
  // =============================================================================================
  // Every input comes through here. One input is buffered while a turn is still animating.
  function act(a) {
    if (screen !== 'run' || !state) return;
    auto = null;
    if (performance.now() < lockUntil) { pending = a; return; }
    doAct(a);
  }
  function doAct(a) {
    if (!state || (state.mode !== 'play' && state.mode !== 'altar')) return false;
    const prev = state, r = E.step(state, a);
    for (const e of r.events) {
      if (e.e === 'bump' && e.what === 'sealed') toast(TEXT.toast.sealed);
      else if (e.e === 'bump' && e.what === 'spent') toast(TEXT.toast.altarSpent);
      else if (e.e === 'refuse') toast(TEXT.toast[e.why] || '');
    }
    if (!r.changed) { if (r.events.length) R.play(state, r.events); return false; }
    state = r.state;
    const dur = R.play(state, r.events);
    lockUntil = performance.now() + Math.min(dur, r.turn ? 150 : 60);
    updateHud(false, prev);
    saveRun();
    let ended = false;
    for (const e of r.events) {
      switch (e.e) {
        case 'altar': auto = null; setTimeout(openAltar, 150); break;
        case 'unseal': toast(TEXT.toast.unseal); break;
        case 'floor': auto = null; saidFull = false; toast(floorLine(), 2800); break;
        case 'relic': toast(RELICS[e.id].name + '. ' + RELICS[e.id].text, 3400); break;
        case 'snuffed': case 'won': ended = true; break;
        case 'stir': case 'wake': case 'hurt': case 'ignite': case 'chest': case 'strike': case 'brazier': case 'explode': auto = null; break;
        default: break;
      }
    }
    if (auto && E.openRadius(state) !== E.openRadius(prev)) auto = null;
    if (!ended && r.turn && !saidFull && state.p.flame >= state.p.max && state.embers[E.idx(state.p.x, state.p.y)] > 0) { saidFull = true; toast(TEXT.toast.max, 2600); }
    if (ended) endRun(dur);
    return true;
  }

  function logRun(s, sc) {
    meta.runs++;
    if (s.mode === 'won') meta.wins++;
    meta.best.floor = Math.max(meta.best.floor, s.floor);
    meta.best.score = Math.max(meta.best.score, sc);
    meta.log.unshift({ w: s.wick, text: E.record(s), floor: s.floor, score: sc, seed: s.seed, won: s.mode === 'won' });
    meta.log.length = Math.min(20, meta.log.length);
    saveMeta();
  }
  function endRun(delay) {
    const s = state, sc = E.score(s), wasBest = meta.best.score;
    store.del(K_RUN);
    lockUntil = Infinity; pending = null; auto = null;
    setAim(false); hideInfo();
    logRun(s, sc);
    setTimeout(() => { if (state === s) showSummary(s, sc, wasBest); }, Math.max(200, delay));
  }

  // =============================================================================================
  // HUD
  // =============================================================================================
  let pipMax = -1, wickMax = -1, relicCount = -1;
  function updateHud(force, prev) {
    if (!state) return;
    const p = state.p, num = $('flame-num');
    if (pipMax !== p.max || force) {
      pipMax = p.max;
      let h = '';
      for (let i = 1; i <= p.max; i++) h += '<i' + (i > 1 && CFG.light.bands.some(b => b[0] === i) ? ' class="band"' : '') + '></i>';
      $('pips').innerHTML = h;
    }
    const every = CANDLES[state.candle].burnEvery;
    if (wickMax !== every || force) {
      wickMax = every;
      let h = '';
      for (let i = 0; i < every; i++) h += '<i></i>';
      $('wick').innerHTML = h + '<span id="wick-label"></span>';
    }
    num.textContent = Math.max(0, p.flame);
    num.classList.toggle('low', p.flame > 0 && p.flame <= 2);
    if (prev && prev.p.flame !== p.flame) { num.classList.remove('pop'); void num.offsetWidth; num.classList.add('pop'); }
    const pips = $('pips').children;
    for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('on', i < p.flame);
    const knots = $('wick').children;
    for (let i = 0; i < every; i++) { knots[i].classList.toggle('on', i < p.burn); knots[i].classList.toggle('tip', i === p.burn - 1); }
    $('wick-label').textContent = 'burn in ' + p.burn;
    $('zone').textContent = C.ZONES[state.zone].short;
    $('floor').textContent = 'Floor ' + state.floor;
    $('light').innerHTML = p.cupped ? '<b>Cupped</b>: own tile only' : 'Light <b>' + E.lightRadius(state) + '</b>';
    if (relicCount !== state.relics.length || force) {
      relicCount = state.relics.length;
      $('relics').innerHTML = state.relics.map(id => icon(RELICS[id].icon)).join('');
    }
    const fl = CFG.sparks.flare.cost, sp = CFG.sparks[CANDLES[state.candle].spark].cost;
    $('cost-flare').textContent = fl; $('cost-spark').textContent = sp;
    $('spark-name').textContent = C.SPARKS[CANDLES[state.candle].spark].name;
    $('btn-cup').classList.toggle('held', p.cupped);
    $('btn-flare').classList.toggle('cant', !E.canSpend(state, fl));
    $('btn-spark').classList.toggle('cant', !E.sparkReady(state));
    $('btn-flare').classList.toggle('armed', aim);
  }
  function toast(text, ms) {
    if (!text) return;
    toastEl.textContent = text;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), ms || 2000);
  }
  function setAim(on) {
    aim = !!on;
    R.setAim(aim);
    $('btn-flare').classList.toggle('armed', aim);
  }

  // A long-press card: what this is, and where it can hurt me. It replaces a manual.
  function showInfo(t) {
    const info = E.inspect(state, t.x, t.y);
    if (!info) return;
    const tag = info.kind === 'enemy' ? info.hp + ' of ' + info.maxHp + ' health, hits for ' + info.dmg : '';
    infoEl.innerHTML = '<h3>' + esc(info.title) + (tag ? '<span>' + tag + '</span>' : '') + '</h3>' +
      info.lines.map((l, i) => '<p' + (info.kind === 'enemy' && i === info.lines.length - 1 ? ' class="tip"' : '') + '>' + esc(l) + '</p>').join('');
    infoEl.className = t.y < 4 ? 'bottom' : 'top';
    infoEl.hidden = false;
    R.setInspect(E.idx(t.x, t.y), info);
  }
  function hideInfo() {
    if (infoEl.hidden) return false;
    infoEl.hidden = true;
    R.setInspect(-1, null);
    return true;
  }

  // =============================================================================================
  // Sheets: altar, relics, pause
  // =============================================================================================
  function openSheet(name) {
    closeSheet();
    sheet = name;
    shade.hidden = false;
    $('sheet-' + name).hidden = false;
    auto = null; pending = null;
    setAim(false); hideInfo();
  }
  function closeSheet() {
    if (!sheet) return;
    $('sheet-' + sheet).hidden = true;
    shade.hidden = true;
    sheet = '';
  }
  // Closing by the back gesture or a tap outside: walking away from an altar is an action.
  function dismissSheet() {
    if (sheet === 'altar') { closeSheet(); doAct({ t: 'leave' }); }
    else closeSheet();
  }
  function currentAltar() { return state && state.mode === 'altar' ? E.altarAt(state, E.xOf(state.altarAt), E.yOf(state.altarAt)) : null; }
  function openAltar() {
    const a = currentAltar();
    if (!a || screen !== 'run') return;
    altarSel = Math.max(0, a.offers.findIndex(o => o.free));
    openSheet('altar');
    renderAltar();
  }
  function renderAltar() {
    const a = currentAltar();
    if (!a) return;
    $('altar-list').innerHTML = a.offers.map((o, i) => {
      const r = RELICS[o.id], cost = E.relicPrice(state, o), can = cost === 0 || E.canSpend(state, cost);
      return '<button class="relic' + (i === altarSel ? ' sel' : '') + (can ? '' : ' cant') + '" data-i="' + i + '">' + icon(r.icon) +
        '<div><b>' + esc(r.name) + '</b><small>' + esc(r.text) + '</small></div>' +
        '<div class="price' + (cost === 0 ? ' free' : '') + '">' + (cost === 0 ? 'free' : cost + ' flame') + '</div></button>';
    }).join('');
    const o = a.offers[altarSel], cost = E.relicPrice(state, o), can = cost === 0 || E.canSpend(state, cost);
    const take = $('btn-take');
    take.textContent = can ? (cost === 0 ? 'Take it' : 'Take for ' + cost + ' flame') : 'Not your last flame';
    take.style.opacity = can ? '1' : '0.4';
  }
  function openRelics() {
    if (!state.relics.length) { toast('No relics yet. Altars have them.'); return; }
    $('relics-sub').textContent = state.relics.length + (state.relics.length === 1 ? ' relic, kept for this run.' : ' relics, kept for this run.');
    $('relics-list').innerHTML = state.relics.map(id => '<div class="relic owned">' + icon(RELICS[id].icon) + '<div><b>' + esc(RELICS[id].name) + '</b><small>' + esc(RELICS[id].text) + '</small></div></div>').join('');
    openSheet('relics');
  }
  function openPause() {
    $('pause-sub').textContent = 'Wick the ' + E.ordinal(state.wick) + ', floor ' + state.floor + '. The dark will wait.';
    $('pause-ver').textContent = 'Wickbound v' + C.VERSION + '. Seed ' + state.seed + '.';
    const ab = $('btn-abandon'); ab.textContent = 'Pinch this Wick out'; ab.dataset.armed = '';
    openSheet('pause');
  }

  // =============================================================================================
  // The end of a run
  // =============================================================================================
  function showSummary(s, sc, wasBest) {
    const d = s.death, won = s.mode === 'won';
    sumWon = won;
    $('epitaph').textContent = E.epitaph(s);
    $('record').textContent = E.record(s) + '.';
    let head = 'What snuffed you', text = '';
    if (won) { head = 'What happens next'; text = 'That was all twelve floors of this build. The three bosses and the Great Lantern arrive with stage 2.'; }
    else if (d.by === 'abandoned') { head = 'What happened'; text = 'You pinched this one out yourself.'; }
    else if (d.by === 'burn') text = 'The burn. Every ' + CANDLES[s.candle].burnEvery + ' turns it takes 1 flame. Embers and chests are the only way to stay lit, so the things that sleep down here are also your fuel.';
    else if (d.by === 'fire') text = 'Burning oil. It costs 1 flame a turn to stand in, and it does not care who lit it.';
    else if (d.by === 'explosion') text = 'A Tinder Beetle’s blast. ' + ENEMIES.beetle.tip;
    else if (d.by === 'enemy' && ENEMIES[d.t]) text = 'A ' + ENEMIES[d.t].name + '. ' + ENEMIES[d.t].tip;
    $('lesson-head').textContent = head;
    $('lesson-text').textContent = text;
    const names = h => (h.by === 'enemy' && ENEMIES[h.t] ? ENEMIES[h.t].name : h.by === 'burn' ? 'the burn' : h.by === 'fire' ? 'burning oil' : h.by === 'explosion' ? 'a blast' : h.by);
    $('breaths').textContent = !won && s.hurts.length ? 'Last flame lost: ' + s.hurts.slice(-4).map(h => '−' + h.n + ' ' + names(h)).join(', ') + '.' : '';
    const st = s.stats, rows = [
      ['Floors cleared', st.floors], ['Turns', st.turns], ['Kills', st.kills], ['Sneak attacks', st.sneaks],
      ['Braziers lit', st.braziers], ['Embers', st.embers], ['Chests', st.chests], [won ? 'Flame left' : 'Flame lost to hits', won ? s.p.flame : st.hurt]
    ];
    $('stats').innerHTML = rows.map(r => '<div>' + r[0] + '<b>' + r[1] + '</b></div>').join('');
    $('sum-relics').innerHTML = s.relics.map(id => icon(RELICS[id].icon)).join('');
    $('score').textContent = sc;
    $('seed').textContent = 'Seed ' + s.seed;
    $('best').innerHTML = sc > wasBest && meta.runs > 1 ? 'A new best.<br>It was ' + wasBest + '.' : 'Best ' + meta.best.score + '<br>Deepest floor ' + meta.best.floor;
    state = null;
    show('summary');
    $('summary').scrollTop = 0;
  }

  // =============================================================================================
  // Input: Pointer Events, first pointer only
  // =============================================================================================
  const G = { id: null, x0: 0, y0: 0, fired: false, long: false, dismiss: false, btn: null, tile: null, timer: 0 };
  let swallowClick = false;
  function direction(d) {
    if (aim) { setAim(false); act({ t: 'flare', d: d }); }
    else act({ t: 'move', d: d });
  }
  function tapTile(t) {
    const p = state.p, dx = t.x - p.x, dy = t.y - p.y, dist = Math.abs(dx) + Math.abs(dy);
    if (aim) {
      if (dist === 0) { setAim(false); toast(TEXT.toast.aimCancel, 1200); }
      else if (dx === 0 || dy === 0) direction(dx === 0 ? (dy < 0 ? 0 : 2) : (dx > 0 ? 1 : 3));
      return;
    }
    if (dist === 0) act({ t: 'wait' });
    else if (dist === 1) direction(dx === 0 ? (dy < 0 ? 0 : 2) : (dx > 0 ? 1 : 3));
    else if (E.anyAwake(state)) toast('Something is awake. Walk this one yourself.', 1600);
    else {
      const path = E.pathTo(state, t.x, t.y);
      if (path) { pending = null; auto = { dirs: path, i: 0 }; }
    }
  }
  function autoStep() {
    if (!auto || !state || state.mode !== 'play' || E.anyAwake(state)) { auto = null; return; }
    const route = auto, known = state.enemies.filter(e => E.enemyView(state, e) !== 'hidden').length;
    const moved = doAct({ t: 'move', d: route.dirs[route.i++] });
    if (auto !== route) return;                                     // something changed: the walk was called off
    if (!moved || route.i >= route.dirs.length || !state || state.enemies.filter(e => E.enemyView(state, e) !== 'hidden').length !== known) { auto = null; return; }
    lockUntil = Math.max(lockUntil, performance.now() + FEEL.autoWalkMs);
  }

  const runEl = $('run');
  document.addEventListener('pointerdown', () => { swallowClick = false; }, true);
  runEl.addEventListener('pointerdown', e => {
    if (G.id !== null || screen !== 'run' || sheet || !state) return;
    G.id = e.pointerId; G.x0 = e.clientX; G.y0 = e.clientY; G.fired = false; G.long = false;
    G.btn = e.target.closest ? e.target.closest('button') : null;
    G.tile = G.btn ? null : R.tileAt(e.clientX, e.clientY);
    G.dismiss = hideInfo();                        // a touch that closes a card does nothing else unless it becomes a swipe
    clearTimeout(G.timer);
    if (G.tile) { const t = G.tile; G.timer = setTimeout(() => { if (G.id !== null && !G.fired) { G.long = true; auto = null; showInfo(t); } }, FEEL.longPressMs); }
  });
  window.addEventListener('pointermove', e => {
    if (e.pointerId !== G.id || G.fired || G.long) return;
    const dx = e.clientX - G.x0, dy = e.clientY - G.y0, ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax > 8 || ay > 8) clearTimeout(G.timer);
    if (ax < FEEL.swipePx && ay < FEEL.swipePx) return;
    G.fired = true; swallowClick = true;           // act the moment the swipe passes the threshold
    direction(ax > ay ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0));
  });
  function endTouch(e, cancelled) {
    if (e.pointerId !== G.id) return;
    clearTimeout(G.timer);
    G.id = null;
    if (cancelled || G.fired || G.long || G.btn || G.dismiss || !G.tile || screen !== 'run' || sheet || !state) return;
    if (Math.abs(e.clientX - G.x0) < 12 && Math.abs(e.clientY - G.y0) < 12) tapTile(G.tile);
  }
  window.addEventListener('pointerup', e => endTouch(e, false));
  window.addEventListener('pointercancel', e => endTouch(e, true));
  document.addEventListener('click', e => { if (swallowClick) { swallowClick = false; e.stopPropagation(); e.preventDefault(); } }, true);

  // Nothing on the game surface should scroll, zoom, select or pop a menu.
  window.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('dblclick', e => e.preventDefault());
  document.addEventListener('gesturestart', e => e.preventDefault());
  document.addEventListener('touchmove', e => { if (!(e.target.closest && e.target.closest('.sheet, #summary'))) e.preventDefault(); }, { passive: false });

  // ---------- buttons ----------
  const on = (id, fn) => $(id).addEventListener('click', fn);
  on('btn-descend', () => { if (state) enterRun(false); else startRun(); });
  on('btn-fresh', e => {
    const b = e.currentTarget;
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Tap again to pinch it out'; b.classList.add('warn'); return; }
    abandon(true);
  });
  on('btn-cup', () => act({ t: 'cup' }));
  on('btn-wait', () => act({ t: 'wait' }));
  on('btn-spark', () => { setAim(false); act({ t: 'spark' }); });
  on('btn-flare', () => {
    if (!state) return;
    if (aim) { setAim(false); toast(TEXT.toast.aimCancel, 1200); return; }
    if (!E.canSpend(state, CFG.sparks.flare.cost)) { toast(TEXT.toast.lastFlame); return; }
    auto = null; pending = null;
    setAim(true); toast(TEXT.toast.aim, 2400);
  });
  on('btn-pause', () => { if (state) openPause(); });
  on('relics', () => { if (state) openRelics(); });
  on('btn-resume', closeSheet);
  on('btn-relics-close', closeSheet);
  on('btn-leave', dismissSheet);
  on('btn-take', () => {
    const a = currentAltar();
    if (!a) { closeSheet(); return; }
    const cost = E.relicPrice(state, a.offers[altarSel]);
    if (cost > 0 && !E.canSpend(state, cost)) return;
    closeSheet();
    doAct({ t: 'take', i: altarSel });
  });
  $('altar-list').addEventListener('click', e => {
    const b = e.target.closest('.relic');
    if (!b) return;
    altarSel = +b.dataset.i;
    renderAltar();
  });
  shade.addEventListener('click', dismissSheet);
  on('btn-abandon', e => {
    const b = e.currentTarget;
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Tap again. This Wick will not come back.'; return; }
    abandon(false);
  });
  function abandon(thenNew) {
    if (!state) return;
    closeSheet();
    const s = E.step(state, { t: 'abandon' }).state, sc = E.score(s), wasBest = meta.best.score;
    store.del(K_RUN);
    logRun(s, sc);
    state = null;
    if (thenNew) startRun(); else showSummary(s, sc, wasBest);
  }
  on('btn-again', startRun);
  on('btn-title', goTitle);

  // ---------- keyboard (for playing at a desk) ----------
  window.addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    if (screen === 'title') { if (k === 'enter' || k === ' ') { e.preventDefault(); $('btn-descend').click(); } return; }
    if (screen === 'summary') { if (k === 'enter' || k === ' ') { e.preventDefault(); startRun(); } else if (k === 'escape') goTitle(); return; }
    if (sheet) { if (k === 'escape') dismissSheet(); else if (k === 'enter' && sheet === 'altar') $('btn-take').click(); return; }
    const dir = { arrowup: 0, w: 0, arrowright: 1, d: 1, arrowdown: 2, s: 2, arrowleft: 3, a: 3 }[k];
    if (dir !== undefined) { e.preventDefault(); hideInfo(); direction(dir); }
    else if (k === ' ' || k === '.') { e.preventDefault(); hideInfo(); act({ t: 'wait' }); }
    else if (k === 'c') act({ t: 'cup' });
    else if (k === 'f') $('btn-flare').click();
    else if (k === 'e') $('btn-spark').click();
    else if (k === 'escape') { if (!hideInfo()) { if (aim) setAim(false); else openPause(); } }
  });

  // =============================================================================================
  // The back gesture closes whatever is open, or pauses, instead of quitting.
  // =============================================================================================
  function pushTrap() {
    if (trapped) return;
    try { history.pushState({ wickbound: 1 }, ''); trapped = true; } catch (e) { /* history is unavailable in some previews */ }
  }
  window.addEventListener('popstate', () => {
    if (ignorePop) { ignorePop = false; return; }
    trapped = false;
    if (screen === 'run') {
      if (!hideInfo()) { if (aim) setAim(false); else if (sheet) dismissSheet(); else if (state) openPause(); }
      pushTrap();
    } else if (screen === 'summary') { refreshTitle(); show('title'); }
  });

  // =============================================================================================
  // Layout, the frame loop, and the page's life
  // =============================================================================================
  function layout() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    for (const c of [titleCv, sumCv]) {
      const r = c.getBoundingClientRect();
      if (r.width > 0) { const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } }
    }
    if (screen !== 'run') return;
    const wrap = $('board-wrap');
    const tile = Math.max(20, Math.floor(Math.min(wrap.clientWidth / E.W, wrap.clientHeight / E.H)));
    if (tile !== lastTile || dpr !== lastDpr) {
      lastTile = tile; lastDpr = dpr;
      R.resize(tile, dpr);
      if (state) R.setState(state);
    }
    // embers fly to the flame number
    const a = $('flame-num').getBoundingClientRect(), b = boardCv.getBoundingClientRect();
    R.setHudTarget(a.left + a.width / 2 - b.left, a.top + a.height / 2 - b.top);
  }
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (screen === 'run') {
      if (state && !sheet) {
        if (pending && now >= lockUntil) { const a = pending; pending = null; doAct(a); }
        else if (auto && now >= lockUntil) autoStep();
      }
      R.frame(now);
    } else if (screen === 'title') R.drawPortrait(titleCv, now, 10, 10, false);
    else R.drawPortrait(sumCv, now, sumWon ? 10 : 0, 10, !sumWon);
  }
  function startLoop() { if (!raf) raf = requestAnimationFrame(tick); }
  function stopLoop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  // Hidden: save, stop drawing. Shown again: carry on.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { saveRun(); stopLoop(); }
    else { startLoop(); layout(); }
  });
  window.addEventListener('pagehide', saveRun);
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', () => setTimeout(layout, 120));

  // ---------- boot ----------
  R.attach(boardCv);
  R.resize(48, Math.min(3, window.devicePixelRatio || 1));      // builds the shared sprites; the real size comes with the first layout
  lastTile = 0;
  try { R.setReduced(window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { /* no matchMedia */ }
  refreshTitle();
  show('title');
  startLoop();

  // A small handle for tests and for poking at the game from the console.
  window.Wickbound = {
    get state() { return state; }, get meta() { return meta; }, get screen() { return screen; }, get sheet() { return sheet; },
    act: act, store: store, version: C.VERSION,
    load: s => { state = s; enterRun(false); }
  };
})();
