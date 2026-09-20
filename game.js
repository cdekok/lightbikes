(() => {
  // Arena size adapts to the screen shape (see resize); it is fixed for the duration of a match round.
  const TARGET_CELLS = 4000; // roughly the area of the classic 80x50 arena
  let COLS = 80;
  let ROWS = 50;
  let gridLocked = false;
  const HUD_FULL = 48;
  let HUD = HUD_FULL; // height of the score strip above the arena (0 in compact mode)
  let compact = false; // small screens: no strip, slim score overlay on top of the arena
  const TICK_MS = 70;
  const WIN_SCORE = 3;
  const COUNTDOWN_MS = 800;
  const ROCKETS = 3;
  const ROCKET_STEPS = 3; // cells per tick, i.e. 3x bike speed

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  let cell = 10;
  let overlay = null;
  let renderT = 1;
  let CW = 0; // logical canvas size (CSS px)
  let CH = 0;
  let uiScale = 1;
  // Touch UI is on for touch-first devices (phones, iPads) and switches on at the first touch.
  let touchMode = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

  function resize(regrid) {
    const dpr = window.devicePixelRatio || 1;
    const vw = window.innerWidth;
    compact = Math.min(vw, window.innerHeight) < 600;
    HUD = compact ? 0 : HUD_FULL;
    const availH = Math.max(100, window.innerHeight - HUD);
    if (regrid || !gridLocked) {
      // Pick a cell size that gives ~TARGET_CELLS cells, then fill the screen shape with them.
      const c = Math.max(5, Math.sqrt((vw * availH) / TARGET_CELLS));
      COLS = Math.max(30, Math.min(140, Math.floor(vw / c)));
      ROWS = Math.max(20, Math.min(100, Math.floor(availH / c)));
    }
    const fit = Math.min(vw / COLS, availH / ROWS);
    cell = Math.max(3, Math.floor(fit * dpr) / dpr);
    CW = COLS * cell;
    CH = ROWS * cell + HUD;
    canvas.width = Math.round(CW * dpr);
    canvas.height = Math.round(CH * dpr);
    canvas.style.width = `${CW}px`;
    canvas.style.height = `${CH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    uiScale = Math.min(1, CW / 900);
    buildOverlay();
  }
  window.addEventListener('resize', () => resize(false));
  window.addEventListener('orientationchange', () => resize(false));
  resize();

  // --- Sound (WebAudio, synthesized; no asset files) ---
  let audio = null;
  let muted = false;

  function initAudio() {
    if (audio) { if (audio.state === 'suspended') audio.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audio = new AC();
  }

  function tone(freq, dur, { type = 'square', vol = 0.08, slideTo = null, delay = 0 } = {}) {
    if (!audio || muted) return;
    const t = audio.currentTime + delay;
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(audio.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function noise(dur, vol = 0.2) {
    if (!audio || muted) return;
    const len = Math.floor(audio.sampleRate * dur);
    const buf = audio.createBuffer(1, len, audio.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = audio.createBufferSource();
    const g = audio.createGain();
    const filter = audio.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1200;
    g.gain.value = vol;
    src.buffer = buf;
    src.connect(filter).connect(g).connect(audio.destination);
    src.start();
  }

  const sfx = {
    turn: (i) => tone(i === 0 ? 660 : 520, 0.05, { type: 'square', vol: 0.04 }),
    count: () => tone(440, 0.15, { type: 'sine', vol: 0.15 }),
    go: () => tone(880, 0.35, { type: 'sine', vol: 0.18 }),
    crash: () => { noise(0.5, 0.35); tone(160, 0.5, { type: 'sawtooth', vol: 0.15, slideTo: 30 }); },
    roundWin: () => [523, 659, 784].forEach((f, k) => tone(f, 0.15, { type: 'triangle', vol: 0.15, delay: k * 0.12 })),
    matchWin: () => [523, 659, 784, 1047, 784, 1047].forEach((f, k) => tone(f, 0.2, { type: 'triangle', vol: 0.18, delay: k * 0.14 })),
    fire: () => { noise(0.15, 0.1); tone(300, 0.25, { type: 'sawtooth', vol: 0.08, slideTo: 1200 }); },
    hit: () => { noise(0.3, 0.25); tone(220, 0.25, { type: 'square', vol: 0.1, slideTo: 60 }); },
    pickup: () => [660, 880, 1320].forEach((f, k) => tone(f, 0.12, { type: 'triangle', vol: 0.14, delay: k * 0.07 })),
    spawn: () => tone(1000, 0.12, { type: 'sine', vol: 0.06 }),
    laser: () => { noise(0.4, 0.2); tone(2400, 0.45, { type: 'sawtooth', vol: 0.12, slideTo: 120 }); },
    dud: () => tone(120, 0.08, { type: 'square', vol: 0.05 }),
    draw: () => [392, 330].forEach((f, k) => tone(f, 0.2, { type: 'triangle', vol: 0.15, delay: k * 0.15 })),
  };

  const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

  const DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };

  const KEYMAP = {
    KeyW: [0, 'up'], KeyA: [0, 'left'], KeyS: [0, 'down'], KeyD: [0, 'right'],
    ArrowUp: [1, 'up'], ArrowLeft: [1, 'left'], ArrowDown: [1, 'down'], ArrowRight: [1, 'right'],
  };

  const FIRE = { KeyE: 0, Digit0: 1, Numpad0: 1 };
  const LASER = { KeyQ: 0, Enter: 1, NumpadEnter: 1 };

  const PLAYERS = [
    { name: 'P1', color: '#19e6ff', rgb: '25,230,255' },
    { name: 'P2', color: '#ff7a1a', rgb: '255,122,26' },
  ];

  // state: 'menu' | 'countdown' | 'playing' | 'roundOver' | 'matchOver'
  let state = 'menu';
  let grid;
  let bikes;
  let scores = [0, 0];
  let message = '';
  let countdownEnd = 0;
  let lastTick = 0;
  let paused = false;
  let lastCount = 0;
  let particles = [];
  let rings = [];
  let rockets = [];
  let lasers = [];
  let powerup = null;
  let spawnIn = 0;
  let cellPt = [];
  let shake = 0;

  function newRound() {
    resize(true); // re-fit the arena to the current screen shape
    gridLocked = true;
    grid = new Uint8Array(COLS * ROWS);
    cellPt = new Array(COLS * ROWS).fill(null);
    rockets = [];
    lasers = [];
    powerup = null;
    spawnIn = randInt(50, 110);
    const y = Math.floor(ROWS / 2);
    bikes = [
      { x: Math.floor(COLS * 0.2), y, dir: 'right', queue: [], alive: true },
      { x: Math.floor(COLS * 0.8) - 1, y, dir: 'left', queue: [], alive: true },
    ];
    bikes.forEach((b, i) => {
      grid[b.y * COLS + b.x] = i + 1;
      b.px = b.x;
      b.py = b.y;
      b.rockets = ROCKETS;
      b.laser = false;
      const pt = { x: b.x, y: b.y, gone: false };
      b.trail = [pt];
      cellPt[b.y * COLS + b.x] = pt;
      b.angle = Math.atan2(DIRS[b.dir].y, DIRS[b.dir].x);
    });
    particles = [];
    rings = [];
    shake = 0;
    state = 'countdown';
    countdownEnd = performance.now() + COUNTDOWN_MS * 3;
    lastCount = 0;
    lastTick = 0;
  }

  function startMatch() {
    scores = [0, 0];
    newRound();
  }

  function isOpposite(a, b) {
    return DIRS[a].x + DIRS[b].x === 0 && DIRS[a].y + DIRS[b].y === 0;
  }

  window.addEventListener('keydown', (e) => {
    if (KEYMAP[e.code] || e.code === 'Space') e.preventDefault();
    initAudio();

    if (e.code === 'KeyM') {
      muted = !muted;
      return;
    }

    if (LASER[e.code] !== undefined) {
      e.preventDefault();
      if (!e.repeat && bikes) fireLaser(LASER[e.code]);
      return;
    }

    if (FIRE[e.code] !== undefined) {
      e.preventDefault();
      if (!e.repeat && bikes) fireRocket(FIRE[e.code]);
      return;
    }

    if (e.code === 'Space') {
      advance();
      return;
    }
    if (e.code === 'KeyP') {
      togglePause();
      return;
    }
    const m = KEYMAP[e.code];
    if (m) steer(m[0], m[1]);
  });

  function advance() {
    if (state === 'menu' || state === 'matchOver') startMatch();
    else if (state === 'roundOver') newRound();
  }

  function togglePause() {
    if (state === 'playing') paused = !paused;
  }

  function steer(idx, dir) {
    if (!bikes) return;
    const b = bikes[idx];
    if (!b.alive || (state !== 'playing' && state !== 'countdown')) return;
    // Validate against the last queued direction so a fast double-tap
    // can never reverse the bike into its own trail.
    const ref = b.queue.length ? b.queue[b.queue.length - 1] : b.dir;
    if (dir === ref || isOpposite(dir, ref)) return;
    if (b.queue.length < 2) {
      b.queue.push(dir);
      sfx.turn(idx);
    }
  }

  // --- Touch / pointer input ---
  // Swipe on the left half steers P1, on the right half steers P2. Round buttons fire weapons.
  const SWIPE_PX = 18;
  const pointers = new Map();
  const flashes = {};

  function touchButtons() {
    const bottom = CH;
    const r = Math.max(30, Math.min(48, cell * 3.4));
    const m = compact ? r * 0.3 : r * 0.5;
    const y = bottom - m - r;
    return [
      { id: 'rocket0', kind: 'rocket', player: 0, x: m + r, y, r },
      { id: 'laser0', kind: 'laser', player: 0, x: m + r + r * 2.3, y, r },
      { id: 'rocket1', kind: 'rocket', player: 1, x: CW - m - r, y, r },
      { id: 'laser1', kind: 'laser', player: 1, x: CW - m - r - r * 2.3, y, r },
      { id: 'pause', kind: 'pause', x: CW / 2, y: bottom - m - r * 0.7, r: r * 0.7 },
    ];
  }

  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (CW / rect.width), y: (e.clientY - rect.top) * (CH / rect.height) };
  }

  function goFullscreen() {
    const el = document.documentElement;
    if (document.fullscreenElement || !el.requestFullscreen) return;
    el.requestFullscreen({ navigationUI: 'hide' })
      .then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'))
      .catch(() => {}); // unsupported (e.g. iPhone Safari) or denied: just keep playing
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    initAudio();
    if (e.pointerType === 'touch') touchMode = true;
    if (state === 'menu' || state === 'roundOver' || state === 'matchOver') {
      advance();
      return;
    }
    const { x, y } = pointerPos(e);
    if (touchMode && bikes) {
      const btn = touchButtons().find((b) => Math.hypot(x - b.x, y - b.y) <= b.r * 1.2);
      if (btn) {
        flashes[btn.id] = performance.now() + 150;
        if (btn.kind === 'rocket') fireRocket(btn.player);
        else if (btn.kind === 'laser') fireLaser(btn.player);
        else togglePause();
        return;
      }
    }
    if (paused) { togglePause(); return; }
    pointers.set(e.pointerId, { player: x < CW / 2 ? 0 : 1, sx: x, sy: y });
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const { x, y } = pointerPos(e);
    const dx = x - p.sx;
    const dy = y - p.sy;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return;
    steer(p.player, Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
    // Re-anchor so a continuous drag can chain several turns.
    p.sx = x;
    p.sy = y;
  });

  const endPointer = (e) => pointers.delete(e.pointerId);
  canvas.addEventListener('pointerup', (e) => {
    endPointer(e);
    // Fullscreen needs a completed gesture (pointerup), not pointerdown, to count as user activation.
    if (e.pointerType === 'touch') goFullscreen();
  });
  canvas.addEventListener('pointercancel', endPointer);
  document.addEventListener('gesturestart', (e) => e.preventDefault()); // block iOS pinch-zoom
  document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'playing') paused = true; });

  function fireRocket(i) {
    if (state !== 'playing' || paused) return;
    const b = bikes[i];
    if (!b.alive) return;
    if (b.rockets <= 0) { sfx.dud(); return; }
    b.rockets--;
    const d = DIRS[b.dir];
    rockets.push({ x: b.x, y: b.y, px: b.x, py: b.y, dx: d.x, dy: d.y, owner: i });
    sfx.fire();
  }

  function clearCell(x, y) {
    const idx = y * COLS + x;
    grid[idx] = 0;
    if (cellPt[idx]) { cellPt[idx].gone = true; cellPt[idx] = null; }
  }

  // Instantly cuts every trail cell in a straight line from the bike's nose to the wall.
  function fireLaser(i) {
    if (state !== 'playing' || paused) return;
    const b = bikes[i];
    if (!b.alive || !b.laser) return;
    b.laser = false;
    const d = DIRS[b.dir];
    let x = b.x + d.x;
    let y = b.y + d.y;
    while (x >= 0 && x < COLS && y >= 0 && y < ROWS) {
      if (grid[y * COLS + x] !== 0) {
        clearCell(x, y);
        sparks(x, y, 8);
      }
      x += d.x;
      y += d.y;
    }
    lasers.push({
      x0: b.x + 0.5 + d.x * 0.5,
      y0: b.y + 0.5 + d.y * 0.5,
      x1: d.x > 0 ? COLS : d.x < 0 ? 0 : b.x + 0.5,
      y1: d.y > 0 ? ROWS : d.y < 0 ? 0 : b.y + 0.5,
      life: 1,
      owner: i,
    });
    shake = Math.max(shake, 0.5);
    sfx.laser();
  }

  function spawnPowerup() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const x = randInt(3, COLS - 4);
      const y = randInt(3, ROWS - 4);
      if (grid[y * COLS + x] !== 0) continue;
      if (bikes.some((b) => Math.abs(b.x - x) + Math.abs(b.y - y) < 8)) continue;
      powerup = { x, y };
      sfx.spawn();
      return;
    }
    spawnIn = 20; // no free spot right now; retry shortly
  }

  function punchHole(cx, cy) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue;
        clearCell(x, y);
      }
    }
    sparks(cx, cy, 35);
    rings.push({ x: cx + 0.5, y: cy + 0.5, r: 0.5, life: 0.8, color: '#ffb84a' });
    shake = Math.max(shake, 0.35);
    sfx.hit();
  }

  function sparks(x, y, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 0.03 + Math.random() * 0.35;
      particles.push({
        x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 1, decay: 0.03 + Math.random() * 0.03, size: 0.15 + Math.random() * 0.3,
        color: Math.random() < 0.4 ? '#ffffff' : '#ffb84a',
      });
    }
  }

  // Advances rockets one tick, one cell at a time so collisions are exact.
  // Returns which bikes were hit directly.
  function stepRockets() {
    const killed = [false, false];
    // A rocket only ever kills the *other* bike, never its owner.
    const hitsBike = (r) => {
      const t = 1 - r.owner;
      const b = bikes[t];
      if (b.alive && b.x === r.x && b.y === r.y) {
        killed[t] = true;
        sparks(r.x, r.y, 40);
        rings.push({ x: r.x + 0.5, y: r.y + 0.5, r: 0.5, life: 0.8, color: '#ffb84a' });
        return true;
      }
      return false;
    };

    rockets.forEach((r) => { r.px = r.x; r.py = r.y; r.dead = false; });
    // Covers a bike that drove into a rocket's cell since the last tick.
    rockets.forEach((r) => { if (hitsBike(r)) r.dead = true; });

    for (let s = 0; s < ROCKET_STEPS; s++) {
      const live = rockets.filter((r) => !r.dead);
      live.forEach((r) => {
        const nx = r.x + r.dx;
        const ny = r.y + r.dy;
        if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) {
          sparks(r.x, r.y, 12);
          sfx.dud();
          r.dead = true;
          return;
        }
        r.sx = r.x;
        r.sy = r.y;
        r.x = nx;
        r.y = ny;
      });

      // Rocket vs rocket: both detonate harmlessly (same cell, or passing through each other).
      for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
          const a = live[i];
          const c = live[j];
          if (a.dead || c.dead || a.owner === c.owner) continue;
          const same = a.x === c.x && a.y === c.y;
          const swap = a.x === c.sx && a.y === c.sy && c.x === a.sx && c.y === a.sy;
          if (same || swap) {
            a.dead = c.dead = true;
            sparks(a.x, a.y, 30);
            rings.push({ x: a.x + 0.5, y: a.y + 0.5, r: 0.5, life: 0.8, color: '#ffffff' });
            shake = Math.max(shake, 0.25);
            sfx.hit();
          }
        }
      }

      live.forEach((r) => {
        if (r.dead) return;
        if (hitsBike(r)) { r.dead = true; return; }
        if (grid[r.y * COLS + r.x] !== 0) {
          punchHole(r.x, r.y);
          r.dead = true;
          return;
        }
        sparks(r.x, r.y, 1);
      });
    }

    rockets = rockets.filter((r) => !r.dead);
    return killed;
  }

  function tick() {
    const killed = stepRockets();
    if (!powerup && --spawnIn <= 0) spawnPowerup();
    const next = bikes.map((b) => {
      if (b.queue.length) b.dir = b.queue.shift();
      const d = DIRS[b.dir];
      return { x: b.x + d.x, y: b.y + d.y };
    });

    const crashed = killed.slice();
    next.forEach((n, i) => {
      if (killed[i]) return;
      if (n.x < 0 || n.x >= COLS || n.y < 0 || n.y >= ROWS) crashed[i] = true;
      else if (grid[n.y * COLS + n.x] !== 0) crashed[i] = true;
    });
    // Head-on: both entering the same cell, or swapping cells.
    if (!killed[0] && !killed[1]) {
      if (next[0].x === next[1].x && next[0].y === next[1].y) crashed[0] = crashed[1] = true;
      if (next[0].x === bikes[1].x && next[0].y === bikes[1].y &&
          next[1].x === bikes[0].x && next[1].y === bikes[0].y) crashed[0] = crashed[1] = true;
    }

    bikes.forEach((b, i) => {
      if (crashed[i]) {
        b.alive = false;
        explode(b.x, b.y, PLAYERS[i].color);
      } else {
        b.px = b.x;
        b.py = b.y;
        b.x = next[i].x;
        b.y = next[i].y;
        grid[b.y * COLS + b.x] = i + 1;
        const pt = { x: b.x, y: b.y, gone: false };
        b.trail.push(pt);
        cellPt[b.y * COLS + b.x] = pt;
      }
    });

    if (powerup) {
      bikes.forEach((b) => {
        if (powerup && b.alive && b.x === powerup.x && b.y === powerup.y) {
          b.laser = true;
          rings.push({ x: powerup.x + 0.5, y: powerup.y + 0.5, r: 0.5, life: 0.8, color: '#b48cff' });
          sparks(powerup.x, powerup.y, 20);
          powerup = null;
          spawnIn = randInt(100, 200);
          sfx.pickup();
        }
      });
    }

    if (crashed[0] || crashed[1]) endRound(crashed);
  }

  function endRound(crashed) {
    rockets = [];
    powerup = null;
    sfx.crash();
    if (crashed[0] && crashed[1]) {
      message = 'DRAW';
      sfx.draw();
    } else {
      const winner = crashed[0] ? 1 : 0;
      scores[winner]++;
      message = `${PLAYERS[winner].name} WINS THE ROUND`;
      sfx.roundWin();
    }
    if (scores[0] >= WIN_SCORE || scores[1] >= WIN_SCORE) {
      const w = scores[0] >= WIN_SCORE ? 0 : 1;
      message = `${PLAYERS[w].name} WINS THE MATCH!`;
      state = 'matchOver';
      sfx.matchWin();
    } else {
      state = 'roundOver';
    }
  }

  function explode(x, y, color) {
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 0.05 + Math.random() * 0.6;
      particles.push({
        x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 1, decay: 0.012 + Math.random() * 0.02, size: 0.2 + Math.random() * 0.4,
        color: Math.random() < 0.3 ? '#ffffff' : color,
      });
    }
    rings.push({ x: x + 0.5, y: y + 0.5, r: 0.5, life: 1, color });
    shake = 1;
  }

  function update(now) {
    if (state === 'countdown') {
      const n = Math.ceil((countdownEnd - now) / COUNTDOWN_MS);
      if (n !== lastCount && n >= 1) sfx.count();
      lastCount = n;
      if (now >= countdownEnd) {
        state = 'playing';
        lastTick = now;
        sfx.go();
      }
    }
    if (state === 'playing' && !paused) {
      if (now - lastTick >= TICK_MS) {
        lastTick += TICK_MS;
        if (now - lastTick > TICK_MS * 4) lastTick = now; // avoid spiral after tab switch
        tick();
      }
    } else if (paused) {
      lastTick = now;
    }
    particles.forEach((p) => {
      p.x += p.vx; p.y += p.vy; p.vx *= 0.98; p.vy *= 0.98; p.life -= p.decay;
    });
    particles = particles.filter((p) => p.life > 0);
    rings.forEach((r) => { r.r += 0.6; r.life -= 0.03; });
    rings = rings.filter((r) => r.life > 0);
    lasers.forEach((l) => { l.life -= 0.05; });
    lasers = lasers.filter((l) => l.life > 0);
    shake *= 0.9;
    if (bikes) {
      // Smoothly rotate bike sprites toward their heading.
      bikes.forEach((b) => {
        const target = Math.atan2(DIRS[b.dir].y, DIRS[b.dir].x);
        let d = target - b.angle;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        b.angle += d * 0.35;
      });
    }
  }

  const FONT = '"Orbitron", "Courier New", monospace';

  function text(str, x, y, size, color, align = 'center', glow = 0) {
    ctx.fillStyle = color;
    ctx.font = `bold ${Math.max(8, size * uiScale)}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.shadowColor = color;
    ctx.shadowBlur = glow;
    ctx.fillText(str, x, y);
    ctx.shadowBlur = 0;
  }

  function buildOverlay() {
    const w = COLS * cell;
    const h = ROWS * cell;
    overlay = document.createElement('canvas');
    overlay.width = Math.round(w);
    overlay.height = Math.round(h);
    const o = overlay.getContext('2d');
    const v = o.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, w * 0.7);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.55)');
    o.fillStyle = v;
    o.fillRect(0, 0, w, h);
    o.fillStyle = 'rgba(0,0,0,0.12)';
    for (let y = 0; y < h; y += 3) o.fillRect(0, y, w, 1);
  }

  function drawBackground(now) {
    const w = COLS * cell;
    const h = ROWS * cell;
    const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.65);
    bg.addColorStop(0, '#0c1030');
    bg.addColorStop(1, '#03040b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    ctx.lineWidth = 1;
    for (let x = 0; x <= COLS; x += 2) {
      ctx.strokeStyle = x % 10 === 0 ? 'rgba(110,130,255,0.16)' : 'rgba(110,130,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(x * cell + 0.5, 0);
      ctx.lineTo(x * cell + 0.5, h);
      ctx.stroke();
    }
    for (let y = 0; y <= ROWS; y += 2) {
      ctx.strokeStyle = y % 10 === 0 ? 'rgba(110,130,255,0.16)' : 'rgba(110,130,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(0, y * cell + 0.5);
      ctx.lineTo(w, y * cell + 0.5);
      ctx.stroke();
    }

    // Slow scanning light band.
    const sy = ((now * 0.06) % (h + 120)) - 60;
    const band = ctx.createLinearGradient(0, sy - 60, 0, sy + 60);
    band.addColorStop(0, 'rgba(138,92,255,0)');
    band.addColorStop(0.5, 'rgba(138,92,255,0.07)');
    band.addColorStop(1, 'rgba(138,92,255,0)');
    ctx.fillStyle = band;
    ctx.fillRect(0, sy - 60, w, 120);
  }

  function drawTrail(b, p, hx, hy) {
    const pts = b.trail;
    const n = pts.length;
    const c = cell;
    const path = new Path2D();
    // Cells punched out by rockets are flagged `gone`; lifting the pen there leaves a gap.
    let pen = false;
    const add = (x, y, gone) => {
      if (gone) { pen = false; return; }
      if (pen) {
        path.lineTo(x, y);
      } else {
        path.moveTo(x, y);
        path.lineTo(x + 0.01, y); // lone cells still render as a dot
        pen = true;
      }
    };
    const end = b.alive ? n - 1 : n;
    for (let k = 0; k < end; k++) add((pts[k].x + 0.5) * c, (pts[k].y + 0.5) * c, pts[k].gone);
    if (b.alive) add(hx, hy, false);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const [wd, a] of [[1.8, 0.08], [1.1, 0.18], [0.6, 0.5]]) {
      ctx.lineWidth = c * wd;
      ctx.strokeStyle = `rgba(${p.rgb},${a})`;
      ctx.stroke(path);
    }
    ctx.lineWidth = c * 0.22;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke(path);
    ctx.restore();
  }

  // Top-down hypermodern lightcycle, drawn in "bike units" (length ~5.4).
  // The nose sits near the head cell so crashes look like they happen at the nose.
  function drawBike(x, y, angle, p, unit) {
    const col = p.color;
    const rgb = p.rgb;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(unit, unit);
    ctx.translate(-2.2, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Headlight beam + underglow (additive).
    ctx.globalCompositeOperation = 'lighter';
    const beam = ctx.createLinearGradient(2.7, 0, 8, 0);
    beam.addColorStop(0, `rgba(${rgb},0.3)`);
    beam.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(2.7, 0); ctx.lineTo(8, -1.8); ctx.lineTo(8, 1.8);
    ctx.closePath();
    ctx.fill();
    const glow = ctx.createRadialGradient(0, 0, 0.3, 0, 0, 3.6);
    glow.addColorStop(0, `rgba(${rgb},0.35)`);
    glow.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, 3.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    ctx.shadowColor = col;
    ctx.shadowBlur = unit * 0.8;

    // Wheels: dark tyres with neon rims and a glowing tread line.
    for (const [x0, x1, hw] of [[-2.7, -1.5, 0.55], [1.5, 2.7, 0.45]]) {
      ctx.beginPath();
      ctx.roundRect(x0, -hw, x1 - x0, hw * 2, 0.4);
      ctx.fillStyle = '#04050c';
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 0.1;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x0 + 0.2, 0);
      ctx.lineTo(x1 - 0.2, 0);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 0.06;
      ctx.stroke();
    }

    // Fuselage.
    const body = ctx.createLinearGradient(0, -0.8, 0, 0.8);
    body.addColorStop(0, '#20264a');
    body.addColorStop(0.5, '#0a0c1c');
    body.addColorStop(1, '#20264a');
    ctx.beginPath();
    ctx.moveTo(1.9, -0.2);
    ctx.lineTo(1.3, -0.5);
    ctx.lineTo(-0.4, -0.75);
    ctx.lineTo(-1.3, -0.6);
    ctx.lineTo(-2.0, -0.3);
    ctx.lineTo(-2.0, 0.3);
    ctx.lineTo(-1.3, 0.6);
    ctx.lineTo(-0.4, 0.75);
    ctx.lineTo(1.3, 0.5);
    ctx.lineTo(1.9, 0.2);
    ctx.closePath();
    ctx.fillStyle = body;
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 0.09;
    ctx.stroke();

    // Neon accent lines.
    ctx.strokeStyle = col;
    ctx.lineWidth = 0.07;
    ctx.beginPath();
    ctx.moveTo(1.2, -0.3); ctx.lineTo(-1.4, -0.3);
    ctx.moveTo(1.2, 0.3); ctx.lineTo(-1.4, 0.3);
    ctx.stroke();

    // Rear fins.
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(-1.3, -0.6); ctx.lineTo(-2.2, -1.05); ctx.lineTo(-2.0, -0.3);
    ctx.closePath();
    ctx.moveTo(-1.3, 0.6); ctx.lineTo(-2.2, 1.05); ctx.lineTo(-2.0, 0.3);
    ctx.closePath();
    ctx.fill();

    // Canopy.
    const can = ctx.createRadialGradient(-0.2, 0, 0.05, -0.2, 0, 0.9);
    can.addColorStop(0, '#ffffff');
    can.addColorStop(0.4, col);
    can.addColorStop(1, `rgba(${rgb},0.15)`);
    ctx.beginPath();
    ctx.ellipse(-0.2, 0, 0.9, 0.38, 0, 0, Math.PI * 2);
    ctx.fillStyle = can;
    ctx.fill();

    // Headlight.
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = unit * 1.2;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(1.85, 0, 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawRocket(x, y, angle, p) {
    const u = cell;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.globalCompositeOperation = 'lighter';
    const fl = ctx.createLinearGradient(0, 0, -u * 4, 0);
    fl.addColorStop(0, 'rgba(255,210,90,0.9)');
    fl.addColorStop(0.4, `rgba(${p.rgb},0.4)`);
    fl.addColorStop(1, 'rgba(255,120,20,0)');
    ctx.fillStyle = fl;
    ctx.beginPath();
    ctx.moveTo(0, -u * 0.25); ctx.lineTo(-u * 4, 0); ctx.lineTo(0, u * 0.25);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowColor = '#ffd27a';
    ctx.shadowBlur = u * 1.2;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(u * 0.9, 0); ctx.lineTo(u * 0.3, -u * 0.28); ctx.lineTo(-u * 0.6, -u * 0.28);
    ctx.lineTo(-u * 0.6, u * 0.28); ctx.lineTo(u * 0.3, u * 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.moveTo(-u * 0.6, -u * 0.28); ctx.lineTo(-u * 0.95, -u * 0.6); ctx.lineTo(-u * 0.2, -u * 0.28);
    ctx.moveTo(-u * 0.6, u * 0.28); ctx.lineTo(-u * 0.95, u * 0.6); ctx.lineTo(-u * 0.2, u * 0.28);
    ctx.fill();
    ctx.restore();
  }

  function boltPath(x, y, size) {
    const pts = [[0.15, -1], [-0.5, 0.1], [-0.05, 0.1], [-0.2, 1], [0.5, -0.15], [0.05, -0.15]];
    ctx.beginPath();
    pts.forEach(([px, py], k) => {
      if (k === 0) ctx.moveTo(x + px * size, y + py * size);
      else ctx.lineTo(x + px * size, y + py * size);
    });
    ctx.closePath();
  }

  function drawPowerup(now) {
    const x = (powerup.x + 0.5) * cell;
    const y = (powerup.y + 0.5) * cell;
    const pulse = 1 + 0.15 * Math.sin(now / 200);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(x, y, 0, x, y, cell * 3.5 * pulse);
    g.addColorStop(0, 'rgba(160,120,255,0.55)');
    g.addColorStop(1, 'rgba(160,120,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, cell * 3.5 * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowColor = '#b48cff';
    ctx.shadowBlur = cell * 1.2;
    ctx.translate(x, y);
    ctx.rotate(now / 500);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = cell * 0.18;
    ctx.strokeRect(-cell * 0.9 * pulse, -cell * 0.9 * pulse, cell * 1.8 * pulse, cell * 1.8 * pulse);
    ctx.rotate(-now / 500);
    ctx.fillStyle = '#ffffff';
    boltPath(0, 0, cell * 0.75);
    ctx.fill();
    ctx.restore();
  }

  function drawRocketIcon(x, y, dir, p, filled) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(dir, 1);
    ctx.beginPath();
    ctx.moveTo(9, 0); ctx.lineTo(3, -4); ctx.lineTo(-7, -4); ctx.lineTo(-9, -7);
    ctx.lineTo(-9, 7); ctx.lineTo(-7, 4); ctx.lineTo(3, 4);
    ctx.closePath();
    if (filled) {
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawTouchControls(now) {
    touchButtons().forEach((b) => {
      const p = b.player === undefined ? null : PLAYERS[b.player];
      const bike = p && bikes ? bikes[b.player] : null;
      const flash = (flashes[b.id] || 0) > now;
      const enabled = b.kind === 'rocket' ? bike && bike.rockets > 0 : b.kind === 'laser' ? bike && bike.laser : true;
      ctx.save();
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fillStyle = flash ? 'rgba(255,255,255,0.35)' : 'rgba(3,4,11,0.45)';
      ctx.fill();
      ctx.strokeStyle = p ? p.color : '#8a5cff';
      ctx.globalAlpha = enabled ? 0.85 : 0.3;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.translate(b.x, b.y);
      const u = b.r / 22;
      if (b.kind === 'rocket') {
        ctx.save();
        ctx.scale(u * 1.4, u * 1.4);
        drawRocketIcon(0, -3, b.player === 0 ? 1 : -1, p, !!enabled);
        ctx.restore();
        text(String(bike ? bike.rockets : ROCKETS), 0, b.r * 0.5, 13, '#ffffff');
      } else if (b.kind === 'laser') {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1.5;
        boltPath(0, 0, b.r * 0.55);
        if (enabled) { ctx.shadowColor = '#b48cff'; ctx.shadowBlur = 12; ctx.fill(); } else ctx.stroke();
      } else {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-b.r * 0.35, -b.r * 0.45, b.r * 0.25, b.r * 0.9);
        ctx.fillRect(b.r * 0.1, -b.r * 0.45, b.r * 0.25, b.r * 0.9);
      }
      ctx.restore();
    });
  }

  function drawHUD(W) {
    const g = ctx.createLinearGradient(0, 0, 0, HUD);
    g.addColorStop(0, '#0b0e26');
    g.addColorStop(1, '#05060f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, HUD);

    const lg = ctx.createLinearGradient(0, 0, W, 0);
    lg.addColorStop(0, PLAYERS[0].color);
    lg.addColorStop(0.5, '#8a5cff');
    lg.addColorStop(1, PLAYERS[1].color);
    ctx.fillStyle = lg;
    ctx.shadowColor = '#8a5cff';
    ctx.shadowBlur = 10;
    ctx.fillRect(0, HUD - 3, W, 2);
    ctx.shadowBlur = 0;

    text(PLAYERS[0].name, 20, HUD / 2 - 1, 22, PLAYERS[0].color, 'left', 12);
    text(PLAYERS[1].name, W - 20, HUD / 2 - 1, 22, PLAYERS[1].color, 'right', 12);
    if (W >= 700) {
      ctx.letterSpacing = '6px';
      text('LIGHTBIKES', W / 2, HUD / 2 - 1, 14, '#5b5f8a');
      ctx.letterSpacing = '0px';
    }

    [[0, 200, 1], [1, W - 200, -1]].forEach(([i, x0, dir]) => {
      if (W < 560) return; // narrow screens: the touch buttons already show ammo
      const have = bikes ? bikes[i].rockets : ROCKETS;
      for (let k = 0; k < ROCKETS; k++) drawRocketIcon(x0 + dir * k * 28, HUD / 2 - 1, dir, PLAYERS[i], k < have);
      const hasLaser = bikes && bikes[i].laser;
      ctx.save();
      if (hasLaser) {
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = '#b48cff';
        ctx.shadowBlur = 12;
        boltPath(x0 + dir * (ROCKETS * 28 + 8), HUD / 2 - 1, 11);
        ctx.fill();
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 1.5;
        boltPath(x0 + dir * (ROCKETS * 28 + 8), HUD / 2 - 1, 11);
        ctx.stroke();
      }
      ctx.restore();
    });

    [[0, 90, 1], [1, W - 90, -1]].forEach(([i, x0, dir]) => {
      for (let k = 0; k < WIN_SCORE; k++) {
        const px = x0 + dir * k * 26;
        ctx.beginPath();
        ctx.arc(px, HUD / 2 - 1, 8, 0, Math.PI * 2);
        if (k < scores[i]) {
          ctx.fillStyle = PLAYERS[i].color;
          ctx.shadowColor = PLAYERS[i].color;
          ctx.shadowBlur = 12;
          ctx.fill();
          ctx.shadowBlur = 0;
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.25)';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    });
  }

  // Small screens: scores float over the top corners of the arena instead of taking a strip.
  function drawCompactHUD(W) {
    const y = 15;
    [[0, 10, 1], [1, W - 10, -1]].forEach(([i, x0, dir]) => {
      text(PLAYERS[i].name, x0, y, 20, PLAYERS[i].color, dir > 0 ? 'left' : 'right', 6);
      for (let k = 0; k < WIN_SCORE; k++) {
        ctx.beginPath();
        ctx.arc(x0 + dir * (34 + k * 13), y, 4.5, 0, Math.PI * 2);
        if (k < scores[i]) {
          ctx.fillStyle = PLAYERS[i].color;
          ctx.shadowColor = PLAYERS[i].color;
          ctx.shadowBlur = 8;
          ctx.fill();
          ctx.shadowBlur = 0;
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.3)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    });
  }

  function drawBand(W, cy, h) {
    const g = ctx.createLinearGradient(0, cy - h / 2, 0, cy + h / 2);
    g.addColorStop(0, 'rgba(3,4,11,0)');
    g.addColorStop(0.2, 'rgba(3,4,11,0.82)');
    g.addColorStop(0.8, 'rgba(3,4,11,0.82)');
    g.addColorStop(1, 'rgba(3,4,11,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, cy - h / 2, W, h);
  }

  function draw(now) {
    const W = CW;
    const H = CH;
    const AH = ROWS * cell;
    ctx.fillStyle = '#03040b';
    ctx.fillRect(0, 0, W, H);
    if (!compact) drawHUD(W);

    // Progress through the current tick, for smooth bike/trail motion.
    if (state === 'playing') {
      if (!paused) renderT = Math.min(1, (now - lastTick) / TICK_MS);
    } else {
      renderT = 1;
    }

    ctx.save();
    ctx.translate(0, HUD);
    ctx.beginPath();
    ctx.rect(0, 0, W, AH);
    ctx.clip();
    if (shake > 0.02) ctx.translate((Math.random() - 0.5) * shake * cell * 1.5, (Math.random() - 0.5) * shake * cell * 1.5);

    drawBackground(now);

    if (bikes) {
      const heads = bikes.map((b) => ({
        x: (b.px + (b.x - b.px) * renderT + 0.5) * cell,
        y: (b.py + (b.y - b.py) * renderT + 0.5) * cell,
      }));
      bikes.forEach((b, i) => drawTrail(b, PLAYERS[i], heads[i].x, heads[i].y));
      if (powerup) drawPowerup(now);
      rockets.forEach((r) => {
        const rx = (r.px + (r.x - r.px) * renderT + 0.5) * cell;
        const ry = (r.py + (r.y - r.py) * renderT + 0.5) * cell;
        drawRocket(rx, ry, Math.atan2(r.dy, r.dx), PLAYERS[r.owner]);
      });
      bikes.forEach((b, i) => {
        if (!b.alive) return;
        drawBike(heads[i].x, heads[i].y, b.angle, PLAYERS[i], cell * 0.6);
        if (b.laser) {
          // Charged laser: pulsing halo around the bike.
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = PLAYERS[i].color;
          ctx.lineWidth = cell * 0.2;
          ctx.beginPath();
          ctx.arc(heads[i].x, heads[i].y, cell * (2.4 + 0.3 * Math.sin(now / 120)), 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      });
    }

    // Laser beams + explosion effects (additive).
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    lasers.forEach((l) => {
      ctx.beginPath();
      ctx.moveTo(l.x0 * cell, l.y0 * cell);
      ctx.lineTo(l.x1 * cell, l.y1 * cell);
      ctx.strokeStyle = `rgba(${PLAYERS[l.owner].rgb},${0.3 * l.life})`;
      ctx.lineWidth = cell * (3.5 * l.life + 0.5);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${l.life})`;
      ctx.lineWidth = cell * (0.9 * l.life + 0.1);
      ctx.stroke();
    });
    particles.forEach((p) => {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x * cell, p.y * cell, cell * p.size, cell * p.size);
    });
    ctx.globalAlpha = 1;
    rings.forEach((r) => {
      ctx.strokeStyle = r.color;
      ctx.globalAlpha = Math.max(0, r.life);
      ctx.lineWidth = cell * 0.4;
      ctx.beginPath();
      ctx.arc(r.x * cell, r.y * cell, r.r * cell, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // Arena wall.
    ctx.strokeStyle = '#8a5cff';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#8a5cff';
    ctx.shadowBlur = 14;
    ctx.strokeRect(1.5, 1.5, COLS * cell - 3, AH - 3);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(3.5, 3.5, COLS * cell - 7, AH - 7);

    if (overlay) ctx.drawImage(overlay, 0, 0, COLS * cell, AH);

    // Overlays / messages.
    const cx = W / 2;
    const cy = AH / 2;
    if (state === 'menu') {
      drawBand(W, cy, 400);
      drawBike(cx - W * 0.27, cy - 95, 0, PLAYERS[0], cell * 1.6);
      drawBike(cx + W * 0.27, cy - 95, Math.PI, PLAYERS[1], cell * 1.6);
      ctx.letterSpacing = '8px';
      text('LIGHTBIKES', cx, cy - 95, Math.min(64, W / 12), '#ffffff', 'center', 30);
      ctx.letterSpacing = '0px';
      if (touchMode) {
        text('P1: SWIPE LEFT SIDE', cx - W * 0.19, cy - 15, 18, PLAYERS[0].color, 'center', 12);
        text('P2: SWIPE RIGHT SIDE', cx + W * 0.19, cy - 15, 18, PLAYERS[1].color, 'center', 12);
        text('Round buttons fire rockets: punch trails, kill bikes', cx, cy + 22, 14, '#ffb84a');
        text('Grab the glowing bolt for a laser that cuts every trail in a line', cx, cy + 48, 14, '#b48cff');
        text(window.innerHeight > window.innerWidth ? 'ROTATE YOUR DEVICE TO LANDSCAPE' : 'Make the other bike crash into your trail', cx, cy + 76, 15, '#9aa0c0');
        if (Math.floor(now / 500) % 2 === 0) text('TAP TO START', cx, cy + 120, 22, '#ffffff', 'center', 14);
      } else {
        text('P1: W A S D + E', cx - W * 0.17, cy - 15, 18, PLAYERS[0].color, 'center', 12);
        text('P2: ARROWS + 0', cx + W * 0.17, cy - 15, 18, PLAYERS[1].color, 'center', 12);
        text('E / 0 fires a rocket (3 each): punches trails, kills bikes', cx, cy + 22, 14, '#ffb84a');
        text('Grab the glowing bolt for a laser (Q / ENTER) that cuts every trail in a line', cx, cy + 48, 14, '#b48cff');
        text('Make the other bike crash into your trail', cx, cy + 76, 15, '#9aa0c0');
        text('M: mute   P: pause', cx, cy + 100, 13, '#6a6f90');
        if (Math.floor(now / 500) % 2 === 0) text('PRESS SPACE TO START', cx, cy + 142, 22, '#ffffff', 'center', 14);
      }
    } else if (state === 'countdown') {
      const n = Math.ceil((countdownEnd - now) / COUNTDOWN_MS);
      const frac = 1 - (((countdownEnd - now) / COUNTDOWN_MS) % 1);
      ctx.globalAlpha = 1 - frac * 0.5;
      text(String(Math.max(1, n)), cx, cy - 60, 90 + frac * 30, '#ffffff', 'center', 30);
      ctx.globalAlpha = 1;
    } else if (state === 'roundOver' || state === 'matchOver') {
      drawBand(W, cy, 220);
      text(message, cx, cy - 20, 38, '#ffffff', 'center', 24);
      text(state === 'matchOver' ? (touchMode ? 'TAP: NEW MATCH' : 'SPACE: NEW MATCH') : (touchMode ? 'TAP: NEXT ROUND' : 'SPACE: NEXT ROUND'), cx, cy + 35, 18, '#9aa0c0');
    } else if (paused) {
      drawBand(W, cy, 160);
      text('PAUSED', cx, cy, 40, '#ffffff', 'center', 20);
    }
    ctx.restore();
    if (compact) drawCompactHUD(W);
    if (touchMode && bikes && (state === 'countdown' || state === 'playing')) drawTouchControls(now);
  }

  function frame(now) {
    if (bikes) update(now);
    draw(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
