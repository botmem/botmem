# Bug: Photo memories show encrypted data in graph detail

## Problem

When clicking a photo memory node in the force-directed graph, the Memory Detail panel shows the raw encrypted/base64 blob text instead of a readable description or the photo itself.

## Screenshot

The node label also shows the encrypted text truncated: `ecrdxdKW/4xTcnsD:BOU...`

## Root cause (likely)

Photo memories store their `text` field as encrypted data. The graph detail panel renders `memory.text` directly without:

1. Decrypting it first
2. Or showing the photo thumbnail / enriched description instead

## Fix needed

- In the graph Memory Detail component, detect `source_type === 'photos'` or `connector_type === 'photos-immich'`
- Show the photo thumbnail (from metadata/fileBase64) instead of the text blob
- Or show the enriched description if available (from entities/claims)
- The node label in the graph should also use a friendlier name (date, location, people detected) instead of truncated encrypted text

## Files to investigate

- `apps/web/src/components/memory/` — graph detail panel
- `apps/web/src/components/dashboard/` — force graph rendering
- `apps/api/src/memory/` — how photo memory text is stored/returned
