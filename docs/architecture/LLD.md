# Botmem — Low-Level Design (LLD)

## 1. Database Schema (PostgreSQL + Drizzle ORM)

### 1.1 Entity-Relationship Diagram

```mermaid
erDiagram
    users ||--o{ accounts : "owns"
    users ||--o{ apiKeys : "owns"
    users ||--o{ memoryBanks : "owns"
    users {
        text id PK
        text email UK
        text password_hash
        text recovery_key_hash
        text name
        timestamp created_at
        timestamp updated_at
    }

    accounts ||--o{ jobs : "triggers"
    accounts ||--o{ rawEvents : "produces"
    accounts ||--o{ memories : "contains"
    accounts {
        text id PK
        text user_id FK
        text connector_type
        text name
        text status
        text auth_context "AES-256-GCM encrypted"
        text sync_cursor
        boolean tunnel_mode
        timestamp last_synced_at
        timestamp created_at
    }

    jobs ||--o{ logs : "produces"
    jobs {
        text id PK
        text account_id FK
        text type
        text status "queued|running|done|failed|cancelled"
        integer progress
        integer total
        text error
        text bullmq_job_id
        timestamp started_at
        timestamp completed_at
        timestamp created_at
    }

    logs {
        text id PK
        text job_id FK
        text level "info|warn|error|debug"
        text message
        text details
        timestamp created_at
    }

    rawEvents {
        text id PK
        text account_id FK
        text source_type
        text source_id
        text payload "AES-256-GCM encrypted JSON"
        text connector_type

        timestamp created_at
    }

    memories ||--o{ memoryLinks : "source"
    memories ||--o{ memoryPeople : "involves"
    memories {
        text id PK
        text account_id FK
        text memory_bank_id FK
        text raw_event_id FK
        text text "encrypted"
        text connector_type
        text source_type
        text source_id
        timestamp event_time
        real importance
        text factuality_label "FACT|UNVERIFIED|FICTION"
        real factuality_confidence
        text factuality_rationale
        text entities "encrypted JSON"
        text claims "encrypted JSON"
        text metadata "encrypted JSON"
        text search_tokens

        boolean pinned
        integer recall_count
        timestamp created_at
        timestamp updated_at
    }

    memoryLinks {
        text id PK
        text source_id FK
        text target_id FK
        text link_type "related|supports|contradicts"
        real confidence
        timestamp created_at
    }

    people ||--o{ personIdentifiers : "has"
    people ||--o{ memoryPeople : "appears_in"
    people {
        text id PK
        text user_id FK
        text display_name
        text avatar_url
        text metadata "JSON"
        timestamp created_at
        timestamp updated_at
    }

    personIdentifiers {
        text id PK
        text person_id FK
        text type "email|phone|name|handle|slack_id"
        text value
        text source
        timestamp created_at
    }

    memoryPeople {
        text id PK
        text memory_id FK
        text person_id FK
        text role "sender|recipient|mentioned|participant"
    }

    memoryBanks {
        text id PK
        text user_id FK
        text name
        text description
        timestamp created_at
    }

    connectorCredentials {
        text id PK
        text user_id FK
        text connector_type UK
        text credentials "AES-256-GCM encrypted"
        timestamp created_at
        timestamp updated_at
    }

    apiKeys {
        text id PK
        text user_id FK
        text name
        text key_hash "SHA-256"
        text key_prefix
        timestamp last_used_at
        timestamp created_at
    }

    settings {
        text key PK
        text value
        timestamp updated_at
    }

    llmCache {
        text id PK
        text input_hash "SHA-256"
        text model
        text backend
        text operation
        text output
        timestamp created_at
    }

    oauthClients {
        text id PK
        text user_id FK
        text name
        text secret_hash
        text redirect_uris "JSON array"
        text scopes "JSON array"
        timestamp created_at
    }

    oauthCodes {
        text id PK
        text client_id FK
        text user_id FK
        text code_hash
        text redirect_uri
        text scopes "JSON"
        text code_challenge
        text code_challenge_method
        timestamp expires_at
        timestamp created_at
    }

    oauthRefreshTokens {
        text id PK
        text client_id FK
        text user_id FK
        text token_hash
        text scopes "JSON"
        timestamp expires_at
        timestamp created_at
    }
```

### 1.2 Indexes

