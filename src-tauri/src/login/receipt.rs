//! Persist only non-secret login receipts in the application's existing SQLite database.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginReceipt {
    pub receipt_id: String,
    pub provider: String,
    pub account_hash: String,
    pub email: String,
    pub name: String,
    pub avatar_url: String,
    pub issued_at: u64,
    pub expires_at: u64,
    pub sync_status: String,
}

/// Idempotent migration; bearer tokens, authorization codes and email are never columns.
pub(crate) fn initialize(connection: &Connection) -> Result<(), String> {
    let sql: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='login_receipts'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "LOGIN_STORAGE_FAILED")?;
    if sql.is_some_and(|sql| !sql.contains("PRIMARY KEY(owner, account_hash)")) {
        connection.execute_batch("BEGIN IMMEDIATE;
		ALTER TABLE login_receipts RENAME TO login_receipts_legacy;
		CREATE TABLE login_receipts(owner TEXT NOT NULL, receipt_id TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, account_hash TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, sync_status TEXT NOT NULL CHECK(sync_status IN ('pending','synced')), PRIMARY KEY(owner, account_hash));
		INSERT INTO login_receipts(owner, receipt_id, provider, account_hash, issued_at, expires_at, sync_status) SELECT owner, receipt_id, provider, account_hash, issued_at, expires_at, sync_status FROM login_receipts_legacy;
		DROP TABLE login_receipts_legacy;
		COMMIT;").map_err(|_| { let _ = connection.execute_batch("ROLLBACK;"); "LOGIN_STORAGE_FAILED".to_owned() })?;
    }
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS login_receipts (
        owner TEXT NOT NULL, receipt_id TEXT NOT NULL UNIQUE, provider TEXT NOT NULL,
        account_hash TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        sync_status TEXT NOT NULL CHECK (sync_status IN ('pending','synced')),
        PRIMARY KEY(owner, account_hash)
    );",
        )
        .map_err(|_| "LOGIN_STORAGE_FAILED".to_string())
}

/// Receipt metadata identifies a backend account without publishing its ID or bearer token.
pub(crate) fn account_hash(account_id: &str) -> String {
    format!("{:x}", Sha256::digest(format!("wstudio:{account_id}")))
}

/// Create metadata only after the backend has issued a session.
pub(crate) fn create(provider: &str, subject: &str, expires_at: u64, now: u64) -> LoginReceipt {
    LoginReceipt {
        receipt_id: Uuid::new_v4().to_string(),
        provider: provider.into(),
        account_hash: account_hash(subject),
        email: String::new(),
        name: String::new(),
        avatar_url: String::new(),
        issued_at: now,
        expires_at,
        sync_status: "synced".into(),
    }
}

/// Replace only this owner's receipt; a plugin cannot access the host or another plugin.
pub(crate) fn save(
    connection: &Connection,
    owner: &str,
    receipt: &LoginReceipt,
) -> Result<(), String> {
    connection.execute("INSERT INTO login_receipts
        (owner, receipt_id, provider, account_hash, issued_at, expires_at, sync_status)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(owner, account_hash) DO UPDATE SET receipt_id=excluded.receipt_id,
        provider=excluded.provider, account_hash=excluded.account_hash,
        issued_at=excluded.issued_at, expires_at=excluded.expires_at, sync_status=excluded.sync_status",
        params![owner, receipt.receipt_id, receipt.provider, receipt.account_hash,
            receipt.issued_at, receipt.expires_at, receipt.sync_status])
        .map_err(|_| "LOGIN_STORAGE_FAILED".to_string())?;
    Ok(())
}

/// Remove this owner's non-secret receipt during local logout.
pub(crate) fn clear(
    connection: &Connection,
    owner: &str,
    account_hash: Option<&str>,
) -> Result<(), String> {
    let changed = match account_hash {
        Some(account_hash) => connection.execute(
            "DELETE FROM login_receipts WHERE owner=?1 AND account_hash=?2",
            params![owner, account_hash],
        ),
        None => connection.execute("DELETE FROM login_receipts WHERE owner=?1", [owner]),
    };
    changed
        .map(|_| ())
        .map_err(|_| "LOGIN_STORAGE_FAILED".to_string())
}

