# Hoploom

> **A local-first secure server access layer for humans and AI agents.**

Manage SSH hosts, credentials, remote access, and host-specific agent context from one deterministic interface — without putting secrets in config files, shell history, or an AI model's context.

[Website](https://xiayh0107.github.io/hoploom/) · [Documentation](ssh-server-manager/docs/) · [Product README](ssh-server-manager/README.md) · [简体中文](ssh-server-manager/README.zh-CN.md)

Previously **SSH Server Manager** / `servers-connect`. Existing `serverctl`
commands remain compatible; follow the [upgrade guide](ssh-server-manager/docs/migration.md)
to migrate an existing installation without changing its data or vault entries.

[![test](https://github.com/xiayh0107/hoploom/actions/workflows/test.yml/badge.svg)](https://github.com/xiayh0107/hoploom/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/xiayh0107/hoploom)](https://github.com/xiayh0107/hoploom/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Why Hoploom?

OpenSSH is excellent at transport. The hard part is everything around it:

- remembering which hostname, user, port, bastion, or credential belongs to which machine;
- keeping passwords and key passphrases out of dotfiles, scripts, environment variables, and shell history;
- letting coding agents operate remote machines without exposing credentials to the model;
- keeping environment-specific procedures attached to the hosts where they actually apply;
- providing one consistent interface across macOS, Linux, and Windows.

`Hoploom` puts a small local control layer around OpenSSH.

```text
                  Human
                    │
            CLI / Local Web UI
                    │
                    ▼
        ┌───────────────────────┐
        │        hoploom        │
        │                       │
        │  Host inventory       │
        │  Credential routing   │
        │  Context routing      │
        │  Test / Exec / Files  │
        └───────────┬───────────┘
                    │
              OpenSSH / SFTP
                    │
                    ▼
             Remote Servers
                    ▲
                    │
                AI Agent
                    │
              Agent Skill
```

The core idea is simple:

> **Humans and agents can use a server without needing to know or expose its secret.**

---

## What it manages

A managed server is more than an IP address.

| Layer | What Hoploom knows |
|---|---|
| **Identity** | alias, hostname, port, username, tags, notes, ProxyJump chain |
| **Credential** | password, private-key reference, key passphrase, ssh-agent/OpenSSH defaults |
| **Context** | working paths, host notes, host-bound Agent Skills |
| **Action** | test, connect, execute commands, browse and transfer files |

That turns this:

```bash
ssh -J user@bastion.example.com deploy@10.0.2.7
```

into this:

```bash
hoploom connect db1
```

And for an AI agent:

```bash
hoploom exec db1 --json -- uptime
```

---

## Secrets stay outside the model

Passwords and key passphrases live in the operating system's native credential vault:

| Platform | Secret storage |
|---|---|
| macOS | Keychain |
| Windows | Credential Locker |
| Linux | Secret Service |
| Private keys | Existing local file; only the absolute path is stored |

`hoploom` does **not** inject secrets through command-line arguments, environment variables, config files, or shell history.

Authentication is handled out-of-band through OpenSSH AskPass:

```text
AI Agent
   │
   │ hoploom exec gpu01 ...
   ▼
hoploom
   │
   │ credential identifier
   ▼
AskPass ───────────────► OS Credential Vault
   │                           │
   │        actual secret      │
   ◄───────────────────────────┘
   │
   ▼
OpenSSH
   │
   ▼
Remote Host
```

The secret is delivered directly to the SSH authentication process. It is not returned to the caller and does not enter the agent's model context.

Unsafe plaintext keyring backends are rejected rather than silently accepted.

See the full [security model](ssh-server-manager/docs/security.md).

---

## Built for AI agents

The project ships as an [Agent Skill](ssh-server-manager/SKILL.md) for Claude Code, Codex, Gemini CLI, Cursor, and other Agent Skills-compatible clients.

For managed hosts, agents are instructed to use `hoploom` instead of improvising with raw `ssh`, `scp`, `sftp`, `rsync`, or `sshpass`.

That gives agents a deterministic, machine-readable interface:

```bash
# Discover available hosts
hoploom server list --json

# Test connectivity
hoploom server test gpu01 --json

# Run a remote command
hoploom exec gpu01 --json -- nvidia-smi

# Transfer a file
hoploom get gpu01:/data/results.csv ./

# Resolve locally saved working paths
hoploom path resolve gpu01 --json
```

Connection failures are classified — authentication failure, untrusted host key, timeout, DNS failure, and more — so an agent can branch on structured results instead of parsing prose.

### One-line Agent Skill deployment

For **DeepSeek Harness**, install the local Hoploom backend below, then run
`dsh plugin --profile web add dsh-hoploom`. The
[dsh plugin](dsh-hoploom/README.md) supplies inventory/context tools and
explicitly enabled remote operations. [中文说明](dsh-hoploom/README.zh-CN.md).

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/xiayh0107/hoploom/main/install.sh | sh
```

Windows:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/xiayh0107/hoploom/main/install.ps1 | iex"
```

The installer installs dependencies, exposes `hoploom`, links the skill into detected local agents, and runs `hoploom doctor`.

Only the CLI and Web UI, without the skill links:

```bash
pipx install hoploom
# or
brew install xiayh0107/tap/hoploom
```

---

## Host-specific Agent Skills

Connecting to a server is only half the problem. After connecting, an agent may also need to know:

- cluster topology;
- scheduler conventions;
- approved health checks;
- project directories;
- storage layouts;
- deployment procedures;
- service-specific runbooks.

That information should not live in one giant global prompt.

`Hoploom` lets local Agent Skills be explicitly associated with the hosts where they apply:

```text
gpu-login ───────┐
gpu-node-01 ─────┼── gpu-ops
gpu-node-02 ─────┘

storage-01 ────────── storage-ops

production-web ───── production-runbook
```

The workflow is **target first, context second**:

```bash
hoploom server list --json
hoploom skill resolve gpu-node-01 --json
```

A host-skill binding is relevance metadata, not authorization. It does not grant permission to operate on a machine or bypass normal credential and host-key rules.

Manage bindings explicitly:

```bash
# Discover local skills without downloading or installing anything
hoploom skill discover --json

# Register one and bind it to selected hosts
hoploom skill add ~/.agents/skills/gpu-ops \
  --server gpu-node-01 \
  --server gpu-node-02 \
  --json

# Resolve context for the current target
hoploom skill resolve gpu-node-01 --json
```

When the target changes, agents are expected to resolve again instead of carrying host-specific context across environments.

See [Using Hoploom with AI agents](ssh-server-manager/docs/ai-agents.md).

---

## Quick start

### From source

Source builds require the Rust toolchain pinned in
`ssh-server-manager/rust-toolchain.toml`. Published native wheels need no Rust;
the one-line installer selects a published wheel and its matching Skill tag.

```bash
git clone https://github.com/xiayh0107/hoploom.git
cd hoploom/ssh-server-manager

./scripts/bootstrap
./scripts/hoploom doctor
```

Once installed, use `hoploom` directly from PATH.

### Import the SSH hosts you already have

Preview first:

```bash
hoploom server import
```

Apply explicitly:

```bash
hoploom server import --apply
```

The importer follows OpenSSH `Include` directives and resolves aliases through `ssh -G`. Your original `~/.ssh/config` is read but never rewritten.

### Add a credential

```bash
hoploom credential add-password work-password
```

The password is entered through a hidden local prompt and stored in the OS credential vault.

Private key:

```bash
hoploom credential add-key deploy-key \
  --key-path ~/.ssh/id_ed25519 \
  --store-passphrase
```

Or use ssh-agent / normal OpenSSH defaults:

```bash
hoploom credential add-agent default-agent
```

There is deliberately no normal CLI command that dumps a stored password back to stdout.

### Add and use a server

```bash
hoploom server add web1 \
  --hostname web1.example.com \
  --username deploy \
  --credential work-password
```

Then:

```bash
hoploom server test web1
hoploom connect web1
hoploom exec web1 -- uptime
hoploom exec web1 --json -- systemctl is-active nginx
```

Use `--shell` for pipelines or compound shell expressions:

```bash
hoploom exec web1 --shell -- 'du -sh /var/log/* | sort -h | tail -5'
```

---

## ProxyJump and private networks

Bastions are modeled as ordinary managed hosts:

```bash
hoploom server add bastion \
  --hostname bastion.example.com \
  --username jump

hoploom server add db1 \
  --hostname 10.0.2.7 \
  --username dba \
  --proxy-jump bastion
```

ProxyJump chains are ordered and checked for loops.

---

## Remote files

Resolve remembered working directories before searching blindly:

```bash
hoploom path resolve gpu01 --json
```

Transfer individual files through the same credential and host-key boundary:

```bash
hoploom get gpu01:/remote/result.csv ./
hoploom put ./config.yaml gpu01:/remote/config.yaml
```

The Files page browses SFTP directories, uploads with conflict confirmation, and downloads ordinary files within the runtime transfer limit.

---

## Local Web UI

```bash
hoploom ui
```

opens a management interface that listens only on loopback.

Use it to:

- add and edit servers;
- manage credentials;
- organize hosts with tags;
- inspect connection state;
- import OpenSSH configuration;
- browse remote files;
- manage Host ↔ Agent Skill relationships;
- reveal a stored secret after explicit re-authentication.

The UI uses a one-time launch token, Origin/Host validation, CSRF protection, a strict Content Security Policy, and WebAuthn/platform passkeys or an Argon2id master password for secret reveal.

Check or stop a background UI:

```bash
hoploom ui --status
hoploom ui --stop
```

---

## Host-key verification is never bypassed

`Hoploom` does not weaken OpenSSH host-key verification.

An unknown or changed host key fails with a classified `host-key-untrusted` error. There is intentionally no convenience switch that silently turns on `StrictHostKeyChecking=no`.

Verify the fingerprint and resolve the trust decision explicitly.

---

## Local-first by design

There is no Hoploom cloud account required to hold your SSH inventory or credentials.

```text
Host metadata
      │
      ▼
local SQLite database

Passwords / passphrases
      │
      ▼
OS credential vault

Private keys
      │
      ▼
your existing filesystem

SSH transport
      │
      ▼
OpenSSH
```

The trust boundary is your local OS user account, similar to OpenSSH's trust model for `~/.ssh`.

---

## What Hoploom is — and is not

### It is

A **local secure server access layer** around OpenSSH.

It handles:

- server inventory;
- credential routing;
- managed SSH configuration;
- secure authentication;
- host-key verification;
- remote command execution;
- file transport;
- host-specific Agent context.

### It is not

**Not an SSH implementation.**  
OpenSSH remains the transport layer.

**Not Terraform or Ansible.**  
It does not define desired infrastructure state or fleet configuration. Those tools can sit above or beside it.

**Not a generic Agent runtime.**  
It does not provide planning, memory, scheduling, or multi-agent orchestration. It provides one bounded capability: secure access to remote machines.

**Not a cloud credential service.**  
Your host inventory and credentials remain local.

---

## Design principles

1. **Secrets are capabilities, not context.** An agent may be allowed to use a credential without being allowed to read it.
2. **Targets come before context.** Identify the host first; only then load environment-specific Agent Skills.
3. **Fail closed.** Unsafe credential storage, ambiguous Skills, unknown host keys, and invalid security state produce errors instead of insecure fallbacks.
4. **Keep OpenSSH underneath.** Add management and policy around a mature SSH implementation instead of replacing it.
5. **Humans retain trust decisions.** Secret entry, secret reveal, host-key trust, and interactive shells remain explicit human-facing operations where appropriate.

---

## Platform support

| | macOS | Linux | Windows |
|---|---:|---:|---:|
| CLI + Local Web UI | ✅ | ✅ | ✅ |
| Native credential vault | Keychain | Secret Service | Credential Locker |
| Secret reveal re-auth | Passkey / master password | Passkey / master password | Passkey / master password |
| SSH connection reuse | ✅ | ✅ | — |

See [platform notes](ssh-server-manager/docs/platforms.md) for details.

---

## Documentation

| Guide | Description |
|---|---|
| [Quickstart](ssh-server-manager/docs/quickstart.md) | From installation to first managed host |
| [Installation](ssh-server-manager/docs/installation.md) | Installation methods and dependencies |
| [CLI reference](ssh-server-manager/docs/cli.md) | Complete `hoploom` command surface |
| [Web UI](ssh-server-manager/docs/web-ui.md) | Local management interface |
| [AI agents](ssh-server-manager/docs/ai-agents.md) | Agent Skill deployment and host-specific context |
| [Security model](ssh-server-manager/docs/security.md) | Trust boundaries and security invariants |
| [Platforms](ssh-server-manager/docs/platforms.md) | macOS, Linux, and Windows behavior |
| [FAQ](ssh-server-manager/docs/faq.md) | Common questions and troubleshooting |

The `ssh-server-manager/` source path is retained for existing source installations.
Product source, detailed docs, and the Agent Skill live in [`ssh-server-manager/`](ssh-server-manager/).

---

## Repository structure

```text
hoploom/
├── ssh-server-manager/     # Product source, CLI, Web UI, docs and Agent Skill
├── dsh-hoploom/            # DeepSeek Harness plugin (independent npm package)
├── website/                # Project website
├── install.sh              # macOS / Linux installer
├── install.ps1             # Windows installer
└── README.md               # You are here
```

---

## Mental model

```text
             SERVER ACCESS

     Identity
        +
     Credential
        +
      Context
        +
       Action
        │
        ▼
   Remote Environment
```

A server is not merely an address. For a human or an AI agent, it is an environment with an identity, an authentication boundary, relevant operational knowledge, and a controlled set of actions.

`Hoploom` keeps those pieces together.

---

## License

[MIT](LICENSE)
