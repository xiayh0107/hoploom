import type {Host} from '../types';

export type HostRow = {host: Host; label: string; child: boolean; parent: boolean; last: boolean; groupStart: boolean; groupSize: number};

export function visibleHostText(host: Host, details: boolean) {
  return [host.alias, ...host.tags, ...(details ? [host.hostname, host.username, host.notes, host.credential_label || ''] : [])].join(' ').toLocaleLowerCase();
}

/** Index local metadata once per inventory/privacy revision, never per row. */
export function indexHosts(hosts: Host[], details: boolean) {
  const byId = new Map<string, Host>(), byAlias = new Map<string, Host>(), text = new Map<string, string>();
  const tags = new Map<string, number>(), blocked = new Map<string, string>();
  let untagged = 0, reachable = 0, failing = 0, unchecked = 0;
  for (const host of hosts) {
    byId.set(host.id, host); byAlias.set(host.alias, host); text.set(host.id, visibleHostText(host, details));
    if (!host.tags.length) untagged++;
    for (const tag of host.tags) tags.set(tag, (tags.get(tag) || 0) + 1);
  }
  for (const host of hosts) {
    const down = host.proxy_jumps.find(alias => byAlias.get(alias)?.last_test_status === 'failed');
    if (down) {blocked.set(host.id, down); continue;}
    if (host.last_test_status === 'ok') reachable++;
    if (host.last_test_status === 'failed') failing++;
    if (!host.last_test_at) unchecked++;
  }
  const scopes = [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({name, count}));
  const summary = `${hosts.length} hosts · ${reachable} reachable · ${failing} failing${blocked.size ? ` · ${blocked.size} blocked by a jump host` : ''} · ${unchecked} never checked`;
  return {byId, byAlias, text, blocked, scopes, untagged, summary};
}

export function hostRows(hosts: Host[], group: string): HostRow[] {
  if (group === 'route') return routeRows(hosts);
  const groups = new Map<string, Host[]>();
  for (const host of hosts) {
    const label = group === 'tag' ? host.tags[0] || 'Untagged' : '';
    const members = groups.get(label);
    if (members) members.push(host); else groups.set(label, [host]);
  }
  const rows: HostRow[] = [];
  for (const [label, members] of groups) members.forEach((host, index) => {
    rows.push({host, label, child: false, parent: false, last: false, groupStart: !!label && index === 0, groupSize: members.length});
  });
  return rows;
}

/** Iterative traversal also bounds the stack for very deep routes or cycles. */
function routeRows(hosts: Host[]): HostRow[] {
  const aliases = new Set(hosts.map(host => host.alias)), children = new Map<string, Host[]>();
  for (const host of hosts) {
    let parent = '';
    for (let index = host.proxy_jumps.length - 1; index >= 0; index--) {
      const alias = host.proxy_jumps[index];
      if (alias !== host.alias && aliases.has(alias)) {parent = alias; break;}
    }
    const members = children.get(parent);
    if (members) members.push(host); else children.set(parent, [host]);
  }
  const rows: HostRow[] = [], visited = new Set<string>();
  const append = (root: Host) => {
    const stack = [{host: root, child: false, last: true}];
    while (stack.length) {
      const current = stack.pop()!, {host, child, last} = current;
      if (visited.has(host.id)) continue;
      visited.add(host.id);
      const descendants = children.get(host.alias) || [];
      rows.push({host, label: '', child, parent: descendants.length > 0, last: last && !descendants.length, groupStart: false, groupSize: 0});
      for (let index = descendants.length - 1; index >= 0; index--) stack.push({host: descendants[index], child: true, last: last && index === descendants.length - 1});
    }
  };
  for (const host of children.get('') || []) append(host);
  for (const host of hosts) if (!visited.has(host.id)) append(host);
  return rows;
}
