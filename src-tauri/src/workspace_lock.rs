//! Coordinate synchronous workspace mutations between Rust host processes without lock files.
use std::{
    cell::RefCell,
    collections::HashMap,
    fs,
    marker::PhantomData,
    path::Path,
    rc::Rc,
    time::{Duration, Instant},
};

thread_local! {
    static HELD_WORKSPACES: RefCell<HashMap<String, usize>> = RefCell::new(HashMap::new());
}

/// Name stages by the same directory identity as their owning mutation lock.
pub(crate) fn staging_identity(root: &Path) -> Result<String, String> {
    Ok(crate::plugin_path_identity(root)?.replace(':', "-"))
}

/// Remove abandoned WStudio staging files after exclusive ownership is acquired.
fn cleanup_staging(root: &Path) {
    let Ok(identity) = staging_identity(root) else {
        return;
    };
    let prefixes = [
        format!(".wstudio-write-{identity}-"),
        format!(".wstudio-link-{identity}-"),
    ];
    fn visit(path: &Path, remaining: &mut usize, depth: usize, prefixes: &[String; 2]) {
        if *remaining == 0 || depth > 64 {
            return;
        }
        *remaining -= 1;
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            if *remaining == 0 {
                return;
            }
            *remaining -= 1;
            let child = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(metadata) = fs::symlink_metadata(&child) else {
                continue;
            };
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    continue;
                }
            }
            if metadata.is_dir() {
                visit(&child, remaining, depth + 1, prefixes);
            } else if metadata.is_file()
                && name.ends_with(".tmp")
                && prefixes.iter().any(|prefix| name.starts_with(prefix))
            {
                let _ = fs::remove_file(child);
            }
        }
    }
    let mut remaining = 10_000;
    visit(root, &mut remaining, 0, &prefixes);
}

/// Ownership remains on the synchronous worker thread required by Windows mutexes.
pub(crate) struct WorkspaceLock {
    _lock: platform::Lock,
    _thread_bound: PhantomData<Rc<()>>,
    identity: String,
}

impl Drop for WorkspaceLock {
    fn drop(&mut self) {
        HELD_WORKSPACES.with(|held| {
            let mut held = held.borrow_mut();
            if let Some(count) = held.get_mut(&self.identity) {
                *count -= 1;
                if *count == 0 {
                    held.remove(&self.identity);
                }
            }
        });
    }
}

