//! Contacts source reader — READ-ONLY over ALL local AddressBook account DBs.
//! Ported from `local-index/sources/contacts.ts`. Each iCloud/Exchange/local
//! account stores its own `AddressBook-v22.abcddb` (top-level + `Sources/<uuid>/`).

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::{open_ro, RecordSink};
use crate::index::IndexRecord;

pub fn default_base() -> PathBuf {
    crate::config::home_dir().join("Library/Application Support/AddressBook")
}

/// Collect every account's AddressBook DB (top-level + `Sources/<uuid>/…`).
fn list_contact_dbs(base: &Path) -> Vec<PathBuf> {
    let mut dbs = Vec::new();
    let top = base.join("AddressBook-v22.abcddb");
    if top.exists() {
        dbs.push(top);
    }
    let src_dir = base.join("Sources");
    if let Ok(entries) = std::fs::read_dir(&src_dir) {
        for e in entries.flatten() {
            let p = e.path().join("AddressBook-v22.abcddb");
            if p.exists() {
                dbs.push(p);
            }
        }
    }
    dbs
}

/// Account tag for a db path: the `Sources/<uuid>` prefix (8 chars) or "default".
fn account_tag(db_path: &Path) -> String {
    let s = db_path.to_string_lossy();
    if let Some(idx) = s.find("/Sources/") {
        let rest = &s[idx + "/Sources/".len()..];
        rest.chars().take(8).collect()
    } else {
        "default".to_string()
    }
}

pub fn detect(base: &Path) -> bool {
    let dbs = if base.extension().map(|e| e == "abcddb").unwrap_or(false) {
        vec![base.to_path_buf()]
    } else {
        list_contact_dbs(base)
    };
    dbs.iter().any(|p| open_ro(p).is_ok())
}

/// Stream contact records into `sink`. `base` may be a directory (enumerate) or
/// a single `.abcddb`. Returns the record count.
pub fn read(base: &Path, sink: RecordSink<'_>) -> Result<usize, rusqlite::Error> {
    let dbs = if base.extension().map(|e| e == "abcddb").unwrap_or(false) {
        vec![base.to_path_buf()]
    } else {
        list_contact_dbs(base)
    };
    let mut count = 0usize;
    for db_path in dbs {
        let conn = match open_ro(&db_path) {
            Ok(c) => c,
            Err(_) => continue, // unreadable account DB — skip
        };
        count += read_conn(&conn, &account_tag(&db_path), sink)?;
    }
    Ok(count)
}

pub(crate) fn read_conn(
    conn: &Connection,
    tag: &str,
    sink: RecordSink<'_>,
) -> Result<usize, rusqlite::Error> {
    let mut stmt = conn.prepare(
        r#"SELECT r.Z_PK AS id, r.ZFIRSTNAME AS first, r.ZLASTNAME AS last, r.ZORGANIZATION AS org
           FROM ZABCDRECORD r
           WHERE r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL OR r.ZORGANIZATION IS NOT NULL"#,
    )?;
    let mut rows = stmt.query([])?;
    let mut count = 0usize;
    while let Some(row) = rows.next()? {
        let id: i64 = row.get("id")?;
        let first: Option<String> = row.get("first")?;
        let last: Option<String> = row.get("last")?;
        let org: Option<String> = row.get("org")?;

        let full: String = [first.as_deref(), last.as_deref()]
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
            .trim()
            .to_string();
        let name = if !full.is_empty() { full } else { org.clone().unwrap_or_default() };
        if name.is_empty() {
            continue;
        }
        let text = match org.as_deref().filter(|o| !o.is_empty()) {
            Some(o) if o != name => format!("{name} — {o}"),
            _ => name.clone(),
        };

        sink(IndexRecord {
            source_id: format!("{tag}:{id}"),
            thread_id: String::new(),
            thread_title: "Contacts".to_string(),
            sender_name: name,
            sender_id: String::new(),
            is_from_me: false,
            ts: 0,
            text,
            media_json: None,
        });
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            r#"
            CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT,
                                      ZLASTNAME TEXT, ZORGANIZATION TEXT);
            INSERT INTO ZABCDRECORD VALUES (1, 'Amr', 'Essam', NULL);
            INSERT INTO ZABCDRECORD VALUES (2, NULL, NULL, 'Parkwoods Realty');
            INSERT INTO ZABCDRECORD VALUES (3, NULL, NULL, NULL); -- skipped (all null)
            "#,
        )
        .unwrap();
        c
    }

    #[test]
    fn reads_names_and_orgs() {
        let c = fixture();
        let mut got = Vec::new();
        let n = read_conn(&c, "icloudAB", &mut |r| got.push(r)).unwrap();
        assert_eq!(n, 2);

        let person = got.iter().find(|r| r.source_id == "icloudAB:1").unwrap();
        assert_eq!(person.sender_name, "Amr Essam");
        assert_eq!(person.text, "Amr Essam");
        assert_eq!(person.thread_title, "Contacts");
        assert_eq!(person.ts, 0);

        let org = got.iter().find(|r| r.source_id == "icloudAB:2").unwrap();
        assert_eq!(org.sender_name, "Parkwoods Realty");
    }
}
