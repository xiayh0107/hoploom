import type {Credential, DirectoryListing, Host} from '../types';

const keyOf = (hostId: string, path?: string) => `${hostId}\u0000${path || ''}`;
type Folder = {hostId: string; listing: DirectoryListing};

/** Canonical folders own entries; shorthand paths are aliases, never copies. */
export class FolderCache {
  private folders = new Map<string, Folder>();
  private aliases = new Map<string, string>();
  private identities = new Map<string, string>();
  private entries = 0;
  constructor(private maxFolders = 40, private maxEntries = 20_000) {}
  get size() {return this.folders.size;}
  get entryCount() {return this.entries;}
  read(hostId: string, path?: string) {
    const key = this.aliases.get(keyOf(hostId, path)) || keyOf(hostId, path), folder = this.folders.get(key);
    if (!folder) return undefined;
    this.folders.delete(key); this.folders.set(key, folder);
    return folder;
  }
  write(hostId: string, path: string | undefined, listing: DirectoryListing) {
    const key = keyOf(hostId, listing.path);
    // Keep existing shorthand aliases when refreshing the canonical folder.
    this.entries -= this.folders.get(key)?.listing.entries.length || 0;
    this.folders.delete(key); this.folders.set(key, {hostId, listing});
    this.entries += listing.entries.length;
    this.aliases.set(keyOf(hostId, path), key); this.aliases.set(key, key);
    while (this.aliases.size > this.maxFolders * 4) this.aliases.delete(this.aliases.keys().next().value!);
    while (this.folders.size > this.maxFolders || this.entries > this.maxEntries) this.remove(this.folders.keys().next().value!);
  }
  invalidate(hostId: string, directory?: string) {
    const key = directory === undefined ? undefined : this.aliases.get(keyOf(hostId, directory)) || keyOf(hostId, directory);
    for (const [candidate, folder] of this.folders) if (folder.hostId === hostId && (key === undefined || candidate === key)) this.remove(candidate);
  }
  reconcile(identities: Map<string, string>) {
    const changed = new Set<string>();
    for (const [id, previous] of this.identities) if (identities.get(id) !== previous) {changed.add(id); this.invalidate(id);}
    this.identities = identities;
    return changed;
  }
  clear() {this.folders.clear(); this.aliases.clear(); this.identities.clear(); this.entries = 0;}
  private remove(key: string) {
    const folder = this.folders.get(key);
    if (!folder) return;
    this.entries -= folder.listing.entries.length; this.folders.delete(key);
    for (const [alias, target] of this.aliases) if (target === key) this.aliases.delete(alias);
  }
}

// Track local revisions instead of serializing every host's complete route.
// A long jump chain stays linear and cycles never recurse. Both old and new
// reverse edges matter when a jump is removed or an external alias is imported.
class ConnectionIndex {
  private own = new Map<string, string>();
  private dependents = new Map<string, Set<string>>();
  private versions = new Map<string, string>();
  private revision = 0;
  clear() {this.own.clear(); this.dependents.clear(); this.versions.clear();}
  read(hosts: Host[], credentials: Credential[]) {
    const byAlias = new Map(hosts.map(host => [host.alias, host.id]));
    const revisions = new Map(credentials.map(credential => [credential.id, credential.revision]));
    const own = new Map<string, string>(), dependents = new Map<string, Set<string>>();
    for (const host of hosts) {
      own.set(host.id, JSON.stringify([host.alias, host.hostname, host.port, host.username,
        host.credential_id, revisions.get(host.credential_id || ''), host.proxy_jumps]));
      for (const alias of host.proxy_jumps) {
        const id = byAlias.get(alias);
        if (id) {if (!dependents.has(id)) dependents.set(id, new Set()); dependents.get(id)!.add(host.id);}
      }
    }
    const changed = new Set<string>();
    for (const [id, value] of own) if (this.own.get(id) !== value) changed.add(id);
    for (const id of this.own.keys()) if (!own.has(id)) changed.add(id);
    const pending = [...changed];
    for (let index = 0; index < pending.length; index++) {
      const id = pending[index];
      for (const edges of [this.dependents.get(id), dependents.get(id)]) for (const child of edges || []) {
        if (!changed.has(child)) {changed.add(child); pending.push(child);}
      }
    }
    const versions = new Map<string, string>();
    for (const id of own.keys()) versions.set(id, changed.has(id) ? `connection-${++this.revision}` : this.versions.get(id)!);
    this.own = own; this.dependents = dependents; this.versions = versions;
    return new Map(versions);
  }
}
const connections = new ConnectionIndex();
export function connectionIdentities(hosts: Host[], credentials: Credential[] = []) {return connections.read(hosts, credentials);}
export function clearConnectionIdentities() {connections.clear();}
