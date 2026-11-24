import { PlayArena } from './arena.js';
const previewArena = new PlayArena();
setInterval(() => previewArena.step(), 25);
import { hurtbox, slashAngle as swingAngle, swordOutline, swordPose, SWORD_VIEW } from './combat/duel-motion.js';
const $ = id => document.getElementById(id);
let canvas = $('game');
let gl = canvas.getContext('webgl', { alpha: false, antialias: true, stencil: true });
// Phaser 4 needs instancing and vertex arrays. A canvas with a WebGL context
// cannot switch to 2D, so replace it before binding input on older devices.
if (gl && (!gl.getExtension('ANGLE_instanced_arrays') || !gl.getExtension('OES_vertex_array_object'))) {
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  gl = null;
  const fallback = canvas.cloneNode(false);
  canvas.replaceWith(fallback);
  canvas = fallback;
}
const keys = new Set(), pointerActions = { a: new Set(), b: new Set() };
const sequence = { a: 0, b: 0 }, pressedAt = new Map();
const inputQueues = { a: Promise.resolve(), b: Promise.resolve() }, crouchPoses = new Map(), guardPoses = new Map();
const keyMap = {
  KeyA: ['a', 'left'], KeyD: ['a', 'right'], KeyW: ['a', 'jump'], Space: ['a', 'jump'],
  KeyJ: ['a', 'attack'], KeyF: ['a', 'attack'], KeyE: ['a', 'pickup'], KeyS: ['a', 'crouch'],
  KeyK: ['a', 'primary'], KeyL: ['a', 'guard'],
  ArrowLeft: ['b', 'left'], ArrowRight: ['b', 'right'], ArrowUp: ['b', 'jump'],
  Enter: ['b', 'primary'], ArrowDown: ['b', 'crouch'], Slash: ['b', 'guard'], Period: ['b', 'pickup'],
  PageUp: ['b', 'aimUp'], PageDown: ['b', 'aimDown'],
};
let state, previous, receivedAt = 0, previousAt = 0, focused = false, starting = false;
let frame = 0, seenEvents = new Set(), particles = [], floaters = [], pendingImpactAt = null;
let lastInputError = '', pollFailures = 0, roundStartedAt = 0;
let mouseAim = null, lastAimSentAt = 0;
let debugEnabled = false, lastJudgment = null;
const ink = 0x22282d, paper = 0xfaf9f4;
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const mix = (a, b, t) => a + (b - a) * t;
const playerName = id => id === 'player-a' ? 'P1' : state?.mode === 'ai' ? 'AI' : 'P2';

async function request(path, data) {
  if (path === '/api/play/state') return previewArena.getSnapshot();
  if (path === '/api/play/start') return previewArena.start(data.mode);
  const input = /^\/api\/play\/input\/(a|b)$/.exec(path);
  if (input) return previewArena.submitInput(input[1], data);
  throw new Error('未知试玩动作');
}

