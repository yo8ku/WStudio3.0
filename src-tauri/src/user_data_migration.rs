//! Import Electron application data into Rust storage without replacing existing Tauri data.

use rusqlite::{
    backup::{Backup, StepResult},
    Connection, OpenFlags,
};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const COMPLETE: &str = "user-data-migration-v1.complete";
const MAX_THEME_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TOTAL_THEME_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DATABASE_BYTES: u64 = 512 * 1024 * 1024;

/// Reject symlinks and Windows junction/reparse points in every existing path component.
fn checked_exists(path: &Path) -> Result<bool, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("USER_DATA_MIGRATION_PATH_INVALID".into());
    }
    let mut exists = false;
    for (index, ancestor) in path.ancestors().enumerate() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                #[cfg(windows)]
                let redirected = {
                    use std::os::windows::fs::MetadataExt;
                    metadata.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let redirected = metadata.file_type().is_symlink();
                if redirected || metadata.file_type().is_symlink() {
                    return Err("USER_DATA_MIGRATION_PATH_INVALID".into());
                }
                if index == 0 {
                    exists = true;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("USER_DATA_MIGRATION_READ_FAILED".into()),
        }
    }
    Ok(exists)
}

/// Bound reads even if another process grows a source file after metadata is checked.
fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    checked_exists(path)?;
    let file = fs::File::open(path).map_err(|_| "USER_DATA_MIGRATION_READ_FAILED")?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "USER_DATA_MIGRATION_READ_FAILED")?;
    if bytes.len() as u64 > limit {
        return Err("USER_DATA_MIGRATION_TOO_LARGE".into());
    }
    Ok(bytes)
}

/// Write complete staged files before publishing their names in the destination directory.
fn write_staged(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("USER_DATA_MIGRATION_PATH_INVALID")?;
    checked_exists(parent)?;
    fs::create_dir_all(parent).map_err(|_| "USER_DATA_MIGRATION_WRITE_FAILED")?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "USER_DATA_MIGRATION_WRITE_FAILED")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "USER_DATA_MIGRATION_WRITE_FAILED".into())
}

/// SQLite backup reads committed WAL data; only the staged snapshot receives schema upgrades.
fn stage_database(source: &Path, staging: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if !checked_exists(source)? {
        return Ok(());
    }
    if fs::metadata(source)
        .map_err(|_| "USER_DATA_MIGRATION_READ_FAILED")?
        .len()
        > MAX_DATABASE_BYTES
    {
        return Err("USER_DATA_MIGRATION_TOO_LARGE".into());
    }
    for suffix in ["-wal", "-shm"] {
        let mut companion = source.as_os_str().to_os_string();
        companion.push(suffix);
        checked_exists(Path::new(&companion))?;
    }
    let original = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "USER_DATA_MIGRATION_DATABASE_INVALID")?;
    let relative = PathBuf::from("database/wstudio.sqlite");
    let snapshot = staging.join(&relative);
    fs::create_dir_all(snapshot.parent().unwrap())
        .map_err(|_| "USER_DATA_MIGRATION_WRITE_FAILED")?;
    let mut imported =
        Connection::open(&snapshot).map_err(|_| "USER_DATA_MIGRATION_WRITE_FAILED")?;
    {
        let backup = Backup::new(&original, &mut imported)
            .map_err(|_| "USER_DATA_MIGRATION_DATABASE_INVALID")?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match backup
                .step(256)
                .map_err(|_| "USER_DATA_MIGRATION_DATABASE_INVALID")?
            {
                StepResult::Done => break,
                _ if Instant::now() >= deadline => {
                    return Err("USER_DATA_MIGRATION_DATABASE_BUSY".into())
                }
                StepResult::Busy | StepResult::Locked => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                _ => (),
            }
            if fs::metadata(&snapshot)
                .map_err(|_| "USER_DATA_MIGRATION_READ_FAILED")?
                .len()
                > MAX_DATABASE_BYTES
            {
                return Err("USER_DATA_MIGRATION_TOO_LARGE".into());
            }
        }
    }
    let check: String = imported
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|_| "USER_DATA_MIGRATION_DATABASE_INVALID")?;
    if check != "ok" {
        return Err("USER_DATA_MIGRATION_DATABASE_INVALID".into());
    }
    super::initialize_database(&imported).map_err(|_| "USER_DATA_MIGRATION_DATABASE_INVALID")?;
    imported
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")
        .map_err(|_| "USER_DATA_MIGRATION_DATABASE_INVALID")?;
    drop(imported);
    if fs::metadata(&snapshot)
        .map_err(|_| "USER_DATA_MIGRATION_READ_FAILED")?
        .len()
        > MAX_DATABASE_BYTES
    {
        return Err("USER_DATA_MIGRATION_TOO_LARGE".into());
    }
    fs::OpenOptions::new()
        .write(true)
        .open(snapshot)
        .and_then(|file| file.sync_all())
        .map_err(|_| "USER_DATA_MIGRATION_WRITE_FAILED")?;
    files.push(relative);
    Ok(())
}

