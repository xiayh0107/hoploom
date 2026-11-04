import {useEffect, useRef, useState, type CSSProperties} from 'react';
import {cancelTransfer, clearFinishedTransfers, dismissTransfer, filenameValid, joinRemote, resolveConflict, retryTransfer, useTransfers, type Transfer} from './transfers';
import {Button, Icon, formatBytes, relativeDate} from './ui';

const verb = (item: Transfer) => item.kind === 'upload' ? 'upload' : 'download';
const folderHref = (item: Transfer) => `#/files/${encodeURIComponent(item.hostId)}?path=${encodeURIComponent(item.directory)}`;
const percent = (item: Transfer) => item.size > 0 ? Math.min(100, Math.floor(item.loaded / item.size * 100)) : 100;
// A percentage only once bytes were actually counted; some transports and
// platforms never report them.
const measured = (item: Transfer) => item.state === 'running' && item.phase === 'browser' && item.loaded > 0;
function hostPercent(item: Transfer) {
  if (item.state !== 'running' || item.phase !== 'host' || item.waiting || item.hostBytes === undefined) return undefined;
  const total = item.hostTotal ?? item.size;
  return total > 0 ? Math.min(100, Math.floor(item.hostBytes / total * 100)) : undefined;
}

function status(item: Transfer) {
  switch (item.state) {
    case 'queued': return 'Queued';
    case 'running':
      if (item.waiting) return 'Waiting for a free slot';
      if (item.phase === 'host') {
        const share = hostPercent(item), action = item.kind === 'upload' ? 'Writing on host' : 'Reading on host';
        // sftp has handed every byte over; the host is still acknowledging or publishing.
        if (share === 100 && item.kind === 'upload') return 'Finishing on host';
        return share === undefined ? action : `${action} · ${share}%`;
      }
      if (!measured(item)) return item.kind === 'upload' ? 'Sending' : 'Receiving';
      return `${percent(item)}%`;
    case 'conflict': return 'Already exists';
    case 'done': return `${item.kind === 'upload' ? 'Uploaded' : 'Saved'} · ${formatBytes(item.size)}`;
    case 'failed': return 'Failed';
    case 'canceled': return 'Canceled';
  }
}

function Bar({label, share}: {label: string; share?: number}) {
  return share === undefined
    ? <div className="transfer-bar indeterminate" role="progressbar" aria-label={label}><span/></div>
    : <div className="transfer-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={share}><span style={{'--progress': `${share}%`} as CSSProperties}/></div>;
}

function Row({item}: {item: Transfer}) {
  const [rename, setRename] = useState(item.name);
  useEffect(() => setRename(item.name), [item.name, item.state]);
  const active = item.state === 'queued' || item.state === 'running';
  const label = `${verb(item)} ${item.name}`;
  const renamed = joinRemote(item.directory, rename);
  return <li className={`transfer-row ${item.state}`}>
    <span className={`transfer-icon ${item.kind}`}><Icon name={item.kind} size={14}/></span>
    <div className="transfer-main">
      <div className="transfer-line">
        <strong className="transfer-name" title={item.path}>{item.name}</strong>
        <span className="transfer-status">{status(item)}</span>
      </div>
      <a className="transfer-where mono" href={folderHref(item)} title={`${item.alias}:${item.directory}`}>{item.alias}:{item.directory}</a>
      {item.state === 'running' && <Bar label={label} share={item.waiting ? undefined : measured(item) ? percent(item) : hostPercent(item) === 100 && item.kind === 'upload' ? undefined : hostPercent(item)}/>}
      {item.uncertain && <p className="transfer-note">The host may have finished before the cancel arrived.</p>}
      {item.error && <p className="transfer-error" role="alert">{item.error}</p>}
      {item.state === 'conflict' && <form className="transfer-conflict" onSubmit={event => {event.preventDefault(); resolveConflict(item.id, {name: rename});}}>
        {item.existing && <p className="transfer-existing">{[
          String(item.existing.type || 'file'),
          typeof item.existing.size === 'number' ? formatBytes(item.existing.size) : '',
          typeof item.existing.modified_at === 'string' && Number.isFinite(Date.parse(item.existing.modified_at)) ? relativeDate(item.existing.modified_at) : String(item.existing.modified || ''),
        ].filter(Boolean).join(' · ')}</p>}
        <input aria-label="New filename" value={rename} onChange={event => setRename(event.target.value)}/>
        <div className="transfer-conflict-actions">
          <Button type="submit" disabled={!filenameValid(rename) || renamed === item.path}>Upload with new name</Button>
          <Button variant="danger" onClick={() => resolveConflict(item.id, {overwrite: true})}>Overwrite this file</Button>
        </div>
      </form>}
    </div>
    <div className="transfer-actions">
      {item.state === 'failed' && <Button variant="ghost" aria-label={`Retry ${label}`} title="Retry" onClick={() => retryTransfer(item.id)}><Icon name="refresh" size={14}/></Button>}
      {active || item.state === 'conflict'
        ? <Button variant="ghost" aria-label={`Cancel ${label}`} title="Cancel" onClick={() => cancelTransfer(item.id)}><Icon name="close" size={14}/></Button>
        : <Button variant="ghost" aria-label={`Dismiss ${label}`} title="Dismiss" onClick={() => dismissTransfer(item.id)}><Icon name="close" size={14}/></Button>}
    </div>
  </li>;
}

/** App-wide transfer dock: present while any transfer is listed, never in the URL. */
export default function TransferPanel() {
  const items = useTransfers();
  const [open, setOpen] = useState(true);
  const running = items.filter(item => item.state === 'running').length, queued = items.filter(item => item.state === 'queued').length;
  const conflicts = items.filter(item => item.state === 'conflict').length, failed = items.filter(item => item.state === 'failed').length;
  const done = items.filter(item => item.state === 'done').length;
  const finished = items.length - running - queued - conflicts;
  // A new transfer or a decision brings the list back into view.
  const seen = useRef(items.length);
  useEffect(() => {if (items.length > seen.current || conflicts) setOpen(true); seen.current = items.length;}, [items.length, conflicts]);
  if (!items.length) return null;
  const summary = [
    conflicts && `${conflicts} to decide`, running && `${running} running`, queued && `${queued} queued`,
    failed && `${failed} failed`, !running && !queued && done && `${done} done`,
  ].filter(Boolean).join(' · ');
  return <section className={`transfer-dock${open ? '' : ' collapsed'}`} aria-label="Transfers">
    <header className="transfer-head">
      <button className="transfer-toggle" aria-expanded={open} aria-controls="transfer-list" onClick={() => setOpen(value => !value)}>
        Transfers<span className="transfer-summary" aria-live="polite">{summary}</span>
        <span className={`transfer-chevron${open ? ' open' : ''}`}><Icon name="arrow" size={12}/></span>
      </button>
      {finished > 0 && <Button variant="ghost" className="transfer-clear" aria-label="Clear finished transfers" onClick={clearFinishedTransfers}>Clear</Button>}
    </header>
    {open && <ul className="transfer-list" id="transfer-list">{[...items].reverse().map(item => <Row key={item.id} item={item}/>)}</ul>}
  </section>;
}