function ingest(next) {
  const now = performance.now();
  if (!state || state.matchId !== next.matchId) {
    lastJudgment = null;
    $('debug-result').textContent = '等待本局首次判定';
    previous = next; previousAt = now - 50;
    seenEvents = new Set(); pendingImpactAt = null; particles = []; floaters = []; lastInputError = ''; crouchPoses.clear(); guardPoses.clear(); mouseAim = null;
    roundStartedAt = next.startedAt; sequence.a = 0; sequence.b = 0; $('mode').value = next.mode;
  } else { previous = state; previousAt = receivedAt; }
  state = next; receivedAt = now;
  for (const letter of ['a', 'b']) sequence[letter] = Math.max(sequence[letter], next.players.find(p => p.playerId === `player-${letter}`).inputSequence);
  const stats = next.weapons[0].derivedAttributes;
  $('stat-damage').textContent = `${stats.damage} / ${Math.round(stats.damage * next.duelRules.thrust.damageScale)}`;
  $('stat-reach').textContent = Math.round(stats.reach * next.duelRules.slash.reachScale);
  $('stat-cooldown').textContent = stats.cooldownMs;
  $('name-b').textContent = next.mode === 'ai' ? 'AI / 对手' : 'P2 / 对手';
  $('round-mode').textContent = next.mode === 'pickup' ? '双人夺剑' : next.mode === 'local' ? '双人对战' : '近战练习';
  for (const button of document.querySelectorAll('[data-player="b"]')) button.disabled = next.mode === 'ai';
  for (const event of next.events) {
    if (seenEvents.has(event.eventId)) continue;
    seenEvents.add(event.eventId);
    if (['combat:hit', 'combat:miss', 'combat:blocked', 'combat:guard_break', 'combat:clash'].includes(event.type)) {
      lastJudgment = event;
      $('debug-result').textContent = describeJudgment(event);
    }
    if (event.type === 'combat:hit') {
      const target = next.players.find(p => p.playerId === event.targetId);
      pendingImpactAt = event.occurredAt;
      floaters.push({ x: target.x, y: target.y - 75, startedAt: event.occurredAt, text: `−${event.result.damage}${event.result.guardBypassed ? ' 穿透格挡' : ''}` });
      for (let i = 0; i < 12; i++) particles.push({ x: target.x, y: target.y - 8,
        vx: Math.cos(i * 2.4) * (65 + i * 7), vy: Math.sin(i * 2.4) * (65 + i * 7),
        startedAt: event.occurredAt, life: 450 + i * 15 });
    }
    if (['combat:blocked', 'combat:guard_break'].includes(event.type)) {
      const contact = event.result.contact;
      floaters.push({ x: contact.x, y: contact.y - 18, startedAt: event.occurredAt,
        text: event.type === 'combat:blocked' ? '剑挡' : '破防' });
      for (let i = 0; i < 8; i++) particles.push({ x: contact.x, y: contact.y,
        vx: Math.cos(i * 0.9) * 110, vy: Math.sin(i * 0.9) * 110, startedAt: event.occurredAt, life: 350, guard: true });
    }
    if (event.type === 'combat:clash') {
      const point = event.result.contact;
      pendingImpactAt = event.occurredAt;
      floaters.push({ x: point.x, y: point.y - 12, startedAt: event.occurredAt, text: '弹刀' });
      for (let i = 0; i < 16; i++) particles.push({ x: point.x, y: point.y,
        vx: Math.cos(i * 2.4) * (90 + i * 5), vy: Math.sin(i * 2.4) * (90 + i * 5),
        startedAt: event.occurredAt, life: 300 + i * 8, guard: true });
    }
    if (event.type === 'item:picked_up') {
      floaters.push({ x: 500, y: next.arena.groundY - 95, startedAt: event.occurredAt, text: '获得长剑' });
    }
  }
  $('events').replaceChildren(...next.events.slice(-8).reverse().map(event => {
    const li = document.createElement('li');
    const labels = { 'combat:charge': '开始蓄力', 'combat:swing': event.result.action === 'thrust' ? '蓄力刺击' : '开始挥砍',
      'combat:hit': `命中 −${event.result.damage} HP${event.result.guardBypassed ? ' · 刺击穿透格挡' : ''}`,
      'combat:blocked': `${playerName(event.targetId)} 格挡挥砍`, 'combat:guard_break': `${playerName(event.targetId)} 精力耗尽 · 破防`,
      'combat:clash': `与 ${playerName(event.targetId)} 弹刀 · 双方无伤`,
      'combat:miss': event.result.missReason === 'OUT_OF_HEIGHT' ? '高度不符 · 未命中' : event.result.missReason === 'OUT_OF_AIM' ? '瞄准方向未命中' : '挥空',
      'combat:kill': '击败对手', 'combat:cancelled': '攻击取消', 'item:picked_up': '拾取长剑' };
    li.textContent = `${(Math.max(0, event.occurredAt - roundStartedAt) / 1000).toFixed(2)}s · ${playerName(event.actorId)} · ${labels[event.type] || event.type}`;
    return li;
  }));
  $('connection').classList.remove('offline'); $('connection').textContent = '浏览器独立试玩 · 无需登录';
  pollFailures = 0;
}

function intent(letter) {
  const actions = new Set(pointerActions[letter]);
  for (const code of keys) if (keyMap[code]?.[0] === letter) actions.add(keyMap[code][1]);
  return { matchId: state.matchId, sequence: ++sequence[letter],
    axis: Number(actions.has('right')) - Number(actions.has('left')),
    jump: actions.has('jump'), attack: actions.has('attack'), pickup: actions.has('pickup'),
    crouch: actions.has('crouch'), guard: actions.has('guard'), primary: actions.has('primary'),
    aimAngle: letter === 'a' ? mouseAimAngle(state.players[0]) : actions.has('aimUp') ? -Math.PI / 2 : actions.has('aimDown') ? Math.PI / 2 : 0 };
}

function mouseAimAngle(player) {
  if (!mouseAim) return player.aimAngle || 0;
  const direction = player.facing === 'right' ? 1 : -1;
  return clamp(Math.atan2(mouseAim.y - player.y - (player.crouching ? 28 : -8),
    (mouseAim.x - player.x) * direction), -Math.PI / 2, Math.PI / 2);
}

function updateMouseAim(event) {
  const rect = canvas.getBoundingClientRect(), scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
  mouseAim = { x: (event.clientX - rect.left - (rect.width - canvas.width * scale) / 2) / scale,
    y: (event.clientY - rect.top - (rect.height - canvas.height * scale) / 2) / scale };
}

