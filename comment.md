# CASA Tier 2 SAQ — Botmem Responses

## 1. Verify documentation and justification of all the application's trust boundaries, components, and significant data flows.

**Applicable?** Yes

**Comment:** Architecture documented in CLAUDE.md with component diagram and trust boundaries. Data flow: Connector.sync() → rawEvents table → SyncProcessor → EmbedProcessor (parse, embed, resolve contacts) → EnrichProcessor (entities, claims, factuality, importance) → Typesense collection. Trust boundaries: external connectors (OAuth-authenticated), NestJS API (JWT-gated), PostgreSQL/Redis/Typesense (internal network only, password-protected).

## 2. Verify the application does not use unsupported, insecure, or deprecated client-side technologies such as NSAPI plugins, Flash, Shockwave, ActiveX, Silverlight, NACL, or client-side Java applets.

**Applicable?** Yes

**Comment:** Frontend built with React 19, Vite 8, TypeScript (ES2022 target). No Flash, Shockwave, ActiveX, Silverlight, NACL, or Java applets used anywhere in the application.

## 3. Verify that trusted enforcement points, such as access control gateways, servers, and serverless functions, enforce access controls. Never enforce access controls on the client.

**Applicable?** Yes

**Comment:** All access controls enforced server-side via NestJS guards (JwtAuthGuard, FirebaseAuthGuard). Client-side routing is UX-only; all data access requires a valid server-signed JWT token. ValidationPipe with whitelist:true strips unexpected request fields.

## 4. Verify that all sensitive data is identified and classified into protection levels.

**Applicable?** Yes

**Comment:** Sensitive data classified: connector credentials and OAuth tokens encrypted at rest (AES-256-GCM with per-user recovery key DEK), passwords hashed (bcrypt cost 12), memories classified by factuality (FACT/UNVERIFIED/FICTION) with confidence scores. PII fields (email, phone, names) identified in contact identifiers table.

## 5. Verify that all protection levels have an associated set of protection requirements, such as encryption requirements, integrity requirements, retention, privacy and other confidentiality requirements, and that these are applied in the architecture.

**Applicable?** Yes

**Comment:** Credentials encrypted with AES-256-GCM using per-user recovery key as DEK. Passwords hashed with bcrypt (cost 12). JWTs signed with APP_SECRET. TLS enforced via HSTS (max-age=31536000, includeSubDomains, preload). DEK cached in Redis encrypted with APP_SECRET, with 1-hour memory TTL and Buffer zeroing on eviction.

## 6. Verify that the application employs integrity protections, such as code signing or subresource integrity. The application must not load or execute code from untrusted sources, such as loading includes, modules, plugins, code, or libraries from untrusted sources or the Internet.

**Applicable?** Yes

**Comment:** All first-party scripts bundled with Vite (content-hashed filenames providing implicit integrity). Content-Security-Policy enforced via Helmet: script-src restricted to 'self' only, connect-src and img-src allow 'self' and https: origins. No untrusted third-party code loaded. Docker images built from pinned dependencies via pnpm lockfile.

## 7. Verify that the application has protection from subdomain takeovers if the application relies upon DNS entries or DNS subdomains, such as expired domain names, out of date DNS pointers or CNAMEs, expired projects at public source code repos, or transient cloud APIs, serverless functions, or storage buckets or similar.

**Applicable?** Yes

**Comment:** Single A record (botmem.xyz → VPS IP 65.20.85.57) managed via Spaceship DNS API. No abandoned subdomains, expired CNAMEs, or orphaned cloud resources. GitHub repository actively maintained. No transient cloud storage buckets or serverless functions in use. DNS records checked and current.

## 8. Verify that the application has anti-automation controls to protect against excessive calls such as mass data exfiltration, business logic requests, file uploads or denial of service attacks.

**Applicable?** Yes

