// Dino runner with WebMCP tools.
// Humans play with Space/↑ (jump) and ↓ (duck). An agent plays through
// document.modelContext: the game freezes whenever an obstacle comes into range,
// the agent plans an action ("jump when the gap is 70px"), and the game carries
// that plan out in real time.

// ---------- World constants (px, seconds; heights measured up from the ground) ----------

const W = 800;
const H = 240;
const GROUND_Y = 205; // canvas y of the ground line
const DINO_X = 40; // dino back edge
const STAND = { w: 44, h: 47 };
const DUCK = { w: 59, h: 28 };
const DINO_FRONT = DINO_X + STAND.w; // gaps are measured from here
const JUMP_V = 780;
const GRAVITY = 2600;
const START_SPEED = 400;
const ACCEL = 10;
const MAX_SPEED = 1000;
const SCORE_PER_PX = 1 / 40;
const BIRD_MIN_SCORE = 200;
const BIRD = { w: 46, h: 32, altitudes: { low: 10, mid: 38, high: 75 } };
const CACTUS = { small: { unit: 17, h: 35 }, large: { unit: 25, h: 50 } };
const STEP = 1 / 60;

const freezeGap = (speed) => Math.min(560, Math.max(320, speed * 0.75));

// ---------- State ----------

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);

let game = null;
let history = loadHistory();
let decisionWaiter = null; // resolves the pending start_game/act call
let bubble = null; // { text, until }

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem('dino-history')) || [];
  } catch {
    return [];
  }
}
function saveHistory() {
  try {
    localStorage.setItem('dino-history', JSON.stringify(history.slice(-50)));
  } catch {}
}
const best = () => history.reduce((m, g) => Math.max(m, g.score), 0);

function newGame(mode) {
  game = {
    mode, // 'human' | 'agent'
    status: 'running', // 'running' | 'decision' | 'over'
    t: 0,
    distance: 0,
    speed: START_SPEED,
    dino: { y: 0, vy: 0, ducking: false, duckUntil: null, wantJump: false },
    obstacles: [],
    nextId: 1,
    spawnIn: 600,
    decision: null, // obstacle awaiting an agent plan
    log: [],
    cause: null,
  };
  bubble = null;
  $('log').replaceChildren();
  updateHud();
}

const score = () => Math.floor(game.distance * SCORE_PER_PX);
const grounded = () => game.dino.y <= 0 && game.dino.vy === 0;
const gapOf = (o) => Math.round(o.x - DINO_FRONT);

// ---------- Obstacles ----------

function spawnObstacle() {
  const allowBirds = score() >= BIRD_MIN_SCORE;
  let o;
  if (allowBirds && Math.random() < 0.3) {
    const level = ['low', 'mid', 'high'][Math.floor(Math.random() * 3)];
    o = { type: 'bird', level, w: BIRD.w, h: BIRD.h, alt: BIRD.altitudes[level] };
  } else {
    const kind = Math.random() < 0.55 ? 'small' : 'large';
    const count = 1 + Math.floor(Math.random() * (game.speed > 550 ? 3 : 2));
    o = { type: `cactus_${kind}`, count, w: CACTUS[kind].unit * count, h: CACTUS[kind].h, alt: 0 };
  }
  Object.assign(o, { id: game.nextId++, x: W + 20, plan: null, executed: false, passed: false });
  game.obstacles.push(o);
  game.spawnIn = o.w + game.speed * 0.7 + 80 + Math.random() * game.speed * 0.8;
}

function describe(o) {
  return {
    id: o.id,
    type: o.type,
    ...(o.count && { count: o.count }),
    ...(o.level && { level: o.level }),
    width_px: o.w,
    height_px: o.h,
    altitude_px: o.alt,
    gap_px: gapOf(o),
    time_to_reach_ms: Math.max(0, Math.round((gapOf(o) / game.speed) * 1000)),
  };
}

// ---------- Simulation ----------