function sendInput(letter, cancel = false) {
  if (!state || state.phase !== 'playing' || starting || (letter === 'b' && state.mode === 'ai')) return;
  const matchId = state.matchId;
  const packet = { ...intent(letter), cancel };
  // Preserve down/up ordering, even for a click shorter than a simulation frame.
  inputQueues[letter] = inputQueues[letter].then(async () => {
    if (state.matchId !== matchId) return;
    const result = await request(`/api/play/input/${letter}`, packet);
    if (state.matchId !== matchId) return;
    if (!result.accepted && !['MATCH_NOT_PLAYING', 'STALE_MATCH'].includes(result.error.code)) {
      lastInputError = result.error.message;
    }
  }).catch(error => { lastInputError = error.message; });
}

function releaseAll() {
  keys.clear(); pointerActions.a.clear(); pointerActions.b.clear();
  for (const button of document.querySelectorAll('.key')) button.classList.remove('held');
  sendInput('a', true); sendInput('b', true);
}

async function startRound() {
  if (starting) return;
  starting = true; releaseAll();
  try {
    const result = await request('/api/play/start', { mode: $('mode').value });
    if (!result.accepted) throw new Error(result.error.message);
    ingest(result.state); canvas.focus(); focused = true;
  } catch (error) { lastInputError = error.message; }
  finally { starting = false; }
}
$('start').addEventListener('click', startRound);
$('restart').addEventListener('click', startRound);
function toggleDebug() {
  debugEnabled = !debugEnabled;
  $('debug-toggle').setAttribute('aria-pressed', String(debugEnabled));
  $('debug-legend').hidden = !debugEnabled;
  document.querySelector('.world-caption').hidden = debugEnabled;
}
$('debug-toggle').addEventListener('click', () => {
  toggleDebug();
  if (state?.phase === 'playing') { canvas.focus(); focused = true; }
});
$('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.querySelector('.arena').requestFullscreen();
    canvas.focus(); focused = true;
  } catch { lastInputError = '当前浏览器不支持全屏，可把试玩面板拉宽。'; }
});
$('exit-fullscreen').addEventListener('click', async () => { await document.exitFullscreen(); releaseAll(); canvas.focus(); focused = true; });
$('mode').addEventListener('change', () => {
  if (state?.phase !== 'ready') return;
  const pickup = $('mode').value === 'pickup';
  $('overlay-title').textContent = pickup ? '谁先拿到长剑？' : '拔剑，开始练习';
  $('overlay-copy').innerHTML = pickup ? '两人跑向场地中央。<br>靠近长剑后按 E / . 拾取。' :
    `左键短按挥砍，长按 ${(state.duelRules.chargeMs / 1000).toFixed(1)} 秒后松开刺击。<br>右键挡中才耗精力，双方挥砍剑身相碰会弹刀。`;
});
canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('pointermove', event => {
  updateMouseAim(event);
  if (focused && performance.now() - lastAimSentAt >= 40) { lastAimSentAt = performance.now(); sendInput('a'); }
});
canvas.addEventListener('mousedown', event => {
  if (![0, 2].includes(event.button)) return;
  event.preventDefault(); canvas.focus(); focused = true; updateMouseAim(event);
  pointerActions.a.add(event.button === 0 ? 'primary' : 'guard'); sendInput('a');
});
window.addEventListener('mouseup', event => {
  const action = event.button === 0 ? 'primary' : event.button === 2 ? 'guard' : null;
  if (action && pointerActions.a.delete(action)) sendInput('a');
});
canvas.addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse') return;
  event.preventDefault(); canvas.focus(); focused = true; updateMouseAim(event); canvas.setPointerCapture(event.pointerId);
  pointerActions.a.add('primary'); sendInput('a');
});
canvas.addEventListener('pointerup', event => {
  if (event.pointerType !== 'mouse' && pointerActions.a.delete('primary')) sendInput('a');
});
canvas.addEventListener('pointercancel', () => { pointerActions.a.delete('primary'); sendInput('a', true); });
window.addEventListener('keydown', event => {
  if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement) return;
  if (event.code === 'KeyH' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing) {
    if (!event.repeat) toggleDebug();
    event.preventDefault(); return;
  }
  if (event.code === 'KeyR' && !event.repeat) { event.preventDefault(); startRound(); return; }
  if (!keyMap[event.code] || !focused) return;
  event.preventDefault();
  if (!keys.has(event.code)) { keys.add(event.code); sendInput(keyMap[event.code][0]); }
});
window.addEventListener('keyup', event => {
  if (!keyMap[event.code]) return;
  event.preventDefault(); keys.delete(event.code); sendInput(keyMap[event.code][0]);
});
window.addEventListener('blur', () => { focused = false; releaseAll(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { focused = false; releaseAll(); } });
for (const button of document.querySelectorAll('.key')) {
  button.addEventListener('pointerdown', event => {
    event.preventDefault(); if (button.disabled) return;
    focused = true; button.setPointerCapture(event.pointerId);
    const { player, action } = button.dataset;
    pressedAt.set(button, performance.now()); pointerActions[player].add(action);
    button.classList.add('held'); sendInput(player);
  });
  const release = () => {
    const { player, action } = button.dataset;
    // Short button clicks are usable too; a movement click lasts at least 150 ms.
    const delay = ['left', 'right', 'jump', 'pickup', 'attack'].includes(action) ? Math.max(0, 150 - (performance.now() - (pressedAt.get(button) || 0))) : 0;
    setTimeout(() => { pointerActions[player].delete(action); button.classList.remove('held'); sendInput(player); }, delay);
  };
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', () => { const { player, action } = button.dataset;
    pointerActions[player].delete(action); button.classList.remove('held'); sendInput(player, true); });
}
setInterval(() => { if (focused && !document.hidden) { sendInput('a'); sendInput('b'); } }, 75);

