import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {api} from './api';
import {credential, host, runtime} from './test-fixtures';
import type {Credential, Host} from './types';
import App from './App';

vi.mock('./api', async original => ({...await original<typeof import('./api')>(), api: vi.fn()}));
// Keep the request-order regression focused on the app's shared snapshots.
vi.mock('./pages/HostsPage', () => ({
  default: ({hosts, credentials, onRefresh}: {hosts: Host[]; credentials: Credential[]; onRefresh: (ids?: string[]) => Promise<void>}) => <>
    <output data-testid="host-snapshot">{hosts.map(value => value.alias).join(',')}</output>
    <output data-testid="credential-snapshot">{credentials.map(value => value.label).join(',')}</output>
    <button onClick={() => void onRefresh()}>Refresh shared snapshots</button>
    <button onClick={() => void onRefresh(['host-a'])}>Refresh one host</button>
  </>,
}));

const mocked = vi.mocked(api);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => {resolve = complete;});
  return {promise, resolve};
}
beforeEach(() => {
  mocked.mockReset();
  history.replaceState({}, '', '#/hosts');
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn()}));
});

it('refreshes only affected hosts and coalesces identical requests in the same turn', async () => {
  const original = host({alias: 'initial'});
  mocked.mockImplementation(async path => path === '/runtime' ? runtime : path === '/hosts' ? [original] : path === '/credentials' ? [credential()] : path === '/hosts/host-a' ? {...original, alias: 'updated'} : undefined);
  render(<App/>);
  await screen.findByRole('button', {name: 'Refresh one host'});
  mocked.mockClear();
  fireEvent.click(screen.getByRole('button', {name: 'Refresh one host'}));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh one host'}));
  await waitFor(() => expect(screen.getByTestId('host-snapshot')).toHaveTextContent('updated'));
  expect(mocked).toHaveBeenCalledExactlyOnceWith('/hosts/host-a');
  expect(screen.getByTestId('credential-snapshot')).toHaveTextContent('Deploy password');
});
afterEach(() => vi.unstubAllGlobals());

it('keeps the latest hosts and credentials when an earlier refresh finishes later', async () => {
  const olderHosts = deferred<Host[]>(), olderCredentials = deferred<Credential[]>();
  let hostReads = 0, credentialReads = 0;
  mocked.mockImplementation(async path => {
    if (path === '/runtime') return runtime;
    if (path === '/hosts') {
      const read = ++hostReads;
      return read === 1 ? [host({alias: 'initial-host'})] : read === 2 ? olderHosts.promise : [host({alias: 'latest-host'})];
    }
    if (path === '/credentials') {
      const read = ++credentialReads;
      return read === 1 ? [credential({label: 'Initial credential'})] : read === 2 ? olderCredentials.promise : [credential({label: 'Latest credential'})];
    }
    throw new Error(`Unexpected request: ${path}`);
  });

  render(<App/>);
  await screen.findByRole('button', {name: 'Refresh shared snapshots'});
  fireEvent.click(screen.getByRole('button', {name: 'Refresh shared snapshots'}));
  await waitFor(() => expect(hostReads).toBe(2));
  fireEvent.click(screen.getByRole('button', {name: 'Refresh shared snapshots'}));
  await waitFor(() => {
    expect(screen.getByTestId('host-snapshot')).toHaveTextContent('latest-host');
    expect(screen.getByTestId('credential-snapshot')).toHaveTextContent('Latest credential');
  });
  await act(async () => {
    olderHosts.resolve([host({alias: 'older-host'})]);
    olderCredentials.resolve([credential({label: 'Older credential'})]);
  });
  expect(screen.getByTestId('host-snapshot')).toHaveTextContent('latest-host');
  expect(screen.getByTestId('credential-snapshot')).toHaveTextContent('Latest credential');
});
