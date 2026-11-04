import {useSyncExternalStore} from 'react';
import {api, ApiError, download, segment, upload} from './api';
import type {components} from './generated';

/**
 * Browser file transfers, owned by the app rather than by a page: switching
 * pages or file tabs never stops one. Records live only in memory — never in
 * the URL, history or browser storage — and go away with the session.
 */
export type TransferState = 'queued' | 'running' | 'conflict' | 'done' | 'failed' | 'canceled';
export type Transfer = Readonly<{
  id: string; kind: 'upload' | 'download'; hostId: string; alias: string;
  /** Remote file path, its directory and basename. */
  path: string; directory: string; name: string;
  /** Bytes moved between the browser and Hoploom, against the best known size. */
  loaded: number; size: number;
  state: TransferState;
  /** Where a running transfer spends its time: in this browser or on the host. */
  phase?: 'browser' | 'host';
  /** Host-side bytes sftp has moved, when Hoploom can tell, and their expected total. */
  hostBytes?: number; hostTotal?: number;
  /** Hoploom is holding the transfer until another window's transfer frees a slot. */
  waiting?: boolean;
  overwrite: boolean;
  error?: string;
  existing?: Record<string, unknown>;
  /** A canceled upload whose bytes had already reached Hoploom: the host may still finish it. */
  uncertain?: boolean;
}>;

export const transferLimits = {active: 2, waiting: 8, finished: 50};
const PROGRESS_INTERVAL_MS = 100;
const HOST_POLL_MS = 500;
type HostProgress = components['schemas']['TransferProgress'];
// Names one attempt so its host-side progress can be asked for; never reused.
const attemptId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

export const filenameValid = (name: string) => !!name && name !== '.' && name !== '..' && !/[\\/\x00-\x1f\x7f]/.test(name);
export const joinRemote = (directory: string, name: string) => `${directory === '/' ? '' : directory.replace(/\/$/, '')}/${name}`;
const basename = (path: string) => path.replace(/\/+$/, '').split('/').at(-1) || path;
const parent = (path: string) => {const index = path.replace(/\/+$/, '').lastIndexOf('/'); return index > 0 ? path.slice(0, index) : '/';};
const hostApi = (hostId: string) => `/hosts/${segment(hostId)}`;
const isActive = (transfer: Transfer) => transfer.state === 'queued' || transfer.state === 'running';
const isFinished = (transfer: Transfer) => transfer.state === 'done' || transfer.state === 'failed' || transfer.state === 'canceled';

let transfers: readonly Transfer[] = [];
let sequence = 0, progressTimer: number | undefined;
const listeners = new Set<() => void>();
const uploadListeners = new Set<(hostId: string, directory: string) => void>();
// Live handles stay out of the snapshot: the File to send and the controller
// of the attempt in flight. Dropping them is what releases the browser's hold.
const handles = new Map<string, {file?: File; controller?: AbortController; poll?: number}>();

function emit() {
  window.clearTimeout(progressTimer); progressTimer = undefined;
  listeners.forEach(listener => listener());
}
function patch(id: string, change: Partial<Transfer>) {transfers = transfers.map(item => item.id === id ? {...item, ...change} : item);}
function update(id: string, change: Partial<Transfer>) {patch(id, change); emit();}
// Byte counts arrive many times a second; repaint at most every 100 ms.
function progress(id: string, change: Partial<Transfer>) {
  patch(id, change);
  progressTimer ??= window.setTimeout(emit, PROGRESS_INTERVAL_MS);
}
function find(id: string) {return transfers.find(item => item.id === id);}
function running() {return transfers.filter(item => item.state === 'running').length;}
function hasRoom() {return transfers.filter(isActive).length < transferLimits.active + transferLimits.waiting;}
const queueFull = () => new Error(`At most ${transferLimits.active + transferLimits.waiting} transfers can run or wait at once. Try again when one finishes.`);