async function poll() {
  const requestedMatch = state?.matchId;
  try {
    const snapshot = await request('/api/play/state');
    if (!starting && (!requestedMatch || state?.matchId === requestedMatch)) ingest(snapshot);
  }
  catch (error) {
    pollFailures++; $('connection').classList.add('offline'); $('connection').textContent = '试玩暂时中断 · 请刷新页面';
    lastInputError = error.message;
  }
  setTimeout(poll, pollFailures ? 500 : 40);
}

function stroke(g, points, color = ink, width = 3, alpha = 1) {
  g.lineStyle(width, color, alpha).beginPath().moveTo(...points[0]);
  for (const point of points.slice(1)) g.lineTo(...point);
  g.strokePath();
}

function sword(g, x, y, angle, facing, opacity = 1, flash = false) {
  const weapon = state.weapons[0], scale = weapon.derivedAttributes.reach * SWORD_VIEW.scale / SWORD_VIEW.span;
  g.save().translateCanvas(x, y).scaleCanvas(facing, 1).rotateCanvas(angle);
  for (const path of weapon.drawing.strokes) {
    const closed = path.length > 3 && path[0][0] === path.at(-1)[0] && path[0][1] === path.at(-1)[1];
    const points = path.map(([px, py]) => ({ x: (px - SWORD_VIEW.gripX) * scale, y: (py - SWORD_VIEW.gripY) * scale }));
    if (closed) g.fillStyle(paper, opacity).fillPoints(points, true);
    g.lineStyle(closed ? (flash ? 2.3 : 1.6) : 1, flash ? 0xbd9b4a : closed ? ink : 0x747c73, opacity)
      .strokePoints(points, closed);
  }
  g.restore();
}

