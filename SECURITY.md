# Security Policy

## Supported versions

Only the latest released version of the OPM Flow Editor Support VS Code
extension receives security updates. Older versions are not patched.

## Reporting a vulnerability

If you believe you have found a security vulnerability in this extension,
please report it privately rather than opening a public issue.

Use GitHub's
[private vulnerability reporting](https://github.com/OPM/opm-flow-editor-support/security/advisories/new)
to route the report directly to the maintainers. Please include:

- A description of the issue and its impact.
- Steps to reproduce, ideally including a minimal deck file or
  configuration that triggers the behaviour.
- The extension version (`Extensions: Show Installed Extensions` in
  VS Code) and your VS Code version.

You should receive an acknowledgement within a few business days. We will
work with you on a fix and coordinate a disclosure timeline; please give
us a reasonable window to release a patched version before any public
disclosure.

## Scope

In scope:

- The published `magne-sjaastad.opm-flow-editor-support` VS Code extension.
- The build / packaging pipeline in `.github/workflows/build-vsix.yml`.
- Helper scripts in `scripts/` that produce the bundled keyword index.

Out of scope:

- Vulnerabilities in OPM Flow itself, the OPM reference manual, or other
  upstream OPM projects — please report those to the relevant
  [OPM repository](https://github.com/OPM).
- Issues that require an already-compromised developer machine or an
  attacker-controlled VS Code installation.
