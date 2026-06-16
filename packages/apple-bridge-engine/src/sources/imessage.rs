//! iMessage source reader — READ-ONLY over `~/Library/Messages/chat.db`.
//! Ported from `local-index/sources/imessage.ts`. Body comes from `text`, or the
//! `attributedBody` typedstream when `text` is NULL.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::{open_ro, RecordSink};
use crate::index::IndexRecord;

/// Seconds between 2001-01-01 (Core Data epoch) and 1970-01-01 (Unix).
const COCOA_EPOCH: i64 = 978_307_200;

/// chat.db `date` is nanoseconds (modern) or seconds (legacy) since Cocoa epoch.
fn to_unix_seconds(date: i64) -> i64 {
    if date == 0 {
        0
    } else if date > 100_000_000_000 {
        date / 1_000_000_000 + COCOA_EPOCH
    } else {
        date + COCOA_EPOCH
    }
}

pub fn default_db_path() -> PathBuf {
    crate::config::home_dir().join("Library/Messages/chat.db")
}

/// Cheap readability probe. Never throws.
pub fn detect(db_path: &Path) -> bool {
    db_path.exists() && open_ro(db_path).is_ok()
}

/// Stream normalized message records into `sink`. Returns the record count.
pub fn read(db_path: &Path, sink: RecordSink<'_>) -> Result<usize, rusqlite::Error> {
    let conn = open_ro(db_path)?;
    read_conn(&conn, sink)
}

/// Inner read against an open connection (so tests can use a fixture DB).
pub(crate) fn read_conn(conn: &Connection, sink: RecordSink<'_>) -> Result<usize, rusqlite::Error> {
    let mut stmt = conn.prepare(
        r#"SELECT m.ROWID AS id, m.text AS text, m.attributedBody AS body, m.date AS date,
                  m.is_from_me AS is_from_me, h.id AS handle,
                  c.chat_identifier AS chat_id, c.display_name AS chat_title
           FROM message m
           LEFT JOIN handle h ON h.ROWID = m.handle_id
           LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
           LEFT JOIN chat c ON c.ROWID = cmj.chat_id
           WHERE (m.text IS NOT NULL AND m.text <> '') OR m.attributedBody IS NOT NULL"#,
    )?;

    let mut rows = stmt.query([])?;
    let mut count = 0usize;
    while let Some(row) = rows.next()? {
        let id: i64 = row.get("id")?;
        let text_col: Option<String> = row.get("text")?;
        let body: Option<Vec<u8>> = row.get("body")?;
        let date: i64 = row.get::<_, Option<i64>>("date")?.unwrap_or(0);
        let is_from_me: i64 = row.get::<_, Option<i64>>("is_from_me")?.unwrap_or(0);
        let handle: Option<String> = row.get("handle")?;
        let chat_id: Option<String> = row.get("chat_id")?;
        let chat_title: Option<String> = row.get("chat_title")?;

        let text = match text_col {
            Some(t) if !t.is_empty() => t,
            _ => super::attributed_body::extract_attributed_body_text(body.as_deref().unwrap_or(&[])),
        };
        if text.is_empty() {
            continue;
        }

        let from_me = is_from_me != 0;
        sink(IndexRecord {
            source_id: id.to_string(),
            thread_id: chat_id.unwrap_or_default(),
            thread_title: chat_title.unwrap_or_default(),
            sender_name: if from_me { "Me".to_string() } else { handle.clone().unwrap_or_default() },
            sender_id: handle.unwrap_or_default(),
            is_from_me: from_me,
            ts: to_unix_seconds(date),
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

    /// Build an in-memory chat.db with the columns the reader uses.
    fn fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            r#"
            CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
            CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);
            CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB,
                                  date INTEGER, is_from_me INTEGER, handle_id INTEGER);
            CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
            INSERT INTO handle VALUES (1, '+15551234567');
            INSERT INTO chat VALUES (1, 'chat123', 'Parkwoods');
            -- plain text message from a handle
            INSERT INTO message VALUES (10, 'next installment is 50000', NULL, 700000000000000000, 0, 1);
            -- message from me, attributedBody only (text NULL)
            INSERT INTO message VALUES (11, NULL, ?1, 700000001000000000, 1, NULL);
            INSERT INTO chat_message_join VALUES (1, 10), (1, 11);
            "#,
        )
        .unwrap();
        // Insert an attributedBody blob for ROWID 11.
        let blob = {
            let mut v = Vec::new();
            v.extend_from_slice(b"NSString");
            v.extend_from_slice(&[0x01, 0x94, 0x84, 0x95, 0x84, 0x01, 0x2b]);
            let t = b"see you tomorrow";
            v.push(t.len() as u8);
            v.extend_from_slice(t);
            v
        };
        c.execute("UPDATE message SET attributedBody = ?1 WHERE ROWID = 11", [blob])
            .unwrap();
        c
    }

    #[test]
    fn reads_text_and_attributed_body() {
        let c = fixture();
        let mut got = Vec::new();
        let n = read_conn(&c, &mut |r| got.push(r)).unwrap();
        assert_eq!(n, 2);

        let plain = got.iter().find(|r| r.source_id == "10").unwrap();
        assert_eq!(plain.text, "next installment is 50000");
        assert_eq!(plain.sender_name, "+15551234567");
        assert_eq!(plain.thread_title, "Parkwoods");
        assert!(!plain.is_from_me);
        assert!(plain.ts > 1_600_000_000); // sane unix seconds

        let attr = got.iter().find(|r| r.source_id == "11").unwrap();
        assert_eq!(attr.text, "see you tomorrow");
        assert!(attr.is_from_me);
        assert_eq!(attr.sender_name, "Me");
    }
}
