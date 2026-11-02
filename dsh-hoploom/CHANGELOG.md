# Changelog

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
