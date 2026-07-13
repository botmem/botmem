use crate::protocol::{
    DeviceSearchItem, DeviceSearchQuery, MediaDescriptor, Participant, ProtocolError, Thread,
};
use crate::state::SourceId;
use crate::storage::{DeviceStore, StoreError};
use chrono::{SecondsFormat, TimeZone, Utc};
use rusqlite::{named_params, ErrorCode};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use thiserror::Error;

const SEARCH_SQL: &str = "FROM document_fts
       JOIN documents d ON d.rowid = document_fts.rowid
       JOIN source_state s
         ON s.source = d.source AND s.active_generation = d.generation
      WHERE document_fts MATCH :fts_query
        AND (:connectors_json IS NULL OR d.source IN (
              SELECT value FROM json_each(:connectors_json)
            ))
        AND (:from_ms IS NULL OR d.occurred_at_ms >= :from_ms)
        AND (:to_ms IS NULL OR d.occurred_at_ms <= :to_ms)
        AND (:participant_id IS NULL OR EXISTS (
              SELECT 1 FROM json_each(d.payload_json, '$.participants') participant
               WHERE json_extract(participant.value, '$.durableId') = :participant_id
            ))
        AND (:authored_by_me IS NULL OR
             json_extract(d.payload_json, '$.authoredByMe') = :authored_by_me)";

const FUZZY_SEARCH_SQL: &str = "FROM (
        SELECT token.document_rowid
          FROM document_tokens token
          JOIN json_each(:term_matches_json) matched
            ON token.token = json_extract(matched.value, '$.token')
         GROUP BY token.document_rowid
        HAVING COUNT(DISTINCT json_extract(matched.value, '$.group')) = :term_group_count
       ) candidate
       JOIN documents d ON d.rowid = candidate.document_rowid
       JOIN source_state s
         ON s.source = d.source AND s.active_generation = d.generation
      WHERE (:connectors_json IS NULL OR d.source IN (
              SELECT value FROM json_each(:connectors_json)
            ))
        AND (:from_ms IS NULL OR d.occurred_at_ms >= :from_ms)
        AND (:to_ms IS NULL OR d.occurred_at_ms <= :to_ms)
        AND (:participant_id IS NULL OR EXISTS (
              SELECT 1 FROM json_each(d.payload_json, '$.participants') participant
               WHERE json_extract(participant.value, '$.durableId') = :participant_id
            ))
        AND (:authored_by_me IS NULL OR
             json_extract(d.payload_json, '$.authoredByMe') = :authored_by_me)";

#[derive(Debug, Clone, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LocalSearchResponse {
    pub items: Vec<DeviceSearchItem>,
    pub found: u64,
    /// The launch protocol deliberately keeps local result content out of
    /// hosted cursors. Federation can request a larger bounded device page.
    pub next_cursor: Option<String>,
    pub took_ms: u64,
}

pub struct LocalSearchService<'a> {
    store: &'a DeviceStore,
}

impl<'a> LocalSearchService<'a> {
    pub fn new(store: &'a DeviceStore) -> Self {
        Self { store }
    }

