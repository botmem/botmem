//! Contacts source reader — READ-ONLY over ALL local AddressBook account DBs.
//! Ported from `local-index/sources/contacts.ts`. Each iCloud/Exchange/local
//! account stores its own `AddressBook-v22.abcddb` (top-level + `Sources/<uuid>/`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;

use super::{open_ro, Cancelled, RecordSink};
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
pub fn read(base: &Path, cancelled: Cancelled<'_>, sink: RecordSink<'_>) -> Result<usize, rusqlite::Error> {
    let dbs = if base.extension().map(|e| e == "abcddb").unwrap_or(false) {
        vec![base.to_path_buf()]
    } else {
        list_contact_dbs(base)
    };
    let mut count = 0usize;
    for db_path in dbs {
        if cancelled() {
            break;
        }
        let conn = match open_ro(&db_path) {
            Ok(c) => c,
            Err(_) => continue, // unreadable account DB — skip
        };
        count += read_conn(&conn, &account_tag(&db_path), cancelled, sink)?;
    }
    Ok(count)
}

pub(crate) fn read_conn(
    conn: &Connection,
    tag: &str,
    cancelled: Cancelled<'_>,
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
        if cancelled() {
            break;
        }
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
        // Match contacts.ts: text = [name, org].filter(Boolean).join(' — ').
        // (For org-only contacts where name==org this duplicates, exactly as the
        // node adapter does — parity over prettiness.)
        let text = [Some(name.as_str()), org.as_deref()]
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" — ");

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

// ── Rich contacts.list (legacy connector-sync RPC) ─────────────────────────
//
// The node bridge sourced this from the Contacts framework (CNContactStore via a
// Swift subprocess). We source the same `AppleContact` shape directly from the
// AddressBook SQLite so it stays in-process. Birthday/image are not read from
// SQLite (left empty/false); the server dedups on durable email/phone anyway.

/// Matches `AppleContact` in apple-client.ts (camelCase JSON).
#[derive(Debug, Serialize)]
pub struct AppleContact {
    pub id: String,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(rename = "givenName", skip_serializing_if = "Option::is_none")]
    pub given_name: Option<String>,
    #[serde(rename = "familyName", skip_serializing_if = "Option::is_none")]
    pub family_name: Option<String>,
    #[serde(rename = "middleName", skip_serializing_if = "Option::is_none")]
    pub middle_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization: Option<String>,
    #[serde(rename = "jobTitle", skip_serializing_if = "Option::is_none")]
    pub job_title: Option<String>,
    pub emails: Vec<String>,
    pub phones: Vec<String>,
    #[serde(rename = "imageAvailable")]
    pub image_available: bool,
}

fn clean(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// List rich contacts across all AddressBook account DBs. `base` may be a dir or
/// a single `.abcddb`.
pub fn list_apple_contacts(
    base: &Path,
    cancelled: Cancelled<'_>,
) -> Result<Vec<AppleContact>, rusqlite::Error> {
    let dbs = if base.extension().map(|e| e == "abcddb").unwrap_or(false) {
        vec![base.to_path_buf()]
    } else {
        list_contact_dbs(base)
    };
    let mut out = Vec::new();
    for db_path in dbs {
        if cancelled() {
            break;
        }
        let conn = match open_ro(&db_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        out.extend(list_contacts_conn(&conn, &account_tag(&db_path))?);
    }
    Ok(out)
}

/// Best-effort `ZOWNER → [value]` map; returns empty on any schema mismatch so a
/// version without these tables/columns degrades gracefully.
fn owner_values(conn: &Connection, sql: &str) -> HashMap<i64, Vec<String>> {
    let mut map: HashMap<i64, Vec<String>> = HashMap::new();
    let Ok(mut stmt) = conn.prepare(sql) else { return map };
    let Ok(rows) = stmt.query_map([], |r| {
        Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<String>>(1)?))
    }) else {
        return map;
    };
    for (owner, value) in rows.flatten() {
        if let (Some(owner), Some(value)) = (owner, clean(value)) {
            map.entry(owner).or_default().push(value);
        }
    }
    map
}

