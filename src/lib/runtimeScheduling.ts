/**
 * Schedule a runtime state transition without depending on UI rendering.
 *
 * requestAnimationFrame may stop while a desktop WebView is backgrounded.
 * Durable queues, approvals, and continuation handoffs must keep progressing
 * even when MAIN is not painting.
 */
export function scheduleRuntimeTask(callback: () => void): void {
  setTimeout(callback, 0);
}
