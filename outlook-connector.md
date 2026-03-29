# Outlook Connector — SDK Documentation Audit Report

## Summary

Built a Microsoft Outlook connector (emails + contacts via Graph API) using **only** the published docs at `docs.botmem.xyz` and the `@botmem/connector-sdk` TypeScript types. This report documents every place where the documentation was insufficient, wrong, or missing — from the perspective of an external developer who has never seen the Botmem source code.

**Verdict**: An experienced developer can get a connector _partially_ working from the docs, but will hit multiple blockers that require reading the source code to resolve. The api-key auth path is well-documented, but OAuth2 (the most common real-world pattern) has critical gaps.

---

## Documentation Sources Used

| Source                        | URL                                     | Quality                                      |
| ----------------------------- | --------------------------------------- | -------------------------------------------- |
| Building a Connector guide    | `/connectors/building-a-connector.html` | Good structure, but only covers api-key auth |
| Connector SDK Reference       | `/contributing/connector-sdk.html`      | Incomplete — missing fields and methods      |
| `@botmem/connector-sdk` types | npm package                             | Authoritative but not all fields are obvious |
| Connectors Overview           | `/connectors/overview.html`             | **404 — page doesn't exist**                 |

---

## Findings by Severity

### BLOCKER — External developer cannot proceed without reading source code

#### 1. No OAuth2 Connector Example

**Where**: Building a Connector guide, Section 2
**Problem**: The complete example connector uses `api-key` auth type. OAuth2 — by far the most common auth type for real connectors (Gmail, Slack, Outlook, etc.) — has only a one-line table entry:

> `oauth2` — `initiateAuth` returns `{ type: 'redirect', url }`, user is redirected, `completeAuth` handles the callback

This tells you the _return type_ but nothing about:

- How to construct the OAuth authorization URL
- What scopes to request
- How to exchange the authorization code for tokens in `completeAuth()`
- What `params` are passed to `completeAuth()` (just `code`? also the original config?)
- Where to store clientId/clientSecret for later token refresh (answer: `auth.raw`)
- How to handle token expiration during sync

**Impact**: An external developer building a Gmail, Slack, Outlook, or any OAuth2 connector is completely on their own. They must reverse-engineer the auth flow or read the source code.

**Suggested fix**: Add a complete OAuth2 connector example alongside the api-key example. Show the full `initiateAuth → redirect → completeAuth → token exchange → auth.raw storage` flow.

---

#### 2. ConnectorManifest Type is Incomplete in Docs

**Where**: SDK Reference, `ConnectorManifest` section
**Problem**: The docs show 7 fields:

```typescript
interface ConnectorManifest {
  id: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  authType: AuthType;
  configSchema: Record<string, unknown>;
}
```

But the actual TypeScript type in `@botmem/connector-sdk` requires **4 additional fields**:

- `entities: string[]` — entity types this connector produces
- `pipeline: { clean?: boolean; embed?: boolean; enrich?: boolean }` — pipeline stages
- `trustScore: number` — base trust score (0-1)
- `weights?: { semantic?, recency?, importance?, trust? }` — scoring overrides

**Impact**: An external developer writes a manifest with 7 fields, TypeScript immediately errors with "missing properties". They have no docs to explain what `entities`, `pipeline`, `trustScore`, or `weights` are for or what values to use.

**Suggested fix**: Add all fields to the docs with descriptions and example values.

---

#### 3. Registration Instructions Are Wrong

**Where**: Building a Connector guide, Section 3
**Problem**: The docs say to register in `connectors.service.ts`:

```typescript
import mySourceFactory from '@botmem/connector-my-source';
// In the ConnectorsService constructor or init method:
this.register(mySourceFactory());
```

But the actual system uses `plugins.service.ts` with `loadBuiltin()`:

```typescript
await this.loadBuiltin('@botmem/connector-outlook');
```

`ConnectorsService` is a thin wrapper with no constructor initialization. Following the docs literally would mean modifying a file that has no constructor or init method to add code to.

Additionally, registering a built-in connector requires touching **4 files** that are never mentioned:

1. `apps/api/src/plugins/plugins.service.ts` — `loadBuiltin()` call
2. `packages/shared/src/types/index.ts` — `BuiltinConnectorType` union
3. `packages/shared/src/utils/index.ts` — `CONNECTOR_COLORS` map
4. `apps/web/src/lib/connectorMeta.ts` — `CONNECTOR_ICONS` + `CONNECTOR_LABELS`