/// Preserve nested JSON theme files and skip names already owned by the Tauri installation.
fn stage_themes(
    source: &Path,
    target: &Path,
    staging: &Path,
    relative: &Path,
    depth: usize,
    bytes: &mut u64,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let directory = source.join(relative);
    if !checked_exists(&directory)? {
        return Ok(());
    }
    if depth > 16 {
        return Err("USER_DATA_MIGRATION_TOO_LARGE".into());
    }
    for entry in fs::read_dir(directory).map_err(|_| "USER_DATA_MIGRATION_READ_FAILED")? {
        let entry = entry.map_err(|_| "USER_DATA_MIGRATION_READ_FAILED")?;
        checked_exists(&entry.path())?;
        let next = relative.join(entry.file_name());
        let metadata = entry
            .metadata()
            .map_err(|_| "USER_DATA_MIGRATION_READ_FAILED")?;
        if metadata.is_dir() {
            stage_themes(source, target, staging, &next, depth + 1, bytes, files)?;
        } else if metadata.is_file()
            && entry
                .path()
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
            && !checked_exists(&target.join(&next))?
        {
            let contents = read_bounded(&entry.path(), MAX_THEME_BYTES)?;
            *bytes += contents.len() as u64;
            if *bytes > MAX_TOTAL_THEME_BYTES || files.len() >= 4096 {
                return Err("USER_DATA_MIGRATION_TOO_LARGE".into());
            }
            write_staged(&staging.join(&next), &contents)?;
            files.push(next);
        }
    }
    Ok(())
}

/// Convert Electron UUID/path records into canonical Rust repository identities.
fn stage_workspace(source: &Path, staging: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let legacy = source.join("recent-repositories.json");
    if !checked_exists(&legacy)? {
        return Ok(());
    }
    let contents = read_bounded(&legacy, 1024 * 1024)?;
    let raw: serde_json::Value =
        serde_json::from_slice(&contents).map_err(|_| "USER_DATA_MIGRATION_WORKSPACE_INVALID")?;
    let items = raw
        .as_array()
        .ok_or("USER_DATA_MIGRATION_WORKSPACE_INVALID")?;
    let mut recent = Vec::new();
    for item in items {
        let (Some(_), Some(name), Some(root)) = (
            item["id"].as_str(),
            item["name"].as_str(),
            item["rootPath"].as_str(),
        ) else {
            continue;
        };
        if !Path::new(root).is_absolute() {
            continue;
        }
        let Ok(root) = super::canonical_directory(root) else {
            continue;
        };
        let mut entry = super::recent_from_root(&root);
        if recent
            .iter()
            .any(|existing: &super::RecentRepository| existing.id == entry.id)
        {
            continue;
        }
        if !name.trim().is_empty() && !name.contains(['/', '\\']) && name.len() <= 256 {
            entry.name = name.trim().into();
        }
        recent.push(entry);
        if recent.len() == 20 {
            break;
        }
    }
    let workspace = super::PersistedWorkspace {
        current_path: recent.first().map(|entry| entry.root_path.clone()),
        recent_repositories: recent,
        recent_closed_tabs: Vec::new(),
    };
    let relative = PathBuf::from("workspace.json");
    write_staged(
        &staging.join(&relative),
        &serde_json::to_vec_pretty(&workspace)
            .map_err(|_| "USER_DATA_MIGRATION_WORKSPACE_INVALID")?,
    )?;
    files.push(relative);
    Ok(())
}

/// Hard-link publication is atomic and refuses replacement even if another process wins a race.
fn publish(staging: &Path, target: &Path, relative: &Path) -> Result<(), String> {
    let destination = target.join(relative);
    if checked_exists(&destination)? {
        return Ok(());
    }
    fs::create_dir_all(destination.parent().unwrap())
        .map_err(|_| "USER_DATA_MIGRATION_WRITE_FAILED")?;
    checked_exists(&destination)?;
    match fs::hard_link(staging.join(relative), &destination) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            checked_exists(&destination)?;
            Ok(())
        }
        Err(_) => Err("USER_DATA_MIGRATION_WRITE_FAILED".into()),
    }
}

