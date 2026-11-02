# Changelog

## 0.2.0 — 2026-11-02

- Automatically prepare the bundled Hoploom 0.11.0 backend and a private Python
  runtime when the default command has no usable installation. Reuse existing
  installs and preserve explicit custom commands.
- Add a native Hoploom sidebar entry and bilingual setup panel with progress,
  retry and cancel. Embed the full existing Hoploom UI in dsh without opening
  an external browser; share its inventory and vault with MCP.
- Keep recovery available during setup failures; add `hoploom_setup` for agents
  and terminal sessions. Retain metadata-only defaults and the official MCP bridge.
- Verify pinned runtime downloads, serialize concurrent installers, cancel owned
  processes and reuse verified environments offline. Do not modify system Python.
- Keep authenticated dsh owner routes, per-view sessions, CSRF and reveal
  authentication; stream uploads/downloads and cancel outstanding requests.
- Cover first installation, cache reuse, failed setup recovery, UI registration,
  cancellation and existing MCP behavior on macOS, Linux and Windows.

## 0.1.1 — 2026-11-01

- Find the default Hoploom backend in standard local installation directories
  when a desktop app's PATH omits them. Preserve explicit command selection.
- Check MCP CLI support before connecting and explain how to repair missing,
  outdated or stalled backends. Preflight scrubs ambient credentials and hides
  child diagnostics; it does not access inventory, vault or remote hosts.
- Cover default command loading, restricted PATH, Windows launchers, old backends
  and cancelled startup. Document upgrading legacy `serverctl` installations.

## 0.1.0 — 2026-11-01

- First DeepSeek Harness plugin, verified against dsh 0.2.1-rc.5.
- Discover six local metadata tools through Hoploom's existing MCP backend.
- Expose host checks and allowlisted argv commands only through explicit settings.
- Add target-first agent instructions and English/Chinese plugin metadata.
- Use the official dsh MCP client for lifecycle, cancellation and tool adaptation.
- Ship isolated backend integration tests, cross-platform CI and an npm tarball.
