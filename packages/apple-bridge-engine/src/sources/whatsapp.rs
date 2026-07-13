//! WhatsApp source reader — READ-ONLY over `ChatStorage.sqlite`.
//! Ported from `local-index/sources/whatsapp.ts`. Sender names resolve from the
//! sibling `ContactsV2.sqlite`. LIDs are opaque identifiers, never phone numbers.
//!
//! Phase 4a indexes text messages + document captions. Attachment text
//! extraction (PDF/DOCX/TXT) is Phase 4b (see `media_json` carries the path).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::{open_ro, Cancelled, RecordSink};
use crate::index::IndexRecord;

/// Core Data epoch: 2001-01-01 in unix seconds.
const CORE_DATA_EPOCH: f64 = 978_307_200.0;

pub fn default_db_path() -> PathBuf {
    crate::config::home_dir()
        .join("Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite")
}

pub fn detect(db_path: &Path) -> bool {
    db_path.exists() && open_ro(db_path).is_ok()
}

fn only_digits(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit()).collect()
}

/// Digits/lid from a JID like `971…@s.whatsapp.net` or `…@lid`.
fn jid_digits(jid: &str) -> String {
    only_digits(jid.split('@').next().unwrap_or(""))
}

/// Build a phone/waid/lid → contact name map from the sibling ContactsV2.sqlite.
fn load_contact_names(container_dir: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let p = container_dir.join("ContactsV2.sqlite");
    if !p.exists() {
        return map;
    }
    let conn = match open_ro(&p) {
        Ok(c) => c,
        Err(_) => return map,
    };
    let stmt = conn.prepare(
        r#"SELECT ZFULLNAME f, ZGIVENNAME g, ZLASTNAME l, ZPHONENUMBER p, ZWHATSAPPID w, ZLID lid
           FROM ZWAADDRESSBOOKCONTACT"#,
    );
    let mut stmt = match stmt {
        Ok(s) => s,
        Err(_) => return map, // schema variant without this table — best-effort
    };
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
        ))
    });
    let rows = match rows {
        Ok(r) => r,
        Err(_) => return map,
    };
    for row in rows.flatten() {
        let (f, g, l, p, w, lid) = row;
        let name = f
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                [g.as_deref(), l.as_deref()]
                    .into_iter()
                    .flatten()
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ")
                    .trim()
                    .to_string()
            });
        if name.is_empty() {
            continue;
        }
        for key in [
            only_digits(p.as_deref().unwrap_or("")),
            jid_digits(w.as_deref().unwrap_or("")),
            only_digits(lid.as_deref().unwrap_or("")),
        ] {
            if !key.is_empty() {
                map.insert(key, name.clone());
            }
        }
    }
    map
}

/// Pick the session-title column that exists in this WhatsApp version.
fn pick_title_col(conn: &Connection) -> String {
    let mut cols = std::collections::HashSet::new();
    if let Ok(mut stmt) = conn.prepare("PRAGMA table_info(ZWACHATSESSION)") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(1)) {
            for c in rows.flatten() {
                cols.insert(c);
            }
        }
    }
    for cand in ["ZPARTNERNAME", "ZSESSIONNAME", "ZCONTACTJID"] {
        if cols.contains(cand) {
            return cand.to_string();
        }
    }
    "ZCONTACTJID".to_string()
}

/// Where to find (and how to confine) downloaded attachments for text extraction.
pub(crate) struct AttachCtx {
    /// WhatsApp container dir that `ZMEDIALOCALPATH` is relative to.
    pub container: PathBuf,
    /// Canonicalized container — attachment reads must resolve within this.
    pub real_container: PathBuf,
}

pub fn read(
    db_path: &Path,
    cancelled: Cancelled<'_>,
    sink: RecordSink<'_>,
) -> Result<usize, rusqlite::Error> {
    let conn = open_ro(db_path)?;
    let container_dir = db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    let names = load_contact_names(&container_dir);
    let real_container =
        std::fs::canonicalize(&container_dir).unwrap_or_else(|_| container_dir.clone());
    let attach = AttachCtx {
        container: container_dir,
        real_container,
    };
    read_conn(&conn, &names, Some(&attach), cancelled, sink)
}

