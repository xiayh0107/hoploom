#!/bin/sh
# One-line installer for the Hoploom Agent Skill (macOS / Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/xiayh0107/hoploom/main/install.sh | sh
#
# or from a checkout:  ./install.sh
#
# What it does:
#   1. Uses the checkout it runs from, or clones the repo to ~/.local/share/hoploom
#   2. Creates the project venv and installs dependencies (scripts/bootstrap.py)
#   3. Symlinks the skill into every detected agent skills directory
#      (~/.claude/skills, ~/.codex/skills; add more via SSM_SKILLS_DIRS)
#   4. Runs `hoploom doctor` so problems surface immediately
#
# Overrides: SSM_REPO_URL, SSM_INSTALL_DIR, SSM_SKILLS_DIRS (space-separated).
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

# 1. Locate or fetch the source tree.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || SCRIPT_DIR=""
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/$SOURCE_DIR_NAME/SKILL.md" ]; then
  SOURCE="$SCRIPT_DIR/$SOURCE_DIR_NAME"
  say "Using source checkout: $SOURCE"
elif [ -f "$INSTALL_DIR/$SOURCE_DIR_NAME/SKILL.md" ]; then
  SOURCE="$INSTALL_DIR/$SOURCE_DIR_NAME"
  if [ -d "$INSTALL_DIR/.git" ] && command -v git >/dev/null 2>&1; then
    say "Updating existing install in $INSTALL_DIR"
    git -C "$INSTALL_DIR" pull --ff-only || say "note: update skipped (local changes?)"
  fi
else
  command -v git >/dev/null 2>&1 || fail "git is required to fetch $REPO_URL"
  say "Cloning $REPO_URL -> $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  SOURCE="$INSTALL_DIR/$SOURCE_DIR_NAME"
fi

# 2. Dependencies (idempotent: reuses the venv when present).
say "Installing Python dependencies into $SOURCE/.venv ..."
python3 "$SOURCE/scripts/bootstrap.py" >/dev/null

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
say "Re-run this installer any time to update: it pulls the current repository branch,"
say "re-links the skill, and 'hoploom doctor' warns when a linked copy goes stale."
