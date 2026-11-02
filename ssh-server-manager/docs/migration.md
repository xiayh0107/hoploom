# Upgrade to Hoploom

Hoploom 0.11.0 adopts one public name for the product, package, command,
repository and Agent Skill. The former product names were SSH Server Manager
and servers-connect. `serverctl` remains a compatible command.

## Names and compatibility

| Surface | Canonical name | Compatibility |
| --- | --- | --- |
| Product and Web UI | Hoploom | Previous names appear in historical releases |
| GitHub repository | `xiayh0107/hoploom` | Retain GitHub's old repository redirects |
| PyPI distribution | `hoploom` | Upgrade explicitly from `ssh-server-manager` |
| Homebrew formula | `xiayh0107/tap/hoploom` | Tap rename mapping preserves upgrades |
| CLI | `hoploom` | `serverctl` uses the same implementation |
| Agent Skill | `hoploom` | Installer migrates links it owns |
| MCP server identity | `hoploom` | Tool names, arguments and policy flags stay stable |

The existing `SSM_*` environment variables, OS-vault service
`ssh-server-manager`, data/cache/runtime paths, managed SSH config path,
`ssh-server-manager.export` format and `ssh_server_manager` Python package
remain stable. Credentials, host IDs, paths, host-specific Skill bindings,
disclosure authentication and SSH trust stores stay in place. The
`ssh-server-manager/` source subtree is retained so source installations and
launchers keep their existing target paths. It is not the public product name.

Both commands produce the same machine-readable results, without a rename
warning on stdout or stderr. Help and `--version` reflect the command used.
`doctor` includes both `version.hoploom` and the retained `version.serverctl`.

## Before upgrading

Use the same account and package manager that installed the existing copy.
Stop its Web UI with `serverctl web --stop`, close managed tunnels/mounts and
finish running sessions before replacing executable files. Keep a private
backup of the metadata database; do not export secrets or delete OS-vault
entries. See [installation](installation.md) for database backup instructions.

The package-manager commands below require Hoploom 0.11.0 to have been
published. Before that, use the reviewed source checkout or its local wheel.

## pipx and uv

The new package provides both command names, so remove the old tool environment
before installing it. Removing the tool does not remove the external database
or OS-vault entries.

```sh
pipx uninstall ssh-server-manager
pipx install hoploom
hoploom doctor
hoploom server list --json
```

For uv use `uv tool uninstall ssh-server-manager`, followed by
`uv tool install hoploom`. Do not use force-overwrite flags to keep both
independent tool installations competing for `serverctl`.

## Existing Python virtual environment

The distributions own the same Python module paths. Uninstall the old
distribution before installing the new one; installing both and uninstalling
the old one afterwards can delete files belonging to Hoploom.

```sh
python -m pip uninstall ssh-server-manager
python -m pip install hoploom
hoploom doctor
```

The source bootstrap performs this code-only migration inside the checkout's
own `.venv` before installing Hoploom. It never removes user data or credentials.

## Source installer and Agent Skills

Re-run `install.sh` or `install.ps1`. Existing default `servers-connect`
checkouts are reused; new checkouts use `hoploom`. `SSM_INSTALL_DIR` still
selects a custom location. Custom installations should pass the same override
or run the installer from their checkout.

The installer creates `hoploom` links in detected agent Skill directories.
It removes an old `ssh-server-manager` link only when it points to that same
source tree and the new link is ready. Unrelated directories and links are
left alone and reported. Restart the agent session to refresh its Skill
catalog. The new base Skill and its old name are both excluded from host-bound
Skill discovery and registration.

Both command names are installed in `~/.local/bin` on macOS/Linux, or
`%LOCALAPPDATA%\hoploom\bin` on Windows. If PATH does not contain that directory,
use the printed absolute launcher path immediately and add the directory to
your shell's PATH. Do not install the unrelated PyPI package `serverctl`.

## Homebrew and MCP

After the tap publishes its rename mapping, run `brew update` and
`brew upgrade`. Homebrew migrates `ssh-server-manager` to `hoploom`; the
formula continues to provide `serverctl` for existing scripts.

Existing MCP configurations that execute `serverctl mcp serve` remain valid.
New configurations should use `hoploom mcp serve` and the label `hoploom`.
Restart the client after editing its configuration; do not register a second
copy alongside the existing entry. Tool names and authorization flags are
unchanged.

## Maintainer cutover

1. Validate the source, both CLI names, UI build, wheel/sdist installations and
   a populated upgrade from the published old distribution. Keep this change
   under Unreleased until the release is ready.
2. Configure PyPI's pending Trusted Publisher for project `hoploom`, owner
   `xiayh0107`, repository `hoploom`, workflow `publish.yml`, environment `pypi`.
   Retain the old PyPI project and its release history; add a migration notice.
   Do not publish a dependency-only bridge over the old shared module files.
3. Rename the GitHub repository and update its homepage and local remotes.
   Never recreate a repository named `servers-connect`, which would displace
   the old repository redirects. Verify both legacy raw installer URLs.
4. Publish the new GitHub Pages site and verify its documentation links.
   GitHub does not redirect the old project Pages URL. Provide an explicit
   redirect through an account Pages site or a controlled custom domain before
   announcing the cutover; do not claim the old website redirects automatically.
5. Publish the reviewed release, wait for PyPI, then generate the Homebrew
   formula from PyPI's actual sdist with `scripts/prepare_packaging`.
   In the same tap PR remove the old formula and merge the generated
   `formula_renames.json` mapping without replacing unrelated mappings.
6. Verify fresh installs and old-name upgrades before announcing the new name.
   Domain registration is separate; the project does not assume ownership of
   `hoploom.com` or `hoploom.dev`.