pub(crate) fn read_conn(
    conn: &Connection,
    names: &HashMap<String, String>,
    attach: Option<&AttachCtx>,
    cancelled: Cancelled<'_>,
    sink: RecordSink<'_>,
) -> Result<usize, rusqlite::Error> {
    let title_col = pick_title_col(conn);
    let sql = format!(
        r#"SELECT m.Z_PK AS id, m.ZTEXT AS text, m.ZMESSAGEDATE AS ts,
                  m.ZISFROMME AS is_from_me, m.ZFROMJID AS from_jid,
                  cs.ZCONTACTJID AS chat_jid, cs.{title_col} AS chat_title,
                  gm.ZMEMBERJID AS member_jid,
                  md.ZMEDIALOCALPATH AS media_path, md.ZTITLE AS media_title
           FROM ZWAMESSAGE m
           LEFT JOIN ZWACHATSESSION cs ON cs.Z_PK = m.ZCHATSESSION
           LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER
           LEFT JOIN ZWAMEDIAITEM  md ON md.Z_PK = m.ZMEDIAITEM
           WHERE (m.ZTEXT IS NOT NULL AND m.ZTEXT <> '')
              OR (md.ZTITLE IS NOT NULL AND md.ZTITLE <> '')
              OR (md.ZMEDIALOCALPATH IS NOT NULL)"#
    );

    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    let mut count = 0usize;
    while let Some(row) = rows.next()? {
        // Check before each row (and thus before any attachment extraction) so a
        // stop request interrupts promptly even mid-scan of a large store.
        if cancelled() {
            break;
        }
        let id: i64 = row.get("id")?;
        let text_col: Option<String> = row.get("text")?;
        let ts: Option<f64> = row.get("ts")?;
        let is_from_me: i64 = row.get::<_, Option<i64>>("is_from_me")?.unwrap_or(0);
        let from_jid: Option<String> = row.get("from_jid")?;
        let chat_jid: Option<String> = row.get("chat_jid")?;
        let chat_title: Option<String> = row.get("chat_title")?;
        let member_jid: Option<String> = row.get("member_jid")?;
        let media_path: Option<String> = row.get("media_path")?;
        let media_title: Option<String> = row.get("media_title")?;

        // Sender: prefer group-member JID; for 1:1 use ZFROMJID (not the group jid).
        let sender_jid = member_jid
            .filter(|s| !s.is_empty())
            .or_else(|| from_jid.filter(|j| !j.ends_with("@g.us")))
            .unwrap_or_default();
        let digits = jid_digits(&sender_jid);
        let sender_name = if !digits.is_empty() {
            names
                .get(&digits)
                .cloned()
                .unwrap_or_else(|| format!("+{digits}"))
        } else {
            String::new()
        };

        let caption = media_title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let mut text = text_col.filter(|t| !t.is_empty()).unwrap_or_default();

        // Extract text from a downloaded document attachment (PDF/DOCX/TXT/CSV).
        // ZMEDIALOCALPATH is data from the source DB: resolve it against the
        // container, canonicalize (follows symlinks like a read would), and
        // reject anything that escapes the real container before reading.
        if let (Some(ctx), Some(rel)) = (attach, media_path.as_deref()) {
            let abs = ctx.container.join(rel);
            if let Ok(real) = std::fs::canonicalize(&abs) {
                if real.starts_with(&ctx.real_container) {
                    let doc = super::attachments::extract_doc_text(&real);
                    if !doc.is_empty() {
                        text = [text.as_str(), caption.unwrap_or(""), doc.as_str()]
                            .into_iter()
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<_>>()
                            .join("\n");
                    }
                }
            }
        }

        if text.is_empty() {
            if let Some(c) = caption {
                text = c.to_string();
            }
        }
        if text.is_empty() {
            continue; // pure image/audio with no caption — nothing to index
        }

        let media_json = media_path
            .as_ref()
            .map(|p| serde_json::json!([{ "path": p }]).to_string());

        sink(IndexRecord {
            source_id: id.to_string(),
            thread_id: chat_jid.unwrap_or_default(),
            thread_title: chat_title.unwrap_or_default(),
            sender_name,
            sender_id: sender_jid,
            is_from_me: is_from_me != 0,
            ts: ts
                .map(|t| (t + CORE_DATA_EPOCH).round() as i64)
                .unwrap_or(0),
            text,
            media_json,
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
            CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZCONTACTJID TEXT, ZPARTNERNAME TEXT);
            CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZMEMBERJID TEXT);
            CREATE TABLE ZWAMEDIAITEM (Z_PK INTEGER PRIMARY KEY, ZMEDIALOCALPATH TEXT, ZTITLE TEXT);
            CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, ZTEXT TEXT, ZMESSAGEDATE REAL,
                                     ZISFROMME INTEGER, ZFROMJID TEXT, ZCHATSESSION INTEGER,
                                     ZGROUPMEMBER INTEGER, ZMEDIAITEM INTEGER);
            INSERT INTO ZWACHATSESSION VALUES (1, '[email protected]', 'Parkwoods Group');
            INSERT INTO ZWAGROUPMEMBER VALUES (5, '971501234567@s.whatsapp.net');
            INSERT INTO ZWAMEDIAITEM VALUES (7, 'Message/Media/doc.pdf', 'installment.pdf');
            -- group text message from member 5
            INSERT INTO ZWAMESSAGE VALUES (100, 'the next installment is due Friday', 700000000.0, 0,
                                          '[email protected]', 1, 5, NULL);
            -- document with caption only (no text)
            INSERT INTO ZWAMESSAGE VALUES (101, NULL, 700000100.0, 1, NULL, 1, NULL, 7);
            "#,
        )
        .unwrap();
        c
    }

    #[test]
    fn reads_text_and_resolves_names() {
        let c = fixture();
        let mut names = HashMap::new();
        names.insert("971501234567".to_string(), "Mostafa".to_string());
        let mut got = Vec::new();
        let n = read_conn(
            &c,
            &names,
            None,
            &crate::sources::never_cancelled(),
            &mut |r| got.push(r),
        )
        .unwrap();
        assert_eq!(n, 2);

        let msg = got.iter().find(|r| r.source_id == "100").unwrap();
        assert_eq!(msg.text, "the next installment is due Friday");
        assert_eq!(msg.sender_name, "Mostafa"); // resolved from ContactsV2 map
        assert_eq!(msg.thread_title, "Parkwoods Group");
        assert!(msg.ts > 1_600_000_000);

        let doc = got.iter().find(|r| r.source_id == "101").unwrap();
        assert_eq!(doc.text, "installment.pdf"); // caption used when no text
        assert!(doc.media_json.as_ref().unwrap().contains("doc.pdf"));
    }

    #[test]
    fn unknown_sender_falls_back_to_plus_digits() {
        let c = fixture();
        let names = HashMap::new(); // empty → no resolution
        let mut got = Vec::new();
        read_conn(
            &c,
            &names,
            None,
            &crate::sources::never_cancelled(),
            &mut |r| got.push(r),
        )
        .unwrap();
        let msg = got.iter().find(|r| r.source_id == "100").unwrap();
        assert_eq!(msg.sender_name, "+971501234567");
    }

    #[test]
    fn extracts_contained_attachment_text() {
        use std::io::Write;
        // Container with a real downloaded .txt attachment.
        let dir = tempfile::tempdir().unwrap();
        let container = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(container.join("Message/Media")).unwrap();
        let mut f = std::fs::File::create(container.join("Message/Media/doc.txt")).unwrap();
        f.write_all(b"the next installment amount is 50,000 due Friday")
            .unwrap();

        // A media row pointing at that file, with no ZTEXT.
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            r#"
            CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZCONTACTJID TEXT, ZPARTNERNAME TEXT);
            CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZMEMBERJID TEXT);
            CREATE TABLE ZWAMEDIAITEM (Z_PK INTEGER PRIMARY KEY, ZMEDIALOCALPATH TEXT, ZTITLE TEXT);
            CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, ZTEXT TEXT, ZMESSAGEDATE REAL,
                                     ZISFROMME INTEGER, ZFROMJID TEXT, ZCHATSESSION INTEGER,
                                     ZGROUPMEMBER INTEGER, ZMEDIAITEM INTEGER);
            INSERT INTO ZWACHATSESSION VALUES (1, '[email protected]', 'Parkwoods Group');
            INSERT INTO ZWAMEDIAITEM VALUES (7, 'Message/Media/doc.txt', 'statement.txt');
            INSERT INTO ZWAMESSAGE VALUES (200, NULL, 700000200.0, 0, '[email protected]', 1, NULL, 7);
            "#,
        )
        .unwrap();

        let attach = AttachCtx {
            container: container.clone(),
            real_container: container,
        };
        let names = HashMap::new();
        let mut got = Vec::new();
        read_conn(
            &c,
            &names,
            Some(&attach),
            &crate::sources::never_cancelled(),
            &mut |r| got.push(r),
        )
        .unwrap();
        let msg = got.iter().find(|r| r.source_id == "200").unwrap();
        assert!(
            msg.text.contains("installment amount is 50,000"),
            "got: {:?}",
            msg.text
        );
        // caption is included alongside the extracted text
        assert!(msg.text.contains("statement.txt"));
    }

    #[test]
    fn rejects_attachment_outside_container() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let container = std::fs::canonicalize(dir.path()).unwrap().join("container");
        std::fs::create_dir_all(&container).unwrap();
        // Secret file OUTSIDE the container.
        let mut f = std::fs::File::create(dir.path().join("secret.txt")).unwrap();
        f.write_all(b"top secret should never be indexed").unwrap();

        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            r#"
            CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZCONTACTJID TEXT, ZPARTNERNAME TEXT);
            CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZMEMBERJID TEXT);
            CREATE TABLE ZWAMEDIAITEM (Z_PK INTEGER PRIMARY KEY, ZMEDIALOCALPATH TEXT, ZTITLE TEXT);
            CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, ZTEXT TEXT, ZMESSAGEDATE REAL,
                                     ZISFROMME INTEGER, ZFROMJID TEXT, ZCHATSESSION INTEGER,
                                     ZGROUPMEMBER INTEGER, ZMEDIAITEM INTEGER);
            INSERT INTO ZWACHATSESSION VALUES (1, '[email protected]', 'G');
            INSERT INTO ZWAMEDIAITEM VALUES (7, '../secret.txt', 'cap.txt');
            INSERT INTO ZWAMESSAGE VALUES (300, NULL, 700000300.0, 0, '[email protected]', 1, NULL, 7);
            "#,
        )
        .unwrap();

        let real_container = std::fs::canonicalize(&container).unwrap();
        let attach = AttachCtx {
            container,
            real_container,
        };
        let names = HashMap::new();
        let mut got = Vec::new();
        read_conn(
            &c,
            &names,
            Some(&attach),
            &crate::sources::never_cancelled(),
            &mut |r| got.push(r),
        )
        .unwrap();
        let msg = got.iter().find(|r| r.source_id == "300").unwrap();
        // Traversal blocked → secret never read; falls back to the caption only.
        assert!(
            !msg.text.contains("top secret"),
            "path traversal leaked: {:?}",
            msg.text
        );
        assert_eq!(msg.text, "cap.txt");
    }
}
