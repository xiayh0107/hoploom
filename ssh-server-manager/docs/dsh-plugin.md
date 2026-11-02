# DeepSeek Harness plugin

`dsh-hoploom` connects DeepSeek Harness to Hoploom through its official stdio
MCP bridge. Version **0.2.0** supports **dsh 0.2.1-rc.5** and adds automatic
backend preparation plus the full existing Hoploom UI inside a native sidebar panel.

## Install and use

You do not need to install Hoploom or Python first. In dsh's **Plugins → Add
plugin**, search for `dsh-hoploom`, or run:

```sh
dsh plugin --profile web add dsh-hoploom
dsh web
```

Use `tui` for terminal sessions. A downloaded release's absolute `.tgz` path also
works. For CLI changes to the `desktop` profile, fully quit the desktop app first;
use its Plugins page while it is open.

Click **Hoploom** in the sidebar. The plugin prepares its bundled Hoploom 0.11.0
and private Python runtime in the background. MCP tools can also reuse a compatible
existing install; the UI always uses the bundled version and the same state directories.
The first preparation needs internet access and may take a few minutes. The panel
shows progress and offers cancel/retry, even after a preparation failure.
The original Hoploom UI appears directly inside dsh, including hosts, ports, tags,
skills, credentials, audit and file management. Add hosts and credentials there,
then ask the agent to list hosts, resolve jump routes or find working directories.

Automatic preparation supports macOS, Windows and Linux (glibc), on x64 and
ARM64. It downloads checksum-pinned uv from Astral's official GitHub release,
uses uv-managed Python, and installs dependencies from PyPI. The Hoploom wheel
is included in the npm package. No Git checkout, system Python change or shell
profile edit is required. Verified completed environments are reused offline.
OpenSSH and a working OS vault are still needed for their respective SSH and
credential operations.

The plugin operates on the **dsh backend machine**, under its OS account. This
also applies when the browser is elsewhere. The UI stays inside dsh and its private
backend remains loopback-only. No external browser is opened or launch URL sent
to the page. Opening the panel starts the private UI, without connecting to SSH
hosts. Unloading stops only plugin-owned processes; standalone UI instances are
unaffected.

Each view has an independent browser session. Requests pass through authenticated
dsh owner routes and retain Hoploom's CSRF and credential-reveal checks. Passkeys
need a supported HTTPS domain or localhost origin. Native desktop and IP-address
views use the existing local master-password flow for secret reveal.

When upgrading from 0.1.x, finish active tasks and fully restart dsh after
installation. dsh 0.2.1-rc.5 caches the old package's absence of a client entry
until its backend process exits; a page refresh cannot load the new sidebar.

## Install with your agent

