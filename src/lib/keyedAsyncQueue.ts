export interface KeyedAsyncQueue {
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  pendingKeyCount(): number;
}

/**
 * Serialize asynchronous mutations for the same durable owner while allowing
 * unrelated owners to proceed concurrently. A rejected mutation releases the
 * queue and cannot strand later work.
 */
export function createKeyedAsyncQueue(): KeyedAsyncQueue {
  const tails = new Map<string, Promise<void>>();

  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const normalizedKey = String(key || "").trim() || "__default__";
      const previous = tails.get(normalizedKey) || Promise.resolve();
      const run = previous.catch(() => undefined).then(task);
      const tail = run.then(
        () => undefined,
        () => undefined,
      );
      tails.set(normalizedKey, tail);
      return run.finally(() => {
        if (tails.get(normalizedKey) === tail) {
          tails.delete(normalizedKey);
        }
      });
    },
    pendingKeyCount(): number {
      return tails.size;
    },
  };
}