/// Import application data once, leaving the Electron source available for rollback.
pub(crate) fn migrate_user_data(source: &Path, target: &Path) -> Result<bool, String> {
    if !checked_exists(source)? {
        return Ok(false);
    }
    checked_exists(target)?;
    if source == target {
        return Ok(false);
    }
    if source.starts_with(target) || target.starts_with(source) {
        return Err("USER_DATA_MIGRATION_PATH_INVALID".into());
    }
    if checked_exists(&target.join(COMPLETE))? {
        return Ok(false);
    }
    fs::create_dir_all(target).map_err(|_| "USER_DATA_MIGRATION_WRITE_FAILED")?;
    let staging = target.join(format!(".user-data-migration-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging).map_err(|_| "USER_DATA_MIGRATION_WRITE_FAILED")?;
    let result = (|| {
        let mut files = Vec::new();
        if !checked_exists(&target.join("database/wstudio.sqlite"))? {
            stage_database(
                &source.join("database/wstudio.sqlite"),
                &staging,
                &mut files,
            )?;
        }
        stage_themes(
            source,
            target,
            &staging,
            Path::new("themes"),
            0,
            &mut 0,
            &mut files,
        )?;
        if !checked_exists(&target.join("workspace.json"))? {
            stage_workspace(source, &staging, &mut files)?;
        }
        write_staged(
            &staging.join(COMPLETE),
            b"wstudio-tauri-user-data-migration-v1\n",
        )?;
        for relative in files {
            publish(&staging, target, &relative)?;
        }
        publish(&staging, target, Path::new(COMPLETE))?;
        Ok(true)
    })();
    fs::remove_dir_all(&staging).map_err(|_| "USER_DATA_MIGRATION_WRITE_FAILED")?;
    result
}

#[cfg(test)]
mod tests {
    use super::migrate_user_data;
    use rusqlite::Connection;
    use serde_json::json;
    use std::{fs, path::PathBuf};

    struct Fixture {
        root: PathBuf,
        source: PathBuf,
        target: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("wstudio-user-migration-{}", uuid::Uuid::new_v4()));
            let source = root.join("electron");
            let target = root.join("tauri");
            fs::create_dir_all(&source).unwrap();
            Self {
                root,
                source,
                target,
            }
        }

        fn database(&self) -> Connection {
            fs::create_dir_all(self.source.join("database")).unwrap();
            Connection::open(self.source.join("database/wstudio.sqlite")).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    fn database_snapshot_includes_uncheckpointed_wal_and_keeps_source_contents() {
        let fixture = Fixture::new();
        let source = fixture.database();
        source.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
            CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
            INSERT INTO app_settings VALUES ('theme', 'user-dark', 42);").unwrap();
        let main_before = fs::read(fixture.source.join("database/wstudio.sqlite")).unwrap();
        let wal_before = fs::read(fixture.source.join("database/wstudio.sqlite-wal")).unwrap();

        assert!(migrate_user_data(&fixture.source, &fixture.target).unwrap());
        let imported = Connection::open(fixture.target.join("database/wstudio.sqlite")).unwrap();
        let value: String = imported
            .query_row(
                "SELECT value FROM app_settings WHERE key='theme'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, "user-dark");
        assert_eq!(
            fs::read(fixture.source.join("database/wstudio.sqlite")).unwrap(),
            main_before
        );
        assert_eq!(
            fs::read(fixture.source.join("database/wstudio.sqlite-wal")).unwrap(),
            wal_before
        );
        drop(imported);
        drop(source);
    }

    #[test]
    fn legacy_ai_schema_is_upgraded_in_snapshot_and_ciphertext_is_preserved() {
        let fixture = Fixture::new();
        let source = fixture.database();
        source.execute_batch("CREATE TABLE ai_models (id TEXT PRIMARY KEY, name TEXT, group_name TEXT, endpoint_type TEXT, created_at INTEGER, updated_at INTEGER);
            INSERT INTO ai_models VALUES ('model', 'Model', 'Group', 'openai', 10, 11);
            CREATE TABLE ai_connection_settings (singleton INTEGER PRIMARY KEY, api_endpoint TEXT, encrypted_api_key TEXT);
            INSERT INTO ai_connection_settings VALUES (1, 'https://legacy.example/v1', 'electron-ciphertext');").unwrap();
        assert!(migrate_user_data(&fixture.source, &fixture.target).unwrap());
        let imported = Connection::open(fixture.target.join("database/wstudio.sqlite")).unwrap();
        let row: (String, String) = imported
            .query_row(
                "SELECT api_endpoint, encrypted_api_key FROM ai_configurations WHERE id='default'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            row,
            (
                "https://legacy.example/v1".into(),
                "electron-ciphertext".into()
            )
        );
        let status: i32 = imported.query_row("SELECT connection_succeeded FROM ai_models WHERE configuration_id='default' AND id='model'", [], |row| row.get(0)).unwrap();
        assert_eq!(status, 0);
        assert!(source
            .prepare("SELECT singleton FROM ai_connection_settings")
            .is_ok());
        drop(imported);
        drop(source);
    }

    #[test]
    fn existing_database_workspace_and_theme_win_but_missing_themes_are_imported() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.source.join("themes/custom")).unwrap();
        fs::create_dir_all(fixture.target.join("themes/custom")).unwrap();
        fs::create_dir_all(fixture.target.join("database")).unwrap();
        fs::write(
            fixture.source.join("themes/custom/existing.json"),
            br#"{"id":"old"}"#,
        )
        .unwrap();
        fs::write(
            fixture.source.join("themes/custom/new.json"),
            br#"{"id":"new"}"#,
        )
        .unwrap();
        fs::write(
            fixture.target.join("themes/custom/existing.json"),
            b"current-theme",
        )
        .unwrap();
        fs::write(fixture.target.join("workspace.json"), b"current-workspace").unwrap();
        fs::write(
            fixture.target.join("database/wstudio.sqlite"),
            b"current-database",
        )
        .unwrap();
        fs::write(
            fixture.source.join("recent-repositories.json"),
            b"invalid legacy workspace",
        )
        .unwrap();
        assert!(migrate_user_data(&fixture.source, &fixture.target).unwrap());
        assert_eq!(
            fs::read(fixture.target.join("themes/custom/existing.json")).unwrap(),
            b"current-theme"
        );
        assert_eq!(
            fs::read(fixture.target.join("themes/custom/new.json")).unwrap(),
            br#"{"id":"new"}"#
        );
        assert_eq!(
            fs::read(fixture.target.join("workspace.json")).unwrap(),
            b"current-workspace"
        );
        assert_eq!(
            fs::read(fixture.target.join("database/wstudio.sqlite")).unwrap(),
            b"current-database"
        );
    }

    #[test]
    fn recent_repositories_convert_to_tauri_format_and_restore_first_existing_root() {
        let fixture = Fixture::new();
        let repository = fixture.root.join("笔记仓库");
        fs::create_dir(&repository).unwrap();
        fs::write(
            fixture.source.join("recent-repositories.json"),
            serde_json::to_vec(&json!([
                {"id":"gone", "name":"Gone", "rootPath":fixture.root.join("missing")},
                {"id":"electron-uuid", "name":"我的笔记", "rootPath":repository},
                {"id":"duplicate", "name":"Duplicate", "rootPath":repository},
                {"id":42, "rootPath":repository}
            ]))
            .unwrap(),
        )
        .unwrap();
        assert!(migrate_user_data(&fixture.source, &fixture.target).unwrap());
        let workspace: crate::PersistedWorkspace =
            serde_json::from_slice(&fs::read(fixture.target.join("workspace.json")).unwrap())
                .unwrap();
        let canonical = repository.canonicalize().unwrap();
        assert_eq!(workspace.current_path.as_deref(), canonical.to_str());
        assert_eq!(workspace.recent_repositories.len(), 1);
        assert_eq!(workspace.recent_repositories[0].name, "我的笔记");
        assert_ne!(workspace.recent_repositories[0].id, "electron-uuid");
        let restored =
            crate::restore_workspace_state(fixture.target.join("workspace.json")).unwrap();
        assert_eq!(*restored.root.lock().unwrap(), canonical);
        assert_eq!(restored.recent.lock().unwrap()[0].name, "我的笔记");
        restored.persist().unwrap();
        let saved: crate::PersistedWorkspace =
            serde_json::from_slice(&fs::read(fixture.target.join("workspace.json")).unwrap())
                .unwrap();
        assert_eq!(saved.recent_repositories[0].name, "我的笔记");
    }

    #[test]
    fn completion_marker_prevents_reimporting_a_deleted_theme() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.source.join("themes")).unwrap();
        fs::write(fixture.source.join("themes/old.json"), b"{}").unwrap();
        assert!(migrate_user_data(&fixture.source, &fixture.target).unwrap());
        fs::remove_file(fixture.target.join("themes/old.json")).unwrap();
        assert!(!migrate_user_data(&fixture.source, &fixture.target).unwrap());
        assert!(!fixture.target.join("themes/old.json").exists());
    }

    #[test]
    fn corrupt_database_never_publishes_target_and_can_be_retried() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.source.join("database")).unwrap();
        fs::write(
            fixture.source.join("database/wstudio.sqlite"),
            b"corrupt sqlite",
        )
        .unwrap();
        assert_eq!(
            migrate_user_data(&fixture.source, &fixture.target).unwrap_err(),
            "USER_DATA_MIGRATION_DATABASE_INVALID"
        );
        assert!(!fixture.target.join("database/wstudio.sqlite").exists());
        assert!(!fixture
            .target
            .join("user-data-migration-v1.complete")
            .exists());
        fs::remove_file(fixture.source.join("database/wstudio.sqlite")).unwrap();
        let source = fixture.database();
        source
            .execute_batch(
                "CREATE TABLE example (value TEXT); INSERT INTO example VALUES ('retry');",
            )
            .unwrap();
        drop(source);
        assert!(migrate_user_data(&fixture.source, &fixture.target).unwrap());
        assert!(!fs::read_dir(&fixture.target).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".user-data-migration-")));
    }

    #[test]
    fn corrupt_workspace_is_retryable_without_publishing_or_completing() {
        let fixture = Fixture::new();
        let source = fixture.database();
        source
            .execute_batch("CREATE TABLE example (value TEXT);")
            .unwrap();
        drop(source);
        fs::write(fixture.source.join("recent-repositories.json"), b"not-json").unwrap();
        assert_eq!(
            migrate_user_data(&fixture.source, &fixture.target).unwrap_err(),
            "USER_DATA_MIGRATION_WORKSPACE_INVALID"
        );
        assert!(!fixture.target.join("workspace.json").exists());
        assert!(!fixture.target.join("database/wstudio.sqlite").exists());
        assert!(!fixture
            .target
            .join("user-data-migration-v1.complete")
            .exists());
    }

    #[test]
    fn absent_legacy_directory_does_not_create_target_or_completion_marker() {
        let fixture = Fixture::new();
        assert!(!migrate_user_data(&fixture.root.join("absent"), &fixture.target).unwrap());
        assert!(!fixture.target.exists());
    }

    #[test]
    fn oversized_theme_aborts_before_publishing_staged_database() {
        let fixture = Fixture::new();
        let source = fixture.database();
        source
            .execute_batch("CREATE TABLE example (value TEXT);")
            .unwrap();
        drop(source);
        fs::create_dir(fixture.source.join("themes")).unwrap();
        fs::File::create(fixture.source.join("themes/large.json"))
            .unwrap()
            .set_len(2 * 1024 * 1024 + 1)
            .unwrap();
        assert_eq!(
            migrate_user_data(&fixture.source, &fixture.target).unwrap_err(),
            "USER_DATA_MIGRATION_TOO_LARGE"
        );
        assert!(!fixture.target.join("database/wstudio.sqlite").exists());
        assert!(!fixture.target.join("themes/large.json").exists());
        assert!(!fixture
            .target
            .join("user-data-migration-v1.complete")
            .exists());
    }

    /// Exercise Windows junctions without requiring symbolic-link privileges.
    #[cfg(windows)]
    fn redirect_directory(link: &std::path::Path, target: &std::path::Path) {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(output.status.success(), "junction creation failed");
    }

    #[cfg(unix)]
    fn redirect_directory(link: &std::path::Path, target: &std::path::Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[test]
    fn redirected_theme_source_is_rejected_without_copying_external_data() {
        let fixture = Fixture::new();
        let outside = fixture.root.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("private.json"), b"external-data").unwrap();
        redirect_directory(&fixture.source.join("themes"), &outside);
        assert_eq!(
            migrate_user_data(&fixture.source, &fixture.target).unwrap_err(),
            "USER_DATA_MIGRATION_PATH_INVALID"
        );
        assert!(!fixture.target.join("themes/private.json").exists());
        assert!(!fixture
            .target
            .join("user-data-migration-v1.complete")
            .exists());
        assert_eq!(
            fs::read(outside.join("private.json")).unwrap(),
            b"external-data"
        );
    }

    #[test]
    fn redirected_destination_ancestor_is_rejected_without_writing_external_data() {
        let fixture = Fixture::new();
        let outside = fixture.root.join("outside");
        fs::create_dir(&outside).unwrap();
        let alias = fixture.root.join("alias");
        redirect_directory(&alias, &outside);
        assert_eq!(
            migrate_user_data(&fixture.source, &alias.join("tauri")).unwrap_err(),
            "USER_DATA_MIGRATION_PATH_INVALID"
        );
        assert!(!outside.join("tauri").exists());
    }
}
