# Contributing to Botmem

Thanks for your interest in contributing to Botmem! This guide covers the essentials. For detailed development docs, see [docs.botmem.xyz/contributing](https://docs.botmem.xyz/contributing/).

## Prerequisites

- Node.js 20+
- pnpm 9.15+ (`corepack enable`)
- Docker (PostgreSQL, Redis, Typesense)
- An AI backend: [Ollama](https://ollama.ai) (local) or an [OpenRouter](https://openrouter.ai) API key

## Setup

```bash
git clone https://github.com/botmem/botmem.git
cd botmem
docker compose up -d
pnpm install
cp .env.example .env    # Edit as needed
pnpm dev                # http://localhost:12412
```

## Development Commands

```bash
pnpm dev          # Start API + web dev servers
pnpm build        # Build all packages
pnpm lint         # Lint everything (ESLint + Prettier)
pnpm typecheck    # TypeScript strict checking
pnpm test         # Run Vitest across all workspaces
```

## Pull Request Process

1. **Fork and branch** — create a feature branch from `main`
2. **Write tests** — add tests in `__tests__/` directories adjacent to source
3. **Follow conventions** — TypeScript strict, ESLint + Prettier (enforced by Husky pre-commit)
4. **Keep PRs focused** — one logical change per PR
5. **Describe your change** — use the PR template, explain the "why"

## Code Style

- TypeScript strict mode, ES2022 target, ESNext modules
- All IDs are UUIDs
- All timestamps are ISO 8601 strings
- Shared types live in `@botmem/shared`
- Tests use Vitest, placed in `__tests__/` directories

## Building a Connector

See the [Connector SDK docs](https://docs.botmem.xyz/contributing/connector-sdk) for the full guide. In short:

1. Create `packages/connectors/<name>/` with its own `package.json`
2. Extend `BaseConnector` from `@botmem/connector-sdk`
3. Implement all abstract methods (`manifest`, `sync`, auth methods)
4. Register in `ConnectorRegistry`

## Reporting Issues

Use [GitHub Issues](https://github.com/botmem/botmem/issues) with the provided templates for bugs and feature requests.

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0 License](LICENSE).