| Table | Index | Columns | Purpose |
|-------|-------|---------|---------|
| `memories` | `idx_memories_account_id` | `account_id` | Filter by account |
| `memories` | `idx_memories_event_time` | `event_time` | Temporal queries |
| `memories` | `idx_memories_connector_type` | `connector_type` | Faceted search |
| `rawEvents` | `idx_raw_events_account_source` | `account_id, source_type, source_id` | Dedup check |
| `personIdentifiers` | `idx_person_ident_type_value` | `type, value` | Contact resolution |
| `memoryPeople` | `idx_memory_people_memory` | `memory_id` | Join lookup |
| `memoryPeople` | `idx_memory_people_person` | `person_id` | Contact memory list |
| `accounts` | `idx_accounts_user_id` | `user_id` | User's accounts |

---

## 2. Module Architecture

### 2.1 NestJS Module Dependency Graph

```mermaid
graph TB
    AppModule["AppModule"]

    AppModule --> ConfigModule
    AppModule --> DbModule
    AppModule --> CryptoModule
    AppModule --> UserAuthModule
    AppModule --> ConnectorsModule
    AppModule --> AccountsModule
    AppModule --> AuthModule
    AppModule --> JobsModule
    AppModule --> MemoryModule
    AppModule --> PeopleModule
    AppModule --> EventsModule
    AppModule --> SettingsModule
    AppModule --> AnalyticsModule
    AppModule --> OAuthModule
    AppModule --> MemoryBanksModule
    AppModule --> PluginsModule

    ConfigModule["ConfigModule<br/>(ConfigService)"]
    DbModule["DbModule<br/>(DbService)"]
    CryptoModule["CryptoModule<br/>(CryptoService,<br/>UserKeyService,<br/>DekCacheService)"]

    UserAuthModule["UserAuthModule<br/>(FirebaseAuthGuard,<br/>JwtAuthGuard)"]
    UserAuthModule --> CryptoModule
    UserAuthModule --> DbModule

    AccountsModule["AccountsModule<br/>(AccountsService,<br/>AccountsController)"]
    AccountsModule --> DbModule
    AccountsModule --> CryptoModule
    AccountsModule --> ConnectorsModule

    AuthModule["AuthModule<br/>(AuthService,<br/>AuthController)"]
    AuthModule --> ConnectorsModule
    AuthModule --> AccountsModule
    AuthModule --> CryptoModule

    ConnectorsModule["ConnectorsModule<br/>(ConnectorsService)"]
    ConnectorsModule --> ConfigModule

    JobsModule["JobsModule<br/>(JobsService,<br/>JobsController,<br/>SyncProcessor)"]
    JobsModule --> DbModule
    JobsModule --> AccountsModule
    JobsModule --> ConnectorsModule
    JobsModule --> EventsModule

    MemoryModule["MemoryModule<br/>(MemoryService,<br/>MemoryController,<br/>EmbedProcessor,<br/>EnrichProcessor,<br/>CleanProcessor,<br/>DecayProcessor,<br/>OllamaService,<br/>TypesenseService)"]
    MemoryModule --> DbModule
    MemoryModule --> ConfigModule
    MemoryModule --> CryptoModule
    MemoryModule --> PeopleModule
    MemoryModule --> EventsModule

    PeopleModule["PeopleModule<br/>(PeopleService,<br/>PeopleController)"]
    PeopleModule --> DbModule
    PeopleModule --> CryptoModule

    EventsModule["EventsModule<br/>(EventsService,<br/>EventsGateway)"]

    MemoryBanksModule["MemoryBanksModule<br/>(MemoryBanksService,<br/>MemoryBanksController)"]
    MemoryBanksModule --> DbModule

    OAuthModule["OAuthModule<br/>(OAuthService,<br/>OAuthController)"]
    OAuthModule --> DbModule
    OAuthModule --> CryptoModule

    AnalyticsModule["AnalyticsModule<br/>(PostHog)"]
    SettingsModule["SettingsModule<br/>(SettingsService)"]
    PluginsModule["PluginsModule"]
```

### 2.2 Key Service Classes

#### MemoryService
```
search(query, userId, options) → RankedResult[]
  ├── parseNLQ(query) → temporal filters, entities, intent
  ├── embedQuery(query) → float[]
  ├── resolveUserAccounts(userId) → accountIds[]
  ├── typesenseHybridSearch(text, vector, filters) → raw hits
  ├── applyWeightedRanking(hits) → scored results
  ├── decryptResults(results, userId) → plaintext
  └── buildFacets(hits) → connector/source/factuality/people counts
```

