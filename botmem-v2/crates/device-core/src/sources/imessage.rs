use super::{
    columns, contains_all, default_path, open_source_database, probe_error, schema_fingerprint,
    stable_revision, AdapterCursor, AdapterError, SchemaDescriptor, SourceAdapter, SourceProbe,
    SourceRecord, SourceScan,
};
use crate::state::{SourceCursor, SourceId, SourceReadiness};
use rusqlite::params;
use std::path::{Path, PathBuf};

const COCOA_EPOCH_SECONDS: i64 = 978_307_200;
const SCHEMA_TABLES: [&str; 4] = ["message", "handle", "chat", "chat_message_join"];

#[derive(Debug, Clone)]
pub struct IMessageAdapter {
    path: PathBuf,
}

impl IMessageAdapter {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    fn open_and_detect(&self) -> Result<(rusqlite::Connection, SchemaDescriptor), AdapterError> {
        let connection = open_source_database(self.source(), &self.path)?;
        let message = columns(&connection, "message")?;
        let handle = columns(&connection, "handle")?;
        let chat = columns(&connection, "chat")?;
        let join = columns(&connection, "chat_message_join")?;
        let fingerprint = schema_fingerprint(&connection, &SCHEMA_TABLES)?;
        let supported = contains_all(
            &message,
            &["guid", "text", "date", "is_from_me", "handle_id"],
        ) && contains_all(&handle, &["id"])
            && contains_all(&chat, &["chat_identifier"])
            && contains_all(&join, &["message_id", "chat_id"]);
        if !supported {
            return Err(AdapterError::UnsupportedSchema {
                connector: self.source(),
                fingerprint,
            });
        }
        let version = if message.contains("date_edited") && message.contains("date_retracted") {
            2
        } else {
            1
        };
        Ok((
            connection,
            SchemaDescriptor {
                family: "apple-messages",
                version,
                fingerprint,
            },
        ))
    }
}

impl Default for IMessageAdapter {
    fn default() -> Self {
        Self::new(default_path("Library/Messages/chat.db"))
    }
}

impl SourceAdapter for IMessageAdapter {
    fn source(&self) -> SourceId {
        SourceId::IMessage
    }

    fn database_path(&self) -> &Path {
        &self.path
    }

    fn probe(&self) -> SourceProbe {
        match self.open_and_detect() {
            Ok((connection, schema)) => SourceProbe {
                source: self.source(),
                readiness: SourceReadiness::Ready,
                schema: Some(schema),
                read_only: connection
                    .is_readonly(rusqlite::DatabaseName::Main)
                    .unwrap_or(false),
                reason_code: None,
            },
            Err(error) => probe_error(self.source(), error),
        }
    }