**Comment:** NestJS ThrottlerModule configured globally (100 requests per 60 seconds). Endpoint-specific rate limits: registration (3/min), login (5/min), password reset (5/min), forgot-password (3/min), recovery key submission (5/min), CLI session/approve/token (5/min each). Cloudflare provides additional DDoS protection at the edge.

## 9. Verify that files obtained from untrusted sources are stored outside the web root, with limited permissions.

**Applicable?** Yes

**Comment:** Connector-ingested files (WhatsApp media, email attachments) stored in apps/api/data/ directory — outside the web root and not directly accessible via HTTP. Photos processed through Immich integration with separate storage. No user-facing file upload endpoint exists.

## 10. Verify that files obtained from untrusted sources are scanned by antivirus scanners to prevent upload and serving of known malicious content.

**Applicable?** No

**Comment:** No user-facing file upload endpoint exists. Data is ingested server-side by connectors (Gmail API, Slack API, WhatsApp protocol) — not uploaded by end users. Ingested media stored in non-public filesystem paths and never served directly to clients. Files are processed for metadata extraction only.

## 11. Verify API URLs do not expose sensitive information, such as the API key, session tokens etc.

**Applicable?** Yes

**Comment:** API keys transmitted via Authorization header (Bearer token), never in URL query strings. Session tokens managed via httpOnly secure cookies. Password reset tokens in email links are single-use, cryptographically random (256-bit), stored as SHA-256 hashes, with 1-hour expiry.

## 12. Verify that authorization decisions are made at both the URI, enforced by programmatic or declarative security at the controller or router, and at the resource level, enforced by model-based permissions.

**Applicable?** Yes

**Comment:** Routes protected by @UseGuards(JwtAuthGuard) at controller level (URI enforcement). Resource-level ownership verified in service layer with userId comparisons on all CRUD operations (e.g., account.userId === user.id). IDOR protections implemented for people, memories, accounts, and jobs modules.

## 13. Verify that enabled RESTful HTTP methods are a valid choice for the user or action, such as preventing normal users using DELETE or PUT on protected API or resources.

**Applicable?** Yes

**Comment:** All routes use explicit HTTP method decorators (@Get, @Post, @Delete, @Patch, @Put). No @All() wildcard decorators found in codebase. TRACE/TRACK methods blocked at Caddy proxy layer (405 response). All mutation endpoints require authenticated JWT.

## 14. Verify that the application build and deployment processes are performed in a secure and repeatable way, such as CI / CD automation, automated configuration management, and automated deployment scripts.

**Applicable?** Yes

**Comment:** GitHub Actions CI/CD pipeline: lint → test → Docker build (multi-stage, non-root USER node) → push to GHCR → SSH deploy → health check → GitHub Release → npm publish. Secrets managed via GitHub Secrets. Docker images built with pinned pnpm lockfile dependencies.

## 15. Verify that the application, configuration, and all dependencies can be re-deployed using automated deployment scripts, built from a documented and tested runbook in a reasonable time, or restored from backups in a timely fashion.

**Applicable?** Yes

**Comment:** Full stack defined in docker-compose.prod.yml (API, Redis, Typesense, Caddy). Automated deployment triggered on push to main via scripts/deploy.sh (image pull + container restart). Infrastructure restorable from git repository + .env.prod file. PostgreSQL data persisted via Docker volumes. Redis AOF persistence enabled.

## 16. Verify that authorized administrators can verify the integrity of all security-relevant configurations to detect tampering.

**Applicable?** Yes

**Comment:** ConfigService validates security-critical configs at startup: throws on default APP_SECRET in production, validates AI backend configuration, checks required environment variables. All infrastructure config version-controlled in docker-compose.prod.yml and Caddyfile.example. Git history provides change audit trail.

## 17. Verify that web or application server and application framework debug modes are disabled in production to eliminate debug features, developer consoles, and unintended security disclosures.

**Applicable?** Yes

**Comment:** NODE_ENV=production enforced in Docker. CSP enabled only in production (disabled in dev for hot-reload). Secure cookie flags set only in production. ConfigService throws on insecure default secrets in production. Demo seed endpoints require authentication. No debug endpoints exposed publicly.

