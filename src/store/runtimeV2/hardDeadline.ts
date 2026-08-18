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

/**
 * Bound a provider phase by inactivity instead of total generation time.
 *
 * Each call to `markProgress` renews the same bounded lease. Callers must use
 * transport progress here (headers/chunks) and keep semantic/model-progress
 * stall policy in the streaming adapter. A separate hard lifecycle deadline
 * must still own the Run's total wall clock.
 */
export async function withRuntimeV2ProgressDeadline<T>(input: {
  readonly timeoutMs: number;
  readonly task: (lease: { readonly markProgress: () => void }) => Promise<T>;
  readonly onTimeout?: () => void;
  readonly timeoutError?: string;
}): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let rejectDeadline: ((error: Error) => void) | null = null;
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs));
  const fail = () => {
    if (settled) return;
    try {
      input.onTimeout?.();
    } catch {
      // Cancellation is best-effort. The progress deadline still settles.
    }
    rejectDeadline?.(new Error(
      input.timeoutError || RUNTIME_V2_HARD_DEADLINE_ERROR,
    ));
  };
  const arm = () => {
    if (settled) return;
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(fail, timeoutMs);
  };
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
    arm();
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => input.task({ markProgress: arm })),
      deadline,
    ]);
  } finally {
    settled = true;
    rejectDeadline = null;
    if (timeout) clearTimeout(timeout);
  }
}
