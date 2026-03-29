# Botmem — High-Level Design (HLD)

## 1. System Overview

Botmem is a **local-first personal memory RAG system** that ingests events from multiple data sources (emails, messages, photos, locations), normalizes them into a unified memory schema, and provides cross-modal retrieval with weighted ranking.

```mermaid
graph TB
    subgraph "Data Sources"
        Gmail["Gmail<br/>(OAuth2)"]
        Slack["Slack<br/>(OAuth2/Token)"]
        WA["WhatsApp<br/>(QR Auth)"]
        iMsg["iMessage<br/>(Local)"]
        Photos["Photos/Immich<br/>(Local)"]
        Telegram["Telegram<br/>(API Key)"]
        Locations["OwnTracks<br/>(HTTP)"]
    end

    subgraph "Ingestion Layer"
        ConnRegistry["Connector Registry"]
        SyncProc["Sync Processor"]
        RawEvents["Raw Events Store"]
    end

    subgraph "Processing Pipeline"
        CleanProc["Clean Processor"]
        EmbedProc["Embed Processor"]
        EnrichProc["Enrich Processor"]
    end

    subgraph "Storage Layer"
        PG["PostgreSQL<br/>(Drizzle ORM)"]
        Redis["Redis<br/>(BullMQ + Cache)"]
        TS["Typesense<br/>(Hybrid Search)"]
    end

    subgraph "AI Services"
        Ollama["Ollama<br/>(Local)"]
        OpenRouter["OpenRouter<br/>(Cloud)"]
        Gemini["Gemini<br/>(Embeddings)"]
    end

    subgraph "API Layer"
        NestJS["NestJS 11<br/>REST + WebSocket"]
        AuthGuard["Firebase Auth<br/>+ Recovery Key"]
    end

    subgraph "Clients"
        WebApp["React 19 SPA"]
        CLI["botmem CLI"]
        Agents["AI Agents<br/>(OpenClaw, etc.)"]
    end

    Gmail & Slack & WA & iMsg & Photos & Telegram & Locations --> ConnRegistry
    ConnRegistry --> SyncProc
    SyncProc --> RawEvents
    RawEvents --> CleanProc --> EmbedProc --> EnrichProc
    EmbedProc --> PG
    EmbedProc --> Ollama & OpenRouter & Gemini
    EnrichProc --> TS
    EnrichProc --> PG
    SyncProc --> Redis
    NestJS --> PG & Redis & TS
    AuthGuard --> NestJS
    WebApp & CLI & Agents --> NestJS
```

---

## 2. Architecture Style

| Aspect         | Choice                                 | Rationale                                                               |
| -------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| **Pattern**    | Modular monolith (NestJS modules)      | Single deployable, clear module boundaries, future-ready for extraction |
| **Data flow**  | Event-driven pipeline (BullMQ)         | Decoupled stages, retry semantics, backpressure handling                |
| **Search**     | Hybrid RAG (BM25 + vector)             | Best-of-both-worlds: keyword precision + semantic recall                |
| **Auth**       | Firebase Auth + client-side encryption | Zero-knowledge encryption, portable identity                            |
| **Deployment** | Docker Compose on VPS                  | Self-hosted, privacy-first, single-machine simplicity                   |

---

## 3. Key Design Decisions

### 3.1 Store Everything, Label Confidence

Memories are never deleted. Each carries a factuality label (`FACT`, `UNVERIFIED`, `FICTION`) with confidence scores. The ranking formula weights trust and factuality into results.

### 3.2 Connector-Agnostic Pipeline

All connectors emit `ConnectorDataEvent` objects. The pipeline doesn't know or care about the source — it normalizes everything into the same `Memory` schema.

### 3.3 Per-User Encryption (Recovery Key)

- User gets a 32-byte random recovery key at signup (shown once)
- All PII data encrypted with AES-256-GCM using a key derived from recovery key
- Server never stores the plaintext key — only SHA-256 hash for verification
- Key cached in memory + Redis (30-day TTL) for session performance

### 3.4 Swappable AI Backend

Three AI backends (Ollama, OpenRouter, Gemini) behind a unified interface. Switching is a single env var change. LLM responses cached by SHA-256 hash to avoid redundant API calls.

---

## 4. Component Architecture