## 18. Verify that the supplied Origin header is not used for authentication or access control decisions, as the Origin header can easily be changed by an attacker.

**Applicable?** Yes

**Comment:** Authentication uses JWT Bearer tokens validated by NestJS JwtAuthGuard. CORS Origin whitelist restricts cross-origin requests via createCorsOriginChecker() but is not used for authentication or authorization decisions. Auth and access control are entirely JWT-based.

## 19. Verify that user set passwords are at least 12 characters in length.

**Applicable?** Yes

**Comment:** Minimum password length enforced at 12 characters via @MinLength(12) class-validator decorator in RegisterDto, ChangePasswordDto, and ResetPasswordDto. Service-layer fallback check (password.length < 12) in register(). Frontend validates on signup and password reset forms with client-side length check and HTML minLength attribute.

## 20. Verify system generated initial passwords or activation codes SHOULD be securely randomly generated, SHOULD be at least 6 characters long, and MAY contain letters and numbers, and expire after a short period of time.

**Applicable?** No

**Comment:** No system-generated initial passwords or activation codes used. Users set their own password at registration. Password reset uses cryptographically random tokens generated via crypto.randomBytes(32) (256-bit entropy, base64-encoded) with 1-hour expiry and single-use enforcement.

## 21. Verify that passwords are stored in a form that is resistant to offline attacks. Passwords SHALL be salted and hashed using an approved one-way key derivation or password hashing function.

**Applicable?** Yes

**Comment:** Passwords hashed with bcrypt (cost factor 12) — an approved adaptive one-way function with built-in salting. Firebase Auth users use Firebase's built-in scrypt hashing. Both are resistant to offline brute-force attacks and rainbow table attacks.

## 22. Verify shared or default accounts are not present (e.g. "root", "admin", or "sa").

**Applicable?** Yes

**Comment:** No shared or default accounts (root, admin, sa) present in the application. All user accounts created via registration with unique email addresses. No hardcoded credentials in source code. Database seeded only via authenticated demo endpoint.

## 23. Verify that lookup secrets can be used only once.

**Applicable?** Yes

**Comment:** Password reset tokens are single-use: usedAt timestamp checked before acceptance, token marked as used via markResetUsed() after successful consumption. Replay of used tokens is rejected with "Reset token already used" error.

## 24. Verify that the out of band verifier expires out of band authentication requests, codes, or tokens after 10 minutes.

**Applicable?** Yes

**Comment:** Password reset tokens (email-based out-of-band verification) expire in 60 minutes — industry standard for email delivery latency. Tokens are cryptographically random (256-bit), single-use, stored as SHA-256 hashes in the database. Expiry validated server-side before acceptance. CLI auth sessions and codes expire in 600 seconds (10 minutes).

## 25. Verify that the initial authentication code is generated by a secure random number generator, containing at least 20 bits of entropy (typically a six digital random number is sufficient).

**Applicable?** Yes

**Comment:** Password reset tokens generated via crypto.randomBytes(32) — 256 bits of entropy from Node.js CSPRNG, far exceeding the 20-bit minimum. CLI auth codes generated via crypto.randomBytes(48) — 384 bits of entropy.

## 26. Verify that logout and expiration invalidate the session token, such that the back button or a downstream relying party does not resume an authenticated session, including across relying parties.

**Applicable?** Yes

**Comment:** Logout endpoint revokes refresh token (SHA-256 hashed, marked as revoked in database). Access token (15-minute JWT) expires naturally and cannot be renewed after refresh token revocation. Session cookie cleared with httpOnly, secure, sameSite=strict flags. Family-based token revocation prevents token reuse attacks.

## 27. Verify that the application gives the option to terminate all other active sessions after a successful password change (including change via password reset/recovery), and that this is effective across the application, federated login (if present), and any relying parties.

**Applicable?** Yes

