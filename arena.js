const randomUUID = () => crypto.randomUUID();

import { CombatEngine, DUEL_RULES } from './combat/index.js';
import { SWORD_VIEW } from './combat/duel-motion.js';

const sample = {
  "schemaVersion": "0.1",
  "weaponId": null,
  "ownerId": null,
  "name": "Starter Sword",
  "category": "melee",
  "drawing": {
    "coordinateSpace": "normalized-0-to-1",
    "strokes": [
      [[0.05,0.5],[0.085,0.455],[0.12,0.47],[0.3,0.47],[0.335,0.435],[0.35,0.365],[0.38,0.34],[0.41,0.37],[0.405,0.435],[0.48,0.425],[0.7,0.425],[0.85,0.455],[0.96,0.5],[0.85,0.545],[0.7,0.575],[0.48,0.575],[0.405,0.565],[0.41,0.63],[0.38,0.66],[0.35,0.635],[0.335,0.565],[0.3,0.53],[0.12,0.53],[0.085,0.545],[0.05,0.5]],
      [[0.075,0.5],[0.105,0.5]],
      [[0.14,0.48],[0.165,0.52]],
      [[0.185,0.48],[0.21,0.52]],
      [[0.23,0.48],[0.255,0.52]],
      [[0.275,0.48],[0.295,0.52]],
      [[0.49,0.5],[0.75,0.5],[0.86,0.5]]
    ]
  },
  "geometry": {
    "pathLength": 2.8069,
    "bounds": {"minX": 0.05, "minY": 0.34, "maxX": 0.96, "maxY": 0.66},
    "area": 0.1043,
    "centroid": {"x": 0.5114, "y": 0.5}
  },
  "derivedAttributes": null,
  "reviewStatus": "draft"
};
export const ARENA = Object.freeze({ width: 1000, height: 640, groundY: 540, swordScale: SWORD_VIEW.scale,
  platforms: [{ x: 130, y: 360, width: 210 }, { x: 660, y: 360, width: 210 }] });
export const PLAY_TIMINGS = Object.freeze({ impactMs: 180, windupMs: 120, activeMs: 140, animationMs: 440 });
const SPEED = 230, AI_SPEED = 170, GRAVITY = 1850, JUMP_SPEED = 900, FEET = DUEL_RULES.feet;
const inputError = (code, message) => ({ accepted: false, error: { code, message } });
const idleInput = () => ({ axis: 0, jump: false, attack: false, pickup: false, crouch: false, guard: false, primary: false, cancel: false, aimAngle: 0, sequence: -1, receivedAt: -1000,
  jumpQueued: false, pickupQueued: false, attackQueued: false, pickupOrder: 0 });

