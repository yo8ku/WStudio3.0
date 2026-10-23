//! Rust plugin package registry and version transactions; runtime startup is a separate Host task.
use super::plugin_package::{read_manifest, stage, valid_id, validate_app_compatibility};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const MAX_REGISTRY_BYTES: u64 = 1024 * 1024;
const MAX_MIGRATION_BYTES: u64 = 512 * 1024 * 1024;
const PRIVILEGED: &[&str] = &[
    "renderer.code",
    "node.fs",
    "node.process",
    "node.native",
    "electron.system",
];

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    id: String,
    version: String,
    enabled: bool,
    granted_permissions: Vec<String>,
    install_path: PathBuf,
    data_path: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    rollback_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rollback_install_path: Option<PathBuf>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    version: u8,
    plugins: Vec<Entry>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CoreEntry {
    enabled: bool,
    granted_permissions: Vec<String>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CoreStates {
    version: u8,
    plugins: HashMap<String, CoreEntry>,
}
impl Default for Registry {
    fn default() -> Self {
        Self {
            version: 1,
            plugins: Vec::new(),
        }
    }
}

/// Serialize all management reads/mutations, including directory moves and registry commits.
pub(crate) struct PluginRegistryState {
    root: PathBuf,
    core_root: PathBuf,
    operation: Mutex<()>,
    host: Mutex<super::plugin_host::PluginHost>,
}

/// Migrate the Electron userData plugin tree without mutating the old tree.
/// Registry absolute paths are rebuilt from IDs/versions before the staged tree is renamed.
pub(crate) fn migrate_legacy_data(source: &Path, target: &Path) -> Result<bool, String> {
    migrate_legacy_data_with_limit(source, target, MAX_MIGRATION_BYTES)
}

fn migrate_legacy_data_with_limit(
    source: &Path,
    target: &Path,
    max_migration_bytes: u64,
) -> Result<bool, String> {
    if !source.is_absolute() || !target.is_absolute() || source == target || !source.is_dir() {
        return Ok(false);
    }
    if target.exists() {
        if !migration_target_is_empty(target)? {
            return Ok(false);
        }
    }
    let parent = target.parent().ok_or("PLUGIN_MIGRATION_PATH_INVALID")?;
    fs::create_dir_all(parent).map_err(|_| "PLUGIN_MIGRATION_WRITE_FAILED")?;
    let staging = parent.join(format!(".plugins-migration-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut bytes = 0u64;
        copy_migration_tree(source, &staging, &mut bytes, max_migration_bytes)?;
        let registry_path = staging.join("registry.json");
        if registry_path.is_file() {
            let raw = fs::read(&registry_path).map_err(|_| "PLUGIN_MIGRATION_READ_FAILED")?;
            let mut registry: Registry =
                serde_json::from_slice(&raw).map_err(|_| "PLUGIN_MIGRATION_INVALID")?;
            if registry.version != 1 {
                return Err("PLUGIN_MIGRATION_INVALID".into());
            }
            for entry in &mut registry.plugins {
                entry.install_path = target
                    .join("installed")
                    .join(&entry.id)
                    .join(&entry.version);
                entry.data_path = target.join("data").join(&entry.id);
                entry.rollback_install_path = entry
                    .rollback_version
                    .as_deref()
                    .map(|version| target.join("installed").join(&entry.id).join(version));
            }
            fs::write(
                &registry_path,
                serde_json::to_vec_pretty(&registry).map_err(|_| "PLUGIN_MIGRATION_INVALID")?,
            )
            .map_err(|_| "PLUGIN_MIGRATION_WRITE_FAILED")?;
        }
        fs::write(
            staging.join("migration-v1.complete"),
            b"wstudio-tauri-plugin-migration-v1\n",
        )
        .map_err(|_| "PLUGIN_MIGRATION_WRITE_FAILED")?;
        if target.exists() {
            if !migration_target_is_empty(target)? {
                return Err("PLUGIN_MIGRATION_WRITE_FAILED".into());
            }
            for entry in fs::read_dir(target).map_err(|_| "PLUGIN_MIGRATION_READ_FAILED")? {
                let entry = entry.map_err(|_| "PLUGIN_MIGRATION_READ_FAILED")?;
                // remove_dir preserves any data created after the empty-scaffold check.
                fs::remove_dir(entry.path()).map_err(|_| "PLUGIN_MIGRATION_WRITE_FAILED")?;
            }
            fs::remove_dir(target).map_err(|_| "PLUGIN_MIGRATION_WRITE_FAILED")?;
        }
        fs::rename(&staging, target).map_err(|_| "PLUGIN_MIGRATION_WRITE_FAILED")?;
        Ok(true)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

/// Treat a scaffold created by an earlier Tauri startup as empty, while preserving any real data.
fn migration_target_is_empty(path: &Path) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "PLUGIN_MIGRATION_READ_FAILED")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(false);
    }
    for entry in fs::read_dir(path).map_err(|_| "PLUGIN_MIGRATION_READ_FAILED")? {
        let entry = entry.map_err(|_| "PLUGIN_MIGRATION_READ_FAILED")?;
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| "PLUGIN_MIGRATION_READ_FAILED")?;
        if metadata.file_type().is_symlink()
            || !matches!(
                entry.file_name().to_str(),
                Some("data" | "installed" | "staging")
            )
        {
            return Ok(false);
        }
        if !metadata.is_dir()
            || fs::read_dir(entry.path())
                .map_err(|_| "PLUGIN_MIGRATION_READ_FAILED")?
                .next()
                .is_some()
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn copy_migration_tree(
    source: &Path,
    target: &Path,
    bytes: &mut u64,
    max_migration_bytes: u64,
) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|_| "PLUGIN_MIGRATION_WRITE_FAILED")?;
    for item in fs::read_dir(source).map_err(|_| "PLUGIN_MIGRATION_READ_FAILED")? {
        let item = item.map_err(|_| "PLUGIN_MIGRATION_READ_FAILED")?;
        let source_path = item.path();
        let target_path = target.join(item.file_name());
        let metadata =
            fs::symlink_metadata(&source_path).map_err(|_| "PLUGIN_MIGRATION_READ_FAILED")?;
        if metadata.file_type().is_symlink() {
            return Err("PLUGIN_MIGRATION_PATH_INVALID".into());
        }
        if metadata.is_dir() {
            copy_migration_tree(&source_path, &target_path, bytes, max_migration_bytes)?;
        } else if metadata.is_file() {
            *bytes = bytes.saturating_add(metadata.len());
            if *bytes > max_migration_bytes {
                return Err("PLUGIN_MIGRATION_TOO_LARGE".into());
            }
            fs::copy(&source_path, &target_path).map_err(|_| "PLUGIN_MIGRATION_WRITE_FAILED")?;
        } else {
            return Err("PLUGIN_MIGRATION_PATH_INVALID".into());
        }
    }
    Ok(())
}