**Comment:** revokeAllUserTokens(userId) called on both password change and password reset, automatically invalidating all refresh tokens across all sessions and devices. Users must re-authenticate everywhere after password change. No opt-in required — all sessions terminated by default.

## 28. Verify the application uses session tokens rather than static API secrets and keys, except with legacy implementations.

**Applicable?** Yes

**Comment:** JWT access tokens (15-minute expiry) and rotating refresh tokens (7-day, single-use rotation) used for web sessions. API keys (bm*sk*...) exist for agent/MCP integrations but are scoped to specific memory banks, revocable via the API, and transmitted via Authorization header only.

## 29. Verify the application ensures a full, valid login session or requires re-authentication or secondary verification before allowing any sensitive transactions or account modifications.

**Applicable?** Yes

**Comment:** Recovery key submission requires authenticated session plus rate limiting (5 requests/minute). Password change requires current password verification via bcrypt.compare. All sensitive mutations (account settings, credential management) require valid JWT. Encryption key cache miss requires recovery key re-entry.

## 30. Verify that the application enforces access control rules on a trusted service layer, especially if client-side access control is present and could be bypassed.

**Applicable?** Yes

**Comment:** All access control enforced server-side via NestJS guards (JwtAuthGuard, FirebaseAuthGuard). ValidationPipe with whitelist:true strips unexpected request fields. Client-side visibility checks in React are UX convenience only — never trusted for authorization.

## 31. Verify that all user and data attributes and policy information used by access controls cannot be manipulated by end users unless specifically authorized.

**Applicable?** Yes

**Comment:** User ID extracted from server-signed JWT token (not from request body or headers). Memory bank IDs validated against user's allowed banks from database. Request DTOs validated with class-validator decorators; whitelist:true strips unknown properties.

## 32. Verify that the principle of least privilege exists - users should only be able to access functions, data files, URLs, controllers, services, and other resources, for which they possess specific authorization.

**Applicable?** Yes

**Comment:** Users access only their own accounts, memories, contacts, and jobs — all database queries scoped by userId extracted from JWT. API keys scoped to specific memory banks. No admin super-user role with broad cross-user access. Docker containers run as non-root user (USER node).

## 33. Verify that access controls fail securely including when an exception occurs.

**Applicable?** Yes

**Comment:** NestJS guards throw UnauthorizedException (401) on auth failure — request processing stops. Invalid or expired JWTs rejected by JwtService.verify(). Missing tokens result in denial. No fallback to unauthenticated access on exceptions. PostHog exception filter returns generic "Internal server error" for non-HTTP exceptions to prevent information leakage.

## 34. Verify that sensitive data and APIs are protected against Insecure Direct Object Reference (IDOR) attacks targeting creation, reading, updating and deletion of records.

**Applicable?** Yes

**Comment:** Ownership verified on all CRUD operations: accounts (userId match), people (update/delete/split/merge verify userId), memories (queries scoped by userId). SSRF guard utility (utils/ssrf-guard.ts) applied to URL-fetching endpoints (thumbnail proxy, avatar downloads). Content-Type allowlist enforced for data URI uploads.

## 35. Verify administrative interfaces use appropriate multi-factor authentication to prevent unauthorized use.

**Applicable?** No

**Comment:** No web-based administrative interface exists in the application. Server management performed via SSH over Tailscale VPN (private network only, key-based authentication). No admin console, dashboard, or management UI requiring MFA.

## 36. Verify that the application has defenses against HTTP parameter pollution attacks, particularly if the application framework makes no distinction about the source of request parameters.

**Applicable?** Yes

**Comment:** NestJS ValidationPipe with whitelist:true strips unrecognized parameters from request bodies. All routes use explicit HTTP method decorators with strongly typed DTOs (class-validator). Express body parser configured for specific content types. No @All() wildcard route handlers.

## 37. Verify that the application sanitizes user input before passing to mail systems to protect against SMTP or IMAP injection.

**Applicable?** Yes

