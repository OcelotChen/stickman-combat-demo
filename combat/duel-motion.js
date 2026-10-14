// Shared by the authoritative sword collision and Canvas animation. The grip and
// local orientation are temporary conventions for the PR #7 starter sword.
export const SWORD_VIEW = Object.freeze({ gripX: 0.15, gripY: 0.5, span: 0.91, scale: 0.6,
  guardRiseMs: 140, guardReturnMs: 180, guardRecoilMs: 200 });
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);

export function slashAngle(elapsed) {
  if (elapsed < 120) return mix(0, -0.85, smooth(clamp(elapsed / 120, 0, 1)));
  if (elapsed < 240) return mix(-0.85, 0.85, smooth(clamp((elapsed - 120) / 120, 0, 1)));
  return mix(0.85, 0, smooth(clamp((elapsed - 240) / 200, 0, 1)));
}

export function guardSwordPose(player, now, crouch = Number(player.crouching)) {
  const facing = player.facing === 'right' ? 1 : -1;
  const aim = clamp(player.aimAngle, -Math.PI / 2, Math.PI / 2);
  const age = now - (player.guardHitAt ?? -1000);
  const recoil = age >= 0 && age < SWORD_VIEW.guardRecoilMs ? Math.sin(age / SWORD_VIEW.guardRecoilMs * Math.PI) : 0;
  return { facing, handX: facing * (20 + 14 * Math.cos(aim) - recoil * 7),
    handY: mix(20, 47, crouch) + Math.sin(aim) * 30 + recoil * 4,
    angle: clamp(aim - 1.05 + recoil * 0.24, -Math.PI / 2, Math.PI / 2), extension: 0, recoil };
}

export function swordPose(player, swing, now, crouch = Number(swing?.crouching ?? player.crouching), guardProgress = Number(player.blocking)) {
  const facing = (swing?.facing ?? player.facing) === 'right' ? 1 : -1;
  const aim = clamp(player.aimAngle, -Math.PI / 2, Math.PI / 2);
  const elapsed = swing ? now - swing.startedAt : 0;
  const thrusting = swing?.action === 'thrust';
  const charging = !swing && player.chargingSince !== null;
  const extension = thrusting ? (elapsed < 170 ? smooth(clamp(elapsed / 170, 0, 1)) :
    1 - smooth(clamp((elapsed - 220) / 300, 0, 1))) : 0;
  let handReach = thrusting ? mix(12, 52, extension) : charging ? 12 : swing ? 30 : 29;
  let angle = swing && !thrusting ? clamp(aim + slashAngle(elapsed), -Math.PI / 2, Math.PI / 2) : aim;
  let handX = facing * handReach * Math.cos(aim);
  let handY = mix(thrusting || charging ? -6 : swing ? -12 : -8, 29, crouch) + handReach * Math.sin(aim);
  if (swing?.clashedAt !== undefined) {
    const t = clamp((now - swing.clashedAt) / (swing.endsAt - swing.clashedAt), 0, 1);
    const backward = clamp(swing.reboundFrom.angle - 0.65, -Math.PI / 2, Math.PI / 2);
    angle = t < 0.35 ? mix(swing.reboundFrom.angle, backward, smooth(t / 0.35)) :
      mix(backward, aim, smooth((t - 0.35) / 0.65));
    handReach = 30 - Math.sin(t * Math.PI) * 14;
    handX = mix(swing.reboundFrom.handX, facing * handReach * Math.cos(aim), smooth(t));
    handY = mix(swing.reboundFrom.handY, mix(-8, 29, crouch) + handReach * Math.sin(aim), smooth(t));
  }
  const guarding = !swing && !charging ? smooth(clamp(guardProgress, 0, 1)) : 0;
  const guard = guardSwordPose(player, now, crouch);
  return { facing, angle: mix(angle, guard.angle, guarding), handX: mix(handX, guard.handX, guarding),
    handY: mix(handY, guard.handY, guarding), extension, guarding, guardRecoil: guard.recoil * guarding };
}

export function swordOutline(player, swing, weapon, now) {
  const pose = swordPose(player, swing, now);
  const scale = weapon.derivedAttributes.reach * SWORD_VIEW.scale / SWORD_VIEW.span;
  const cos = Math.cos(pose.angle), sin = Math.sin(pose.angle);
  const outline = weapon.drawing.strokes.find(path => path.length > 3 &&
    path[0][0] === path.at(-1)[0] && path[0][1] === path.at(-1)[1]);
  return outline.slice(0, -1).map(([px, py]) => {
    const x = (px - SWORD_VIEW.gripX) * scale, y = (py - SWORD_VIEW.gripY) * scale;
    return { x: player.x + pose.handX + pose.facing * (x * cos - y * sin),
      y: player.y + pose.handY + x * sin + y * cos };
  });
}