#### CryptoService
```
encrypt(plaintext, key) → { ciphertext, iv, tag }     // AES-256-GCM
decrypt(ciphertext, iv, tag, key) → plaintext
deriveKey(recoveryKey) → Buffer                         // SHA-256
hashRecoveryKey(key) → string                           // SHA-256 hex
```

#### UserKeyService
```
getKey(userId) → Buffer
  ├── checkMemoryCache(userId) → key?
  ├── checkRedisCache(userId) → key? (decrypt w/ APP_SECRET)
  └── throw NeedsRecoveryKeyError
cacheKey(userId, key) → void
  ├── memoryCache.set(userId, key)
  └── redis.set(`dek:${userId}`, encrypt(key, APP_SECRET), 30d)
```

#### ConnectorsService
```
getRegistry() → ConnectorRegistry
  ├── loadBuiltinConnectors()
  └── loadPluginConnectors(PLUGINS_DIR)
getConnector(type) → BaseConnector instance
```

---

## 3. Processing Pipeline — Detailed

### 3.1 Sync Processor

```mermaid
flowchart TD
    Start["Job received<br/>(accountId)"] --> LoadAcct["Load Account<br/>+ decrypt auth"]
    LoadAcct --> GetConn["Get Connector<br/>from Registry"]
    GetConn --> ValidAuth{"Auth valid?"}
    ValidAuth -->|No| Fail["Job FAILED<br/>(auth expired)"]
    ValidAuth -->|Yes| Sync["connector.sync(ctx)"]

    Sync --> DataEvent{"On 'data' event"}
    DataEvent --> StoreRaw["Insert rawEvents<br/>(encrypted payload)"]
    StoreRaw --> EnqClean["Enqueue clean job<br/>(rawEventId)"]
    EnqClean --> DataEvent

    Sync --> ProgressEvent{"On 'progress' event"}
    ProgressEvent --> UpdateJob["Update job progress<br/>+ WS broadcast"]
    UpdateJob --> ProgressEvent

    Sync --> Done["Sync complete"]
    Done --> UpdateCursor["Update account<br/>sync_cursor"]
    UpdateCursor --> JobDone["Job DONE"]
```

### 3.2 Clean Processor

```mermaid
flowchart TD
    Start["Job received<br/>(rawEventId)"] --> Load["Load raw event<br/>+ decrypt payload"]
    Load --> Parse["Parse connector<br/>payload format"]
    Parse --> Normalize["Normalize text<br/>(strip HTML, clean<br/>whitespace, etc.)"]
    Normalize --> Tokens["Generate<br/>search_tokens"]
    Tokens --> EnqEmbed["Enqueue embed job<br/>(rawEventId, cleanText)"]
```

### 3.3 Embed Processor

```mermaid
flowchart TD
    Start["Job received<br/>(rawEventId)"] --> Load["Load raw event<br/>+ decrypt"]
    Load --> Parse["Parse payload →<br/>text, metadata,<br/>event_time, source"]
    Parse --> CreateMem["INSERT memory<br/>(encrypted text,<br/>metadata, entities)"]
    CreateMem --> Embed["Generate embedding<br/>(Ollama/OpenRouter/<br/>Gemini)"]
    Embed --> StoreMem["UPDATE memory<br/>with embedding"]
    StoreMem --> ResolvePeople["Resolve participants<br/>→ People records"]
    ResolvePeople --> LinkPeople["Create memoryPeople<br/>associations"]
    LinkPeople --> EnqEnrich["Enqueue enrich job<br/>(memoryId)"]
```

### 3.4 Enrich Processor

```mermaid
flowchart TD
    Start["Job received<br/>(memoryId)"] --> Load["Load memory<br/>+ decrypt text"]
    Load --> Entities["Extract entities<br/>(LLM prompt)"]
    Entities --> Claims["Extract claims<br/>(LLM prompt)"]
    Claims --> Factuality["Classify factuality<br/>(FACT / UNVERIFIED /<br/>FICTION + confidence)"]
    Factuality --> Importance["Compute importance<br/>baseline score"]
    Importance --> UpdateMem["UPDATE memory<br/>(entities, claims,<br/>factuality, importance)"]
    UpdateMem --> Upsert["Upsert document →<br/>Typesense collection"]
    Upsert --> Done["Job DONE<br/>+ WS broadcast"]
```

