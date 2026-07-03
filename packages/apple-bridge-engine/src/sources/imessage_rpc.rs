//! Legacy connector-sync RPC reads over chat.db: `chats.list` and
//! `messages.history`. Ported from `packages/apple-bridge/src/db.ts` to preserve
//! the exact response shapes the (unchanged) server + iMessage connector expect
//! (`apple-client.ts` Chat/Message). The live search path uses the FTS index;
//! these serve the connector's `sync()` which still calls them over the tunnel.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;

use super::{epoch_ms_to_iso, open_ro};

/// Seconds between 2001-01-01 (Core Data epoch) and 1970-01-01 (Unix).
const CORE_DATA_EPOCH_OFFSET: i64 = 978_307_200;

/// Core Data nanosecond timestamp → ISO 8601 (mirrors db.ts `coreDataToISO`:
/// always treats `date` as nanoseconds; 0 → the Unix epoch).
fn core_data_to_iso(nanos: i64) -> String {
    if nanos == 0 {
        return epoch_ms_to_iso(0);
    }
    // unix_ms = nanos/1e6 + EPOCH*1000  (nanos/1e9 + EPOCH seconds, ×1000)
    let unix_ms = (nanos as f64 / 1_000_000.0).round() as i64 + CORE_DATA_EPOCH_OFFSET * 1000;
    epoch_ms_to_iso(unix_ms)
}

/// ISO 8601 → Core Data nanoseconds (mirrors db.ts `isoToCoreData`). Returns
/// None if unparseable (the filter is then skipped, matching JS NaN behavior
/// being avoided by callers passing valid ISO).
fn iso_to_core_data(iso: &str) -> Option<i64> {
    let ms = parse_iso_ms(iso)?;
    Some((ms / 1000 - CORE_DATA_EPOCH_OFFSET) * 1_000_000_000)
}

/// Minimal ISO-8601 parser for `YYYY-MM-DDTHH:MM:SS(.mmm)?Z` → epoch ms.
fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |a: usize, z: usize| -> Option<i64> { s.get(a..z)?.parse::<i64>().ok() };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, se) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    // days_from_civil (Howard Hinnant)
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = if yy >= 0 { yy } else { yy - 399 } / 400;
    let yoe = yy - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + h * 3600 + mi * 60 + se) * 1000) as i64)
}

