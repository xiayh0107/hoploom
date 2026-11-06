# Changelog

## 0.2.2 — 2026-11-06

- Publish through npm Trusted Publishing from the `publish-dsh` workflow,
  with automatic provenance and no stored npm token. The package contents are
  unchanged from 0.2.1.

## 0.2.1 — 2026-11-05

- Support dsh 0.2.1-rc.5 and later 0.2.x releases (`engines.dsh`
  `>=0.2.1-rc.5 <0.3.0-0`). 0.2.0 accepted only 0.2.1-rc.5, so dsh 0.2.2
  refuses to install it and skips it at startup. Verified on dsh 0.2.1-rc.5
  and 0.2.2-rc.1.
- Open Hoploom in dsh's right sidebar beside the conversation instead of
  replacing it. The left Hoploom entry keeps the chat and its draft in view, and
  the right sidebar's start page lists Hoploom next to files and terminals.
  Only a view without a Session on screen still shows Hoploom in place.
- Keep the embedded UI mounted while the panel is collapsed or another tab or
  Session is shown, so transfers and page state continue.
- The embedded UI and bundled backend include Hoploom's Transfers dock; the
  bundled backend is still versioned 0.11.0 and is reinstalled automatically.
- Fit the setup panel to the pane width and poll less often once the UI is ready.
- Run the integration tests against both dsh tool-execution interfaces: the
  single-call one in 0.2.1 and the batch executor plugin in 0.2.2.

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