/// Reject redirecting symlinks or file/directory substitutions within managed storage.
fn check_path(root: &Path, target: &Path, file: bool) -> Result<(), String> {
    if !target.starts_with(root) {
        return Err("PLUGIN_REGISTRY_PATH_INVALID".into());
    }
    for (index, path) in target.ancestors().enumerate() {
        match fs::symlink_metadata(path) {
            Ok(metadata)
                if metadata.file_type().is_symlink()
                    || if index == 0 && file {
                        !metadata.is_file()
                    } else {
                        !metadata.is_dir()
                    } =>
            {
                return Err("PLUGIN_REGISTRY_PATH_INVALID".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("PLUGIN_REGISTRY_PATH_INVALID".into()),
        }
        if path == root {
            break;
        }
    }
    Ok(())
}

/// Verify every descendant before moving/deleting an installed package or its private data.
fn check_tree(root: &Path, path: &Path, depth: usize) -> Result<(), String> {
    check_path(root, path, false)?;
    if depth > 64 {
        return Err("PLUGIN_REGISTRY_PATH_INVALID".into());
    }
    for entry in fs::read_dir(path).map_err(|_| "PLUGIN_REGISTRY_READ_FAILED")? {
        let entry = entry.map_err(|_| "PLUGIN_REGISTRY_READ_FAILED")?;
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| "PLUGIN_REGISTRY_READ_FAILED")?;
        if metadata.file_type().is_symlink() {
            return Err("PLUGIN_REGISTRY_PATH_INVALID".into());
        }
        if metadata.is_dir() {
            check_tree(root, &entry.path(), depth + 1)?;
        } else if !metadata.is_file() {
            return Err("PLUGIN_REGISTRY_PATH_INVALID".into());
        }
    }
    Ok(())
}

impl PluginRegistryState {
    /// Set up only application-private plugin folders, preserving the repository layout.
    pub(crate) fn open(root: PathBuf, core_root: PathBuf) -> Result<Self, String> {
        if !root.is_absolute() {
            return Err("PLUGIN_REGISTRY_PATH_INVALID".into());
        }
        let state = Self {
            root,
            core_root,
            operation: Mutex::new(()),
            host: Mutex::new(super::plugin_host::PluginHost::default()),
        };
        for path in [
            state.root.clone(),
            state.root.join("installed"),
            state.root.join("data"),
            state.root.join("staging"),
        ] {
            check_path(&state.root, &path, false)?;
            fs::create_dir_all(path).map_err(|_| "PLUGIN_REGISTRY_WRITE_FAILED")?;
        }
        let registry = state.read_registry()?;
        state.recover_uninstall_transactions(&registry)?;
        state.cleanup_staging()?;
        state.cleanup_orphaned_versions(&registry)?;
        state.restore()?;
        Ok(state)
    }

    /// Finish or roll back an uninstall whose process was terminated after moving files.
    /// The marker is written before the first move, so a restart can always identify the
    /// original plugin even when only one of the two source directories was moved.
    fn recover_uninstall_transactions(&self, registry: &Registry) -> Result<(), String> {
        let staging = self.root.join("staging");
        check_path(&self.root, &staging, false)?;
        for entry in fs::read_dir(&staging).map_err(|_| "PLUGIN_REGISTRY_READ_FAILED")? {
            let entry = entry.map_err(|_| "PLUGIN_REGISTRY_READ_FAILED")?;
            let trash = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("uninstall-") {
                continue;
            }
            check_tree(&self.root, &trash, 0)?;
            let marker = trash.join("transaction.json");
            let marker_bytes = fs::read(&marker).map_err(|_| "PLUGIN_REGISTRY_RECOVERY_FAILED")?;
            let marker_value: Value = serde_json::from_slice(&marker_bytes)
                .map_err(|_| "PLUGIN_REGISTRY_RECOVERY_FAILED")?;
            let id = marker_value
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| valid_id(id))
                .ok_or("PLUGIN_REGISTRY_RECOVERY_FAILED")?;
            let retained = registry.plugins.iter().any(|item| item.id == id);
            let sources = [
                self.root.join("installed").join(id),
                self.root.join("data").join(id),
            ];
            for (index, source) in sources.iter().enumerate() {
                let moved = trash.join(index.to_string());
                if !moved.exists() {
                    continue;
                }
                if retained {
                    check_path(&self.root, source, false)?;
                    if source.exists() {
                        return Err("PLUGIN_REGISTRY_RECOVERY_FAILED".into());
                    }
                    fs::create_dir_all(source.parent().ok_or("PLUGIN_REGISTRY_RECOVERY_FAILED")?)
                        .map_err(|_| "PLUGIN_REGISTRY_RECOVERY_FAILED")?;
                    fs::rename(&moved, source).map_err(|_| "PLUGIN_REGISTRY_RECOVERY_FAILED")?;
                }
            }
            fs::remove_dir_all(&trash).map_err(|_| "PLUGIN_REGISTRY_RECOVERY_FAILED")?;
        }
        Ok(())
    }

    /// Remove only transaction staging entries left behind by an interrupted install.
    /// Installed versions are intentionally reconciled separately so rollback files are preserved.
    fn cleanup_staging(&self) -> Result<(), String> {
        let staging = self.root.join("staging");
        check_path(&self.root, &staging, false)?;
        for entry in fs::read_dir(&staging).map_err(|_| "PLUGIN_REGISTRY_READ_FAILED")? {
            let entry = entry.map_err(|_| "PLUGIN_REGISTRY_READ_FAILED")?;
            let path = entry.path();
            let metadata =
                fs::symlink_metadata(&path).map_err(|_| "PLUGIN_REGISTRY_READ_FAILED")?;
            if metadata.file_type().is_symlink() {
                fs::remove_file(path).map_err(|_| "PLUGIN_REGISTRY_WRITE_FAILED")?;
            } else if metadata.is_dir() {
                check_tree(&self.root, &path, 0)?;
                fs::remove_dir_all(path).map_err(|_| "PLUGIN_REGISTRY_WRITE_FAILED")?;
            } else if metadata.is_file() {
                fs::remove_file(path).map_err(|_| "PLUGIN_REGISTRY_WRITE_FAILED")?;
            } else {
                return Err("PLUGIN_REGISTRY_PATH_INVALID".into());
            }
        }
        Ok(())
    }

    /// Remove package versions no longer referenced by active or rollback records.
    /// Unknown or malformed entries are preserved so recovery never destroys data it cannot verify.
    fn cleanup_orphaned_versions(&self, registry: &Registry) -> Result<(), String> {
        let referenced: HashMap<&str, HashSet<&str>> = registry
            .plugins
            .iter()
            .map(|entry| {
                let mut versions = HashSet::from([entry.version.as_str()]);
                if let Some(version) = entry.rollback_version.as_deref() {
                    versions.insert(version);
                }
                (entry.id.as_str(), versions)
            })
            .collect();
        for entry in &registry.plugins {
            let root = self.root.join("installed").join(&entry.id);
            check_path(&self.root, &root, false)?;
            let Ok(entries) = fs::read_dir(&root) else {
                continue;
            };
            for item in entries {
                let item = item.map_err(|_| "PLUGIN_REGISTRY_READ_FAILED")?;
                let path = item.path();
                let metadata =
                    fs::symlink_metadata(&path).map_err(|_| "PLUGIN_REGISTRY_READ_FAILED")?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    continue;
                }
                let Some(version) = item.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                if semver::Version::parse(&version).is_err()
                    || referenced
                        .get(entry.id.as_str())
                        .is_some_and(|versions| versions.contains(version.as_str()))
                {
                    continue;
                }
                let Ok(manifest) = read_manifest(&path) else {
                    continue;
                };
                if manifest["id"] != entry.id || manifest["version"] != version {
                    continue;
                }
                check_tree(&self.root, &path, 0)?;
                fs::remove_dir_all(path).map_err(|_| "PLUGIN_REGISTRY_WRITE_FAILED")?;
            }
        }
        Ok(())
    }

    /// Built-in package IDs remain protected even when a built-in manifest is malformed.
    fn is_core(&self, id: &str) -> bool {
        fs::read_dir(&self.core_root)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .any(|entry| {
                fs::read(entry.path().join("manifest.json"))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                    .is_some_and(|manifest| manifest["id"].as_str() == Some(id))
            })
    }

    /// Compute all mutation targets from validated identifiers, never registry-provided paths.
    fn version_path(&self, id: &str, version: &str) -> Result<PathBuf, String> {
        if !valid_id(id) || semver::Version::parse(version).is_err() {
            return Err("PLUGIN_REGISTRY_INVALID".into());
        }
        let path = self.root.join("installed").join(id).join(version);
        check_path(&self.root, &path, false)?;
        Ok(path)
    }

    /// A malformed registry is surfaced instead of silently replacing installed records.
    fn read_registry(&self) -> Result<Registry, String> {
        let path = self.root.join("registry.json");
        check_path(&self.root, &path, true)?;
        let file = match fs::File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Registry::default())
            }
            Err(_) => return Err("PLUGIN_REGISTRY_READ_FAILED".into()),
        };
        let mut bytes = Vec::new();
        file.take(MAX_REGISTRY_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "PLUGIN_REGISTRY_READ_FAILED")?;
        if bytes.len() as u64 > MAX_REGISTRY_BYTES {
            return Err("PLUGIN_REGISTRY_TOO_LARGE".into());
        }
        let registry: Registry =
            serde_json::from_slice(&bytes).map_err(|_| "PLUGIN_REGISTRY_INVALID")?;
        let mut ids = HashSet::new();
        if registry.version != 1 {
            return Err("PLUGIN_REGISTRY_INVALID".into());
        }
        for entry in &registry.plugins {
            if !ids.insert(&entry.id)
                || entry.install_path != self.version_path(&entry.id, &entry.version)?
                || entry.data_path != self.root.join("data").join(&entry.id)
                || self.is_core(&entry.id)
            {
                return Err("PLUGIN_REGISTRY_INVALID".into());
            }
            check_path(&self.root, &entry.data_path, false)?;
            match (&entry.rollback_version, &entry.rollback_install_path) {
                (None, None) => {}
                (Some(version), Some(path))
                    if *path == self.version_path(&entry.id, version)? => {}
                _ => return Err("PLUGIN_REGISTRY_INVALID".into()),
            }
        }
        Ok(registry)
    }

    /// Flush the complete next snapshot and atomically replace the registry on success.
    fn persist(&self, registry: &Registry) -> Result<(), String> {
        self.persist_json("registry.json", registry)
    }

    /// Use one bounded atomic writer for ordinary and core desired state snapshots.
    fn persist_json(&self, filename: &str, value: &impl Serialize) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(value).map_err(|_| "PLUGIN_REGISTRY_INVALID")?;
        if bytes.len() as u64 > MAX_REGISTRY_BYTES {
            return Err("PLUGIN_REGISTRY_TOO_LARGE".into());
        }
        let path = self.root.join(filename);
        check_path(&self.root, &path, true)?;
        let temporary = self
            .root
            .join(format!("{filename}.{}.tmp", uuid::Uuid::new_v4()));
        let operation = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, path)
        })();
        if operation.is_err() {
            let _ = fs::remove_file(temporary);
            return Err("PLUGIN_REGISTRY_WRITE_FAILED".into());
        }
        Ok(())
    }

    /// Core v1 flags migrate to disabled with no grants; malformed files stay untouched.
    fn read_core_states(&self) -> Result<CoreStates, String> {
        let path = self.root.join("core-state.json");
        check_path(&self.root, &path, true)?;
        let file = match fs::File::open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(CoreStates {
                    version: 2,
                    ..CoreStates::default()
                })
            }
            Err(_) => return Err("PLUGIN_REGISTRY_READ_FAILED".into()),
        };
        let mut bytes = Vec::new();
        file.take(MAX_REGISTRY_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "PLUGIN_REGISTRY_READ_FAILED")?;
        if bytes.len() as u64 > MAX_REGISTRY_BYTES {
            return Err("PLUGIN_REGISTRY_TOO_LARGE".into());
        }
        let raw: Value = serde_json::from_slice(&bytes).map_err(|_| "PLUGIN_REGISTRY_INVALID")?;
        let result = if raw["version"] == 1 {
            if raw.as_object().is_none_or(|o| o.len() != 2) {
                return Err("PLUGIN_REGISTRY_INVALID".into());
            }
            let plugins = raw["plugins"]
                .as_object()
                .ok_or("PLUGIN_REGISTRY_INVALID")?;
            let mut next = HashMap::new();
            for (id, value) in plugins {
                if !value.is_boolean() {
                    return Err("PLUGIN_REGISTRY_INVALID".into());
                }
                next.insert(id.clone(), CoreEntry::default());
            }
            CoreStates {
                version: 2,
                plugins: next,
            }
        } else {
            serde_json::from_value::<CoreStates>(raw).map_err(|_| "PLUGIN_REGISTRY_INVALID")?
        };
        if result.version != 2 || result.plugins.keys().any(|id| !valid_id(id)) {
            return Err("PLUGIN_REGISTRY_INVALID".into());
        }
        Ok(result)
    }

    /// Scan packaged packages through the ordinary validator, without executing their code.
    fn core_packages(&self) -> Result<Vec<(PathBuf, Value)>, String> {
        let entries = match fs::read_dir(&self.core_root) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(_) => return Err("PLUGIN_MANIFEST_READ_FAILED".into()),
        };
        let mut result = Vec::new();
        let mut ids = HashSet::new();
        for entry in entries {
            let entry = entry.map_err(|_| "PLUGIN_MANIFEST_READ_FAILED")?;
            let meta =
                fs::symlink_metadata(entry.path()).map_err(|_| "PLUGIN_MANIFEST_READ_FAILED")?;
            if meta.file_type().is_symlink() {
                return Err("PLUGIN_REGISTRY_PATH_INVALID".into());
            }
            if !meta.is_dir() {
                continue;
            }
            let manifest = read_manifest(&entry.path())?;
            if !ids.insert(manifest["id"].as_str().unwrap().to_string()) {
                return Err("PLUGIN_REGISTRY_INVALID".into());
            }
            result.push((entry.path(), manifest));
        }
        Ok(result)
    }

    /// Recreate enabled resource generations at app startup; readiness is acknowledged later.
    fn restore(&self) -> Result<(), String> {
        let mut host = self.host.lock().map_err(|_| "PLUGIN_REGISTRY_FAILED")?;
        for entry in self.read_registry()?.plugins {
            if entry.enabled {
                let manifest = self.manifest(&entry)?;
                if let Ok(session) = super::plugin_host::Session::new(
                    entry.install_path.clone(),
                    manifest.clone(),
                    filter_permissions(&manifest, &entry.granted_permissions),
                ) {
                    host.replace(&entry.id, Some(session));
                }
            }
        }
        let core = self.read_core_states()?;
        for (path, manifest) in self.core_packages()? {
            let id = manifest["id"].as_str().unwrap();
            if let Some(entry) = core.plugins.get(id).filter(|entry| entry.enabled) {
                if let Ok(session) = super::plugin_host::Session::new(
                    path,
                    manifest.clone(),
                    filter_permissions(&manifest, &entry.granted_permissions),
                ) {
                    host.replace(id, Some(session));
                }
            }
        }
        Ok(())
    }

    /// Settings/management may read disabled metadata without obtaining runtime capabilities.
    fn metadata_unlocked(&self, id: &str) -> Result<(PathBuf, Value), String> {
        if let Some(package) = self
            .core_packages()?
            .into_iter()
            .find(|(_, manifest)| manifest["id"] == id)
        {
            return Ok(package);
        }
        let registry = self.read_registry()?;
        let entry = registry
            .plugins
            .iter()
            .find(|entry| entry.id == id)
            .ok_or("PLUGIN_NOT_FOUND")?;
        Ok((entry.install_path.clone(), self.manifest(entry)?))
    }
    pub(crate) fn metadata(&self, id: &str) -> Result<(PathBuf, Value), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "PLUGIN_REGISTRY_FAILED")?;
        self.metadata_unlocked(id)
    }
    /// Every capability resolves an enabled generation and its actual granted permissions.
    pub(crate) fn active_manifest(&self, id: &str) -> Result<(PathBuf, Value), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "PLUGIN_REGISTRY_FAILED")?;
        self.host
            .lock()
            .map_err(|_| "PLUGIN_REGISTRY_FAILED")?
            .authorized_manifest(id)
    }
    pub(crate) fn authorize_runtime(
        &self,
        id: &str,
        runtime: &str,
        window: &str,
    ) -> Result<(), String> {
        self.host
            .lock()
            .map_err(|_| "PLUGIN_REGISTRY_FAILED")?
            .authorize(id, runtime, window)
    }
    pub(crate) fn invoke_sidecar(
        &self,
        id: &str,
        runtime: &str,
        request_id: &str,
        method: &str,
        params: &Value,
        deadline: u64,
    ) -> Result<Option<Value>, String> {
        self.host
            .lock()
            .map_err(|_| "PLUGIN_REGISTRY_FAILED")?
            .invoke_sidecar(id, runtime, request_id, method, params, deadline)
    }
    pub(crate) fn report_runtime(
        &self,
        id: &str,
        runtime: &str,
        window: &str,
        failed: bool,
    ) -> Result<(), String> {
        self.host
            .lock()
            .map_err(|_| "PLUGIN_REGISTRY_FAILED")?
            .report(id, runtime, window, failed)
    }
    pub(crate) fn dispose_window(&self, window: &str) -> Vec<String> {
        self.host
            .lock()
            .map(|mut host| host.dispose_window(window))
            .unwrap_or_default()
    }
    pub(crate) fn contributions(&self, window: &str) -> Result<Vec<Value>, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "PLUGIN_REGISTRY_FAILED")?;
        Ok(self
            .host
            .lock()
            .map_err(|_| "PLUGIN_REGISTRY_FAILED")?
            .contributions(window))
    }
    /// Serve GET/HEAD only, with no caching of resources from revoked generations.
    pub(crate) fn serve_resource(
        &self,
        window: &str,
        request: http::Request<Vec<u8>>,
    ) -> http::Response<Vec<u8>> {
        if !matches!(request.method().as_str(), "GET" | "HEAD") {
            return http::Response::builder().status(405).body(vec![]).unwrap();
        }
        let result = self
            .host
            .lock()
            .map_err(|_| "PLUGIN_REGISTRY_FAILED".to_string())
            .and_then(|host| host.resource(window, &request.uri().to_string()));
        match result {
            Ok((bytes, mime)) => http::Response::builder()
                .status(200)
                .header("Content-Type", mime)
                .header("Content-Length", bytes.len())
                .header("Cache-Control", "no-store")
                .header("X-Content-Type-Options", "nosniff")
                .header("Access-Control-Allow-Origin", "*")
                .body(if request.method() == "HEAD" {
                    vec![]
                } else {
                    bytes
                })
                .unwrap(),
            Err(_) => http::Response::builder()
                .status(404)
                .header("Cache-Control", "no-store")
                .header("Access-Control-Allow-Origin", "*")
                .body(vec![])
                .unwrap(),
        }
    }

    /// Load only the expected installed version and validate its on-disk identity.
    fn manifest(&self, entry: &Entry) -> Result<Value, String> {
        let path = self.version_path(&entry.id, &entry.version)?;
        let manifest = read_manifest(&path)?;
        if manifest["id"] != entry.id || manifest["version"] != entry.version {
            return Err("PLUGIN_REGISTRY_INVALID".into());
        }
        Ok(manifest)
    }

    /// Metadata reflects desired persisted state, never claims an unstarted Host is running.
    fn summary(&self, entry: &Entry, manifest: &Value) -> Result<Value, String> {
        let mut summary =
            super::plugin_summary_from_manifest(manifest).ok_or("PLUGIN_MANIFEST_INVALID")?;
        summary["isCore"] = json!(false);
        summary["enabled"] = json!(entry.enabled);
        summary["state"] = json!(if entry.enabled {
            self.host
                .lock()
                .map_err(|_| "PLUGIN_REGISTRY_FAILED")?
                .state(&entry.id)
                .unwrap_or("blocked")
                .to_string()
        } else {
            "disabled".to_string()
        });
        summary["grantedPermissions"] =
            json!(filter_permissions(manifest, &entry.granted_permissions));
        if let Some(version) = &entry.rollback_version {
            summary["rollbackVersion"] = json!(version);
        }
        Ok(summary)
    }

    /// Return validated installed metadata for the existing frontend plugin manager.
    pub(crate) fn list(&self) -> Result<Vec<Value>, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "PLUGIN_REGISTRY_FAILED")?;
        let mut result: Vec<_> = self
            .read_registry()?
            .plugins
            .iter()
            .map(|entry| self.summary(entry, &self.manifest(entry)?))
            .collect::<Result<_, String>>()?;
        let core = self.read_core_states()?;
        for (path, manifest) in self.core_packages()? {
            let id = manifest["id"].as_str().unwrap();
            let entry = core.plugins.get(id).cloned().unwrap_or_default();
            let record = Entry {
                id: id.into(),
                version: manifest["version"].as_str().unwrap().into(),
                enabled: entry.enabled,
                granted_permissions: entry.granted_permissions,
                install_path: path,
                data_path: self.root.join("data").join(id),
                rollback_version: None,
                rollback_install_path: None,
            };
            let mut summary = self.summary(&record, &manifest)?;
            summary["isCore"] = json!(true);
            result.push(summary);
        }
        Ok(result)
    }

    /// Commit a new package/version; on registry failure move the staged files back for cleanup.
    fn commit_package(
        &self,
        staged: &super::plugin_package::StagedPackage,
        target: &Path,
        registry: &Registry,
    ) -> Result<(), String> {
        check_path(&self.root, target, false)?;
        if target.exists() {
            return Err("PLUGIN_VERSION_ALREADY_INSTALLED".into());
        }
        fs::create_dir_all(target.parent().ok_or("PLUGIN_REGISTRY_PATH_INVALID")?)
            .map_err(|_| "PLUGIN_INSTALL_WRITE_FAILED")?;
        fs::rename(&staged.path, target).map_err(|_| "PLUGIN_INSTALL_WRITE_FAILED")?;
        if let Err(error) = self.persist(registry) {
            fs::rename(target, &staged.path).map_err(|_| "PLUGIN_INSTALL_ROLLBACK_FAILED")?;
            return Err(error);
        }
        Ok(())
    }

    /// New third-party packages start disabled and with no permission grants.
    pub(crate) fn install(&self, source: &Path) -> Result<Value, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "PLUGIN_REGISTRY_FAILED")?;
        let mut registry = self.read_registry()?;
        check_path(&self.root, &self.root.join("staging"), false)?;
        let staged = stage(source, &self.root.join("staging"))?;
        validate_app_compatibility(&staged.manifest)?;
        let id = staged.manifest["id"]
            .as_str()
            .ok_or("PLUGIN_MANIFEST_INVALID")?;
        if self.is_core(id) || registry.plugins.iter().any(|entry| entry.id == id) {
            return Err("PLUGIN_ALREADY_INSTALLED".into());
        }
        let version = staged.manifest["version"]
            .as_str()
            .ok_or("PLUGIN_MANIFEST_INVALID")?;
        let path = self.version_path(id, version)?;
        let entry = Entry {
            id: id.into(),
            version: version.into(),
            enabled: false,
            granted_permissions: vec![],
            install_path: path.clone(),
            data_path: self.root.join("data").join(id),
            rollback_version: None,
            rollback_install_path: None,
        };
        let summary = self.summary(&entry, &staged.manifest)?;
        registry.plugins.push(entry);
        self.commit_package(&staged, &path, &registry)?;
        Ok(summary)
    }

    /// Require an inactive version and retain its files for reversible updates.
    pub(crate) fn update(&self, id: &str, source: &Path) -> Result<Value, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "PLUGIN_REGISTRY_FAILED")?;
        if self.is_core(id) {
            return Err("PLUGIN_CORE_UPDATE_NOT_ALLOWED".into());
        }
        let mut registry = self.read_registry()?;
        let entry = registry
            .plugins
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or("PLUGIN_NOT_FOUND")?;
        if entry.enabled {
            return Err("PLUGIN_UPDATE_REQUIRES_DISABLED".into());
        }
        self.manifest(entry)?;
        check_path(&self.root, &self.root.join("staging"), false)?;
        let staged = stage(source, &self.root.join("staging"))?;
        if staged.manifest["id"] != id {
            return Err("PLUGIN_UPDATE_ID_MISMATCH".into());
        }
        validate_app_compatibility(&staged.manifest)?;
        let version = staged.manifest["version"]
            .as_str()
            .ok_or("PLUGIN_MANIFEST_INVALID")?;
        let candidate = semver::Version::parse(version).map_err(|_| "PLUGIN_MANIFEST_INVALID")?;
        let current =
            semver::Version::parse(&entry.version).map_err(|_| "PLUGIN_REGISTRY_INVALID")?;
        if candidate.cmp_precedence(&current) != std::cmp::Ordering::Greater {
            return Err("PLUGIN_UPDATE_VERSION_NOT_NEWER".into());
        }
        let path = self.version_path(id, version)?;
        entry.rollback_version = Some(entry.version.clone());
        entry.rollback_install_path = Some(entry.install_path.clone());
        entry.version = version.into();
        entry.install_path = path.clone();
        entry.granted_permissions =
            filter_permissions(&staged.manifest, &entry.granted_permissions);
        let summary = self.summary(entry, &staged.manifest)?;
        self.commit_package(&staged, &path, &registry)?;
        Ok(summary)
    }

    /// Swap active and retained versions, revalidating package identity and permission grants.
    pub(crate) fn rollback(&self, id: &str) -> Result<Value, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "PLUGIN_REGISTRY_FAILED")?;
        if self.is_core(id) {
            return Err("PLUGIN_CORE_ROLLBACK_NOT_ALLOWED".into());
        }
        let mut registry = self.read_registry()?;
        let entry = registry
            .plugins
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or("PLUGIN_NOT_FOUND")?;
        if entry.enabled {
            return Err("PLUGIN_UPDATE_REQUIRES_DISABLED".into());
        }
        let version = entry
            .rollback_version
            .clone()
            .ok_or("PLUGIN_ROLLBACK_NOT_AVAILABLE")?;
        let path = self.version_path(id, &version)?;
        let manifest = read_manifest(&path)?;
        if manifest["id"] != id || manifest["version"] != version {
            return Err("PLUGIN_ROLLBACK_VERSION_INVALID".into());
        }
        validate_app_compatibility(&manifest)?;
        entry.rollback_version = Some(std::mem::replace(&mut entry.version, version));
        entry.rollback_install_path = Some(std::mem::replace(&mut entry.install_path, path));
        entry.granted_permissions = filter_permissions(&manifest, &entry.granted_permissions);
        let summary = self.summary(entry, &manifest)?;
        self.persist(&registry)?;
        Ok(summary)
    }

    /// Persist grants then replace any active generation, revoking its old resource/RPC IDs.
    pub(crate) fn set_permissions(
        &self,
        id: &str,
        permissions: &[String],
    ) -> Result<Value, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "PLUGIN_REGISTRY_FAILED")?;
        let (path, manifest) = self.metadata_unlocked(id)?;
        validate_grants(&manifest, permissions)?;
        let grants = filter_permissions(&manifest, permissions);
        if self.is_core(id) {
            let mut states = self.read_core_states()?;
            let entry = states.plugins.entry(id.into()).or_default();
            entry.granted_permissions = grants.clone();
            let session = if entry.enabled {
                Some(super::plugin_host::Session::new(
                    path,
                    manifest.clone(),
                    grants,
                )?)
            } else {
                None
            };
            let enabled = entry.enabled;
            self.persist_json("core-state.json", &states)?;
            self.host
                .lock()
                .map_err(|_| "PLUGIN_REGISTRY_FAILED")?
                .replace(id, session);
            return Ok(self.core_summary(id, &manifest, enabled, permissions)?);
        }
        let mut registry = self.read_registry()?;
        let entry = registry
            .plugins
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or("PLUGIN_NOT_FOUND")?;
        entry.granted_permissions = grants.clone();
        let session = if entry.enabled {
            Some(super::plugin_host::Session::new(
                path,
                manifest.clone(),
                grants,
            )?)
        } else {
            None
        };
        let updated = entry.clone();
        self.persist(&registry)?;
        self.host
            .lock()
            .map_err(|_| "PLUGIN_REGISTRY_FAILED")?
            .replace(id, session);
        self.summary(&updated, &manifest)
    }

    /// Enable/disable core and ordinary resource Hosts through identical generation rules.
    pub(crate) fn set_enabled(&self, id: &str, enabled: bool) -> Result<Value, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "PLUGIN_REGISTRY_FAILED")?;
        let (path, manifest) = self.metadata_unlocked(id)?;
        if self.is_core(id) {
            let mut states = self.read_core_states()?;
            let entry = states.plugins.entry(id.into()).or_default();
            let grants = filter_permissions(&manifest, &entry.granted_permissions);
            let session = if enabled {
                Some(super::plugin_host::Session::new(
                    path,
                    manifest.clone(),
                    grants.clone(),
                )?)
            } else {
                None
            };
            entry.enabled = enabled;
            self.persist_json("core-state.json", &states)?;
            self.host
                .lock()
                .map_err(|_| "PLUGIN_REGISTRY_FAILED")?
                .replace(id, session);
            return self.core_summary(id, &manifest, enabled, &grants);
        }
        let mut registry = self.read_registry()?;
        let entry = registry
            .plugins
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or("PLUGIN_NOT_FOUND")?;
        let session = if enabled {
            Some(super::plugin_host::Session::new(
                path,
                manifest.clone(),
                filter_permissions(&manifest, &entry.granted_permissions),
            )?)
        } else {
            None
        };
        entry.enabled = enabled;
        let updated = entry.clone();
        self.persist(&registry)?;
        self.host
            .lock()
            .map_err(|_| "PLUGIN_REGISTRY_FAILED")?
            .replace(id, session);
        self.summary(&updated, &manifest)
    }

    /// Return management metadata without inventing readiness for an enabled core package.
    fn core_summary(
        &self,
        id: &str,
        manifest: &Value,
        enabled: bool,
        grants: &[String],
    ) -> Result<Value, String> {
        let mut summary =
            super::plugin_summary_from_manifest(manifest).ok_or("PLUGIN_MANIFEST_INVALID")?;
        summary["enabled"] = json!(enabled);
        summary["grantedPermissions"] = json!(filter_permissions(manifest, grants));
        summary["state"] = json!(if enabled {
            self.host
                .lock()
                .map_err(|_| "PLUGIN_REGISTRY_FAILED")?
                .state(id)
                .unwrap_or("blocked")
                .to_string()
        } else {
            "disabled".to_string()
        });
        Ok(summary)
    }

    /// Remove every installed version and private data with restoration before registry commit.
    pub(crate) fn uninstall(&self, id: &str) -> Result<(), String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "PLUGIN_REGISTRY_FAILED")?;
        if self.is_core(id) {
            return Err("PLUGIN_CORE_UNINSTALL_NOT_ALLOWED".into());
        }
        let mut registry = self.read_registry()?;
        let entry = registry
            .plugins
            .iter()
            .find(|entry| entry.id == id)
            .ok_or("PLUGIN_NOT_FOUND")?;
        if entry.enabled {
            return Err("PLUGIN_UPDATE_REQUIRES_DISABLED".into());
        }
        let sources = [
            self.root.join("installed").join(id),
            self.root.join("data").join(id),
        ];
        for source in &sources {
            check_path(&self.root, source, false)?;
            if source.exists() {
                check_tree(&self.root, source, 0)?;
            }
        }
        let staging = self.root.join("staging");
        check_path(&self.root, &staging, false)?;
        let trash = staging.join(format!("uninstall-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&trash).map_err(|_| "PLUGIN_UNINSTALL_FAILED")?;
        fs::write(
            trash.join("transaction.json"),
            serde_json::to_vec(&json!({ "id": id })).map_err(|_| "PLUGIN_UNINSTALL_FAILED")?,
        )
        .map_err(|_| "PLUGIN_UNINSTALL_FAILED")?;
        let mut moved = Vec::new();
        let operation = (|| {
            for (index, source) in sources
                .iter()
                .enumerate()
                .filter(|(_, source)| source.exists())
            {
                let target = trash.join(index.to_string());
                fs::rename(source, &target).map_err(|_| "PLUGIN_UNINSTALL_FAILED")?;
                moved.push((source.clone(), target));
            }
            registry.plugins.retain(|entry| entry.id != id);
            self.persist(&registry)
        })();
        if let Err(error) = operation {
            for (source, target) in moved.iter().rev() {
                fs::rename(target, source).map_err(|_| "PLUGIN_UNINSTALL_ROLLBACK_FAILED")?;
            }
            let _ = fs::remove_dir_all(&trash);
            return Err(error);
        }
        if let Err(error) = fs::remove_dir_all(&trash) {
            eprintln!("[plugin:{id}] PLUGIN_UNINSTALL_CLEANUP_FAILED: {error}");
        }
        Ok(())
    }
}