#[derive(Debug, Serialize)]
pub struct Chat {
    pub id: i64,
    pub name: String,
    pub identifier: String,
    pub guid: String,
    pub service: String,
    pub last_message_at: String,
    pub participants: Vec<String>,
    pub is_group: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Attachment {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Message {
    pub id: i64,
    pub chat_id: i64,
    pub guid: String,
    pub sender: String,
    pub is_from_me: bool,
    pub text: String,
    pub created_at: String,
    pub attachments: Vec<Attachment>,
    pub reactions: Vec<serde_json::Value>,
    pub chat_identifier: String,
    pub chat_name: String,
    pub participants: Vec<String>,
    pub is_group: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_guid: Option<String>,
}

pub struct MessagesOpts {
    pub limit: Option<i64>,
    pub start: Option<String>,
    pub end: Option<String>,
}

/// Open chat.db read-only and list chats (newest first). Mirrors db.ts `chatsList`.
pub fn chats_list(db_path: &Path, limit: Option<i64>) -> Result<Vec<Chat>, rusqlite::Error> {
    let conn = open_ro(db_path)?;
    chats_list_conn(&conn, limit)
}

pub(crate) fn chats_list_conn(
    conn: &Connection,
    limit: Option<i64>,
) -> Result<Vec<Chat>, rusqlite::Error> {
    let base = r#"SELECT c.ROWID AS id, COALESCE(c.display_name, '') AS name, c.guid AS identifier,
                         c.guid AS guid, COALESCE(c.service_name, 'iMessage') AS service,
                         MAX(m.date) AS last_message_date
                  FROM chat c
                  LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
                  LEFT JOIN message m ON m.ROWID = cmj.message_id
                  GROUP BY c.ROWID
                  ORDER BY last_message_date DESC"#;
    let sql = if limit.is_some() { format!("{base}\nLIMIT ?1") } else { base.to_string() };

    let mut stmt = conn.prepare(&sql)?;
    let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<(i64, String, String, String, String, i64)> {
        Ok((
            row.get("id")?,
            row.get("name")?,
            row.get("identifier")?,
            row.get("guid")?,
            row.get("service")?,
            row.get::<_, Option<i64>>("last_message_date")?.unwrap_or(0),
        ))
    };
    let raw: Vec<_> = if let Some(l) = limit {
        stmt.query_map([l], map_row)?.collect::<Result<_, _>>()?
    } else {
        stmt.query_map([], map_row)?.collect::<Result<_, _>>()?
    };

    let mut chats = Vec::with_capacity(raw.len());
    for (id, name, identifier, guid, service, last_date) in raw {
        let participants = chat_participants(conn, id)?;
        let is_group = participants.len() > 1;
        let resolved_name = if !name.is_empty() {
            name
        } else if is_group {
            "Group Chat".to_string()
        } else {
            participants.first().cloned().unwrap_or_else(|| "Unknown".to_string())
        };
        chats.push(Chat {
            id,
            name: resolved_name,
            identifier,
            guid,
            service,
            last_message_at: core_data_to_iso(last_date),
            participants,
            is_group,
        });
    }
    Ok(chats)
}

/// Open chat.db read-only and fetch a chat's messages. Mirrors db.ts `messagesHistory`.
pub fn messages_history(
    db_path: &Path,
    chat_id: i64,
    opts: &MessagesOpts,
) -> Result<Vec<Message>, rusqlite::Error> {
    let conn = open_ro(db_path)?;
    messages_history_conn(&conn, chat_id, opts)
}

pub(crate) fn messages_history_conn(
    conn: &Connection,
    chat_id: i64,
    opts: &MessagesOpts,
) -> Result<Vec<Message>, rusqlite::Error> {
    let (chat_name, chat_identifier) = chat_meta(conn, chat_id)?;
    let participants = chat_participants(conn, chat_id)?;
    let is_group = participants.len() > 1;

    let mut sql = String::from(
        r#"SELECT m.ROWID AS id, m.guid AS guid, m.text AS text, m.attributedBody AS body,
                  m.date AS date, m.is_from_me AS is_from_me,
                  m.associated_message_guid AS assoc_guid, h.id AS handle_id
           FROM message m
           JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
           LEFT JOIN handle h ON h.ROWID = m.handle_id
           WHERE cmj.chat_id = ?1"#,
    );
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(chat_id)];
    if let Some(start) = opts.start.as_deref().and_then(iso_to_core_data) {
        sql.push_str(&format!(" AND m.date >= ?{}", params.len() + 1));
        params.push(Box::new(start));
    }
    if let Some(end) = opts.end.as_deref().and_then(iso_to_core_data) {
        sql.push_str(&format!(" AND m.date <= ?{}", params.len() + 1));
        params.push(Box::new(end));
    }
    sql.push_str(" ORDER BY m.date ASC");
    if let Some(l) = opts.limit {
        sql.push_str(&format!(" LIMIT ?{}", params.len() + 1));
        params.push(Box::new(l));
    }

    let attachments = attachments_for_chat(conn, chat_id)?;

    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(rusqlite::params_from_iter(params.iter().map(|b| b.as_ref())))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let id: i64 = row.get("id")?;
        let guid: Option<String> = row.get("guid")?;
        let text_col: Option<String> = row.get("text")?;
        let body: Option<Vec<u8>> = row.get("body")?;
        let date: i64 = row.get::<_, Option<i64>>("date")?.unwrap_or(0);
        let is_from_me: i64 = row.get::<_, Option<i64>>("is_from_me")?.unwrap_or(0);
        let assoc: Option<String> = row.get("assoc_guid")?;
        let handle: Option<String> = row.get("handle_id")?;

        let text = match text_col {
            Some(t) if !t.is_empty() => t,
            _ => super::attributed_body::extract_attributed_body_text(body.as_deref().unwrap_or(&[])),
        };
        out.push(Message {
            id,
            chat_id,
            guid: guid.unwrap_or_else(|| format!("apple-msg-local-{id}")),
            sender: handle.unwrap_or_default(),
            is_from_me: is_from_me == 1,
            text,
            created_at: core_data_to_iso(date),
            attachments: attachments.get(&id).cloned().unwrap_or_default(),
            reactions: Vec::new(),
            chat_identifier: chat_identifier.clone(),
            chat_name: chat_name.clone(),
            participants: participants.clone(),
            is_group,
            reply_to_guid: assoc.filter(|s| !s.is_empty()),
        });
    }
    Ok(out)
}

fn chat_participants(conn: &Connection, chat_id: i64) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        r#"SELECT h.id FROM chat_handle_join chj
           JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = ?1"#,
    )?;
    let rows = stmt.query_map([chat_id], |r| r.get::<_, String>(0))?;
    rows.collect()
}

