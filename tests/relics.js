/* Wickbound: what each relic is worth on its own.   node tests/relics.js [runs] [strategy]
 *
 * Every altar is emptied and the Wick simply starts with the relics being tried, so the only
 * difference between rows is the relic. Used to look for relics, or pairs of them, that make flame
 * effectively endless.
 */
'use strict';
const C = require('../config.js');
const E = require('../engine.js');
const B = require('./bot.js');

const runs = parseInt(process.argv[2], 10) || 100, strat = process.argv[3] || 'stealth';
const median = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const spend = s => { s.altars.forEach(a => (a.used = true)); return s; };

function trial(label, relics) {
  let wins = 0;
  const depth = [], burn = [], hurt = [], turns = [], flameLeft = [];
  for (let k = 0; k < runs; k++) {
    let s = E.clone(E.newRun({ seed: E.hash32(k, 555), wick: 1 }));
    s.relics = relics.slice();
    spend(s); E._refresh(s);
    const mem = { turns: 0, idle: 0 };
    let burned = 0, guard = 0;
    while (s.mode === 'play' && guard++ < 30000) {
      if (mem.idle > 300) { s = E.step(s, { t: 'abandon' }).state; break; }
      let r = E.step(s, B.decide(s, strat, mem));
      if (!r.changed) r = E.step(s, { t: 'wait' });
      if (r.turn) {
        mem.turns++;
        const n = r.state;
        const progress = n.floor !== s.floor || n.stats.kills !== s.stats.kills || n.stats.braziers !== s.stats.braziers || n.stats.embers !== s.stats.embers || n.stats.chests !== s.stats.chests || n.mode === 'won';
        mem.idle = progress ? 0 : mem.idle + 1;
        for (const e of r.events) if (e.e === 'burn') burned++;
        if (n.floor !== s.floor && n.mode === 'play') spend(n);
      }
      s = r.state;
    }
    if (s.mode === 'won') { wins++; flameLeft.push(s.p.flame); }
    depth.push(s.floor); burn.push(100 * burned / Math.max(1, s.stats.turns)); hurt.push(s.stats.hurt); turns.push(s.stats.turns);
  }
  console.log(label.padEnd(24) + ' cleared ' + String(Math.round(100 * wins / runs)).padStart(3) + '%   mean floor ' + mean(depth).toFixed(1).padStart(4) +
    '   burn per 100 turns ' + mean(burn).toFixed(1).padStart(4) + '   flame lost to hits ' + mean(hurt).toFixed(1).padStart(5) + '   turns ' + String(median(turns)).padStart(4) +
    (flameLeft.length ? '   flame left when cleared ' + median(flameLeft) : ''));
}

console.log(strat + ' bot, ' + runs + ' runs each, altars removed, build ' + C.VERSION);
trial('no relics', []);
for (const id of Object.keys(C.RELICS)) trial(C.RELICS[id].name, [id]);
trial('Hooded + Slow Burn', ['hooded', 'slowburn']);
trial('Hooded + Hearthstone', ['hooded', 'hearth']);
trial('Hooded + Slow + Hearth', ['hooded', 'slowburn', 'hearth']);
trial('Jar + Greedy + Tinderbox', ['jar', 'greedy', 'tinderbox']);
trial('every relic', Object.keys(C.RELICS));