// A local mock adapter for D playtesting. C's transport and A's Phaser client remain separate.
export class PlayArena {
  #clock; #engine; #bodies; #inputs; #mode = 'ai'; #phase = 'ready'; #winnerId = null;
  #lastStep; #startedAt; #events = []; #aiJumpAt = 0; #inputOrder = 0;
  constructor({ clock = () => performance.now() } = {}) { this.#clock = clock; this.#reset('ai', false); }

  #reset(mode, playing) {
    this.#mode = mode; this.#phase = playing ? 'playing' : 'ready'; this.#winnerId = null;
    this.#engine = new CombatEngine({ roomId: 'local-play', matchId: `play-${randomUUID()}`,
      state: playing ? 'playing' : 'waiting', clock: this.#clock, attackWindupMs: PLAY_TIMINGS.impactMs, duel: true });
    this.#engine.registerWeapon(sample, { weaponId: 'starter-sword', ownerId: 'mock-library-author', reviewStatus: 'approved' });
    this.#bodies = new Map(); this.#inputs = new Map(); this.#events = []; this.#aiJumpAt = 0; this.#inputOrder = 0;
    for (const [letter, x, facing] of [['a', mode === 'pickup' ? 420 : 310, 'right'], ['b', mode === 'pickup' ? 580 : 690, 'left']]) {
      const playerId = `player-${letter}`;
      this.#engine.addPlayer({ playerId, x, y: ARENA.groundY - FEET, facing });
      if (mode !== 'pickup') this.#engine.equipWeapon(playerId, 'starter-sword');
      this.#bodies.set(playerId, { vx: 0, vy: 0, grounded: true, knockback: 0,
        swing: null, hurtAt: -1000, blockAt: -1000, deathAt: null, actionResult: null, nextAttackAttemptAt: 0 });
      this.#inputs.set(playerId, idleInput());
    }
    this.#engine.spawnItem({ itemId: 'sword-item', weaponId: 'starter-sword', x: 500, y: ARENA.groundY - FEET });
    this.#lastStep = this.#clock();
    this.#startedAt = this.#lastStep;
  }

  start(mode) {
    if (!['ai', 'local', 'pickup'].includes(mode)) return inputError('INVALID_MODE', '请选择 AI 对战、双人对战或夺剑模式。');
    this.#reset(mode, true);
    return { accepted: true, state: this.getSnapshot() };
  }

  submitInput(letter, packet) {
    const playerId = `player-${letter}`, input = this.#inputs.get(playerId);
    if (!input) return inputError('UNKNOWN_PLAYER', '模拟玩家不存在。');
    if (!packet || typeof packet !== 'object' || Array.isArray(packet) ||
      Object.keys(packet).some(key => !['matchId', 'sequence', 'axis', 'jump', 'attack', 'pickup', 'crouch', 'guard', 'primary', 'cancel', 'aimAngle'].includes(key)) ||
      typeof packet.matchId !== 'string' || !Number.isSafeInteger(packet.sequence) || packet.sequence < 0 || packet.sequence > 1e9 ||
      ![-1, 0, 1].includes(packet.axis) || !['jump', 'attack', 'pickup'].every(key => typeof packet[key] === 'boolean') ||
      !['crouch', 'guard', 'primary', 'cancel'].every(key => packet[key] === undefined || typeof packet[key] === 'boolean') ||
      !(packet.aimAngle === undefined || typeof packet.aimAngle === 'number' && Number.isFinite(packet.aimAngle) && Math.abs(packet.aimAngle) <= DUEL_RULES.maxAimAngle)) {
      return inputError('INVALID_INPUT', '只接受有序的移动、跳跃、蹲伏、攻击、格挡与拾取按键。');
    }
    if (packet.matchId !== this.#engine.getSnapshot().matchId) return inputError('STALE_MATCH', '本局已重新开始。');
    if (this.#mode === 'ai' && letter === 'b') return inputError('AI_CONTROLLED', '玩家 B 由练习对手控制。');
    if (packet.sequence <= input.sequence) return { accepted: true, replayed: true, sequence: input.sequence };
    if (this.#phase !== 'playing') return inputError('MATCH_NOT_PLAYING', '请先开始或重新开局。');
    const normalized = { crouch: false, guard: false, primary: false, cancel: false, aimAngle: 0, ...packet };
    const body = this.#bodies.get(playerId), wasPrimary = input.primary;
    this.#engine.setCombatAim(playerId, normalized.aimAngle);
    this.#engine.setCombatStance(playerId, { crouching: normalized.crouch && body.grounded, guarding: normalized.guard });
    if (normalized.cancel) {
      this.#engine.cancelCharge(playerId); normalized.primary = false;
    } else if (normalized.primary && !wasPrimary) {
      const response = this.#engine.beginCharge(playerId);
      body.actionResult = response.accepted ? null : response.error.code;
      this.#record(response.events);
    } else if (!normalized.primary && wasPrimary) {
      const response = this.#engine.releaseCharge(playerId, { requestId: `release-${randomUUID()}`, weaponId: 'starter-sword',
        targetId: letter === 'a' ? 'player-b' : 'player-a' });
      body.actionResult = response.accepted ? null : response.error.code;
      this.#record(response.events);
    }
    input.jumpQueued ||= packet.jump && !input.jump;
    input.attackQueued ||= packet.attack && !input.attack;
    if (packet.pickup && !input.pickup && !input.pickupQueued) input.pickupOrder = ++this.#inputOrder;
    input.pickupQueued ||= packet.pickup && !input.pickup;
    Object.assign(input, normalized, { receivedAt: this.#clock() });
    return { accepted: true, replayed: false, sequence: input.sequence };
  }

  #record(events) {
    for (const event of events) {
      this.#events.push(event);
      const actorBody = this.#bodies.get(event.actorId), targetBody = this.#bodies.get(event.targetId);
      if (event.type === 'combat:swing') {
        const actor = this.#engine.getSnapshot().players.find(p => p.playerId === event.actorId);
        actorBody.swing = { swingId: event.eventId, startedAt: event.occurredAt, impactAt: event.result.impactAt,
          endsAt: event.occurredAt + event.result.animationMs, facing: actor.facing,
          action: event.result.action, crouching: actor.crouching };
      }
      if (event.type === 'combat:hit') {
        const players = this.#engine.getSnapshot().players;
        const actor = players.find(p => p.playerId === event.actorId), target = players.find(p => p.playerId === event.targetId);
        targetBody.hurtAt = event.occurredAt;
        targetBody.knockback = (target.x >= actor.x ? 1 : -1) * 320;
        targetBody.vy = Math.min(targetBody.vy, -120);
        targetBody.grounded = false;
      }
      if (event.type === 'combat:kill') {
        targetBody.deathAt = event.occurredAt;
        this.#winnerId = event.actorId; this.#phase = 'finished'; this.#engine.setMatchState('finished');
      }
      if (event.type === 'combat:blocked') {
        targetBody.blockAt = event.occurredAt;
        actorBody.knockback = (this.#engine.getSnapshot().players.find(p => p.playerId === event.actorId).facing === 'right' ? -1 : 1) * 90;
      }
      if (event.type === 'combat:guard_break') targetBody.blockAt = event.occurredAt;
      if (event.type === 'combat:clash') {
        for (const participant of event.result.participants) {
          const body = this.#bodies.get(participant.playerId);
          Object.assign(body.swing, { clashedAt: event.occurredAt, endsAt: event.result.reboundUntil,
            reboundFrom: participant.reboundFrom });
          body.knockback = (body.swing.facing === 'right' ? -1 : 1) * 90;
          body.actionResult = null;
        }
      }
      if (event.type === 'item:picked_up' && this.#mode === 'pickup') {
        this.#winnerId = event.actorId; this.#phase = 'finished'; this.#engine.setMatchState('finished');
      }
    }
    this.#events = this.#events.slice(-64);
  }

  #ai(now, players) {
    const a = players.find(p => p.playerId === 'player-a'), b = players.find(p => p.playerId === 'player-b');
    const body = this.#bodies.get('player-b'), input = this.#inputs.get('player-b');
    const dx = a.x - b.x, dy = a.y - b.y, distance = Math.hypot(dx, dy);
    input.aimAngle = Math.atan2(dy, Math.max(1, Math.abs(dx)));
    input.axis = Math.abs(dx) > 88 ? Math.sign(dx) : Math.abs(dx) < 55 ? -Math.sign(dx) : 0;
    input.attack = distance < 105 && Math.abs(dy) < 38;
    // The practice opponent visibly guards while P1 charges: thrusts can beat this guard.
    const incoming = this.#bodies.get('player-a').swing;
    input.guard = (a.chargingSince !== null || incoming?.action === 'thrust' && now < incoming.endsAt) && Math.abs(dx) < 145 && b.stamina > 30;
    if (input.guard) input.attack = false;
    if (body.swing && now < body.swing.endsAt) input.axis = 0;
    if (a.y < b.y - 45 && Math.abs(dx) < 260 && body.grounded && now >= this.#aiJumpAt) {
      input.jumpQueued = true; this.#aiJumpAt = now + 900;
    }
    input.receivedAt = now;
  }

  step() {
    const now = this.#clock(), dt = Math.max(0, Math.min((now - this.#lastStep) / 1000, 0.05));
    this.#lastStep = now;
    if (this.#phase !== 'playing') { this.#record(this.#engine.advance()); return; }
    let players = this.#engine.getSnapshot().players;
    if (this.#mode === 'ai') this.#ai(now, players);
    for (const player of players) {
      const body = this.#bodies.get(player.playerId), input = this.#inputs.get(player.playerId);
      if (now - input.receivedAt > 250) {
        this.#engine.cancelCharge(player.playerId);
        Object.assign(input, { axis: 0, jump: false, attack: false, pickup: false, primary: false, crouch: false, guard: false,
          jumpQueued: false, attackQueued: false, pickupQueued: false });
      }
      this.#engine.setCombatStance(player.playerId, { crouching: input.crouch && body.grounded, guarding: input.guard });
      this.#engine.setCombatAim(player.playerId, input.aimAngle);
      const combat = this.#engine.getSnapshot().players.find(p => p.playerId === player.playerId);
      if (input.jumpQueued && body.grounded) {
        const response = this.#engine.tryJump(player.playerId);
        if (response.accepted) { body.vy = -JUMP_SPEED; body.grounded = false; }
        body.actionResult = response.accepted ? null : response.error.code;
      }
      input.jumpQueued = false;
      const movementScale = now < combat.staggerUntil ? 0 : combat.crouching ? 0.42 : combat.blocking ? 0.45 :
        combat.chargingSince !== null ? 0.5 : body.swing && now < body.swing.endsAt ? 0.55 : 1;
      body.vx = input.axis * (this.#mode === 'ai' && player.playerId === 'player-b' ? AI_SPEED : SPEED) * movementScale + body.knockback;
      body.knockback *= Math.exp(-8 * dt);
      let x = Math.min(ARENA.width - 32, Math.max(32, player.x + body.vx * dt));
      const previousFeet = player.y + FEET;
      body.vy += GRAVITY * dt;
      let y = player.y + body.vy * dt; body.grounded = false;
      for (const surface of [...ARENA.platforms, { x: 0, y: ARENA.groundY, width: ARENA.width }].sort((a, b) => a.y - b.y)) {
        if (body.vy >= 0 && previousFeet <= surface.y + 0.1 && y + FEET >= surface.y &&
          x + player.radius > surface.x && x - player.radius < surface.x + surface.width) {
          y = surface.y - FEET; body.vy = 0; body.grounded = true; break;
        }
      }
      if (y + FEET > ARENA.groundY) { y = ARENA.groundY - FEET; body.vy = 0; body.grounded = true; }
      const swingLocked = body.swing && now < body.swing.endsAt;
      const facing = swingLocked ? body.swing.facing : input.axis === 0 ? player.facing : input.axis > 0 ? 'right' : 'left';
      this.#engine.updatePlayerPosition(player.playerId, { x, y, facing });
    }
    players = this.#engine.getSnapshot().players;
    // Resolve body overlap on the server so players cannot simply walk through each other.
    const [a, b] = players;
    if (Math.abs(a.y - b.y) < 112 && Math.abs(a.x - b.x) < 38) {
      const sign = a.x <= b.x ? 1 : -1, correction = (38 - Math.abs(a.x - b.x)) / 2;
      this.#engine.updatePlayerPosition(a.playerId, { x: Math.min(968, Math.max(32, a.x - sign * correction)), y: a.y, facing: a.facing });
      this.#engine.updatePlayerPosition(b.playerId, { x: Math.min(968, Math.max(32, b.x + sign * correction)), y: b.y, facing: b.facing });
    }
    for (const player of this.#engine.getSnapshot().players) {
      const body = this.#bodies.get(player.playerId), input = this.#inputs.get(player.playerId);
      if ((input.attackQueued || input.attack) && now >= player.readyAt && now >= body.nextAttackAttemptAt &&
        player.chargingSince === null && (!body.swing || now >= body.swing.endsAt)) {
        const response = this.#engine.attack(player.playerId, { requestId: `swing-${randomUUID()}`, weaponId: 'starter-sword', targetId: player.playerId === 'player-a' ? 'player-b' : 'player-a' });
        body.actionResult = response.accepted ? null : response.error.code;
        body.nextAttackAttemptAt = now + 125;
        this.#record(response.events);
      }
      input.attackQueued = false;
    }
    // Process same-tick pickup intents in server arrival order, not by player label.
    const contenders = this.#engine.getSnapshot().players.filter(player => this.#inputs.get(player.playerId).pickupQueued)
      .sort((a, b) => this.#inputs.get(a.playerId).pickupOrder - this.#inputs.get(b.playerId).pickupOrder);
    for (const player of contenders) {
      const body = this.#bodies.get(player.playerId), input = this.#inputs.get(player.playerId);
      if (input.pickupQueued) {
        const response = this.#engine.pickup(player.playerId, { requestId: `pickup-${randomUUID()}`, itemId: 'sword-item' });
        body.actionResult = response.accepted ? 'PICKUP_OK' : response.error.code;
        this.#record(response.events); input.pickupQueued = false;
      }
    }
    this.#record(this.#engine.advance());
  }

  getSnapshot() {
    const state = this.#engine.getSnapshot();
    return structuredClone({ ...state, players: state.players.map(player => ({ ...player, ...this.#bodies.get(player.playerId),
      inputSequence: this.#inputs.get(player.playerId).sequence })),
      mode: this.#mode, phase: this.#phase, startedAt: this.#startedAt, winnerId: this.#winnerId, events: structuredClone(this.#events),
      arena: ARENA, timings: PLAY_TIMINGS, mockOnly: true });
  }
}