fn chat_meta(conn: &Connection, chat_id: i64) -> Result<(String, String), rusqlite::Error> {
    let mut stmt = conn
        .prepare("SELECT COALESCE(display_name, '') AS name, guid AS identifier FROM chat WHERE ROWID = ?1")?;
    let mut rows = stmt.query([chat_id])?;
    if let Some(row) = rows.next()? {
        Ok((row.get("name")?, row.get("identifier")?))
    } else {
        Ok(("Unknown".to_string(), String::new()))
    }
}

/// Attachments for every message in a chat, grouped by message id.
fn attachments_for_chat(
    conn: &Connection,
    chat_id: i64,
) -> Result<HashMap<i64, Vec<Attachment>>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        r#"SELECT maj.message_id AS mid, a.filename AS filename, a.mime_type AS mime_type,
                  a.transfer_name AS transfer_name
           FROM message_attachment_join maj
           JOIN attachment a ON a.ROWID = maj.attachment_id
           WHERE maj.message_id IN (SELECT message_id FROM chat_message_join WHERE chat_id = ?1)"#,
    )?;
    let mut rows = stmt.query([chat_id])?;
    let mut map: HashMap<i64, Vec<Attachment>> = HashMap::new();
    while let Some(row) = rows.next()? {
        let mid: i64 = row.get("mid")?;
        map.entry(mid).or_default().push(Attachment {
            filename: row.get::<_, Option<String>>("filename")?.filter(|s| !s.is_empty()),
            mime_type: row.get::<_, Option<String>>("mime_type")?.filter(|s| !s.is_empty()),
            transfer_name: row.get::<_, Option<String>>("transfer_name")?.filter(|s| !s.is_empty()),
        });
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            r#"
            CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
            CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, display_name TEXT, guid TEXT, service_name TEXT);
            CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
                                  date INTEGER, is_from_me INTEGER, associated_message_guid TEXT, handle_id INTEGER);
            CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
            CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
            CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT, transfer_name TEXT);
            CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
            INSERT INTO handle VALUES (1, '+15551234567'), (2, '+15559998888');
            INSERT INTO chat VALUES (1, '', 'iMessage;-;chat1', 'iMessage');
            INSERT INTO chat_handle_join VALUES (1, 1), (1, 2);
            INSERT INTO message VALUES (10, 'g-10', 'hello there', NULL, 700000000000000000, 0, NULL, 1);
            INSERT INTO message VALUES (11, 'g-11', 'reply', NULL, 700000001000000000, 1, 'g-10', NULL);
            INSERT INTO chat_message_join VALUES (1, 10), (1, 11);
            INSERT INTO attachment VALUES (99, '/x/doc.pdf', 'application/pdf', 'doc.pdf');
            INSERT INTO message_attachment_join VALUES (10, 99);
            "#,
        )
        .unwrap();
        c
    }

    #[test]
    fn chats_list_resolves_group_and_time() {
        let c = fixture();
        let chats = chats_list_conn(&c, None).unwrap();
        assert_eq!(chats.len(), 1);
        let chat = &chats[0];
        assert!(chat.is_group, "2 participants → group");
        assert_eq!(chat.name, "Group Chat"); // empty display_name + group
        assert_eq!(chat.participants.len(), 2);
        assert!(chat.last_message_at.ends_with('Z'));
        assert_eq!(chat.service, "iMessage");
    }

    #[test]
    fn messages_history_shape_and_attachments() {
        let c = fixture();
        let msgs = messages_history_conn(&c, 1, &MessagesOpts { limit: None, start: None, end: None }).unwrap();
        assert_eq!(msgs.len(), 2);

        let m10 = msgs.iter().find(|m| m.id == 10).unwrap();
        assert_eq!(m10.text, "hello there");
        assert_eq!(m10.sender, "+15551234567");
        assert!(!m10.is_from_me);
        assert_eq!(m10.attachments.len(), 1);
        assert_eq!(m10.attachments[0].mime_type.as_deref(), Some("application/pdf"));
        assert!(m10.is_group);
        assert_eq!(m10.participants.len(), 2);
        assert!(m10.created_at.ends_with('Z'));

        let m11 = msgs.iter().find(|m| m.id == 11).unwrap();
        assert!(m11.is_from_me);
        assert_eq!(m11.reply_to_guid.as_deref(), Some("g-10"));
        assert!(m11.attachments.is_empty());
    }

    #[test]
    fn iso_core_data_roundtrip() {
        // 700000000 s of Core Data nanos handled; check ISO parse/format symmetry.
        let iso = core_data_to_iso(700_000_000_000_000_000);
        let nanos = iso_to_core_data(&iso).unwrap();
        // round-trips to within the original (whole-second) precision
        assert_eq!(core_data_to_iso(nanos), iso);
    }
}