---

## 4. Search System — Detailed

### 4.1 Typesense Collection Schema

```
Collection: memories
├── id (string)
├── text (string, BM25-indexed)
├── connector_type (string, facet)
├── source_type (string, facet)
├── account_id (string, filter)
├── memory_bank_id (string, filter)
├── event_time (int64, sort/filter)
├── factuality_label (string, facet)
├── people (string[], facet, filter)
├── entities_text (string, BM25-indexed)
├── importance (float, sort)
├── pinned (bool, filter)
└── embedding (float[], cosine, num_dim=auto)
```

### 4.2 Search Ranking Formula

```
final_score = 0.40 × semantic
            + 0.25 × recency
            + 0.20 × importance
            + 0.15 × trust

where:
  semantic   = Typesense vector similarity (or hybrid rank_fusion_score)
  recency    = exp(-0.005 × age_in_days)  // search; decay processor uses -0.015
  importance = memory.importance (boosted by recall, pinning, direct mention)
  trust      = connector_base_trust × factuality_confidence
```

### 4.3 NLQ Parser

```mermaid
flowchart LR
    Input["Raw query string"] --> Temporal["Extract temporal<br/>references<br/>(yesterday, last week,<br/>March 2024, etc.)"]
    Temporal --> Entities["Extract entity<br/>mentions<br/>(person names,<br/>email addresses)"]
    Entities --> Intent["Classify intent<br/>(search, timeline,<br/>people lookup)"]
    Intent --> Output["Structured query:<br/>text, dateRange,<br/>entities, intent"]
```

---

## 5. Authentication & Encryption

### 5.1 Recovery Key System

```mermaid
flowchart TD
    Signup["User signs up"] --> GenKey["Generate 32-byte<br/>random key"]
    GenKey --> HashKey["SHA-256 hash →<br/>users.recovery_key_hash"]
    HashKey --> CacheKey["Cache in memory +<br/>Redis (encrypted w/<br/>APP_SECRET, 30d TTL)"]
    CacheKey --> ShowKey["Display base64 key<br/>to user (once only)"]

    Login["User logs in"] --> CheckCache{"Key in cache?"}
    CheckCache -->|Yes| Proceed["Decrypt data<br/>normally"]
    CheckCache -->|No| PromptKey["Prompt for<br/>recovery key"]
    PromptKey --> Verify["Verify SHA-256<br/>hash matches"]
    Verify --> CacheKey2["Re-cache key"] --> Proceed
```

### 5.2 Data Encryption Flow

```mermaid
flowchart LR
    Plain["Plaintext data"] --> GetKey["UserKeyService<br/>.getKey(userId)"]
    GetKey --> Encrypt["AES-256-GCM<br/>encrypt(data, key)"]
    Encrypt --> Store["Store: ciphertext +<br/>IV + auth tag"]

    Read["Read request"] --> GetKey2["UserKeyService<br/>.getKey(userId)"]
    GetKey2 --> Decrypt["AES-256-GCM<br/>decrypt(cipher, key)"]
    Decrypt --> Return["Return plaintext"]
```

---

## 6. Connector System

### 6.1 Class Hierarchy

```mermaid
classDiagram
    class BaseConnector {
        <<abstract>>
        +manifest: ConnectorManifest
        +initiateAuth(config): AuthResult
        +completeAuth(params): Credentials
        +validateAuth(auth): boolean
        +revokeAuth(auth): void
        +sync(ctx: SyncContext): void
        +emitData(event: ConnectorDataEvent): void
        #emit("data" | "progress" | "log")
        +DEBUG_SYNC_LIMIT: number
    }

    class ConnectorManifest {
        +id: string
        +name: string
        +description: string
        +icon: string
        +authType: "oauth2" | "qr-code" | "api-key" | "local-tool"
        +configSchema: JSONSchema
        +capabilities: string[]
    }

    class SyncContext {
        +account: Account
        +cursor: string?
        +logger: ConnectorLogger
        +signal: AbortSignal
    }

    class ConnectorDataEvent {
        +sourceType: string
        +sourceId: string
        +eventTime: string
        +payload: object
    }

    class GmailConnector {
        +manifest: ConnectorManifest
        +sync(ctx): void
    }
    class SlackConnector {
        +manifest: ConnectorManifest
        +sync(ctx): void
    }
    class WhatsAppConnector {
        +manifest: ConnectorManifest
        +sync(ctx): void
    }
    class IMessageConnector
    class PhotosImmichConnector
    class TelegramConnector
    class LocationsConnector

    BaseConnector <|-- GmailConnector
    BaseConnector <|-- SlackConnector
    BaseConnector <|-- WhatsAppConnector
    BaseConnector <|-- IMessageConnector
    BaseConnector <|-- PhotosImmichConnector
    BaseConnector <|-- TelegramConnector
    BaseConnector <|-- LocationsConnector
    BaseConnector --> ConnectorManifest
    BaseConnector --> SyncContext
    BaseConnector --> ConnectorDataEvent
```

