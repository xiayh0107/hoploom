# dsh-hoploom

[简体中文](README.zh-CN.md)

[Hoploom](https://github.com/xiayh0107/hoploom) for **DeepSeek Harness**. Manage
saved SSH hosts, jump routes, working directories and host-bound skills. dsh's
right sidebar embeds Hoploom's existing host manager beside your conversation.
Passwords and key passphrases stay in the OS vault.

## Install

Requires **dsh 0.2.1-rc.5 or a later 0.2.x release** (verified on 0.2.1-rc.5 and
0.2.2-rc.1) and Node.js 22.19+ (22.x) or 24+. Since 0.2.0,
**you do not need to install Hoploom or Python first**.

1. In **Plugins → Add plugin**, enter the package name `dsh-hoploom`, or run:

   ```sh
   dsh plugin --profile web add dsh-hoploom
   dsh web
   ```

   Use `tui` instead of `web` for terminal sessions.
2. Click **Hoploom** in the sidebar, or choose it on the right sidebar's start
   page. It opens in the right sidebar, so your conversation stays in view; use
   the panel's fullscreen control for more room. The plugin prepares its bundled
   backend and private Python runtime automatically. The first preparation needs internet
   access and can take a few minutes. You can cancel or retry from this panel.
   MCP tools can also reuse a compatible existing Hoploom installation.
3. The full Hoploom UI appears **inside dsh**, with hosts, ports, tags, skills,
   credentials, audit and file management. Add hosts there, then ask your agent:
   “List my saved SSH hosts” or “Which jump hosts and directories belong to web1?”

The plugin runs under the dsh backend's OS account. The embedded UI uses that
machine's inventory and vault, including when accessing dsh from elsewhere.
No API key is needed by this plugin. Remote SSH operations require the system
OpenSSH client and a usable OS credential vault where credentials are stored.

Automatic setup supports macOS, Windows and Linux (glibc or musl), on x64 and ARM64.
It downloads checksum-pinned [uv](https://github.com/astral-sh/uv) from Astral's
GitHub releases, managed Python, and dependencies from PyPI. Hoploom itself is
bundled in the npm package. System Python and shell profiles are not modified.
Completed environments are reused on later starts, including offline.
The bundle contains eight native wheels. Selection uses the managed Python's
actual compatibility tags, then checks SHA-256 and native version; its cache
identity includes the platform and selected wheel. No Rust compiler is needed.

A downloaded [release artifact](https://github.com/xiayh0107/hoploom/releases) also works:

```sh
dsh plugin --profile web add /absolute/path/dsh-hoploom-0.3.0.tgz
```

Update with `dsh plugin --profile web update dsh-hoploom@latest`. Remove with
`dsh plugin --profile web remove dsh-hoploom`. For CLI changes to the `desktop`
profile, fully quit the desktop app first; use its Plugins page while it is open.
When upgrading from 0.1.x, fully restart dsh after installation to load the new
sidebar UI. In dsh 0.2.1-rc.5, the old package's absence of a client entry is
cached for the lifetime of the backend process; refreshing the page is insufficient.
Finish active tasks before restarting.
Plugin 0.2.0 accepts only dsh 0.2.1-rc.5, so later dsh releases refuse to
install it and skip it at startup; update to 0.2.1 or later.

Removal unregisters tools and stops plugin-owned processes. Inventory, vault
entries and the managed runtime are retained.

## Tools and access

The six default tools use the `mcp__hoploom__` prefix. Their schemas come from
the Python backend through dsh's official MCP bridge.

| Tool | Default | Purpose |
| --- | --- | --- |
| `list_hosts` | On | Filter local host metadata by query or tag |
| `host_route` | On | Resolve saved ProxyJump chains |
| `saved_paths` | On | Resolve working directories for selected hosts |
| `host_skills` | On | Resolve registered skill metadata for selected hosts |
| `list_tunnels` | On | List saved forwarding profiles and local process status |
| `runtime_capabilities` | On | Inspect local capabilities and active policy |
| `test_host` | Off | Contact a selected SSH host |
| `run_command` | Off | Run an explicitly allowlisted argv command |

`hoploom_setup` is also available, including during setup failures. Its `action`
is `status`, `prepare` or `cancel`. In terminal sessions the agent can report
progress or retry on request. Setup does not busy-poll in the conversation.

Startup, opening the plugin panel and metadata queries do not contact SSH hosts.
The agent selects targets and resolves their host-bound skills before acting.
A disabled remote tool must never be bypassed with raw SSH or another shell tool.

## Configure

Open **Plugins → dsh-hoploom → Configuration** and edit the `dsh-hoploom` entry.

| Setting | Default | Meaning |
| --- | --- | --- |
| `command` | `hoploom` | Reuse a compatible installation, or prepare the bundled backend |
| `commandArgs` | `[]` | Arguments before `mcp serve`, without shell parsing |
| `autoInstall` | `true` | Prepare the private runtime when needed |
| `managedDir` | empty | Optional absolute directory for the private runtime |
| `allowRemote` | `false` | Enable `test_host` |
| `allowExec` | `false` | Enable `run_command`; requires `allowCommands` |
| `allowCommands` | `[]` | Backend command glob allowlist |
| `dataDir` | empty | Optional absolute `SSM_DATA_DIR` override |
| `runtimeDir` | empty | Optional absolute `SSM_RUNTIME_DIR` override |
| `toolCallTimeoutMs` | `660000` | MCP call deadline; backend timeouts still apply |

Set `autoInstall: false` to require an explicit **Prepare Hoploom** action when
there is no compatible default installation. The managed runtime defaults to
`$DSH_HOME/plugin-data/hoploom`, or `~/.dsh/plugin-data/hoploom` without DSH_HOME.
Host data and vault namespaces retain Hoploom's normal locations.

The default command searches absolute PATH directories, `~/.local/bin`, macOS
Homebrew locations and Windows `%LOCALAPPDATA%\hoploom\bin`. An explicit custom
command, absolute path or argument prefix is honored without replacement.
It must support `mcp serve`; old `serverctl 0.7.0` does not. On Windows,
`hoploom.cmd`, `hoploom.exe`, or an absolute Python executable plus a launcher in
`commandArgs` work. Relative command paths are rejected.

To enable checks and a small command set, use `allowRemote: true`,
`allowExec: true`, and `allowCommands: ["uptime", "df -h"]`. An allowlist alone
does not enable execution. Empty execution allowlists are rejected. Backend
globs match the joined argv or executable: `*` permits arbitrary commands, and
allowing an interpreter permits its programs. Enabled tools still require the
user's task authorization. Never put credentials in any plugin setting.

## Human controls and recovery

Opening the Hoploom panel starts a private loopback backend and embeds the
original Hoploom UI. No external browser is opened. This UI always uses the bundled
backend version; its private runtime is prepared on first use even if MCP uses
an existing CLI. Both share the configured inventory and vault. The plugin
stops only its own processes when unloaded.

UI requests use dsh's authenticated owner routes and separate browser sessions
with Hoploom's existing CSRF and credential-reveal checks. No launch token is
sent to the page. Passkeys require a supported HTTPS domain or localhost origin;
native desktop and IP-address views use the existing local master-password flow
for secret reveal. Credential entry stays in the embedded Hoploom UI. Standalone installations also support `hoploom ui` and terminal shells
with `hoploom connect ALIAS`. Host-key trust remains a human decision.

If first preparation fails, the panel remains usable: check the connection,
proxy or available disk space and choose **Try again**. A custom command failure
requires correcting that setting or restoring the default `hoploom` command.
Users upgrading from 0.1.x `spawn hoploom ENOENT` should update the plugin and
restore the default command to use automatic setup. Do not register another
generic MCP connection named `hoploom` alongside this plugin.

## Development and release

```sh
# From dsh-hoploom/: compile the same frontend source as the standalone UI.
npm ci --prefix ../ssh-server-manager/frontend
npm ci
npm run build
# This Python environment needs Hoploom's dependencies and the build package.
HOPLOOM_BUILD_PYTHON=/absolute/path/to/python npm run build:backend
HOPLOOM_TEST_PYTHON=/absolute/path/to/python HOPLOOM_TEST_BOOTSTRAP=1 npm test
# Local development tarball only; formal prepack requires all eight wheels.
npm pack --ignore-scripts
```

The wheel is built only from tracked public backend source, including its built
UI. The npm package also includes the private Python UI adapter and a build of
that same frontend source. Tests isolate state, use the real dsh tool registry,
cover embedded sessions, CSRF, streaming, cancellation and the client panel,
and verify a fresh managed Python installation plus offline reuse. CI runs on
Linux, macOS and Windows. Release wheel checks also execute both Linux libcs and
each supported architecture. Without `HOPLOOM_TEST_PYTHON`, existing-backend
integration tests skip; `HOPLOOM_TEST_BOOTSTRAP=1` opts into network setup tests.

For publication, download `native-dist` from this clean commit's workflow and
set `HOPLOOM_WHEEL_DIR=/absolute/path/to/native-dist` when running `build:backend`.
Then `npm pack` verifies the complete set and source commit. It cannot rebuild
or silently shrink that set to the developer's platform. The publish workflow
publishes the already verified tarball.

The adapter has an independent version and `dsh-hoploom-vX.Y.Z` tags. See the
[maintainer guide](https://github.com/xiayh0107/hoploom/blob/main/ssh-server-manager/docs/dsh-plugin.md)
for packaging and publication. The design follows
[dsh-context](https://github.com/bowenliang123/dsh-context) and the official
[dsh plugin APIs](https://github.com/deepseek-ai/deepseek-harness). It uses no
dsh-context source code. The Python backend owns schemas, SSH policy and vault access.

MIT — see [LICENSE](LICENSE).
