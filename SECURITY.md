# Security policy

Morrow's security model, controls, and exact limits are documented in
[docs/SECURITY.md](docs/SECURITY.md). Read that first for deployment hardening
and the threat model.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub **Security
Advisories** ("Report a vulnerability" under the repository's Security tab).
Do not open a public issue for a security problem.

Include what you can: affected version or commit, deployment mode, reproduction
steps, and impact. Avoid including real user data or credentials.

## Do not post secrets

Never put `.env` contents, session or setup tokens, capture/CalDAV/MCP tokens,
provider API keys, database files, or backup archives in issues, pull requests,
screenshots, or logs. Redact them before sharing.

## Scope

This is a self-hosted project; operators own their deployment, host, TLS front
door, model provider, and backups. Reports about third-party dependencies should
also go to the relevant upstream project.
