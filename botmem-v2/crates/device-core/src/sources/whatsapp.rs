use super::{
    columns, contains_all, default_path, open_source_database, probe_error, schema_fingerprint,
    stable_revision, AdapterCursor, AdapterError, SchemaDescriptor, SourceAdapter, SourceProbe,
    SourceRecord, SourceScan,
};
use crate::state::{SourceCursor, SourceId, SourceReadiness};
use rusqlite::params;
use std::path::{Path, PathBuf};

const CORE_DATA_EPOCH_MS: i64 = 978_307_200_000;
const SCHEMA_TABLES: [&str; 4] = [
    "ZWAMESSAGE",
    "ZWACHATSESSION",
    "ZWAGROUPMEMBER",
    "ZWAMEDIAITEM",
];

#[derive(Debug, Clone)]
pub struct WhatsAppAdapter {
    path: PathBuf,
}

impl WhatsAppAdapter {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    fn open_and_detect(&self) -> Result<(rusqlite::Connection, SchemaDescriptor), AdapterError> {
        let connection = open_source_database(self.source(), &self.path)?;
        let message = columns(&connection, "ZWAMESSAGE")?;
        let chats = columns(&connection, "ZWACHATSESSION")?;
        let group_members = columns(&connection, "ZWAGROUPMEMBER")?;
        let fingerprint = schema_fingerprint(&connection, &SCHEMA_TABLES)?;
        let supported = contains_all(
            &message,
            &[
                "Z_PK",
                "Z_OPT",
                "ZSTANZAID",
                "ZTEXT",
                "ZMESSAGEDATE",
                "ZISFROMME",
                "ZFROMJID",
                "ZCHATSESSION",
                "ZGROUPMEMBER",
                "ZMEDIAITEM",
            ],
        ) && contains_all(&chats, &["Z_PK", "ZCONTACTJID"])
            && contains_all(&group_members, &["Z_PK", "ZMEMBERJID"]);
        if !supported {
            return Err(AdapterError::UnsupportedSchema {
                connector: self.source(),
                fingerprint,
            });
        }
        Ok((
            connection,
            SchemaDescriptor {
                family: "whatsapp-core-data",
                version: 1,
                fingerprint,
            },
        ))
    }
}

impl Default for WhatsAppAdapter {
    fn default() -> Self {
        Self::new(default_path(
            "Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite",
        ))
    }
}

impl SourceAdapter for WhatsAppAdapter {
    fn source(&self) -> SourceId {
        SourceId::Whatsapp
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
        let chat_columns = columns(&connection, "ZWACHATSESSION")?;
        let title_column = ["ZPARTNERNAME", "ZSESSIONNAME", "ZCONTACTJID"]
            .into_iter()
            .find(|column| chat_columns.contains(*column))
            .unwrap_or("ZCONTACTJID");
        let query = format!(
            "SELECT m.Z_PK, m.Z_OPT, m.ZSTANZAID, m.ZTEXT, m.ZMESSAGEDATE,
                    m.ZISFROMME, m.ZFROMJID, cs.ZCONTACTJID, cs.{title_column},
                    gm.ZMEMBERJID,
                    CAST(COALESCE(m.ZMESSAGEDATE, 0) * 1000000 AS INTEGER) AS sort_value
               FROM ZWAMESSAGE m
               LEFT JOIN ZWACHATSESSION cs ON cs.Z_PK = m.ZCHATSESSION
               LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER
              WHERE (sort_value > ?1 OR (sort_value = ?1 AND m.Z_PK > ?2))
                AND m.ZSTANZAID IS NOT NULL AND m.ZSTANZAID <> ''
                AND m.ZTEXT IS NOT NULL AND m.ZTEXT <> ''
              ORDER BY sort_value, m.Z_PK"
        );
        let mut statement = connection.prepare(&query)?;
        let mut rows = statement.query(params![cursor.sort_value, cursor.row_id])?;
        let mut records = Vec::new();
        let mut high_water = cursor;
        let mut high_watermark_ms = None;
        while let Some(row) = rows.next()? {
            let row_id: i64 = row.get(0)?;
            let version: i64 = row.get(1)?;
            let stanza_id: String = row.get(2)?;
            let text: String = row.get(3)?;
            let timestamp: f64 = row.get::<_, Option<f64>>(4)?.unwrap_or(0.0);
            let authored_by_me = row.get::<_, i64>(5)? != 0;
            let from_jid: Option<String> = row.get(6)?;
            let chat_jid: Option<String> = row.get(7)?;
            let chat_title: Option<String> = row.get(8)?;
            let member_jid: Option<String> = row.get(9)?;
            let sort_value: i64 = row.get(10)?;
            high_water = AdapterCursor {
                source: self.source(),
                sort_value,
                row_id,
            };
            high_watermark_ms = Some(core_data_to_unix_ms(timestamp));
            let thread_id = chat_jid.filter(|value| !value.is_empty());
            let source_id = format!(
                "{}:{stanza_id}",
                thread_id.as_deref().unwrap_or("unknown-thread")
            );
            let participant_id = member_jid.or_else(|| {
                from_jid.filter(|value| !value.is_empty() && !value.ends_with("@g.us"))
            });
            let revision = stable_revision(&[
                source_id.as_bytes(),
                version.to_string().as_bytes(),
                text.as_bytes(),
                participant_id.as_deref().unwrap_or_default().as_bytes(),
                if authored_by_me { b"1" } else { b"0" },
            ]);
            let record = SourceRecord {
                source_id,
                revision,
                occurred_at_ms: Some(core_data_to_unix_ms(timestamp)),
                text,
                thread_id,
                thread_title: chat_title,
                participant_id,
                authored_by_me,
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

fn core_data_to_unix_ms(value: f64) -> i64 {
    (value * 1_000.0).round() as i64 + CORE_DATA_EPOCH_MS
}
