import { analyzeDrawing } from './geometry.js';
import { ATTACK_TYPE, DEFAULT_CATEGORY_ACTIONS, RULES_VERSION, fail, isRecord, validateCategoryActions } from './rules.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function validateHeader(document) {
  if (!isRecord(document) || document.schemaVersion !== '0.1') fail('SCHEMA_VERSION', '仅支持武器 JSON 0.1。', 'schemaVersion');
  if (typeof document.name !== 'string' || !document.name.trim() || document.name.trim().length > 40) {
    fail('INVALID_NAME', '武器名称需要 1–40 个字符。', 'name');
  }
}

function meleeAttributes(geometry) {
  // Decoration affects preview length, but never damage, range or cooldown.
  return {
    rulesVersion: RULES_VERSION,
    attackType: ATTACK_TYPE,
    damage: clamp(Math.round(8 + 100 * geometry.area), 8, 30),
    reach: clamp(Math.round(60 + 90 * geometry.span), 60, 160),
    cooldownMs: clamp(Math.round(350 + 1200 * geometry.area + 150 * geometry.span), 350, 1200),
  };
}

export function evaluateWeapon(document, categoryActions = DEFAULT_CATEGORY_ACTIONS) {
  const actions = validateCategoryActions(categoryActions);
  validateHeader(document);
  if (typeof document.category !== 'string' || !Object.hasOwn(actions, document.category)) {
    fail('UNSUPPORTED_CATEGORY', '类别尚未映射到已实现的攻击行为。', 'category');
  }
  const geometry = analyzeDrawing(document.drawing);
  const derivedAttributes = meleeAttributes(geometry);
  // Explicitly discard client IDs, owner, approval and precomputed geometry/stats.
  return {
    schemaVersion: '0.1', name: document.name.trim(), category: document.category,
    drawing: { coordinateSpace: 'normalized-0-to-1', strokes: structuredClone(document.drawing.strokes) }, geometry, derivedAttributes,
  };
}

// For E's library. A successful shape check is independent of publication or equipping.
export const LIBRARY_RULES_VERSION = `d-shape-draft-0.1+${RULES_VERSION}`;
export function validateWeaponShape(document) {
  validateHeader(document);
  if (!['melee', 'throwable', 'ranged'].includes(document.category)) {
    fail('UNSUPPORTED_CATEGORY', '类别需要武器库审核。', 'category');
  }
  const geometry = analyzeDrawing(document.drawing);
  const combatAvailable = Object.hasOwn(DEFAULT_CATEGORY_ACTIONS, document.category);
  const derivedAttributes = combatAvailable ? meleeAttributes(geometry) : { rulesVersion: LIBRARY_RULES_VERSION };
  return { valid: true, geometry, derivedAttributes, rulesVersion: LIBRARY_RULES_VERSION,
    attackType: derivedAttributes.attackType ?? null, combatAvailable, source: 'D.validateWeaponShape' };
}
