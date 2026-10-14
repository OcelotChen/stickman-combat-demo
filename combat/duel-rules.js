// Opt-in playtest rules. These do not change the V0.1 JSON geometry contract.
export const DUEL_RULES = Object.freeze({
  version: 'd-duel-draft-0.4', maxStamina: 100, chargeMs: 600,
  regenPerSecond: 24, regenDelayMs: 650,
  blockCost: 22, jumpCost: 12, guardBreakMs: 900, hurtStaggerMs: 240,
  clashStartMs: 120, clashSampleMs: 4, clashReboundMs: 260,
  feet: 64, standingTop: -62, crouchingTop: 1, maxAimAngle: Math.PI / 2, guardHalfAngle: Math.PI / 3,
  slash: Object.freeze({ staminaCost: 18, damageScale: 1, reachScale: 0.65,
    cooldownScale: 1, impactMs: 180, animationMs: 440, height: -12, crouchingHeight: 28, halfHeight: 8 }),
  thrust: Object.freeze({ staminaCost: 32, damageScale: 1.5, reachScale: 0.85,
    cooldownScale: 1.5, impactMs: 160, animationMs: 520, height: -6, crouchingHeight: 30, halfHeight: 8 }),
});
