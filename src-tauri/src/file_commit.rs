//! Shared native file commits: stage complete bytes, pin parents and revalidate replacement baselines.
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

#[cfg(windows)]
mod windows_security {
    use super::*;
    use std::{ffi::c_void, os::windows::ffi::OsStrExt};

    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        descriptor: *mut c_void,
        inherit_handle: i32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            attributes: *const SecurityAttributes,
            disposition: u32,
            flags: u32,
            template: *mut c_void,
        ) -> *mut c_void;
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn GetFileSecurityW(
            path: *const u16,
            information: u32,
            descriptor: *mut c_void,
            length: u32,
            needed: *mut u32,
        ) -> i32;
        fn SetSecurityDescriptorControl(
            descriptor: *mut c_void,
            interest: u16,
            control: u16,
        ) -> i32;
    }

    pub(super) fn path(path: &Path) -> Result<Vec<u16>, String> {
        let mut encoded: Vec<u16> = path.as_os_str().encode_wide().collect();
        if encoded.contains(&0) {
            return Err("PLUGIN_FILESYSTEM_PATH_INVALID".into());
        }
        encoded.push(0);
        Ok(encoded)
    }

    /// Obtain an aligned self-relative descriptor carrying the original file's DACL.
    pub(super) fn descriptor(file: &Path) -> Result<Vec<u32>, String> {
        let name = path(file)?;
        let mut needed = 0;
        // SAFETY: the first call only obtains size; name and out parameter remain live.
        unsafe {
            GetFileSecurityW(name.as_ptr(), 4, std::ptr::null_mut(), 0, &mut needed);
        }
        if needed == 0 || needed > 64 * 1024 {
            return Err("PLUGIN_FILESYSTEM_WRITE_FAILED".into());
        }
        let mut descriptor = vec![0u32; (needed as usize + 3) / 4];
        // SAFETY: DWORD-aligned storage is at least `needed` bytes long.
        if unsafe {
            GetFileSecurityW(
                name.as_ptr(),
                4,
                descriptor.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } == 0
        {
            return Err("PLUGIN_FILESYSTEM_WRITE_FAILED".into());
        }
        Ok(descriptor)
    }

    /// Supply the DACL at creation so decrypted bytes never inherit broader directory access.
    pub(super) fn create(temporary: &Path, original: &Path) -> Result<File, String> {
        use std::os::windows::io::FromRawHandle;
        let name = path(temporary)?;
        let mut descriptor = descriptor(original)?;
        // SAFETY: a valid self-relative descriptor supports DACL control updates. Freeze only stage
        // inheritance. Publication retains the original ACEs and keeps inheritance frozen.
        if unsafe { SetSecurityDescriptorControl(descriptor.as_mut_ptr().cast(), 0x1000, 0x1000) }
            == 0
        {
            return Err("PLUGIN_FILESYSTEM_WRITE_FAILED".into());
        }
        let attributes = SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor: descriptor.as_mut_ptr().cast(),
            inherit_handle: 0,
        };
        // SAFETY: attributes/descriptor/name remain live for synchronous CREATE_NEW; no inheritance.
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                0x40000000,
                0,
                &attributes,
                1,
                0x80,
                std::ptr::null_mut(),
            )
        };
        if handle as isize == -1 {
            return Err("PLUGIN_FILESYSTEM_WRITE_FAILED".into());
        }
        // SAFETY: a successful CreateFileW returns one uniquely owned handle.
        Ok(unsafe { File::from_raw_handle(handle) })
    }
}

