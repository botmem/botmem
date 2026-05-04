# Improvements

## Split API and queue workers

The production API currently serves HTTP/WebSocket traffic and processes BullMQ sync/memory jobs in the same Nest process. During large rebuilds, high `memory_concurrency` can make the API slow because hundreds of jobs compete with request handling for Node event-loop time, the PostgreSQL pool, encryption work, and outbound Gemini calls.

Planned improvement:

- Add a dedicated worker service using the same API image for BullMQ processors.
- Keep the public API container focused on HTTP/WebSocket/realtime connector runtime.
- Add an explicit env flag to disable queue workers in API-only containers.
- Tune worker-only concurrency independently from API latency targets.
- Keep `memory_concurrency` conservative on API-facing processes and high only on worker processes.

This would let bulk memory rebuilds saturate Gemini safely without making `botmem.xyz` slow to load.