function step(dt) {
  const g = game;
  if (g.status !== 'running') return;
  g.t += dt;
  g.speed = Math.min(MAX_SPEED, g.speed + ACCEL * dt);
  const dx = g.speed * dt;
  g.distance += dx;

  for (const o of g.obstacles) o.x -= dx;
  g.spawnIn -= dx;
  if (g.spawnIn <= 0) spawnObstacle();

  runPlans();
  physics(dt);

  if (checkCollision()) return gameOver();

  for (const o of g.obstacles) {
    if (!o.passed && o.x + o.w < DINO_X) {
      o.passed = true;
      markLog(o, true);
    }
  }
  g.obstacles = g.obstacles.filter((o) => o.x + o.w > -20);

  if (g.mode === 'agent') {
    const next = g.obstacles.find((o) => !o.plan && !o.passed && gapOf(o) <= freezeGap(g.speed));
    if (next) freezeFor(next);
  }
  if (Math.floor(g.t * 10) !== Math.floor((g.t - dt) * 10)) updateHud();
}

function runPlans() {
  const d = game.dino;
  for (const o of game.obstacles) {
    if (!o.plan || o.executed || gapOf(o) > o.plan.trigger) continue;
    o.executed = true;
    if (o.plan.action === 'jump') d.wantJump = true;
    if (o.plan.action === 'duck') {
      d.ducking = true;
      d.duckUntil = o.id;
    }
  }
  if (d.duckUntil !== null) {
    const holder = game.obstacles.find((o) => o.id === d.duckUntil);
    if (!holder || holder.passed) {
      d.ducking = false;
      d.duckUntil = null;
    }
  }
}

function physics(dt) {
  const d = game.dino;
  if (d.wantJump && grounded()) {
    d.wantJump = false;
    d.ducking = false;
    d.vy = JUMP_V;
  }
  if (d.vy !== 0 || d.y > 0) {
    d.vy -= GRAVITY * dt;
    d.y += d.vy * dt;
    if (d.y <= 0) {
      d.y = 0;
      d.vy = 0;
    }
  }
}

function dinoBox() {
  const d = game.dino;
  const size = d.ducking && grounded() ? DUCK : STAND;
  return { x1: DINO_X, x2: DINO_X + size.w, y1: d.y, y2: d.y + size.h };
}

function checkCollision() {
  const b = dinoBox();
  for (const o of game.obstacles) {
    if (b.x2 > o.x && b.x1 < o.x + o.w && b.y2 > o.alt && b.y1 < o.alt + o.h) {
      game.cause = { obstacle: describe(o), plan: o.plan, dino_y_px: Math.round(game.dino.y), dino_ducking: game.dino.ducking };
      markLog(o, false);
      return true;
    }
  }
  return false;
}

function freezeFor(o) {
  game.status = 'decision';
  game.decision = o;
  resolveWaiter(snapshot());
}

function gameOver() {
  game.status = 'over';
  history.push({ score: score(), mode: game.mode, at: Date.now(), cause: game.cause?.obstacle?.type });
  saveHistory();
  updateHud();
  resolveWaiter(snapshot());
}

function resolveWaiter(value) {
  const w = decisionWaiter;
  decisionWaiter = null;
  w?.(value);
}

function snapshot() {
  const g = game;
  const base = {
    status: g.status,
    score: score(),
    speed_px_per_s: Math.round(g.speed),
    dino: { state: g.dino.y > 0 ? 'jumping' : g.dino.ducking ? 'ducking' : 'running', y_px: Math.round(g.dino.y), vy_px_per_s: Math.round(g.dino.vy) },
  };
  if (g.status === 'over') {
    return { ...base, cause_of_death: g.cause, best_score: best(), games_played: history.length };
  }
  return {
    ...base,
    obstacle: g.decision ? describe(g.decision) : null,
    other_obstacles: g.obstacles.filter((o) => o !== g.decision && !o.passed).map(describe),
    recent_results: g.log.slice(-3).map(({ id, type, action, trigger, cleared }) => ({ id, type, action, trigger, cleared })),
  };
}

