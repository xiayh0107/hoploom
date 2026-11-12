/** Coalesce same-turn metadata refreshes; a later mutation starts a fresh batch. */
export function batchRefresh(run: (ids?: string[]) => Promise<void>) {
  let pending = false, all = false;
  const ids = new Set<string>();
  let waiters: {resolve: () => void; reject: (reason: unknown) => void}[] = [];
  return (hostIds?: string[]) => new Promise<void>((resolve, reject) => {
    if (hostIds === undefined) all = true; else hostIds.forEach(id => ids.add(id));
    waiters.push({resolve, reject});
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      const selected = all ? undefined : [...ids], current = waiters;
      pending = all = false; ids.clear(); waiters = [];
      run(selected).then(() => current.forEach(waiter => waiter.resolve()), reason => current.forEach(waiter => waiter.reject(reason)));
    });
  });
}
