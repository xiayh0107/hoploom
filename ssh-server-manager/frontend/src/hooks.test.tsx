import {act, renderHook, waitFor} from '@testing-library/react';
import {beforeEach, expect, it, vi} from 'vitest';
import {api} from './api';
import {useResource} from './hooks';

vi.mock('./api', async original => ({...await original<typeof import('./api')>(), api: vi.fn()}));
const mocked = vi.mocked(api);
beforeEach(() => mocked.mockReset());
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}

it('retains local metadata during reload but never shows it for another resource', async () => {
  const pending = deferred<string>();
  mocked.mockResolvedValueOnce('saved').mockReturnValueOnce(pending.promise).mockResolvedValueOnce('other');
  const view = renderHook(({path}) => useResource<string>(path), {initialProps: {path: '/hosts/a/workspace'}});
  await waitFor(() => expect(view.result.current.data).toBe('saved'));
  act(() => view.result.current.reload());
  expect(view.result.current.loading).toBe(true); expect(view.result.current.data).toBe('saved');
  await act(async () => pending.resolve('updated'));
  expect(view.result.current.data).toBe('updated');
  view.rerender({path: '/hosts/b/workspace'});
  expect(view.result.current.data).toBeUndefined();
  await waitFor(() => expect(view.result.current.data).toBe('other'));
});

it('shares reads and cancels only when their last subscriber leaves', async () => {
  const pending = deferred<string>(); let signal: AbortSignal | undefined;
  mocked.mockImplementation(async (_path, options) => {signal = options?.signal as AbortSignal; return pending.promise;});
  const first = renderHook(() => useResource<string>('/hosts/shared/route'));
  const second = renderHook(() => useResource<string>('/hosts/shared/route'));
  expect(mocked).toHaveBeenCalledOnce();
  first.unmount(); await act(async () => {});
  expect(signal?.aborted).toBe(false);
  second.unmount(); await act(async () => {});
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve('ignored'));
});