// ---------- Rendering ----------

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function draw() {
  const ink = css('--ink');
  const faint = css('--faint');
  const accent = css('--accent');
  ctx.clearRect(0, 0, W, H);

  // ground
  ctx.fillStyle = ink;
  ctx.fillRect(0, GROUND_Y, W, 1);
  ctx.fillStyle = faint;
  const off = game ? game.distance % 40 : 0;
  for (let x = -off; x < W; x += 40) ctx.fillRect(x + 7, GROUND_Y + 6, 3, 1), ctx.fillRect(x + 25, GROUND_Y + 11, 5, 1);

  if (!game) return;

  for (const o of game.obstacles) drawObstacle(o, ink);
  drawDino(ink);

  // plans
  ctx.font = '12px ui-monospace, Menlo, monospace';
  for (const o of game.obstacles) {
    if (!o.plan || o.passed) continue;
    const tx = DINO_FRONT + o.plan.trigger;
    if (!o.executed && o.plan.action !== 'none') {
      ctx.strokeStyle = accent;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(tx, GROUND_Y + 2);
      ctx.lineTo(tx, GROUND_Y - 70);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = accent;
    ctx.fillText(o.plan.action, o.x, GROUND_Y - o.alt - o.h - 8);
  }

  // decision overlay
  if (game.status === 'decision' && game.decision) {
    const o = game.decision;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(o.x - 4, GROUND_Y - o.alt - o.h - 4, o.w + 8, o.h + 8);
    ctx.lineWidth = 1;
    ctx.fillStyle = accent;
    ctx.fillRect(DINO_FRONT, GROUND_Y + 16, o.x - DINO_FRONT, 2);
    ctx.fillText(`gap ${gapOf(o)}px`, DINO_FRONT + (o.x - DINO_FRONT) / 2 - 28, GROUND_Y + 32);
    ctx.font = '15px ui-monospace, Menlo, monospace';
    ctx.fillText('⏸ Claude is deciding…', 16, 28);
  }

  if (bubble && performance.now() < bubble.until) {
    ctx.font = '13px -apple-system, system-ui, sans-serif';
    const tw = ctx.measureText(bubble.text).width;
    const bx = DINO_X - 4;
    const by = GROUND_Y - game.dino.y - STAND.h - 40;
    ctx.fillStyle = css('--bubble');
    ctx.strokeStyle = ink;
    ctx.beginPath();
    ctx.roundRect(bx, by, tw + 16, 24, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.fillText(bubble.text, bx + 8, by + 16);
  }

  if (game.status === 'over') {
    ctx.fillStyle = ink;
    ctx.font = 'bold 20px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('G A M E   O V E R', W / 2, 90);
    ctx.font = '13px ui-monospace, Menlo, monospace';
    ctx.fillText(game.mode === 'human' ? 'press space to restart' : 'waiting for the agent…', W / 2, 115);
    ctx.textAlign = 'left';
  }
}

function drawDino(ink) {
  const d = game.dino;
  const bottom = GROUND_Y - d.y;
  const legPhase = Math.floor(game.distance / 30) % 2;
  ctx.fillStyle = ink;
  if (d.ducking && grounded()) {
    ctx.fillRect(DINO_X, bottom - 24, 40, 16); // body
    ctx.fillRect(DINO_X + 34, bottom - 28, 25, 14); // head
    ctx.fillRect(DINO_X - 6, bottom - 22, 8, 6); // tail
    ctx.fillRect(DINO_X + 10, bottom - 8, 5, legPhase ? 8 : 4);
    ctx.fillRect(DINO_X + 26, bottom - 8, 5, legPhase ? 4 : 8);
    ctx.clearRect(DINO_X + 50, bottom - 25, 3, 3); // eye
    return;
  }
  ctx.fillRect(DINO_X + 22, bottom - 47, 22, 16); // head
  ctx.fillRect(DINO_X + 22, bottom - 33, 12, 6); // neck
  ctx.fillRect(DINO_X + 6, bottom - 31, 26, 20); // body
  ctx.fillRect(DINO_X, bottom - 29, 8, 10); // tail
  ctx.fillRect(DINO_X + 30, bottom - 26, 7, 3); // arm
  const airborne = d.y > 0;
  ctx.fillRect(DINO_X + 10, bottom - 11, 5, airborne || legPhase ? 11 : 6);
  ctx.fillRect(DINO_X + 22, bottom - 11, 5, airborne || !legPhase ? 11 : 6);
  ctx.clearRect(DINO_X + 27, bottom - 43, 3, 3); // eye
}

function drawObstacle(o, ink) {
  const top = GROUND_Y - o.alt - o.h;
  ctx.fillStyle = ink;
  if (o.type === 'bird') {
    const flap = Math.floor(game.t * 6) % 2;
    ctx.fillRect(o.x, top + 12, 34, 8); // body
    ctx.fillRect(o.x - 4, top + 10, 10, 6); // head
    ctx.fillRect(o.x + 34, top + 14, 12, 4); // tail
    ctx.fillRect(o.x + 12, flap ? top : top + 20, 10, 12); // wing
    return;
  }
  const unit = o.w / o.count;
  for (let i = 0; i < o.count; i++) {
    const x = o.x + i * unit;
    const stem = Math.max(6, unit * 0.36);
    ctx.fillRect(x + (unit - stem) / 2, top, stem, o.h);
    ctx.fillRect(x + 1, top + o.h * 0.3, 3, o.h * 0.3);
    ctx.fillRect(x + 1, top + o.h * 0.55, (unit - stem) / 2, 3);
    ctx.fillRect(x + unit - 4, top + o.h * 0.2, 3, o.h * 0.3);
    ctx.fillRect(x + (unit + stem) / 2, top + o.h * 0.45, (unit - stem) / 2 - 1, 3);
  }
}

// ---------- HUD + decision log ----------

function updateHud() {
  $('score').textContent = String(game ? score() : 0).padStart(5, '0');
  $('best').textContent = String(best()).padStart(5, '0');
  $('speed').textContent = game ? `${Math.round(game.speed)} px/s` : '-';
  $('mode').textContent = !game ? 'idle' : game.mode === 'agent' ? 'agent playing' : 'you are playing';
  $('games').textContent = history.length;
  const agentGames = history.filter((g) => g.mode === 'agent');
  $('agent-best').textContent = agentGames.length ? Math.max(...agentGames.map((g) => g.score)) : '-';
}

function addLog(o, plan, reason) {
  const entry = { id: o.id, type: o.type, action: plan.action, trigger: plan.trigger, cleared: null };
  game.log.push(entry);
  const li = document.createElement('li');
  li.id = `log-${o.id}`;
  const label = o.type === 'bird' ? `bird (${o.level})` : `${o.type.replace('_', ' ')} ×${o.count}`;
  li.innerHTML = '<span class="res">…</span> <b></b> <span class="act"></span><div class="why"></div>';
  li.querySelector('b').textContent = `#${o.id} ${label}`;
  li.querySelector('.act').textContent = plan.action === 'none' ? '→ do nothing' : `→ ${plan.action} at ${plan.trigger}px`;
  li.querySelector('.why').textContent = reason || '';
  $('log').prepend(li);
}

function markLog(o, cleared) {
  const entry = game.log.find((e) => e.id === o.id);
  if (entry) entry.cleared = cleared;
  const li = document.getElementById(`log-${o.id}`);
  if (li) {
    li.querySelector('.res').textContent = cleared ? '✓' : '✗';
    li.classList.add(cleared ? 'ok' : 'bad');
  }
}

// ---------- Main loop (timer-driven so it keeps running in background tabs) ----------

let last = performance.now();
let acc = 0;
setInterval(() => {
  const now = performance.now();
  acc = Math.min(acc + (now - last) / 1000, 0.25);
  last = now;
  while (acc >= STEP) {
    if (game) step(STEP);
    acc -= STEP;
  }
  draw();
}, 1000 / 60);

// ---------- Human controls ----------

function humanAction(e) {
  if (game?.mode === 'agent' && game.status !== 'over') return;
  if (['Space', 'ArrowUp'].includes(e.code)) {
    e.preventDefault();
    if (!game || game.status === 'over' || game.mode !== 'human') return newGame('human');
    game.dino.wantJump = true;
  } else if (e.code === 'ArrowDown' && game?.mode === 'human') {
    e.preventDefault();
    if (grounded()) game.dino.ducking = e.type === 'keydown';
  }
}
document.addEventListener('keydown', humanAction);
document.addEventListener('keyup', (e) => {
  if (e.code === 'ArrowDown' && game?.mode === 'human') game.dino.ducking = false;
});
$('play').addEventListener('click', () => newGame('human'));

// ---------- WebMCP tools ----------

const RULES = {
  coordinates: 'Pixels and seconds. Heights are measured up from the ground (0). Obstacles scroll left toward the dino.',
  dino: {
    back_x: DINO_X,
    front_x: DINO_FRONT,
    standing_hitbox: { width: STAND.w, height: STAND.h },
    ducking_hitbox: { width: DUCK.w, height: DUCK.h, note: 'Only on the ground. Ducking is 15px longer at the front.' },
  },
  jump: {
    initial_velocity_px_per_s: JUMP_V,
    gravity_px_per_s2: GRAVITY,
    height_at_t: 'y(t) = 780*t - 1300*t^2  (dino bottom above ground, t in seconds after takeoff)',
    airtime_ms: Math.round(((2 * JUMP_V) / GRAVITY) * 1000),
    peak_px: Math.round((JUMP_V * JUMP_V) / (2 * GRAVITY)),
  },
  speed: { start_px_per_s: START_SPEED, accel_px_per_s2: ACCEL, max_px_per_s: MAX_SPEED },
  obstacles: {
    cactus_small: { width_px: '17 per cactus, 1-3 in a group', height_px: CACTUS.small.h, altitude_px: 0 },
    cactus_large: { width_px: '25 per cactus, 1-3 in a group', height_px: CACTUS.large.h, altitude_px: 0 },
    bird: { width_px: BIRD.w, height_px: BIRD.h, altitude_px: BIRD.altitudes, appears_after_score: BIRD_MIN_SCORE },
  },
  collision: 'Exact axis-aligned boxes. Any overlap between the dino hitbox and an obstacle box ends the game.',
  how_to_play: [
    'Call start_game. The game runs until an obstacle comes into range, then freezes and returns it.',
    'Reply with act: action "jump", "duck" or "none", plus trigger_gap_px. The action fires when the gap between the dino front (x=84) and the obstacle shrinks to trigger_gap_px.',
    'A jump fires once (if the dino is still in the air it fires on landing). A duck holds until that obstacle has fully passed.',
    'act resumes the game and returns at the next freeze, or with status "game_over".',
  ],
  tip: 'To jump an obstacle of height h and width w at speed v: during the (w + 44)px overlap the dino bottom y(t) must stay above altitude + h. Solve for when y(t) > that height, then convert to a gap: gap = v * t_rise.',
};

const tools = [
  {
    name: 'get_game_rules',
    description: 'Get the exact physics, hitboxes and obstacle sizes of the dino game, and how the agent controls work. Read this before playing.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => RULES,
  },
  {
    name: 'start_game',
    description: 'Start a new game in agent mode. Runs until the first obstacle comes into range, then freezes and returns the game state for your decision.',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      resolveWaiter({ status: 'superseded' });
      newGame('agent');
      return new Promise((resolve) => (decisionWaiter = resolve));
    },
  },
  {
    name: 'act',
    description:
      'Plan how to handle the obstacle the game is frozen on, then resume. The action fires when the gap to the obstacle shrinks to trigger_gap_px. Returns the next frozen state, or the game over result.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['jump', 'duck', 'none'] },
        trigger_gap_px: { type: 'number', description: 'Gap (px) between dino front and obstacle at which to act. Ignored for "none".' },
        reason: { type: 'string', description: 'Very short reason, shown in a speech bubble (max ~6 words)' },
      },
      required: ['action'],
    },
    async execute({ action, trigger_gap_px, reason }) {
      if (!game || game.status !== 'decision') {
        return { error: `Nothing to decide (status: ${game ? game.status : 'no game'}). Call start_game.`, state: game ? snapshot() : null };
      }
      if (!['jump', 'duck', 'none'].includes(action)) throw new Error('action must be jump, duck or none');
      const o = game.decision;
      const trigger = action === 'none' ? 0 : Math.max(0, Math.round(Number(trigger_gap_px ?? 60)));
      o.plan = { action, trigger };
      addLog(o, o.plan, reason);
      if (reason) bubble = { text: String(reason).slice(0, 48), until: performance.now() + 1800 };
      game.decision = null;
      game.status = 'running';
      return new Promise((resolve) => (decisionWaiter = resolve));
    },
  },
  {
    name: 'get_state',
    description: 'Get the current game state without changing anything.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => (game ? snapshot() : { status: 'no game' }),
  },
  {
    name: 'get_history',
    description: 'Scores and causes of death for past games (human and agent).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => ({ best_score: best(), games: history.slice(-20) }),
  },
];

if ('modelContext' in document) {
  Promise.all(tools.map((t) => document.modelContext.registerTool(t)))
    .then(() => ($('webmcp').textContent = `${tools.length} WebMCP tools registered`))
    .catch((err) => ($('webmcp').textContent = `WebMCP error: ${err.message}`));
} else {
  $('webmcp').textContent = 'No WebMCP in this browser: you can still play with the keyboard';
}

updateHud();