function release(id: string, keepFile = false) {
  const handle = handles.get(id);
  if (!handle) return;
  window.clearInterval(handle.poll);
  handle.controller = handle.poll = undefined;
  if (!keepFile) handles.delete(id);
}
function settle(id: string, change: Partial<Transfer>, keepFile = false) {
  release(id, keepFile);
  patch(id, change);
  // Keep the newest finished records; older ones simply drop off.
  const finished = transfers.filter(isFinished);
  if (finished.length > transferLimits.finished) {
    const stale = new Set(finished.slice(0, finished.length - transferLimits.finished).map(item => item.id));
    stale.forEach(item => handles.delete(item));
    transfers = transfers.filter(item => !stale.has(item.id));
  }
  emit(); pump();
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function pump() {
  for (const item of transfers) {
    if (running() >= transferLimits.active) return;
    if (item.state === 'queued') start(item);
  }
}

function start(item: Transfer) {
  const controller = new AbortController(), handle = handles.get(item.id) || {}, attempt = attemptId();
  handle.controller = controller; handles.set(item.id, handle);
  const current = () => handles.get(item.id)?.controller === controller;
  update(item.id, {state: 'running', phase: item.kind === 'upload' ? 'browser' : 'host', loaded: 0, error: undefined, existing: undefined,
    hostBytes: undefined, hostTotal: undefined, waiting: undefined});
  // While the host does the work, ask Hoploom how far sftp has come. An upload
  // is asked while sending too: Hoploom reads no body until a server slot is
  // free, which the browser alone would show as a stalled percentage. One
  // question at a time; the answer is dropped if the phase moved on.
  const watched = () => {const phase = find(item.id)?.phase; return phase === 'host' || (phase === 'browser' && item.kind === 'upload');};
  let asking = false;
  handle.poll = window.setInterval(() => {
    if (asking || !current() || !watched()) return;
    asking = true;
    api<HostProgress>(`/transfers/${attempt}`, {signal: controller.signal}).then(report => {
      if (!report || !current() || !watched()) return;
      progress(item.id, {waiting: report.phase === 'waiting', hostBytes: report.bytes ?? undefined, hostTotal: report.total ?? undefined});
    }).catch(() => { /* Progress is optional; the transfer reports its own outcome. */ }).finally(() => {asking = false;});
  }, HOST_POLL_MS);
  const query = `?transfer_id=${attempt}`;
  if (item.kind === 'upload') {
    const form = new FormData();
    form.set('file', handle.file!); form.set('path', item.path); form.set('overwrite', String(item.overwrite));
    upload(`${hostApi(item.hostId)}/upload${query}`, form, {
      signal: controller.signal,
      onProgress: loaded => {if (current()) progress(item.id, {loaded});},
      onSent: () => {if (current()) update(item.id, {phase: 'host', loaded: item.size});},
    }).then(() => {
      if (!current()) return;
      settle(item.id, {state: 'done', phase: undefined, loaded: item.size});
      uploadListeners.forEach(listener => listener(item.hostId, item.directory));
    }, error => {
      if (!current()) return;
      if (error instanceof ApiError && error.status === 409 && error.code === 'exists') {
        settle(item.id, {state: 'conflict', phase: undefined, existing: error.existing}, true);
      } else settle(item.id, {state: 'failed', phase: undefined, error: message(error)}, true);
    });
    return;
  }
  download(`${hostApi(item.hostId)}/download${query}`, {path: item.path}, {
    signal: controller.signal,
    onProgress: (loaded, total) => {if (current()) (loaded ? progress : update)(item.id, {phase: 'browser', loaded, size: total ?? item.size, waiting: undefined});},
  }).then(result => {
    if (!current()) return;
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.filename;
    document.body.append(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    settle(item.id, {state: 'done', phase: undefined, loaded: result.blob.size, size: result.blob.size});
  }, error => {
    if (current()) settle(item.id, {state: 'failed', phase: undefined, error: message(error)});
  });
}

function add(item: Omit<Transfer, 'id' | 'loaded' | 'state'>, file?: File): Transfer {
  if (!hasRoom()) throw queueFull();
  const created: Transfer = {...item, id: `transfer-${++sequence}`, loaded: 0, state: 'queued'};
  handles.set(created.id, {file});
  transfers = [...transfers, created]; emit(); pump();
  return created;
}

/** Queue an upload of `file` to the remote `path` inside `directory`. */
export function enqueueUpload({hostId, alias, directory, path, file, overwrite = false}: {hostId: string; alias: string; directory: string; path: string; file: File; overwrite?: boolean}) {
  return add({kind: 'upload', hostId, alias, path, directory, name: basename(path), size: file.size, overwrite}, file);
}
/** Queue a download; `size` is the listed size, replaced by the server's when it sends one. */
export function enqueueDownload({hostId, alias, path, size}: {hostId: string; alias: string; path: string; size: number}) {
  return add({kind: 'download', hostId, alias, path, directory: parent(path), name: basename(path), size, overwrite: false});
}

export function cancelTransfer(id: string) {
  const item = find(id);
  if (!item || isFinished(item)) return;
  const controller = handles.get(id)?.controller;
  // Hoploom stops sftp when the request goes away, but an upload that had
  // already published cannot be taken back; say so instead of implying it.
  settle(id, {state: 'canceled', phase: undefined, uncertain: item.kind === 'upload' && item.state === 'running' && item.phase === 'host'});
  controller?.abort();
}
/** Run a failed transfer again. Only an explicit request ever replays one. */
export function retryTransfer(id: string) {
  const item = find(id);
  if (!item || item.state !== 'failed' || (item.kind === 'upload' && !handles.get(id)?.file)) return;
  requeue(id, {});
}
/** Settle an upload conflict: a new name in the same directory, or an explicit overwrite. */
export function resolveConflict(id: string, choice: {name: string} | {overwrite: true}) {
  const item = find(id);
  if (!item || item.state !== 'conflict') return;
  if ('name' in choice) {
    if (!filenameValid(choice.name)) return;
    const path = joinRemote(item.directory, choice.name);
    requeue(id, {path, name: choice.name, overwrite: false});
  } else requeue(id, {overwrite: true});
}
function requeue(id: string, change: Partial<Transfer>) {
  if (!hasRoom()) {update(id, {error: queueFull().message}); return;}
  update(id, {...change, state: 'queued', error: undefined, existing: undefined, uncertain: undefined});
  pump();
}
export function dismissTransfer(id: string) {
  const item = find(id);
  if (!item || isActive(item)) return;
  handles.delete(id);
  transfers = transfers.filter(value => value.id !== id); emit();
}
export function clearFinishedTransfers() {
  const finished = transfers.filter(isFinished);
  if (!finished.length) return;
  finished.forEach(item => handles.delete(item.id));
  transfers = transfers.filter(item => !isFinished(item)); emit();
}
/** Abort everything and forget every record, e.g. when the session ends. */
export function resetTransfers() {
  const controllers = [...handles.values()].map(handle => {window.clearInterval(handle.poll); return handle.controller;});
  handles.clear(); transfers = [];
  controllers.forEach(controller => controller?.abort());
  emit();
}

/** Called after an upload is published, with its host and directory. */
export function onUploaded(listener: (hostId: string, directory: string) => void) {
  uploadListeners.add(listener);
  return () => {uploadListeners.delete(listener);};
}
function subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};}
export function useTransfers() {return useSyncExternalStore(subscribe, () => transfers);}

// Re-renders only when the set of in-flight downloads changes, not on every byte.
const downloadKey = (hostId: string, path: string) => `${hostId}\u0000${path}`;
const activeDownloads = () => transfers.filter(item => item.kind === 'download' && isActive(item)).map(item => downloadKey(item.hostId, item.path)).join('\n');
export function useDownloading() {
  const key = useSyncExternalStore(subscribe, activeDownloads);
  return (hostId: string, path: string) => key.split('\n').includes(downloadKey(hostId, path));
}

if (typeof window !== 'undefined') {
  // Records name remote files; they must not outlive the session that read them.
  window.addEventListener('ssm-session-expired', resetTransfers);
  // A reload would drop transfers in flight. The embedded view is closed by its
  // host application, where a prompt could keep the view from closing at all.
  window.addEventListener('beforeunload', event => {
    if (!transfers.some(isActive) || document.querySelector('meta[name="hoploom-frame"]')) return;
    event.preventDefault(); event.returnValue = '';
  });
}
