# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 1.x | ✅ |
| < 1.0 | ❌ |

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability
reporting instead:

**Security → Advisories → Report a vulnerability** on
[github.com/windsor8890/dsh-screencapture/security/advisories](https://github.com/windsor8890/dsh-screencapture/security/advisories/new)

If private advisories are unavailable, contact the maintainer through the e-mail listed on the
GitHub profile and mention `dsh-screencapture security` in the subject.

Please include:

- affected version and Windows version,
- a minimal reproduction (steps, inputs, expected vs. actual behaviour),
- impact assessment (what an attacker could read/execute),
- any suggested fix.

You can expect an initial response within a few days. Please allow a reasonable disclosure window
before publishing details.

## Design boundaries worth knowing

- All HTTP routes (`/api/dsh-screencapture/*`) are **loopback-only**: the socket address is checked
  and the `Host` header must be a loopback host (`host/fence.js`). Cross-site requests with an
  `Origin` mismatch are rejected.
- Captures, clipboard data and saved PNGs never leave the machine; the plugin performs no network
  requests and has no telemetry.
- The host half spawns `powershell.exe` / `pwsh` and reads two bundled `.ps1` helper scripts. The
  helpers run with the privileges of the DSH process; treat local script access as equivalent to
  local code execution.
- Captured screenshots can contain sensitive information. The plugin only writes them to the
  clipboard and to the directory the user selects/confirms; it never uploads them.

## Out of scope

- Vulnerabilities in DeepSeek Harness itself (report them to the Harness project).
- Vulnerabilities in third-party software used to test the plugin (PowerShell, Windows).
- Issues that require an attacker to already have local code execution or administrator rights.
