export const RUNTIME_V2_HARD_DEADLINE_ERROR =
  "RUNTIME_V2_HARD_DEADLINE_EXCEEDED";

/**
 * Enforce a wall-clock deadline even when a provider transport ignores
 * AbortSignal. The caller still owns transport cancellation through
 * `onTimeout`; this race owns control-flow convergence.
 */
export async function withRuntimeV2HardDeadline<T>(input: {
  readonly timeoutMs: number;
  readonly task: () => Promise<T>;
  readonly onTimeout?: () => void;
  readonly timeoutError?: string;
}): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs));
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      try {
        input.onTimeout?.();
      } catch {
        // Cancellation is best-effort. The hard deadline must still settle.
      }
      reject(new Error(
        input.timeoutError || RUNTIME_V2_HARD_DEADLINE_ERROR,
      ));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(input.task),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
