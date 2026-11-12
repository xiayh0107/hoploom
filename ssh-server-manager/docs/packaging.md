# Packaging outside PyPI

`pipx install hoploom` and `pip install hoploom` are the
supported installs; the wheel needs no Node.js, no build step and no network at
runtime. This page covers the two distribution channels that need extra work, and
is explicit about which of them this project can actually ship.

## Native Python distributions

The mixed Python/Rust package uses maturin 1.16.0 and PyO3's `cp310-abi3` ABI.
`ssh_server_manager._native` ships with the Python package, entry points and
built UI. `Cargo.toml`, `Cargo.lock`, Python metadata and the website version
must agree. The pinned source toolchain is in `rust-toolchain.toml`.

`native-wheels.yml` builds macOS x64/ARM64, Windows x64/ARM64, manylinux2014
x64/ARM64 and musllinux 1.2 x64/ARM64. Each target installs and executes its
wheel, tests cancellation and explicit Python rollback, and checks native
version/load evidence outside the checkout's package directory. The sdist job
checks public inputs, rebuilds from the archive and smoke-tests the installed
result. Only after every job succeeds does `wheel-manifest.py` validate all
eight wheels' metadata, tags and SHA-256 and record their source commit.

The resulting `native-dist` artifact contains the complete set and sdist.
Python publication uploads that set; the DSH plugin imports the same commit's
wheels. `npm prepack` validates a complete bundle and never replaces it with a
local wheel. Local `build:backend` remains available for development, produces
an incomplete manifest, and cannot pass the formal publication gate.

Source archives include Rust sources, lockfile, Python sources, built UI and
public developer inputs, excluding compiled native libraries, private state,
dependencies and caches. Standard CPython 3.10+ with the GIL is supported;
this release makes no prebuilt PyPy/free-threaded promise. Runtime rollback
does not remove the source build's Rust requirement.

## Homebrew (the xiayh0107/tap tap)

```bash
brew install xiayh0107/tap/hoploom
```

Homebrew cannot install a PyPI package from the main formula set unless the
project adopts it there, so the formula lives in a tap,
[xiayh0107/homebrew-tap](https://github.com/xiayh0107/homebrew-tap). Its
`brew test-bot` workflow builds every pull request from source on macOS and
Linux, and the **brew pr-pull** workflow publishes the bottles once that is green.

The formula is updated **after** a release reaches PyPI, from the file PyPI
serves. `publish.yml` builds its own sdist rather than uploading the local one,
and sdists are not byte-reproducible, so a `dist/` build never has the hash
Homebrew will download:

```bash
sdist="$(mktemp -d)/hoploom-X.Y.Z.tar.gz"
curl -fsSL -o "$sdist" \
  https://files.pythonhosted.org/packages/source/h/hoploom/hoploom-X.Y.Z.tar.gz
scripts/prepare_packaging "$sdist"
cp dist/packaging/homebrew/hoploom.rb "$(brew --repository xiayh0107/tap)/Formula/"
brew update-python-resources xiayh0107/tap/hoploom
```

Then commit on a branch in the tap and open a pull request.

For the first Hoploom release, remove the old `ssh-server-manager.rb` formula
and merge `dist/packaging/homebrew/formula_renames.json` into the tap's root
`formula_renames.json` in that same PR. Preserve any other rename mappings.
See the [migration guide](migration.md) for the GitHub/PyPI cutover order.

`packaging/homebrew/hoploom.rb.in` is the template and
`scripts/prepare_packaging` is the only thing that should fill it in. The script
refuses an sdist whose version disagrees with `__version__`, whose archive does
not contain `hoploom-<version>/`, or whose hash is not the one PyPI
serves for that version (`--offline` skips only that last check, for local
experiments). It also fills in PyPI's own URL for the file, which `brew audit`
requires instead of the `/packages/source/` redirect.

`brew update-python-resources` generates the dependency `resource` blocks. Those
pin a hash per dependency, so they are produced in the tap (where network access
is expected) rather than committed here. Two things to check in its output:
Homebrew installs with a one-day upload cooldown, so a dependency released in the
last day must be pinned to the previous version; and the resolution runs on one
platform, so keyring's Linux-only `jeepney` and `secretstorage` belong in an
`on_linux` block. Every resource builds from source, which is why the formula
needs Rust, `pkgconf`, OpenSSL, libffi and libyaml. Regenerate maturin and other
build resources as well as runtime dependencies for the native release. Its test never touches the OS
keychain, which a test sandbox does not have.

## winget (not planned)

winget installs a Windows installer or a portable archive, not a Python package.
Shipping a winget manifest would mean building and signing an `.exe`/`.msi` (or a
zip with a launcher) and maintaining that build for every release — a second
packaging pipeline for a tool whose Windows install already works:

```powershell
irm https://raw.githubusercontent.com/xiayh0107/hoploom/main/install.ps1 | iex
```

or `pipx install hoploom`. Until a Windows installer actually exists,
publishing a manifest would promise an install path that is not tested, so this
stays out of the roadmap.

## What is *not* packaged

- No Docker image: the tool's value is this machine's keychain and SSH agent, and
  a container has neither.
- No snap/flatpak: confinement hides `~/.ssh` and the OS credential store, which
  are the two things the tool exists to use.

## Checklist addition

Once `publish.yml` has uploaded the release to PyPI, render the formula from
PyPI's sdist as above and open the tap pull request. A local `dist/` sdist is
refused by `prepare_packaging`; render it with `--offline` only to try a template
change.