**Impact**: External developer follows the docs, their connector doesn't load, and they have no idea why.

**Suggested fix**: Update registration docs to match the actual `loadBuiltin()` pattern and list all files that need updating. Or better: make registration truly automatic (e.g., scan `packages/connectors/*/` at startup).

---

#### 4. Contact/People Data Format is Undocumented

**Where**: Not documented anywhere
**Problem**: The `ConnectorDataEvent.sourceType` union is:

```typescript
'email' | 'message' | 'photo' | 'location' | 'file';
```

There is no `'contact'` type. How do you emit contact/people data? After building the connector, I discovered (by trial and error / TypeScript experimentation) that the convention is:

- Use `sourceType: 'message'` (overloaded meaning)
- Set `metadata.type: 'contact'` to distinguish from actual messages
- Put `name`, `emails`, `phones`, `organizations`, etc. in metadata
- Put `[name, ...emails]` in `participants` for contact resolution

This convention is completely undocumented. An external developer has no way to know this without reading the Gmail connector source code.

**Impact**: Connector that imports contacts (Gmail, Outlook, Slack, etc.) cannot be built from docs alone.

**Suggested fix**: Either add `'contact'` to the sourceType union, or document the `message` + `metadata.type='contact'` convention with a complete example.

---

#### 5. Pipeline Override Methods (`clean`, `embed`, `enrich`) Are Undocumented

**Where**: Not mentioned in guide or SDK reference
**Problem**: `BaseConnector` has three optional override methods that customize how data flows through the processing pipeline:

- `clean(event, ctx): CleanResult` — strip HTML, normalize text
- `embed(event, cleanedText, ctx): EmbedResult` — extract entities for search indexing
- `enrich(memoryId, ctx): EnrichResult` — extract claims, classify factuality

These are **never mentioned** in the "Building a Connector" guide or the SDK reference. The SDK reference lists `emitData()`, `emitProgress()`, `log()` as the helper methods, but omits `clean()`, `embed()`, and `enrich()` entirely.

These methods are critical for connectors that need to:

- Extract person entities from email headers (sender/recipient roles)
- Build compound person identifiers (`email:x|name:y|phone:z`)
- Strip service-specific email cruft (Outlook SafeLinks, Gmail tracking pixels)
- Classify content factuality

**Impact**: External developers miss the ability to customize how their connector's data is processed. Their data goes through the default pipeline which may produce poor search results.

**Suggested fix**: Add a "Pipeline Customization" section to the guide explaining these methods with examples.

---

### CONFUSING — External developer wastes significant time

#### 6. `auth.raw` Convention Not Explained

**Where**: SDK Reference, `AuthContext` section
**Problem**: The docs show `raw?: Record<string, unknown>` as "Additional connector-specific data" but don't explain its purpose. In practice, `auth.raw` is critical for OAuth2 connectors: you must store `clientId`, `clientSecret`, `tenantId`, and `redirectUri` here so that `sync()` can reconstruct the OAuth client later for token refresh.

**Suggested fix**: Document the `auth.raw` convention with an example showing what to store for OAuth2.

---

#### 7. Token Refresh During Sync Not Addressed

**Where**: Not documented anywhere
**Problem**: OAuth2 access tokens expire (Microsoft: ~1 hour, Google: ~1 hour). During a large sync (thousands of emails), the token WILL expire mid-sync. The SDK provides no helper for this. Connectors must:

- Detect 401 responses
- Use the refresh token to get a new access token
- Retry the failed request
- Update `ctx.auth.accessToken` (which has no documented mutation API)

**Suggested fix**: Either provide a `ctx.refreshAuth()` helper in the SDK, or document the token refresh pattern with code examples.

---

#### 8. `completeAuth(params)` Shape Unclear for OAuth2

**Where**: SDK Reference, `completeAuth` signature
**Problem**: For OAuth2, what does the system pass as `params`? Just the authorization `code`? Also the original `state`? Also the `clientId`/`clientSecret` from the config? The docs don't say.

In practice, the connector must:

1. Store config during `initiateAuth()` in an instance variable
2. Hope the same instance is used for `completeAuth()`
3. Also accept config from `params` as fallback

**Suggested fix**: Document what `params` contains for each auth type (oauth2, qr-code, api-key, local-tool).

---

#### 9. Default Export Convention Not Clearly Required