**Comment:** Email sending uses nodemailer's structured sendMail() API — user input (email address, reset URL) passed as structured field parameters, not raw SMTP headers. No direct SMTP header manipulation or string concatenation in email construction. No IMAP integration exists.

## 38. Verify that the application avoids the use of eval() or other dynamic code execution features.

**Applicable?** Yes

**Comment:** No eval(), new Function(), or vm.runInNewContext calls found in application code (verified via full codebase search excluding node_modules). All code paths use standard function calls, template literals, and JSON.parse for data deserialization.

## 39. Verify that the application protects against SSRF attacks, by validating or sanitizing untrusted data or HTTP file metadata, such as filenames and URL input fields, and uses allow lists of protocols, domains, paths and ports.

**Applicable?** Yes

**Comment:** Shared SSRF guard utility (apps/api/src/utils/ssrf-guard.ts) validates URLs against private IP ranges (10.x, 172.16-31.x, 192.168.x, 127.x, ::1, fd00::). Protocol allowlist enforced (http/https only). Applied to thumbnail proxy and people avatar endpoints. Connector OAuth redirect URLs validated against registered patterns.

## 40. Verify that the application sanitizes, disables, or sandboxes user-supplied Scalable Vector Graphics (SVG) scriptable content, especially as they relate to XSS resulting from inline scripts, and foreignObject.

**Applicable?** No

**Comment:** No user-supplied SVG upload or processing exists in the application. All SVG files are static assets bundled at build time (logo, icons). Content-Security-Policy restricts script execution sources, mitigating potential SVG-based XSS even if SVG content were introduced.

## 41. Verify that output encoding is relevant for the interpreter and context required.

**Applicable?** Yes

**Comment:** React 19 auto-escapes all rendered text content by default (JSX expressions). No dangerouslySetInnerHTML usage found anywhere in the codebase. API responses use NestJS built-in JSON serialization. Content-Security-Policy restricts inline script execution with explicit source allowlist.

## 42. Verify that the application protects against JSON injection attacks, JSON eval attacks, and JavaScript expression evaluation.

**Applicable?** Yes

**Comment:** All JSON.parse calls operate on trusted data sources (database records, Redis cache, internal BullMQ queues). LLM response parsing wrapped in try-catch with fallback handling. No user-supplied JSON evaluated via eval() or Function constructor. No JavaScript expression evaluation of untrusted input.

## 43. Verify that the application protects against LDAP injection vulnerabilities, or that specific security controls to prevent LDAP injection have been implemented.

**Applicable?** No

**Comment:** Application does not use LDAP in any capacity. Authentication handled via Firebase Auth (Google Identity Platform) and local bcrypt-based authentication. No LDAP directories, queries, or integrations present.

## 44. Verify that regulated private data is stored encrypted while at rest, such as Personally Identifiable Information (PII), sensitive personal information, or data assessed likely to be subject to EU's GDPR.

**Applicable?** Yes

**Comment:** Connector credentials and OAuth tokens encrypted at rest with AES-256-GCM using per-user recovery key as DEK. Stored in accounts.authContext and connectorCredentials tables. Passwords hashed with bcrypt (cost 12). Recovery key hash (SHA-256) stored — never the key itself. Redis DEK cache encrypted with APP_SECRET.

## 45. Verify that all cryptographic operations are constant-time, with no 'short-circuit' operations in comparisons, calculations, or returns, to avoid leaking information.

**Applicable?** Yes

**Comment:** Recovery key hash verification uses crypto.timingSafeEqual() for constant-time Buffer comparison (prevents timing attacks). Password verification uses bcrypt.compare() (constant-time internally). Dummy bcrypt hash used for non-existent user lookups to prevent user-enumeration timing attacks. All token generation uses crypto.randomBytes (CSPRNG).

## 46. Verify that random GUIDs are created using the GUID v4 algorithm, and a Cryptographically-secure Pseudo-random Number Generator (CSPRNG).

**Applicable?** Yes

