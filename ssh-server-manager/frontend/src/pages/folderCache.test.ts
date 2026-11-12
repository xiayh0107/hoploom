import {expect, it} from 'vitest';
import {credential, host} from '../test-fixtures';
import type {DirectoryListing} from '../types';
import {connectionIdentities, FolderCache} from './folderCache';

function listing(path: string, count: number): DirectoryListing {
  return {alias: 'alpha', path, parent: '/', entries: Array.from({length: count}, (_, index) => ({name: `file-${index}`, path: `${path}/file-${index}`, type: 'file', size: 0, modified: '', permissions: '', owner: '', group: '', hidden: false})), total: count, truncated: false, unparsed: 0, latency_ms: 0, connection_checked_at: '', enriched: true};
}

it('shares home aliases and evicts least-recent canonical folders under both bounds', () => {
  const cache = new FolderCache(3, 6), home = listing('/home', 2);
  cache.write('a', undefined, home); cache.write('a', '/two', listing('/two', 2));
  expect(cache.read('a', undefined)?.listing).toBe(home);
  expect(cache.read('a', '/home')?.listing).toBe(home);
  cache.write('b', '/three', listing('/three', 3));
  expect(cache.size).toBe(2); expect(cache.entryCount).toBe(5);
  expect(cache.read('a', '/two')).toBeUndefined();
  cache.write('b', '/four', listing('/four', 0)); cache.write('b', '/five', listing('/five', 0));
  expect(cache.size).toBe(3); expect(cache.read('a', undefined)).toBeUndefined();
  expect(cache.entryCount).toBe(3);
});

it('invalidates only an uploaded directory and all folders for changed routes', () => {
  const cache = new FolderCache(), jump = host({id: 'jump', alias: 'jump'}), child = host({proxy_jumps: ['jump']});
  cache.reconcile(connectionIdentities([child, jump]));
  cache.write(child.id, undefined, listing('/home', 1)); cache.write(child.id, '/other', listing('/other', 1));
  cache.write(jump.id, '/home', listing('/home', 1));
  cache.invalidate(child.id, '/home');
  expect(cache.read(child.id, undefined)).toBeUndefined(); expect(cache.read(child.id, '/other')).toBeDefined();
  expect(cache.reconcile(connectionIdentities([child, {...jump, hostname: 'changed.invalid'}]))).toEqual(new Set([child.id, jump.id]));
  expect(cache.size).toBe(0); expect(cache.entryCount).toBe(0);
});

it('does not retain an oversized listing and clears every alias on session teardown', () => {
  const cache = new FolderCache(40, 2);
  cache.write('a', undefined, listing('/home', 3));
  expect(cache.size).toBe(0); expect(cache.read('a', undefined)).toBeUndefined();
  cache.write('a', undefined, listing('/home', 1)); cache.clear();
  expect(cache.entryCount).toBe(0); expect(cache.read('a', '/home')).toBeUndefined();
});

it('invalidates host and jump identities when the saved credential revision changes', () => {
  const key = credential(), jump = host({id: 'jump', alias: 'jump', credential_id: key.id}), child = host({proxy_jumps: ['jump']});
  const cache = new FolderCache();
  cache.reconcile(connectionIdentities([child, jump], [key]));
  cache.write(child.id, undefined, listing('/home', 1));
  expect(cache.reconcile(connectionIdentities([child, jump], [{...key, revision: key.revision + 1}]))).toEqual(new Set([child.id, jump.id]));
  expect(cache.read(child.id, undefined)).toBeUndefined();
});

it('invalidates all downstream hosts when a nested jump changes or disappears', () => {
  const first = host({id:'first',alias:'first'}), second = host({id:'second',alias:'second',proxy_jumps:['first']}), child = host({proxy_jumps:['second']}), unrelated = host({id:'other',alias:'other'});
  const cache = new FolderCache();
  cache.reconcile(connectionIdentities([first,second,child,unrelated]));
  cache.write(child.id,undefined,listing('/home',1)); cache.write(unrelated.id,undefined,listing('/home',1));
  expect(cache.reconcile(connectionIdentities([{...first,hostname:'changed.invalid'},second,child,unrelated]))).toEqual(new Set([first.id,second.id,child.id]));
  expect(cache.read(child.id,undefined)).toBeUndefined(); expect(cache.read(unrelated.id,undefined)).toBeDefined();
  expect(cache.reconcile(connectionIdentities([second,child,unrelated]))).toEqual(new Set([first.id,second.id,child.id]));
});

it('handles a 10,000-hop chain and a cycle without recursive route copies', () => {
  const hosts = Array.from({length:10_000},(_,index)=>host({id:`chain-${index}`,alias:`chain-${index}`,proxy_jumps:index?[`chain-${index-1}`]:[]}));
  const before = connectionIdentities(hosts);
  const after = connectionIdentities([{...hosts[0],port:2222},...hosts.slice(1)]);
  expect(after.size).toBe(10_000);
  for (const host of hosts) expect(after.get(host.id)).not.toBe(before.get(host.id));
  const cycle = [host({id:'cycle-a',alias:'cycle-a',proxy_jumps:['cycle-b']}),host({id:'cycle-b',alias:'cycle-b',proxy_jumps:['cycle-a']})];
  const oldCycle=connectionIdentities(cycle), newCycle=connectionIdentities([{...cycle[0],port:2222},cycle[1]]);
  expect(newCycle.get('cycle-b')).not.toBe(oldCycle.get('cycle-b'));
});
