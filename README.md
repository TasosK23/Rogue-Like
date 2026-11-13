# Wickbound

A turn-based dungeon roguelike for one thumb. You are a Wick: a small living candle sent down into
the Undercroft. Your flame is your health, your sight, your clock and your money, so every decision
is some version of "how much of my own life is this worth?"

This is **stage 1 of 3: the core** (v0.1.0). It has the Tallow candle, the Ossuary and its four
enemies, oil, embers, chests, braziers, altars with 13 relics, Flare and Dazzle, death, the run
summary, and save and resume. Until the bosses and the other two zones arrive in stage 2, a run is
twelve Ossuary floors.

## Playing

- **Swipe** anywhere to move. Move into things to strike them, light them or open them.
- **Tap yourself** to wait. **Tap a far tile** to walk there while nothing is awake.
- **Hold** on anything to see what it is and where it can hurt you.
- **Red tiles** are where you would be hit if you ended your turn there.
- **Cup** is free: it hides your light from sleepers, and everything from you.
- **Flare**: tap the button, then swipe or tap a direction. Tap the button again to put it away.

At a desk: arrow keys or WASD move, Space waits, C cups, F aims a Flare, E is Dazzle, Esc pauses.

## Putting it on a phone

The game is a folder of static files. Serve the repository with GitHub Pages (Settings, Pages,
"Deploy from a branch", `main`, `/ (root)`), open `https://<you>.github.io/<repo>/` in Chrome on
the phone, and choose "Add to Home screen" from Chrome's menu.

There is no service worker yet (it is the last thing in stage 3, so caching cannot fight the game
while it is changing). Until then the game needs a connection to load, and after an update GitHub
Pages can keep serving the old files for about ten minutes.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page and all its CSS |
| `config.js` | Every balance number and all content: candles, enemies, relics, text |
| `engine.js` | The rules. Pure: no DOM, no clock, no `Math.random`. `step(state, action)` returns a new state and a list of events |
| `render.js` | Draws the board on a canvas and plays the engine's events as animation |
| `ui.js` | Screens, touch input, saving |
| `manifest.webmanifest`, `icon-*.png` | So it installs to the home screen |
| `version.json` | The build version (the update check that reads it arrives with the service worker) |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are |
| `tests/` | Headless tests and the tuning bot. The game does not load these |

There is no build step and nothing is fetched from anywhere else. Every URL is relative, so the game
works from a sub-path such as `https://<you>.github.io/<repo>/`.

GitHub Pages serves all of one account's sites from the same origin, which means they share
`localStorage`. Wickbound only ever touches keys that start with `wickbound:`.

## Running it locally

Any static file server will do:

    python3 -m http.server 8000

then open `http://localhost:8000/`.

## Tests

    node tests/test.js            # rules, 48,000 floors, 1,500 random runs, bot runs, replay and save/resume, fairness
    node tests/test.js --quick    # the same, smaller
    node tests/bot.js 300         # the tuning bot: 300 runs for each of four ways of using the cup
    node tests/relics.js 100      # what each relic is worth on its own, and the burn-pausing combinations
    node tests/browser.js         # needs Playwright: plays through every screen with touch events and screenshots them

## Tuning

Change numbers in `CONFIG` at the top of `config.js`. Add or edit enemies and relics in the tables
below it. When you change anything, bump the version in three places, which `tests/test.js` checks
agree: `VERSION` in `config.js`, `version.json`, and the `?v=` on the script tags in `index.html`.