**Where**: Building a Connector guide
**Problem**: The example shows `export default () => new MySourceConnector()` but doesn't state this factory function pattern is **required**. The `loadBuiltin()` system calls the default export as a function to create instances. If a developer does `export default new MySourceConnector()` (exporting a singleton), it may cause issues.

**Suggested fix**: Explicitly state: "The default export MUST be a factory function (not an instance)."

---

#### 10. `emitData()` Returns False When No Listeners Exist

**Where**: SDK Reference, `emitData` section
**Problem**: The docs say to check `emitData()`'s return value for the debug sync limit. But `emitData()` is based on `EventEmitter.emit()`, which returns `false` when there are NO registered listeners — not just when the limit is reached. In tests, this caused false "limit reached" signals until we added a `data` event listener.

**Suggested fix**: Document that `emitData()` returns `false` both for debug limit AND when no listeners are registered. In tests, always add a `connector.on('data', ...)` listener before calling sync.

---

#### 11. Connectors Overview Page is 404

**Where**: Navigation sidebar links to `/connectors/overview.html`
**Problem**: Page returns 404. Navigation suggests it should exist.

**Suggested fix**: Create the page or remove the nav link.

---

### MINOR — Friction but not blocking

#### 12. AuthType Missing `phone-code`

**Where**: SDK Reference, `AuthType` definition
**Problem**: Docs show `'oauth2' | 'qr-code' | 'api-key' | 'local-tool'`. Actual SDK type also includes `'phone-code'` (used by Telegram connector).

**Suggested fix**: Add `phone-code` to the docs with a description.

---

#### 13. Attachment Type Missing `filename` and `size`

**Where**: SDK Reference, `ConnectorDataEvent`
**Problem**: Docs show attachments as `{ uri: string; mimeType: string }`. In practice, `filename` and `size` are useful for the UI and pipeline. The SDK types don't include them either, so connectors must put this info in metadata instead.

**Suggested fix**: Add `filename?: string` and `size?: number` to the attachment interface.

---

#### 14. Cursor Semantics Vague

**Where**: Building a Connector guide, "Cursor-Based Sync" section
**Problem**: Says "a string that your connector controls" — but provides no guidance on strategies. Common patterns:

- Timestamp-based (filter by date, use latest timestamp as cursor)
- Page-token-based (store API pagination token)
- Delta-token-based (Microsoft Graph delta queries)

**Suggested fix**: Show 2-3 cursor strategy examples.

---

#### 15. `sourceType: 'message'` is Overloaded

**Where**: SDK types
**Problem**: `'message'` is used for both chat messages (Slack, WhatsApp) AND contacts (as a workaround). This is confusing and makes the type less useful for filtering.

**Suggested fix**: Add `'contact'` to the sourceType union.

---

## Implementation Notes

### What Worked Well from Docs Alone

- Package scaffold (Section 1) — clear and correct
- `BaseConnector` abstract methods — well-defined interface
- `ConnectorDataEvent` shape — simple and intuitive (for emails)
- `emitData()` / `emitProgress()` / `log()` helpers — easy to use
- Testing pattern (Section 5) — good vitest example

### What Required Source Code or Trial-and-Error

- OAuth2 auth flow (everything beyond the return type)
- Token refresh during sync
- Contact data format and entity structure
- Registration (actual file locations and pattern)
- Pipeline override methods
- `auth.raw` convention
- `emitData()` behavior with EventEmitter listeners

### Files Created

- `packages/connectors/outlook/package.json`
- `packages/connectors/outlook/tsconfig.json`
- `packages/connectors/outlook/vitest.config.ts`
- `packages/connectors/outlook/src/index.ts` — OutlookConnector class
- `packages/connectors/outlook/src/oauth.ts` — Microsoft OAuth2 helpers
- `packages/connectors/outlook/src/graph-client.ts` — Graph API client with retry
- `packages/connectors/outlook/src/contacts.ts` — Contact sync
- `packages/connectors/outlook/src/sync.ts` — Email sync
- `packages/connectors/outlook/src/__tests__/outlook.test.ts` — 14 tests (all passing)

### Files Modified (Registration)

- `apps/api/src/plugins/plugins.service.ts` — Added `loadBuiltin('@botmem/connector-outlook')`
- `apps/api/package.json` — Added workspace dep
- `packages/shared/src/types/index.ts` — Added `'outlook'` to BuiltinConnectorType
- `packages/shared/src/utils/index.ts` — Added `outlook: '#0078D4'` to CONNECTOR_COLORS
- `apps/web/src/lib/connectorMeta.ts` — Added icon `'Ou'` and label `'Outlook'`

