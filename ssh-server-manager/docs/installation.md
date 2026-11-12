# Installation

Upgrading from SSH Server Manager / `serverctl`? Follow the
[Hoploom migration guide](migration.md) before installing the renamed package.

## Requirements

- Standard CPython **3.10+** (with the GIL)
- An **OpenSSH client** on `PATH` (`ssh -V` to check)
  - macOS / most Linux distros: preinstalled
  - Windows 10/11: `Settings → Apps → Optional features → OpenSSH Client`,
    or `winget install Microsoft.OpenSSH.Beta`
- An unlocked **OS credential vault** (see [platforms.md](platforms.md))

Published native wheels cover macOS, Windows, Linux glibc and Linux musl, each
on x64 and ARM64. A wheel installation needs neither Rust nor Node.js. PyPy and
free-threaded Python are outside this release's prebuilt support. Source builds
need the Rust toolchain pinned in `rust-toolchain.toml`; bootstrap checks it
before creating the environment. `HOPLOOM_EXECUTOR=python` is an explicit runtime
rollback after installation, not a way to build the package without Rust.

## Option A — pipx / uv (recommended)

Installs `hoploom` as an isolated global command:

```bash
pipx install hoploom
# or
uv tool install hoploom
# or, on macOS and Linux with Homebrew
brew install xiayh0107/tap/hoploom
```

The Homebrew formula installs the same PyPI release into its own virtualenv
([xiayh0107/homebrew-tap](https://github.com/xiayh0107/homebrew-tap)); see
[packaging.md](packaging.md) for how it is kept in step.

Then from anywhere:

```bash
hoploom doctor
hoploom ui
```

## Option B — run from a source checkout

```bash
git clone https://github.com/xiayh0107/hoploom.git
cd hoploom/ssh-server-manager
./scripts/bootstrap        # creates .venv and installs dependencies
./scripts/hoploom doctor
```

On Windows:

```bat
scripts\bootstrap.cmd
scripts\hoploom.cmd doctor
```

The launcher first calls the installed entry point in the project `.venv`, so a
Skill's source files cannot hide the installed native module. Development installs
remain editable. With no installed entry point it falls back to the source launcher.

## Option C — as an AI Agent Skill (one line)

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/xiayh0107/hoploom/main/install.sh | sh
```

Windows:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/xiayh0107/hoploom/main/install.ps1 | iex"
```

The one-line installer selects the latest published native version, installs
its wheel, fetches the matching `vX.Y.Z` Skill tag, and symlinks the skill into
every detected agent skills directory under the name `hoploom` (`~/.claude/skills`,
`~/.codex/skills`; extend with `SSM_SKILLS_DIRS`), creates `~/.local/bin` and
links both `hoploom` and the compatible `serverctl` command there on macOS/Linux.
Windows launchers live in `%LOCALAPPDATA%\hoploom\bin`. If that directory is
not on PATH, the installer prints it and the bundled absolute launcher path.
The installer finishes with
`hoploom doctor`. Re-running updates an existing install; `doctor`'s
`agent_skill` check warns when a linked skill copy is older than the CLI,
so agents never keep following stale instructions silently. See
[ai-agents.md](ai-agents.md).

`SSM_INSTALL_DIR`, `SSM_REPO_URL` and `SSM_SKILLS_DIRS` keep their existing
meanings. `SSM_VERSION=X.Y.Z` selects a published native release (0.12.0+).
Running `./install.sh` / `-File install.ps1` from a checkout, setting
`SSM_INSTALL_SOURCE=1`, or supplying a custom `SSM_REPO_URL` uses a source build
and requires Rust. An ordinary update stops if its managed checkout has local
edits; preserve those edits in a separate source checkout before updating.

## Verify the install

```bash
hoploom doctor --json
```

Every check should report `"ok": true`. The most common failure is the
vault check on Linux — see [platforms.md](platforms.md#linux).

## Uninstall

- `pipx uninstall hoploom` (or `uv tool uninstall`)
- Data lives in a platform data directory (`hoploom doctor` prints the
  database path); secrets live in the OS vault under the service name
  `ssh-server-manager`. Remove credentials with `hoploom credential remove`
  *before* uninstalling if you want the vault entries cleaned up.
- The rendered config at `~/.ssh/ssh-server-manager.conf` can be deleted;
  your original `~/.ssh/config` was never modified.

## Upgrades and database backups

For the first upgrade from `ssh-server-manager` to Hoploom 0.12.0, follow the
[migration guide](migration.md). A package rename requires replacing the old
distribution; `pipx upgrade ssh-server-manager` will not switch to Hoploom.

Once Hoploom is installed, stop the running Web UI before later upgrades:

```bash
hoploom web --stop
pipx upgrade hoploom
# or: uv tool upgrade hoploom
```

Back up the SQLite database in the platform data directory before upgrading.
With the Web UI and other hoploom processes stopped, copy `manager.db` to a
private backup directory. Keep the OS vault entries and referenced private-key
files in place; the database contains references and metadata, not their secrets.
Opening the database migrates supported older schemas, including schema 5
(0.8.0), development schema 6 and schema 7, to schema 8
transactionally. IDs, routes, tags, notes, directories, Skills and reveal settings
are preserved. A newer unsupported schema is rejected. To return to 0.8.0, stop
all processes and restore the pre-upgrade database backup before starting it.

The wheel and source distribution include the fingerprinted production Web
assets and their manifest. Running an installed package or a source checkout
does not require Node.js or an internet connection for the UI. Node 22 is needed
only when changing the frontend source; see [frontend development](https://github.com/xiayh0107/hoploom/blob/main/ssh-server-manager/frontend/README.md).
If the native vault is unavailable, credential operations report that state;
there is no fallback that saves secrets in a file.
