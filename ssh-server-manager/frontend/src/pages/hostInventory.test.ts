import {expect, it} from 'vitest';
import {host} from '../test-fixtures';
import {hostRows, indexHosts} from './hostInventory';

it('indexes blocked routes and privacy-aware text without changing inventory order', () => {
  const values = [host({id: 'child', alias: 'child', proxy_jumps: ['jump'], hostname: 'hidden.invalid', tags: ['prod']}), host({id: 'jump', alias: 'jump', last_test_status: 'failed'})];
  const inventory = indexHosts(values, false);
  expect(inventory.blocked.get('child')).toBe('jump');
  expect(inventory.text.get('child')).toBe('child prod');
  expect(inventory.summary).toContain('1 blocked by a jump host');
  expect(hostRows(values, 'route').map(row => row.host.id)).toEqual(['jump', 'child']);
  expect(values[0].id).toBe('child');
});

it('groups 10,000 hosts and records group boundaries/counts in inventory order', () => {
  const values = Array.from({length: 10_000}, (_, index) => host({id: String(index), alias: `host-${index}`, tags: [index % 2 ? 'prod' : 'test']}));
  const rows = hostRows(values, 'tag');
  expect(rows).toHaveLength(10_000);
  expect(rows.filter(row => row.groupStart).map(row => [row.label, row.groupSize])).toEqual([['test', 5_000], ['prod', 5_000]]);
  expect(new Set(rows.map(row => row.host.id)).size).toBe(10_000);
});

it('traverses 10,000 nested routes without overflowing and includes cyclic hosts once', () => {
  const values = Array.from({length: 10_000}, (_, index) => host({id: String(index), alias: `host-${index}`, proxy_jumps: index ? [`host-${index - 1}`] : []}));
  expect(hostRows(values, 'route').map(row => row.host.id)).toEqual(values.map(value => value.id));
  values[0] = {...values[0], proxy_jumps: ['host-9999']};
  expect(new Set(hostRows(values, 'route').map(row => row.host.id)).size).toBe(10_000);
});
