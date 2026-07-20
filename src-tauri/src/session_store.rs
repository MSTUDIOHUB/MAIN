use rusqlite::{
    params, Connection, Error as SqliteError, ErrorCode, OptionalExtension, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fmt;
use std::fs;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const SESSION_STORE_SCHEMA_VERSION: u32 = 2;
pub const DEFAULT_BUSY_TIMEOUT_MS: u64 = 5_000;
const MAX_BUSY_TIMEOUT_MS: u64 = 60_000;
const MAX_IDENTITY_BYTES: usize = 16 * 1_024;
const MAX_SNAPSHOT_BYTES: usize = 64 * 1_024 * 1_024;

pub type SessionStoreResult<T> = Result<T, SessionStoreError>;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionStoreErrorCode {
    InvalidInput,
    RevisionConflict,
    DeadlineExceeded,
    CorruptData,
    UnsupportedSchema,
    DatabaseBusy,
    Database,
    Io,
    LockPoisoned,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionStoreError {
    pub code: SessionStoreErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl SessionStoreError {
    fn new(code: SessionStoreErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            entity: None,
            details: None,
        }
    }

    fn with_entity(mut self, entity: impl Into<String>) -> Self {
        self.entity = Some(entity.into());
        self
    }

    fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    fn invalid(field: &str, message: impl Into<String>) -> Self {
        Self::new(SessionStoreErrorCode::InvalidInput, message).with_entity(field)
    }

    fn corrupt(entity: &str, message: impl Into<String>) -> Self {
        Self::new(SessionStoreErrorCode::CorruptData, message).with_entity(entity)
    }

    fn database(error: SqliteError) -> Self {
        let code = match &error {
            SqliteError::SqliteFailure(failure, _)
                if matches!(
                    failure.code,
                    ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
                ) =>
            {
                SessionStoreErrorCode::DatabaseBusy
            }
            _ => SessionStoreErrorCode::Database,
        };
        Self::new(
            code,
            format!("SQLite session store operation failed: {error}"),
        )
    }
}

impl fmt::Display for SessionStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for SessionStoreError {}

impl From<SqliteError> for SessionStoreError {
    fn from(error: SqliteError) -> Self {
        Self::database(error)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionStoreOptions {
    pub busy_timeout_ms: u64,
}

impl Default for SessionStoreOptions {
    fn default() -> Self {
        Self {
            busy_timeout_ms: DEFAULT_BUSY_TIMEOUT_MS,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionStoreSchemaInfo {
    pub schema_version: u32,
    pub busy_timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct SessionKey {
    pub workspace: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshotRecord {
    pub workspace: String,
    pub session_id: String,
    pub revision: u64,
    pub snapshot: Value,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportLegacySnapshotIfAbsentRequest {
    pub key: SessionKey,
    pub snapshot: Value,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportLegacySnapshotIfAbsentResult {
    pub imported: bool,
    pub snapshot: SessionSnapshotRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionSnapshotResult {
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClearWorkspaceResult {
    pub deleted_sessions: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyWorkspaceImportRecord {
    pub workspace: String,
    pub imported_at_ms: i64,
    pub imported_sessions: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompareAndSwapSessionSnapshotRequest {
    pub key: SessionKey,
    pub expected_revision: u64,
    pub snapshot: Value,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompareAndSwapSessionSnapshotResult {
    pub snapshot: SessionSnapshotRecord,
}

/// SQLite owns only opaque Session snapshot bytes and their CAS revision.
/// Runtime FIFO, receipts, attempts, and execution ownership remain in TypeScript.
pub struct SessionStore {
    connection: Mutex<Connection>,
    options: SessionStoreOptions,
}

impl SessionStore {
    pub fn open(path: impl AsRef<Path>) -> SessionStoreResult<Self> {
        Self::open_with_options(path, SessionStoreOptions::default())
    }

    pub fn open_with_options(
        path: impl AsRef<Path>,
        options: SessionStoreOptions,
    ) -> SessionStoreResult<Self> {
        validate_options(&options)?;
        let path = path.as_ref();
        if path.as_os_str().is_empty() {
            return Err(SessionStoreError::invalid(
                "path",
                "Session store path must not be empty.",
            ));
        }
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent).map_err(|error| {
                SessionStoreError::new(
                    SessionStoreErrorCode::Io,
                    format!(
                        "Failed to create session store directory {}: {error}",
                        parent.display()
                    ),
                )
                .with_entity("path")
            })?;
        }
        let connection = Connection::open(path).map_err(SessionStoreError::database)?;
        Self::from_connection(connection, options)
    }

    fn from_connection(
        mut connection: Connection,
        options: SessionStoreOptions,
    ) -> SessionStoreResult<Self> {
        validate_options(&options)?;
        configure_connection(&mut connection, &options)?;
        migrate_schema(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            options,
        })
    }

    #[cfg(test)]
    fn open_in_memory_with_options(options: SessionStoreOptions) -> SessionStoreResult<Self> {
        let connection = Connection::open_in_memory().map_err(SessionStoreError::database)?;
        Self::from_connection(connection, options)
    }

    pub fn schema_info(&self) -> SessionStoreResult<SessionStoreSchemaInfo> {
        let connection = self.lock_connection()?;
        Ok(SessionStoreSchemaInfo {
            schema_version: read_schema_version(&connection)?,
            busy_timeout_ms: self.options.busy_timeout_ms,
        })
    }

    pub fn get_session_snapshot(
        &self,
        key: &SessionKey,
    ) -> SessionStoreResult<Option<SessionSnapshotRecord>> {
        validate_session_key(key)?;
        let connection = self.lock_connection()?;
        read_session_snapshot(&connection, key)
    }

    pub fn list_session_snapshots(
        &self,
        workspace: &str,
    ) -> SessionStoreResult<Vec<SessionSnapshotRecord>> {
        validate_identity("workspace", workspace)?;
        let connection = self.lock_connection()?;
        let mut statement = connection
            .prepare(
                "SELECT workspace, session_id, revision, snapshot_json, updated_at_ms FROM session_snapshots WHERE workspace = ?1 ORDER BY updated_at_ms DESC, session_id ASC",
            )
            .map_err(SessionStoreError::database)?;
        let rows = statement
            .query_map(params![workspace], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(SessionStoreError::database)?;
        rows.map(|row| {
            row.map_err(SessionStoreError::database)
                .and_then(decode_session_snapshot_row)
        })
        .collect()
    }

    pub fn import_legacy_snapshot_if_absent(
        &self,
        request: ImportLegacySnapshotIfAbsentRequest,
    ) -> SessionStoreResult<ImportLegacySnapshotIfAbsentResult> {
        validate_session_key(&request.key)?;
        validate_timestamp("updatedAtMs", request.updated_at_ms)?;
        let snapshot_json = serialize_snapshot(&request.snapshot)?;
        let mut connection = self.lock_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(SessionStoreError::database)?;
        if let Some(existing) = read_session_snapshot(&transaction, &request.key)? {
            transaction.commit().map_err(SessionStoreError::database)?;
            return Ok(ImportLegacySnapshotIfAbsentResult {
                imported: false,
                snapshot: existing,
            });
        }
        transaction
            .execute(
                "INSERT INTO session_snapshots (workspace, session_id, revision, snapshot_json, updated_at_ms) VALUES (?1, ?2, 1, ?3, ?4)",
                params![
                    &request.key.workspace,
                    &request.key.session_id,
                    &snapshot_json,
                    request.updated_at_ms,
                ],
            )
            .map_err(SessionStoreError::database)?;
        transaction.commit().map_err(SessionStoreError::database)?;
        Ok(ImportLegacySnapshotIfAbsentResult {
            imported: true,
            snapshot: SessionSnapshotRecord {
                workspace: request.key.workspace,
                session_id: request.key.session_id,
                revision: 1,
                snapshot: request.snapshot,
                updated_at_ms: request.updated_at_ms,
            },
        })
    }

    pub fn get_legacy_workspace_import(
        &self,
        workspace: &str,
    ) -> SessionStoreResult<Option<LegacyWorkspaceImportRecord>> {
        validate_identity("workspace", workspace)?;
        let connection = self.lock_connection()?;
        connection
            .query_row(
                "SELECT workspace, imported_at_ms, imported_sessions FROM legacy_workspace_imports WHERE workspace = ?1",
                params![workspace],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(SessionStoreError::database)?
            .map(|(workspace, imported_at_ms, imported_sessions)| {
                if imported_at_ms < 0 {
                    return Err(SessionStoreError::corrupt(
                        "legacy_workspace_imports.imported_at_ms",
                        "Legacy workspace import timestamp is negative.",
                    ));
                }
                Ok(LegacyWorkspaceImportRecord {
                    workspace,
                    imported_at_ms,
                    imported_sessions: from_sql_u64(
                        "legacy_workspace_imports.imported_sessions",
                        imported_sessions,
                    )?,
                })
            })
            .transpose()
    }

    pub fn mark_legacy_workspace_imported(
        &self,
        record: LegacyWorkspaceImportRecord,
    ) -> SessionStoreResult<LegacyWorkspaceImportRecord> {
        validate_identity("workspace", &record.workspace)?;
        validate_timestamp("importedAtMs", record.imported_at_ms)?;
        let imported_sessions = to_sql_u64("importedSessions", record.imported_sessions)?;
        let mut connection = self.lock_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(SessionStoreError::database)?;
        transaction
            .execute(
                "INSERT INTO legacy_workspace_imports (workspace, imported_at_ms, imported_sessions) VALUES (?1, ?2, ?3) ON CONFLICT(workspace) DO NOTHING",
                params![&record.workspace, record.imported_at_ms, imported_sessions],
            )
            .map_err(SessionStoreError::database)?;
        let stored = transaction
            .query_row(
                "SELECT workspace, imported_at_ms, imported_sessions FROM legacy_workspace_imports WHERE workspace = ?1",
                params![&record.workspace],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .map_err(SessionStoreError::database)?;
        transaction.commit().map_err(SessionStoreError::database)?;
        Ok(LegacyWorkspaceImportRecord {
            workspace: stored.0,
            imported_at_ms: stored.1,
            imported_sessions: from_sql_u64(
                "legacy_workspace_imports.imported_sessions",
                stored.2,
            )?,
        })
    }

    pub fn delete_session_snapshot(
        &self,
        key: &SessionKey,
    ) -> SessionStoreResult<DeleteSessionSnapshotResult> {
        validate_session_key(key)?;
        let mut connection = self.lock_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(SessionStoreError::database)?;
        let deleted = transaction
            .execute(
                "DELETE FROM session_snapshots WHERE workspace = ?1 AND session_id = ?2",
                params![&key.workspace, &key.session_id],
            )
            .map_err(SessionStoreError::database)?;
        transaction.commit().map_err(SessionStoreError::database)?;
        Ok(DeleteSessionSnapshotResult {
            deleted: deleted == 1,
        })
    }

    pub fn clear_workspace(&self, workspace: &str) -> SessionStoreResult<ClearWorkspaceResult> {
        validate_identity("workspace", workspace)?;
        let mut connection = self.lock_connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(SessionStoreError::database)?;
        let deleted_sessions = transaction
            .execute(
                "DELETE FROM session_snapshots WHERE workspace = ?1",
                params![workspace],
            )
            .map_err(SessionStoreError::database)?;
        transaction.commit().map_err(SessionStoreError::database)?;
        Ok(ClearWorkspaceResult {
            deleted_sessions: deleted_sessions as u64,
        })
    }

    pub fn compare_and_swap_session_snapshot(
        &self,
        request: CompareAndSwapSessionSnapshotRequest,
    ) -> SessionStoreResult<CompareAndSwapSessionSnapshotResult> {
        self.compare_and_swap_session_snapshot_before(request, None)
    }

    /// Commit one opaque snapshot only while its TypeScript mutation lease is
    /// live. The deadline is checked after lock/transaction acquisition and
    /// again immediately before commit, so a JavaScript queue timeout cannot
    /// release a late writer across a newer save/delete/clear mutation.
    pub fn compare_and_swap_session_snapshot_before(
        &self,
        request: CompareAndSwapSessionSnapshotRequest,
        mutation_deadline_ms: Option<i64>,
    ) -> SessionStoreResult<CompareAndSwapSessionSnapshotResult> {
        validate_session_key(&request.key)?;
        validate_timestamp("updatedAtMs", request.updated_at_ms)?;
        ensure_mutation_deadline(mutation_deadline_ms)?;
        let expected_revision = to_sql_u64("expectedRevision", request.expected_revision)?;
        let snapshot_json = serialize_snapshot(&request.snapshot)?;

        let mut connection = self.lock_connection()?;
        ensure_mutation_deadline(mutation_deadline_ms)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(SessionStoreError::database)?;
        ensure_mutation_deadline(mutation_deadline_ms)?;
        let current_revision = transaction
            .query_row(
                "SELECT revision FROM session_snapshots WHERE workspace = ?1 AND session_id = ?2",
                params![&request.key.workspace, &request.key.session_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(SessionStoreError::database)?;

        if current_revision != Some(expected_revision)
            && !(current_revision.is_none() && expected_revision == 0)
        {
            return Err(SessionStoreError::new(
                SessionStoreErrorCode::RevisionConflict,
                "Session snapshot revision no longer matches the expected owner.",
            )
            .with_entity("session_snapshot")
            .with_details(json!({
                "workspace": request.key.workspace,
                "sessionId": request.key.session_id,
                "expectedRevision": request.expected_revision,
                "actualRevision": current_revision,
            })));
        }

        let next_revision = request.expected_revision.checked_add(1).ok_or_else(|| {
            SessionStoreError::invalid("expectedRevision", "Session revision overflowed.")
        })?;
        let next_revision_sql = to_sql_u64("nextRevision", next_revision)?;
        if current_revision.is_none() {
            transaction
                .execute(
                    "INSERT INTO session_snapshots (workspace, session_id, revision, snapshot_json, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        &request.key.workspace,
                        &request.key.session_id,
                        next_revision_sql,
                        &snapshot_json,
                        request.updated_at_ms,
                    ],
                )
                .map_err(SessionStoreError::database)?;
        } else {
            let updated = transaction
                .execute(
                    "UPDATE session_snapshots SET revision = ?1, snapshot_json = ?2, updated_at_ms = ?3 WHERE workspace = ?4 AND session_id = ?5 AND revision = ?6",
                    params![
                        next_revision_sql,
                        &snapshot_json,
                        request.updated_at_ms,
                        &request.key.workspace,
                        &request.key.session_id,
                        expected_revision,
                    ],
                )
                .map_err(SessionStoreError::database)?;
            if updated != 1 {
                return Err(SessionStoreError::new(
                    SessionStoreErrorCode::RevisionConflict,
                    "Session snapshot CAS lost ownership during update.",
                )
                .with_entity("session_snapshot"));
            }
        }

        // Returning here drops and rolls back the uncommitted transaction.
        // No snapshot modified under an expired lease can become visible.
        ensure_mutation_deadline(mutation_deadline_ms)?;
        transaction.commit().map_err(SessionStoreError::database)?;
        Ok(CompareAndSwapSessionSnapshotResult {
            snapshot: SessionSnapshotRecord {
                workspace: request.key.workspace,
                session_id: request.key.session_id,
                revision: next_revision,
                snapshot: request.snapshot,
                updated_at_ms: request.updated_at_ms,
            },
        })
    }

    fn lock_connection(&self) -> SessionStoreResult<MutexGuard<'_, Connection>> {
        self.connection.lock().map_err(|_| {
            SessionStoreError::new(
                SessionStoreErrorCode::LockPoisoned,
                "Session store connection lock is poisoned.",
            )
        })
    }
}

fn session_store_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(i64::MAX)
}

fn ensure_mutation_deadline(mutation_deadline_ms: Option<i64>) -> SessionStoreResult<()> {
    let Some(deadline_ms) = mutation_deadline_ms else {
        return Ok(());
    };
    validate_timestamp("mutationDeadlineMs", deadline_ms)?;
    let observed_at_ms = session_store_now_ms();
    if observed_at_ms < deadline_ms {
        return Ok(());
    }
    Err(SessionStoreError::new(
        SessionStoreErrorCode::DeadlineExceeded,
        "Session snapshot mutation lease expired before commit.",
    )
    .with_entity("session_snapshot")
    .with_details(json!({
        "mutationDeadlineMs": deadline_ms,
        "observedAtMs": observed_at_ms,
    })))
}

fn validate_options(options: &SessionStoreOptions) -> SessionStoreResult<()> {
    if options.busy_timeout_ms == 0 || options.busy_timeout_ms > MAX_BUSY_TIMEOUT_MS {
        return Err(SessionStoreError::invalid(
            "busyTimeoutMs",
            format!("Busy timeout must be between 1 and {MAX_BUSY_TIMEOUT_MS} milliseconds."),
        ));
    }
    Ok(())
}

fn configure_connection(
    connection: &mut Connection,
    options: &SessionStoreOptions,
) -> SessionStoreResult<()> {
    connection
        .busy_timeout(Duration::from_millis(options.busy_timeout_ms))
        .map_err(SessionStoreError::database)?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;\nPRAGMA journal_mode = WAL;\nPRAGMA synchronous = FULL;",
        )
        .map_err(SessionStoreError::database)?;
    Ok(())
}

fn read_schema_version(connection: &Connection) -> SessionStoreResult<u32> {
    let version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(SessionStoreError::database)?;
    if version < 0 || version > u32::MAX as i64 {
        return Err(SessionStoreError::corrupt(
            "schema",
            format!("Invalid SQLite user_version: {version}"),
        ));
    }
    Ok(version as u32)
}

fn migrate_schema(connection: &mut Connection) -> SessionStoreResult<()> {
    let version = read_schema_version(connection)?;
    if version > SESSION_STORE_SCHEMA_VERSION {
        return Err(unsupported_schema_error(version));
    }
    if version == SESSION_STORE_SCHEMA_VERSION {
        return Ok(());
    }

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(SessionStoreError::database)?;
    let locked_version = read_schema_version(&transaction)?;
    if locked_version > SESSION_STORE_SCHEMA_VERSION {
        return Err(unsupported_schema_error(locked_version));
    }
    if locked_version == SESSION_STORE_SCHEMA_VERSION {
        transaction.commit().map_err(SessionStoreError::database)?;
        return Ok(());
    }

    if locked_version == 0 {
        transaction
            .execute_batch(
                r#"
                CREATE TABLE session_store_schema_migrations (
                    version INTEGER PRIMARY KEY CHECK (version > 0),
                    applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
                ) STRICT;

                CREATE TABLE session_snapshots (
                    workspace TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    revision INTEGER NOT NULL CHECK (revision > 0),
                    snapshot_json TEXT NOT NULL,
                    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
                    PRIMARY KEY (workspace, session_id)
                ) STRICT;

                CREATE TABLE legacy_workspace_imports (
                    workspace TEXT PRIMARY KEY,
                    imported_at_ms INTEGER NOT NULL CHECK (imported_at_ms >= 0),
                    imported_sessions INTEGER NOT NULL CHECK (imported_sessions >= 0)
                ) STRICT;

                INSERT INTO session_store_schema_migrations (version, applied_at_ms)
                    VALUES (1, 0), (2, 0);
                PRAGMA user_version = 2;
                "#,
            )
            .map_err(SessionStoreError::database)?;
    } else if locked_version == 1 {
        // Schema v1 briefly introduced Rust-owned semantic queues and leases.
        // They duplicate the TypeScript Session runtime and are intentionally
        // discarded: only the opaque snapshot and its CAS revision survive.
        transaction
            .execute_batch(
                r#"
                DROP TABLE IF EXISTS workspace_turn_outbox;
                DROP TABLE IF EXISTS run_leases;
                INSERT OR IGNORE INTO session_store_schema_migrations (version, applied_at_ms)
                    VALUES (2, 0);
                PRAGMA user_version = 2;
                "#,
            )
            .map_err(SessionStoreError::database)?;
    }

    transaction.commit().map_err(SessionStoreError::database)?;
    Ok(())
}

fn unsupported_schema_error(version: u32) -> SessionStoreError {
    SessionStoreError::new(
        SessionStoreErrorCode::UnsupportedSchema,
        format!(
            "Session store schema {version} is newer than supported schema {SESSION_STORE_SCHEMA_VERSION}."
        ),
    )
    .with_entity("schema")
    .with_details(json!({
        "foundVersion": version,
        "supportedVersion": SESSION_STORE_SCHEMA_VERSION,
    }))
}

fn validate_session_key(key: &SessionKey) -> SessionStoreResult<()> {
    validate_identity("workspace", &key.workspace)?;
    validate_identity("sessionId", &key.session_id)
}

fn validate_identity(field: &str, value: &str) -> SessionStoreResult<()> {
    if value.trim().is_empty() {
        return Err(SessionStoreError::invalid(
            field,
            format!("{field} must not be empty."),
        ));
    }
    if value.trim() != value {
        return Err(SessionStoreError::invalid(
            field,
            format!("{field} must be canonical and cannot contain surrounding whitespace."),
        ));
    }
    if value.len() > MAX_IDENTITY_BYTES {
        return Err(SessionStoreError::invalid(
            field,
            format!("{field} exceeds the maximum identity length."),
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(SessionStoreError::invalid(
            field,
            format!("{field} cannot contain control characters."),
        ));
    }
    Ok(())
}

fn validate_timestamp(field: &str, value: i64) -> SessionStoreResult<()> {
    if value < 0 {
        return Err(SessionStoreError::invalid(
            field,
            format!("{field} must be non-negative."),
        ));
    }
    Ok(())
}

fn serialize_snapshot(value: &Value) -> SessionStoreResult<String> {
    if !value.is_object() {
        return Err(SessionStoreError::invalid(
            "snapshot",
            "snapshot must be a JSON object.",
        ));
    }
    let encoded = serde_json::to_string(value).map_err(|error| {
        SessionStoreError::invalid("snapshot", format!("Failed to serialize snapshot: {error}"))
    })?;
    if encoded.len() > MAX_SNAPSHOT_BYTES {
        return Err(SessionStoreError::invalid(
            "snapshot",
            format!("snapshot exceeds the maximum encoded size of {MAX_SNAPSHOT_BYTES} bytes."),
        ));
    }
    Ok(encoded)
}

fn to_sql_u64(field: &str, value: u64) -> SessionStoreResult<i64> {
    i64::try_from(value).map_err(|_| {
        SessionStoreError::invalid(field, format!("{field} exceeds SQLite integer range."))
    })
}

fn from_sql_u64(field: &str, value: i64) -> SessionStoreResult<u64> {
    u64::try_from(value).map_err(|_| {
        SessionStoreError::corrupt(field, format!("{field} contains a negative integer."))
    })
}

type RawSessionSnapshotRow = (String, String, i64, String, i64);

fn decode_session_snapshot_row(
    raw: RawSessionSnapshotRow,
) -> SessionStoreResult<SessionSnapshotRecord> {
    let snapshot: Value = serde_json::from_str(&raw.3).map_err(|error| {
        SessionStoreError::corrupt(
            "session_snapshots.snapshot_json",
            format!("Stored Session snapshot is not valid JSON: {error}"),
        )
    })?;
    if !snapshot.is_object() {
        return Err(SessionStoreError::corrupt(
            "session_snapshots.snapshot_json",
            "Stored Session snapshot is not a JSON object.",
        ));
    }
    validate_timestamp("session_snapshots.updated_at_ms", raw.4).map_err(|_| {
        SessionStoreError::corrupt(
            "session_snapshots.updated_at_ms",
            "Stored Session timestamp is negative.",
        )
    })?;
    Ok(SessionSnapshotRecord {
        workspace: raw.0,
        session_id: raw.1,
        revision: from_sql_u64("session_snapshots.revision", raw.2)?,
        snapshot,
        updated_at_ms: raw.4,
    })
}

fn read_session_snapshot(
    connection: &Connection,
    key: &SessionKey,
) -> SessionStoreResult<Option<SessionSnapshotRecord>> {
    let raw = connection
        .query_row(
            "SELECT workspace, session_id, revision, snapshot_json, updated_at_ms FROM session_snapshots WHERE workspace = ?1 AND session_id = ?2",
            params![&key.workspace, &key.session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()
        .map_err(SessionStoreError::database)?;
    raw.map(decode_session_snapshot_row).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn key(session_id: &str) -> SessionKey {
        SessionKey {
            workspace: "/workspace/main".to_string(),
            session_id: session_id.to_string(),
        }
    }

    fn create_snapshot(store: &SessionStore, session_key: SessionKey) -> SessionSnapshotRecord {
        store
            .compare_and_swap_session_snapshot(CompareAndSwapSessionSnapshotRequest {
                key: session_key,
                expected_revision: 0,
                snapshot: json!({ "turns": [] }),
                updated_at_ms: 1_000,
            })
            .expect("create snapshot")
            .snapshot
    }

    #[test]
    fn migrates_new_database_to_snapshot_only_schema() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<SessionStore>();

        let store = SessionStore::open_in_memory_with_options(SessionStoreOptions {
            busy_timeout_ms: 321,
        })
        .expect("open store");
        assert_eq!(
            store.schema_info().expect("schema info"),
            SessionStoreSchemaInfo {
                schema_version: SESSION_STORE_SCHEMA_VERSION,
                busy_timeout_ms: 321,
            }
        );
        let connection = store.lock_connection().expect("connection");
        let tables = schema_table_names(&connection);
        assert!(tables.contains(&"session_snapshots".to_string()));
        assert!(tables.contains(&"legacy_workspace_imports".to_string()));
        assert!(!tables.contains(&"workspace_turn_outbox".to_string()));
        assert!(!tables.contains(&"run_leases".to_string()));
    }

    #[test]
    fn v1_semantic_owner_tables_are_dropped_without_losing_snapshots() {
        let connection = Connection::open_in_memory().expect("open SQLite");
        connection
            .execute_batch(
                r#"
                CREATE TABLE session_store_schema_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at_ms INTEGER NOT NULL
                );
                CREATE TABLE session_snapshots (
                    workspace TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    snapshot_json TEXT NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    PRIMARY KEY (workspace, session_id)
                );
                CREATE TABLE legacy_workspace_imports (
                    workspace TEXT PRIMARY KEY,
                    imported_at_ms INTEGER NOT NULL,
                    imported_sessions INTEGER NOT NULL
                );
                CREATE TABLE workspace_turn_outbox (sequence INTEGER PRIMARY KEY);
                CREATE TABLE run_leases (session_id TEXT PRIMARY KEY);
                INSERT INTO session_store_schema_migrations VALUES (1, 0);
                INSERT INTO session_snapshots VALUES (
                    '/workspace/main', 'kept', 4, '{"turns":["kept"]}', 1000
                );
                PRAGMA user_version = 1;
                "#,
            )
            .expect("seed v1 schema");

        let store = SessionStore::from_connection(connection, SessionStoreOptions::default())
            .expect("migrate v1 store");
        assert_eq!(store.schema_info().unwrap().schema_version, 2);
        assert_eq!(
            store
                .get_session_snapshot(&key("kept"))
                .unwrap()
                .unwrap()
                .snapshot,
            json!({ "turns": ["kept"] })
        );
        let connection = store.lock_connection().expect("connection");
        let tables = schema_table_names(&connection);
        assert!(!tables.contains(&"workspace_turn_outbox".to_string()));
        assert!(!tables.contains(&"run_leases".to_string()));
    }

    #[test]
    fn rejects_a_newer_schema_without_mutating_it() {
        let connection = Connection::open_in_memory().expect("open SQLite");
        connection
            .execute_batch("PRAGMA user_version = 99;")
            .expect("set version");
        let error = SessionStore::from_connection(connection, SessionStoreOptions::default())
            .err()
            .expect("new schema must fail closed");
        assert_eq!(error.code, SessionStoreErrorCode::UnsupportedSchema);
    }

    #[test]
    fn snapshot_compare_and_swap_is_monotonic_and_stale_writes_fail_closed() {
        let store = SessionStore::open_in_memory_with_options(SessionStoreOptions::default())
            .expect("open store");
        let session_key = key("snapshot-cas");
        let created = create_snapshot(&store, session_key.clone());
        assert_eq!(created.revision, 1);

        let stale = store
            .compare_and_swap_session_snapshot(CompareAndSwapSessionSnapshotRequest {
                key: session_key.clone(),
                expected_revision: 0,
                snapshot: json!({ "turns": ["stale"] }),
                updated_at_ms: 1_001,
            })
            .expect_err("stale revision must fail");
        assert_eq!(stale.code, SessionStoreErrorCode::RevisionConflict);
        assert_eq!(
            store
                .get_session_snapshot(&session_key)
                .unwrap()
                .unwrap()
                .snapshot,
            json!({ "turns": [] })
        );

        let updated = store
            .compare_and_swap_session_snapshot(CompareAndSwapSessionSnapshotRequest {
                key: session_key,
                expected_revision: 1,
                snapshot: json!({ "turns": ["turn-1"] }),
                updated_at_ms: 1_002,
            })
            .expect("update snapshot");
        assert_eq!(updated.snapshot.revision, 2);
    }

    #[test]
    fn legacy_import_is_create_only_and_idempotent() {
        let store = SessionStore::open_in_memory_with_options(SessionStoreOptions::default())
            .expect("open store");
        let session_key = key("legacy-import");
        let imported = store
            .import_legacy_snapshot_if_absent(ImportLegacySnapshotIfAbsentRequest {
                key: session_key.clone(),
                snapshot: json!({ "source": "legacy" }),
                updated_at_ms: 1_100,
            })
            .expect("import legacy snapshot");
        assert!(imported.imported);
        assert_eq!(imported.snapshot.revision, 1);

        let repeated = store
            .import_legacy_snapshot_if_absent(ImportLegacySnapshotIfAbsentRequest {
                key: session_key,
                snapshot: json!({ "source": "newer-legacy-file" }),
                updated_at_ms: 9_999,
            })
            .expect("repeat import");
        assert!(!repeated.imported);
        assert_eq!(repeated.snapshot.snapshot, json!({ "source": "legacy" }));
        assert_eq!(repeated.snapshot.updated_at_ms, 1_100);
    }

    #[test]
    fn list_session_snapshots_is_recent_first_with_stable_ties() {
        let store = SessionStore::open_in_memory_with_options(SessionStoreOptions::default())
            .expect("open store");
        for (session_id, updated_at_ms) in [
            ("session-c", 2_000),
            ("session-a", 1_000),
            ("session-b", 2_000),
        ] {
            store
                .import_legacy_snapshot_if_absent(ImportLegacySnapshotIfAbsentRequest {
                    key: key(session_id),
                    snapshot: json!({ "session": session_id }),
                    updated_at_ms,
                })
                .expect("import fixture");
        }
        let listed = store
            .list_session_snapshots("/workspace/main")
            .expect("list snapshots");
        assert_eq!(
            listed
                .iter()
                .map(|snapshot| snapshot.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["session-b", "session-c", "session-a"]
        );
    }

    #[test]
    fn legacy_workspace_marker_is_write_once() {
        let store = SessionStore::open_in_memory_with_options(SessionStoreOptions::default())
            .expect("open store");
        let first = store
            .mark_legacy_workspace_imported(LegacyWorkspaceImportRecord {
                workspace: "/workspace/main".to_string(),
                imported_at_ms: 2_000,
                imported_sessions: 3,
            })
            .expect("write marker");
        assert_eq!(first.imported_sessions, 3);
        let repeated = store
            .mark_legacy_workspace_imported(LegacyWorkspaceImportRecord {
                workspace: "/workspace/main".to_string(),
                imported_at_ms: 9_000,
                imported_sessions: 9,
            })
            .expect("repeat marker");
        assert_eq!(repeated.imported_at_ms, 2_000);
        assert_eq!(repeated.imported_sessions, 3);
    }

    #[test]
    fn non_object_snapshot_fails_before_any_write() {
        let store = SessionStore::open_in_memory_with_options(SessionStoreOptions::default())
            .expect("open store");
        let error = store
            .compare_and_swap_session_snapshot(CompareAndSwapSessionSnapshotRequest {
                key: key("invalid-snapshot"),
                expected_revision: 0,
                snapshot: json!([]),
                updated_at_ms: 1_000,
            })
            .expect_err("array snapshot must fail");
        assert_eq!(error.code, SessionStoreErrorCode::InvalidInput);
        assert!(store
            .get_session_snapshot(&key("invalid-snapshot"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn expired_mutation_lease_fails_before_any_snapshot_becomes_visible() {
        let store = SessionStore::open_in_memory_with_options(SessionStoreOptions::default())
            .expect("open store");
        let session_key = key("expired-lease");
        let error = store
            .compare_and_swap_session_snapshot_before(
                CompareAndSwapSessionSnapshotRequest {
                    key: session_key.clone(),
                    expected_revision: 0,
                    snapshot: json!({ "turns": ["must-not-commit"] }),
                    updated_at_ms: 1_000,
                },
                Some(0),
            )
            .expect_err("expired mutation lease must fail closed");
        assert_eq!(error.code, SessionStoreErrorCode::DeadlineExceeded);
        assert!(store.get_session_snapshot(&session_key).unwrap().is_none());
    }

    #[test]
    fn delete_and_clear_remove_only_owned_snapshots() {
        let store = SessionStore::open_in_memory_with_options(SessionStoreOptions::default())
            .expect("open store");
        create_snapshot(&store, key("delete"));
        create_snapshot(&store, key("clear"));
        let foreign_key = SessionKey {
            workspace: "/workspace/other".to_string(),
            session_id: "keep".to_string(),
        };
        create_snapshot(&store, foreign_key.clone());

        assert!(
            store
                .delete_session_snapshot(&key("delete"))
                .unwrap()
                .deleted
        );
        assert!(
            !store
                .delete_session_snapshot(&key("delete"))
                .unwrap()
                .deleted
        );
        let cleared = store.clear_workspace("/workspace/main").unwrap();
        assert_eq!(cleared.deleted_sessions, 1);
        assert!(store
            .list_session_snapshots("/workspace/main")
            .unwrap()
            .is_empty());
        assert!(store.get_session_snapshot(&foreign_key).unwrap().is_some());
    }

    #[test]
    fn configured_busy_timeout_returns_structured_busy_error() {
        let directory = tempdir().expect("temporary directory");
        let database_path = directory.path().join("session-store.sqlite");
        let options = SessionStoreOptions { busy_timeout_ms: 5 };
        let first =
            SessionStore::open_with_options(&database_path, options.clone()).expect("first store");
        let second =
            SessionStore::open_with_options(&database_path, options).expect("second store");

        let mut first_connection = first.lock_connection().expect("first connection");
        let transaction = first_connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .expect("hold write transaction");
        let error = second
            .compare_and_swap_session_snapshot(CompareAndSwapSessionSnapshotRequest {
                key: key("busy"),
                expected_revision: 0,
                snapshot: json!({ "turns": [] }),
                updated_at_ms: 6_000,
            })
            .expect_err("second writer must time out");
        assert_eq!(error.code, SessionStoreErrorCode::DatabaseBusy);
        transaction.rollback().expect("rollback writer");
    }

    #[test]
    fn ipc_shapes_use_camel_case_and_structured_error_codes() {
        let request = CompareAndSwapSessionSnapshotRequest {
            key: key("serde"),
            expected_revision: 7,
            snapshot: json!({ "turns": [] }),
            updated_at_ms: 7_000,
        };
        let encoded = serde_json::to_value(request).expect("serialize request");
        assert_eq!(encoded["expectedRevision"], 7);

        let error = SessionStoreError::invalid("workspace", "workspace is required");
        let encoded_error = serde_json::to_value(error).expect("serialize error");
        assert_eq!(encoded_error["code"], "invalid_input");
        assert_eq!(encoded_error["entity"], "workspace");
    }

    fn schema_table_names(connection: &Connection) -> Vec<String> {
        let mut statement = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .expect("prepare schema query");
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query schema")
            .map(|row| row.expect("table name"))
            .collect()
    }
}