/// Acquire a bounded, revocable workspace lock shared by participating host processes.
pub(crate) fn acquire(
    root: &Path,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<WorkspaceLock, String> {
    acquire_with_timeout(root, checkpoint, Duration::from_secs(5))
}

/// Reuse the directory identity lock for non-file transactions without scanning staging files.
pub(crate) fn acquire_without_cleanup(root: &Path) -> Result<WorkspaceLock, String> {
    acquire_checked(root, &|| Ok(()), Duration::from_secs(5), false)
}

/// Acquire two workspace identities in a stable order for repository moves.
pub(crate) fn acquire_pair(
    first: &Path,
    second: &Path,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<(WorkspaceLock, Option<WorkspaceLock>), String> {
    let first_identity = crate::plugin_path_identity(first)?;
    let second_identity = crate::plugin_path_identity(second)?;
    if first_identity == second_identity {
        return Ok((acquire(first, checkpoint)?, None));
    }
    let (left, right) = if first_identity < second_identity {
        (first, second)
    } else {
        (second, first)
    };
    let left_guard = acquire(left, checkpoint)?;
    let right_guard = match acquire(right, checkpoint) {
        Ok(guard) => guard,
        Err(error) => return Err(error),
    };
    Ok((left_guard, Some(right_guard)))
}

fn acquire_with_timeout(
    root: &Path,
    checkpoint: &dyn Fn() -> Result<(), String>,
    timeout: Duration,
) -> Result<WorkspaceLock, String> {
    acquire_checked(root, checkpoint, timeout, true)
}

/// Keep acquisition semantics shared while letting database callers skip file staging cleanup.
fn acquire_checked(
    root: &Path,
    checkpoint: &dyn Fn() -> Result<(), String>,
    timeout: Duration,
    clean_staging: bool,
) -> Result<WorkspaceLock, String> {
    checkpoint()?;
    let identity = crate::plugin_path_identity(root)?;
    let mut lock = platform::Lock::new(root)?;
    let deadline = Instant::now() + timeout;
    loop {
        checkpoint()?;
        if lock.try_acquire()? {
            let first_acquisition = HELD_WORKSPACES.with(|held| {
                let mut held = held.borrow_mut();
                let count = held.entry(identity.clone()).or_default();
                *count += 1;
                *count == 1
            });
            let guard = WorkspaceLock {
                _lock: lock,
                _thread_bound: PhantomData,
                identity,
            };
            // Windows named mutexes are reentrant; a nested acquisition owns active stages already.
            if first_acquisition && clean_staging {
                cleanup_staging(root);
            }
            checkpoint()?;
            return Ok(guard);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("PLUGIN_FILESYSTEM_BUSY".into());
        }
        std::thread::sleep(remaining.min(Duration::from_millis(20)));
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attributes: *const c_void, owner: i32, name: *const u16) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn ReleaseMutex(handle: *mut c_void) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    pub(super) struct Lock {
        handle: *mut c_void,
        owned: bool,
    }
    impl Lock {
        pub(super) fn new(root: &Path) -> Result<Self, String> {
            let identity = crate::plugin_path_identity(root)?;
            let name: Vec<u16> = format!(
                "Local\\WStudioWorkspaceMutation-{}\0",
                identity.replace(':', "-")
            )
            .encode_utf16()
            .collect();
            // SAFETY: the name is live NUL-terminated UTF-16; null requests the default ACL.
            let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
            if handle.is_null() {
                return Err("PLUGIN_FILESYSTEM_WRITE_FAILED".into());
            }
            Ok(Self {
                handle,
                owned: false,
            })
        }
        pub(super) fn try_acquire(&mut self) -> Result<bool, String> {
            // SAFETY: this object exclusively owns the live handle; zero is a nonblocking wait.
            match unsafe { WaitForSingleObject(self.handle, 0) } {
                0 | 0x80 => {
                    self.owned = true;
                    Ok(true)
                } // WAIT_OBJECT_0 / abandoned owner
                0x102 => Ok(false),
                _ => Err("PLUGIN_FILESYSTEM_WRITE_FAILED".into()),
            }
        }
    }
    impl Drop for Lock {
        fn drop(&mut self) {
            // SAFETY: owned mutexes are released on their acquiring thread; the handle closes once.
            unsafe {
                if self.owned {
                    ReleaseMutex(self.handle);
                }
                CloseHandle(self.handle);
            }
        }
    }
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::{fs::File, os::fd::AsRawFd};
    extern "C" {
        fn flock(fd: i32, operation: i32) -> i32;
    }
    pub(super) struct Lock {
        file: File,
    }
    impl Lock {
        pub(super) fn new(root: &Path) -> Result<Self, String> {
            crate::plugin_path_identity(root)?;
            let file = File::open(root).map_err(|_| "PLUGIN_FILESYSTEM_WRITE_FAILED")?;
            Ok(Self { file })
        }
        pub(super) fn try_acquire(&mut self) -> Result<bool, String> {
            // SAFETY: the file descriptor is live; LOCK_EX | LOCK_NB acquires without blocking.
            if unsafe { flock(self.file.as_raw_fd(), 2 | 4) } == 0 {
                return Ok(true);
            }
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::WouldBlock {
                return Ok(false);
            }
            Err("PLUGIN_FILESYSTEM_WRITE_FAILED".into())
        }
    }
    // Closing the File releases flock, including early errors and process termination.
}

#[cfg(not(any(windows, unix)))]
mod platform {
    use super::*;
    pub(super) struct Lock;
    impl Lock {
        pub(super) fn new(_: &Path) -> Result<Self, String> {
            Err("PLUGIN_FILESYSTEM_TYPE_UNSUPPORTED".into())
        }
        pub(super) fn try_acquire(&mut self) -> Result<bool, String> {
            Err("PLUGIN_FILESYSTEM_TYPE_UNSUPPORTED".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        process::{Child, Command, Stdio},
    };

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("wstudio-workspace-lock-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            Self(root.canonicalize().unwrap())
        }
        fn spawn_worker(&self, mode: &str) -> Child {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "workspace_lock::tests::child_lock_worker",
                    "--ignored",
                    "--nocapture",
                ])
                .env("WSTUDIO_LOCK_TEST_ROOT", &self.0)
                .env("WSTUDIO_LOCK_TEST_MODE", mode)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            command.spawn().unwrap()
        }
        fn worker(&self, mode: &str) {
            let result = self.spawn_worker(mode).wait_with_output().unwrap();
            assert!(
                result.status.success(),
                "lock worker failed: {}",
                String::from_utf8_lossy(&result.stdout)
            );
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    /// The test binary doubles as a real isolated process; environment belongs only to that child.
    #[test]
    #[ignore]
    fn child_lock_worker() {
        let root = PathBuf::from(std::env::var_os("WSTUDIO_LOCK_TEST_ROOT").unwrap());
        let mode = std::env::var("WSTUDIO_LOCK_TEST_MODE").unwrap();
        if mode == "cancel-while-busy" {
            let start = Instant::now();
            let checks = std::cell::Cell::new(0);
            let result = acquire_with_timeout(
                &root,
                &|| {
                    checks.set(checks.get() + 1);
                    if start.elapsed() >= Duration::from_millis(30) {
                        Err("PLUGIN_RUNTIME_TERMINATED".into())
                    } else {
                        Ok(())
                    }
                },
                Duration::from_secs(2),
            );
            assert!(matches!(result, Err(error) if error == "PLUGIN_RUNTIME_TERMINATED"));
            assert!(checks.get() >= 3);
            return;
        }
        if mode == "sdk-write" || mode == "markdown-write" {
            let result = if mode == "sdk-write" {
                crate::plugin_filesystem::invoke(
                    &root,
                    &serde_json::json!({"id":"com.example.concurrent-write","permissions":[{"id":"workspace.write"}]}),
                    "filesystem.writeText",
                    &serde_json::json!({"path":"note.md","content":"sdk","options":{"expectedContent":"original"}}),
                    &|| Ok(()),
                ).map(|_| "updated".to_string())
            } else {
                crate::update_markdown_at_root(
                    &root,
                    crate::UpdateMarkdownRequest {
                        path: "note.md".into(),
                        expected_content: "original".into(),
                        content: "markdown".into(),
                    },
                    &|| Ok(()),
                )
                .map(|result| match result {
                    crate::UpdateMarkdownResult::Updated { .. } => "updated".to_string(),
                    crate::UpdateMarkdownResult::Conflict { .. } => {
                        "PLUGIN_WRITE_CONFLICT".to_string()
                    }
                    other => panic!("unexpected Markdown result: {other:?}"),
                })
            };
            let status = match result {
                Ok(status) => status,
                Err(error) if error == "PLUGIN_WRITE_CONFLICT" => error,
                Err(error) => panic!("unexpected write error: {error}"),
            };
            fs::write(root.join(format!("result-{mode}")), status).unwrap();
            return;
        }
        if mode.starts_with("storage-") {
            let path = root.join("storage.json");
            crate::update_plugin_storage_value_checked(
                &path,
                mode.clone(),
                Some(serde_json::json!(mode)),
                &|| Ok(()),
            )
            .unwrap();
            crate::web_viewer::save_favorite(
                &path,
                &serde_json::json!({"permissions":[{"id":"storage.plugin"}]}),
                &format!("https://{mode}.example/"),
                &|| Ok(()),
            )
            .unwrap();
            return;
        }
        let result = acquire_with_timeout(&root, &|| Ok(()), Duration::from_millis(80));
        if mode == "busy" {
            assert!(matches!(result, Err(error) if error == "PLUGIN_FILESYSTEM_BUSY"));
        } else {
            let _guard = result.unwrap();
            if mode == "exit-with-lock" {
                std::process::exit(0);
            }
        }
    }

    #[test]
    fn workspace_lock_excludes_another_process_and_releases_without_lock_files() {
        let fixture = Fixture::new();
        let guard = acquire(&fixture.0, &|| Ok(())).unwrap();
        fixture.worker("busy");
        drop(guard);
        fixture.worker("acquire");
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
    }

    #[test]
    fn acquiring_workspace_lock_removes_abandoned_staging_files_only() {
        let fixture = Fixture::new();
        let identity = staging_identity(&fixture.0).unwrap();
        let write_stage = fixture.0.join(format!(".wstudio-write-{identity}-old.tmp"));
        let link_stage = fixture
            .0
            .join(format!("nested/.wstudio-link-{identity}-old.tmp"));
        fs::write(&write_stage, b"stale").unwrap();
        fs::write(fixture.0.join("keep.tmp"), b"keep").unwrap();
        fs::write(
            fixture.0.join(".wstudio-write-legacy.tmp"),
            b"unknown owner",
        )
        .unwrap();
        fs::write(fixture.0.join(".wstudio-write-keep.md"), b"document").unwrap();
        fs::create_dir(fixture.0.join("nested")).unwrap();
        fs::write(&link_stage, b"stale").unwrap();
        let _guard = acquire(&fixture.0, &|| Ok(())).unwrap();
        assert!(!write_stage.exists());
        assert!(!link_stage.exists());
        assert!(fixture.0.join("keep.tmp").exists());
        assert!(fixture.0.join(".wstudio-write-legacy.tmp").exists());
        assert!(fixture.0.join(".wstudio-write-keep.md").exists());
    }

    #[test]
    fn storage_processes_preserve_distinct_keys_and_append_favorites_under_one_lock() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("storage.json"), br#"{"keep":42}"#).unwrap();
        let guard = acquire(&fixture.0, &|| Ok(())).unwrap();
        let first = fixture.spawn_worker("storage-first");
        let second = fixture.spawn_worker("storage-second");
        drop(guard);
        for child in [first, second] {
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let values = crate::read_plugin_storage(&fixture.0.join("storage.json")).unwrap();
        assert_eq!(values["keep"], serde_json::json!(42));
        assert_eq!(values["storage-first"], serde_json::json!("storage-first"));
        assert_eq!(
            values["storage-second"],
            serde_json::json!("storage-second")
        );
        let favorites = values["webViewer.favorites"].as_array().unwrap();
        assert_eq!(favorites.len(), 2);
        assert!(favorites.contains(&serde_json::json!("https://storage-first.example/")));
        assert!(favorites.contains(&serde_json::json!("https://storage-second.example/")));
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
    }

    #[test]
    fn process_exit_releases_workspace_lock_even_without_drop() {
        let fixture = Fixture::new();
        fixture.worker("exit-with-lock");
        let _guard = acquire(&fixture.0, &|| Ok(())).unwrap();
    }

    #[test]
    fn revoked_caller_does_not_acquire_workspace_lock() {
        let fixture = Fixture::new();
        let result = acquire(&fixture.0, &|| Err("PLUGIN_RUNTIME_TERMINATED".into()));
        assert!(matches!(result, Err(error) if error == "PLUGIN_RUNTIME_TERMINATED"));
        fixture.worker("acquire");
    }

    #[test]
    fn waiting_process_rechecks_revocation_before_lock_becomes_available() {
        let fixture = Fixture::new();
        let guard = acquire(&fixture.0, &|| Ok(())).unwrap();
        fixture.worker("cancel-while-busy");
        drop(guard);
        fixture.worker("acquire");
    }

    #[test]
    fn sdk_and_markdown_processes_share_one_optimistic_write_baseline() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("note.md"), "original").unwrap();
        let guard = acquire(&fixture.0, &|| Ok(())).unwrap();
        let sdk = fixture.spawn_worker("sdk-write");
        let markdown = fixture.spawn_worker("markdown-write");
        drop(guard);
        let outputs: Vec<_> = [sdk, markdown]
            .into_iter()
            .map(|child| child.wait_with_output().unwrap())
            .collect();
        for result in outputs {
            assert!(
                result.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
        }
        let sdk = fs::read_to_string(fixture.0.join("result-sdk-write")).unwrap();
        let markdown = fs::read_to_string(fixture.0.join("result-markdown-write")).unwrap();
        assert!(matches!(
            (sdk.as_str(), markdown.as_str()),
            ("updated", "PLUGIN_WRITE_CONFLICT") | ("PLUGIN_WRITE_CONFLICT", "updated")
        ));
        assert_eq!(
            fs::read_to_string(fixture.0.join("note.md")).unwrap(),
            if sdk == "updated" { "sdk" } else { "markdown" }
        );
        assert!(!fs::read_dir(&fixture.0).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
    }
}
