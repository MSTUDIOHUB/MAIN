export interface AutoScrollStateInput {
  scrollTop: number;
  previousScrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  nearBottomThreshold?: number;
  upwardMovementTolerance?: number;
}

export function getDistanceFromBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

/**
 * 只要用户明确向上滚动浏览历史，就立即释放自动贴底；
 * 只有重新滚回接近底部时，才恢复自动跟随。
 */
export function resolveAutoScrollState({
  scrollTop,
  previousScrollTop,
  scrollHeight,
  clientHeight,
  nearBottomThreshold = 100,
  upwardMovementTolerance = 2,
}: AutoScrollStateInput): boolean {
  const distanceFromBottom = getDistanceFromBottom(scrollTop, scrollHeight, clientHeight);
  const didScrollUp = scrollTop < previousScrollTop - upwardMovementTolerance;

  if (didScrollUp) return false;
  return distanceFromBottom < nearBottomThreshold;
}
