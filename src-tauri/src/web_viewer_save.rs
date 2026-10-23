//! Store only webpage URLs through bounded, scoped, atomic repository saves.
use crate::file_commit::{create_staging, install as install_link, pin_directories};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const MAX_LINK_BYTES: usize = 8 * 1024;

/// The save dialog approves this exact filesystem object and content.
pub(crate) struct Target {
    pub(crate) relative: String,
    original: Option<Vec<u8>>,
    identity: Option<String>,
}

/// Derive a conservative filename; native dialogs handle any final user rename.
fn default_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .filter(|char| !char.is_control() && !"<>:\"/\\|?*".contains(*char))
        .take(80)
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']);
    let stem = cleaned
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    format!(
        "{}.url",
        if cleaned.is_empty() || reserved {
            "网页"
        } else {
            cleaned
        }
    )
}

/// Bound every wait by the request deadline; late native callbacks only drop their result.
fn remaining(deadline: u64) -> Result<Duration, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "PLUGIN_API_FAILED")?
        .as_millis() as u64;
    if now >= deadline {
        return Err("PLUGIN_REQUEST_TIMEOUT".into());
    }
    Ok(Duration::from_millis(deadline - now))
}

/// Native dialogs use this bounded wait, including cancellation and late results.
fn wait_native<T>(receive: mpsc::Receiver<T>, deadline: u64, limit: Duration) -> Result<T, String> {
    let result = receive
        .recv_timeout(remaining(deadline)?.min(limit))
        .map_err(|_| "PLUGIN_REQUEST_TIMEOUT")?;
    remaining(deadline)?;
    Ok(result)
}

/// Display a parented native save dialog without blocking Tauri's UI thread.
pub(crate) fn pick_destination(
    app: &AppHandle,
    window: &str,
    root: &Path,
    title: &str,
    deadline: u64,
) -> Result<Option<PathBuf>, String> {
    remaining(deadline)?;
    let parent = app.get_window(window).ok_or("PLUGIN_RUNTIME_TERMINATED")?;
    let (send, receive) = mpsc::sync_channel(1);
    app.dialog()
        .file()
        .set_parent(&parent)
        .set_title("保存链接到仓库")
        .set_directory(root)
        .set_file_name(default_name(title))
        .add_filter("网页链接 (URL)", &["url"])
        .save_file(move |selected| {
            let _ = send.send(selected);
        });
    let selected = wait_native(receive, deadline, Duration::from_secs(300))?;
    selected
        .map(|path| {
            path.into_path()
                .map_err(|_| "PLUGIN_DIALOG_PATH_INVALID".into())
        })
        .transpose()
}

