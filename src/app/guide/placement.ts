export interface Size { width: number; height: number }
export interface Box { top: number; bottom: number; left: number; right: number }
export interface CardPlacementInput {
  viewport: Size;
  card: Size;
  target: Box | null;
  margin: number;
  gap: number;
  pad: number;
}

export function intersectsViewport(box: Box, viewport: Size): boolean {
  return box.bottom > 0 && box.top < viewport.height && box.right > 0 && box.left < viewport.width;
}

/** 下 → 上 → 左 → 右 → 対象との重なりが最小の四隅・四辺中央の順で配置する。 */
export function computeTourCardPosition(input: CardPlacementInput): { left: number; top: number } {
  const { viewport, card, target, margin, gap, pad } = input;
  const clamp = (value: number, limit: number): number => Math.max(margin, Math.min(value, limit - margin));
  const topLimit = viewport.height - card.height;
  const leftLimit = viewport.width - card.width;
  const bottom = clamp(topLimit, topLimit);
  if (!target || !intersectsViewport(target, viewport)) return { left: clamp(leftLimit, leftLimit), top: bottom };
  const left = clamp(target.left, leftLimit);
  const below = target.bottom + pad + gap;
  if (below + card.height <= viewport.height - margin) return { left, top: clamp(below, topLimit) };
  const above = target.top - pad - gap - card.height;
  if (above >= margin) return { left, top: clamp(above, topLimit) };
  const sideTop = clamp(target.top - pad, topLimit);
  const before = target.left - pad - gap - card.width;
  if (before >= margin) return { left: before, top: sideTop };
  const after = target.right + pad + gap;
  if (after + card.width <= viewport.width - margin) return { left: after, top: sideTop };
  const candidates = [
    { left: clamp(leftLimit, leftLimit), top: bottom },
    { left: margin, top: bottom },
    { left: clamp(leftLimit, leftLimit), top: margin },
    { left: margin, top: margin },
    { left: clamp(leftLimit / 2, leftLimit), top: margin },
    { left: clamp(leftLimit / 2, leftLimit), top: bottom },
    { left: margin, top: clamp(topLimit / 2, topLimit) },
    { left: clamp(leftLimit, leftLimit), top: clamp(topLimit / 2, topLimit) },
  ];
  const overlap = (point: { left: number; top: number }): number =>
    Math.max(0, Math.min(point.left + card.width, target.right) - Math.max(point.left, target.left)) *
    Math.max(0, Math.min(point.top + card.height, target.bottom) - Math.max(point.top, target.top));
  return candidates.reduce((best, corner) => overlap(corner) < overlap(best) ? corner : best);
}