/// Expired local receipts do not restore a logged-in UI after restart.
pub(crate) fn load(
    connection: &Connection,
    owner: &str,
    now: u64,
) -> Result<Option<LoginReceipt>, String> {
    connection
        .query_row(
            "SELECT receipt_id, provider, account_hash, issued_at, expires_at, sync_status
        FROM login_receipts WHERE owner=?1 AND expires_at>?2 AND sync_status='synced'",
            params![owner, now],
            |row| {
                Ok(LoginReceipt {
                    receipt_id: row.get(0)?,
                    provider: row.get(1)?,
                    account_hash: row.get(2)?,
                    email: String::new(),
                    name: String::new(),
                    avatar_url: String::new(),
                    issued_at: row.get(3)?,
                    expires_at: row.get(4)?,
                    sync_status: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|_| "LOGIN_STORAGE_FAILED".to_string())
}

/// Load all non-expired receipts for this host. Personal fields are refreshed from `/me`.
pub(crate) fn load_all(
    connection: &Connection,
    owner: &str,
    now: u64,
) -> Result<Vec<LoginReceipt>, String> {
    let mut statement = connection
        .prepare(
            "SELECT receipt_id, provider, account_hash, issued_at, expires_at, sync_status
             FROM login_receipts WHERE owner=?1 AND expires_at>?2 AND sync_status='synced'
             ORDER BY issued_at DESC",
        )
        .map_err(|_| "LOGIN_STORAGE_FAILED")?;
    let rows = statement
        .query_map(params![owner, now], |row| {
            Ok(LoginReceipt {
                receipt_id: row.get(0)?,
                provider: row.get(1)?,
                account_hash: row.get(2)?,
                email: String::new(),
                name: String::new(),
                avatar_url: String::new(),
                issued_at: row.get(3)?,
                expires_at: row.get(4)?,
                sync_status: row.get(5)?,
            })
        })
        .map_err(|_| "LOGIN_STORAGE_FAILED")?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| "LOGIN_STORAGE_FAILED".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_pending_receipt_is_not_a_backend_session() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE login_receipts(owner TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, account_hash TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, sync_status TEXT NOT NULL CHECK(sync_status IN ('pending'))); INSERT INTO login_receipts VALUES('host','old','google','hash',100,9999999999,'pending');").unwrap();
        initialize(&connection).unwrap();
        assert!(load(&connection, "host", 200).unwrap().is_none());
        let receipt = create("google", "backend-account", 500, 200);
        assert_eq!(receipt.sync_status, "synced");
        save(&connection, "host", &receipt).unwrap();
        assert_eq!(load(&connection, "host", 201).unwrap(), Some(receipt));
    }

    #[test]
    fn receipt_roundtrip_is_owner_scoped_expiring_and_has_no_tokens() {
        let connection = Connection::open_in_memory().unwrap();
        initialize(&connection).unwrap();
        initialize(&connection).unwrap();
        let receipt = create("google", "google-user-123", 200, 100);
        save(&connection, "host", &receipt).unwrap();
        assert_eq!(
            load(&connection, "host", 100).unwrap(),
            Some(receipt.clone())
        );
        assert!(load(&connection, "plugin:other", 100).unwrap().is_none());
        assert!(load(&connection, "host", 200).unwrap().is_none());
        let serialized = serde_json::to_string(&receipt).unwrap();
        for secret in ["google-user-123", "token", "secret", "authorizationCode"] {
            assert!(!serialized.contains(secret));
        }
        let next = create("google", "google-user-456", 300, 101);
        save(&connection, "host", &next).unwrap();
        assert_ne!(receipt.receipt_id, next.receipt_id);
        assert_eq!(load(&connection, "host", 102).unwrap(), Some(next));
        clear(&connection, "host", None).unwrap();
        assert!(load(&connection, "host", 102).unwrap().is_none());
    }
}