### 6.2 Connector Registry

```mermaid
flowchart TD
    Boot["App bootstrap"] --> Load["ConnectorRegistry<br/>.loadAll()"]
    Load --> Builtin["Scan packages/connectors/*<br/>Read package.json<br/>botmem.connector field"]
    Builtin --> Plugins["Scan PLUGINS_DIR<br/>for external plugins"]
    Plugins --> Register["Register each:<br/>type → ConnectorClass"]

    Request["getConnector(type)"] --> Lookup["registry.get(type)"]
    Lookup --> Instance["new ConnectorClass()"]
    Instance --> Return["Return connector<br/>instance"]
```

---

## 7. Frontend Architecture

### 7.1 Component Tree

```mermaid
graph TB
    App["App (Router)"]
    App --> Layout["RootLayout"]

    Layout --> Dashboard["DashboardPage"]
    Layout --> Connectors["ConnectorsPage"]
    Layout --> Contacts["ContactsPage"]
    Layout --> Settings["SettingsPage"]

    Dashboard --> SearchBar["SearchInput"]
    Dashboard --> TabSwitch["Graph | Timeline"]
    TabSwitch --> GraphView["ForceGraph2D<br/>(react-force-graph)"]
    TabSwitch --> Timeline["TimelineView"]
    Dashboard --> Facets["FacetFilters"]

    Connectors --> ConnList["ConnectorList"]
    ConnList --> SetupModal["ConnectorSetupModal"]
    ConnList --> OAuthRedirect["OAuthCallback"]
    ConnList --> QRAuth["QRAuthModal"]
    ConnList --> SyncProgress["SyncProgressCard"]

    Contacts --> ContactList["ContactList"]
    Contacts --> MergeUI["MergeContactsDialog"]
```

### 7.2 Zustand Store Architecture

```mermaid
graph LR
    subgraph "Stores"
        AuthStore["authStore<br/>user, token, isAuth,<br/>login(), signup(),<br/>logout()"]
        MemoryStore["memoryStore<br/>results, facets, graph,<br/>search(), loadGraph()"]
        ConnectorStore["connectorStore<br/>accounts, manifests,<br/>sync(), connect()"]
        ContactStore["contactStore<br/>contacts, identifiers,<br/>merge(), search()"]
        JobStore["jobStore<br/>jobs, logs,<br/>subscribe()"]
        MemBankStore["memoryBankStore<br/>banks, create(),<br/>update(), delete()"]
        ThemeStore["themeStore<br/>mode: dark|light"]
        TourStore["tourStore<br/>step, completed"]
    end

    subgraph "API Client"
        Fetch["api.ts<br/>(fetch wrapper,<br/>auth headers,<br/>base URL)"]
    end

    AuthStore & MemoryStore & ConnectorStore & ContactStore & JobStore & MemBankStore --> Fetch
```

---

## 8. WebSocket Events

### 8.1 Event Flow

```mermaid
sequenceDiagram
    participant Client as Web Client
    participant GW as EventsGateway
    participant ES as EventsService
    participant Proc as Processor

    Client->>GW: WS connect (/events)
    GW->>GW: Authenticate (JWT/Firebase)
    GW->>Client: connection:established

    Proc->>ES: emitToChannel("jobs", "progress", data)
    ES->>GW: EventEmitter emit
    GW->>Client: { event: "job:progress", data }

    Proc->>ES: emitDebounced("mem:123", "memory", "processed", getter)
    Note over ES: Debounce 500ms
    ES->>GW: EventEmitter emit
    GW->>Client: { event: "memory:processed", data }
```

