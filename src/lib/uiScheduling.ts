export function runAfterNextPaint(callback: () => void): void {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    setTimeout(callback, 0);
    return;
  }

  window.requestAnimationFrame(() => {
    window.setTimeout(callback, 0);
  });
}