    fn scan(&self, cursor: Option<&SourceCursor>) -> Result<SourceScan, AdapterError> {
        let (connection, schema) = self.open_and_detect()?;
        let cursor = AdapterCursor::parse(self.source(), cursor)?;
        let message_columns = columns(&connection, "message")?;
        let chat_columns = columns(&connection, "chat")?;
        let has_body = message_columns.contains("attributedBody");
        let has_edited = message_columns.contains("date_edited");
        let has_retracted = message_columns.contains("date_retracted");
        let body_select = if has_body { "m.attributedBody" } else { "NULL" };
        let edited_select = if has_edited { "m.date_edited" } else { "0" };
        let sort_expression = if has_edited {
            "MAX(COALESCE(m.date, 0), COALESCE(NULLIF(m.date_edited, 0), COALESCE(m.date, 0)))"
        } else {
            "COALESCE(m.date, 0)"
        };
        let retracted_filter = if has_retracted {
            "AND COALESCE(m.date_retracted, 0) = 0"
        } else {
            ""
        };
        let title_select = if chat_columns.contains("display_name") {
            "c.display_name"
        } else {
            "NULL"
        };
        let query = format!(
            "SELECT m.ROWID, m.guid, m.text, {body_select}, m.date, {edited_select},
                    m.is_from_me, h.id, c.chat_identifier, {title_select},
                    {sort_expression} AS sort_value
               FROM message m
               LEFT JOIN handle h ON h.ROWID = m.handle_id
               LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
               LEFT JOIN chat c ON c.ROWID = cmj.chat_id
              WHERE ({sort_expression} > ?1 OR ({sort_expression} = ?1 AND m.ROWID > ?2))
                {retracted_filter}
              ORDER BY sort_value, m.ROWID"
        );
        let mut statement = connection.prepare(&query)?;
        let mut rows = statement.query(params![cursor.sort_value, cursor.row_id])?;
        let mut records = Vec::new();
        let mut high_water = cursor;
        let mut high_watermark_ms = None;
        while let Some(row) = rows.next()? {
            let row_id: i64 = row.get(0)?;
            let guid: String = row.get(1)?;
            let text: Option<String> = row.get(2)?;
            let body: Option<Vec<u8>> = row.get(3)?;
            let date: i64 = row.get::<_, Option<i64>>(4)?.unwrap_or(0);
            let edited: i64 = row.get::<_, Option<i64>>(5)?.unwrap_or(0);
            let is_from_me = row.get::<_, i64>(6)? != 0;
            let handle: Option<String> = row.get(7)?;
            let thread_id: Option<String> = row.get(8)?;
            let thread_title: Option<String> = row.get(9)?;
            let sort_value: i64 = row.get(10)?;
            high_water = AdapterCursor {
                source: self.source(),
                sort_value,
                row_id,
            };
            high_watermark_ms = Some(cocoa_to_unix_ms(sort_value));

            let text = text
                .filter(|value| !value.is_empty())
                .or_else(|| body.as_deref().and_then(extract_attributed_body_text));
            let Some(text) = text else {
                continue;
            };
            let revision = stable_revision(&[
                guid.as_bytes(),
                text.as_bytes(),
                date.to_string().as_bytes(),
                edited.to_string().as_bytes(),
                handle.as_deref().unwrap_or_default().as_bytes(),
                thread_id.as_deref().unwrap_or_default().as_bytes(),
                if is_from_me { b"1" } else { b"0" },
            ]);
            let record = SourceRecord {
                source_id: guid,
                revision,
                occurred_at_ms: Some(cocoa_to_unix_ms(date)),
                text,
                thread_id,
                thread_title,
                participant_id: handle,
                authored_by_me: is_from_me,
            };
            record.validate()?;
            records.push(record);
        }
        Ok(SourceScan {
            schema,
            records,
            next_cursor: high_water.encode(high_watermark_ms)?,
        })
    }
}

fn cocoa_to_unix_ms(value: i64) -> i64 {
    if value > 100_000_000_000 {
        value / 1_000_000 + COCOA_EPOCH_SECONDS * 1_000
    } else {
        (value + COCOA_EPOCH_SECONDS) * 1_000
    }
}

fn extract_attributed_body_text(body: &[u8]) -> Option<String> {
    const NS_STRING: &[u8] = b"NSString";
    const MARKER: &[u8] = &[0x95, 0x84, 0x01, 0x2b];
    let mut search_from = 0;
    while search_from < body.len() {
        let class_at = find_bytes(&body[search_from..], NS_STRING)? + search_from;
        let marker_from = class_at + NS_STRING.len();
        let marker_offset = find_bytes(&body[marker_from..], MARKER)?;
        let length_at = marker_from + marker_offset + MARKER.len();
        let Some((length, offset)) = archived_length(body, length_at) else {
            search_from = marker_from;
            continue;
        };
        let start = length_at + offset;
        let end = start.saturating_add(length);
        if length > 0 && end <= body.len() {
            if let Ok(value) = std::str::from_utf8(&body[start..end]) {
                let value = value.trim();
                if value.chars().any(char::is_alphanumeric)
                    && !matches!(value, "NSString" | "NSAttributedString" | "NSObject")
                    && !value.starts_with("__kIM")
                {
                    return Some(value.to_owned());
                }
            }
        }
        search_from = marker_from;
    }
    None
}

fn archived_length(body: &[u8], offset: usize) -> Option<(usize, usize)> {
    let first = *body.get(offset)?;
    if first < 0x80 {
        return Some((usize::from(first), 1));
    }
    let count = usize::from(first & 0x7f);
    if count == 0 || count > 4 || offset + count >= body.len() {
        return None;
    }
    let mut length = 0usize;
    for index in 1..=count {
        length = length.checked_shl(8)? + usize::from(*body.get(offset + index)?);
    }
    Some((length, 1 + count))
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_typedstream_text() {
        let mut body = b"prefix NSString data".to_vec();
        body.extend_from_slice(&[0x95, 0x84, 0x01, 0x2b, 5]);
        body.extend_from_slice(b"hello");
        assert_eq!(
            extract_attributed_body_text(&body).as_deref(),
            Some("hello")
        );
    }
}