/// Create an unpublished file with replacement permissions before writing any content.
pub(crate) fn create_staging(temporary: &Path, original: Option<&Path>) -> Result<File, String> {
    #[cfg(windows)]
    if let Some(original) = original {
        return windows_security::create(temporary, original);
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if let Some(original) = original {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(
            fs::metadata(original)
                .map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")?
                .permissions()
                .mode()
                & 0o777,
        );
    }
    options
        .open(temporary)
        .map_err(|_| "PLUGIN_FILESYSTEM_WRITE_FAILED".into())
}

/// Keep every Windows directory from the repository root to the target parent immovable.
pub(crate) fn pin_directories(root: &Path, parent: &Path) -> Result<Vec<File>, String> {
    let relative = parent
        .strip_prefix(root)
        .map_err(|_| "PLUGIN_FILESYSTEM_PATH_INVALID")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        let mut directories = vec![root.to_path_buf()];
        let mut current = root.to_path_buf();
        for component in relative.components() {
            if !matches!(component, std::path::Component::Normal(_)) {
                return Err("PLUGIN_FILESYSTEM_PATH_INVALID".into());
            }
            current.push(component);
            directories.push(current.clone());
        }
        directories
            .iter()
            .map(|path| {
                let file = OpenOptions::new()
                    .read(true)
                    .share_mode(3)
                    .custom_flags(0x02200000)
                    .open(path)
                    .map_err(|_| "PLUGIN_FILESYSTEM_WRITE_FAILED")?;
                let metadata = file
                    .metadata()
                    .map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")?;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err("PLUGIN_FILESYSTEM_SYMLINK_NOT_ALLOWED".into());
                }
                if !metadata.is_dir() {
                    return Err("PLUGIN_FILESYSTEM_PARENT_NOT_DIRECTORY".into());
                }
                Ok(file)
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        let _ = relative;
        Ok(Vec::new())
    }
}

/// Install a staged file with an explicit replacement policy; no-replace creation is atomic.
#[cfg(windows)]
pub(crate) fn install(temporary: &Path, target: &Path, replace: bool) -> Result<(), String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32;
        fn ReplaceFileW(
            target: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
    }
    let source = windows_security::path(temporary)?;
    let destination = windows_security::path(target)?;
    // SAFETY: paths are live UTF-16. ReplaceFile preserves target ACEs/metadata; new files never replace.
    let installed = unsafe {
        if replace {
            ReplaceFileW(
                destination.as_ptr(),
                source.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } else {
            MoveFileExW(source.as_ptr(), destination.as_ptr(), 8)
        }
    };
    if installed == 0 {
        let error = std::io::Error::last_os_error();
        return Err(if matches!(error.raw_os_error(), Some(80 | 183)) {
            "PLUGIN_WRITE_CONFLICT"
        } else {
            "PLUGIN_FILESYSTEM_WRITE_FAILED"
        }
        .into());
    }
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn install(temporary: &Path, target: &Path, replace: bool) -> Result<(), String> {
    if replace {
        fs::rename(temporary, target).map_err(|_| "PLUGIN_FILESYSTEM_WRITE_FAILED".into())
    } else {
        fs::hard_link(temporary, target).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "PLUGIN_WRITE_CONFLICT".into()
            } else {
                "PLUGIN_FILESYSTEM_WRITE_FAILED".into()
            }
        })
    }
}

/// Read a regular source while Windows denies concurrent content writes and object replacement.
pub(crate) fn open_read_snapshot(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x00200000);
    }
    let file = options
        .open(path)
        .map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")?;
    let metadata = file
        .metadata()
        .map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("PLUGIN_FILESYSTEM_SYMLINK_NOT_ALLOWED".into());
        }
    }
    if !metadata.is_file() {
        return Err("PLUGIN_FILESYSTEM_NOT_FILE".into());
    }
    Ok(file)
}

/// Publish a new file only after its complete body is staged; never overwrite another writer.
pub(crate) fn create_new(
    root: &Path,
    target: &Path,
    content: &[u8],
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    create_new_with(
        root,
        target,
        None,
        &mut |file| {
            file.write_all(content)
                .map_err(|_| "PLUGIN_FILESYSTEM_WRITE_FAILED".into())
        },
        checkpoint,
    )
}

/// Stream new content into a same-directory stage with optional source permissions.
pub(crate) fn create_new_with(
    root: &Path,
    target: &Path,
    permissions_source: Option<&Path>,
    write: &mut dyn FnMut(&mut File) -> Result<(), String>,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| "PLUGIN_FILESYSTEM_PATH_INVALID")?
        .to_str()
        .ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?;
    let parent = target.parent().ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?;
    let _pins = pin_directories(root, parent)?;
    checkpoint()?;
    if crate::resolve_plugin_new_path(root, relative)? != target {
        return Err("PLUGIN_FILESYSTEM_PATH_INVALID".into());
    }
    let temporary = parent.join(format!(
        ".wstudio-write-{}-{}.tmp",
        crate::workspace_lock::staging_identity(root)?,
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        let mut file = create_staging(&temporary, permissions_source)?;
        write(&mut file)?;
        file.sync_all()
            .map_err(|_| "PLUGIN_FILESYSTEM_WRITE_FAILED")?;
        drop(file);
        checkpoint()?;
        if crate::resolve_plugin_new_path(root, relative)? != target {
            return Err("PLUGIN_FILESYSTEM_PATH_INVALID".into());
        }
        install(&temporary, target, false).map_err(|error| {
            if error == "PLUGIN_WRITE_CONFLICT" {
                "PLUGIN_FILESYSTEM_ALREADY_EXISTS".into()
            } else {
                error
            }
        })
    })();
    let _ = fs::remove_file(&temporary);
    result
}

