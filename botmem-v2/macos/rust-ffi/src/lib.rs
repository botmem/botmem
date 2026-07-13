use botmem_device_core::sources::{
    IMessageAdapter, SourceAdapter, SourceIndexer, SyncMode, WhatsAppAdapter,
};
use botmem_device_core::{DeviceStore, EngineLock, SourceId};
use rusqlite::{Connection, DatabaseName, OpenFlags};
use serde_json::{json, Value};
use std::ffi::{c_char, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

const FFI_VERSION: &[u8] = b"botmem.device.ffi.v1\0";

#[no_mangle]
pub extern "C" fn botmem_device_ffi_version() -> *const c_char {
    FFI_VERSION.as_ptr().cast()
}

#[no_mangle]
/// Probes the selected protected source using the production read-only adapter.
///
/// # Safety
///
/// `source` must be a non-null pointer to a NUL-terminated UTF-8 string. The
/// returned pointer must be released exactly once with
/// [`botmem_device_string_free`].
pub unsafe extern "C" fn botmem_device_probe(source: *const c_char) -> *mut c_char {
    boundary(|| {
        let source = required_string(source, "source")?;
        let adapter = adapter(&source)?;
        if let Some(unavailable) = protected_database_preflight(adapter.as_ref()) {
            return Ok(unavailable);
        }
        let probe = adapter.probe();
        Ok(json!({
            "source": probe.source.as_str(),
            "readiness": probe.readiness.as_str(),
            "readOnly": probe.read_only,
            "reasonCode": probe.reason_code,
            "schema": probe.schema.map(|schema| json!({
                "family": schema.family,
                "version": schema.version,
                "fingerprint": schema.fingerprint,
            })),
        }))
    })
}

fn protected_database_preflight(adapter: &dyn SourceAdapter) -> Option<Value> {
    let source = adapter.source();
    let path = adapter.database_path();
    match std::fs::File::open(path) {
        Ok(file) => drop(file),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Some(unavailable(source, "not_installed", "source_not_installed"));
        }
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            return Some(unavailable(
                source,
                "permission_required",
                "source_permission_required",
            ));
        }
        Err(_) => return Some(unavailable(source, "error", "source_probe_failed")),
    }

    let connection = match Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(connection) => connection,
        Err(_) => return Some(unavailable(source, "error", "source_database_open_failed")),
    };
    if connection.pragma_update(None, "query_only", true).is_err()
        || !connection.is_readonly(DatabaseName::Main).unwrap_or(false)
    {
        return Some(unavailable(
            source,
            "error",
            "source_read_only_invariant_failed",
        ));
    }
    None
}

fn unavailable(source: SourceId, readiness: &str, reason_code: &str) -> Value {
    json!({
        "source": source.as_str(),
        "readiness": readiness,
        "readOnly": false,
        "reasonCode": reason_code,
        "schema": null,
    })
}

#[no_mangle]
/// Synchronizes the selected source into the device store.
///
/// # Safety
///
/// `source` and `store_root` must be non-null pointers to NUL-terminated UTF-8
/// strings. The returned pointer must be released exactly once with
/// [`botmem_device_string_free`].
pub unsafe extern "C" fn botmem_device_sync(
    source: *const c_char,
    store_root: *const c_char,
    reconcile: bool,
) -> *mut c_char {
    boundary(|| {
        let source = required_string(source, "source")?;
        let root = required_string(store_root, "storeRoot")?;
        let adapter = adapter(&source)?;
        let _lock = EngineLock::try_acquire(Path::new(&root)).map_err(|error| error.to_string())?;
        let mut store = DeviceStore::open(Path::new(&root)).map_err(|error| error.to_string())?;
        let mode = if reconcile {
            SyncMode::Reconcile
        } else {
            SyncMode::Incremental
        };
        let report = SourceIndexer::new(&mut store)
            .run(adapter.as_ref(), mode)
            .map_err(|error| error.to_string())?;
        Ok(json!({
            "source": report.source.as_str(),
            "mode": match report.mode {
                SyncMode::Incremental => "incremental",
                SyncMode::Reconcile => "reconcile",
            },
            "scanned": report.scanned,
            "indexed": report.indexed,
            "schemaFingerprint": report.schema_fingerprint,
        }))
    })
}

#[no_mangle]
/// Releases a response allocated by this FFI library.
///
/// # Safety
///
/// `value` must be null or a pointer returned by this library that has not
/// already been released.
pub unsafe extern "C" fn botmem_device_string_free(value: *mut c_char) {
    if !value.is_null() {
        drop(CString::from_raw(value));
    }
}

fn adapter(source: &str) -> Result<Box<dyn SourceAdapter>, String> {
    match SourceId::try_from(source).map_err(|error| error.to_string())? {
        SourceId::IMessage => Ok(Box::new(IMessageAdapter::default())),
        SourceId::Whatsapp => Ok(Box::new(WhatsAppAdapter::default())),
    }
}

unsafe fn required_string(value: *const c_char, field: &str) -> Result<String, String> {
    if value.is_null() {
        return Err(format!("{field} is required"));
    }
    CStr::from_ptr(value)
        .to_str()
        .map(str::to_owned)
        .map_err(|_| format!("{field} must be UTF-8"))
}

fn boundary(operation: impl FnOnce() -> Result<Value, String>) -> *mut c_char {
    let response = match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(Ok(value)) => json!({"ok": true, "value": value}),
        Ok(Err(message)) => json!({"ok": false, "error": message}),
        Err(_) => json!({"ok": false, "error": "device core panicked"}),
    };
    CString::new(response.to_string())
        .expect("serialized JSON cannot contain NUL")
        .into_raw()
}

#[cfg(test)]
mod tests {
    use super::*;
    use botmem_device_core::sources::{AdapterError, SourceProbe, SourceScan};
    use botmem_device_core::SourceCursor;
    use std::path::{Path, PathBuf};

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    struct FixtureAdapter(PathBuf);

    impl SourceAdapter for FixtureAdapter {
        fn source(&self) -> SourceId {
            SourceId::IMessage
        }

        fn database_path(&self) -> &Path {
            &self.0
        }

        fn probe(&self) -> SourceProbe {
            unreachable!("the preflight test does not invoke schema probing")
        }

        fn scan(&self, _cursor: Option<&SourceCursor>) -> Result<SourceScan, AdapterError> {
            unreachable!("the preflight test does not invoke scanning")
        }
    }

    #[test]
    fn missing_database_is_not_installed() {
        let root = tempfile::tempdir().expect("temporary directory");
        let adapter = FixtureAdapter(root.path().join("missing.sqlite"));

        let result = protected_database_preflight(&adapter).expect("unavailable result");

        assert_eq!(result["readiness"], "not_installed");
    }

    #[test]
    fn readable_database_passes_real_read_only_open() {
        let root = tempfile::tempdir().expect("temporary directory");
        let path = root.path().join("fixture.sqlite");
        Connection::open(&path).expect("create fixture database");
        let adapter = FixtureAdapter(path);

        assert!(protected_database_preflight(&adapter).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_database_requires_permission() {
        let root = tempfile::tempdir().expect("temporary directory");
        let path = root.path().join("fixture.sqlite");
        Connection::open(&path).expect("create fixture database");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000))
            .expect("remove access");
        let adapter = FixtureAdapter(path.clone());

        let result = protected_database_preflight(&adapter).expect("unavailable result");

        assert_eq!(result["readiness"], "permission_required");
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .expect("restore access");
    }
}
