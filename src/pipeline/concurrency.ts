/** Tiny homemade concurrency limiter (no p-limit dependency). */
export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active += 1;
        fn().then(resolve, reject).finally(release);
      };
      if (active < concurrency) {
        run();
      } else {
        queue.push(run);
      }
    });
  };
}

/** Hard timeout wrapper: aborts `fn`'s signal and rejects once `ms` elapses. */
export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${ms}ms`)), ms);

  try {
    return await new Promise<T>((resolve, reject) => {
      fn(controller.signal).then(resolve, reject);
      controller.signal.addEventListener("abort", () => reject(new Error(`timeout after ${ms}ms`)));
    });
  } finally {
    clearTimeout(timer);
  }
}
