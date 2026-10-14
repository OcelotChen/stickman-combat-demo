const randomUUID = () => crypto.randomUUID();
import { evaluateWeapon } from './weapon.js';
import { DUEL_RULES } from './duel-rules.js';
import { segmentHitsBox, polygonContact } from './aim-geometry.js';
import { swordPose, swordOutline } from './duel-motion.js';
import { DEFAULT_CATEGORY_ACTIONS, LIMITS, MAX_HP, PICKUP_DISTANCE, PLAYER_RADIUS, isId, isRecord, validateCategoryActions } from './rules.js';

const messages = {
  INVALID_REQUEST: '请求格式不正确；攻击数值和身份不能由玩家提交。',
  UNKNOWN_PLAYER: '玩家不在当前房间。', MATCH_NOT_PLAYING: '对局尚未开始或已结束。',
  PLAYER_DEAD: '玩家已被击败。', UNKNOWN_WEAPON: '武器不存在。',
  WEAPON_NOT_APPROVED: '武器尚未通过服务器审核。', WEAPON_NOT_EQUIPPED: '玩家未持有该武器。',
  INVALID_TARGET: '目标不是可攻击的存活对手。', COOLDOWN: '攻击仍在冷却。',
  UNKNOWN_ITEM: '物品不存在。', ITEM_TAKEN: '物品已被其他玩家拾取。',
  PICKUP_OUT_OF_RANGE: '距离物品太远。', REQUEST_CONFLICT: '同一请求编号不能用于不同动作。',
  REQUEST_LIMIT: '本局请求数量达到上限。',
  STAMINA: '精力不足，停止攻击和格挡后恢复。', BLOCKING: '格挡期间不能攻击。',
  STAGGERED: '受击后暂时无法行动。', NO_CHARGE: '没有正在蓄力的攻击。', CHARGING: '请先松开正在蓄力的攻击。', CROUCHING: '先站起再跳跃。',
};
const reject = (code, extra = {}) => ({ accepted: false, error: { code, message: messages[code], ...extra }, events: [], replayed: false });
const validPosition = (x, y) => [x, y].every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= LIMITS.maxWorldCoordinate);

// One engine per room/match. These methods are server integration APIs, not client RPCs.
export class CombatEngine {
  #roomId; #matchId; #state; #clock; #lastTime = 0; #eventPrefix; #sequence = 0;
  #players = new Map(); #weapons = new Map(); #items = new Map(); #requests = new Map();
  #categoryActions; #attackWindupMs; #pendingAttacks = []; #duel;

  constructor({ roomId, matchId, state = 'waiting', clock = () => performance.now(), categoryActions = DEFAULT_CATEGORY_ACTIONS, attackWindupMs = 0, duel = false }) {
    if (!isId(roomId) || !isId(matchId) || typeof clock !== 'function') throw new TypeError('Invalid server room/match/clock');
    if (!Number.isInteger(attackWindupMs) || attackWindupMs < 0 || attackWindupMs > 250) throw new TypeError('Invalid server attack windup');
    if (typeof duel !== 'boolean') throw new TypeError('Invalid server duel configuration');
    this.#roomId = roomId; this.#matchId = matchId; this.#clock = clock;
    this.#attackWindupMs = attackWindupMs;
    this.#duel = duel;
    this.#categoryActions = validateCategoryActions(categoryActions);
    this.#eventPrefix = `${roomId}:${matchId}:${randomUUID()}`;
    this.setMatchState(state);
  }

  setMatchState(state) {
    if (!['waiting', 'countdown', 'playing', 'finished'].includes(state)) throw new TypeError('Invalid match state');
    if (this.#duel && state !== 'playing') for (const player of this.#players.values()) {
      this.#syncStamina(player, this.#now());
      Object.assign(player, { chargingSince: null, chargingWeaponId: null, guardHeld: false, blocking: false });
    }
    this.#state = state; // F owns transitions; D only enforces the playing gate.
  }

