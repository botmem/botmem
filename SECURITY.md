# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Botmem, please report it responsibly.

**Email:** security@botmem.xyz

Please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Suggested fix (if any)

**Do not** open a public GitHub issue for security vulnerabilities.

## Response Timeline

- **Acknowledgment:** within 48 hours
- **Initial assessment:** within 7 days
- **Fix timeline:** depends on severity, typically within 30 days
- **Disclosure:** coordinated disclosure after 90 days or when a fix is released, whichever comes first

## Scope

The following are in scope for security reports:

- Authentication bypass or privilege escalation
- Data exposure (unencrypted credentials, PII leaks)
- Encryption weaknesses (recovery key handling, AES-256-GCM implementation)
- Injection vulnerabilities (SQL, command, XSS)
- Connector credential mishandling
- API key or token leakage

## Architecture

Botmem encrypts connector credentials and PII at rest using AES-256-GCM with a user-held recovery key. See [Security & Encryption](https://docs.botmem.xyz/architecture/security) for the full architecture.

## Supported Versions

Security fixes are applied to the latest release on `main`. We do not backport to older versions.