On the [Hoploom home page](../#deepseek), choose **Install with your Agent** in
the DeepSeek Harness section and copy the prompt in your preferred language.
It asks the agent to identify your dsh profile, use the desktop plugin manager
or the matching web/tui CLI command, and help verify the sidebar. If the agent
cannot operate the desktop interface, it can guide you through the steps.

For a desktop upgrade of an installed third-party plugin, use the Plugins page
to uninstall the old plugin and install the new version. Host data, vault entries
and the managed runtime are retained. Finish other tasks before restarting dsh
if you are upgrading from 0.1.x.

## Tools and configuration

The six default tools are `list_hosts`, `host_route`, `saved_paths`, `host_skills`,
`list_tunnels` and `runtime_capabilities`, all under `mcp__hoploom__`.
They query local metadata, without testing remote reachability.
`hoploom_setup` provides `action=status`, `prepare` and `cancel`, including when
the MCP backend is unavailable. Agents should report progress once, without
busy polling, and retry or cancel when asked.

In **Plugins → dsh-hoploom → Configuration**, edit the `dsh-hoploom` entry:

| Setting | Default | Meaning |
| --- | --- | --- |
| `command` | `hoploom` | Reuse a usable local installation or prepare the bundled backend |
| `commandArgs` | `[]` | Prefix arguments before `mcp serve`, without shell parsing |
| `autoInstall` | `true` | Prepare the private runtime when needed |
| `managedDir` | empty | Optional absolute private-runtime directory |
| `allowRemote` | `false` | Enable `test_host` |
| `allowExec` | `false` | Enable `run_command`, requiring `allowCommands` |
| `allowCommands` | `[]` | Backend glob allowlist, e.g. `["uptime", "df -h"]` |
| `dataDir` / `runtimeDir` | empty | Optional absolute Hoploom state directories |
| `toolCallTimeoutMs` | `660000` | MCP call deadline; backend command timeouts still apply |

With `autoInstall: false`, a missing default backend waits for an explicit
**Prepare Hoploom** action. The managed runtime is stored under
`$DSH_HOME/plugin-data/hoploom`, or `~/.dsh/plugin-data/hoploom` without DSH_HOME.
Host metadata and vault namespaces retain their normal Hoploom locations.
Removing the plugin preserves inventory, vault entries and the managed runtime.

Default lookup searches absolute PATH directories, `~/.local/bin`, macOS
Homebrew locations, and Windows `%LOCALAPPDATA%\hoploom\bin`. An explicit
custom command, absolute path or argument prefix is never silently replaced.
It must support `mcp serve`; old `serverctl 0.7.0` does not. Windows can use
`hoploom.cmd`, `hoploom.exe`, or an absolute Python executable with the launcher
in `commandArgs`. Relative executable paths are rejected.

No setting accepts secret values. An allowlist alone does not enable execution.
Backend globs match joined argv or its executable: `*` permits arbitrary
commands, and allowing an interpreter permits its programs. Enabled tools
still require task authorization. Agents select targets, resolve their host
skills, and must never bypass disabled tools with raw SSH or another shell.
Host-key trust remains a human decision.

## Recovery

For a failed first preparation, check network/proxy access and disk space, then
retry from the sidebar. Cancelling stops only the attempt's owned subprocesses;
an incomplete new environment is discarded after they stop. Completed older
environments remain available for other profiles. Concurrent installers share
a lock, and interrupted dead installers are recovered.

For an explicit custom-command failure, correct the command or restore the
default `hoploom` setting for automatic preparation. Upgrading from 0.1.x
`spawn hoploom ENOENT` no longer requires a separate backend install with the
default setting. Do not also register a generic MCP connection named `hoploom`.

## Architecture

The design follows [dsh-context's packaging](https://github.com/bowenliang123/dsh-context)
and the [official dsh APIs](https://github.com/deepseek-ai/deepseek-harness).

1. `package.json` declares the bundle patch, client factory, supported harness
   version, locale exports and explicit npm files.
2. The host entry validates configuration and registers the recovery tool and
   authenticated owner-only Fetch routes. Backend preparation runs asynchronously,
   so the client entry remains available when it fails.
3. A verified Python wheel is built from tracked public backend source only.
   uv archives are pinned to version and SHA256, extracted only for the expected
   executable, and kept in a private directory. Each new environment is installed
   separately; a verified successful install atomically updates its pointer.
4. `@deepseek-ai/dsh-mcp-client` owns schema discovery, namespaced tools,
   cancellation, reconnects and connection disposal. Python still owns inventory,
   vault access, strict host-key checks, command policy and audit actor `mcp`.
5. The browser factory uses dsh's official `sidebar.panellist` and `main` slots,
   with shared React and locale services. Its setup endpoint accepts a fixed set
   of actions; it cannot change remote-tool policy or return credentials.
6. An iframe loads a separate build of the existing React UI from the same
   frontend source. A private Python adapter hosts the existing FastAPI app,
   receives a random transport key through stdin and maps each view to an
   independent Hoploom session. The dsh owner route tunnels requests only to
   that owned loopback listener, preserving streaming and cancellation. The
   standalone UI's launch flow and framing restrictions remain unchanged.

A bounded `mcp serve --help` probe exits before opening the database, vault or
SSH client. Subprocesses use dsh's scrubbed environment. Installation output and
UI launch output are not relayed to browser or tool responses. The plugin does
not install a second protocol implementation or duplicate backend schemas.

## Verify and publish

From the repository root:

```sh
npm ci --prefix ssh-server-manager/frontend
npm ci --prefix dsh-hoploom
npm run build --prefix dsh-hoploom
HOPLOOM_BUILD_PYTHON=/absolute/path/to/python npm run build:backend --prefix dsh-hoploom
HOPLOOM_TEST_PYTHON=/absolute/path/to/python HOPLOOM_TEST_BOOTSTRAP=1 npm test --prefix dsh-hoploom
npm pack ./dsh-hoploom --pack-destination /absolute/path/to/output
```

The build Python needs `build` and Hoploom's dependencies. Tests isolate state
and exercise real MCP tools, permissions, cleanup, runtime downloads, concurrent
installation, cancellation, offline reuse, the built client panel and embedded
sessions/CSRF/streaming. Frontend changes also require the frontend build and
checks documented in AGENTS.md. CI runs
on macOS, Linux and Windows. Before release, install the tarball into a disposable
`DSH_HOME` and verify sidebar registration, embedded UI operations, setup status
and tool discovery.
Never use production inventory for release tests.

Bump `dsh-hoploom/package.json` and its lockfile, update its changelog and tarball
examples. The Python version does not change for an adapter-only release.
Commit reviewed source, tag `dsh-hoploom-vX.Y.Z`, and attach the verified `.tgz`
to its GitHub Release. The Python publish workflow ignores plugin tags.

Authenticate locally with `npm login` and publish the reviewed artifact:
`npm publish /absolute/path/dsh-hoploom-X.Y.Z.tgz --access public`.
Keep credentials and authentication codes out of repository files and chat.
Verify the registry version, integrity and an actual fresh installation.

The manual `publish-dsh` workflow can use npm Trusted Publishing after configuring
owner `xiayh0107`, repository `hoploom`, workflow `publish-dsh.yml`, environment
`npm`. Dispatch on the matching plugin tag. It checks the version and publishes
with OIDC provenance. Plugin and Python releases have independent lifecycles.
