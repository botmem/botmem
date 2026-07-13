//! C ABI surface consumed by the Swift host (see `include/botmem_engine.h`).
//!
//! Contract:
//!   - One engine instance per process. `start` is idempotent in the sense that
//!     starting while already running first stops the previous instance.
//!   - Every entry point is wrapped in `catch_unwind` so a Rust panic NEVER
//!     crosses the C boundary (that would be UB in the Swift host).
//!   - Returned `char*` strings are heap-allocated by Rust and MUST be freed by
//!     the caller via `botmem_engine_free_string`.

use crate::config::EngineConfig;
use crate::engine::Engine;
use once_cell::sync::Lazy;
use std::ffi::{c_char, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::sync::Mutex;

/// Result codes returned across the FFI.
pub const BOTMEM_OK: i32 = 0;
pub const BOTMEM_ERR_PANIC: i32 = -1;
pub const BOTMEM_ERR_BAD_ARG: i32 = -2;
pub const BOTMEM_ERR_CONFIG: i32 = -3;
pub const BOTMEM_ERR_ALREADY_STOPPED: i32 = -4;
pub const BOTMEM_ERR_START: i32 = -5;

/// The single process-wide engine instance.
static ENGINE: Lazy<Mutex<Option<Engine>>> = Lazy::new(|| Mutex::new(None));

/// Start the engine with a JSON config string. Returns `BOTMEM_OK` on success.
///
/// # Safety
/// `config_json` must be a valid, NUL-terminated C string (or null).
#[no_mangle]
pub unsafe extern "C" fn botmem_engine_start(config_json: *const c_char) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        if config_json.is_null() {
            return BOTMEM_ERR_BAD_ARG;
        }
        let json = match CStr::from_ptr(config_json).to_str() {
            Ok(s) => s,
            Err(_) => return BOTMEM_ERR_BAD_ARG,
        };
        let config = match EngineConfig::from_json(json) {
            Ok(c) => c,
            Err(e) => {
                crate::logging::init();
                tracing::error!(error = %e, "rejecting engine config");
                return BOTMEM_ERR_CONFIG;
            }
        };

        let mut guard = lock_engine();
        // Replace any existing instance (stop the old one first).
        if let Some(existing) = guard.take() {
            existing.stop();
        }
        match Engine::start(config) {
            Ok(engine) => {
                *guard = Some(engine);
                BOTMEM_OK
            }
            Err(e) => {
                tracing::error!(error = %e, "engine failed to start");
                BOTMEM_ERR_START
            }
        }
    }))
    .unwrap_or(BOTMEM_ERR_PANIC)
}

/// Stop the engine if running. Idempotent — returns `BOTMEM_ERR_ALREADY_STOPPED`
/// if there was nothing to stop (not a hard error).
#[no_mangle]
pub extern "C" fn botmem_engine_stop() -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let taken = lock_engine().take();
        match taken {
            Some(engine) => {
                engine.stop();
                BOTMEM_OK
            }
            None => BOTMEM_ERR_ALREADY_STOPPED,
        }
    }))
    .unwrap_or(BOTMEM_ERR_PANIC)
}

/// Return the current status snapshot as a JSON string (caller frees via
/// `botmem_engine_free_string`). Returns null if no engine is running or on
/// panic.
#[no_mangle]
pub extern "C" fn botmem_engine_status_json() -> *mut c_char {
    catch_unwind(AssertUnwindSafe(|| {
        let guard = lock_engine();
        match guard.as_ref() {
            Some(engine) => to_c_string(engine.status().snapshot_json()),
            None => ptr::null_mut(),
        }
    }))
    .unwrap_or(ptr::null_mut())
}

/// Free a string previously returned by this library.
///
/// # Safety
/// `s` must be a pointer returned by `botmem_engine_status_json` (or null).
#[no_mangle]
pub unsafe extern "C" fn botmem_engine_free_string(s: *mut c_char) {
    if s.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| {
        drop(CString::from_raw(s));
    }));
}

// ── helpers ────────────────────────────────────────────────────────────────

fn lock_engine() -> std::sync::MutexGuard<'static, Option<Engine>> {
    ENGINE.lock().unwrap_or_else(|e| e.into_inner())
}

fn to_c_string(s: String) -> *mut c_char {
    match CString::new(s) {
        Ok(c) => c.into_raw(),
        Err(_) => ptr::null_mut(), // interior NUL — shouldn't happen for JSON
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    fn cfg_json() -> CString {
        let dir = std::env::temp_dir().join(format!("botmem-ffi-{}", std::process::id()));
        let status = dir.join("bridge-status.json");
        let json = serde_json::json!({
            "token": "apple_bt_ffitest",
            "server": "wss://api.botmem.xyz/apple-tunnel",
            "status_path": status.to_string_lossy(),
            "data_dir": dir.to_string_lossy(),
        });
        CString::new(json.to_string()).unwrap()
    }

    // One serial test: the FFI entry points share a process-global ENGINE
    // singleton, so splitting these into separate #[test]s would race under
    // cargo's parallel runner.
    #[test]
    fn ffi_lifecycle_and_arg_validation() {
        // null / bad config never start an engine
        assert_eq!(
            unsafe { botmem_engine_start(ptr::null()) },
            BOTMEM_ERR_BAD_ARG
        );
        let bad = CString::new(r#"{"token":"","server":"wss://x/y"}"#).unwrap();
        assert_eq!(
            unsafe { botmem_engine_start(bad.as_ptr()) },
            BOTMEM_ERR_CONFIG
        );

        // ensure a clean baseline, then start
        botmem_engine_stop();
        assert!(botmem_engine_status_json().is_null());

        let c = cfg_json();
        assert_eq!(unsafe { botmem_engine_start(c.as_ptr()) }, BOTMEM_OK);

        let ptr = botmem_engine_status_json();
        assert!(!ptr.is_null());
        let json = unsafe { CStr::from_ptr(ptr).to_str().unwrap().to_string() };
        unsafe { botmem_engine_free_string(ptr) };
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["schema"], 1);

        assert_eq!(botmem_engine_stop(), BOTMEM_OK);
        // Second stop is a no-op signal, not a hard error.
        assert_eq!(botmem_engine_stop(), BOTMEM_ERR_ALREADY_STOPPED);
        assert!(botmem_engine_status_json().is_null());
    }
}