pub(crate) fn list_contacts_conn(
    conn: &Connection,
    tag: &str,
) -> Result<Vec<AppleContact>, rusqlite::Error> {
    let emails = owner_values(conn, "SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS");
    let phones = owner_values(conn, "SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER");

    let mut stmt = conn.prepare(
        r#"SELECT Z_PK AS id, ZFIRSTNAME AS first, ZLASTNAME AS last, ZMIDDLENAME AS middle,
                  ZNICKNAME AS nick, ZORGANIZATION AS org, ZJOBTITLE AS job
           FROM ZABCDRECORD
           WHERE ZFIRSTNAME IS NOT NULL OR ZLASTNAME IS NOT NULL OR ZORGANIZATION IS NOT NULL
              OR ZMIDDLENAME IS NOT NULL OR ZNICKNAME IS NOT NULL"#,
    )?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let pk: i64 = row.get("id")?;
        let given = clean(row.get("first")?);
        let family = clean(row.get("last")?);
        let middle = clean(row.get("middle")?);
        let nickname = clean(row.get("nick")?);
        let organization = clean(row.get("org")?);
        let job_title = clean(row.get("job")?);

        let full = [given.as_deref(), middle.as_deref(), family.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
        let display_name = clean(Some(full))
            .or_else(|| nickname.clone())
            .or_else(|| organization.clone());

        out.push(AppleContact {
            id: format!("{tag}:{pk}"),
            display_name,
            given_name: given,
            family_name: family,
            middle_name: middle,
            nickname,
            organization,
            job_title,
            emails: emails.get(&pk).cloned().unwrap_or_default(),
            phones: phones.get(&pk).cloned().unwrap_or_default(),
            image_available: false,
        });
    }
    Ok(out)
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
        let n = read_conn(&c, "icloudAB", &crate::sources::never_cancelled(), &mut |r| got.push(r)).unwrap();
        assert_eq!(n, 2);

        let person = got.iter().find(|r| r.source_id == "icloudAB:1").unwrap();
        assert_eq!(person.sender_name, "Amr Essam");
        assert_eq!(person.text, "Amr Essam");
        assert_eq!(person.thread_title, "Contacts");
        assert_eq!(person.ts, 0);

        let org = got.iter().find(|r| r.source_id == "icloudAB:2").unwrap();
        assert_eq!(org.sender_name, "Parkwoods Realty");
    }

    fn rich_fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            r#"
            CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT,
                                      ZMIDDLENAME TEXT, ZNICKNAME TEXT, ZORGANIZATION TEXT, ZJOBTITLE TEXT);
            CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT);
            CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT);
            INSERT INTO ZABCDRECORD VALUES (1, 'Amr', 'Essam', NULL, NULL, 'Acme', 'Engineer');
            INSERT INTO ZABCDEMAILADDRESS VALUES (1, 1, '[email protected]');
            INSERT INTO ZABCDEMAILADDRESS VALUES (2, 1, '[email protected]');
            INSERT INTO ZABCDPHONENUMBER VALUES (1, 1, '+15551234567');
            "#,
        )
        .unwrap();
        c
    }

    #[test]
    fn rich_contacts_shape() {
        let c = rich_fixture();
        let contacts = list_contacts_conn(&c, "icloud").unwrap();
        assert_eq!(contacts.len(), 1);
        let p = &contacts[0];
        assert_eq!(p.id, "icloud:1");
        assert_eq!(p.display_name.as_deref(), Some("Amr Essam"));
        assert_eq!(p.given_name.as_deref(), Some("Amr"));
        assert_eq!(p.job_title.as_deref(), Some("Engineer"));
        assert_eq!(p.emails.len(), 2);
        assert!(p.emails.contains(&"[email protected]".to_string()));
        assert_eq!(p.phones, vec!["+15551234567".to_string()]);
        assert!(!p.image_available);
    }

    #[test]
    fn rich_contacts_degrades_without_email_tables() {
        // Schema lacking the email/phone tables must not error — empty arrays.
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            r#"CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT,
                  ZMIDDLENAME TEXT, ZNICKNAME TEXT, ZORGANIZATION TEXT, ZJOBTITLE TEXT);
               INSERT INTO ZABCDRECORD VALUES (5, 'Solo', NULL, NULL, NULL, NULL, NULL);"#,
        )
        .unwrap();
        let contacts = list_contacts_conn(&c, "local").unwrap();
        assert_eq!(contacts.len(), 1);
        assert!(contacts[0].emails.is_empty());
        assert!(contacts[0].phones.is_empty());
        assert_eq!(contacts[0].display_name.as_deref(), Some("Solo"));
    }
}
