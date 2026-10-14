// All limits, units and formula coefficients are D's review draft, not balance decisions.
export const RULES_VERSION = 'd-melee-draft-0.1';
export const ATTACK_TYPE = 'melee-swing';
export const DEFAULT_CATEGORY_ACTIONS = Object.freeze({ melee: ATTACK_TYPE });
export const LIMITS = Object.freeze({
  maxStrokes: 32,
  maxPointsPerStroke: 256,
  maxTotalPoints: 1024,
  maxPathLength: 16,
  minArea: 0.002,
  maxArea: 0.6,
  minSpan: 0.05,
  maxRequestBytes: 65536,
  maxRequestsPerPlayer: 1024,
  maxWorldCoordinate: 10000,
});
export const MAX_HP = 100;
export const PLAYER_RADIUS = 12;
export const PICKUP_DISTANCE = 48;

export class WeaponValidationError extends Error {
  constructor(code, message, path = '') {
    super(message);
    this.name = 'WeaponValidationError';
    this.code = code;
    this.path = path;
  }
  toJSON() { return { code: this.code, message: this.message, path: this.path }; }
}

export const round6 = value => Number(value.toFixed(6));
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value);
export function fail(code, message, path) { throw new WeaponValidationError(code, message, path); }

export function validateCategoryActions(actions) {
  if (!isRecord(actions) || !Object.keys(actions).length) throw new TypeError('Category actions must be a nonempty server configuration');
  for (const [category, action] of Object.entries(actions)) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(category) || action !== ATTACK_TYPE) {
      throw new TypeError('A category may only map to the implemented melee-swing action');
    }
  }
  return Object.freeze({ ...actions });
}
