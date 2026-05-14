# OpenAPI Schema

The full OpenAPI 3.0 specification is auto-generated from the API source code.

- **Swagger UI**: [http://localhost:12412/api/docs](http://localhost:12412/api/docs) — interactive API explorer (available when your Botmem instance is running)
- **OpenAPI JSON**: [http://localhost:12412/api/docs/json](http://localhost:12412/api/docs/json) — machine-readable spec
- **Managed docs**: [https://docs.botmem.xyz/api/openapi](https://docs.botmem.xyz/api/openapi)

## Auto-Generated Types

TypeScript types are generated from the OpenAPI schema:

```bash
pnpm generate:api-types
```

This outputs `packages/shared/src/types/api.generated.ts`, importable as:

```ts
import type { paths, components } from '@botmem/shared/types/api.generated';
```
