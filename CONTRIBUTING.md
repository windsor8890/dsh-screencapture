# Contributing to dsh-screencapture

Thanks for wanting to improve the plugin! This document explains how to build, test and submit
changes.

## Scope

- The plugin is **Windows-only** at the API level: capture, clipboard writes and the global hotkey
  are implemented in PowerShell (`.NET` / Win32). The host is a plain ESM Cordis plugin; the client
  is a browser bundle rendered inside the DSH Web UI.
- macOS / Linux support would need a separate native adapter behind `host/capture.js` and
  `host/hotkey.js`; design discussions are welcome in an issue first.
- Issues and PRs should stay focused: one problem or feature per PR.

## Prerequisites

- Node.js **20 or newer**
- Windows 10/11 with an interactive desktop session (for the host/hotkey test suites)
- PowerShell 5.1 (built into Windows) — the helpers spawn `powershell.exe`
- A DeepSeek Harness install whose plugin manager can install a local bundle (for manual testing)

## Setup

```powershell
git clone https://github.com/windsor8890/dsh-screencapture.git
cd dsh-screencapture
```

Install the directory as a local bundle in DSH (Settings → Plugins → install bundle / local path),
then enable the **截图 / Screenshot** plugin.

## Build

The browser half is authored as four plain-JS files in `src/client/` and concatenated into the
committed bundle `lib/client.js`:

```powershell
node build.mjs
```

**Never edit `lib/client.js` by hand** — edit `src/client/*.js` and rebuild. Commit the regenerated
bundle together with the source change (CI verifies that the committed bundle is current).

The host half (`host/`) is plain ESM and needs no build step. After changing it, disable and
re-enable the plugin in DSH, or restart DSH.

## Tests

Cross-platform (also run by CI):

```powershell
node tests/client-math-test.mjs      # selection/coordinate/chord helpers
node tests/client-locale-test.mjs    # zh/en dictionary key parity
```

Windows, interactive desktop session:

```powershell
node tests/host-test.mjs    # real desktop capture, clipboard readback, save, route validation (17 checks)
node tests/hotkey-test.mjs  # global hotkey / SSE / config / overlay-window (20 checks)
```

The Windows suites **use the real screen and clipboard**, briefly register `F12` hotkeys, open
temporary windows (see `tests/placement-probe.ps1`) and write files under the system temp directory.
Run them when you can tolerate focus/clipboard changes, and do not run them on a locked workstation.

## Code notes

- Keep user-visible strings in **both** `zh` and `en` dictionaries (`src/client/30-entry.js` and
  `locale/*.json`); the locale test enforces parity.
- Host HTTP routes must stay loopback-only (`host/fence.js`), return JSON errors and never expose
  capture data outside the machine.
- The capture / hotkey helpers are persistent PowerShell processes; keep their stdin/stdout protocol
  line-oriented and add a timeout when introducing a new command.
- Prefer small, focused modules over new dependencies — the host intentionally uses only Node
  built-ins and Windows built-in PowerShell.
- When changing the overlay geometry or window snapping, update `tests/client-math-test.mjs`.

## Submitting a PR

1. Fork the repo and create a branch from `main`.
2. Make the change, rebuild the client bundle, and run the relevant tests.
3. Fill in the PR template: summary, motivation, changes, tests you ran, and (for UI changes) a
   screenshot of the overlay or settings page.
4. Keep the description focused; link the related issue with `Fixes #<number>` when applicable.

Bug reports and feature requests use the GitHub issue templates. For security issues, see
[SECURITY.md](SECURITY.md) — please do **not** open a public issue.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
