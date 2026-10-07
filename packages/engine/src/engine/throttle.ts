export interface Throttled<T> {
  push(value: T): void;
  dispose(): void;
}

export function throttleLatest<T>(emit: (value: T) => void, intervalMs: number): Throttled<T> {
  let last = Number.NEGATIVE_INFINITY;
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const fire = (value: T) => {
    last = Date.now();
    emit(value);
  };

  return {
    push(value) {
      const wait = last + intervalMs - Date.now();
      if (wait <= 0 && !timer) return fire(value);
      pending = { value };
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const p = pending;
        pending = null;
        if (p) fire(p.value);
      }, Math.max(wait, 0));
      timer.unref?.();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
