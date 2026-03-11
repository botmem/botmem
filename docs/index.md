---
layout: home

hero:
  name: Botmem
  text: Personal Memory for AI Agents
  tagline: Your memories. Your agents. Your control.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/quickstart
    - theme: alt
      text: Agent API (MCP)
      link: /agent-api/
    - theme: alt
      text: View on GitHub
      link: https://github.com/botmem/botmem

features:
  - icon: '🧠'
    title: Personal Memory
    details: Ingest emails, messages, photos, and locations into a unified memory store. Everything you have said, received, or experienced — searchable and structured.
  - icon: '🔍'
    title: Semantic Search
    details: Vector embeddings power natural-language queries across all your data. Ask "what did John say about the project deadline?" and get ranked, scored results.
  - icon: '🔌'
    title: Multi-Source
    details: Gmail, Slack, WhatsApp, iMessage, Immich photos, OwnTracks locations — and a plugin SDK to build your own connectors.
  - icon: '🤖'
    title: Agent-Ready
    details: Expose your memory to AI agents via REST API and CLI. Claude, GPT, and any agent can query your personal knowledge base.
  - icon: '🔒'
    title: Encrypted & Private
    details: AES-256-GCM encryption at rest with a personal recovery key. Self-host on your hardware, or use the managed Pro tier — either way, your data stays yours.
  - icon: '🧩'
    title: Extensible
    details: Build custom connectors with the Connector SDK. Add new data sources in under 200 lines of TypeScript.
---

<style>
.vp-doc h2 {
  margin-top: 48px;
}
</style>

## Quick Start

Get Botmem running in under five minutes:

```bash
# Clone the repository
git clone https://github.com/botmem/botmem.git
cd botmem

# Configure environment
cp .env.example .env    # Edit .env — set OLLAMA_BASE_URL to your Ollama host

# Start everything (Botmem + PostgreSQL + Redis + Qdrant)
docker compose up -d
```

The API and web UI serve on `http://localhost:12412`. Sign up, connect your first data source, and start searching.

For development, see the [quickstart guide](/guide/quickstart).

Want someone else to handle the infrastructure? [Botmem Pro](https://botmem.xyz) ($14.99/mo) runs the same open-source code with managed hosting and preconfigured AI.