```mermaid
graph LR
    subgraph "apps/api (NestJS 11)"
        direction TB
        ConfigMod["Config Module"]
        DbMod["DB Module<br/>(Drizzle + PG)"]
        AuthMod["Auth Module<br/>(Firebase/JWT)"]
        CryptoMod["Crypto Module<br/>(AES-256-GCM)"]
        ConnMod["Connectors Module"]
        AcctMod["Accounts Module"]
        JobsMod["Jobs Module"]
        MemMod["Memory Module<br/>(Search + Pipeline)"]
        PeopleMod["People Module"]
        EventsMod["Events Module<br/>(WebSocket)"]
        SettingsMod["Settings Module"]
        AnalyticsMod["Analytics Module<br/>(PostHog)"]
        OAuthMod["OAuth Module"]
        MemBankMod["Memory Banks Module"]
        PluginsMod["Plugins Module"]
    end

    subgraph "apps/web (React 19)"
        direction TB
        Pages["Pages<br/>(18 routes)"]
        Stores["Zustand Stores<br/>(8 stores)"]
        Components["Components<br/>(Connectors, Memory,<br/>Auth, UI)"]
        Hooks["Custom Hooks"]
    end

    subgraph "packages/"
        direction TB
        SDK["connector-sdk<br/>(BaseConnector)"]
        Shared["shared<br/>(Types)"]
        CLIPkg["cli<br/>(botmem)"]
        Connectors["connectors/<br/>(7 connectors)"]
    end
```

---

## 5. Data Flow Overview

### 5.1 Ingestion Pipeline

```mermaid
flowchart LR
    A["Connector.sync()"] -->|"ConnectorDataEvent"| B["Raw Events<br/>(immutable)"]
    B -->|"sync queue"| C["SyncProcessor"]
    C -->|"clean queue"| D["CleanProcessor<br/>(normalize text)"]
    D -->|"embed queue"| E["EmbedProcessor<br/>(Memory + embedding<br/>+ contact resolution)"]
    E -->|"enrich queue"| F["EnrichProcessor<br/>(entities, claims,<br/>factuality, importance)"]
    F --> G["Typesense<br/>(searchable)"]
    E --> H["PostgreSQL<br/>(Memory record)"]
```

### 5.2 Query Pipeline

```mermaid
flowchart LR
    Q["User Query"] --> NLQ["NLQ Parser<br/>(temporal, entities,<br/>intent)"]
    NLQ --> EMB["Embed Query<br/>(AI backend)"]
    EMB --> TS["Typesense<br/>Hybrid Search<br/>(BM25 + vector)"]
    TS --> RANK["Weighted Ranking<br/>(semantic 40%,<br/>recency 25%,<br/>importance 20%,<br/>trust 15%)"]
    RANK --> DEC["Decrypt Results"]
    DEC --> RES["Ranked Results<br/>+ Facets"]
```

---

## 6. Infrastructure

```mermaid
graph TB
    subgraph "Production (VPS — 65.20.85.57)"
        Caddy["Caddy<br/>(Reverse Proxy + SSL)"]
        API["NestJS API<br/>(Docker)"]
        PG["PostgreSQL<br/>(Docker)"]
        Redis["Redis<br/>(Docker, AOF)"]
        TSProd["Typesense<br/>(Docker)"]
    end

    subgraph "CI/CD"
        GH["GitHub Actions"]
        GHCR["GitHub Container<br/>Registry"]
    end

    subgraph "External Services"
        Firebase["Firebase Auth"]
        PostHog["PostHog Analytics"]
    end

    Internet["Internet<br/>(botmem.xyz)"] --> Caddy
    Caddy --> API
    API --> PG & Redis & TSProd
    API --> Firebase & PostHog
    GH -->|"build + push"| GHCR
    GH -->|"SSH deploy"| API
```

---

## 7. Security Architecture

| Layer                  | Mechanism                                                     |
| ---------------------- | ------------------------------------------------------------- |
| **Transport**          | TLS via Caddy auto-SSL                                        |
| **Authentication**     | Firebase Auth (email/password) + JWT tokens                   |
| **Authorization**      | Per-user data isolation (account ownership)                   |
| **Encryption at rest** | AES-256-GCM per-user key (recovery key derived)               |
| **Credential storage** | Encrypted auth context in `accounts` + `connectorCredentials` |
| **Secret management**  | `APP_SECRET` env var for server-side encryption               |
| **Network**            | Tailscale VPN for SSH (public SSH disabled)                   |

---

## 8. Non-Functional Requirements

| Requirement        | Target                       | Implementation                                          |
| ------------------ | ---------------------------- | ------------------------------------------------------- |
| **Privacy**        | Zero-knowledge encryption    | Per-user recovery key, server never sees plaintext key  |
| **Scalability**    | Single-user, multi-connector | BullMQ queues with configurable concurrency             |
| **Reliability**    | Job retry with backoff       | 3 attempts, exponential backoff (5s base), 300s lock    |
| **Search quality** | Hybrid RAG                   | BM25 + vector + weighted scoring                        |
| **Extensibility**  | Plugin connectors            | `BaseConnector` SDK, directory-based loading            |
| **Observability**  | Real-time pipeline status    | WebSocket events, PostHog analytics, structured logging |