### 8.2 Event Types

| Channel | Event | Payload | Source |
|---------|-------|---------|--------|
| `jobs` | `job:progress` | `{ jobId, progress, total }` | SyncProcessor |
| `jobs` | `job:status` | `{ jobId, status, error? }` | JobsService |
| `memory` | `memory:processed` | `{ memoryId, accountId }` | EmbedProcessor |
| `memory` | `memory:enriched` | `{ memoryId, entities, claims }` | EnrichProcessor |
| `connectors` | `phone-auth:code` | `{ qrCode, accountId }` | WhatsAppConnector |
| `connectors` | `phone-auth:2fa` | `{ accountId }` | WhatsAppConnector |

---

## 9. AI Service Layer

### 9.1 Backend Abstraction

```mermaid
classDiagram
    class OllamaService {
        +embed(text: string): float[]
        +embedBatch(texts: string[]): float[][]
        +generate(prompt: string, model?: string): string
        +generateVL(prompt: string, imageB64: string): string
        -getBackend(): "ollama" | "openrouter" | "gemini"
        -callOllama(endpoint, body): Response
        -callOpenRouter(endpoint, body): Response
        -callGemini(endpoint, body): Response
        -checkCache(hash): string?
        -setCache(hash, result): void
    }

    class ConfigService {
        +aiBackend: string
        +embedBackend: string
        +ollamaBaseUrl: string
        +ollamaEmbedModel: string
        +ollamaTextModel: string
        +ollamaVlModel: string
        +openrouterApiKey: string
        +openrouterEmbedModel: string
        +geminiApiKey: string
        +geminiEmbedModel: string
        +embedDimension: number
    }

    OllamaService --> ConfigService
```

### 9.2 Embedding Flow

```mermaid
flowchart TD
    Input["Text input"] --> Hash["SHA-256 hash<br/>(model + backend + text)"]
    Hash --> CacheCheck{"LLM cache<br/>hit?"}
    CacheCheck -->|Yes| Return["Return cached<br/>embedding"]
    CacheCheck -->|No| Backend{"Which backend?"}

    Backend -->|ollama| OllamaCall["POST /api/embed<br/>mxbai-embed-large<br/>(1024d)"]
    Backend -->|openrouter| ORCall["POST /api/v1/embeddings<br/>gemini-embedding-001<br/>(3072d)"]
    Backend -->|gemini| GeminiCall["POST /v1beta/models/<br/>gemini-embedding-2-preview<br/>(3072d)"]

    OllamaCall & ORCall & GeminiCall --> Normalize["Normalize vector"]
    Normalize --> Cache["Store in llmCache"]
    Cache --> Return
```

---

## 10. Job Queue Configuration

### 10.1 BullMQ Queue Settings

| Queue | Concurrency | Lock Duration | Max Attempts | Backoff |
|-------|-------------|---------------|--------------|---------|
| `sync` | 1 | 300s | 3 | Exponential (5s base) |
| `clean` | 5 | 300s | 3 | Exponential (5s base) |
| `embed` | 3 (configurable) | 300s | 3 | Exponential (5s base) |
| `enrich` | 3 (configurable) | 300s | 3 | Exponential (5s base) |

### 10.2 Job State Machine

```mermaid
stateDiagram-v2
    [*] --> queued : Job created
    queued --> running : Worker picks up
    running --> done : Success
    running --> failed : Error (retries exhausted)
    running --> queued : Error (retry available)
    queued --> cancelled : Manual cancel
    running --> cancelled : Manual cancel
    done --> [*]
    failed --> [*]
    cancelled --> [*]
```

---

## 11. API Endpoints

### 11.1 REST API Routes