/// Enforce the existing repository path rules for both new files and approved replacements.
fn resolve_target(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if !relative.ends_with(".url") {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    match super::resolve_plugin_new_path(root, relative) {
        Ok(path) => Ok(path),
        Err(code) if code == "PLUGIN_FILESYSTEM_ALREADY_EXISTS" => {
            let path = super::resolve_plugin_existing_path(root, relative)?;
            if !path.is_file() {
                return Err("PLUGIN_FILESYSTEM_NOT_FILE".into());
            }
            Ok(path)
        }
        Err(code) => Err(code),
    }
}

/// Read a bounded baseline for replacement conflict detection.
fn read_original(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("PLUGIN_FILESYSTEM_READ_FAILED".into()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_LINK_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")?;
    if bytes.len() > MAX_LINK_BYTES {
        return Err("PLUGIN_FILESYSTEM_FILE_TOO_LARGE".into());
    }
    Ok(Some(bytes))
}

/// Map the selected native path to the same relative scope used by other workspace writes.
pub(crate) fn select_target(
    root: &Path,
    selected: &Path,
    manifest: &Value,
) -> Result<Target, String> {
    if !selected.is_absolute() {
        return Err("PLUGIN_FILESYSTEM_PATH_INVALID".into());
    }
    let parent = selected
        .parent()
        .ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?
        .canonicalize()
        .map_err(|_| "PLUGIN_FILESYSTEM_PARENT_NOT_FOUND")?;
    let name = selected
        .file_name()
        .ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?;
    let path = parent.join(name);
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "PLUGIN_PERMISSION_SCOPE_VIOLATION")?
        .to_str()
        .ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?
        .replace('\\', "/");
    if !super::plugin_path_has_permission(manifest, "workspace.write", &relative) {
        return Err("PLUGIN_PERMISSION_SCOPE_VIOLATION".into());
    }
    let path = resolve_target(root, &relative)?;
    let original = read_original(&path)?;
    let identity = original
        .as_ref()
        .map(|_| super::plugin_path_identity(&path))
        .transpose()?;
    if read_original(&path)? != original {
        return Err("PLUGIN_WRITE_CONFLICT".into());
    }
    Ok(Target {
        relative,
        original,
        identity,
    })
}

/// Encode an Internet Shortcut containing only the validated HTTP(S) address.
pub(crate) fn encode_link(url: &str) -> Result<Vec<u8>, String> {
    let url = super::web_viewer::parse_url(url)?;
    Ok(format!("[InternetShortcut]\r\nURL={}\r\n", url.as_str()).into_bytes())
}

/// Stage in the destination directory, recheck identity/scope/content, then atomically install.
pub(crate) fn commit_link(
    root: &Path,
    target: &Target,
    url: &str,
    guard: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    let _mutation_lock = super::workspace_lock::acquire(root, guard)?;
    let content = encode_link(url)?;
    let path = resolve_target(root, &target.relative)?;
    let parent = path.parent().ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?;
    let _pins = pin_directories(root, parent)?;
    // Validate after acquiring directory pins in case a parent moved during their acquisition.
    if resolve_target(root, &target.relative)? != path {
        return Err("PLUGIN_FILESYSTEM_PATH_INVALID".into());
    }
    let temporary = parent.join(format!(
        ".wstudio-link-{}-{}.tmp",
        super::workspace_lock::staging_identity(root)?,
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        let mut file =
            create_staging(&temporary, target.original.as_ref().map(|_| path.as_path()))?;
        file.write_all(&content)
            .and_then(|_| file.sync_all())
            .map_err(|_| "PLUGIN_FILESYSTEM_WRITE_FAILED")?;
        drop(file);
        guard()?;
        if resolve_target(root, &target.relative)? != path
            || read_original(&path)? != target.original
        {
            return Err("PLUGIN_WRITE_CONFLICT".into());
        }
        if let Some(identity) = &target.identity {
            if super::plugin_path_identity(&path)? != *identity {
                return Err("PLUGIN_WRITE_CONFLICT".into());
            }
        }
        guard()?;
        install_link(&temporary, &path, target.original.is_some())?;
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::Cell;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("wstudio-webpage-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
        fn grants() -> Value {
            json!({"permissions": [{"id": "workspace.write", "scope": ["*.url", "saved/**"]}]})
        }
        fn target(&self) -> Target {
            select_target(&self.0, &self.0.join("page.url"), &Self::grants()).unwrap()
        }
        fn clean(&self) {
            assert!(fs::read_dir(&self.0).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")));
        }
        fn staged_in(&self, directory: &Path) -> bool {
            fs::read_dir(directory).unwrap().any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".wstudio-link-")
            })
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn link_destination_accepts_shortcuts_and_rejects_webpage_archives() {
        let fixture = Fixture::new();
        let grants = json!({"permissions": [{"id": "workspace.write", "scope": ["*"]}]});
        assert!(select_target(&fixture.0, &fixture.0.join("page.url"), &grants).is_ok());
        for extension in ["html", "mhtml"] {
            assert!(select_target(
                &fixture.0,
                &fixture.0.join(format!("page.{extension}")),
                &grants
            )
            .is_err());
        }
    }

    #[test]
    fn shortcuts_contain_only_urls_and_reject_injection() {
        assert_eq!(
            encode_link("https://example.com/path?q=1#part").unwrap(),
            b"[InternetShortcut]\r\nURL=https://example.com/path?q=1#part\r\n"
        );
        for invalid in [
            "https://example.com/\r\nIconFile=evil",
            "file:///private",
            "javascript:alert(1)",
        ] {
            assert_eq!(encode_link(invalid).unwrap_err(), "PLUGIN_INVALID_ARGUMENT");
        }
    }

    #[test]
    fn filename_and_deadline_handle_untrusted_titles_and_expiry() {
        assert_eq!(default_name("<>:\"/\\|?*"), "网页.url");
        assert_eq!(default_name("CON.txt"), "网页.url");
        assert_eq!(default_name("LPT9"), "网页.url");
        assert_eq!(default_name("example.  "), "example.url");
        assert_eq!(remaining(0).unwrap_err(), "PLUGIN_REQUEST_TIMEOUT");
    }

    #[test]
    fn cancelled_dialog_returns_none_and_late_native_results_are_discarded() {
        let (send, receive) = mpsc::sync_channel(1);
        send.send(None::<PathBuf>).unwrap();
        assert!(wait_native(receive, u64::MAX, Duration::ZERO)
            .unwrap()
            .is_none());
        let (send, receive) = mpsc::sync_channel(1);
        assert_eq!(
            wait_native::<Option<PathBuf>>(receive, u64::MAX, Duration::ZERO).unwrap_err(),
            "PLUGIN_REQUEST_TIMEOUT"
        );
        assert!(send.send(Some(PathBuf::from("late.url"))).is_err());
        let (send, receive) = mpsc::sync_channel(1);
        send.send(Some(PathBuf::from("expired.url"))).unwrap();
        assert_eq!(
            wait_native(receive, 0, Duration::ZERO).unwrap_err(),
            "PLUGIN_REQUEST_TIMEOUT"
        );
    }

    #[test]
    fn destination_requires_repository_scope_extension_and_regular_file() {
        let fixture = Fixture::new();
        let external = Fixture::new();
        assert_eq!(
            select_target(&fixture.0, &external.0.join("page.url"), &Fixture::grants())
                .err()
                .unwrap(),
            "PLUGIN_PERMISSION_SCOPE_VIOLATION"
        );
        assert!(select_target(&fixture.0, Path::new("page.url"), &Fixture::grants()).is_err());
        assert!(
            select_target(&fixture.0, &fixture.0.join("page.html"), &Fixture::grants()).is_err()
        );
        fs::create_dir(fixture.0.join("private")).unwrap();
        assert_eq!(
            select_target(
                &fixture.0,
                &fixture.0.join("private/page.url"),
                &Fixture::grants()
            )
            .err()
            .unwrap(),
            "PLUGIN_PERMISSION_SCOPE_VIOLATION"
        );
        fs::create_dir(fixture.0.join("page.url")).unwrap();
        assert_eq!(
            select_target(&fixture.0, &fixture.0.join("page.url"), &Fixture::grants())
                .err()
                .unwrap(),
            "PLUGIN_FILESYSTEM_NOT_FILE"
        );
    }

    #[test]
    fn links_create_and_replace_atomically_without_temporary_residue() {
        let fixture = Fixture::new();
        let target = fixture.target();
        commit_link(&fixture.0, &target, "https://one.example/", &|| Ok(())).unwrap();
        assert_eq!(
            fs::read(fixture.0.join("page.url")).unwrap(),
            encode_link("https://one.example/").unwrap()
        );
        let replacement = fixture.target();
        commit_link(&fixture.0, &replacement, "https://two.example/", &|| Ok(())).unwrap();
        assert_eq!(
            fs::read(fixture.0.join("page.url")).unwrap(),
            encode_link("https://two.example/").unwrap()
        );
        fixture.clean();
    }

    #[test]
    fn failed_identity_or_scope_check_never_changes_the_approved_target() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("page.url"), b"original").unwrap();
        for code in [
            "PLUGIN_REQUEST_TIMEOUT",
            "PLUGIN_RUNTIME_TERMINATED",
            "PLUGIN_PERMISSION_SCOPE_VIOLATION",
            "PLUGIN_WEBVIEWER_PAGE_CHANGED",
            "PLUGIN_WEBVIEWER_REPOSITORY_CHANGED",
        ] {
            let target = fixture.target();
            let staged = Cell::new(false);
            assert_eq!(
                commit_link(&fixture.0, &target, "https://new.example/", &|| {
                    if fixture.staged_in(&fixture.0) {
                        staged.set(true);
                        Err(code.into())
                    } else {
                        Ok(())
                    }
                })
                .unwrap_err(),
                code
            );
            assert!(staged.get());
            assert_eq!(fs::read(fixture.0.join("page.url")).unwrap(), b"original");
            fixture.clean();
        }
    }

    #[test]
    fn concurrent_target_changes_are_preserved_for_new_files_and_replacements() {
        let fixture = Fixture::new();
        for existing in [false, true] {
            if existing {
                fs::write(fixture.0.join("page.url"), b"approved").unwrap();
            }
            let target = fixture.target();
            let changed = Cell::new(false);
            assert_eq!(
                commit_link(&fixture.0, &target, "https://example.com/", &|| {
                    if fixture.staged_in(&fixture.0) && !changed.replace(true) {
                        fs::write(fixture.0.join("page.url"), b"other writer").unwrap();
                    }
                    Ok(())
                })
                .unwrap_err(),
                "PLUGIN_WRITE_CONFLICT"
            );
            assert!(changed.get());
            assert_eq!(
                fs::read(fixture.0.join("page.url")).unwrap(),
                b"other writer"
            );
            fixture.clean();
        }
    }

    #[test]
    fn replacement_with_identical_bytes_is_still_a_conflict() {
        let fixture = Fixture::new();
        let path = fixture.0.join("page.url");
        fs::write(&path, b"approved").unwrap();
        let target = fixture.target();
        // Keep the old object alive so its identity cannot be reused by the filesystem.
        fs::rename(&path, fixture.0.join("previous.url")).unwrap();
        fs::write(&path, b"approved").unwrap();
        assert_eq!(
            commit_link(&fixture.0, &target, "https://example.com/", &|| Ok(())).unwrap_err(),
            "PLUGIN_WRITE_CONFLICT"
        );
        assert_eq!(fs::read(path).unwrap(), b"approved");
        fixture.clean();
    }

    #[test]
    fn final_deadline_check_prevents_link_publication() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("page.url"), b"approved").unwrap();
        let target = fixture.target();
        let staged_checks = Cell::new(0);
        let result = commit_link(&fixture.0, &target, "https://example.com/", &|| {
            if fixture.staged_in(&fixture.0) {
                staged_checks.set(staged_checks.get() + 1);
                if staged_checks.get() == 2 {
                    return Err("PLUGIN_REQUEST_TIMEOUT".into());
                }
            }
            Ok(())
        });
        assert_eq!(result.unwrap_err(), "PLUGIN_REQUEST_TIMEOUT");
        assert_eq!(fs::read(fixture.0.join("page.url")).unwrap(), b"approved");
        fixture.clean();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn pinned_parent_cannot_be_renamed_during_link_commit() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("saved")).unwrap();
        let target = select_target(
            &fixture.0,
            &fixture.0.join("saved/page.url"),
            &Fixture::grants(),
        )
        .unwrap();
        let checked = Cell::new(false);
        commit_link(&fixture.0, &target, "https://example.com/", &|| {
            if fixture.staged_in(&fixture.0.join("saved")) && !checked.replace(true) {
                assert!(fs::rename(fixture.0.join("saved"), fixture.0.join("moved")).is_err());
            }
            Ok(())
        })
        .unwrap();
        assert!(checked.get());
        assert_eq!(
            fs::read(fixture.0.join("saved/page.url")).unwrap(),
            encode_link("https://example.com/").unwrap()
        );
    }

    #[test]
    fn atomic_creation_refuses_to_replace_a_late_created_destination() {
        let fixture = Fixture::new();
        let source = fixture.0.join("staged.tmp");
        let destination = fixture.0.join("page.url");
        fs::write(&source, b"snapshot").unwrap();
        fs::write(&destination, b"other writer").unwrap();
        assert_eq!(
            install_link(&source, &destination, false).unwrap_err(),
            "PLUGIN_WRITE_CONFLICT"
        );
        assert_eq!(fs::read(destination).unwrap(), b"other writer");
    }
}
