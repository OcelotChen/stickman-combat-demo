import { analyzeDrawing } from './geometry.js';
import { ATTACK_TYPE, DEFAULT_CATEGORY_ACTIONS, RULES_VERSION, fail, isRecord, validateCategoryActions } from './rules.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function evaluateWeapon(document, categoryActions = DEFAULT_CATEGORY_ACTIONS) {
  const actions = validateCategoryActions(categoryActions);
  if (!isRecord(document) || document.schemaVersion !== '0.1') fail('SCHEMA_VERSION', '仅支持武器 JSON 0.1。', 'schemaVersion');
  if (typeof document.name !== 'string' || !document.name.trim() || document.name.trim().length > 40) {
    fail('INVALID_NAME', '武器名称需要 1–40 个字符。', 'name');
  }
  if (typeof document.category !== 'string' || !Object.hasOwn(actions, document.category)) {
    fail('UNSUPPORTED_CATEGORY', '类别尚未映射到已实现的攻击行为。', 'category');
  }
  const geometry = analyzeDrawing(document.drawing);
  // Decoration affects preview length, but never damage, range or cooldown.
  const derivedAttributes = {
    rulesVersion: RULES_VERSION,
    attackType: ATTACK_TYPE,
    damage: clamp(Math.round(8 + 100 * geometry.area), 8, 30),
    reach: clamp(Math.round(60 + 90 * geometry.span), 60, 160),
    cooldownMs: clamp(Math.round(350 + 1200 * geometry.area + 150 * geometry.span), 350, 1200),
  };
  // Explicitly discard client IDs, owner, approval and precomputed geometry/stats.
  return {
    schemaVersion: '0.1', name: document.name.trim(), category: document.category,
    drawing: { coordinateSpace: 'normalized-0-to-1', strokes: structuredClone(document.drawing.strokes) }, geometry, derivedAttributes,
  };
}
