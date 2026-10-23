//! Own native AI credentials and compatibility with the application's Electron settings.
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::path::Path;
use zeroize::Zeroizing;

const UNAVAILABLE: &str = "AI_CONNECTION_SECURE_STORAGE_UNAVAILABLE";

/// Real Windows credential-store fixtures share one OS service, unlike isolated SQLite files.
#[cfg(all(test, windows))]
pub(crate) static NATIVE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// SQLite may release its lock on an automatic rollback; hold the independent host lock as well.
fn lock(connection: &Connection) -> Result<Option<crate::workspace_lock::WorkspaceLock>, String> {
    if let Some(path) = connection.path().filter(|path| !path.is_empty()) {
        let parent = Path::new(path)
            .parent()
            .ok_or("AI_CONNECTION_SETTINGS_LOCK_FAILED")?;
        return crate::workspace_lock::acquire_without_cleanup(parent)
            .map(Some)
            .map_err(|_| "AI_CONNECTION_SETTINGS_LOCK_FAILED".into());
    }
    // In-memory databases exist only in isolated tests and have no shared persistent state.
    #[cfg(test)]
    return Ok(None);
    #[cfg(not(test))]
    Err("AI_CONNECTION_SETTINGS_LOCK_FAILED".into())
}

/// Each configuration owns one persistent credential under the application service name.
pub(crate) fn entry(configuration_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.wstudio.desktop.ai", configuration_id)
        .map_err(|_| UNAVAILABLE.to_string())
}

/// Recovery secrets use a separate OS service; the database stores only recovery state.
fn backup_entry(configuration_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.wstudio.desktop.ai.rollback", configuration_id)
        .map_err(|_| UNAVAILABLE.to_string())
}

/// Undo incomplete OS mutations, or finish cleanup for an already committed operation.
fn recover(connection: &Connection, configuration_id: &str) -> Result<(), String> {
    const FAILED: &str = "AI_CONNECTION_CREDENTIAL_RECOVERY_FAILED";
    let pending = connection
        .query_row(
            "SELECT had_original, finalized FROM ai_credential_recovery WHERE configuration_id=?1",
            [configuration_id],
            |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()
        .map_err(|_| FAILED)?;
    let backup = backup_entry(configuration_id)?;
    if let Some((had_original, finalized)) = pending {
        if !finalized {
            let original = if had_original {
                Some(read_password(&backup)?.ok_or(FAILED)?)
            } else {
                None
            };
            restore_password(
                &entry(configuration_id)?,
                original.as_deref().map(String::as_str),
            )?;
            // Persist that restoration is complete BEFORE discarding its only backup.
            let changed = connection
                .execute(
                    "UPDATE ai_credential_recovery SET finalized=1 WHERE configuration_id=?1",
                    [configuration_id],
                )
                .map_err(|_| FAILED)?;
            if changed != 1 {
                return Err(FAILED.into());
            }
        }
        // The live key and its SQLite metadata are now coherent; cleanup can retry later.
        if replace_password(&backup, None).is_ok() {
            let _ = connection.execute(
                "DELETE FROM ai_credential_recovery WHERE configuration_id=?1",
                [configuration_id],
            );
        }
    } else {
        // A process may have stopped after backing up but before creating its recovery record.
        replace_password(&backup, None).map_err(|_| FAILED)?;
    }
    Ok(())
}

/// Resolve durable pending records at startup before exposing the database to frontend requests.
pub(crate) fn recover_pending(connection: &Connection) -> Result<(), String> {
    let _guard = lock(connection)?;
    let ids = {
        let mut statement = connection
            .prepare("SELECT configuration_id FROM ai_credential_recovery")
            .map_err(|_| "AI_CONNECTION_CREDENTIAL_RECOVERY_FAILED")?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| "AI_CONNECTION_CREDENTIAL_RECOVERY_FAILED")?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "AI_CONNECTION_CREDENTIAL_RECOVERY_FAILED")?;
        ids
    };
    for id in ids {
        recover(connection, &id)?;
    }
    Ok(())
}

/// Flush and verify the OS backup, then record the intent before changing the live credential.
fn prepare_recovery(
    connection: &Connection,
    configuration_id: &str,
    original: Option<&str>,
) -> Result<(), String> {
    let pending: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM ai_credential_recovery WHERE configuration_id=?1)",
            [configuration_id],
            |row| row.get(0),
        )
        .map_err(|_| "AI_CONNECTION_CREDENTIAL_RECOVERY_FAILED")?;
    if pending {
        return Err("AI_CONNECTION_CREDENTIAL_CLEANUP_PENDING".into());
    }
    let backup = backup_entry(configuration_id)?;
    replace_password(&backup, original)?;
    let saved = read_password(&backup)?;
    if saved.as_deref().map(String::as_str) != original {
        return Err(UNAVAILABLE.into());
    }
    connection.execute(
        "INSERT INTO ai_credential_recovery(configuration_id, had_original, finalized) VALUES (?1,?2,0)",
        (configuration_id, original.is_some()),
    ).map_err(|_| "AI_CONNECTION_SETTINGS_WRITE_FAILED")?;
    Ok(())
}

/// Mark the OS edit as committed in the same transaction as its endpoint and legacy metadata.
fn finalize_recovery(transaction: &Transaction<'_>, configuration_id: &str) -> Result<(), String> {
    let changed = transaction
        .execute(
            "UPDATE ai_credential_recovery SET finalized=1 WHERE configuration_id=?1",
            [configuration_id],
        )
        .map_err(|_| "AI_CONNECTION_SETTINGS_WRITE_FAILED")?;
    if changed != 1 {
        return Err("AI_CONNECTION_SETTINGS_WRITE_FAILED".into());
    }
    Ok(())
}