  registerWeapon(document, { weaponId, ownerId, reviewStatus }) {
    if (!isId(weaponId) || !isId(ownerId) || this.#weapons.has(weaponId) ||
        !['draft', 'pending_review', 'approved', 'rejected'].includes(reviewStatus)) throw new TypeError('Invalid trusted weapon record');
    const record = { ...evaluateWeapon(document, this.#categoryActions), weaponId, ownerId, reviewStatus };
    this.#weapons.set(weaponId, record);
    return structuredClone(record);
  }

  setWeaponReviewStatus(weaponId, status) {
    const weapon = this.#weapons.get(weaponId);
    if (!weapon || !['draft', 'pending_review', 'approved', 'rejected'].includes(status)) throw new TypeError('Invalid trusted review update');
    weapon.reviewStatus = status;
  }

  addPlayer({ playerId, x, y, facing = 'right' }) {
    if (!isId(playerId) || this.#players.has(playerId) || !validPosition(x, y) || !['left', 'right'].includes(facing)) throw new TypeError('Invalid server player');
    this.#players.set(playerId, { playerId, x, y, facing, hp: MAX_HP, radius: PLAYER_RADIUS, equippedWeaponId: null, readyAt: 0 });
    if (this.#duel) Object.assign(this.#players.get(playerId), {
      stamina: DUEL_RULES.maxStamina, staminaUpdatedAt: this.#now(), staminaRecoverAt: 0,
      crouching: false, blocking: false, guardHeld: false, chargingSince: null, aimAngle: 0,
      chargingWeaponId: null, guardHitAt: -1000, guardBrokenUntil: 0, staggerUntil: 0, clashUntil: 0, actionEndsAt: 0,
    });
    this.#requests.set(playerId, new Map());
  }

  updatePlayerPosition(playerId, { x, y, facing }) {
    const player = this.#players.get(playerId);
    if (!player || !validPosition(x, y) || !['left', 'right'].includes(facing)) throw new TypeError('Invalid server position');
    Object.assign(player, { x, y, facing }); // C/A must validate movement before this call.
  }

  equipWeapon(playerId, weaponId) {
    const player = this.#players.get(playerId), weapon = this.#weapons.get(weaponId);
    if (!player || !weapon || weapon.reviewStatus !== 'approved') throw new TypeError('Invalid trusted equipment');
    player.equippedWeaponId = weaponId; // Library authorship is distinct from current possession.
  }

  spawnItem({ itemId, weaponId, x, y }) {
    if (!isId(itemId) || this.#items.has(itemId) || !this.#weapons.has(weaponId) || !validPosition(x, y)) throw new TypeError('Invalid server item');
    this.#items.set(itemId, { itemId, weaponId, x, y, holderId: null });
  }

  getSnapshot() {
    const now = this.#now();
    for (const player of this.#players.values()) this.#syncStamina(player, now);
    return structuredClone({ roomId: this.#roomId, matchId: this.#matchId, state: this.#state,
      now, players: [...this.#players.values()], weapons: [...this.#weapons.values()], items: [...this.#items.values()], pendingAttacks: this.#pendingAttacks,
      ...(this.#duel ? { duelRules: DUEL_RULES } : {}) });
  }

  #canGuard(player, now) {
    return player.guardHeld && player.hp > 0 && this.#state === 'playing' && player.chargingSince === null &&
      now >= Math.max(player.actionEndsAt, player.staggerUntil, player.guardBrokenUntil) && player.stamina > 0 &&
      this.#weapons.get(player.equippedWeaponId)?.reviewStatus === 'approved';
  }

  #syncStamina(player, now) {
    if (!this.#duel) return;
    const previous = player.staminaUpdatedAt;
    if (this.#state === 'playing' && player.hp > 0) {
      // Holding guard is free. Recovery remains paused until guard/charge release.
      if (!player.guardHeld && player.chargingSince === null) {
        player.stamina = Math.min(DUEL_RULES.maxStamina, player.stamina +
          Math.max(0, now - Math.max(previous, player.staminaRecoverAt)) * DUEL_RULES.regenPerSecond / 1000);
      }
    }
    player.staminaUpdatedAt = now;
    player.blocking = Boolean(this.#canGuard(player, now));
  }

  #spend(player, cost, now) {
    if (player.stamina + 1e-9 < cost) return false;
    player.stamina = Math.max(0, player.stamina - cost);
    player.staminaRecoverAt = now + DUEL_RULES.regenDelayMs;
    return true;
  }

  // Trusted movement adapter only; clients submit buttons, never stance/energy values.
  setCombatAim(playerId, aimAngle) {
    const player = this.#players.get(playerId);
    if (!this.#duel || !player || typeof aimAngle !== 'number' || !Number.isFinite(aimAngle) ||
      Math.abs(aimAngle) > DUEL_RULES.maxAimAngle) throw new TypeError('Invalid server aim angle');
    player.aimAngle = aimAngle; // Radians relative to the body's facing; only its front semicircle.
  }

  setCombatStance(playerId, { crouching, guarding }) {
    const player = this.#players.get(playerId);
    if (!this.#duel || !player || typeof crouching !== 'boolean' || typeof guarding !== 'boolean') throw new TypeError('Invalid server stance');
    const now = this.#now(); this.#syncStamina(player, now);
    if (now >= player.actionEndsAt) player.crouching = crouching;
    player.guardHeld = guarding;
    if (guarding) this.cancelCharge(playerId);
    player.blocking = Boolean(this.#canGuard(player, now));
  }

  cancelCharge(playerId) {
    const player = this.#players.get(playerId);
    if (!this.#duel || !player) throw new TypeError('Invalid server charge cancellation');
    this.#syncStamina(player, this.#now());
    player.chargingSince = null; player.chargingWeaponId = null;
  }

  beginCharge(playerId) {
    const player = this.#players.get(playerId), now = this.#now();
    if (!this.#duel || !player) return reject('UNKNOWN_PLAYER');
    this.#syncStamina(player, now);
    const failure = this.#actionFailure(player, now);
    if (failure) return failure;
    if (player.stamina < DUEL_RULES.slash.staminaCost) return reject('STAMINA');
    if (player.chargingSince !== null) return { accepted: true, events: [], replayed: true };
    player.chargingSince = now; player.chargingWeaponId = player.equippedWeaponId;
    const result = { startedAt: now, chargedAt: now + DUEL_RULES.chargeMs };
    return { accepted: true, result, events: [this.#event('combat:charge', playerId, null, player.equippedWeaponId, now, result)], replayed: false };
  }

  releaseCharge(actorId, intent) {
    if (!this.#duel) return reject('INVALID_REQUEST');
    return this.#request(actorId, intent, 'release-charge', ['weaponId', 'targetId'], (actor, now) => {
      this.#syncStamina(actor, now);
      if (actor.chargingSince === null) return reject('NO_CHARGE');
      const duration = now - actor.chargingSince, weaponId = actor.chargingWeaponId;
      actor.chargingSince = null; actor.chargingWeaponId = null;
      if (weaponId !== intent.weaponId || weaponId !== actor.equippedWeaponId) return reject('WEAPON_NOT_EQUIPPED');
      return this.#performAttack(actor, intent, now, duration >= DUEL_RULES.chargeMs ? 'thrust' : 'slash');
    });
  }

  tryJump(playerId) {
    const player = this.#players.get(playerId), now = this.#now();
    if (!this.#duel || !player) return reject('UNKNOWN_PLAYER');
    this.#syncStamina(player, now);
    if (this.#state !== 'playing') return reject('MATCH_NOT_PLAYING');
    if (player.hp <= 0) return reject('PLAYER_DEAD');
    if (player.crouching) return reject('CROUCHING');
    if (now < player.staggerUntil) return reject('STAGGERED');
    if (!this.#spend(player, DUEL_RULES.jumpCost, now)) return reject('STAMINA');
    return { accepted: true, events: [], replayed: false };
  }

  #actionFailure(actor, now) {
    if (this.#state !== 'playing') return reject('MATCH_NOT_PLAYING');
    if (actor.hp <= 0) return reject('PLAYER_DEAD');
    const weapon = this.#weapons.get(actor.equippedWeaponId);
    if (!weapon) return reject('WEAPON_NOT_EQUIPPED');
    if (weapon.reviewStatus !== 'approved') return reject('WEAPON_NOT_APPROVED');
    if (actor.guardHeld) return reject('BLOCKING');
    if (now < actor.staggerUntil) return reject('STAGGERED');
    if (now < actor.readyAt) return reject('COOLDOWN', { retryAfterMs: actor.readyAt - now });
    return null;
  }

  #now() {
    const now = this.#clock();
    if (typeof now !== 'number' || !Number.isFinite(now) || now < 0) throw new TypeError('Invalid server clock');
    this.#lastTime = Math.max(this.#lastTime, Math.floor(now));
    return this.#lastTime;
  }

  #event(type, actorId, targetId, weaponId, now, result) {
    return { eventId: `${this.#eventPrefix}:${++this.#sequence}`, type, roomId: this.#roomId,
      matchId: this.#matchId, actorId, targetId, weaponId, occurredAt: now, result: { accepted: true, ...result } };
  }

  #request(actorId, intent, action, fields, operation) {
    const actor = this.#players.get(actorId);
    if (!actor) return reject('UNKNOWN_PLAYER');
    if (!isRecord(intent) || !isId(intent.requestId) || !fields.every(field => isId(intent[field])) ||
        Object.keys(intent).some(key => !['requestId', ...fields].includes(key))) return reject('INVALID_REQUEST');
    const signature = JSON.stringify([action, ...fields.map(field => intent[field])]);
    const requests = this.#requests.get(actorId), previous = requests.get(intent.requestId);
    if (previous) {
      if (previous.signature !== signature) return reject('REQUEST_CONFLICT');
      // C broadcasts only events, so a retry cannot score or apply damage twice.
      return { ...structuredClone(previous.response), events: [], replayed: true };
    }
    if (requests.size >= LIMITS.maxRequestsPerPlayer) return reject('REQUEST_LIMIT');
    const response = this.#state !== 'playing' ? reject('MATCH_NOT_PLAYING') :
      actor.hp <= 0 ? reject('PLAYER_DEAD') : operation(actor, this.#now());
    requests.set(intent.requestId, { signature, response: structuredClone(response) });
    return structuredClone(response);
  }

  attack(actorId, intent) {
    return this.#request(actorId, intent, 'attack', ['weaponId', 'targetId'], (actor, now) => this.#performAttack(actor, intent, now, 'slash'));
  }

  #performAttack(actor, intent, now, action) {
      const weapon = this.#weapons.get(intent.weaponId), target = this.#players.get(intent.targetId);
      if (!weapon) return reject('UNKNOWN_WEAPON');
      if (weapon.reviewStatus !== 'approved') return reject('WEAPON_NOT_APPROVED');
      if (actor.equippedWeaponId !== weapon.weaponId) return reject('WEAPON_NOT_EQUIPPED');
      if (!target || target === actor || target.hp <= 0) return reject('INVALID_TARGET');
      if (this.#duel) {
        this.#syncStamina(actor, now);
        const failure = this.#actionFailure(actor, now);
        if (failure) return failure;
        if (actor.chargingSince !== null) return reject('CHARGING');
        if (!this.#spend(actor, DUEL_RULES[action].staminaCost, now)) return reject('STAMINA');
      }
      if (now < actor.readyAt) return reject('COOLDOWN', { retryAfterMs: actor.readyAt - now });
      const stats = weapon.derivedAttributes;
      // Cooldown starts when the server accepts the swing, including delayed hits/misses.
      actor.readyAt = now + Math.round(stats.cooldownMs * (this.#duel ? DUEL_RULES[action].cooldownScale : 1));
      const windup = this.#duel ? DUEL_RULES[action].impactMs : this.#attackWindupMs;
      if (this.#duel) { actor.actionEndsAt = now + DUEL_RULES[action].animationMs; actor.blocking = false; }
      if (windup === 0) return this.#resolveHit(actor, target, weapon, now);
      const result = { pending: true, hit: null, damage: 0, startedAt: now,
        impactAt: now + windup, readyAt: actor.readyAt, attackType: action === 'thrust' ? 'melee-thrust' : stats.attackType,
        ...(this.#duel ? { action, aimAngle: actor.aimAngle, animationMs: DUEL_RULES[action].animationMs, staminaCost: DUEL_RULES[action].staminaCost } : {}) };
      const event = this.#event('combat:swing', actor.playerId, target.playerId, weapon.weaponId, now, result);
      this.#pendingAttacks.push({ actorId: actor.playerId, targetId: target.playerId, weaponId: weapon.weaponId,
        swingId: event.eventId, startedAt: now, impactAt: result.impactAt, action, facing: actor.facing, crouching: actor.crouching,
        ...(this.#duel ? { sampledAt: now, sampledPose: { x: actor.x, y: actor.y, aimAngle: actor.aimAngle } } : {}) });
      return { accepted: true, result, events: [event], replayed: false };
  }

  #resolveHit(actor, target, weapon, now, swingId, swing) {
    if (this.#duel) return this.#resolveDuelHit(actor, target, weapon, now, swing);
    const stats = weapon.derivedAttributes, dx = target.x - actor.x, dy = target.y - actor.y;
    const inRange = Math.hypot(dx, dy) <= stats.reach + target.radius;
    const facingTarget = (actor.facing === 'right' ? dx : -dx) >= 0;
    const hpBefore = target.hp, damage = inRange && facingTarget ? Math.min(stats.damage, target.hp) : 0;
    target.hp -= damage;
    const result = { hit: damage > 0, damage, hpBefore, hpAfter: target.hp,
      killed: hpBefore > 0 && target.hp === 0, readyAt: actor.readyAt, attackType: stats.attackType,
      ...(swingId ? { swingId, pending: false } : {}),
      ...(damage === 0 ? { missReason: inRange ? 'NOT_FACING' : 'OUT_OF_RANGE' } : {}) };
    const events = [this.#event(result.hit ? 'combat:hit' : 'combat:miss', actor.playerId, target.playerId, weapon.weaponId, now, result)];
    if (result.killed) events.push(this.#event('combat:kill', actor.playerId, target.playerId, weapon.weaponId, now, result));
    return { accepted: true, result, events, replayed: false };
  }

  #resolveDuelHit(actor, target, weapon, now, swing) {
    this.#syncStamina(target, now);
    const action = swing.action, rule = DUEL_RULES[action], stats = weapon.derivedAttributes;
    const dx = target.x - actor.x, reach = stats.reach * rule.reachScale;
    const aimAngle = actor.aimAngle, facing = swing.facing === 'right' ? 1 : -1;
    const vector = { x: facing * Math.cos(aimAngle), y: Math.sin(aimAngle) };
    const start = { x: actor.x, y: actor.y + (swing.crouching ? rule.crouchingHeight : rule.height) };
    const end = { x: start.x + vector.x * reach, y: start.y + vector.y * reach };
    const box = { minX: target.x - target.radius, maxX: target.x + target.radius,
      minY: target.y + (target.crouching ? DUEL_RULES.crouchingTop : DUEL_RULES.standingTop), maxY: target.y + DUEL_RULES.feet };
    const intersects = segmentHitsBox(start, end, box, rule.halfHeight);
    const missReason = dx * facing < 0 ? 'NOT_FACING' : Math.abs(dx) > reach + target.radius + rule.halfHeight ? 'OUT_OF_RANGE' :
      intersects ? null : Math.abs(aimAngle) < 1e-9 && (start.y + rule.halfHeight < box.minY || start.y - rule.halfHeight > box.maxY) ? 'OUT_OF_HEIGHT' : 'OUT_OF_AIM';
    const result = { pending: false, swingId: swing.swingId, action, attackType: action === 'thrust' ? 'melee-thrust' : stats.attackType,
      readyAt: actor.readyAt, aimAngle, hit: false, damage: 0, hpBefore: target.hp, hpAfter: target.hp, killed: false };
    if (missReason) {
      result.missReason = missReason;
      return { accepted: true, result, events: [this.#event('combat:miss', actor.playerId, target.playerId, weapon.weaponId, now, result)], replayed: false };
    }
    const guardVector = { x: (target.facing === 'right' ? 1 : -1) * Math.cos(target.aimAngle), y: Math.sin(target.aimAngle) };
    const frontalGuard = target.blocking && (target.facing === 'right' ? -dx : dx) >= 0 &&
      -vector.x * guardVector.x - vector.y * guardVector.y >= Math.cos(DUEL_RULES.guardHalfAngle) - 1e-9;
    const guardContact = frontalGuard && action === 'slash' ? polygonContact(swordOutline(actor, swing, weapon, now),
      swordOutline(target, null, this.#weapons.get(target.equippedWeaponId), now)) : null;
    const events = [];
    if (guardContact) {
      result.contact = guardContact;
      if (this.#spend(target, DUEL_RULES.blockCost, now)) {
        target.guardHitAt = now;
        Object.assign(result, { blocked: true, staminaCost: DUEL_RULES.blockCost });
        return { accepted: true, result, events: [this.#event('combat:blocked', actor.playerId, target.playerId, weapon.weaponId, now, result)], replayed: false };
      }
      target.stamina = 0; target.staminaRecoverAt = now + DUEL_RULES.regenDelayMs;
      target.guardBrokenUntil = now + DUEL_RULES.guardBreakMs; target.blocking = false;
      result.guardBroken = true;
      events.push(this.#event('combat:guard_break', actor.playerId, target.playerId, weapon.weaponId, now, { ...result, guardBrokenUntil: target.guardBrokenUntil }));
    }
    result.guardBypassed = frontalGuard && action === 'thrust';
    result.damage = Math.min(target.hp, Math.round(stats.damage * rule.damageScale));
    target.hp -= result.damage;
    target.staggerUntil = now + DUEL_RULES.hurtStaggerMs;
    this.cancelCharge(target.playerId); target.blocking = false;
    Object.assign(result, { hit: true, hpAfter: target.hp, killed: target.hp === 0 });
    events.push(this.#event('combat:hit', actor.playerId, target.playerId, weapon.weaponId, now, result));
    if (result.killed) events.push(this.#event('combat:kill', actor.playerId, target.playerId, weapon.weaponId, now, result));
    return { accepted: true, result, events, replayed: false };
  }

  #swingFailure(swing) {
    const actor = this.#players.get(swing.actorId), target = this.#players.get(swing.targetId), weapon = this.#weapons.get(swing.weaponId);
    return this.#state !== 'playing' ? 'MATCH_NOT_PLAYING' : actor.hp <= 0 ? 'PLAYER_DEAD' :
      target.hp <= 0 ? 'INVALID_TARGET' : weapon.reviewStatus !== 'approved' ? 'WEAPON_NOT_APPROVED' :
      actor.equippedWeaponId !== swing.weaponId ? 'WEAPON_NOT_EQUIPPED' : null;
  }

  #resolveClashes(now) {
    const candidates = this.#pendingAttacks.filter(swing => swing.action === 'slash' && !this.#swingFailure(swing));
    const cancelled = new Set(), events = [];
    const poseAt = (swing, time) => {
      const actor = this.#players.get(swing.actorId), old = swing.sampledPose;
      const t = now === swing.sampledAt ? 1 : Math.max(0, Math.min(1, (time - swing.sampledAt) / (now - swing.sampledAt)));
      return { ...actor, x: old.x + (actor.x - old.x) * t, y: old.y + (actor.y - old.y) * t,
        aimAngle: old.aimAngle + (actor.aimAngle - old.aimAngle) * t };
    };
    for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      if (a.actorId === b.actorId || cancelled.has(a.swingId) || cancelled.has(b.swingId)) continue;
      const from = Math.max(a.startedAt + DUEL_RULES.clashStartMs, b.startedAt + DUEL_RULES.clashStartMs, a.sampledAt, b.sampledAt);
      const to = Math.min(now, a.impactAt, b.impactAt);
      if (from > to) continue;
      const count = Math.max(1, Math.ceil((to - from) / DUEL_RULES.clashSampleMs));
      for (let step = 0; step <= count; step++) {
        const time = from + (to - from) * step / count, aa = poseAt(a, time), bb = poseAt(b, time);
        const contact = polygonContact(swordOutline(aa, a, this.#weapons.get(a.weaponId), time),
          swordOutline(bb, b, this.#weapons.get(b.weaponId), time));
        if (!contact) continue;
        const reboundUntil = now + DUEL_RULES.clashReboundMs;
        const participants = [[a, aa], [b, bb]].map(([swing, pose]) => {
          const actor = this.#players.get(swing.actorId);
          Object.assign(actor, { clashUntil: reboundUntil, actionEndsAt: reboundUntil,
            staggerUntil: Math.max(actor.staggerUntil, reboundUntil), blocking: false });
          cancelled.add(swing.swingId);
          return { playerId: swing.actorId, weaponId: swing.weaponId, swingId: swing.swingId,
            reboundFrom: swordPose(pose, swing, time) };
        });
        events.push(this.#event('combat:clash', a.actorId, b.actorId, a.weaponId, now,
          { action: 'slash', clashed: true, pending: false, hit: false, damage: 0, contact,
            contactAt: time, reboundUntil, staminaCost: 0, participants }));
        break;
      }
    }
    this.#pendingAttacks = this.#pendingAttacks.filter(swing => !cancelled.has(swing.swingId));
    for (const swing of this.#pendingAttacks) {
      const actor = this.#players.get(swing.actorId);
      swing.sampledAt = now; swing.sampledPose = { x: actor.x, y: actor.y, aimAngle: actor.aimAngle };
    }
    return events;
  }

  // Called by the server simulation loop. Clashes cancel both pending hits before damage.
  advance() {
    const now = this.#now();
    for (const player of this.#players.values()) this.#syncStamina(player, now);
    const events = this.#duel ? this.#resolveClashes(now) : [];
    const due = this.#pendingAttacks.filter(swing => swing.impactAt <= now);
    this.#pendingAttacks = this.#pendingAttacks.filter(swing => swing.impactAt > now);
    for (const swing of due) {
      const actor = this.#players.get(swing.actorId), target = this.#players.get(swing.targetId), weapon = this.#weapons.get(swing.weaponId);
      const reason = this.#swingFailure(swing);
      if (reason) events.push(this.#event('combat:cancelled', swing.actorId, swing.targetId, swing.weaponId, now,
        { swingId: swing.swingId, pending: false, damage: 0, reason }));
      else events.push(...this.#resolveHit(actor, target, weapon, now, swing.swingId, swing).events);
    }
    return events;
  }

  pickup(actorId, intent) {
    return this.#request(actorId, intent, 'pickup', ['itemId'], (actor, now) => {
      const item = this.#items.get(intent.itemId);
      if (!item) return reject('UNKNOWN_ITEM');
      if (item.holderId !== null) return reject('ITEM_TAKEN');
      const weapon = this.#weapons.get(item.weaponId);
      if (weapon.reviewStatus !== 'approved') return reject('WEAPON_NOT_APPROVED');
      if (Math.hypot(actor.x - item.x, actor.y - item.y) > PICKUP_DISTANCE) return reject('PICKUP_OUT_OF_RANGE');
      // No await between check and assignment. Atomic within this single Node process.
      item.holderId = actorId;
      actor.equippedWeaponId = item.weaponId;
      const result = { itemId: item.itemId, holderId: actorId, weaponId: item.weaponId };
      return { accepted: true, result, events: [this.#event('item:picked_up', actorId, null, item.weaponId, now, result)], replayed: false };
    });
  }
}
