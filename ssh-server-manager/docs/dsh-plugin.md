# DeepSeek Harness plugin

`dsh-hoploom` connects DeepSeek Harness to the local Hoploom installation through
stdio MCP. The plugin package lives in [`dsh-hoploom/`](https://github.com/xiayh0107/hoploom/tree/main/dsh-hoploom)
and has its own version, starting at 0.1.0. It supports dsh 0.2.1-rc.5.

## Install and use

Install Hoploom using the [source installer](installation.md), or select an
existing installation. In the terminal that starts the dsh backend, verify
`hoploom --version` and `hoploom mcp tools`. The npm plugin does not install the
Python backend. A browser on another machine still operates the backend machine's
inventory and OS account.

```sh
dsh plugin --profile web add dsh-hoploom
dsh web
```

The dsh Plugins page can also install the package by name. For a downloaded
release artifact, substitute its absolute `.tgz` path for `dsh-hoploom`.
Use the `tui` profile instead of `web` for terminal sessions.

Ask the agent to list saved hosts, show a host's route or retrieve its saved
working directories. These actions query local metadata. They do not check
reachability or open a network connection to a host.

The plugin defaults to six tools: `list_hosts`, `host_route`, `saved_paths`,
`host_skills`, `list_tunnels` and `runtime_capabilities`, under the
`mcp__hoploom__` prefix. In **Plugins → dsh-hoploom → Configuration**, enable
`allowRemote` for `test_host`; enable `allowExec` and specify `allowCommands`
for `run_command`. For example, `["uptime", "df -h"]` permits those commands.
These are the backend's existing glob rules, not a shell sandbox: allowing
an interpreter permits its programs, and `*` permits arbitrary commands.

The `command` setting selects the Hoploom executable. `commandArgs` supplies
separate arguments before `mcp serve` when a Python launcher is needed.
On Windows, use `hoploom.exe`, or a Python executable plus the absolute
`scripts/hoploom.py` argument. Existing `serverctl mcp serve` installations
can select `serverctl` explicitly. Optional absolute `dataDir` and `runtimeDir`
settings isolate state. No setting should contain a credential value.

The plugin's instructions require target selection before skill resolution,
restrict host-bound guidance to `applies_to`, and forbid using shell tools to
bypass disabled remote tools. Inventory readiness is separate from verified
reachability. Host changes, credential entry, file transfers and interactive
shells use the human's local Hoploom UI or terminal. The plugin neither embeds
the secret-entry UI nor exposes a credential reveal API.

## How the plugin is built

The design follows [dsh-context's bundle packaging](https://github.com/bowenliang123/dsh-context)
and the [official plugin guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-preset/skills/cordis-plugin-development/references/mcp-bundle.md):

1. `package.json` declares `dsh.bundle.patch`, its supported harness version,
   explicit npm files, locale exports and peer dependencies.
2. `cordis.patch.yml` inserts one `dsh-hoploom` entry into the selected profile.
3. The host entry exports `name`, `inject`, `Config` and async `apply`.
   Schemastery supplies the editable configuration form.
4. The entry validates settings and calls the official
   `@deepseek-ai/dsh-mcp-client` on its own lifecycle scope. The client discovers
   backend schemas, registers namespaced tools, forwards cancellation, reconnects
   and disposes connections. There is no second protocol implementation.
5. An optional `systemPrompt` section supplies Hoploom's agent interaction rules.
   Loading the plugin does not require a browser-only service.

The Python backend still owns inventory, vault access, strict SSH host-key checks,
remote command policy and audit records. Tools obtain the same policy as
`hoploom mcp serve`; acting calls retain audit actor `mcp`. The plugin does not
install software, request vault values or automatically test hosts.

## Verify and publish

From the repository root:

```sh
npm ci --prefix dsh-hoploom
npm run build --prefix dsh-hoploom
HOPLOOM_TEST_PYTHON=/absolute/path/to/python npm test --prefix dsh-hoploom
npm pack ./dsh-hoploom --pack-destination /absolute/path/to/output
```

The Python environment must contain Hoploom's dependencies. Tests initialize
temporary data/runtime directories and call the real backend through the real
dsh registry. They verify default tool scope, host metadata, target-specific
context, allowlist refusal, pre-dispatch cancellation and unload cleanup.
The workflow runs on Linux, macOS and Windows. Before publishing, install the
tarball into a disposable `DSH_HOME` profile and verify bundle loading; never
use production inventory for release tests.

Bump `dsh-hoploom/package.json` and its lockfile together; update its changelog
and versioned tarball examples. Do not bump the Python package just to release
this independent adapter. Commit the reviewed source, create the matching
`dsh-hoploom-vX.Y.Z` tag, and attach the verified `.tgz` to its GitHub Release.
The Python publish workflow ignores these plugin tags.

For the first npm publication, authenticate locally with `npm login` and publish
the reviewed tarball with `npm publish /absolute/path/dsh-hoploom-X.Y.Z.tgz --access public`.
Never put an npm token in repository files, tool arguments or chat. Verify the
registry version and tarball integrity after publishing.

Later releases can use the manual `publish-dsh` GitHub workflow after configuring
the npm package's Trusted Publisher for owner `xiayh0107`, repository `hoploom`,
workflow `publish-dsh.yml`, environment `npm`. Run that workflow on the matching
plugin tag. It checks the version and publishes with OIDC provenance; no stored
npm token is required. `dsh-hoploom-v*` tags and `v*` Python tags have separate
release lifecycles.
