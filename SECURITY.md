# Security Policy

## Supported Versions

Security fixes are provided for the latest published `2.1.x` release and for
the current `main` branch while it is being prepared for the next release.
Users should upgrade to the newest available release before reporting or
verifying a vulnerability.

| Version | Supported |
| --- | --- |
| Latest `2.1.x` release | ✅ |
| `main` | ✅ (development branch) |
| Older releases | ❌ |

## Reporting a Vulnerability

Please do **not** open a public issue for a suspected vulnerability or publish
proof-of-concept details before a fix is available.

Use GitHub's private vulnerability reporting for this repository:

1. Open the repository's **Security** tab.
2. Choose **Advisories** and **Report a vulnerability**.
3. Include the affected release or commit, deployment mode, reproduction steps,
   expected impact and any known mitigation.

If the private-reporting option is unavailable, contact
[@carstenartur](https://github.com/carstenartur) through the GitHub profile
without including sensitive technical details and request a private channel.

The report will be assessed against the browser application, Node/Docker
server, Analysis Service, build and release pipeline, and bundled dependencies.
The maintainer will coordinate validation, remediation and responsible public
disclosure with the reporter. Non-sensitive defects and hardening proposals can
continue to use normal public issues.