function drawFighter(g, label, player, now) {
  const direction = player.facing === 'right' ? 1 : -1, color = player.playerId === 'player-a' ? ink : 0x69756b;
  const dead = player.hp <= 0, deathProgress = clamp((now - (player.deathAt ?? now)) / 550, 0, 1);
  const walking = player.grounded && Math.abs(player.vx) > 20, stride = walking ? Math.sin(now / 85) : 0;
  const breath = Math.sin(now / 370 + (player.playerId === 'player-a' ? 0 : 1)) * 1.1;
  const elapsed = player.swing ? now - player.swing.startedAt : 1000;
  const attacking = player.swing && elapsed >= 0 && now < player.swing.endsAt && !dead;
  const thrusting = attacking && player.swing.action === 'thrust';
  const rebounding = attacking && player.swing.clashedAt !== undefined;
  const crouch = attacking ? Number(player.swing.crouching) : crouchPoses.get(player.playerId) || 0;
  const charging = player.chargingSince !== null && !dead;
  const chargeProgress = charging ? clamp((now - player.chargingSince) / state.duelRules.chargeMs, 0, 1) : 0;
  const guardProgress = dead ? 0 : guardPoses.get(player.playerId) || 0;
  const aim = clamp(player.aimAngle, -Math.PI / 2, Math.PI / 2);
  const attackAngle = elapsedMs => clamp(aim + swingAngle(elapsedMs), -Math.PI / 2, Math.PI / 2);
  const headY = mix(-49, 14, crouch), hipY = mix(18, 42, crouch), shoulderY = headY + 23;
  const hurt = now - player.hurtAt < 140;
  g.clear().setAlpha(hurt && Math.sin(now / 13) > 0 ? 0.35 : dead ? 1 - deathProgress * 0.4 : 1);
  g.save();
  if (dead) {
    g.translateCanvas(player.x, player.y + 63).rotateCanvas(-direction * deathProgress * Math.PI / 2).translateCanvas(0, -63);
  } else {
    g.translateCanvas(player.x, player.y + (attacking || guardProgress > 0 ? 0 : walking ? Math.abs(stride) * -2 : breath));
  }
  const pose = swordPose(player, attacking ? player.swing : null, now, crouch, guardProgress);
  const thrustExtension = pose.extension;
  const lean = rebounding ? -direction * 10 * Math.sin(Math.PI * clamp((now - player.swing.clashedAt) / (player.swing.endsAt - player.swing.clashedAt), 0, 1)) :
    attacking ? direction * mix(-6, thrusting ? 13 : 8, thrusting ? thrustExtension : clamp(elapsed / 220, 0, 1)) :
      pose.guarding > 0 ? -direction * (4 * pose.guarding + 7 * pose.guardRecoil) : charging ? -direction * 5 : walking ? direction * 4 : 0;
  g.fillStyle(paper).fillCircle(lean, headY, 13).lineStyle(3.5, color).strokeCircle(lean, headY, 13);
  if (dead) {
    stroke(g, [[-4 + lean, headY - 3], [2 + lean, headY + 3]], color, 1.5); stroke(g, [[-4 + lean, headY + 3], [2 + lean, headY - 3]], color, 1.5);
  } else g.fillStyle(color).fillCircle(lean + direction * 5, headY - 1, 1.7);
  stroke(g, [[lean, headY + 13], [lean * 0.4, mix(-5, 36, crouch)], [0, hipY]], color, 3.5);
  if (player.grounded || dead) {
    const gait = stride * mix(17, 6, crouch), kneeX = mix(10, 23, crouch), kneeY = mix(40, 52, crouch);
    stroke(g, [[0, hipY], [-kneeX + gait * 0.65, kneeY], [-16 + gait, 63], [-23 + gait, 63]], color, 3.5);
    stroke(g, [[0, hipY], [kneeX - gait * 0.65, kneeY], [16 - gait, 63], [23 - gait, 63]], color, 3.5);
  } else {
    stroke(g, [[0, hipY], [-20, 33], [-11, 51], [-20, 51]], color, 3.5);
    stroke(g, [[0, hipY], [19, 36], [33, 28], [40, 28]], color, 3.5);
  }
  const { handX, handY, angle } = pose;
  stroke(g, [[lean, shoulderY], [mix(direction * 17, handX, 0.35), mix(shoulderY + 20, handY, 0.6)], [handX, handY]], color, 3.5);
  stroke(g, [[lean, shoulderY], [mix(-direction * 17, direction * 6, pose.guarding), mix(mix(6, 45, crouch), handY + 10, pose.guarding)],
    [mix(-direction * 11, handX - direction * 4, pose.guarding), mix(mix(23, 55, crouch), handY + 6, pose.guarding)]], color, 3.5);
  if (player.equippedWeaponId) {
    if (attacking && !thrusting && !rebounding && elapsed > 120 && elapsed < 270) {
      g.save().translateCanvas(handX, handY).scaleCanvas(direction, 1);
      g.lineStyle(10, 0x74877a, 0.31).beginPath().arc(0, 0, 70, attackAngle(Math.max(120, elapsed - 55)), angle).strokePath().restore();
      for (const age of [45, 30, 15]) sword(g, handX, handY, attackAngle(Math.max(0, elapsed - age)), direction, 0.08);
    }
    if (thrusting && elapsed < 250) {
      g.save().translateCanvas(handX, handY).scaleCanvas(direction, 1).rotateCanvas(aim);
      stroke(g, [[-18, 0], [84, 0]], 0xb38b52, 9, 0.38);
      stroke(g, [[-30, -8], [57, -8]], 0xb38b52, 2, 0.25);
      g.restore();
    }
    if (charging) {
      g.lineStyle(3, chargeProgress === 1 ? 0xbd8b3b : 0x92a18b).beginPath()
        .arc(handX, handY, 19, -Math.PI / 2, -Math.PI / 2 + chargeProgress * Math.PI * 2).strokePath();
      const rule = state.duelRules.thrust, height = mix(rule.height, rule.crouchingHeight, crouch);
      const reach = state.weapons[0].derivedAttributes.reach * rule.reachScale;
      g.save().translateCanvas(0, height).scaleCanvas(direction, 1).rotateCanvas(aim).lineStyle(1.5, 0xb39655, 0.38);
      for (let x = 0; x < reach; x += 10) g.lineBetween(x, 0, Math.min(x + 4, reach), 0);
      g.restore();
    }
    sword(g, handX, handY, angle, direction, 1, now - player.guardHitAt >= 0 && now - player.guardHitAt < 120);
  }
  g.restore();
  label.setVisible(!dead);
  if (!dead) {
    label.setPosition(player.x, player.y + headY - 24).setText(charging ? chargeProgress === 1 ? '蓄力完成 · 松开刺击' :
      `蓄力 ${(chargeProgress * state.duelRules.chargeMs / 1000).toFixed(1)} / ${(state.duelRules.chargeMs / 1000).toFixed(1)}s` :
      rebounding ? '弹刀' : playerName(player.playerId));
  }
}