    pub fn search(
        &self,
        query: &DeviceSearchQuery,
        deadline: Instant,
        cancellation: CancellationToken,
    ) -> Result<LocalSearchResponse, LocalSearchError> {
        let started = Instant::now();
        query.validate()?;
        if query.cursor.is_some() {
            return Err(LocalSearchError::UnsupportedCursor);
        }
        ensure_running(deadline, &cancellation)?;

        let fts_query = build_prefix_query(&query.query)?;
        let connectors_json = query
            .connectors
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let from_ms = query.from.as_deref().map(parse_timestamp_ms).transpose()?;
        let to_ms = query.to.as_deref().map(parse_timestamp_ms).transpose()?;
        let authored_by_me = query.authored_by_me.map(i64::from);

        let deadline_for_hook = deadline;
        let cancellation_for_hook = cancellation.clone();
        self.store.connection.progress_handler(
            1_000,
            Some(move || {
                cancellation_for_hook.is_cancelled() || Instant::now() >= deadline_for_hook
            }),
        );

        let result = (|| -> Result<LocalSearchResponse, LocalSearchError> {
            let count_sql = format!("SELECT COUNT(*) {SEARCH_SQL}");
            let found: u64 = self.store.connection.query_row(
                &count_sql,
                named_params! {
                    ":fts_query": fts_query,
                    ":connectors_json": connectors_json,
                    ":from_ms": from_ms,
                    ":to_ms": to_ms,
                    ":participant_id": query.participant_id,
                    ":authored_by_me": authored_by_me,
                },
                |row| row.get(0),
            )?;
            ensure_running(deadline, &cancellation)?;

            if found == 0 {
                let Some((term_matches_json, term_group_count)) =
                    fuzzy_term_matches(&self.store.connection, &query.query)?
                else {
                    return Ok(LocalSearchResponse {
                        items: Vec::new(),
                        found: 0,
                        next_cursor: None,
                        took_ms: elapsed_ms(started.elapsed()),
                    });
                };
                let count_sql = format!("SELECT COUNT(*) FROM (SELECT d.rowid {FUZZY_SEARCH_SQL})");
                let fuzzy_found: u64 = self.store.connection.query_row(
                    &count_sql,
                    named_params! {
                        ":term_matches_json": term_matches_json,
                        ":term_group_count": term_group_count,
                        ":connectors_json": connectors_json,
                        ":from_ms": from_ms,
                        ":to_ms": to_ms,
                        ":participant_id": query.participant_id,
                        ":authored_by_me": authored_by_me,
                    },
                    |row| row.get(0),
                )?;
                ensure_running(deadline, &cancellation)?;
                let select_sql = format!(
                    "SELECT d.source, d.source_id, d.revision, d.occurred_at_ms,
                            d.searchable_text, d.payload_json
                       {FUZZY_SEARCH_SQL}
                      ORDER BY d.occurred_at_ms DESC NULLS LAST,
                               d.source ASC,
                               d.source_id ASC
                      LIMIT :limit"
                );
                let mut statement = self.store.connection.prepare(&select_sql)?;
                let rows = statement.query_map(
                    named_params! {
                        ":term_matches_json": term_matches_json,
                        ":term_group_count": term_group_count,
                        ":connectors_json": connectors_json,
                        ":from_ms": from_ms,
                        ":to_ms": to_ms,
                        ":participant_id": query.participant_id,
                        ":authored_by_me": authored_by_me,
                        ":limit": query.limit,
                    },
                    search_row,
                )?;
                let mut items = Vec::new();
                for row in rows {
                    ensure_running(deadline, &cancellation)?;
                    items.push(row?.into_item()?);
                }
                return Ok(LocalSearchResponse {
                    items,
                    found: fuzzy_found,
                    next_cursor: None,
                    took_ms: elapsed_ms(started.elapsed()),
                });
            }

            let select_sql = format!(
                "SELECT d.source, d.source_id, d.revision, d.occurred_at_ms,
                        d.searchable_text, d.payload_json, bm25(document_fts) AS lexical_rank
                   {SEARCH_SQL}
                  ORDER BY lexical_rank ASC,
                           d.occurred_at_ms DESC NULLS LAST,
                           d.source ASC,
                           d.source_id ASC
                  LIMIT :limit"
            );
            let mut statement = self.store.connection.prepare(&select_sql)?;
            let rows = statement.query_map(
                named_params! {
                    ":fts_query": fts_query,
                    ":connectors_json": connectors_json,
                    ":from_ms": from_ms,
                    ":to_ms": to_ms,
                    ":participant_id": query.participant_id,
                    ":authored_by_me": authored_by_me,
                    ":limit": query.limit,
                },
                search_row,
            )?;
            let mut items = Vec::new();
            for row in rows {
                ensure_running(deadline, &cancellation)?;
                items.push(row?.into_item()?);
            }
            Ok(LocalSearchResponse {
                items,
                found,
                next_cursor: None,
                took_ms: elapsed_ms(started.elapsed()),
            })
        })();

        self.store
            .connection
            .progress_handler(0, None::<fn() -> bool>);
        match result {
            Err(LocalSearchError::Store(StoreError::Database(error))) if is_interrupted(&error) => {
                ensure_running(deadline, &cancellation)?;
                Err(LocalSearchError::Store(StoreError::Database(error)))
            }
            other => other,
        }
    }

