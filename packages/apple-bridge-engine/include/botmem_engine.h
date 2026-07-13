/*
 * botmem_engine.h — C ABI for the Botmem Apple Bridge Rust engine.
 *
 * Linked in-process into the Swift menu-bar app (the FDA-granted process).
 * See ARCHITECTURE.md. This header is hand-maintained to match src/ffi.rs;
 * `scripts/gen-header.sh` can regenerate it with cbindgen.
 *
 * Threading: all functions are safe to call from the main thread. The engine
 * runs its own tokio runtime on background threads.
 *
 * Memory: strings returned by botmem_engine_status_json() are owned by the
 * caller and MUST be released with botmem_engine_free_string().
 */
#ifndef BOTMEM_ENGINE_H
#define BOTMEM_ENGINE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Result codes. */
#define BOTMEM_OK                    0
#define BOTMEM_ERR_PANIC            -1
#define BOTMEM_ERR_BAD_ARG          -2
#define BOTMEM_ERR_CONFIG           -3
#define BOTMEM_ERR_ALREADY_STOPPED  -4
#define BOTMEM_ERR_START            -5

/*
 * Start the engine. `config_json` is a NUL-terminated UTF-8 JSON string:
 *   { "token": "apple_bt_…", "server": "wss://api.botmem.xyz/apple-tunnel",
 *     "sources": "contacts,imessages,whatsapp",   // optional
 *     "status_path": "…", "data_dir": "…" }        // optional overrides
 * Starting while already running stops the previous instance first.
 * Returns BOTMEM_OK (0) on success, or a negative BOTMEM_ERR_* code.
 */
int32_t botmem_engine_start(const char *config_json);

/*
 * Stop the engine. Returns BOTMEM_OK if it was running, or
 * BOTMEM_ERR_ALREADY_STOPPED if there was nothing to stop.
 */
int32_t botmem_engine_stop(void);

/*
 * Return the current status snapshot as a heap-allocated JSON string (matching
 * ~/.botmem/bridge-status.json, PROTOCOL.md §6), or NULL if no engine is
 * running. Free with botmem_engine_free_string().
 */
char *botmem_engine_status_json(void);

/* Free a string returned by this library. NULL is ignored. */
void botmem_engine_free_string(char *s);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* BOTMEM_ENGINE_H */