function drawMap(scene, arena) {
  const g = scene.mapGraphics.clear(), { width, height, groundY } = arena;
  g.lineStyle(1, 0xe6e8df);
  for (let x = 0; x < width; x += 40) g.lineBetween(x, 130, x, groundY);
  for (let y = 140; y < groundY; y += 40) g.lineBetween(0, y, width, y);
  g.fillStyle(0xe9ece1).fillRect(0, groundY + 2, width, height - groundY);
  g.lineStyle(2, 0x84907f).lineBetween(0, groundY + 1, width, groundY + 1);
  for (const label of scene.platformLabels) label.destroy();
  scene.platformLabels = [];
  for (const platform of arena.platforms) {
    const { x, y, width: span } = platform;
    g.fillStyle(0xe5e9dd).fillRect(x, y, span, 9).lineStyle(2, 0x8a9683).lineBetween(x, y, x + span, y);
    g.lineStyle(1, 0xcbd2c1).lineBetween(x + 15, y + 12, x + 4, groundY)
      .lineBetween(x + span - 15, y + 12, x + span - 4, groundY);
    scene.platformLabels.push(scene.label('#788470', 11).setPosition(x + span / 2, y + 27).setText('上层 · 跳跃到达'));
  }
}

function renderHud(now) {
  for (const [letter, player] of [['a', state.players[0]], ['b', state.players[1]]]) {
    $(`hp-${letter}`).textContent = `${player.hp} / 100`; $(`bar-${letter}`).style.width = `${player.hp}%`;
    const stamina = Math.round(player.stamina);
    $(`stamina-${letter}`).textContent = `${stamina} / 100`;
    $(`stamina-bar-${letter}`).style.width = `${stamina}%`;
    $(`stamina-meter-${letter}`).setAttribute('aria-valuenow', String(stamina));
    $(`stamina-meter-${letter}`).classList.toggle('low', stamina < state.duelRules.slash.staminaCost);
    let action = player.equippedWeaponId ? '可以攻击' : '空手 · 靠近长剑后拾取';
    const elapsed = player.swing ? now - player.swing.startedAt : 1000;
    if (player.hp === 0) action = '已被击败';
    else if (now < player.guardBrokenUntil) action = '精力耗尽 · 破防';
    else if (now < player.clashUntil) action = '弹刀 · 反震硬直';
    else if (now < player.staggerUntil) action = '受击硬直';
    else if (player.chargingSince !== null) {
      const duration = now - player.chargingSince;
      action = duration >= state.duelRules.chargeMs ? (player.stamina >= state.duelRules.thrust.staminaCost ? '蓄力完成 · 松开刺击' : '精力不足以刺击 · 松开取消') : `蓄力 ${(duration / 1000).toFixed(1)} / ${(state.duelRules.chargeMs / 1000).toFixed(1)}s`;
    } else if (player.blocking) action = '抬剑格挡 · 挡中才耗精力';
    else if (player.swing && now < player.swing.endsAt) action = now < player.swing.impactAt ? '起手' : elapsed < 260 ? player.swing.action === 'thrust' ? '蓄力刺击' : '挥砍' : '收势';
    else if (now < player.readyAt) action = `冷却 ${Math.ceil((player.readyAt - now) / 10) * 10} ms`;
    else if (player.crouching) action = '蹲伏 · 可躲避高位挥砍';
    else if (player.stamina < state.duelRules.slash.staminaCost) action = '精力恢复中';
    $(`action-${letter}`).textContent = action;
  }
  $('round-phase').textContent = state.phase === 'ready' ? '准备开局' : state.phase === 'finished' ? '本局结束' : `${Math.floor((now - roundStartedAt) / 1000)} s`;
  if (state.phase === 'playing') $('overlay').classList.add('hidden');
  if (state.phase === 'finished') {
    const finalEvent = state.events.findLast(event => event.type === 'combat:kill' || event.type === 'item:picked_up');
    if (finalEvent && now - finalEvent.occurredAt > 650) {
      $('overlay').classList.remove('hidden');
      $('overlay-title').textContent = `${playerName(state.winnerId)} ${state.mode === 'pickup' ? '拿到了长剑' : '获胜'}`;
      $('overlay-copy').textContent = state.mode === 'pickup' ? '同一个物品只能由一名角色获得。' : '调整走位和挥剑时机，再来一局。';
      $('start').textContent = '再来一局'; $('overlay-hint').textContent = '按 R 重新开始，也可以换个模式';
    }
  }
  const results = { WEAPON_NOT_EQUIPPED: '你还没有武器，靠近中央长剑后拾取。', PICKUP_OUT_OF_RANGE: '再靠近长剑一点。', ITEM_TAKEN: '长剑已被另一名玩家拾取。',
    STAMINA: '精力不足，停止攻击和格挡后恢复。', BLOCKING: '先松开格挡，再攻击。', COOLDOWN: '上一击尚未冷却，请稍后再按左键。',
    STAGGERED: '受击后暂时无法行动。', CROUCHING: '松开 S / ↓，站起后再跳跃。' };
  const actionResult = state.players[0].actionResult;
  $('error').textContent = lastInputError || results[actionResult] || '';
}