    /// Diagnostic only: callers can verify that SQLite selected the FTS
    /// virtual-table path without exposing message content.
    pub fn explain_query_plan(
        &self,
        query: &DeviceSearchQuery,
    ) -> Result<Vec<String>, LocalSearchError> {
        query.validate()?;
        let fts_query = build_prefix_query(&query.query)?;
        let connectors_json = query
            .connectors
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let from_ms = query.from.as_deref().map(parse_timestamp_ms).transpose()?;
        let to_ms = query.to.as_deref().map(parse_timestamp_ms).transpose()?;
        let authored_by_me = query.authored_by_me.map(i64::from);
        let sql = format!("EXPLAIN QUERY PLAN SELECT d.rowid {SEARCH_SQL} LIMIT :limit");
        let mut statement = self.store.connection.prepare(&sql)?;
        let rows = statement.query_map(
            named_params! {
                ":fts_query": fts_query,
                ":connectors_json": connectors_json,
                ":from_ms": from_ms,
                ":to_ms": to_ms,
                ":participant_id": query.participant_id,
                ":authored_by_me": authored_by_me,
                ":limit": query.limit,
            },
            |row| row.get(3),
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
            .map_err(LocalSearchError::from)
    }
}

#[derive(Debug)]
struct SearchRow {
    source: String,
    source_id: String,
    revision: String,
    occurred_at_ms: Option<i64>,
    text: String,
    payload_json: String,
}

fn search_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SearchRow> {
    Ok(SearchRow {
        source: row.get(0)?,
        source_id: row.get(1)?,
        revision: row.get(2)?,
        occurred_at_ms: row.get(3)?,
        text: row.get(4)?,
        payload_json: row.get(5)?,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPayload {
    #[serde(default)]
    thread: Option<Thread>,
    #[serde(default)]
    participants: Vec<Participant>,
    #[serde(default)]
    media: Vec<MediaDescriptor>,
    #[serde(default)]
    authored_by_me: Option<bool>,
}

impl SearchRow {
    fn into_item(self) -> Result<DeviceSearchItem, LocalSearchError> {
        let connector = SourceId::try_from(self.source.as_str())?;
        let payload: StoredPayload = serde_json::from_str(&self.payload_json)?;
        let occurred_at = self
            .occurred_at_ms
            .map(|millis| {
                Utc.timestamp_millis_opt(millis)
                    .single()
                    .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
                    .ok_or(LocalSearchError::InvalidTimestamp)
            })
            .transpose()?;
        Ok(DeviceSearchItem {
            r#ref: format!("{}:{}", connector.as_str(), self.source_id),
            source_id: self.source_id,
            revision: self.revision,
            connector,
            occurred_at,
            title: None,
            text: self.text,
            thread: payload.thread,
            participants: payload.participants,
            media: payload.media,
            authored_by_me: payload.authored_by_me,
        })
    }
}

fn build_prefix_query(query: &str) -> Result<String, LocalSearchError> {
    let normalized = normalize_search_text(query);
    let tokens = normalized
        .split(|character: char| !character.is_alphanumeric() && character != '_')
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    if tokens.is_empty() {
        return Err(LocalSearchError::NoSearchTokens);
    }
    Ok(tokens
        .iter()
        .map(|token| format!("\"{}\"*", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND "))
}

pub(crate) fn normalize_search_text(input: &str) -> String {
    input
        .chars()
        .filter_map(|character| match character {
            '\u{0640}' | '\u{064b}'..='\u{065f}' | '\u{0670}' | '\u{06d6}'..='\u{06ed}' => None,
            '\u{0622}' | '\u{0623}' | '\u{0625}' | '\u{0671}' => Some('\u{0627}'),
            '\u{0649}' | '\u{0626}' => Some('\u{064a}'),
            '\u{0624}' => Some('\u{0648}'),
            other => Some(other),
        })
        .flat_map(char::to_lowercase)
        .collect()
}

pub(crate) fn search_bigrams_json(input: &str) -> Result<String, serde_json::Error> {
    let mut bigrams = BTreeSet::new();
    for token in search_tokens(&normalize_search_text(input)) {
        let characters = token.chars().collect::<Vec<_>>();
        if !(4..=64).contains(&characters.len()) {
            continue;
        }
        for pair in characters.windows(2) {
            bigrams.insert(pair.iter().collect::<String>());
        }
    }
    serde_json::to_string(&bigrams.into_iter().collect::<Vec<_>>())
}

pub(crate) fn search_tokens_json(input: &str) -> Result<String, serde_json::Error> {
    let normalized = normalize_search_text(input);
    let tokens = search_tokens(&normalized)
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    serde_json::to_string(&tokens)
}

fn search_tokens(input: &str) -> Vec<&str> {
    input
        .split(|character: char| !character.is_alphanumeric() && character != '_')
        .filter(|token| !token.is_empty())
        .collect()
}

pub(crate) fn within_edit_distance(left: &str, right: &str, maximum: usize) -> bool {
    let left = left.chars().collect::<Vec<_>>();
    let right = right.chars().collect::<Vec<_>>();
    if left.len().abs_diff(right.len()) > maximum {
        return false;
    }
    let mut previous = (0..=right.len()).collect::<Vec<_>>();
    let mut current = vec![0; right.len() + 1];
    for (left_index, left_character) in left.iter().enumerate() {
        current[0] = left_index + 1;
        let mut row_minimum = current[0];
        for (right_index, right_character) in right.iter().enumerate() {
            let substitution =
                previous[right_index] + usize::from(left_character != right_character);
            let insertion = current[right_index] + 1;
            let deletion = previous[right_index + 1] + 1;
            current[right_index + 1] = substitution.min(insertion).min(deletion);
            row_minimum = row_minimum.min(current[right_index + 1]);
        }
        if row_minimum > maximum {
            return false;
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[right.len()] <= maximum
}

#[derive(Serialize)]
struct FuzzyTermMatch<'a> {
    group: usize,
    token: &'a str,
}

fn fuzzy_term_matches(
    connection: &rusqlite::Connection,
    query: &str,
) -> Result<Option<(String, usize)>, LocalSearchError> {
    let normalized = normalize_search_text(query);
    let query_tokens = search_tokens(&normalized);
    if query_tokens.is_empty() || query_tokens.iter().any(|token| token.chars().count() > 64) {
        return Ok(None);
    }
    let mut groups = Vec::<Vec<String>>::with_capacity(query_tokens.len());
    for query_token in query_tokens {
        let query_length = query_token.chars().count();
        let terms = if query_length < 4 {
            let pattern = format!("{query_token}*");
            let mut statement = connection.prepare(
                "SELECT DISTINCT token FROM document_tokens
                  WHERE token GLOB ?1 ORDER BY token",
            )?;
            let found = statement
                .query_map([pattern], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            found
        } else {
            let maximum = if query_length <= 8 { 1_i64 } else { 2_i64 };
            let bigrams_json = search_bigrams_json(query_token)?;
            let mut statement = connection.prepare(
                "SELECT DISTINCT token
                   FROM token_bigrams
                  WHERE bigram IN (SELECT value FROM json_each(?1))
                    AND botmem_token_within(?2, token, ?3) = 1
                  ORDER BY token",
            )?;
            let found = statement
                .query_map(
                    rusqlite::params![bigrams_json, query_token, maximum],
                    |row| row.get::<_, String>(0),
                )?
                .collect::<Result<Vec<_>, _>>()?;
            found
        };
        if terms.is_empty() {
            return Ok(None);
        }
        groups.push(terms);
    }
    let matches = groups
        .iter()
        .enumerate()
        .flat_map(|(group, terms)| {
            terms
                .iter()
                .map(move |token| FuzzyTermMatch { group, token })
        })
        .collect::<Vec<_>>();
    Ok(Some((serde_json::to_string(&matches)?, groups.len())))
}

fn parse_timestamp_ms(value: &str) -> Result<i64, LocalSearchError> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.timestamp_millis())
        .map_err(|_| LocalSearchError::InvalidTimestamp)
}

fn elapsed_ms(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

fn ensure_running(
    deadline: Instant,
    cancellation: &CancellationToken,
) -> Result<(), LocalSearchError> {
    if cancellation.is_cancelled() {
        return Err(LocalSearchError::Cancelled);
    }
    if Instant::now() >= deadline {
        return Err(LocalSearchError::DeadlineExceeded);
    }
    Ok(())
}

fn is_interrupted(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(inner, _)
            if inner.code == ErrorCode::OperationInterrupted
    )
}

#[derive(Debug, Error)]
pub enum LocalSearchError {
    #[error("local search deadline exceeded")]
    DeadlineExceeded,
    #[error("local search was cancelled")]
    Cancelled,
    #[error("local search cursor is not supported; callers must use bounded federation")]
    UnsupportedCursor,
    #[error("search query contains no indexable tokens")]
    NoSearchTokens,
    #[error("stored message has an invalid timestamp")]
    InvalidTimestamp,
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    State(#[from] crate::state::StateError),
}

impl From<rusqlite::Error> for LocalSearchError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Store(StoreError::Database(error))
    }
}
