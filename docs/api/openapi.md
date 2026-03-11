# OpenAPI Schema

The full OpenAPI 3.0 specification is auto-generated from the API source code.

- **Swagger UI**: [/api/docs](/api/docs) — interactive API explorer
- **OpenAPI JSON**: [/api/docs/json](/api/docs/json) — machine-readable spec
- **Production**: [https://botmem.xyz/api/docs](https://botmem.xyz/api/docs)

## Auto-Generated Types

TypeScript types are generated from the OpenAPI schema:

```bash
pnpm generate:api-types
```

This outputs `packages/shared/src/types/api.generated.ts`, importable as:

```ts
import type { paths, components } from '@botmem/shared/types/api.generated';
```