/// Serialize edits with import and compensate native credential edits if the database rejects them.
pub(crate) fn update_settings(
    connection: &Connection,
    configuration_id: &str,
    endpoint: &str,
    key: Option<&str>,
) -> Result<(), String> {
    let _guard = lock(connection)?;
    recover(connection, configuration_id)?;
    let found = connection
        .query_row(
            "SELECT id FROM ai_configurations WHERE id=?1",
            [configuration_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "AI_CONNECTION_SETTINGS_READ_FAILED")?;
    if found.is_none() {
        return Err("AI_CONFIGURATION_NOT_FOUND".into());
    }
    if key.is_some() {
        let original = native_password(configuration_id)?;
        prepare_recovery(
            connection,
            configuration_id,
            original.as_deref().map(String::as_str),
        )?;
    }
    let result = (|| {
        let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
            .map_err(|_| "AI_CONNECTION_SETTINGS_WRITE_FAILED")?;
        transaction.execute(
        "UPDATE ai_configurations SET api_endpoint=?1, encrypted_api_key=CASE WHEN ?2 THEN '' ELSE encrypted_api_key END, updated_at=?3 WHERE id=?4",
        (endpoint, key.is_some(), crate::chrono_like_now(), configuration_id),
    ).map_err(|_| "AI_CONNECTION_SETTINGS_WRITE_FAILED")?;
        if let Some(key) = key {
            replace_password(
                &entry(configuration_id)?,
                Some(key).filter(|value| !value.is_empty()),
            )?;
            finalize_recovery(&transaction, configuration_id)?;
        }
        transaction
            .commit()
            .map_err(|_| "AI_CONNECTION_SETTINGS_WRITE_FAILED")?;
        Ok(())
    })();
    let recovery = recover(connection, configuration_id);
    if result.is_err() {
        recovery?;
    }
    // A committed configuration stays successful even if backup cleanup needs a later retry.
    result
}

/// Retire the native key and configuration in the same recoverable, cross-process operation.
pub(crate) fn delete_configuration(
    connection: &Connection,
    configuration_id: &str,
) -> Result<(), String> {
    let _guard = lock(connection)?;
    recover(connection, configuration_id)?;
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM ai_configurations WHERE id=?1)",
            [configuration_id],
            |row| row.get(0),
        )
        .map_err(|_| "AI_CONNECTION_SETTINGS_READ_FAILED")?;
    if !exists {
        return Err("AI_CONFIGURATION_NOT_FOUND".into());
    }
    let original = native_password(configuration_id)?;
    prepare_recovery(
        connection,
        configuration_id,
        original.as_deref().map(String::as_str),
    )?;
    let result = (|| {
        let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
            .map_err(|_| "AI_CONNECTION_SETTINGS_WRITE_FAILED")?;
        let changed = transaction.execute(
            "DELETE FROM ai_configurations WHERE id=?1 AND (SELECT COUNT(*) FROM ai_configurations)>1",
            [configuration_id],
        ).map_err(|_| "AI_CONNECTION_SETTINGS_WRITE_FAILED")?;
        if changed != 1 {
            let exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM ai_configurations WHERE id=?1)",
                    [configuration_id],
                    |row| row.get(0),
                )
                .map_err(|_| "AI_CONNECTION_SETTINGS_READ_FAILED")?;
            return Err(if exists {
                "AI_CONFIGURATION_DELETE_LAST_FORBIDDEN"
            } else {
                "AI_CONFIGURATION_NOT_FOUND"
            }
            .into());
        }
        replace_password(&entry(configuration_id)?, None)?;
        finalize_recovery(&transaction, configuration_id)?;
        transaction
            .commit()
            .map_err(|_| "AI_CONNECTION_SETTINGS_WRITE_FAILED")?;
        Ok(())
    })();
    let recovery = recover(connection, configuration_id);
    if result.is_err() {
        recovery?;
    }
    result
}

/// Read a persistent credential while keeping the compensating copy out of ordinary allocations.
fn native_password(configuration_id: &str) -> Result<Option<Zeroizing<String>>, String> {
    read_password(&entry(configuration_id)?)
}

/// Wrap OS passwords in wiping allocations, including temporary recovery copies.
fn read_password(credential: &keyring::Entry) -> Result<Option<Zeroizing<String>>, String> {
    match credential.get_password() {
        Ok(value) => Ok(Some(Zeroizing::new(value))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(UNAVAILABLE.into()),
    }
}

/// Treat a missing credential as an already completed clear operation.
fn replace_password(credential: &keyring::Entry, value: Option<&str>) -> Result<(), String> {
    match value {
        Some(value) => credential
            .set_password(value)
            .map_err(|_| UNAVAILABLE.into()),
        None => match credential.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(UNAVAILABLE.into()),
        },
    }
}

/// Distinguish failed compensation from the original settings failure without exposing secrets.
fn restore_password(credential: &keyring::Entry, original: Option<&str>) -> Result<(), String> {
    replace_password(credential, original)
        .map_err(|_| "AI_CONNECTION_SETTINGS_ROLLBACK_FAILED".into())
}

/// Prefer native credentials, importing the copied Electron secret only while its baseline remains.
#[cfg(test)]
pub(crate) fn read(
    connection: &Connection,
    configuration_id: &str,
    legacy_root: Option<&Path>,
) -> Result<String, String> {
    read_snapshot(connection, configuration_id, legacy_root, |_| Ok(())).map(|(_, key)| key)
}

