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
  - icon: "🧠"
    title: Personal Memory
    details: Ingest emails, messages, photos, and locations into a unified memory store. Everything you have said, received, or experienced — searchable and structured.
  - icon: "🔍"
    title: Semantic Search
    details: Vector embeddings power natural-language queries across all your data. Ask "what did John say about the project deadline?" and get ranked, scored results.
  - icon: "🔌"
    title: Multi-Source
    details: Gmail, Slack, WhatsApp, iMessage, Immich photos, OwnTracks locations — and a plugin SDK to build your own connectors.
  - icon: "🤖"
    title: Agent-Ready
    details: Expose your memory to AI agents via MCP (Model Context Protocol). Claude, GPT, and any MCP-compatible agent can query your personal knowledge base.
  - icon: "🏠"
    title: Self-Hosted
    details: Runs entirely on your hardware. SQLite + Qdrant + Redis. No cloud dependencies, no data leaves your network.
  - icon: "🧩"
    title: Extensible
    details: Build custom connectors with the Connector SDK. Add new data sources in under 200 lines of TypeScript.
---

<style>
.vp-doc h2 {
  margin-top: 48px;
}
</style>

## Quick Start

Get Botmem running in under two minutes:

```bash
# Clone the repository
git clone https://github.com/botmem/botmem.git
cd botmem

# Start infrastructure (Redis + Qdrant)
docker compose up -d

# Install dependencies
pnpm install

# Start the development servers
pnpm dev
```

The API serves on `http://localhost:3001` and the web UI on `http://localhost:5173`.

Connect your first data source from the web UI, or jump straight to the [Agent API](/agent-api/) to give your AI agents access to your personal memory.