### Test Results

14 tests, 14 passing. Covers manifest, auth flow, sync with contacts + emails, error handling, cursor management, and factory export.

---

## Type-Level Fixes (make the compiler catch these issues)

The principle: **if the docs are wrong, the types should be right.** Every issue below should be fixed in the SDK types so TypeScript catches mistakes at compile time, not at runtime.

### 1. Add `'contact'` to `sourceType` union

```typescript
// Current (forces workaround of using 'message' for contacts):
sourceType: 'email' | 'message' | 'photo' | 'location' | 'file';

// Fixed:
sourceType: 'email' | 'message' | 'contact' | 'photo' | 'location' | 'file';
```

File: `packages/connector-sdk/src/types.ts`, line 65

### 2. Add `filename` and `size` to attachment type

```typescript
// Current:
attachments?: Array<{ uri: string; mimeType: string }>

// Fixed:
attachments?: Array<{ uri: string; mimeType: string; filename?: string; size?: number }>
```

File: `packages/connector-sdk/src/types.ts`, line 71

### 3. Add `'phone-code'` to `AuthType` in docs

The SDK type already has it — the docs just need to match:

```typescript
type AuthType = 'oauth2' | 'qr-code' | 'phone-code' | 'api-key' | 'local-tool';
```

### 4. Type `completeAuth` params by auth type

Currently `params: Record<string, unknown>` — impossible for external devs to know what's available. Consider:

```typescript
// Per-auth-type param shapes:
interface OAuth2CompleteParams {
  code: string;
  state?: string;
  // Original config fields echoed back:
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  [key: string]: unknown;
}
```

Even if not a separate type, document the expected shape per auth type.

### 5. Type the contact metadata convention

If contacts stay as `sourceType: 'message'`, at minimum create a typed helper:

```typescript
interface ContactEventMetadata {
  type: 'contact';
  name?: string;
  givenName?: string;
  familyName?: string;
  emails?: string[];
  phones?: string[];
  organizations?: Array<{ name?: string; title?: string }>;
  nicknames?: string[];
  addresses?: unknown[];
  birthday?: string;
  bio?: string;
  imClients?: string[];
  photos?: string[];
}
```

### 6. Export pipeline method types from SDK

`CleanResult`, `EmbedResult`, `EnrichResult`, `PipelineContext` are in the types file but external devs don't know they exist since the methods aren't documented. At minimum, ensure they're in the public exports.

---

## Bugs Found During Testing

### 1. Microsoft Graph Contacts API Pagination Loop

The Graph API's `@odata.nextLink` for `/me/contacts` cycles through the same contacts infinitely with unique skip tokens. Each page returns the same 96 contacts but with different URLs, so a naive "follow nextLink until null" approach loops forever. Fixed with `seenContactIds` dedup + `allDuplicates` page-level break guard.

### 2. NestJS Watch Mode Doesn't Reload External Packages

When running `pnpm dev` (NestJS `--watch`), changes to workspace packages (like `@botmem/connector-outlook`) are NOT reloaded — Node's module cache retains the old version. Must restart the full dev server. This is a DX issue that affects all connector development. **Audit finding**: The docs should mention this.

### 3. Email Sync Status Unknown (Pending Restart)

After fixing the contact loop, the email sync (`/me/messages`) needs testing. It may fail due to:

- Azure AD app missing `Mail.Read` API permission grant
- OAuth access token expiration during sync
- Graph API `$filter` syntax issue with incremental cursor

The connector now logs email sync errors to `console.error` for visibility.

---

## Recommendations (Priority Order)

1. **Fix types first** — Add `'contact'` sourceType, attachment fields, typed completeAuth params (see "Type-Level Fixes" above)
2. **Add OAuth2 connector example** — single highest-impact doc improvement
3. **Fix ConnectorManifest docs** — add missing fields (entities, pipeline, trustScore, weights)
4. **Fix registration docs** — match actual loadBuiltin() pattern
5. **Document contact data format** — sourceType convention + entity structure
6. **Document pipeline overrides** — clean/embed/enrich with examples
7. **Fix 404 overview page** — create or remove nav link
8. **Document auth.raw convention** — what to store for each auth type
9. **Add token refresh guidance** — critical for OAuth2 connectors
10. **Document completeAuth params** — what the system passes for each auth type
11. **Add cursor strategy examples** — timestamp vs page-token vs delta