| Method | Path | Controller | Auth | Purpose |
|--------|------|------------|------|---------|
| `POST` | `/api/user-auth/signup` | UserAuthController | None | Register user |
| `POST` | `/api/user-auth/login` | UserAuthController | None | Login (JWT) |
| `POST` | `/api/user-auth/firebase-login` | UserAuthController | Firebase | Firebase SSO |
| `POST` | `/api/user-auth/recovery-key` | UserAuthController | Auth | Submit recovery key |
| `GET` | `/api/accounts` | AccountsController | Auth | List accounts |
| `POST` | `/api/accounts` | AccountsController | Auth | Create account |
| `DELETE` | `/api/accounts/:id` | AccountsController | Auth | Delete account |
| `GET` | `/api/connectors` | ConnectorsController | Auth | List available connectors |
| `GET` | `/api/connectors/:type/manifest` | ConnectorsController | Auth | Get connector manifest |
| `POST` | `/api/auth/:type/initiate` | AuthController | Auth | Start OAuth/QR flow |
| `GET` | `/api/auth/:type/callback` | AuthController | None | OAuth callback |
| `POST` | `/api/jobs/sync/:accountId` | JobsController | Auth | Trigger sync |
| `GET` | `/api/jobs` | JobsController | Auth | List jobs |
| `GET` | `/api/jobs/:id` | JobsController | Auth | Get job detail |
| `GET` | `/api/jobs/:id/logs` | JobsController | Auth | Get job logs |
| `GET` | `/api/memory/search` | MemoryController | Auth | Search memories |
| `GET` | `/api/memory/:id` | MemoryController | Auth | Get single memory |
| `GET` | `/api/memory/graph` | MemoryController | Auth | Get memory graph |
| `GET` | `/api/memory/timeline` | MemoryController | Auth | Timeline view |
| `GET` | `/api/people` | PeopleController | Auth | List contacts |
| `POST` | `/api/people/merge` | PeopleController | Auth | Merge contacts |
| `GET` | `/api/memory-banks` | MemoryBanksController | Auth | List memory banks |
| `POST` | `/api/memory-banks` | MemoryBanksController | Auth | Create bank |
| `GET` | `/api/settings` | SettingsController | Auth | Get settings |
| `PUT` | `/api/settings` | SettingsController | Auth | Update settings |
| `GET` | `/api/version` | AppController | None | Health check |
| `WS` | `/events` | EventsGateway | Auth | Real-time events |

---

## 12. Error Handling

### 12.1 Error Hierarchy

```mermaid
classDiagram
    class BotmemError {
        +code: string
        +message: string
        +statusCode: number
    }

    class AuthError {
        +code: "AUTH_FAILED"
        +statusCode: 401
    }

    class NeedsRecoveryKeyError {
        +code: "NEEDS_RECOVERY_KEY"
        +statusCode: 403
    }

    class ConnectorError {
        +connectorType: string
        +code: "CONNECTOR_ERROR"
    }

    class EncryptionError {
        +code: "ENCRYPTION_ERROR"
    }

    BotmemError <|-- AuthError
    BotmemError <|-- NeedsRecoveryKeyError
    BotmemError <|-- ConnectorError
    BotmemError <|-- EncryptionError
```

---

## 13. Deployment Architecture

### 13.1 Docker Compose Stack

```mermaid
graph TB
    subgraph "Docker Compose (Production)"
        Caddy["caddy:latest<br/>:80, :443<br/>Reverse proxy + Auto-TLS"]
        API["botmem-api<br/>:12412<br/>NestJS app"]
        PG["postgres:16<br/>:5432<br/>Primary datastore"]
        Redis["redis:7-alpine<br/>:6379<br/>Queue + key cache<br/>(AOF persistence)"]
        TS["typesense/typesense<br/>:8108<br/>Search engine"]
    end

    Internet["Internet<br/>(botmem.xyz)"] -->|"HTTPS :443"| Caddy
    Caddy -->|"proxy :12412"| API
    API -->|"TCP :5432"| PG
    API -->|"TCP :6379"| Redis
    API -->|"HTTP :8108"| TS

    subgraph "Volumes"
        PGData["pg_data"]
        RedisData["redis_data"]
        TSData["typesense_data"]
    end

    PG --> PGData
    Redis --> RedisData
    TS --> TSData
```

### 13.2 CI/CD Pipeline

```mermaid
flowchart LR
    Push["git push main"] --> QualityGate["Quality Gate<br/>(lint + test)"]
    QualityGate --> Tag["Determine version<br/>tag from git"]
    Tag --> Build["Docker build<br/>+ push to GHCR"]
    Build --> Deploy["SSH deploy<br/>(update compose,<br/>pull, restart)"]
    Deploy --> Health["Health check<br/>GET /api/version"]
    Health --> Release["GitHub Release"]
    Release --> NPM["npm publish<br/>(CLI package)"]
```
