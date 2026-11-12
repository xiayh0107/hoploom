import {api} from './api';

type Read = {controller: AbortController; promise: Promise<unknown>; readers: number; settled: boolean};
const reads = new Map<string, Read>();

/** Share an in-flight read; the last subscriber owns its cancellation. */
export function acquireMetadata<T>(path: string) {
  let read = reads.get(path);
  if (!read) {
    const controller = new AbortController();
    read = {controller, readers: 0, settled: false, promise: undefined!};
    const current = read;
    current.promise = api<T>(path, {signal: controller.signal}).finally(() => {
      current.settled = true;
      if (reads.get(path) === current) reads.delete(path);
    });
    reads.set(path, current);
  }
  const current = read;
  current.readers++;
  let released = false;
  return {promise: current.promise as Promise<T>, release: () => {
    if (released) return;
    released = true; current.readers--;
    // An effect may immediately resubscribe in React's development lifecycle.
    queueMicrotask(() => {
      if (current.readers || current.settled) return;
      if (reads.get(path) === current) reads.delete(path);
      current.controller.abort();
    });
  }};
}
