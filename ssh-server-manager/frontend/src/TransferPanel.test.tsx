import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {api, ApiError, download, upload, type Progress} from './api';
import TransferPanel from './TransferPanel';
import {enqueueDownload, enqueueUpload, resetTransfers, transferLimits} from './transfers';

vi.mock('./api', async importOriginal => ({...await importOriginal<typeof import('./api')>(), api: vi.fn(), download: vi.fn(), upload: vi.fn()}));
const uploadMock = vi.mocked(upload), downloadMock = vi.mocked(download), apiMock = vi.mocked(api);
// Host-side progress answers, keyed by the attempt id each transfer request carries.
let reports: Record<string, unknown> = {};
const attempt = (call: Call) => new URL(call.path, 'http://fixture').searchParams.get('transfer_id')!;

type Call = {path: string; signal: AbortSignal; onProgress?: Progress; onSent?: () => void; form?: FormData; resolve: (value: never) => void; reject: (error: unknown) => void};
let calls: Call[] = [];
function controlled(kind: 'upload' | 'download') {
  return (path: string, body: unknown, options: {signal?: AbortSignal; onProgress?: Progress; onSent?: () => void} = {}) => new Promise<never>((resolve, reject) => {
    calls.push({path, signal: options.signal!, onProgress: options.onProgress, onSent: options.onSent, form: kind === 'upload' ? body as FormData : undefined, resolve, reject});
  });
}
const dock = () => screen.getByRole('region', {name: 'Transfers'});
const row = (name: string) => within(dock()).getByText(name).closest('li')!;
const file = (name: string, size = 4) => new File(['x'.repeat(size)], name);
const queueUpload = (name: string, size = 4) => enqueueUpload({hostId: 'h/1', alias: 'alpha', directory: '/srv', path: `/srv/${name}`, file: file(name, size)});

beforeEach(() => {
  resetTransfers(); calls = []; reports = {};
  apiMock.mockReset().mockImplementation(async path => {
    const report = reports[path.split('/').at(-1)!];
    if (!report) throw new ApiError(404, 'NotFoundError', 'no transfer with this id is running');
    return report as never;
  });
  uploadMock.mockReset().mockImplementation(controlled('upload') as typeof upload);
  downloadMock.mockReset().mockImplementation(controlled('download') as unknown as typeof download);
  document.querySelector('meta[name="hoploom-frame"]')?.remove();
});
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});

