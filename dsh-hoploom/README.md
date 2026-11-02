# dsh-hoploom

[简体中文](README.zh-CN.md)

[Hoploom](https://github.com/xiayh0107/hoploom) for **DeepSeek Harness**. Ask your
agent about saved SSH hosts, their jump routes, working directories and host-bound
skills. Explicitly enable connectivity checks and allowlisted remote commands
when you need them. Saved passwords and key passphrases stay in the OS vault.

## Install

Requires Node.js 22.19+ (22.x) or 24+, **dsh 0.2.1-rc.5**, and a local Hoploom
installation. The plugin and Hoploom run under the same OS account **on the
machine running the dsh backend**, including when you use dsh through a browser.
The npm package does not install Python, OpenSSH or Hoploom automatically.

1. Install Hoploom with its [source installer](https://github.com/xiayh0107/hoploom#one-line-agent-skill-deployment).
   If already installed, use that installation. Check `hoploom --version` and
   `hoploom mcp tools` in the terminal that starts dsh. Hoploom's renamed PyPI
   distribution is not a prerequisite; the source installer works independently.
2. In dsh's **Plugins → Add plugin**, search for `dsh-hoploom`, or run:

   ```sh
   dsh plugin --profile web add dsh-hoploom
   dsh web
   ```

   For the terminal profile, replace `web` with `tui`.
3. Ask: “List my saved SSH hosts” or “Which jump hosts and working directories
   belong to web1?” No API key is needed by this plugin.

You can also install the `.tgz` attached to a
[plugin release](https://github.com/xiayh0107/hoploom/releases):

```sh
dsh plugin --profile web add /absolute/path/dsh-hoploom-0.1.0.tgz
```

Update with `dsh plugin --profile web update dsh-hoploom@latest`. Remove with
`dsh plugin --profile web remove dsh-hoploom`. Removal stops the bridge and
unregisters its tools; your Hoploom inventory and vault entries remain yours.

## Tools

All names start with `mcp__hoploom__`. Tool schemas are discovered from your
installed Hoploom backend, rather than duplicated in this package.

| Tool | Default | Purpose |
| --- | --- | --- |
| `list_hosts` | On | Filter local host metadata by query or tag |
| `host_route` | On | Resolve saved ProxyJump chains |
| `saved_paths` | On | Resolve saved working directories for selected hosts |
| `host_skills` | On | Resolve registered skill metadata for selected hosts |
| `list_tunnels` | On | List saved forwarding profiles and local process status |
| `runtime_capabilities` | On | Inspect local capabilities and the active policy |
| `test_host` | Off | Contact one host for a connectivity check |
| `run_command` | Off | Run an explicitly allowlisted argv command |

Startup and metadata queries do not connect to your servers. The plugin adds
target-first instructions: choose the hosts, resolve their skills, then perform
the user's authorized task. A disabled remote tool is a policy boundary, not a
reason for the agent to fall back to raw SSH.

## Configure

Open **Plugins → dsh-hoploom → Configuration**, and edit the `dsh-hoploom` entry.
The form is generated from the plugin's exported Config schema.

| Setting | Default | Meaning |
| --- | --- | --- |
| `command` | `hoploom` | Executable name or absolute path |
| `commandArgs` | `[]` | Arguments before `mcp serve`, passed without shell parsing |
| `allowRemote` | `false` | Enable `test_host` |
| `allowExec` | `false` | Enable `run_command`; requires `allowCommands` |
| `allowCommands` | `[]` | Hoploom command glob allowlist |
| `dataDir` | empty | Optional absolute `SSM_DATA_DIR` override |
| `runtimeDir` | empty | Optional absolute `SSM_RUNTIME_DIR` override |
| `toolCallTimeoutMs` | `660000` | Transport deadline; command timeouts still apply |

For checks and a small command set, set `allowRemote` and `allowExec` to `true`,
and set `allowCommands` to `["uptime", "df -h"]`. An empty execution allowlist
fails activation. An allowlist alone does not enable execution. Avoid `*` unless
you intend unrestricted command execution. Hoploom's existing glob policy
matches either the joined argv or its executable; allowing `python`, `sh` or
another interpreter permits programs accepted by that interpreter.

Do not put passwords, tokens or passphrases in any plugin setting.

For a source installation missing from PATH, use its absolute `scripts/hoploom`
path. On Windows, a pip-installed `hoploom.exe` works directly. Alternatively,
set `command` to your installation's Python executable and `commandArgs` to
`["C:\\path\\to\\hoploom\\ssh-server-manager\\scripts\\hoploom.py"]`.
An existing pre-rename installation with the same MCP interface can set
`command` to `serverctl`; never install the unrelated PyPI package `serverctl`.

## Human controls

Add hosts and enter credentials in Hoploom's own local interface:

```sh
hoploom ui
```

Interactive shells use `hoploom connect ALIAS` in your terminal. Verify new
host keys there before asking an agent to connect. The plugin does not embed
the credential UI, relay launch tokens, expose a reveal tool, or bypass host-key
verification. Remote calls retain Hoploom's `mcp` audit actor and command policy.
Enabling a tool does not authorize every possible operation on every host.

If activation fails, confirm that dsh's backend can find the configured executable.
Desktop applications may have a different PATH from your terminal. Install or
select Hoploom, then re-enable the plugin. Do not register a second generic MCP
connection named `hoploom` alongside this plugin.

## Development and release

From this directory:

```sh
npm ci
npm run build
# Point at a Python environment containing the repository's Hoploom dependencies.
HOPLOOM_TEST_PYTHON=/absolute/path/to/python npm test
npm pack
```

The integration tests launch the real Python backend with temporary state and
exercise dsh's real tool registry. They never contact saved production hosts.
CI runs them on Linux, macOS and Windows. Without `HOPLOOM_TEST_PYTHON`, backend
integration tests are skipped and the configuration tests still run.

This package has its own version and `dsh-hoploom-vX.Y.Z` release tags, independent
of the Python package. See [the maintainer guide](https://github.com/xiayh0107/hoploom/blob/main/ssh-server-manager/docs/dsh-plugin.md)
for architecture, verification and npm publishing.

## References

The packaging approach follows [dsh-context](https://github.com/bowenliang123/dsh-context)
and the official [MCP bundle guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-preset/skills/cordis-plugin-development/references/mcp-bundle.md).
The official [dsh MCP client](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/mcp/mcp-client)
owns connection lifecycle and tool adaptation. This plugin uses no dsh-context source code.

MIT — see [LICENSE](LICENSE).
