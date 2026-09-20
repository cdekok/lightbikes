# Lightbikes

A two-player, same-keyboard lightcycle duel in the browser. Your bike leaves a solid light trail; make the other player crash into it.

No build step and no dependencies: open `index.html` in a browser and play.

## Controls

| Action | Player 1 (cyan) | Player 2 (orange) |
|---|---|---|
| Steer | `W` `A` `S` `D` | Arrow keys |
| Fire rocket | `E` | `0` (or numpad `0`) |
| Fire laser | `Q` | `Enter` |

Global keys: `Space` start / next round / new match, `P` pause, `M` mute.

## Rules

- Bikes move constantly and can only turn 90°. Up to two quick turns are queued, so tight corners aren't dropped.
- You crash if you hit a wall, any trail (yours or theirs), or the other bike head-on. A simultaneous crash is a draw.
- First to **3 round wins** takes the match.

## Weapons

**Rockets** — each bike gets 3 per round.
- Fly straight ahead at 3x bike speed.
- Hitting any trail punches a 3x3 hole that bikes can drive through.
- A direct hit on the other bike destroys it. Your own rockets never hurt you.
- Two rockets from different players that collide explode harmlessly, with no hole and no damage.

**Laser** — a one-shot powerup.
- A glowing bolt spawns at a random free spot. Drive over it to pick it up (you get a pulsing halo, and the HUD bolt lights up).
- Firing cuts every trail cell in a straight line from your nose to the wall, leaving a 1-cell gap.
- It only cuts trails; it does not hurt bikes.
- One pickup exists at a time, and unused lasers reset each round.

## Files

- `index.html` — page shell (loads the Orbitron font from Google Fonts; falls back to monospace offline)
- `style.css` — page styling
- `game.js` — all game logic, rendering and synthesized sound (WebAudio, no audio files)

## Tuning

Constants at the top of `game.js`:

- `TICK_MS` — bike speed (lower is faster)
- `WIN_SCORE` — rounds needed to win a match
- `ROCKETS` — rockets per round
- `ROCKET_STEPS` — rocket speed in cells per tick
- `COLS` / `ROWS` — arena size

Other tweaks: the hole size is the `dx`/`dy` range in `punchHole`, and powerup spawn timing is the `randInt` calls for `spawnIn`.