/// Replace only the filesystem object and bytes approved by the caller's optimistic baseline.
pub(crate) fn replace_existing(
    root: &Path,
    path: &Path,
    content: &[u8],
    expected: &[u8],
    identity: &str,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    checkpoint()?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "PLUGIN_FILESYSTEM_PATH_INVALID")?
        .to_str()
        .ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?;
    let parent = path.parent().ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?;
    let _pins = pin_directories(root, parent)?;
    if crate::resolve_plugin_existing_path(root, relative)? != path {
        return Err("PLUGIN_FILESYSTEM_PATH_INVALID".into());
    }
    let metadata = fs::metadata(path).map_err(|_| "PLUGIN_FILESYSTEM_NOT_FOUND")?;
    if !metadata.is_file() {
        return Err("PLUGIN_FILESYSTEM_NOT_FILE".into());
    }
    if metadata.permissions().readonly() {
        return Err("PLUGIN_FILESYSTEM_WRITE_FAILED".into());
    }
    let temporary = parent.join(format!(
        ".wstudio-write-{}-{}.tmp",
        crate::workspace_lock::staging_identity(root)?,
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        let mut file = create_staging(&temporary, Some(path))?;
        file.write_all(content)
            .and_then(|_| file.sync_all())
            .map_err(|_| "PLUGIN_FILESYSTEM_WRITE_FAILED")?;
        drop(file);
        fs::set_permissions(&temporary, metadata.permissions())
            .map_err(|_| "PLUGIN_FILESYSTEM_WRITE_FAILED")?;
        checkpoint()?;
        if crate::resolve_plugin_existing_path(root, relative)? != path
            || crate::plugin_path_identity(path)? != identity
        {
            return Err("PLUGIN_WRITE_CONFLICT".into());
        }
        let mut current = Vec::new();
        File::open(path)
            .map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")?
            .take(expected.len() as u64 + 1)
            .read_to_end(&mut current)
            .map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")?;
        if current != expected || crate::plugin_path_identity(path)? != identity {
            return Err("PLUGIN_WRITE_CONFLICT".into());
        }
        checkpoint()?;
        install(&temporary, path, true)
    })();
    let _ = fs::remove_file(&temporary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, path::PathBuf};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("wstudio-file-commit-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("nested")).unwrap();
            fs::write(root.join("nested/note.md"), b"original").unwrap();
            Self(root.canonicalize().unwrap())
        }
        fn path(&self) -> PathBuf {
            self.0.join("nested/note.md")
        }
        fn staged(&self) -> bool {
            fs::read_dir(self.0.join("nested")).unwrap().any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".wstudio-write-")
            })
        }
        fn replace(&self, checkpoint: &dyn Fn() -> Result<(), String>) -> Result<(), String> {
            let path = self.path();
            replace_existing(
                &self.0,
                &path,
                b"replacement",
                b"original",
                &crate::plugin_path_identity(&path).unwrap(),
                checkpoint,
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn revoked_commit_retains_original_and_removes_staging() {
        let fixture = Fixture::new();
        assert_eq!(
            fixture
                .replace(&|| Err("PLUGIN_RUNTIME_TERMINATED".into()))
                .unwrap_err(),
            "PLUGIN_RUNTIME_TERMINATED"
        );
        assert_eq!(fs::read(fixture.path()).unwrap(), b"original");
        assert!(!fixture.staged());
    }

    #[test]
    fn descendant_cleanup_preserves_a_commit_owned_by_its_workspace_root() {
        let fixture = Fixture::new();
        let guard = crate::workspace_lock::acquire(&fixture.0, &|| Ok(())).unwrap();
        let cleaned = Cell::new(false);
        let result = fixture.replace(&|| {
            if fixture.staged() && !cleaned.replace(true) {
                let directory = fixture.0.join("nested");
                std::thread::spawn(move || {
                    let _guard = crate::workspace_lock::acquire(&directory, &|| Ok(())).unwrap();
                })
                .join()
                .unwrap();
            }
            Ok(())
        });
        drop(guard);
        assert!(cleaned.get());
        assert_eq!(result, Ok(()));
        assert_eq!(fs::read(fixture.path()).unwrap(), b"replacement");
        assert!(!fixture.staged());
    }

    #[cfg(windows)]
    #[test]
    fn reentrant_workspace_lock_does_not_clean_its_own_active_commit() {
        let fixture = Fixture::new();
        let guard = crate::workspace_lock::acquire(&fixture.0, &|| Ok(())).unwrap();
        let cleaned = Cell::new(false);
        let result = fixture.replace(&|| {
            if fixture.staged() && !cleaned.replace(true) {
                let _guard = crate::workspace_lock::acquire(&fixture.0, &|| Ok(())).unwrap();
            }
            Ok(())
        });
        drop(guard);
        assert!(cleaned.get());
        assert_eq!(result, Ok(()));
        assert_eq!(fs::read(fixture.path()).unwrap(), b"replacement");
        assert!(!fixture.staged());
    }

    #[test]
    fn late_external_content_change_is_preserved_instead_of_overwritten() {
        let fixture = Fixture::new();
        let changed = Cell::new(false);
        let result = fixture.replace(&|| {
            if fixture.staged() && !changed.replace(true) {
                fs::write(fixture.path(), b"external").unwrap();
            }
            Ok(())
        });
        assert_eq!(result.unwrap_err(), "PLUGIN_WRITE_CONFLICT");
        assert!(changed.get());
        assert_eq!(fs::read(fixture.path()).unwrap(), b"external");
        assert!(!fixture.staged());
    }

    #[test]
    fn same_content_replacement_is_detected_by_file_identity() {
        let fixture = Fixture::new();
        let changed = Cell::new(false);
        let result = fixture.replace(&|| {
            if fixture.staged() && !changed.replace(true) {
                fs::rename(fixture.path(), fixture.0.join("original.md")).unwrap();
                fs::write(fixture.path(), b"original").unwrap();
            }
            Ok(())
        });
        assert_eq!(result.unwrap_err(), "PLUGIN_WRITE_CONFLICT");
        assert!(changed.get());
        assert_eq!(fs::read(fixture.path()).unwrap(), b"original");
        assert!(!fixture.staged());
    }

    #[test]
    fn staged_commit_exposes_complete_old_bytes_until_atomic_publication() {
        let fixture = Fixture::new();
        let observed = Cell::new(false);
        fixture
            .replace(&|| {
                if fixture.staged() {
                    assert_eq!(fs::read(fixture.path()).unwrap(), b"original");
                    observed.set(true);
                }
                Ok(())
            })
            .unwrap();
        assert!(observed.get());
        assert_eq!(fs::read(fixture.path()).unwrap(), b"replacement");
        assert!(!fixture.staged());
    }

    #[test]
    fn revocation_after_baseline_validation_prevents_publication() {
        let fixture = Fixture::new();
        let staged_checks = Cell::new(0);
        let result = fixture.replace(&|| {
            if fixture.staged() {
                staged_checks.set(staged_checks.get() + 1);
                if staged_checks.get() == 2 {
                    return Err("PLUGIN_REQUEST_TIMEOUT".into());
                }
            }
            Ok(())
        });
        assert_eq!(result.unwrap_err(), "PLUGIN_REQUEST_TIMEOUT");
        assert_eq!(fs::read(fixture.path()).unwrap(), b"original");
        assert!(!fixture.staged());
    }

    #[cfg(windows)]
    fn check_windows_dacl(protected: bool) {
        use std::ffi::c_void;
        #[link(name = "advapi32")]
        extern "system" {
            fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text: *const u16,
                revision: u32,
                descriptor: *mut *mut c_void,
                size: *mut u32,
            ) -> i32;
            fn ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor: *const c_void,
                revision: u32,
                information: u32,
                text: *mut *mut u16,
                size: *mut u32,
            ) -> i32;
            fn SetFileSecurityW(
                path: *const u16,
                information: u32,
                descriptor: *const c_void,
            ) -> i32;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn LocalFree(memory: *mut c_void) -> *mut c_void;
        }
        fn dacl(path: &Path) -> String {
            let descriptor = windows_security::descriptor(path).unwrap();
            let mut text = std::ptr::null_mut();
            let mut size = 0;
            // SAFETY: descriptor is aligned and valid; LocalFree releases the returned string.
            unsafe {
                assert_ne!(
                    ConvertSecurityDescriptorToStringSecurityDescriptorW(
                        descriptor.as_ptr().cast(),
                        1,
                        4,
                        &mut text,
                        &mut size
                    ),
                    0
                );
                // ReplaceFile may mark inheritance as processed; protection and all ACEs must match.
                let result =
                    String::from_utf16_lossy(std::slice::from_raw_parts(text, size as usize))
                        .trim_end_matches('\0')
                        .replace("D:PAI", "D:P");
                LocalFree(text.cast());
                result
            }
        }
        let fixture = Fixture::new();
        let path = fixture.path();
        // Restrict only this disposable fixture to SYSTEM and the current user's SID.
        let inherited = dacl(&path);
        let sid_output = std::process::Command::new("whoami")
            .args(["/user", "/fo", "csv", "/nh"])
            .output()
            .unwrap();
        assert!(sid_output.status.success());
        let sid_text = String::from_utf8_lossy(&sid_output.stdout);
        let sid = sid_text
            .trim()
            .split(',')
            .next_back()
            .unwrap()
            .trim_matches('"');
        assert!(sid.starts_with("S-1-"));
        let access = if protected { "" } else { "OICI" };
        let sddl: Vec<u16> = format!("D:P(A;{access};FA;;;SY)(A;{access};FA;;;{sid})\0")
            .encode_utf16()
            .collect();
        let mut descriptor = std::ptr::null_mut();
        let restricted = fixture.0.join("restricted");
        if !protected {
            fs::create_dir(&restricted).unwrap();
        }
        let name = windows_security::path(if protected { &path } else { &restricted }).unwrap();
        // SAFETY: pointers remain live and only the test fixture DACL is changed.
        unsafe {
            assert_ne!(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    1,
                    &mut descriptor,
                    std::ptr::null_mut()
                ),
                0
            );
            let changed = SetFileSecurityW(name.as_ptr(), 4 | 0x80000000, descriptor);
            LocalFree(descriptor);
            assert_ne!(changed, 0);
        }
        if !protected {
            let source = restricted.join("note.md");
            fs::write(&source, b"original").unwrap();
            fs::remove_file(&path).unwrap();
            fs::rename(source, &path).unwrap();
            assert!(!dacl(&path).starts_with("D:P"));
        }
        let approved = dacl(&path);
        assert_ne!(approved, inherited);
        let observed = Cell::new(false);
        fixture
            .replace(&|| {
                if fixture.staged() {
                    let stage = fs::read_dir(fixture.0.join("nested"))
                        .unwrap()
                        .map(|entry| entry.unwrap().path())
                        .find(|path| path.extension().is_some_and(|extension| extension == "tmp"))
                        .unwrap();
                    let stage_dacl = dacl(&stage);
                    assert_eq!(
                        &stage_dacl[stage_dacl.find('(').unwrap()..],
                        &approved[approved.find('(').unwrap()..]
                    );
                    assert!(stage_dacl.starts_with("D:P"));
                    observed.set(true);
                }
                Ok(())
            })
            .unwrap();
        assert!(observed.get());
        let published = dacl(&path);
        assert_eq!(
            &published[published.find('(').unwrap()..],
            &approved[approved.find('(').unwrap()..]
        );
        assert!(published.starts_with("D:P"));
        assert_eq!(fs::read(path).unwrap(), b"replacement");
    }

    #[cfg(windows)]
    #[test]
    fn staging_and_published_file_preserve_restrictive_windows_dacl() {
        check_windows_dacl(true);
    }

    #[cfg(windows)]
    #[test]
    fn moved_unprotected_file_does_not_gain_parent_permissions_while_staging() {
        check_windows_dacl(false);
    }

    #[cfg(windows)]
    #[test]
    fn all_parent_directories_are_pinned_until_commit_finishes() {
        let fixture = Fixture::new();
        let checked = Cell::new(false);
        fixture
            .replace(&|| {
                if fixture.staged() && !checked.replace(true) {
                    assert!(fs::rename(fixture.0.join("nested"), fixture.0.join("moved")).is_err());
                }
                Ok(())
            })
            .unwrap();
        assert!(checked.get());
        fs::rename(fixture.0.join("nested"), fixture.0.join("moved")).unwrap();
    }
}
