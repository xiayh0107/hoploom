#!/bin/sh
# One-line installer for the Hoploom Agent Skill (macOS / Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/xiayh0107/hoploom/main/install.sh | sh
#
# or from a checkout:  ./install.sh
#
# What it does:
#   1. Fetches a released Skill tag, or uses an explicitly selected source checkout
#   2. Installs the matching native wheel in a private venv (source mode needs Rust)
#   3. Symlinks the skill into every detected agent skills directory
#      (~/.claude/skills, ~/.codex/skills; add more via SSM_SKILLS_DIRS)
#   4. Runs `hoploom doctor` so problems surface immediately
#
# Overrides: SSM_REPO_URL, SSM_INSTALL_DIR, SSM_SKILLS_DIRS (space-separated),
# SSM_VERSION (published version), SSM_INSTALL_SOURCE=1 (build the repository).
set -eu

SOURCE_DIR_NAME="ssh-server-manager"
REPO_URL="${SSM_REPO_URL:-https://github.com/xiayh0107/hoploom.git}"
# Reuse the old checkout when upgrading; new installs use the brand name.
if [ -n "${SSM_INSTALL_DIR:-}" ]; then
  INSTALL_DIR=$SSM_INSTALL_DIR
elif [ -f "$HOME/.local/share/servers-connect/$SOURCE_DIR_NAME/SKILL.md" ]; then
  INSTALL_DIR="$HOME/.local/share/servers-connect"
else
  INSTALL_DIR="$HOME/.local/share/hoploom"
fi

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v python3 >/dev/null 2>&1 || fail "python3 (3.10+) is required"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
  || fail "python3 is older than 3.10"
command -v ssh >/dev/null 2>&1 || say "note: no ssh client on PATH; doctor will flag it"

# 1. Local files and custom repositories retain the source-build workflow.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || SCRIPT_DIR=""
SOURCE_MODE=${SSM_INSTALL_SOURCE:-0}
if [ -n "${SSM_REPO_URL:-}" ]; then SOURCE_MODE=1; fi
if [ -f "$0" ] && [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/$SOURCE_DIR_NAME/SKILL.md" ]; then
  SOURCE="$SCRIPT_DIR/$SOURCE_DIR_NAME"
  SOURCE_MODE=1
  say "Using source checkout: $SOURCE"
elif [ "$SOURCE_MODE" = 1 ] && [ -f "$INSTALL_DIR/$SOURCE_DIR_NAME/SKILL.md" ]; then
  SOURCE="$INSTALL_DIR/$SOURCE_DIR_NAME"
  if [ -d "$INSTALL_DIR/.git" ] && command -v git >/dev/null 2>&1; then
    say "Updating existing install in $INSTALL_DIR"
    git -C "$INSTALL_DIR" pull --ff-only || say "note: update skipped (local changes?)"
  fi
elif [ "$SOURCE_MODE" = 1 ]; then
  command -v git >/dev/null 2>&1 || fail "git is required to fetch $REPO_URL"
  say "Cloning $REPO_URL -> $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  SOURCE="$INSTALL_DIR/$SOURCE_DIR_NAME"
else
  VERSION=${SSM_VERSION:-$(python3 -c 'import json,re,urllib.request; v=json.load(urllib.request.urlopen("https://pypi.org/pypi/hoploom/json",timeout=20))["info"]["version"]; assert re.fullmatch(r"\d+\.\d+\.\d+",v); print(v)')}
  python3 -c 'import re,sys; assert re.fullmatch(r"\d+\.\d+\.\d+",sys.argv[1]) and tuple(map(int,sys.argv[1].split("."))) >= (0,12,0)' "$VERSION" || fail "Select a published native Hoploom version (0.12.0 or newer)"
  command -v git >/dev/null 2>&1 || fail "git is required to fetch the released Skill"
  if [ -d "$INSTALL_DIR/.git" ]; then
    [ -z "$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=no)" ] || fail "Existing install has local edits; keep them in a source checkout before updating"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "refs/tags/v$VERSION:refs/tags/v$VERSION"
    git -C "$INSTALL_DIR" checkout --detach "v$VERSION"
  else
    git clone --depth 1 --branch "v$VERSION" "$REPO_URL" "$INSTALL_DIR"
  fi
  SOURCE="$INSTALL_DIR/$SOURCE_DIR_NAME"
fi

# 2. Dependencies (idempotent: reuses the venv when present).
say "Installing Hoploom into $SOURCE/.venv ..."
if [ "$SOURCE_MODE" = 1 ]; then
  python3 "$SOURCE/scripts/bootstrap.py" >/dev/null
else
  python3 "$SOURCE/scripts/bootstrap.py" --wheel "$VERSION" >/dev/null
fi

# 3. Install the canonical Skill and both CLI names; migrate owned old links.
"$SOURCE/.venv/bin/python" "$SOURCE/scripts/install-links.py"

# 4. Health check.
say ""
say "Running hoploom doctor ..."
"$SOURCE/scripts/hoploom" doctor || {
  say "doctor reported issues above — see $SOURCE/docs/installation.md"
  exit 1
}

say ""
say "Hoploom is installed and the local health check passed."
say ""
say "If you are an AI agent running this installer, do not stop here:"
say "  1. Run: $SOURCE/scripts/hoploom server list --json"
say "  2. Tell the user which managed hosts are available (or that none are configured yet)."
say "  3. Give 3-5 short examples of things they can ask you to do using the real host aliases."
say "  4. Explain that saved SSH secrets stay in the local OS vault and do not need to enter chat."
say "  5. Say that doctor verified local readiness only; do not claim remote login works unless tested."
say "Do not make the user learn hoploom commands unless they ask for the CLI."
say ""
say "Re-run the one-line installer to update the published wheel and matching Skill."
say "Local checkout installs build from source and require the pinned Rust toolchain."
