import {expect, it, vi} from 'vitest';
import {batchRefresh} from './batchRefresh';

it('coalesces affected host reads and lets a later mutation start a fresh read', async () => {
  let complete!: () => void;
  const run = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => {complete = resolve;})).mockResolvedValue(undefined);
  const refresh = batchRefresh(run);
  const first = refresh(['a']), duplicate = refresh(['a', 'b']);
  await Promise.resolve(); expect(run).toHaveBeenCalledExactlyOnceWith(['a', 'b']);
  await refresh(['a']);
  expect(run).toHaveBeenCalledTimes(2);
  complete(); await Promise.all([first, duplicate]);
});

it('uses a complete refresh when requested in the same batch and propagates failure', async () => {
  const run = vi.fn().mockResolvedValue(undefined), refresh = batchRefresh(run);
  await Promise.all([refresh(['a']), refresh()]);
  expect(run).toHaveBeenCalledExactlyOnceWith(undefined);
  run.mockRejectedValueOnce(new Error('unavailable'));
  await expect(refresh(['b'])).rejects.toThrow('unavailable');
  await refresh(['c']); expect(run).toHaveBeenLastCalledWith(['c']);
});