/// Read endpoint/model metadata and its credential under the same cross-process database lock.
pub(crate) fn read_snapshot<T>(
    connection: &Connection,
    configuration_id: &str,
    legacy_root: Option<&Path>,
    metadata: impl FnOnce(&Transaction<'_>) -> Result<T, String>,
) -> Result<(T, String), String> {
    let _guard = lock(connection)?;
    recover(connection, configuration_id)?;
    let legacy: String = connection
        .query_row(
            "SELECT encrypted_api_key FROM ai_configurations WHERE id = ?1",
            [configuration_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| "AI_CONNECTION_SETTINGS_READ_FAILED")?
        .ok_or("AI_CONFIGURATION_NOT_FOUND")?;
    let original = native_password(configuration_id)?;
    let imported = original.is_none() && !legacy.is_empty();
    if imported {
        prepare_recovery(connection, configuration_id, None)?;
    }
    let result = (|| {
        let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
            .map_err(|_| "AI_CONNECTION_SETTINGS_READ_FAILED")?;
        let current_legacy: String = transaction
            .query_row(
                "SELECT encrypted_api_key FROM ai_configurations WHERE id=?1",
                [configuration_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "AI_CONNECTION_SETTINGS_READ_FAILED")?
            .ok_or("AI_CONFIGURATION_NOT_FOUND")?;
        if current_legacy != legacy {
            return Err("AI_CONNECTION_SETTINGS_CONFLICT".into());
        }
        let metadata = metadata(&transaction)?;
        let credential = entry(configuration_id)?;
        let value = match original {
            Some(value) => value.to_string(),
            None if legacy.is_empty() => String::new(),
            None => {
                let decoded = decode_legacy(&legacy, legacy_root)?;
                credential.set_password(&decoded).map_err(|_| UNAVAILABLE)?;
                // Confirm the OS backend persists across independent requests before retiring ciphertext.
                let stored = native_password(configuration_id);
                if !matches!(&stored, Ok(Some(value)) if **value == *decoded) {
                    return Err(UNAVAILABLE.into());
                }
                decoded.to_string()
            }
        };
        let value = Zeroizing::new(value);
        if !legacy.is_empty() {
            transaction
                .execute(
                    "UPDATE ai_configurations SET encrypted_api_key='' WHERE id=?1",
                    [configuration_id],
                )
                .map_err(|_| "AI_CONNECTION_SETTINGS_WRITE_FAILED")?;
        }
        if imported {
            finalize_recovery(&transaction, configuration_id)?;
        }
        transaction
            .commit()
            .map_err(|_| "AI_CONNECTION_SETTINGS_WRITE_FAILED")?;
        Ok((metadata, value.to_string()))
    })();
    let recovery = recover(connection, configuration_id);
    if result.is_err() {
        recovery?;
    }
    result
}

/// Other platforms keep legacy ciphertext intact until their Electron format is implemented.
#[cfg(not(windows))]
fn decode_legacy(
    _ciphertext: &str,
    _root: Option<&Path>,
) -> Result<zeroize::Zeroizing<String>, String> {
    Err("AI_CONNECTION_LEGACY_KEY_UNSUPPORTED".into())
}

/// Decode only Electron's Windows v10 envelope, never a different browser's bound-key format.
#[cfg(windows)]
fn decode_legacy(
    ciphertext: &str,
    root: Option<&Path>,
) -> Result<zeroize::Zeroizing<String>, String> {
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm, Nonce,
    };
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::io::Read;
    use zeroize::Zeroizing;
    const INVALID: &str = "AI_CONNECTION_LEGACY_KEY_INVALID";
    if ciphertext.len() > 16 * 1024 {
        return Err(INVALID.into());
    }
    let bytes = STANDARD.decode(ciphertext).map_err(|_| INVALID)?;
    if bytes.len() < 3 + 12 + 16 || !bytes.starts_with(b"v10") {
        return Err(INVALID.into());
    }
    let root = root.ok_or("AI_CONNECTION_LEGACY_KEY_UNAVAILABLE")?;
    let parent = root
        .parent()
        .ok_or("AI_CONNECTION_LEGACY_KEY_UNAVAILABLE")?;
    let _pins = crate::file_commit::pin_directories(parent, root)
        .map_err(|_| "AI_CONNECTION_LEGACY_KEY_UNAVAILABLE")?;
    let path = root.join("Local State");
    let file = crate::file_commit::open_read_snapshot(&path)
        .map_err(|_| "AI_CONNECTION_LEGACY_KEY_UNAVAILABLE")?;
    let mut local_state = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut local_state)
        .map_err(|_| INVALID)?;
    if local_state.len() > 1024 * 1024 {
        return Err(INVALID.into());
    }
    let state: serde_json::Value = serde_json::from_slice(&local_state).map_err(|_| INVALID)?;
    let wrapped = state["os_crypt"]["encrypted_key"].as_str().ok_or(INVALID)?;
    if wrapped.len() > 64 * 1024 {
        return Err(INVALID.into());
    }
    let wrapped = STANDARD.decode(wrapped).map_err(|_| INVALID)?;
    let wrapped = wrapped
        .strip_prefix(b"DPAPI")
        .filter(|value| !value.is_empty())
        .ok_or(INVALID)?;
    let key = windows_dpapi::unprotect(wrapped)?;
    if key.len() != 32 {
        return Err(INVALID.into());
    }
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| INVALID)?;
    let plain = Zeroizing::new(
        cipher
            .decrypt(Nonce::from_slice(&bytes[3..15]), &bytes[15..])
            .map_err(|_| INVALID)?,
    );
    let text = std::str::from_utf8(&plain).map_err(|_| INVALID)?;
    if text.is_empty() || text.len() > 4096 || text.contains('\0') {
        return Err(INVALID.into());
    }
    // Local State and the Electron database are deliberately read-only throughout migration.
    Ok(Zeroizing::new(text.to_owned()))
}

#[cfg(windows)]
mod windows_dpapi {
    use std::ffi::c_void;
    use zeroize::{Zeroize, Zeroizing};

    #[repr(C)]
    struct DataBlob {
        length: u32,
        data: *mut u8,
    }
    #[link(name = "crypt32")]
    extern "system" {
        fn CryptUnprotectData(
            input: *const DataBlob,
            description: *mut *mut u16,
            entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut DataBlob,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }

    /// DPAPI decrypts as the current Windows user; reject UI prompts and wipe the native allocation.
    pub(super) fn unprotect(bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
        if bytes.len() > 64 * 1024 {
            return Err("AI_CONNECTION_LEGACY_KEY_INVALID".into());
        }
        let input = DataBlob {
            length: bytes.len() as u32,
            data: bytes.as_ptr().cast_mut(),
        };
        let mut output = DataBlob {
            length: 0,
            data: std::ptr::null_mut(),
        };
        // SAFETY: buffers live throughout the synchronous call; DPAPI allocates output with LocalAlloc.
        let success = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        };
        if success == 0 {
            return Err("AI_CONNECTION_LEGACY_KEY_UNAVAILABLE".into());
        }
        // SAFETY: the successful OS call returns a live allocation of output.length bytes.
        let result = unsafe {
            let result = if output.data.is_null() || output.length > 64 * 1024 {
                Err("AI_CONNECTION_LEGACY_KEY_INVALID".into())
            } else {
                Ok(Zeroizing::new(
                    std::slice::from_raw_parts(output.data, output.length as usize).to_vec(),
                ))
            };
            if !output.data.is_null() {
                std::slice::from_raw_parts_mut(output.data, output.length as usize).zeroize();
                LocalFree(output.data.cast());
            }
            result
        };
        result
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };

    /// Unique disposable database, credential and Electron profile; no existing user data is read.
    struct Fixture {
        _native_guard: std::sync::MutexGuard<'static, ()>,
        root: PathBuf,
        id: String,
        connection: Connection,
    }
    impl Fixture {
        fn new() -> Self {
            let native_guard = NATIVE_TEST_LOCK
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let root = std::env::temp_dir()
                .join(format!("wstudio-ai-credentials-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let id = format!("fixture-{}", uuid::Uuid::new_v4());
            let connection = Connection::open(root.join("settings.sqlite")).unwrap();
            crate::initialize_database(&connection).unwrap();
            connection.execute(
                "INSERT INTO ai_configurations (id,name,api_endpoint,encrypted_api_key,created_at,updated_at) VALUES (?1,?1,'https://fixture.example','','0','0')",
                [&id],
            ).unwrap();
            Self {
                _native_guard: native_guard,
                root,
                id,
                connection,
            }
        }

        /// Exit a real child at a chosen SQLite commit boundary, with bounded process cleanup.
        fn interrupt(&self, action: &str, stop_commit: u32) {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "ai_credentials::tests::interruption_worker",
                    "--ignored",
                    "--nocapture",
                ])
                .env(
                    "WSTUDIO_CREDENTIAL_TEST_DB",
                    self.root.join("settings.sqlite"),
                )
                .env("WSTUDIO_CREDENTIAL_TEST_ID", &self.id)
                .env("WSTUDIO_CREDENTIAL_TEST_ACTION", action)
                .env(
                    "WSTUDIO_CREDENTIAL_TEST_STOP_COMMIT",
                    stop_commit.to_string(),
                )
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
            let mut child = command.spawn().unwrap();
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert_eq!(status.code(), Some(37));
                    break;
                }
                if Instant::now() >= deadline {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("credential interruption worker timed out");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        /// Recovery must retire both its metadata and the native-only backup.
        fn assert_recovery_clean(&self) {
            let pending: i64 = self
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM ai_credential_recovery WHERE configuration_id=?1",
                    [&self.id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(pending, 0);
            assert!(matches!(
                backup_entry(&self.id).unwrap().get_password(),
                Err(keyring::Error::NoEntry)
            ));
        }

        /// Produce safeStorage ciphertext with the installed Electron instead of duplicating its algorithm.
        fn electron_ciphertext(&self) -> String {
            let script = self.root.join("fixture.cjs");
            fs::write(&script, r#"
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.WSTUDIO_AI_FIXTURE_ROOT;
app.setPath('userData', root);
app.whenReady().then(() => {
  const encrypted = safeStorage.encryptString('wstudio-public-migration-fixture').toString('base64');
  fs.writeFileSync(path.join(root, 'ciphertext.json'), JSON.stringify({ encrypted }));
  app.quit();
}).catch(() => app.exit(1));
"#).unwrap();
            let executable = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../node_modules/electron/dist/electron.exe");
            let mut command = Command::new(executable);
            command
                .arg(&script)
                .env("WSTUDIO_AI_FIXTURE_ROOT", &self.root)
                .env_remove("ELECTRON_RUN_AS_NODE")
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
            let mut child = command
                .spawn()
                .expect("installed Electron is required for this compatibility test");
            let start = Instant::now();
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(status.success(), "Electron fixture generation failed");
                    break;
                }
                if start.elapsed() > Duration::from_secs(20) {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("Electron fixture generation timed out");
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            let value: serde_json::Value =
                serde_json::from_slice(&fs::read(self.root.join("ciphertext.json")).unwrap())
                    .unwrap();
            value["encrypted"].as_str().unwrap().into()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            match entry(&self.id).unwrap().delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => (),
                Err(error) => panic!("fixture credential cleanup failed: {error}"),
            }
            replace_password(&backup_entry(&self.id).unwrap(), None).unwrap();
            let connection =
                std::mem::replace(&mut self.connection, Connection::open_in_memory().unwrap());
            connection.close().unwrap();
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    fn deleting_a_configuration_retires_its_native_key_and_models() {
        let fixture = Fixture::new();
        entry(&fixture.id)
            .unwrap()
            .set_password("original-fixture-key")
            .unwrap();
        fixture.connection.execute("INSERT INTO ai_models(configuration_id,id,endpoint_type,created_at,updated_at) VALUES (?1,'fixture-model','openai',0,0)", [&fixture.id]).unwrap();
        delete_configuration(&fixture.connection, &fixture.id).unwrap();
        assert!(matches!(
            entry(&fixture.id).unwrap().get_password(),
            Err(keyring::Error::NoEntry)
        ));
        let remaining: i64 = fixture
            .connection
            .query_row(
                "SELECT COUNT(*) FROM ai_models WHERE configuration_id=?1",
                [&fixture.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0);
        fixture.assert_recovery_clean();
    }

    #[test]
    fn deletion_interruption_recovers_before_commit_and_preserves_deletion_after_commit() {
        for boundary in [2, 3] {
            let fixture = Fixture::new();
            entry(&fixture.id)
                .unwrap()
                .set_password("original-fixture-key")
                .unwrap();
            fixture.interrupt("delete", boundary);
            recover_pending(&fixture.connection).unwrap();
            let exists: bool = fixture
                .connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM ai_configurations WHERE id=?1)",
                    [&fixture.id],
                    |row| row.get(0),
                )
                .unwrap();
            if boundary == 2 {
                assert!(exists);
                assert_eq!(
                    entry(&fixture.id).unwrap().get_password().unwrap(),
                    "original-fixture-key"
                );
            } else {
                assert!(!exists);
                assert!(matches!(
                    entry(&fixture.id).unwrap().get_password(),
                    Err(keyring::Error::NoEntry)
                ));
            }
            fixture.assert_recovery_clean();
        }
    }

    #[test]
    fn deletion_commit_rejection_restores_the_configuration_and_native_key() {
        let fixture = Fixture::new();
        entry(&fixture.id)
            .unwrap()
            .set_password("original-fixture-key")
            .unwrap();
        fixture.connection.execute_batch("CREATE TABLE fixture_parent(id INTEGER PRIMARY KEY); CREATE TABLE fixture_child(id INTEGER REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER reject_delete_commit AFTER DELETE ON ai_configurations BEGIN INSERT INTO fixture_child VALUES (123); END;").unwrap();
        assert_eq!(
            delete_configuration(&fixture.connection, &fixture.id),
            Err("AI_CONNECTION_SETTINGS_WRITE_FAILED".into())
        );
        assert_eq!(
            read(&fixture.connection, &fixture.id, None).unwrap(),
            "original-fixture-key"
        );
        fixture.assert_recovery_clean();
    }

    #[test]
    fn deletion_of_the_last_configuration_preserves_its_key() {
        let fixture = Fixture::new();
        fixture
            .connection
            .execute("DELETE FROM ai_configurations WHERE id='default'", [])
            .unwrap();
        entry(&fixture.id)
            .unwrap()
            .set_password("original-fixture-key")
            .unwrap();
        assert_eq!(
            delete_configuration(&fixture.connection, &fixture.id),
            Err("AI_CONFIGURATION_DELETE_LAST_FORBIDDEN".into())
        );
        assert_eq!(
            read(&fixture.connection, &fixture.id, None).unwrap(),
            "original-fixture-key"
        );
        assert_eq!(
            delete_configuration(&fixture.connection, "fixture-missing"),
            Err("AI_CONFIGURATION_NOT_FOUND".into())
        );
        fixture.assert_recovery_clean();
    }

    #[test]
    fn deletion_cleans_a_committed_key_change_after_interrupted_cleanup() {
        let fixture = Fixture::new();
        entry(&fixture.id)
            .unwrap()
            .set_password("original-fixture-key")
            .unwrap();
        fixture.interrupt("replace", 3);
        delete_configuration(&fixture.connection, &fixture.id).unwrap();
        recover_pending(&fixture.connection).unwrap();
        assert!(matches!(
            entry(&fixture.id).unwrap().get_password(),
            Err(keyring::Error::NoEntry)
        ));
        fixture.assert_recovery_clean();
    }

    #[test]
    fn explicit_key_clear_retires_legacy_ciphertext_in_the_target_database() {
        let fixture = Fixture::new();
        fixture
            .connection
            .execute(
                "UPDATE ai_configurations SET encrypted_api_key='retained-legacy' WHERE id=?1",
                [&fixture.id],
            )
            .unwrap();
        entry(&fixture.id)
            .unwrap()
            .set_password("current-fixture-key")
            .unwrap();
        update_settings(
            &fixture.connection,
            &fixture.id,
            "https://new.example",
            Some(""),
        )
        .unwrap();
        let retained: String = fixture
            .connection
            .query_row(
                "SELECT encrypted_api_key FROM ai_configurations WHERE id=?1",
                [&fixture.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            retained.is_empty(),
            "cleared keys must never be restored from legacy data"
        );
        assert_eq!(read(&fixture.connection, &fixture.id, None).unwrap(), "");
    }

    #[test]
    fn database_rejection_preserves_both_native_key_and_endpoint() {
        let fixture = Fixture::new();
        entry(&fixture.id)
            .unwrap()
            .set_password("original-fixture-key")
            .unwrap();
        fixture.connection.execute_batch("CREATE TRIGGER reject_settings BEFORE UPDATE ON ai_configurations BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END;").unwrap();
        assert_eq!(
            update_settings(
                &fixture.connection,
                &fixture.id,
                "https://new.example",
                Some("replacement-fixture-key")
            ),
            Err("AI_CONNECTION_SETTINGS_WRITE_FAILED".into())
        );
        assert_eq!(
            entry(&fixture.id).unwrap().get_password().unwrap(),
            "original-fixture-key"
        );
        let endpoint: String = fixture
            .connection
            .query_row(
                "SELECT api_endpoint FROM ai_configurations WHERE id=?1",
                [&fixture.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(endpoint, "https://fixture.example");
    }

    #[test]
    fn failed_database_commit_restores_the_previous_native_credential() {
        let fixture = Fixture::new();
        entry(&fixture.id)
            .unwrap()
            .set_password("original-fixture-key")
            .unwrap();
        fixture.connection.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE fixture_parent(id INTEGER PRIMARY KEY); CREATE TABLE fixture_child(id INTEGER REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER reject_commit AFTER UPDATE ON ai_configurations BEGIN INSERT INTO fixture_child VALUES (123); END;").unwrap();
        assert_eq!(
            update_settings(
                &fixture.connection,
                &fixture.id,
                "https://new.example",
                Some("replacement-fixture-key")
            ),
            Err("AI_CONNECTION_SETTINGS_WRITE_FAILED".into())
        );
        assert_eq!(
            entry(&fixture.id).unwrap().get_password().unwrap(),
            "original-fixture-key"
        );
        let endpoint: String = fixture
            .connection
            .query_row(
                "SELECT api_endpoint FROM ai_configurations WHERE id=?1",
                [&fixture.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(endpoint, "https://fixture.example");
    }

    #[test]
    fn native_key_takes_precedence_over_unknown_legacy_data() {
        let fixture = Fixture::new();
        fixture
            .connection
            .execute(
                "UPDATE ai_configurations SET encrypted_api_key='unknown-format' WHERE id=?1",
                [&fixture.id],
            )
            .unwrap();
        entry(&fixture.id)
            .unwrap()
            .set_password("native-fixture-key")
            .unwrap();
        assert_eq!(
            read(&fixture.connection, &fixture.id, None).unwrap(),
            "native-fixture-key"
        );
        let retained: String = fixture
            .connection
            .query_row(
                "SELECT encrypted_api_key FROM ai_configurations WHERE id=?1",
                [&fixture.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(retained.is_empty());
    }

    #[test]
    fn invalid_legacy_data_is_preserved_without_creating_native_credentials() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let fixture = Fixture::new();
        for ciphertext in [
            "invalid-base64".to_owned(),
            STANDARD.encode([b"v20".as_slice(), &[0; 28]].concat()),
        ] {
            fixture
                .connection
                .execute(
                    "UPDATE ai_configurations SET encrypted_api_key=?1 WHERE id=?2",
                    (&ciphertext, &fixture.id),
                )
                .unwrap();
            assert_eq!(
                read(&fixture.connection, &fixture.id, Some(&fixture.root)),
                Err("AI_CONNECTION_LEGACY_KEY_INVALID".into())
            );
            let retained: String = fixture
                .connection
                .query_row(
                    "SELECT encrypted_api_key FROM ai_configurations WHERE id=?1",
                    [&fixture.id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(retained, ciphertext);
            assert!(matches!(
                entry(&fixture.id).unwrap().get_password(),
                Err(keyring::Error::NoEntry)
            ));
        }
    }

    #[test]
    fn missing_local_state_preserves_the_legacy_ciphertext() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let fixture = Fixture::new();
        let ciphertext = STANDARD.encode([b"v10".as_slice(), &[0; 28]].concat());
        fixture
            .connection
            .execute(
                "UPDATE ai_configurations SET encrypted_api_key=?1 WHERE id=?2",
                (&ciphertext, &fixture.id),
            )
            .unwrap();
        assert_eq!(
            read(&fixture.connection, &fixture.id, Some(&fixture.root)),
            Err("AI_CONNECTION_LEGACY_KEY_UNAVAILABLE".into())
        );
        let retained: String = fixture
            .connection
            .query_row(
                "SELECT encrypted_api_key FROM ai_configurations WHERE id=?1",
                [&fixture.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, ciphertext);
    }

    #[test]
    fn endpoint_only_edit_preserves_legacy_and_native_credentials() {
        let fixture = Fixture::new();
        fixture
            .connection
            .execute(
                "UPDATE ai_configurations SET encrypted_api_key='retained-legacy' WHERE id=?1",
                [&fixture.id],
            )
            .unwrap();
        entry(&fixture.id)
            .unwrap()
            .set_password("original-fixture-key")
            .unwrap();
        update_settings(
            &fixture.connection,
            &fixture.id,
            "https://new.example",
            None,
        )
        .unwrap();
        let settings: (String, String) = fixture
            .connection
            .query_row(
                "SELECT api_endpoint, encrypted_api_key FROM ai_configurations WHERE id=?1",
                [&fixture.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            settings,
            ("https://new.example".into(), "retained-legacy".into())
        );
        assert_eq!(
            entry(&fixture.id).unwrap().get_password().unwrap(),
            "original-fixture-key"
        );
    }

    #[test]
    fn rejected_native_write_rolls_back_database_and_preserves_previous_key() {
        let fixture = Fixture::new();
        fixture
            .connection
            .execute(
                "UPDATE ai_configurations SET encrypted_api_key='retained-legacy' WHERE id=?1",
                [&fixture.id],
            )
            .unwrap();
        entry(&fixture.id)
            .unwrap()
            .set_password("original-fixture-key")
            .unwrap();
        // Windows Credential Manager rejects an oversized UTF-16 blob before changing storage.
        assert_eq!(
            update_settings(
                &fixture.connection,
                &fixture.id,
                "https://new.example",
                Some(&"k".repeat(4096))
            ),
            Err(UNAVAILABLE.into())
        );
        let settings: (String, String) = fixture
            .connection
            .query_row(
                "SELECT api_endpoint, encrypted_api_key FROM ai_configurations WHERE id=?1",
                [&fixture.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            settings,
            ("https://fixture.example".into(), "retained-legacy".into())
        );
        assert_eq!(
            entry(&fixture.id).unwrap().get_password().unwrap(),
            "original-fixture-key"
        );
    }

    #[test]
    fn failed_commit_restores_absent_and_cleared_credentials() {
        let fixture = Fixture::new();
        fixture
            .connection
            .execute(
                "UPDATE ai_configurations SET encrypted_api_key='retained-legacy' WHERE id=?1",
                [&fixture.id],
            )
            .unwrap();
        fixture.connection.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE fixture_parent(id INTEGER PRIMARY KEY); CREATE TABLE fixture_child(id INTEGER REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER reject_commit AFTER UPDATE ON ai_configurations BEGIN INSERT INTO fixture_child VALUES (123); END;").unwrap();
        assert_eq!(
            update_settings(
                &fixture.connection,
                &fixture.id,
                "https://new.example",
                Some("replacement-fixture-key")
            ),
            Err("AI_CONNECTION_SETTINGS_WRITE_FAILED".into())
        );
        assert!(matches!(
            entry(&fixture.id).unwrap().get_password(),
            Err(keyring::Error::NoEntry)
        ));
        entry(&fixture.id)
            .unwrap()
            .set_password("original-fixture-key")
            .unwrap();
        assert_eq!(
            update_settings(
                &fixture.connection,
                &fixture.id,
                "https://new.example",
                Some("")
            ),
            Err("AI_CONNECTION_SETTINGS_WRITE_FAILED".into())
        );
        assert_eq!(
            entry(&fixture.id).unwrap().get_password().unwrap(),
            "original-fixture-key"
        );
        let retained: String = fixture
            .connection
            .query_row(
                "SELECT encrypted_api_key FROM ai_configurations WHERE id=?1",
                [&fixture.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, "retained-legacy");
    }

    #[test]
    #[ignore = "Isolated child worker invoked by the credential interruption regression"]
    fn interruption_worker() {
        let path = PathBuf::from(std::env::var_os("WSTUDIO_CREDENTIAL_TEST_DB").unwrap());
        let id = std::env::var("WSTUDIO_CREDENTIAL_TEST_ID").unwrap();
        let action = std::env::var("WSTUDIO_CREDENTIAL_TEST_ACTION").unwrap();
        let connection = Connection::open(&path).unwrap();
        crate::initialize_database(&connection).unwrap();
        // SQLite invokes this hook before committing; exiting skips all Rust destructors.
        unsafe extern "C" fn terminate(context: *mut std::ffi::c_void) -> i32 {
            let (count, target) = unsafe { &mut *context.cast::<(u32, u32)>() };
            *count += 1;
            if count == target {
                std::process::exit(37);
            }
            0
        }
        let mut count = (
            0u32,
            std::env::var("WSTUDIO_CREDENTIAL_TEST_STOP_COMMIT")
                .unwrap()
                .parse::<u32>()
                .unwrap(),
        );
        unsafe {
            rusqlite::ffi::sqlite3_commit_hook(
                connection.handle(),
                Some(terminate),
                (&mut count as *mut (u32, u32)).cast(),
            );
        }
        if action == "recover" {
            read(&connection, &id, None).unwrap();
        } else if action == "import" {
            read(&connection, &id, path.parent()).unwrap();
        } else if action == "delete" {
            delete_configuration(&connection, &id).unwrap();
        } else {
            update_settings(
                &connection,
                &id,
                "https://new.example",
                Some(if action == "clear" {
                    ""
                } else {
                    "replacement-fixture-key"
                }),
            )
            .unwrap();
        }
        panic!("interruption boundary was not reached");
    }

    /// Kill a real host worker after the OS mutation and reopen its SQLite database for recovery.
    #[test]
    fn interrupted_key_change_recovers_before_reading_connection_settings() {
        let fixture = Fixture::new();
        for action in ["replace", "clear"] {
            entry(&fixture.id)
                .unwrap()
                .set_password("original-fixture-key")
                .unwrap();
            fixture.interrupt(action, 2);
            let reopened = Connection::open(fixture.root.join("settings.sqlite")).unwrap();
            crate::initialize_database(&reopened).unwrap();
            assert_eq!(read(&reopened, &fixture.id, None).unwrap(), "original-fixture-key", "interrupted {action} must restore the credential paired with the persisted endpoint");
            let endpoint: String = reopened
                .query_row(
                    "SELECT api_endpoint FROM ai_configurations WHERE id=?1",
                    [&fixture.id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(endpoint, "https://fixture.example");
            fixture.assert_recovery_clean();
        }
    }

    #[test]
    fn startup_recovers_pending_credentials_before_frontend_requests() {
        let fixture = Fixture::new();
        entry(&fixture.id)
            .unwrap()
            .set_password("original-fixture-key")
            .unwrap();
        fixture.interrupt("replace", 2);
        let reopened = Connection::open(fixture.root.join("settings.sqlite")).unwrap();
        crate::initialize_database(&reopened).unwrap();
        recover_pending(&reopened).unwrap();
        assert_eq!(
            entry(&fixture.id).unwrap().get_password().unwrap(),
            "original-fixture-key"
        );
        fixture.assert_recovery_clean();
    }

    #[test]
    fn committed_settings_remain_readable_when_recovery_cleanup_is_rejected() {
        let fixture = Fixture::new();
        entry(&fixture.id)
            .unwrap()
            .set_password("original-fixture-key")
            .unwrap();
        fixture.connection.execute_batch("CREATE TRIGGER reject_cleanup BEFORE DELETE ON ai_credential_recovery BEGIN SELECT RAISE(ABORT, 'fixture cleanup'); END;").unwrap();
        update_settings(
            &fixture.connection,
            &fixture.id,
            "https://new.example",
            Some("replacement-fixture-key"),
        )
        .unwrap();
        // This is the exact snapshot used by the update command's returned settings.
        let settings = read_snapshot(&fixture.connection, &fixture.id, None, |transaction| {
            transaction
                .query_row(
                    "SELECT api_endpoint FROM ai_configurations WHERE id=?1",
                    [&fixture.id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|_| "fixture-read".into())
        })
        .unwrap();
        assert_eq!(
            settings,
            (
                "https://new.example".into(),
                "replacement-fixture-key".into()
            )
        );
        assert_eq!(
            update_settings(
                &fixture.connection,
                &fixture.id,
                "https://ignored.example",
                Some("later-fixture-key")
            ),
            Err("AI_CONNECTION_CREDENTIAL_CLEANUP_PENDING".into())
        );
        assert_eq!(
            entry(&fixture.id).unwrap().get_password().unwrap(),
            "replacement-fixture-key"
        );
        fixture
            .connection
            .execute_batch("DROP TRIGGER reject_cleanup;")
            .unwrap();
        assert_eq!(
            read(&fixture.connection, &fixture.id, None).unwrap(),
            "replacement-fixture-key"
        );
        fixture.assert_recovery_clean();
    }

    #[test]
    fn ignored_recovery_finalize_never_commits_a_new_endpoint_and_key() {
        let fixture = Fixture::new();
        entry(&fixture.id)
            .unwrap()
            .set_password("original-fixture-key")
            .unwrap();
        fixture.connection.execute_batch("CREATE TRIGGER skip_finalize BEFORE UPDATE ON ai_credential_recovery BEGIN SELECT RAISE(IGNORE); END;").unwrap();
        assert!(update_settings(
            &fixture.connection,
            &fixture.id,
            "https://new.example",
            Some("replacement-fixture-key")
        )
        .is_err());
        let endpoint: String = fixture
            .connection
            .query_row(
                "SELECT api_endpoint FROM ai_configurations WHERE id=?1",
                [&fixture.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(endpoint, "https://fixture.example");
        assert_eq!(
            entry(&fixture.id).unwrap().get_password().unwrap(),
            "original-fixture-key"
        );
        fixture
            .connection
            .execute_batch("DROP TRIGGER skip_finalize;")
            .unwrap();
        assert_eq!(
            read(&fixture.connection, &fixture.id, None).unwrap(),
            "original-fixture-key"
        );
        fixture.assert_recovery_clean();
    }

    #[test]
    fn committed_key_changes_survive_interrupted_backup_cleanup() {
        let fixture = Fixture::new();
        for action in ["replace", "clear"] {
            entry(&fixture.id)
                .unwrap()
                .set_password("original-fixture-key")
                .unwrap();
            fixture
                .connection
                .execute(
                    "UPDATE ai_configurations SET encrypted_api_key='retained-legacy' WHERE id=?1",
                    [&fixture.id],
                )
                .unwrap();
            fixture.interrupt(action, 3);
            let reopened = Connection::open(fixture.root.join("settings.sqlite")).unwrap();
            crate::initialize_database(&reopened).unwrap();
            assert_eq!(
                read(&reopened, &fixture.id, None).unwrap(),
                if action == "clear" {
                    ""
                } else {
                    "replacement-fixture-key"
                }
            );
            let settings: (String, String) = reopened
                .query_row(
                    "SELECT api_endpoint, encrypted_api_key FROM ai_configurations WHERE id=?1",
                    [&fixture.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(settings, ("https://new.example".into(), String::new()));
            fixture.assert_recovery_clean();
        }
    }

    #[test]
    fn recovery_can_itself_be_interrupted_and_repeated() {
        let fixture = Fixture::new();
        entry(&fixture.id)
            .unwrap()
            .set_password("original-fixture-key")
            .unwrap();
        fixture.interrupt("replace", 2);
        fixture.interrupt("recover", 1);
        assert_eq!(
            read(&fixture.connection, &fixture.id, None).unwrap(),
            "original-fixture-key"
        );
        assert_eq!(
            read(&fixture.connection, &fixture.id, None).unwrap(),
            "original-fixture-key"
        );
        fixture.assert_recovery_clean();
    }

    #[test]
    fn interrupted_preparation_never_changes_the_live_credential() {
        let fixture = Fixture::new();
        entry(&fixture.id)
            .unwrap()
            .set_password("original-fixture-key")
            .unwrap();
        fixture.interrupt("replace", 1);
        assert_eq!(
            read(&fixture.connection, &fixture.id, None).unwrap(),
            "original-fixture-key"
        );
        fixture.assert_recovery_clean();
    }

    #[test]
    fn interrupted_creation_restores_absence_instead_of_retaining_a_new_key() {
        let fixture = Fixture::new();
        fixture.interrupt("replace", 2);
        assert_eq!(read(&fixture.connection, &fixture.id, None).unwrap(), "");
        fixture.assert_recovery_clean();
    }

    #[test]
    fn missing_required_backup_preserves_pending_recovery_and_blocks_key_use() {
        let fixture = Fixture::new();
        entry(&fixture.id)
            .unwrap()
            .set_password("original-fixture-key")
            .unwrap();
        fixture.interrupt("replace", 2);
        backup_entry(&fixture.id)
            .unwrap()
            .delete_credential()
            .unwrap();
        assert_eq!(
            read(&fixture.connection, &fixture.id, None),
            Err("AI_CONNECTION_CREDENTIAL_RECOVERY_FAILED".into())
        );
        let pending: i64 = fixture.connection.query_row("SELECT COUNT(*) FROM ai_credential_recovery WHERE configuration_id=?1 AND finalized=0", [&fixture.id], |row| row.get(0)).unwrap();
        assert_eq!(pending, 1);
    }

    #[test]
    fn interrupted_operation_never_persists_plaintext_secrets_in_sqlite() {
        let fixture = Fixture::new();
        entry(&fixture.id)
            .unwrap()
            .set_password("original-fixture-key")
            .unwrap();
        fixture.interrupt("replace", 2);
        for path in [
            fixture.root.join("settings.sqlite"),
            fixture.root.join("settings.sqlite-wal"),
        ] {
            let bytes = fs::read(path).unwrap();
            for secret in [
                b"original-fixture-key".as_slice(),
                b"replacement-fixture-key".as_slice(),
            ] {
                assert!(!bytes.windows(secret.len()).any(|bytes| bytes == secret));
            }
        }
        assert_eq!(
            read(&fixture.connection, &fixture.id, None).unwrap(),
            "original-fixture-key"
        );
        fixture.assert_recovery_clean();
    }

    #[test]
    fn connection_snapshot_blocks_a_competing_endpoint_and_key_update() {
        let fixture = Fixture::new();
        entry(&fixture.id)
            .unwrap()
            .set_password("original-fixture-key")
            .unwrap();
        let path = fixture.root.join("settings.sqlite");
        let id = fixture.id.clone();
        let (start_tx, start_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let connection = Connection::open(path).unwrap();
            start_rx.recv().unwrap();
            update_settings(
                &connection,
                &id,
                "https://new.example",
                Some("replacement-fixture-key"),
            )
            .unwrap();
            done_tx.send(()).unwrap();
        });
        let snapshot = read_snapshot(&fixture.connection, &fixture.id, None, |transaction| {
            let endpoint: String = transaction
                .query_row(
                    "SELECT api_endpoint FROM ai_configurations WHERE id=?1",
                    [&fixture.id],
                    |row| row.get(0),
                )
                .unwrap();
            start_tx.send(()).unwrap();
            assert!(matches!(
                done_rx.recv_timeout(Duration::from_millis(100)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ));
            Ok(endpoint)
        })
        .unwrap();
        assert_eq!(
            snapshot,
            (
                "https://fixture.example".into(),
                "original-fixture-key".into()
            )
        );
        done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
        assert_eq!(
            read(&fixture.connection, &fixture.id, None).unwrap(),
            "replacement-fixture-key"
        );
    }

    #[test]
    fn automatic_database_rollback_keeps_the_independent_credential_lock() {
        let fixture = Fixture::new();
        let path = fixture.root.join("settings.sqlite");
        let id = fixture.id.clone();
        let (start_tx, start_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let connection = Connection::open(path).unwrap();
            start_rx.recv().unwrap();
            update_settings(
                &connection,
                &id,
                "https://new.example",
                Some("replacement-fixture-key"),
            )
            .unwrap();
            done_tx.send(()).unwrap();
        });
        let result: Result<((), String), String> = read_snapshot(
            &fixture.connection,
            &fixture.id,
            None,
            |transaction| {
                transaction.execute_batch("CREATE TEMP TRIGGER reject_auto BEFORE UPDATE ON ai_configurations BEGIN SELECT RAISE(ROLLBACK, 'fixture rollback'); END;").unwrap();
                assert!(transaction
                    .execute(
                        "UPDATE ai_configurations SET api_endpoint='discarded' WHERE id=?1",
                        [&fixture.id]
                    )
                    .is_err());
                assert!(
                    transaction.is_autocommit(),
                    "SQLite has already released its transaction lock"
                );
                start_tx.send(()).unwrap();
                assert!(matches!(
                    done_rx.recv_timeout(Duration::from_millis(100)),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                ));
                Err("fixture-rollback".into())
            },
        );
        assert_eq!(result, Err("fixture-rollback".into()));
        done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        worker.join().unwrap();
        assert_eq!(
            read(&fixture.connection, &fixture.id, None).unwrap(),
            "replacement-fixture-key"
        );
    }

    #[test]
    #[ignore = "Requires the installed Electron runtime to generate an independent disposable safeStorage fixture"]
    fn actual_electron_secret_is_imported_once_and_source_is_preserved() {
        let fixture = Fixture::new();
        let ciphertext = fixture.electron_ciphertext();
        let local_state = fs::read(fixture.root.join("Local State")).unwrap();
        fixture
            .connection
            .execute(
                "UPDATE ai_configurations SET encrypted_api_key=?1 WHERE id=?2",
                (&ciphertext, &fixture.id),
            )
            .unwrap();
        fixture.interrupt("import", 2);
        assert_eq!(
            read(&fixture.connection, &fixture.id, None),
            Err("AI_CONNECTION_LEGACY_KEY_UNAVAILABLE".into()),
            "an incomplete import must be rolled back before a source-free credential read"
        );
        assert!(matches!(
            entry(&fixture.id).unwrap().get_password(),
            Err(keyring::Error::NoEntry)
        ));
        let result = read(&fixture.connection, &fixture.id, Some(&fixture.root)).unwrap();
        assert_eq!(result, "wstudio-public-migration-fixture");
        assert_eq!(entry(&fixture.id).unwrap().get_password().unwrap(), result);
        let retained: String = fixture
            .connection
            .query_row(
                "SELECT encrypted_api_key FROM ai_configurations WHERE id=?1",
                [&fixture.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(retained.is_empty());
        assert_eq!(
            fs::read(fixture.root.join("Local State")).unwrap(),
            local_state
        );
        assert_eq!(
            read(&fixture.connection, &fixture.id, None).unwrap(),
            result
        );
        entry(&fixture.id).unwrap().delete_credential().unwrap();
        fixture
            .connection
            .execute(
                "UPDATE ai_configurations SET encrypted_api_key=?1 WHERE id=?2",
                (&ciphertext, &fixture.id),
            )
            .unwrap();
        fixture.interrupt("import", 3);
        assert_eq!(
            read(&fixture.connection, &fixture.id, None).unwrap(),
            result,
            "a committed import survives interrupted cleanup without needing the source"
        );
        fixture.assert_recovery_clean();
        // SQL rejection must compensate the credential created by this import.
        entry(&fixture.id).unwrap().delete_credential().unwrap();
        fixture
            .connection
            .execute(
                "UPDATE ai_configurations SET encrypted_api_key=?1 WHERE id=?2",
                (&ciphertext, &fixture.id),
            )
            .unwrap();
        fixture.connection.execute_batch("CREATE TRIGGER reject_import BEFORE UPDATE ON ai_configurations BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END;").unwrap();
        assert_eq!(
            read(&fixture.connection, &fixture.id, Some(&fixture.root)),
            Err("AI_CONNECTION_SETTINGS_WRITE_FAILED".into())
        );
        assert!(matches!(
            entry(&fixture.id).unwrap().get_password(),
            Err(keyring::Error::NoEntry)
        ));
        fixture.connection.execute_batch("DROP TRIGGER reject_import; PRAGMA foreign_keys=ON; CREATE TABLE fixture_parent(id INTEGER PRIMARY KEY); CREATE TABLE fixture_child(id INTEGER REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER reject_commit AFTER UPDATE ON ai_configurations BEGIN INSERT INTO fixture_child VALUES (123); END;").unwrap();
        assert_eq!(
            read(&fixture.connection, &fixture.id, Some(&fixture.root)),
            Err("AI_CONNECTION_SETTINGS_WRITE_FAILED".into())
        );
        assert!(matches!(
            entry(&fixture.id).unwrap().get_password(),
            Err(keyring::Error::NoEntry)
        ));
        let retained: String = fixture
            .connection
            .query_row(
                "SELECT encrypted_api_key FROM ai_configurations WHERE id=?1",
                [&fixture.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, ciphertext);
        fixture
            .connection
            .execute_batch("DROP TRIGGER reject_commit;")
            .unwrap();
        // A separately generated valid envelope fails authentication after ciphertext tampering.
        use base64::{engine::general_purpose::STANDARD, Engine};
        let mut corrupted = STANDARD.decode(&ciphertext).unwrap();
        *corrupted.last_mut().unwrap() ^= 1;
        let corrupted = STANDARD.encode(corrupted);
        fixture
            .connection
            .execute(
                "UPDATE ai_configurations SET encrypted_api_key=?1 WHERE id=?2",
                (&corrupted, &fixture.id),
            )
            .unwrap();
        assert_eq!(
            read(&fixture.connection, &fixture.id, Some(&fixture.root)),
            Err("AI_CONNECTION_LEGACY_KEY_INVALID".into())
        );
        let retained: String = fixture
            .connection
            .query_row(
                "SELECT encrypted_api_key FROM ai_configurations WHERE id=?1",
                [&fixture.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, corrupted);
        assert!(matches!(
            entry(&fixture.id).unwrap().get_password(),
            Err(keyring::Error::NoEntry)
        ));
        assert_eq!(
            fs::read(fixture.root.join("Local State")).unwrap(),
            local_state
        );
    }
}