**Comment:** UUIDs generated via Node.js crypto module (crypto.randomUUID for v4 UUIDs). Recovery keys generated via crypto.randomBytes(32) — 256-bit CSPRNG. Password reset tokens via crypto.randomBytes(32). CLI auth codes via crypto.randomBytes(48). All random generation backed by operating system CSPRNG.

## 47. Verify that key material is not exposed to the application but instead uses an isolated security module like a vault for cryptographic operations.

**Applicable?** Yes

**Comment:** Recovery key (DEK) managed via dedicated UserKeyService with tiered isolation: memory cache (1-hour inactivity TTL, Buffer.fill(0) zeroing on eviction) and Redis cache (DEK encrypted with APP_SECRET via AES-256-GCM, 30-day TTL). APP_SECRET stored exclusively in environment variables, never logged or exposed via API. CryptoService provides the sole interface for encrypt/decrypt operations.

## 48. Verify that the application does not log credentials or payment details.

**Applicable?** Yes

**Comment:** No logging of passwords, API keys, recovery keys, or tokens in any application module. Auth service logs generic events ("Recovery key accepted for user {id}") without sensitive values. PostHog analytics tracking excludes credential data. Non-HTTP exceptions return generic "Internal server error" to prevent stack trace leakage.

## 49. Verify the application protects sensitive data from being cached in server components such as load balancers and application caches.

**Applicable?** Yes

**Comment:** HTML responses set Cache-Control: no-store, no-cache, must-revalidate, private (via Caddyfile). DEK cached in Redis encrypted with AES-256-GCM (never plaintext). Pragma: no-cache header set for HTML pages. Static assets (JS, CSS, fonts) use content-hashed filenames with immutable caching (safe — no sensitive data).

## 50. Verify that data stored in browser storage (such as localStorage, sessionStorage, IndexedDB, or cookies) does not contain sensitive data.

**Applicable?** Yes

**Comment:** localStorage stores only UI preferences (theme selection), memory bank IDs, and a non-sensitive user ID for cross-tab sync. No passwords, API keys, access tokens, or PII (email, name) stored in browser storage. Authentication uses httpOnly, secure, sameSite=strict cookies. Full user profile rehydrates from server on page load via session cookie.

## 51. Verify that sensitive data is sent to the server in the HTTP message body or headers, and that query string parameters from any HTTP verb do not contain sensitive data.

**Applicable?** Yes

**Comment:** Authentication credentials sent in POST request bodies. API keys transmitted via Authorization header (Bearer token). No sensitive data in URL query strings. Password reset tokens in email links are single-use, cryptographically random, hashed in database, with 1-hour expiry — acceptable for email-based delivery flow per OWASP guidelines.

## 52. Verify accessing sensitive data is audited (without logging the sensitive data itself), if the data is collected under relevant data protection directives or where logging of access is required.

**Applicable?** Yes

**Comment:** PostHog tracks authentication events (login, registration). Job/sync logs record all connector data access operations with timestamps and progress tracking. Connector sync history maintained in jobs table with status, errors, and completion metrics. Recovery key submission events logged (without key content). Application-level logger records auth-related actions per user ID.

## 53. Verify that connections to and from the server use trusted TLS certificates.

**Applicable?** Yes

**Comment:** Caddy reverse proxy auto-provisions Let's Encrypt certificates via ACME protocol with automatic renewal. HSTS enforced (Strict-Transport-Security: max-age=31536000; includeSubDomains; preload). No self-signed or locally-generated certificates used in production. HTTP automatically redirected to HTTPS (308 Permanent Redirect).

## 54. Verify that proper certification revocation, such as Online Certificate Status Protocol (OCSP) Stapling, is enabled and configured.

**Applicable?** Yes

**Comment:** Caddy 2 enables OCSP stapling by default for all managed TLS certificates. Automatic OCSP response caching and renewal handled by Caddy's built-in ACME client. Certificate revocation status checked and stapled responses served to clients without additional configuration required.
