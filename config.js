/* Wickbound: tuning and content.
 *
 * Every balance number lives in CONFIG. Every piece of content (candles, enemies, relics, zones, text)
 * lives in the tables below it. The engine reads these and nothing else, so you can retune the game or
 * add content here without touching the rules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WICK_CONFIG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '0.1.0';

  // ------------------------------------------------------------------------------------------
  // CONFIG: all balance numbers
  // ------------------------------------------------------------------------------------------
  var CONFIG = {
    version: VERSION,
    stage: 1,            // build stage (1 = the core)
    saveVersion: 1,      // bump when the shape of a saved run changes

    board: { w: 7, h: 9 },
    run: { floors: 12 },   // clearing the last floor ends the run

    light: {
      // [flame at least, light radius]
      bands: [[1, 1], [3, 2], [6, 3], [9, 4], [12, 5]],
      reach: 0.5,            // a tile is lit if its centre is within radius + reach of a light
      brazierRadius: 2
    },

    wake: {
      settleTurns: 3,        // dark turns in a row before a stirring sleeper settles again
      peekCounts: true       // uncovering the flame mid-turn counts as lit for that turn's wake check
    },

    flame: { ember: 1, chest: 3 },   // flame per ember, flame per chest

    sparks: {
      flare:  { cost: 1, range: 4, damage: 1 },
      dazzle: { cost: 2, turns: 2 }   // enemy turns skipped, counting the turn Dazzle is used
    },

    oil: { burnTurns: 3, damage: 1 },

    altar: {
      offers: 3,
      price:  { common: 1, uncommon: 2, rare: 3 },   // one of the three is always free
      weight: { common: 6, uncommon: 3, rare: 1 }
    },

    relics: {
      tongsFlame: 2,         // Firekeeper's Tongs
      greedyReach: 2,        // Greedy Wick, in steps
      jarEvery: 3,           // Ember Jar
      lastGaspStun: 1
    },

    gen: {
      maxAttempts: 200,
      walls: [8, 14],                      // min, max wall tiles
      mirrorChance: 0.5,                   // chance a floor's walls are mirrored left to right
      braziers: [[1, 1], [3, 2], [8, 3]],  // [from floor, count]
      oilPools: [[1, 0, 1], [2, 1, 2], [5, 1, 3]],   // [from floor, min pools, max pools]
      oilPoolSize: [2, 5],
      chests: [[1, 0, 2]],                 // [from floor, min, max]
      enemyBudget: { base: 3, perFloor: 2, max: 40 },   // floor 1: 3, floor 2: 5, floor 3: 7 ...
      maxEnemies: 12,
      safeSteps: 3,                        // enemies never start within this many steps of the start
      clusterChance: 0.35                  // chance an enemy is placed beside another
    },

    score: { floor: 100, brazier: 25, kill: 10, flame: 5, win: 500 },

    // Feel: animation timings in milliseconds. All motion is time-based.
    feel: {
      playerMs: 64, enemyMs: 64, worldMs: 30,
      hitPauseMs: 36, shakeMs: 170, lightEaseMs: 110, bloomMs: 520,
      deathMs: 900, particles: 150, longPressMs: 420, swipePx: 18, autoWalkMs: 95
    }
  };

  // ------------------------------------------------------------------------------------------
  // Candles: the playable characters
  // ------------------------------------------------------------------------------------------
  var CANDLES = {
    tallow: {
      name: 'Tallow', max: 10, burnEvery: 10, lightMod: 0, strike: 1, sneakMult: 2, spark: 'dazzle',
      text: 'The all-rounder.'
    }
  };

  var SPARKS = {
    flare:  { name: 'Flare',  text: 'A spark flies up to 4 tiles in a line: 1 damage to the first enemy, lights oil and braziers. Uncups you.' },
    dazzle: { name: 'Dazzle', text: 'Every awake enemy in your light loses this turn and the next. Uncups you.' }
  };

  // ------------------------------------------------------------------------------------------
  // Enemies
  //   pattern: 'adjacent' (the four tiles beside it) or 'line' (its row and column, up to range)
  //   ai:      'chase' or 'archer'
  //   period:  acts every Nth turn (default 1)
  //   cost / minFloor / weight: used by the floor generator's budget
  // ------------------------------------------------------------------------------------------
  var ENEMIES = {
    gnawer: {
      name: 'Gnawer', hp: 1, dmg: 1, embers: 1, pattern: 'adjacent', ai: 'chase',
      cost: 1, minFloor: 1, weight: 4,
      text: 'A bone rat. Bites whatever stands beside it.',
      tip: 'Whoever steps next to the other gets hit first. Let it come to you.'
    },
    ooze: {
      name: 'Tallow Ooze', hp: 3, dmg: 1, embers: 2, pattern: 'adjacent', ai: 'chase', period: 2,
      cost: 2, minFloor: 2, weight: 2,
      text: 'Slow wax with a grudge. Acts every other turn and drops two embers.',
      tip: 'It rests after every action. That is when you hit it.'
    },
    beetle: {
      name: 'Tinder Beetle', hp: 1, dmg: 1, embers: 1, pattern: 'adjacent', ai: 'chase',
      explode: { dmg: 2 },
      cost: 2, minFloor: 2, weight: 2,
      text: 'Bursts when it dies: 2 damage to the four tiles around it, and it lights oil.',
      tip: 'Flare it from range, or let it die beside its friends.'
    },
    archer: {
      name: 'Bone Archer', hp: 2, dmg: 2, embers: 1, pattern: 'line', range: 5, ai: 'archer',
      cost: 3, minFloor: 3, weight: 2,
      text: 'Shoots along its row or column, up to 5 tiles. Walls block the shot.',
      tip: 'It lines up instead of chasing. Step out of line and it wastes a turn.'
    }
  };

  // ------------------------------------------------------------------------------------------
  // Relics.  icon: an SVG path on a 24x24 grid, drawn as a line icon.
  // ------------------------------------------------------------------------------------------
  var RELICS = {
    mirror: {
      name: 'Mirror Shard', rarity: 'common', build: 'bright',
      text: '+1 light radius.',
      icon: 'M8 3L17 7L15 21L6 14Z M10.5 8.5L13 15'
    },
    sunstone: {
      name: 'Sunstone', rarity: 'common', build: 'bright',
      text: 'Strikes deal +1 while your flame is at max.',
      icon: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8Z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2'
    },
    beacon: {
      name: 'Beacon Oil', rarity: 'common', build: 'bright',
      text: 'An enemy that wakes inside your light loses its first turn.',
      icon: 'M9 10h6l2 10H7Z M10 10V7h4v3 M12 2v2 M6.5 3.5L8 5 M17.5 3.5L16 5'
    },
    smoulder: {
      name: 'Smoulder', rarity: 'common', build: 'dark',
      text: 'Strikes deal +1 while you are at half flame or less.',
      icon: 'M4 19a8 6 0 0 1 16 0Z M12 10c-2.5-2 2.5-4 0-7'
    },
    hooded: {
      name: 'Hooded Wick', rarity: 'uncommon', build: 'dark',
      text: 'The burn is paused while you are cupped.',
      icon: 'M12 3C6 3 5 10 5 21h14C19 10 18 3 12 3Z M9 21c0-7 6-7 6 0'
    },
    lastgasp: {
      name: 'Last Gasp', rarity: 'rare', build: 'dark',
      text: 'Once per floor, a hit that would snuff you leaves you on 1 flame and stuns everything beside you.',
      icon: 'M12 21c-4 0-6-3-6-6c0-4 4-5 6-12c2 7 6 8 6 12c0 3-2 6-6 6Z M12 11v4 M12 17.5v.5'
    },
    jar: {
      name: 'Ember Jar', rarity: 'common', build: 'ember',
      text: 'Every third ember is worth 2.',
      icon: 'M8 3h8 M9 3v3c-3 1-4 4-4 7c0 5 3 8 7 8s7-3 7-8c0-3-1-6-4-7V3 M12 11l2.5 3L12 17l-2.5-3Z'
    },
    greedy: {
      name: 'Greedy Wick', rarity: 'common', build: 'ember',
      text: 'Embers within 2 steps fly to you at the end of your turn.',
      icon: 'M5 4v8a7 7 0 0 0 14 0V4h-4v8a3 3 0 0 1-6 0V4Z M5 8h4 M15 8h4'
    },
    tongs: {
      name: "Firekeeper's Tongs", rarity: 'uncommon', build: 'brazier',
      text: 'Lighting a brazier gives +2 flame.',
      icon: 'M8 2L15 22 M16 2L9 22 M10.2 9h3.6 M7 2h2 M15 2h2'
    },
    hearth: {
      name: 'Hearthstone', rarity: 'uncommon', build: 'brazier',
      text: "Inside a brazier's light the burn is paused and your strikes deal +1.",
      icon: 'M4 21V12a8 8 0 0 1 16 0v9Z M12 18.5c-2 0-3-1.3-3-2.8c0-2 2-2.4 3-5.2c1 2.8 3 3.2 3 5.2c0 1.5-1 2.8-3 2.8Z'
    },
    tinderbox: {
      name: 'Tinderbox', rarity: 'common', build: 'fire',
      text: 'Enemies killed by fire drop an extra ember.',
      icon: 'M4 10h16v10H4Z M4 10l3-5h10l3 5 M12 12.5v5 M9.5 15h5'
    },
    waxseal: {
      name: 'Wax Seal', rarity: 'uncommon', build: 'fire',
      text: "Fire and explosions don't hurt you.",
      icon: 'M12 3a8 8 0 1 0 0 16a8 8 0 1 0 0-16Z M12 7.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7Z M8.5 18L7 22l3-1.5 M15.5 18L17 22l-3-1.5'
    },
    slowburn: {
      name: 'Slow Burn', rarity: 'common', build: 'tempo',
      text: "Waiting doesn't advance the burn.",
      icon: 'M7 3h10 M7 21h10 M8 3c0 5 8 5 8 9s-8 4-8 9 M16 3c0 5-8 5-8 9s8 4 8 9'
    }
  };

  // ------------------------------------------------------------------------------------------
  // Zones
  // ------------------------------------------------------------------------------------------
  var ZONES = {
    ossuary: {
      name: 'The Ossuary', short: 'Ossuary', hazard: 'oil',
      enemies: ['gnawer', 'ooze', 'beetle', 'archer'],
      lines: [
        'The Ossuary. Everyone here was somebody’s candle.',
        'Bones don’t mind the dark. You do.',
        'Something down here is asleep. Keep it that way, or don’t.',
        'The Chandlers said it would be quick. They did not say for whom.',
        'Deeper. The stone is warm where the last Wick stood.'
      ]
    }
  };

  // ------------------------------------------------------------------------------------------
  // Text: one-liners only
  // ------------------------------------------------------------------------------------------
  var TEXT = {
    title: 'Wickbound',
    quips: [
      'No Wick has come back. You are next.',
      'The Chandlers pour. The Undercroft takes.',
      'Burn briefly. Burn well.',
      'Somewhere below, a lantern waits. So does everything else.',
      'Mind the dark. It minds you.'
    ],
    toast: {
      sealed: 'The stair is sealed. Light every brazier.',
      unseal: 'The stair opens.',
      lastFlame: 'You can’t spend your last flame.',
      altarSpent: 'The altar is spent.',
      aim: 'Flare: swipe or tap a direction.',
      aimCancel: 'Flare put away.',
      noDir: 'Nothing that way to burn.',
      noDazzle: 'Nothing awake in your light to dazzle.',
      max: 'Flame is full. The ember stays for later.'
    },
    // {w} is replaced with "Wick the 13th"
    epitaph: {
      brief:     ['{w} burned briefly.'],
      burn:      ['{w} ran out of candle.', '{w} burned down to nothing, as candles do.'],
      gnawer:    ['{w} was gnawed out.', '{w} fed the rats.'],
      ooze:      ['{w} was folded back into the tallow.'],
      beetle:    ['{w} stood too close to a Tinder Beetle.'],
      explosion: ['{w} went out with a bang. Not its own.'],
      archer:    ['{w} was pinned to the dark by a Bone Archer.'],
      fire:      ['{w} melted in its own bright idea.'],
      abandoned: ['{w} was pinched out before it could disappoint anyone.'],
      won:       ['{w} reached the bottom of everything dug so far.'],
      generic:   ['{w} went dark.']
    },
    causes: {
      burn: 'ran out of flame', fire: 'burning oil', explosion: 'an explosion', abandoned: 'pinched out'
    }
  };

  return {
    VERSION: VERSION, CONFIG: CONFIG, CANDLES: CANDLES, SPARKS: SPARKS, ENEMIES: ENEMIES,
    RELICS: RELICS, ZONES: ZONES, TEXT: TEXT
  };
});