function describeJudgment({ type, result, actorId, targetId }) {
  const action = result.action === 'thrust' ? '刺击' : '挥砍';
  const labels = { 'combat:blocked': '剑挡', 'combat:guard_break': '破防', 'combat:clash': '弹刀',
    'combat:hit': (result.guardBroken ? '破防 · ' : '') + action + '命中', 'combat:miss': action + '落空' };
  const point = result.bodyContact ?? result.contact;
  const coords = point ? ` (${Math.round(point.x)}, ${Math.round(point.y)})` : '';
  return `上次 · ${playerName(actorId)} → ${playerName(targetId)} · ${labels[type]}${coords}`;
}

function drawDebug(g) {
  // Keep live geometry on simulation ticks. Cosmetic pose smoothing would move the colliders.
  g.clear();
  for (const player of state.players) {
    if (player.hp <= 0) continue;
    const box = hurtbox(player, state.duelRules);
    const width = box.maxX - box.minX, height = box.maxY - box.minY;
    g.fillStyle(0x2463a0, 0.06).fillRect(box.minX, box.minY, width, height);
    g.lineStyle(2, 0x2463a0).strokeRect(box.minX, box.minY, width, height);
    const weapon = state.weapons.find(w => w.weaponId === player.equippedWeaponId);
    if (!weapon) continue;
    const swing = state.now < player.swing?.endsAt ? player.swing : null;
    const outline = swordOutline(player, swing, weapon, state.now);
    g.fillStyle(0x008477, 0.14).fillPoints(outline, true);
    g.lineStyle(2.5, 0x008477).strokePoints(outline, true);
  }

  const result = lastJudgment?.result, trace = result?.trace;
  if (!trace) return;
  const amber = 0xa65d12;
  if (trace.blades) {
    for (const outline of trace.blades) g.lineStyle(1.8, amber, 0.85).strokePoints(outline, true);
  }
  if (trace.box && (!trace.blades || result.bodyContact)) {
    const { start, end, radius, box } = trace;
    g.lineStyle(1.5, amber, 0.75).strokeRect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY);
    g.lineStyle(radius * 2, amber, 0.17).lineBetween(start.x, start.y, end.x, end.y);
    g.fillStyle(amber, 0.17).fillCircle(start.x, start.y, radius).fillCircle(end.x, end.y, radius);
    g.lineStyle(1.5, amber).lineBetween(start.x, start.y, end.x, end.y);
  }
  for (const point of [result.contact, result.bodyContact]) {
    if (!point) continue;
    const { x, y } = point;
    g.fillStyle(0xfff9ee).fillCircle(x, y, 5);
    g.lineStyle(2, 0xb12f34).strokeCircle(x, y, 5);
    g.lineBetween(x - 8, y, x + 8, y).lineBetween(x, y - 8, x, y + 8);
  }
}

class CombatScene extends Phaser.Scene {
  constructor() { super('Duel'); }

  label(color, size) {
    return this.add.text(0, 0, '', { fontFamily: 'system-ui, sans-serif', fontSize: size + 'px', color })
      .setOrigin(0.5, 1).setDepth(2);
  }

  create() {
    this.mapGraphics = this.add.graphics();
    this.platformLabels = [];
    this.item = this.add.graphics();
    this.pickupLabel = this.label('#65775d', 11);
    this.fighters = new Map(['player-a', 'player-b'].map(id => [id, {
      body: this.add.graphics(), label: this.label(id === 'player-a' ? '#22282d' : '#69756b', 12),
    }]));
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.sparks = this.add.graphics().setDepth(3);
    this.debugLayer = this.add.graphics().setDepth(5).setVisible(false);
    this.eventLabels = [];
    canvas.dataset.renderer = 'Phaser ' + Phaser.VERSION;
    canvas.dataset.backend = this.game.renderer.type === Phaser.WEBGL ? 'WebGL' : 'Canvas';
    poll();
  }