describe('transfer dock', () => {
  it('runs two transfers, queues eight and refuses more; cancelling frees a slot', async () => {
    render(<TransferPanel/>);
    for (let index = 0; index < transferLimits.active + transferLimits.waiting; index++) act(() => {queueUpload(`f${index}.txt`);});
    expect(calls).toHaveLength(2);
    expect(within(dock()).getByText('2 running · 8 queued')).toBeVisible();
    expect(() => queueUpload('one-too-many.txt')).toThrow('At most 10 transfers');
    // A queued transfer that is cancelled never starts.
    fireEvent.click(within(row('f9.txt')).getByRole('button', {name: 'Cancel upload f9.txt'}));
    expect(calls).toHaveLength(2);
    fireEvent.click(within(row('f0.txt')).getByRole('button', {name: 'Cancel upload f0.txt'}));
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[2].form?.get('path')).toBe('/srv/f2.txt');
    await act(async () => {calls[0].reject(new DOMException('aborted', 'AbortError'));});
    expect(within(row('f0.txt')).getByText('Canceled')).toBeVisible();
    expect(within(row('f0.txt')).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows where an upload spends its time and admits that a late cancel may still publish', async () => {
    render(<TransferPanel/>);
    act(() => {queueUpload('report.pdf', 1000);});
    expect(calls[0].path).toMatch(/^\/hosts\/h%2F1\/upload\?transfer_id=[0-9a-f]{32}$/);
    expect(calls[0].form?.get('overwrite')).toBe('false');
    expect(within(row('report.pdf')).getByText('Sending')).toBeVisible();
    expect(within(row('report.pdf')).getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    act(() => calls[0].onProgress?.(250, 1000));
    await waitFor(() => expect(within(row('report.pdf')).getByRole('progressbar', {name: 'upload report.pdf'})).toHaveAttribute('aria-valuenow', '25'));
    expect(within(row('report.pdf')).getByText('25%')).toBeVisible();
    act(() => calls[0].onSent?.());
    const bar = within(row('report.pdf')).getByRole('progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(within(row('report.pdf')).getByText('Writing on host')).toBeVisible();
    fireEvent.click(within(row('report.pdf')).getByRole('button', {name: 'Cancel upload report.pdf'}));
    expect(within(row('report.pdf')).getByText('The host may have finished before the cancel arrived.')).toBeVisible();
  });

  it('reports how far sftp has come on the host, then stops asking', async () => {
    render(<TransferPanel/>);
    act(() => {queueUpload('backup.tar', 1000);});
    act(() => calls[0].onSent?.());
    expect(within(row('backup.tar')).getByText('Writing on host')).toBeVisible();
    reports[attempt(calls[0])] = {phase: 'host', bytes: 500, total: 1000};
    await waitFor(() => expect(within(row('backup.tar')).getByText('Writing on host · 50%')).toBeVisible(), {timeout: 3000});
    expect(within(row('backup.tar')).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    reports[attempt(calls[0])] = {phase: 'host', bytes: 1000, total: 1000};
    await waitFor(() => expect(within(row('backup.tar')).getByText('Finishing on host')).toBeVisible(), {timeout: 3000});
    expect(within(row('backup.tar')).getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');

    act(() => {enqueueDownload({hostId: 'h', alias: 'alpha', path: '/var/db.sqlite', size: 400});});
    reports[attempt(calls[1])] = {phase: 'waiting', bytes: null, total: null};
    await waitFor(() => expect(within(row('db.sqlite')).getByText('Waiting for a free slot')).toBeVisible(), {timeout: 3000});
    reports[attempt(calls[1])] = {phase: 'host', bytes: 100, total: 400};
    await waitFor(() => expect(within(row('db.sqlite')).getByText('Reading on host · 25%')).toBeVisible(), {timeout: 3000});
    // Platforms that cannot count sftp's bytes keep an honest indeterminate bar.
    reports[attempt(calls[1])] = {phase: 'host', bytes: null, total: 400};

    await act(async () => {calls[0].resolve({} as never); calls[1].reject(new ApiError(502, 'unreachable', 'gone'));});
    const asked = apiMock.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(apiMock.mock.calls.length).toBe(asked);
    expect(new Set(apiMock.mock.calls.map(([path]) => path))).toEqual(new Set([`/transfers/${attempt(calls[0])}`, `/transfers/${attempt(calls[1])}`]));
  });

  it('says an upload is waiting while another tab holds the server slots, not that its send stalled', async () => {
    render(<TransferPanel/>);
    act(() => {queueUpload('held.iso', 1000);});
    // The socket absorbs a little before Hoploom stops reading.
    act(() => calls[0].onProgress?.(80, 1000));
    reports[attempt(calls[0])] = {phase: 'waiting', bytes: null, total: null};
    await waitFor(() => expect(within(row('held.iso')).getByText('Waiting for a free slot')).toBeVisible(), {timeout: 3000});
    expect(within(row('held.iso')).getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    reports[attempt(calls[0])] = {phase: 'receiving', bytes: null, total: null};
    await waitFor(() => expect(within(row('held.iso')).getByText('8%')).toBeVisible(), {timeout: 3000});
    act(() => calls[0].onProgress?.(400, 1000));
    await waitFor(() => expect(within(row('held.iso')).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40'));
  });

  it('saves a finished download once, releases its object URL and never saves a cancelled one', async () => {
    const createObjectURL = vi.fn(() => 'blob:saved'), revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, {createObjectURL, revokeObjectURL}));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<TransferPanel/>);
    act(() => {enqueueDownload({hostId: 'h', alias: 'alpha', path: '/var/log/syslog', size: 100});});
    expect(within(row('syslog')).getByText('Reading on host')).toBeVisible();
    act(() => calls[0].onProgress?.(0, 400));
    expect(within(row('syslog')).getByText('Receiving')).toBeVisible();
    act(() => calls[0].onProgress?.(100, 400));
    await waitFor(() => expect(within(row('syslog')).getByText('25%')).toBeVisible());
    await act(async () => {calls[0].resolve({blob: new Blob(['x'.repeat(400)]), filename: 'syslog'} as never);});
    expect(click).toHaveBeenCalledOnce();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:saved'));
    expect(within(row('syslog')).getByText('Saved · 400 B')).toBeVisible();
    expect(within(row('syslog')).getByRole('link', {name: 'alpha:/var/log'})).toHaveAttribute('href', '#/files/h?path=%2Fvar%2Flog');

    act(() => {enqueueDownload({hostId: 'h', alias: 'alpha', path: '/var/log/auth.log', size: 9});});
    fireEvent.click(within(row('auth.log')).getByRole('button', {name: 'Cancel download auth.log'}));
    await act(async () => {calls[1].resolve({blob: new Blob(['late']), filename: 'auth.log'} as never);});
    expect(click).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it('retries a failed transfer only on request, with the same file', async () => {
    render(<TransferPanel/>);
    act(() => {queueUpload('data.csv');});
    const sent = calls[0].form?.get('file');
    await act(async () => {calls[0].reject(new ApiError(503, 'busy', 'too many browser transfers are in progress; try again shortly'));});
    expect(within(row('data.csv')).getByRole('alert')).toHaveTextContent('too many browser transfers');
    expect(calls).toHaveLength(1);
    fireEvent.click(within(row('data.csv')).getByRole('button', {name: 'Retry upload data.csv'}));
    expect(calls).toHaveLength(2);
    expect(calls[1].form?.get('file')).toBe(sent);
    await act(async () => {calls[1].resolve({} as never);});
    expect(within(row('data.csv')).getByText('Uploaded · 4 B')).toBeVisible();
  });

  it('clears finished records, keeps active and undecided ones, and disappears when empty', async () => {
    render(<TransferPanel/>);
    act(() => {queueUpload('done.txt'); queueUpload('exists.txt'); queueUpload('running.txt');});
    await act(async () => {calls[0].resolve({} as never);});
    await act(async () => {calls[1].reject(new ApiError(409, 'exists', 'Already exists'));});
    fireEvent.click(within(dock()).getByRole('button', {name: 'Clear finished transfers'}));
    expect(within(dock()).queryByText('done.txt')).not.toBeInTheDocument();
    expect(within(dock()).getByText('exists.txt')).toBeVisible();
    expect(within(dock()).getByText('running.txt')).toBeVisible();
    fireEvent.click(within(row('exists.txt')).getByRole('button', {name: 'Cancel upload exists.txt'}));
    await act(async () => {calls[2].resolve({} as never);});
    fireEvent.click(within(dock()).getByRole('button', {name: 'Clear finished transfers'}));
    expect(screen.queryByRole('region', {name: 'Transfers'})).not.toBeInTheDocument();
  });

  it('collapses, and reopens itself when an upload needs a decision', async () => {
    render(<TransferPanel/>);
    act(() => {queueUpload('a.txt');});
    fireEvent.click(within(dock()).getByRole('button', {name: /^Transfers/}));
    expect(within(dock()).queryByRole('list')).not.toBeInTheDocument();
    expect(within(dock()).getByRole('button', {name: /^Transfers/})).toHaveAttribute('aria-expanded', 'false');
    await act(async () => {calls[0].reject(new ApiError(409, 'exists', 'Already exists'));});
    expect(within(dock()).getByRole('list')).toBeVisible();
    expect(within(dock()).getByText('1 to decide')).toBeVisible();
  });

  it('stops and forgets every transfer when the session expires', () => {
    render(<TransferPanel/>);
    act(() => {queueUpload('a.txt'); queueUpload('b.txt'); queueUpload('c.txt');});
    act(() => {window.dispatchEvent(new Event('ssm-session-expired'));});
    expect(calls.every(call => call.signal.aborted)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(screen.queryByRole('region', {name: 'Transfers'})).not.toBeInTheDocument();
  });

  it('asks before a reload drops active transfers, except inside the embedded view', async () => {
    const unload = () => {const event = new Event('beforeunload', {cancelable: true}); window.dispatchEvent(event); return event.defaultPrevented;};
    expect(unload()).toBe(false);
    queueUpload('a.txt');
    expect(unload()).toBe(true);
    const meta = document.createElement('meta'); meta.name = 'hoploom-frame'; meta.content = 'frame'; document.head.append(meta);
    expect(unload()).toBe(false);
    meta.remove();
    await act(async () => {calls[0].resolve({} as never);});
    expect(unload()).toBe(false);
  });
});