/// Retain only declared ordinary grants, preserving request order and removing duplicates.
fn filter_permissions(manifest: &Value, permissions: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    permissions
        .iter()
        .filter(|permission| {
            !PRIVILEGED.contains(&permission.as_str())
                && super::plugin_permission_is_declared(manifest, permission)
                && seen.insert(permission.as_str())
        })
        .cloned()
        .collect()
}

/// Grant requests must be declared ordinary permissions; no package gets private capabilities.
fn validate_grants(manifest: &Value, permissions: &[String]) -> Result<(), String> {
    if permissions.len() > 128 {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    if permissions
        .iter()
        .any(|p| !super::plugin_permission_is_declared(manifest, p))
    {
        return Err("PLUGIN_PERMISSION_NOT_DECLARED".into());
    }
    if permissions.iter().any(|p| PRIVILEGED.contains(&p.as_str())) {
        return Err("PLUGIN_PRIVILEGED_PERMISSION_GRANT_NOT_IMPLEMENTED".into());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallRequest {
    source_path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateRequest {
    id: String,
    source_path: String,
}
#[derive(Deserialize)]
pub(crate) struct PermissionsRequest {
    id: String,
    permissions: Vec<String>,
}
#[derive(Deserialize)]
pub(crate) struct EnabledRequest {
    id: String,
    enabled: bool,
}

/// Perform file work off the UI thread and publish registry changes only after commit.
async fn mutate(
    app: AppHandle,
    operation: impl FnOnce(&PluginRegistryState) -> Result<(String, Value), String> + Send + 'static,
) -> Result<Value, String> {
    let worker_app = app.clone();
    let (id, result) = tauri::async_runtime::spawn_blocking(move || {
        operation(&worker_app.state::<PluginRegistryState>())
    })
    .await
    .map_err(|_| "PLUGIN_REGISTRY_FAILED".to_string())??;
    app.state::<super::PluginRpcState>().dispose_plugin(&id);
    app.state::<super::PluginSettingsState>()
        .dispose_plugin(&id);
    app.state::<super::web_viewer::WebViewerState>()
        .dispose(&app, |scope| scope.plugin == id);
    if let Err(error) = app.emit("plugin:registryChanged", json!({"pluginId":id})) {
        // The transaction is already committed: never report a failed install for an event failure.
        eprintln!("[plugin:{id}] PLUGIN_REGISTRY_EVENT_FAILED: {error}");
    }
    Ok(result)
}

/// Install a validated ordinary package into application-private storage.
#[tauri::command]
pub(crate) async fn plugin_install(
    request: InstallRequest,
    app: AppHandle,
) -> Result<Value, String> {
    mutate(app, move |state| {
        let summary = state.install(Path::new(&request.source_path))?;
        Ok((summary["id"].as_str().unwrap().into(), summary))
    })
    .await
}

/// Update an inactive plugin while retaining the previous version.
#[tauri::command]
pub(crate) async fn plugin_update(request: UpdateRequest, app: AppHandle) -> Result<Value, String> {
    mutate(app, move |state| {
        Ok((
            request.id.clone(),
            state.update(&request.id, Path::new(&request.source_path))?,
        ))
    })
    .await
}

/// Toggle the installed and retained versions.
#[tauri::command]
pub(crate) async fn plugin_rollback(id: String, app: AppHandle) -> Result<Value, String> {
    mutate(app, move |state| Ok((id.clone(), state.rollback(&id)?))).await
}

/// Record ordinary grants without automatically starting package code.
#[tauri::command]
pub(crate) async fn plugin_set_permissions(
    request: PermissionsRequest,
    app: AppHandle,
) -> Result<Value, String> {
    mutate(app, move |state| {
        Ok((
            request.id.clone(),
            state.set_permissions(&request.id, &request.permissions)?,
        ))
    })
    .await
}

/// Disable an inactive/unhosted record; startup returns a stable Host-unavailable error.
#[tauri::command]
pub(crate) async fn plugin_set_enabled(
    request: EnabledRequest,
    app: AppHandle,
) -> Result<Value, String> {
    mutate(app, move |state| {
        Ok((
            request.id.clone(),
            state.set_enabled(&request.id, request.enabled)?,
        ))
    })
    .await
}

/// Uninstall all versions and private data belonging to one ordinary plugin.
#[tauri::command]
pub(crate) async fn plugin_uninstall(id: String, app: AppHandle) -> Result<(), String> {
    mutate(app, move |state| {
        state.uninstall(&id)?;
        Ok((id, Value::Null))
    })
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_package::tests::{manifest, Fixture};
    #[cfg(windows)]
    use std::time::{SystemTime, UNIX_EPOCH};
    const ID: &str = "com.example.reader";

    fn state(f: &Fixture) -> PluginRegistryState {
        PluginRegistryState::open(f.0.join("managed"), f.0.join("core")).unwrap()
    }
    fn write_manifest(source: &Path, value: &Value) {
        fs::write(
            source.join("manifest.json"),
            serde_json::to_vec(value).unwrap(),
        )
        .unwrap();
        fs::write(source.join("main.js"), "export {}").unwrap();
        fs::write(source.join("styles.css"), "").unwrap();
    }

    #[test]
    fn incompatible_directory_and_archive_install_leave_no_registry_or_staging() {
        let f = Fixture::new();
        let state = state(&f);
        let source = f.package("1.0.0");
        let mut value = manifest("1.0.0");
        value["minAppVersion"] = json!("99.0.0");
        write_manifest(&source, &value);
        let manifest_bytes = fs::read(source.join("manifest.json")).unwrap();
        let archive = f.archive(&[
            ("manifest.json", &manifest_bytes),
            ("main.js", b"export {}"),
            ("styles.css", b""),
        ]);

        for path in [&source, &archive] {
            assert_eq!(
                state.install(path).unwrap_err(),
                "PLUGIN_APP_VERSION_UNSUPPORTED"
            );
            assert!(!state.root.join("registry.json").exists());
            assert!(!state.root.join("installed").join(ID).exists());
            assert_eq!(fs::read_dir(state.root.join("staging")).unwrap().count(), 0);
        }
        assert_eq!(
            fs::read(source.join("manifest.json")).unwrap(),
            manifest_bytes
        );
        assert!(archive.is_file());
    }

    #[test]
    fn incompatible_update_and_rollback_preserve_versions_registry_and_private_data() {
        let f = Fixture::new();
        let state = state(&f);
        state.install(&f.package("1.0.0")).unwrap();
        state.update(ID, &f.package("2.0.0")).unwrap();
        let data = state.root.join("data").join(ID);
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("value"), "keep").unwrap();
        let before = fs::read(state.root.join("registry.json")).unwrap();
        let source = f.package("3.0.0");
        let mut future = manifest("3.0.0");
        future["minAppVersion"] = json!("99.0.0");
        write_manifest(&source, &future);
        assert_eq!(
            state.update(ID, &source).unwrap_err(),
            "PLUGIN_APP_VERSION_UNSUPPORTED"
        );
        assert!(!state.version_path(ID, "3.0.0").unwrap().exists());
        assert_eq!(fs::read_dir(state.root.join("staging")).unwrap().count(), 0);

        // Simulate a retained version requiring a newer host after an application downgrade.
        let mut retained = manifest("1.0.0");
        retained["minAppVersion"] = json!("99.0.0");
        write_manifest(&state.version_path(ID, "1.0.0").unwrap(), &retained);
        assert_eq!(
            state.rollback(ID).unwrap_err(),
            "PLUGIN_APP_VERSION_UNSUPPORTED"
        );
        assert_eq!(fs::read(state.root.join("registry.json")).unwrap(), before);
        assert!(state.version_path(ID, "1.0.0").unwrap().is_dir());
        assert!(state.version_path(ID, "2.0.0").unwrap().is_dir());
        assert_eq!(fs::read_to_string(data.join("value")).unwrap(), "keep");
    }

    #[test]
    fn incompatible_enabled_package_on_restart_is_blocked_and_can_be_disabled_and_uninstalled() {
        let f = Fixture::new();
        let opened = state(&f);
        let source = f.package("1.0.0");
        let mut value = manifest("1.0.0");
        value["permissions"] = json!([]);
        write_manifest(&source, &value);
        opened.install(&source).unwrap();
        opened.set_enabled(ID, true).unwrap();
        let installed = opened.version_path(ID, "1.0.0").unwrap();
        let data = opened.root.join("data").join(ID);
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("value"), "keep").unwrap();
        let before = fs::read(opened.root.join("registry.json")).unwrap();
        value["minAppVersion"] = json!("99.0.0");
        write_manifest(&installed, &value);
        drop(opened);

        let reopened = state(&f);
        assert_eq!(reopened.list().unwrap()[0]["state"], "blocked");
        assert_eq!(reopened.list().unwrap()[0]["enabled"], true);
        assert!(reopened.contributions("main").unwrap().is_empty());
        assert!(reopened.active_manifest(ID).is_err());
        assert_eq!(
            reopened.set_enabled(ID, true).unwrap_err(),
            "PLUGIN_APP_VERSION_UNSUPPORTED"
        );
        assert_eq!(
            reopened.set_permissions(ID, &[]).unwrap_err(),
            "PLUGIN_APP_VERSION_UNSUPPORTED"
        );
        assert_eq!(
            fs::read(reopened.root.join("registry.json")).unwrap(),
            before
        );
        assert_eq!(fs::read_to_string(data.join("value")).unwrap(), "keep");
        assert_eq!(
            reopened.set_enabled(ID, false).unwrap()["state"],
            "disabled"
        );
        reopened.uninstall(ID).unwrap();
        assert!(reopened.list().unwrap().is_empty());
    }

    #[test]
    fn incompatible_enabled_core_package_on_restart_uses_same_compatibility_gate() {
        let f = Fixture::new();
        let opened = state(&f);
        let path = opened.core_root.join("reader");
        fs::create_dir_all(&path).unwrap();
        let mut value = manifest("1.0.0");
        value["permissions"] = json!([]);
        write_manifest(&path, &value);
        opened.set_enabled(ID, true).unwrap();
        let before = fs::read(opened.root.join("core-state.json")).unwrap();
        value["minAppVersion"] = json!("99.0.0");
        write_manifest(&path, &value);
        drop(opened);

        let reopened = state(&f);
        assert_eq!(reopened.list().unwrap()[0]["state"], "blocked");
        assert!(reopened.contributions("main").unwrap().is_empty());
        assert_eq!(
            reopened.set_enabled(ID, true).unwrap_err(),
            "PLUGIN_APP_VERSION_UNSUPPORTED"
        );
        assert_eq!(
            fs::read(reopened.root.join("core-state.json")).unwrap(),
            before
        );
        assert_eq!(
            reopened.set_enabled(ID, false).unwrap()["state"],
            "disabled"
        );
    }

    #[test]
    fn install_restart_update_rollback_and_uninstall_preserve_contract() {
        let f = Fixture::new();
        let state = state(&f);
        let first = f.package("1.0.0");
        let result = state.install(&first).unwrap();
        assert_eq!(result["state"], "disabled");
        assert_eq!(result["enabled"], false);
        assert_eq!(result["isCore"], false);
        assert_eq!(result["grantedPermissions"], json!([]));
        assert_eq!(state.list().unwrap(), vec![result.clone()]);
        let reloaded =
            PluginRegistryState::open(state.root.clone(), state.core_root.clone()).unwrap();
        assert_eq!(reloaded.list().unwrap(), vec![result]);
        assert_eq!(
            state.install(&first).unwrap_err(),
            "PLUGIN_ALREADY_INSTALLED"
        );
        let second = f.package("1.1.0");
        assert_eq!(
            state.update(ID, &second).unwrap()["rollbackVersion"],
            "1.0.0"
        );
        assert!(state.version_path(ID, "1.0.0").unwrap().is_dir());
        assert_eq!(state.rollback(ID).unwrap()["version"], "1.0.0");
        assert_eq!(state.rollback(ID).unwrap()["version"], "1.1.0");
        let third = f.package("2.0.0");
        state.update(ID, &third).unwrap();
        let data = state.root.join("data").join(ID);
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("state.json"), "{}").unwrap();
        state.uninstall(ID).unwrap();
        assert!(state.list().unwrap().is_empty());
        assert!(!state.root.join("installed").join(ID).exists());
        assert!(!data.exists());
        assert!(first.join("main.js").is_file());
        assert!(second.join("main.js").is_file());
        assert_eq!(fs::read_dir(state.root.join("staging")).unwrap().count(), 0);
    }

    #[test]
    fn archive_install_has_same_registry_and_permission_defaults_as_directory() {
        let f = Fixture::new();
        let state = state(&f);
        let bytes = serde_json::to_vec(&manifest("1.0.0")).unwrap();
        let path = f.archive(&[
            ("manifest.json", &bytes),
            ("main.js", b"export {}"),
            ("styles.css", b""),
        ]);
        assert_eq!(state.install(&path).unwrap()["version"], "1.0.0");
        assert!(path.exists());
        assert_eq!(state.list().unwrap().len(), 1);
    }

    #[test]
    fn startup_cleans_interrupted_staging_entries_without_touching_sources() {
        let f = Fixture::new();
        let opened = state(&f);
        let stale = opened.root.join("staging").join("interrupted");
        fs::create_dir_all(stale.join("assets")).unwrap();
        fs::write(stale.join("assets/icon.svg"), "<svg/>").unwrap();
        fs::write(stale.join("partial.tmp"), "partial").unwrap();
        drop(opened);

        let reopened = state(&f);
        assert!(!reopened.root.join("staging/interrupted").exists());
        assert_eq!(
            fs::read_dir(reopened.root.join("staging")).unwrap().count(),
            0
        );
    }

    #[test]
    fn startup_recovers_interrupted_uninstall_when_registry_retains_plugin() {
        let f = Fixture::new();
        let opened = state(&f);
        opened.install(&f.package("1.0.0")).unwrap();
        let installed = opened.root.join("installed").join(ID);
        let data = opened.root.join("data").join(ID);
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("state.json"), "{\"open\":true}").unwrap();

        let trash = opened
            .root
            .join("staging")
            .join("uninstall-interrupted-retain");
        fs::create_dir_all(&trash).unwrap();
        fs::write(
            trash.join("transaction.json"),
            serde_json::to_vec(&json!({ "id": ID })).unwrap(),
        )
        .unwrap();
        fs::rename(&installed, trash.join("0")).unwrap();
        fs::rename(&data, trash.join("1")).unwrap();
        assert!(!installed.exists());
        assert!(!data.exists());
        drop(opened);

        let reopened = state(&f);
        assert!(reopened.version_path(ID, "1.0.0").unwrap().is_dir());
        assert_eq!(
            fs::read_to_string(reopened.root.join("data").join(ID).join("state.json")).unwrap(),
            "{\"open\":true}"
        );
        assert!(!trash.exists());
        assert_eq!(
            fs::read_dir(reopened.root.join("staging")).unwrap().count(),
            0
        );
    }

    #[test]
    fn startup_discards_interrupted_uninstall_when_registry_already_removed_plugin() {
        let f = Fixture::new();
        let opened = state(&f);
        opened.install(&f.package("1.0.0")).unwrap();
        let installed = opened.root.join("installed").join(ID);
        let data = opened.root.join("data").join(ID);
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("state.json"), "{\"open\":true}").unwrap();

        let trash = opened
            .root
            .join("staging")
            .join("uninstall-interrupted-delete");
        fs::create_dir_all(&trash).unwrap();
        fs::write(
            trash.join("transaction.json"),
            serde_json::to_vec(&json!({ "id": ID })).unwrap(),
        )
        .unwrap();
        fs::rename(&installed, trash.join("0")).unwrap();
        fs::rename(&data, trash.join("1")).unwrap();
        opened.persist(&Registry::default()).unwrap();
        drop(opened);

        let reopened = state(&f);
        assert!(!reopened.root.join("installed").join(ID).exists());
        assert!(!reopened.root.join("data").join(ID).exists());
        assert!(!trash.exists());
        assert_eq!(
            fs::read_dir(reopened.root.join("staging")).unwrap().count(),
            0
        );
    }

    #[test]
    fn startup_removes_verified_orphan_versions_but_keeps_active_and_rollback_versions() {
        let f = Fixture::new();
        let opened = state(&f);
        opened.install(&f.package("1.0.0")).unwrap();
        opened.update(ID, &f.package("2.0.0")).unwrap();
        let orphan = opened.version_path(ID, "0.5.0").unwrap();
        fs::create_dir_all(&orphan).unwrap();
        write_manifest(&orphan, &manifest("0.5.0"));
        assert!(orphan.exists());
        drop(opened);

        let reopened = state(&f);
        assert!(!orphan.exists());
        assert!(reopened.version_path(ID, "1.0.0").unwrap().is_dir());
        assert!(reopened.version_path(ID, "2.0.0").unwrap().is_dir());
    }

    #[test]
    fn legacy_migration_rewrites_registry_paths_and_preserves_source() {
        let f = Fixture::new();
        let source = f.0.join("legacy");
        let target = f.0.join("tauri");
        fs::create_dir_all(source.join("installed").join(ID).join("1.0.0")).unwrap();
        fs::create_dir_all(source.join("data").join(ID)).unwrap();
        write_manifest(
            &source.join("installed").join(ID).join("1.0.0"),
            &manifest("1.0.0"),
        );
        let registry = Registry {
            version: 1,
            plugins: vec![Entry {
                id: ID.into(),
                version: "1.0.0".into(),
                enabled: false,
                granted_permissions: vec![],
                install_path: source.join("installed").join(ID).join("1.0.0"),
                data_path: source.join("data").join(ID),
                rollback_version: None,
                rollback_install_path: None,
            }],
        };
        fs::write(
            source.join("registry.json"),
            serde_json::to_vec(&registry).unwrap(),
        )
        .unwrap();
        fs::write(
            source.join("core-state.json"),
            br#"{"version":2,"plugins":{"com.example.reader":{"enabled":true,"grantedPermissions":["workspace.read"]}}}"#,
        )
        .unwrap();
        assert_eq!(migrate_legacy_data(&source, &target).unwrap(), true);
        assert!(source.join("registry.json").is_file());
        assert!(target.join("migration-v1.complete").is_file());
        let migrated: Registry =
            serde_json::from_slice(&fs::read(target.join("registry.json")).unwrap()).unwrap();
        assert_eq!(
            migrated.plugins[0].install_path,
            target.join("installed").join(ID).join("1.0.0")
        );
        assert_eq!(migrated.plugins[0].data_path, target.join("data").join(ID));
        assert_eq!(
            fs::read(target.join("core-state.json")).unwrap(),
            fs::read(source.join("core-state.json")).unwrap()
        );
    }

    #[test]
    fn legacy_migration_skips_existing_target_without_touching_source() {
        let f = Fixture::new();
        let source = f.0.join("legacy");
        let target = f.0.join("tauri");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("keep.txt"), "legacy").unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("existing.txt"), "current").unwrap();

        assert!(!migrate_legacy_data(&source, &target).unwrap());
        assert_eq!(
            fs::read_to_string(source.join("keep.txt")).unwrap(),
            "legacy"
        );
        assert_eq!(
            fs::read_to_string(target.join("existing.txt")).unwrap(),
            "current"
        );
        assert!(!target.join("migration-v1.complete").exists());
    }

    #[test]
    fn legacy_migration_replaces_empty_tauri_scaffold() {
        let f = Fixture::new();
        let source = f.0.join("legacy");
        let target = f.0.join("tauri");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("core-state.json"),
            br#"{"version":2,"plugins":{}}"#,
        )
        .unwrap();
        fs::create_dir_all(target.join("installed")).unwrap();
        fs::create_dir_all(target.join("data")).unwrap();
        fs::create_dir_all(target.join("staging")).unwrap();

        assert!(migrate_legacy_data(&source, &target).unwrap());
        assert_eq!(
            fs::read(target.join("core-state.json")).unwrap(),
            fs::read(source.join("core-state.json")).unwrap()
        );
    }

    #[test]
    fn legacy_migration_cleans_staging_when_registry_is_invalid() {
        let f = Fixture::new();
        let source = f.0.join("legacy");
        let target = f.0.join("tauri");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("registry.json"), b"{broken").unwrap();

        assert_eq!(
            migrate_legacy_data(&source, &target).unwrap_err(),
            "PLUGIN_MIGRATION_INVALID"
        );
        assert!(!target.exists());
        assert!(source.join("registry.json").is_file());
        let staging = fs::read_dir(&f.0)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".plugins-migration-")
            });
        assert!(!staging);
    }

    #[test]
    fn legacy_migration_cleans_staging_when_size_limit_is_exceeded() {
        let f = Fixture::new();
        let source = f.0.join("legacy");
        let target = f.0.join("tauri");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("large.bin"), b"0123456789").unwrap();

        assert_eq!(
            migrate_legacy_data_with_limit(&source, &target, 4).unwrap_err(),
            "PLUGIN_MIGRATION_TOO_LARGE"
        );
        assert!(!target.exists());
        assert!(source.join("large.bin").is_file());
        let staging = fs::read_dir(&f.0)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".plugins-migration-")
            });
        assert!(!staging);
    }

    #[cfg(unix)]
    #[test]
    fn legacy_migration_rejects_symlinks_without_creating_target() {
        use std::os::unix::fs::symlink;

        let f = Fixture::new();
        let source = f.0.join("legacy");
        let target = f.0.join("tauri");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("real.txt"), "legacy").unwrap();
        symlink(source.join("real.txt"), source.join("link.txt")).unwrap();

        assert_eq!(
            migrate_legacy_data(&source, &target).unwrap_err(),
            "PLUGIN_MIGRATION_PATH_INVALID"
        );
        assert!(!target.exists());
        assert!(source.join("link.txt").exists());
    }

    #[test]
    fn core_packages_are_protected_without_private_capability_paths() {
        let f = Fixture::new();
        let state = state(&f);
        let source = f.package("1.0.0");
        fs::create_dir_all(state.core_root.join("reader")).unwrap();
        write_manifest(&state.core_root.join("reader"), &manifest("1.0.0"));
        assert_eq!(
            state.install(&source).unwrap_err(),
            "PLUGIN_ALREADY_INSTALLED"
        );
        assert_eq!(
            state.update(ID, &source).unwrap_err(),
            "PLUGIN_CORE_UPDATE_NOT_ALLOWED"
        );
        assert_eq!(
            state.rollback(ID).unwrap_err(),
            "PLUGIN_CORE_ROLLBACK_NOT_ALLOWED"
        );
        assert_eq!(
            state.uninstall(ID).unwrap_err(),
            "PLUGIN_CORE_UNINSTALL_NOT_ALLOWED"
        );
        assert_eq!(
            state.set_enabled(ID, true).unwrap_err(),
            "PLUGIN_PRIVILEGED_RUNTIME_NOT_IMPLEMENTED"
        );
        assert_eq!(
            state.set_permissions(ID, &[]).unwrap()["grantedPermissions"],
            json!([])
        );
        assert!(!state.root.join("registry.json").exists());
    }

    #[test]
    fn semver_ordering_id_mismatch_and_missing_rollback_leave_snapshot_intact() {
        let f = Fixture::new();
        let state = state(&f);
        state.install(&f.package("1.0.0-alpha.2")).unwrap();
        assert_eq!(
            state.rollback(ID).unwrap_err(),
            "PLUGIN_ROLLBACK_NOT_AVAILABLE"
        );
        state.update(ID, &f.package("1.0.0-alpha.10")).unwrap();
        state.update(ID, &f.package("1.0.0")).unwrap();
        let snapshot = fs::read(state.root.join("registry.json")).unwrap();
        for version in ["1.0.0+build.2", "1.0.0-beta", "0.9.9"] {
            assert_eq!(
                state.update(ID, &f.package(version)).unwrap_err(),
                "PLUGIN_UPDATE_VERSION_NOT_NEWER"
            );
        }
        let source = f.package("2.0.0");
        let mut value = manifest("2.0.0");
        value["id"] = json!("com.example.other");
        write_manifest(&source, &value);
        assert_eq!(
            state.update(ID, &source).unwrap_err(),
            "PLUGIN_UPDATE_ID_MISMATCH"
        );
        assert_eq!(
            fs::read(state.root.join("registry.json")).unwrap(),
            snapshot
        );
        assert_eq!(fs::read_dir(state.root.join("staging")).unwrap().count(), 0);
    }

    #[test]
    fn grants_are_deduplicated_rejected_or_intersected_when_versions_change() {
        let f = Fixture::new();
        let state = state(&f);
        let source = f.package("1.0.0");
        let mut value = manifest("1.0.0");
        value["permissions"] = json!([
            { "id": "workspace.read", "reason": "Read workspace" },
            { "id": "storage.plugin", "reason": "Save state" },
            { "id": "renderer.code", "reason": "Render code" }
        ]);
        write_manifest(&source, &value);
        state.install(&source).unwrap();
        let result = state
            .set_permissions(
                ID,
                &[
                    "workspace.read".into(),
                    "workspace.read".into(),
                    "storage.plugin".into(),
                ],
            )
            .unwrap();
        assert_eq!(
            result["grantedPermissions"],
            json!(["workspace.read", "storage.plugin"])
        );
        let snapshot = fs::read(state.root.join("registry.json")).unwrap();
        assert_eq!(
            state
                .set_permissions(ID, &["network.request".into()])
                .unwrap_err(),
            "PLUGIN_PERMISSION_NOT_DECLARED"
        );
        assert_eq!(
            state
                .set_permissions(ID, &["renderer.code".into()])
                .unwrap_err(),
            "PLUGIN_PRIVILEGED_PERMISSION_GRANT_NOT_IMPLEMENTED"
        );
        assert_eq!(
            fs::read(state.root.join("registry.json")).unwrap(),
            snapshot
        );
        let source = f.package("2.0.0");
        let mut value = manifest("2.0.0");
        value["permissions"] = json!([{"id":"storage.plugin","reason":"Save state"}]);
        write_manifest(&source, &value);
        assert_eq!(
            state.update(ID, &source).unwrap()["grantedPermissions"],
            json!(["storage.plugin"])
        );
        assert_eq!(
            state.rollback(ID).unwrap()["grantedPermissions"],
            json!(["storage.plugin"])
        );
    }

    #[test]
    fn startup_is_never_fabricated_and_old_enabled_records_can_be_disabled() {
        let f = Fixture::new();
        let state = state(&f);
        let source = f.package("1.0.0");
        let mut value = manifest("1.0.0");
        value["permissions"] = json!([{ "id": "storage.plugin", "reason": "Save state" }]);
        write_manifest(&source, &value);
        state.install(&source).unwrap();
        let snapshot = fs::read(state.root.join("registry.json")).unwrap();
        assert_eq!(state.set_enabled(ID, true).unwrap()["state"], "starting");
        assert_eq!(state.list().unwrap()[0]["state"], "starting");
        assert_ne!(
            fs::read(state.root.join("registry.json")).unwrap(),
            snapshot
        );
        let mut registry = state.read_registry().unwrap();
        registry.plugins[0].enabled = true;
        state.persist(&registry).unwrap();
        assert_eq!(state.list().unwrap()[0]["state"], "starting");
        assert_eq!(
            state.update(ID, &f.package("2.0.0")).unwrap_err(),
            "PLUGIN_UPDATE_REQUIRES_DISABLED"
        );
        assert_eq!(
            state.rollback(ID).unwrap_err(),
            "PLUGIN_UPDATE_REQUIRES_DISABLED"
        );
        assert_eq!(
            state.uninstall(ID).unwrap_err(),
            "PLUGIN_UPDATE_REQUIRES_DISABLED"
        );
        assert_eq!(state.set_permissions(ID, &[]).unwrap()["state"], "starting");
        assert_eq!(state.set_enabled(ID, false).unwrap()["state"], "disabled");
        assert_eq!(state.list().unwrap()[0]["state"], "disabled");
    }

    #[test]
    fn ordinary_plugin_contributions_use_revocable_host_generation_and_window_ownership() {
        let f = Fixture::new();
        let state = state(&f);
        let source = f.package("1.0.0");
        let mut value = manifest("1.0.0");
        value["permissions"] = json!([
            { "id": "workspace.read", "reason": "Read notes" }
        ]);
        write_manifest(&source, &value);
        state.install(&source).unwrap();
        let enabled = state.set_enabled(ID, true).unwrap();
        assert_eq!(enabled["state"], "starting");

        let first = state.contributions("window-a").unwrap();
        assert_eq!(first.len(), 1);
        let runtime_id = first[0]["runtimeId"].as_str().unwrap().to_string();
        assert!(first[0]["entryUrl"]
            .as_str()
            .unwrap()
            .contains("/plugin/main.js"));
        assert!(first[0]["stylesUrl"]
            .as_str()
            .unwrap()
            .contains("/plugin/styles.css"));
        let second = state.contributions("window-b").unwrap();
        assert_eq!(second[0]["runtimeId"], runtime_id);
        state
            .report_runtime(ID, &runtime_id, "window-a", false)
            .unwrap();
        assert_eq!(state.list().unwrap()[0]["state"], "running");
        state.dispose_window("window-a");
        assert!(state
            .authorize_runtime(ID, &runtime_id, "window-a")
            .is_err());
        assert!(state.authorize_runtime(ID, &runtime_id, "window-b").is_ok());

        state.set_enabled(ID, false).unwrap();
        assert!(state.contributions("window-b").unwrap().is_empty());
        assert!(state
            .authorize_runtime(ID, &runtime_id, "window-b")
            .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn packaged_sidecar_plugin_can_install_enable_and_disable() {
        let f = Fixture::new();
        let state = state(&f);
        let source = f.package("1.0.0");
        let mut value = manifest("1.0.0");
        value["permissions"] = json!([]);
        value["sidecar"] = json!({
            "type": "sidecar",
            "executable": "host.exe",
            "args": ["/C", "type response.jsonl"]
        });
        write_manifest(&source, &value);
        fs::copy(
            std::env::var_os("COMSPEC").unwrap(),
            source.join("host.exe"),
        )
        .unwrap();
        fs::write(
            source.join("response.jsonl"),
            b"{\"protocolVersion\":1,\"requestId\":\"request-1\",\"ok\":true,\"result\":{\"value\":42}}\r\n",
        )
        .unwrap();

        state.install(&source).unwrap();
        let installed_host = state.version_path(ID, "1.0.0").unwrap().join("host.exe");
        assert!(installed_host.is_file());

        let enabled = state.set_enabled(ID, true).unwrap();
        assert_eq!(enabled["enabled"], true);
        assert_eq!(enabled["state"], "starting");
        let runtime_id = state.contributions("window-a").unwrap()[0]["runtimeId"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(
            state
                .invoke_sidecar(
                    ID,
                    &runtime_id,
                    "request-1",
                    "example.echo",
                    &Value::Null,
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_millis() as u64
                        + 5_000,
                )
                .unwrap()
                .unwrap()["value"],
            42
        );

        let disabled = state.set_enabled(ID, false).unwrap();
        assert_eq!(disabled["enabled"], false);
        assert_eq!(disabled["state"], "disabled");
    }

    #[cfg(windows)]
    #[test]
    fn packaged_sidecar_activation_failure_releases_the_child_process() {
        use std::process::Command;
        use std::time::{Duration, Instant};

        let f = Fixture::new();
        let state = state(&f);
        let source = f.package("1.0.0");
        let lock_path = f.0.join("sidecar.lock");
        let host_source = f.0.join("fixture.rs");
        fs::write(
            &host_source,
            r#"use std::fs::OpenOptions;
use std::io::{self, Read};
use std::os::windows::fs::OpenOptionsExt;
fn main() {
    let path = std::env::args().nth(1).unwrap();
    let _lock = OpenOptions::new().write(true).create(true).share_mode(0).open(path).unwrap();
    let mut input = Vec::new();
    io::stdin().read_to_end(&mut input).unwrap();
}"#,
        )
        .unwrap();
        let compilation = Command::new("rustc")
            .arg("--crate-name=wstudio_sidecar_fixture")
            .arg(&host_source)
            .arg("-o")
            .arg(source.join("host.exe"))
            .output()
            .unwrap();
        assert!(
            compilation.status.success(),
            "{}",
            String::from_utf8_lossy(&compilation.stderr)
        );
        let mut value = manifest("1.0.0");
        value["permissions"] = json!([]);
        value["sidecar"] = json!({
            "type": "sidecar", "executable": "host.exe", "args": [lock_path]
        });
        write_manifest(&source, &value);
        state.install(&source).unwrap();
        state.set_enabled(ID, true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !lock_path.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(lock_path.exists(), "sidecar did not acquire its file lock");
        assert!(fs::OpenOptions::new().write(true).open(&lock_path).is_err());
        let contribution = state.contributions("window-a").unwrap();
        let runtime = contribution[0]["runtimeId"].as_str().unwrap();
        state.report_runtime(ID, runtime, "window-a", true).unwrap();
        assert_eq!(state.list().unwrap()[0]["state"], "crashed");
        assert!(state.authorize_runtime(ID, runtime, "window-a").is_err());
        assert!(
            fs::OpenOptions::new().write(true).open(&lock_path).is_ok(),
            "activation failure must stop and reap the sidecar child, releasing its file lock"
        );
    }

    #[test]
    fn corruption_redirected_registry_paths_and_tampered_packages_are_preserved() {
        let f = Fixture::new();
        let state = state(&f);
        state.install(&f.package("1.0.0")).unwrap();
        let path = state.root.join("registry.json");
        let original = fs::read(&path).unwrap();
        for content in [
            b"{broken".as_slice(),
            b"[]",
            b"{\"version\":2,\"plugins\":[]}",
        ] {
            fs::write(&path, content).unwrap();
            assert_eq!(state.list().unwrap_err(), "PLUGIN_REGISTRY_INVALID");
            assert_eq!(
                state.install(&f.package("2.0.0")).unwrap_err(),
                "PLUGIN_REGISTRY_INVALID"
            );
            assert_eq!(fs::read(&path).unwrap(), content);
        }
        fs::write(&path, &original).unwrap();
        let mut registry = state.read_registry().unwrap();
        registry.plugins[0].install_path = f.0.clone();
        fs::write(&path, serde_json::to_vec(&registry).unwrap()).unwrap();
        assert_eq!(state.list().unwrap_err(), "PLUGIN_REGISTRY_INVALID");
        fs::write(&path, &original).unwrap();
        let mut value = manifest("9.0.0");
        value["id"] = json!("com.example.other");
        write_manifest(&state.version_path(ID, "1.0.0").unwrap(), &value);
        assert_eq!(state.list().unwrap_err(), "PLUGIN_REGISTRY_INVALID");
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn registry_commit_failure_restores_staged_package_without_replacing_existing_files() {
        let f = Fixture::new();
        let state = state(&f);
        let source = f.package("1.0.0");
        let staged = stage(&source, &state.root.join("staging")).unwrap();
        let target = state.version_path(ID, "1.0.0").unwrap();
        fs::create_dir(state.root.join("registry.json")).unwrap();
        assert_eq!(
            state
                .commit_package(&staged, &target, &Registry::default())
                .unwrap_err(),
            "PLUGIN_REGISTRY_PATH_INVALID"
        );
        assert!(!target.exists());
        assert!(staged.path.join("main.js").exists());
        assert!(state.root.join("registry.json").is_dir());
    }

    #[cfg(windows)]
    #[test]
    fn uninstall_persist_failure_restores_all_versions_and_private_data() {
        let f = Fixture::new();
        let state = state(&f);
        state.install(&f.package("1.0.0")).unwrap();
        state.update(ID, &f.package("2.0.0")).unwrap();
        let data = state.root.join("data").join(ID);
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("value"), "keep").unwrap();
        let registry = state.root.join("registry.json");
        let before = fs::read(&registry).unwrap();
        let mut permissions = fs::metadata(&registry).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&registry, permissions).unwrap();
        let result = state.uninstall(ID);
        let mut permissions = fs::metadata(&registry).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&registry, permissions).unwrap();
        assert_eq!(result.unwrap_err(), "PLUGIN_REGISTRY_WRITE_FAILED");
        assert_eq!(fs::read(&registry).unwrap(), before);
        assert_eq!(fs::read_to_string(data.join("value")).unwrap(), "keep");
        assert!(state.version_path(ID, "1.0.0").unwrap().is_dir());
        assert!(state.version_path(ID, "2.0.0").unwrap().is_dir());
        assert_eq!(fs::read_dir(state.root.join("staging")).unwrap().count(), 0);
    }

    #[test]
    fn simultaneous_installations_commit_one_entry_and_clean_staging() {
        let f = Fixture::new();
        let state = std::sync::Arc::new(state(&f));
        let source = f.package("1.0.0");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let state = state.clone();
                let source = source.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    state.install(&source)
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|result| result.as_ref().err())
                .collect::<Vec<_>>(),
            vec!["PLUGIN_ALREADY_INSTALLED"]
        );
        assert_eq!(state.list().unwrap().len(), 1);
        assert_eq!(fs::read_dir(state.root.join("staging")).unwrap().count(), 0);
    }
}