  update(time, delta) {
    if (!state) return;
    const dt = Math.min(0.05, delta / 1000);
    // Snapshot arrivals use the browser clock, independently of Phaser's smoothed delta.
    const age = Math.max(0, performance.now() - receivedAt);
    const now = state.now + Math.min(150, age);
    const t = clamp(age / Math.max(25, receivedAt - previousAt), 0, 1);
    if (this.matchId !== state.matchId) {
      this.matchId = state.matchId;
      this.cameras.main.shakeEffect.reset();
      drawMap(this, state.arena);
    }
    if (pendingImpactAt !== null) {
      const remaining = 160 - Math.max(0, now - pendingImpactAt);
      if (remaining > 0 && !this.reducedMotion.matches) this.cameras.main.shake(remaining, 0.0025, true);
      pendingImpactAt = null;
    }
    const item = state.items[0], showItem = !item.holderId;
    this.item.clear();
    this.pickupLabel.setVisible(showItem);
    if (showItem) {
      const groundY = state.arena.groundY;
      this.item.fillStyle(0x344c3d, 0.05).fillEllipse(item.x, groundY - 1, 88, 14);
      sword(this.item, item.x - 32, groundY - 18 + Math.sin(now / 310) * 3, -0.12, 1, state.mode === 'pickup' ? 1 : 0.6);
      this.pickupLabel.setPosition(item.x, groundY + 30).setText(state.mode === 'pickup' ? '靠近 · E / . 拾取' : 'E 拾取');
    }
    for (const player of state.players) {
      const before = previous.players.find(p => p.playerId === player.playerId) || player;
      const pose = crouchPoses.get(player.playerId) || 0;
      crouchPoses.set(player.playerId, mix(pose, Number(player.crouching), Math.min(1, dt * 18)));
      const guardPose = guardPoses.get(player.playerId) || 0;
      const guardStep = dt * 1000 / (player.blocking ? SWORD_VIEW.guardRiseMs : SWORD_VIEW.guardReturnMs);
      const guardAge = now - player.guardHitAt;
      guardPoses.set(player.playerId, guardAge >= 0 && guardAge < SWORD_VIEW.guardRecoilMs ? 1 :
        clamp(guardPose + (player.blocking ? guardStep : -guardStep), 0, 1));
      const fighter = this.fighters.get(player.playerId);
      drawFighter(fighter.body, fighter.label, { ...player, x: mix(before.x, player.x, t), y: mix(before.y, player.y, t) }, now);
    }
    particles = particles.filter(particle => now - particle.startedAt < particle.life);
    const g = this.sparks.clear();
    for (const particle of particles) {
      particle.x += particle.vx * dt; particle.y += particle.vy * dt; particle.vy += 270 * dt;
      const alpha = clamp(1 - (now - particle.startedAt) / particle.life, 0, 1);
      g.lineStyle(1.7, particle.guard ? 0xb18b43 : 0x455a43, alpha)
        .lineBetween(particle.x, particle.y, particle.x - particle.vx * 0.025, particle.y - particle.vy * 0.025);
    }
    floaters = floaters.filter(floater => now - floater.startedAt < 850);
    for (let i = 0; i < Math.max(floaters.length, this.eventLabels.length); i++) {
      const floater = floaters[i];
      const label = this.eventLabels[i] ??= this.label('#38604a', 20).setDepth(4);
      label.setVisible(Boolean(floater));
      if (floater) {
        const elapsed = now - floater.startedAt;
        label.setAlpha(clamp(1 - elapsed / 850, 0, 1)).setPosition(floater.x, floater.y - elapsed * 0.04).setText(floater.text);
      }
    }
    this.debugLayer.setVisible(debugEnabled);
    if (debugEnabled) drawDebug(this.debugLayer);
    renderHud(now);
    canvas.dataset.frame = String(++frame); canvas.dataset.phase = state.phase;
  }
}

// Phaser needs an explicit renderer for our existing, keyboard-accessible canvas.
new Phaser.Game({
  type: gl ? Phaser.WEBGL : Phaser.CANVAS, context: gl, width: 1000, height: 640, canvas,
  scale: { mode: Phaser.Scale.NONE }, backgroundColor: paper,
  audio: { noAudio: true }, input: { keyboard: false, mouse: false, touch: false },
  scene: CombatScene,
});
