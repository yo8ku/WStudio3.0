//! Shared filesystem SDK routing with granted scopes, bounded traversal and revocable checkpoints.
use super::PluginFilesystemEntry;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

const MAX_VISITS: usize = 10_000;
const MAX_DEPTH: usize = 64;

/// Reuse native request DTOs while keeping plugin identity outside caller-controlled parameters.
fn request<T: DeserializeOwned>(
    manifest: &Value,
    params: &Value,
    keys: &[&str],
) -> Result<T, String> {
    let mut object = params
        .as_object()
        .cloned()
        .ok_or("PLUGIN_INVALID_ARGUMENT")?;
    if object.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    object.insert("pluginId".into(), manifest["id"].clone());
    serde_json::from_value(Value::Object(object)).map_err(|_| "PLUGIN_INVALID_ARGUMENT".into())
}

fn serialize(value: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|_| "PLUGIN_API_FAILED".into())
}

fn permission(manifest: &Value, id: &str) -> Result<(), String> {
    if super::plugin_permission_is_declared(manifest, id) {
        Ok(())
    } else {
        Err("PLUGIN_PERMISSION_NOT_DECLARED".into())
    }
}

fn scope(manifest: &Value, id: &str, relative: &str) -> Result<(), String> {
    permission(manifest, id)?;
    if super::plugin_path_has_permission(manifest, id, relative) {
        Ok(())
    } else {
        Err("PLUGIN_PERMISSION_SCOPE_VIOLATION".into())
    }
}

/// Canonical existing paths reject links and root escape; only metadata/list calls accept `.`.
fn existing(root: &Path, value: &str, allow_root: bool) -> Result<PathBuf, String> {
    if value == "." && allow_root {
        return Ok(root.to_path_buf());
    }
    super::resolve_plugin_existing_path(root, value)
}

fn relative(root: &Path, path: &Path) -> String {
    if path == root {
        ".".into()
    } else {
        super::relative_path(root, path)
    }
}

fn excluded(path: &Path) -> bool {
    path.file_name().is_some_and(|name| {
        let name = name.to_string_lossy();
        name.starts_with('.') || matches!(name.as_ref(), "dist" | "dist-electron" | "node_modules")
    })
}

/// A common traversal budget bounds queries and recursive mutation preflight.
struct Budget<'a> {
    remaining: usize,
    checkpoint: &'a dyn Fn() -> Result<(), String>,
}
impl Budget<'_> {
    fn visit(&mut self, depth: usize) -> Result<(), String> {
        (self.checkpoint)()?;
        if depth > MAX_DEPTH || self.remaining == 0 {
            return Err("PLUGIN_FILESYSTEM_TRAVERSAL_LIMIT_EXCEEDED".into());
        }
        self.remaining -= 1;
        Ok(())
    }
}

/// List sorted direct children without following links; hidden/tooling entries remain private.
fn children(
    path: &Path,
    budget: &mut Budget<'_>,
    depth: usize,
    hide: bool,
) -> Result<Vec<PathBuf>, String> {
    budget.visit(depth)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| "PLUGIN_FILESYSTEM_NOT_FOUND")?;
    if metadata.file_type().is_symlink() {
        return Err("PLUGIN_FILESYSTEM_SYMLINK_NOT_ALLOWED".into());
    }
    if !metadata.is_dir() {
        return Err("PLUGIN_FILESYSTEM_NOT_DIRECTORY".into());
    }
    let mut paths = Vec::new();
    for entry in fs::read_dir(path).map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")? {
        budget.visit(depth)?;
        let entry = entry.map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")?;
        if entry
            .file_type()
            .map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")?
            .is_symlink()
        {
            continue;
        }
        if !hide || !excluded(&entry.path()) {
            paths.push(entry.path());
        }
    }
    paths.sort();
    Ok(paths)
}

/// Directory metadata is visible when it or an actual descendant is within the granted scope.
fn visible_directory(
    root: &Path,
    manifest: &Value,
    path: &Path,
    budget: &mut Budget<'_>,
    depth: usize,
) -> Result<bool, String> {
    let name = relative(root, path);
    if super::plugin_path_has_permission(manifest, "workspace.read", &name)
        || super::plugin_path_has_permission(manifest, "workspace.read", &format!("{name}/"))
    {
        return Ok(true);
    }
    for child in children(path, budget, depth, true)? {
        let metadata = fs::symlink_metadata(&child).map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")?;
        if metadata.is_file()
            && super::plugin_path_has_permission(
                manifest,
                "workspace.read",
                &relative(root, &child),
            )
        {
            return Ok(true);
        }
        if metadata.is_dir() && visible_directory(root, manifest, &child, budget, depth + 1)? {
            return Ok(true);
        }
    }
    Ok(false)
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListOptions {
    directory: Option<String>,
    recursive: Option<bool>,
    extensions: Option<Vec<String>>,
    limit: Option<usize>,
}

/// Validate list options before traversal; extension comparison is ASCII case insensitive.
fn list_options(params: &Value) -> Result<ListOptions, String> {
    let object = params.as_object().ok_or("PLUGIN_INVALID_ARGUMENT")?;
    if object.keys().any(|key| key != "options") {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    let options: ListOptions =
        serde_json::from_value(object.get("options").cloned().unwrap_or(json!({})))
            .map_err(|_| "PLUGIN_INVALID_ARGUMENT")?;
    if options
        .limit
        .is_some_and(|limit| !(1..=2000).contains(&limit))
        || options.extensions.as_ref().is_some_and(|values| {
            values.len() > 128
                || values.iter().any(|value| {
                    let extension = value.strip_prefix('.').unwrap_or(value);
                    extension.is_empty()
                        || extension.len() > 32
                        || !extension
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                })
        })
    {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    Ok(options)
}

fn list_files(
    root: &Path,
    manifest: &Value,
    options: &ListOptions,
    budget: &mut Budget<'_>,
) -> Result<Value, String> {
    let directory = existing(root, options.directory.as_deref().unwrap_or("."), true)?;
    let limit = options.limit.unwrap_or(500);
    let mut entries = Vec::new();
    let mut stack = vec![(directory, 0)];
    let mut truncated = false;
    'scan: while let Some((directory, depth)) = stack.pop() {
        for child in children(&directory, budget, depth, true)? {
            let metadata =
                fs::symlink_metadata(&child).map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")?;
            if metadata.is_dir() && options.recursive.unwrap_or(false) {
                stack.push((child, depth + 1));
                continue;
            }
            let name = relative(root, &child);
            if !metadata.is_file()
                || !super::plugin_path_has_permission(manifest, "workspace.read", &name)
            {
                continue;
            }
            if let Some(extensions) = &options.extensions {
                let ext = child
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("");
                if !extensions
                    .iter()
                    .any(|value| value.trim_start_matches('.').eq_ignore_ascii_case(ext))
                {
                    continue;
                }
            }
            if entries.len() == limit {
                truncated = true;
                break 'scan;
            }
            entries.push(super::stat_plugin_filesystem_entry(root, &name)?);
        }
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    serialize(json!({ "entries": entries, "truncated": truncated }))
}

fn list_entries(
    root: &Path,
    manifest: &Value,
    directory: &str,
    budget: &mut Budget<'_>,
) -> Result<Vec<PluginFilesystemEntry>, String> {
    let directory = existing(root, directory, true)?;
    let mut entries = Vec::new();
    for child in children(&directory, budget, 0, true)? {
        let metadata = fs::symlink_metadata(&child).map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")?;
        let name = relative(root, &child);
        let allowed = if metadata.is_dir() {
            visible_directory(root, manifest, &child, budget, 1)?
        } else {
            metadata.is_file()
                && super::plugin_path_has_permission(manifest, "workspace.read", &name)
        };
        if allowed {
            entries.push(super::stat_plugin_filesystem_entry(root, &name)?);
        }
    }
    entries.sort_by(|left, right| {
        left.entry_type
            .cmp(right.entry_type)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(entries)
}

/// Recursive deletion verifies every affected path, including hidden children, before any deletion.
fn preflight_delete(
    root: &Path,
    manifest: &Value,
    path: &Path,
    budget: &mut Budget<'_>,
    depth: usize,
    approved: &mut std::collections::HashMap<PathBuf, String>,
) -> Result<(), String> {
    budget.visit(depth)?;
    scope(manifest, "workspace.write", &relative(root, path))?;
    let metadata = fs::symlink_metadata(path).map_err(|_| "PLUGIN_FILESYSTEM_NOT_FOUND")?;
    if metadata.file_type().is_symlink() {
        return Err("PLUGIN_FILESYSTEM_SYMLINK_NOT_ALLOWED".into());
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("PLUGIN_FILESYSTEM_TYPE_UNSUPPORTED".into());
    }
    approved.insert(path.to_path_buf(), super::plugin_path_identity(path)?);
    if metadata.is_dir() {
        // Unlike queries, destructive preflight rejects links instead of silently skipping them.
        for child in fs::read_dir(path).map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")? {
            preflight_delete(
                root,
                manifest,
                &child.map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")?.path(),
                budget,
                depth + 1,
                approved,
            )?;
        }
    }
    Ok(())
}

/// Dispatch all filesystem SDK methods through the same existing Rust filesystem primitives.
/// Delete one validated object at a time; late entries must pass scope checks too.
fn delete_tree(
    root: &Path,
    manifest: &Value,
    path: &Path,
    recursive: bool,
    approved: &std::collections::HashMap<PathBuf, String>,
    budget: &mut Budget<'_>,
    depth: usize,
) -> Result<(), String> {
    let parent = path.parent().ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?;
    let _pins = super::file_commit::pin_directories(root, parent)?;
    let identity = super::plugin_path_identity(path)?;
    budget.visit(depth)?;
    let name = relative(root, path);
    scope(manifest, "workspace.write", &name)?;
    if approved.get(path) != Some(&identity) {
        return Err("PLUGIN_WRITE_CONFLICT".into());
    }
    if existing(root, &name, false)? != path || super::plugin_path_identity(path)? != identity {
        return Err("PLUGIN_FILESYSTEM_PATH_INVALID".into());
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| "PLUGIN_FILESYSTEM_NOT_FOUND")?;
    let directory_pins = if metadata.is_dir() {
        Some(super::file_commit::pin_directories(root, path)?)
    } else {
        None
    };
    if metadata.is_dir() {
        let entries = {
            let mut entries = Vec::new();
            for entry in fs::read_dir(path).map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")? {
                entries.push(entry.map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")?.path());
                if entries.len() > budget.remaining {
                    return Err("PLUGIN_FILESYSTEM_TRAVERSAL_LIMIT_EXCEEDED".into());
                }
            }
            entries.sort();
            entries
        };
        if !recursive && !entries.is_empty() {
            return Err("PLUGIN_FILESYSTEM_DIRECTORY_NOT_EMPTY".into());
        }
        // Check all newly observed entries before beginning this level's deletion.
        for entry in &entries {
            scope(manifest, "workspace.write", &relative(root, entry))?;
            if approved.get(entry) != Some(&super::plugin_path_identity(entry)?) {
                return Err("PLUGIN_WRITE_CONFLICT".into());
            }
        }
        for entry in entries {
            delete_tree(
                root,
                manifest,
                &entry,
                recursive,
                approved,
                budget,
                depth + 1,
            )?;
        }
    } else if !metadata.is_file() {
        return Err("PLUGIN_FILESYSTEM_TYPE_UNSUPPORTED".into());
    }
    // Release only this node's handle; ancestor handles remain held through child removal.
    drop(directory_pins);
    (budget.checkpoint)()?;
    if existing(root, &name, false)? != path || super::plugin_path_identity(path)? != identity {
        return Err("PLUGIN_FILESYSTEM_PATH_INVALID".into());
    }
    let result = if metadata.is_dir() {
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    };
    result.map_err(|error| {
        if error.kind() == std::io::ErrorKind::DirectoryNotEmpty {
            "PLUGIN_FILESYSTEM_DIRECTORY_NOT_EMPTY".into()
        } else {
            "PLUGIN_FILESYSTEM_DELETE_FAILED".into()
        }
    })
}

pub(crate) fn invoke(
    root: &Path,
    manifest: &Value,
    method: &str,
    params: &Value,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    checkpoint()?;
    if !matches!(
        method,
        "filesystem.listFiles"
            | "filesystem.listEntries"
            | "filesystem.stat"
            | "filesystem.readText"
            | "filesystem.writeText"
            | "filesystem.createFile"
            | "filesystem.createDirectory"
            | "filesystem.delete"
            | "filesystem.move"
            | "filesystem.copy"
            | "filesystem.rename"
            | "filesystem.encrypt"
            | "filesystem.decrypt"
    ) {
        return Err("PLUGIN_API_UNAVAILABLE".into());
    }
    let read = matches!(
        method,
        "filesystem.listFiles"
            | "filesystem.listEntries"
            | "filesystem.stat"
            | "filesystem.readText"
            | "filesystem.copy"
            | "filesystem.encrypt"
            | "filesystem.decrypt"
    );
    if read {
        permission(manifest, "workspace.read")?;
    }
    let mutation = !matches!(
        method,
        "filesystem.listFiles"
            | "filesystem.listEntries"
            | "filesystem.stat"
            | "filesystem.readText"
    );
    if mutation {
        permission(manifest, "workspace.write")?;
    }
    let _mutation_lock = if mutation {
        Some(super::workspace_lock::acquire(root, checkpoint)?)
    } else {
        None
    };
    let mut budget = Budget {
        remaining: MAX_VISITS,
        checkpoint,
    };
    let result = match method {
        "filesystem.listFiles" => list_files(root, manifest, &list_options(params)?, &mut budget),
        "filesystem.listEntries" => {
            let request: super::PluginFilesystemListEntriesRequest =
                request(manifest, params, &["directory"])?;
            serialize(list_entries(
                root,
                manifest,
                request.directory.as_deref().unwrap_or("."),
                &mut budget,
            )?)
        }
        "filesystem.stat" | "filesystem.readText" => {
            let request: super::PluginWorkspacePathRequest = request(manifest, params, &["path"])?;
            let path = existing(root, &request.path, method == "filesystem.stat")?;
            if method == "filesystem.stat" && path.is_dir() {
                if !visible_directory(root, manifest, &path, &mut budget, 0)? {
                    return Err("PLUGIN_PERMISSION_SCOPE_VIOLATION".into());
                }
            } else {
                scope(manifest, "workspace.read", &relative(root, &path))?;
            }
            if method == "filesystem.stat" {
                serialize(super::stat_plugin_filesystem_entry(
                    root,
                    &relative(root, &path),
                )?)
            } else {
                serialize(super::read_plugin_text_file(root, &relative(root, &path))?)
            }
        }
        "filesystem.writeText" => {
            let request: super::PluginFilesystemWriteTextRequest =
                request(manifest, params, &["path", "content", "options"])?;
            let path = existing(root, &request.path, false)?;
            scope(manifest, "workspace.write", &relative(root, &path))?;
            checkpoint()?;
            serialize(super::write_plugin_text_file_checked(
                root,
                &request.path,
                &request.content,
                &request.options.expected_content,
                checkpoint,
            )?)
        }
        "filesystem.createFile" => {
            let request: super::PluginFilesystemCreateFileRequest =
                request(manifest, params, &["path", "content"])?;
            let path = super::resolve_plugin_new_path(root, &request.path)?;
            scope(manifest, "workspace.write", &relative(root, &path))?;
            checkpoint()?;
            serialize(super::create_plugin_text_file_checked(
                root,
                &request.path,
                request.content.as_deref().unwrap_or(""),
                checkpoint,
            )?)
        }
        "filesystem.createDirectory" => {
            let request: super::PluginFilesystemCreateDirectoryRequest =
                request(manifest, params, &["path", "options"])?;
            let mut target = root.to_path_buf();
            for component in super::plugin_relative_components(&request.path)? {
                target.push(component);
                match fs::symlink_metadata(&target) {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        return Err("PLUGIN_FILESYSTEM_SYMLINK_NOT_ALLOWED".into())
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        scope(manifest, "workspace.write", &relative(root, &target))?
                    }
                    Err(_) => return Err("PLUGIN_FILESYSTEM_READ_FAILED".into()),
                }
            }
            scope(manifest, "workspace.write", &relative(root, &target))?;
            checkpoint()?;
            serialize(super::create_plugin_directory_checked(
                root,
                &request.path,
                request
                    .options
                    .and_then(|options| options.recursive)
                    .unwrap_or(false),
                checkpoint,
            )?)
        }
        "filesystem.delete" => {
            let request: super::PluginFilesystemDeleteRequest =
                request(manifest, params, &["path", "options"])?;
            if request.path == "." {
                return Err("PLUGIN_FILESYSTEM_ROOT_PROTECTED".into());
            }
            let path = existing(root, &request.path, false)?;
            if path == root {
                return Err("PLUGIN_FILESYSTEM_ROOT_PROTECTED".into());
            }
            let mut approved = std::collections::HashMap::new();
            preflight_delete(root, manifest, &path, &mut budget, 0, &mut approved)?;
            delete_tree(
                root,
                manifest,
                &path,
                request
                    .options
                    .and_then(|options| options.recursive)
                    .unwrap_or(false),
                &approved,
                &mut Budget {
                    remaining: MAX_VISITS,
                    checkpoint,
                },
                0,
            )?;
            Ok(Value::Null)
        }
        "filesystem.move" => {
            let request: super::PluginFilesystemTransferRequest =
                request(manifest, params, &["sourcePath", "destinationPath"])?;
            serialize(super::move_plugin_path_checked(
                root,
                manifest,
                &request.source_path,
                &request.destination_path,
                checkpoint,
            )?)
        }
        "filesystem.copy" => {
            let request: super::PluginFilesystemCopyRequest = request(
                manifest,
                params,
                &["sourcePath", "destinationPath", "options"],
            )?;
            serialize(super::copy_plugin_path_checked(
                root,
                manifest,
                &request.source_path,
                &request.destination_path,
                request
                    .options
                    .and_then(|options| options.recursive)
                    .unwrap_or(false),
                checkpoint,
            )?)
        }
        "filesystem.rename" => {
            let request: super::PluginFilesystemRenameRequest =
                request(manifest, params, &["path", "newName"])?;
            if request.new_name.trim().is_empty()
                || matches!(request.new_name.as_str(), "." | "..")
                || request.new_name.contains(['/', '\\'])
            {
                return Err("PLUGIN_INVALID_ARGUMENT".into());
            }
            let source = existing(root, &request.path, false)?;
            let parent = source.parent().ok_or("PLUGIN_FILESYSTEM_ROOT_PROTECTED")?;
            let destination = parent.join(request.new_name);
            serialize(super::move_plugin_path_checked(
                root,
                manifest,
                &relative(root, &source),
                &relative(root, &destination),
                checkpoint,
            )?)
        }
        "filesystem.encrypt" | "filesystem.decrypt" => {
            let request: super::PluginFilesystemProtectionRequest =
                request(manifest, params, &["path", "password"])?;
            let path = existing(root, &request.path, false)?;
            for id in ["workspace.read", "workspace.write"] {
                scope(manifest, id, &relative(root, &path))?;
            }
            serialize(super::protect_plugin_file_checked(
                root,
                &request.path,
                &request.password,
                method == "filesystem.encrypt",
                checkpoint,
            )?)
        }
        _ => Err("PLUGIN_API_UNAVAILABLE".into()),
    }?;
    checkpoint()?;
    Ok(result)
}

/// Storage uses the same JSON presence DTO so missing keys and a stored null stay distinct.
pub(crate) fn storage(
    path: &Path,
    manifest: &Value,
    method: &str,
    params: &Value,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    checkpoint()?;
    let request: super::PluginStorageSetRequest = if method == "storage.set" {
        if params.get("value").is_none() {
            return Err("PLUGIN_INVALID_ARGUMENT".into());
        }
        request(manifest, params, &["key", "value"])?
    } else {
        let key: super::PluginStorageKeyRequest = request(manifest, params, &["key"])?;
        super::PluginStorageSetRequest {
            plugin_id: key.plugin_id,
            key: key.key,
            value: Value::Null,
        }
    };
    super::validate_plugin_storage_request(
        manifest,
        &request.key,
        (method == "storage.set").then_some(&request.value),
    )?;
    if method == "storage.get" {
        let result = super::get_plugin_storage_value(path, &request.key)?;
        checkpoint()?;
        return serialize(result);
    }
    if !matches!(method, "storage.set" | "storage.delete") {
        return Err("PLUGIN_API_UNAVAILABLE".into());
    }
    checkpoint()?;
    super::update_plugin_storage_value_checked(
        path,
        request.key,
        (method == "storage.set").then_some(request.value),
        checkpoint,
    )?;
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("wstudio-filesystem-rpc-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self(root.canonicalize().unwrap())
        }
        fn put(&self, name: &str, text: &str) {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        fn call(&self, manifest: &Value, method: &str, params: Value) -> Result<Value, String> {
            invoke(&self.0, manifest, method, &params, &|| Ok(()))
        }
        fn staged_write(&self) -> bool {
            fs::read_dir(&self.0).unwrap().any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".wstudio-write-")
            })
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn manifest() -> Value {
        json!({ "id": "com.example.filesystem", "permissions": [
            { "id": "workspace.read" }, { "id": "workspace.write" }, { "id": "storage.plugin" }
        ] })
    }

    #[test]
    fn sdk_routes_read_create_compare_write_stat_and_directory_creation() {
        let fixture = Fixture::new();
        let manifest = manifest();
        fixture
            .call(
                &manifest,
                "filesystem.createDirectory",
                json!({"path":"notes/deep","options":{"recursive":true}}),
            )
            .unwrap();
        let created = fixture
            .call(
                &manifest,
                "filesystem.createFile",
                json!({"path":"notes/deep/note.md","content":"first"}),
            )
            .unwrap();
        assert_eq!(created["path"], "notes/deep/note.md");
        assert_eq!(created["content"], "first");
        assert_eq!(
            fixture
                .call(
                    &manifest,
                    "filesystem.readText",
                    json!({"path":"notes/deep/note.md"})
                )
                .unwrap()["encoding"],
            "utf-8"
        );
        assert_eq!(fixture.call(&manifest, "filesystem.writeText", json!({"path":"notes/deep/note.md","content":"second","options":{"expectedContent":"wrong"}})).unwrap_err(), "PLUGIN_WRITE_CONFLICT");
        fixture.call(&manifest, "filesystem.writeText", json!({"path":"notes/deep/note.md","content":"second","options":{"expectedContent":"first"}})).unwrap();
        assert_eq!(
            fs::read_to_string(fixture.0.join("notes/deep/note.md")).unwrap(),
            "second"
        );
        assert_eq!(
            fixture
                .call(&manifest, "filesystem.stat", json!({"path":"."}))
                .unwrap()["type"],
            "directory"
        );
    }

    #[test]
    fn list_routes_filter_scopes_extensions_and_tooling_and_report_truncation() {
        let fixture = Fixture::new();
        for name in [
            "notes/a.md",
            "notes/b.MD",
            "notes/c.txt",
            "private/secret.md",
            "node_modules/pkg.md",
            ".hidden.md",
        ] {
            fixture.put(name, "text");
        }
        let manifest = json!({"id":"com.example.filesystem","permissions":[{"id":"workspace.read","scope":["notes/**"]}]});
        let entries = fixture
            .call(&manifest, "filesystem.listEntries", json!({}))
            .unwrap();
        assert_eq!(entries.as_array().unwrap().len(), 1);
        assert_eq!(entries[0]["path"], "notes");
        let list = fixture
            .call(
                &manifest,
                "filesystem.listFiles",
                json!({"options":{"recursive":true,"extensions":[".md"],"limit":1}}),
            )
            .unwrap();
        assert_eq!(list["entries"].as_array().unwrap().len(), 1);
        assert_eq!(list["truncated"], true);
        let list = fixture
            .call(
                &manifest,
                "filesystem.listFiles",
                json!({"options":{"directory":"notes","extensions":["MD"],"limit":2}}),
            )
            .unwrap();
        assert_eq!(list["entries"].as_array().unwrap().len(), 2);
        assert_eq!(list["truncated"], false);
        assert_eq!(
            fixture
                .call(&manifest, "filesystem.stat", json!({"path":"private"}))
                .unwrap_err(),
            "PLUGIN_PERMISSION_SCOPE_VIOLATION"
        );
        assert!(!list.to_string().contains(fixture.0.to_str().unwrap()));
    }

    #[test]
    fn scope_rejection_and_recursive_preflight_leave_denied_files_untouched() {
        let fixture = Fixture::new();
        fixture.put("allowed/a.md", "allowed");
        fixture.put("allowed/private.txt", "private");
        let manifest = json!({"id":"com.example.filesystem","permissions":[
            {"id":"workspace.read","scope":["allowed/*.md"]},
            {"id":"workspace.write","scope":["allowed","allowed/*.md"]}
        ]});
        for method in ["filesystem.readText", "filesystem.stat"] {
            assert_eq!(
                fixture
                    .call(&manifest, method, json!({"path":"allowed/private.txt"}))
                    .unwrap_err(),
                "PLUGIN_PERMISSION_SCOPE_VIOLATION"
            );
        }
        assert_eq!(
            fixture
                .call(
                    &manifest,
                    "filesystem.createFile",
                    json!({"path":"private.txt"})
                )
                .unwrap_err(),
            "PLUGIN_PERMISSION_SCOPE_VIOLATION"
        );
        assert_eq!(
            fixture
                .call(
                    &manifest,
                    "filesystem.delete",
                    json!({"path":"allowed","options":{"recursive":true}})
                )
                .unwrap_err(),
            "PLUGIN_PERMISSION_SCOPE_VIOLATION"
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join("allowed/a.md")).unwrap(),
            "allowed"
        );
        assert!(fixture.0.join("allowed/private.txt").is_file());
        assert_eq!(
            fixture
                .call(
                    &manifest,
                    "filesystem.createDirectory",
                    json!({"path":"allowed/new/deep","options":{"recursive":true}})
                )
                .unwrap_err(),
            "PLUGIN_PERMISSION_SCOPE_VIOLATION"
        );
        assert!(!fixture.0.join("allowed/new").exists());
    }

    #[test]
    fn move_copy_rename_and_delete_use_real_files_and_preserve_source_on_denial() {
        let fixture = Fixture::new();
        let manifest = manifest();
        fixture.put("source/note.md", "content");
        fixture.call(&manifest,"filesystem.copy",json!({"sourcePath":"source","destinationPath":"copy","options":{"recursive":true}})).unwrap();
        fixture
            .call(
                &manifest,
                "filesystem.rename",
                json!({"path":"copy/note.md","newName":"renamed.md"}),
            )
            .unwrap();
        fixture
            .call(
                &manifest,
                "filesystem.move",
                json!({"sourcePath":"copy/renamed.md","destinationPath":"moved.md"}),
            )
            .unwrap();
        assert_eq!(
            fs::read_to_string(fixture.0.join("moved.md")).unwrap(),
            "content"
        );
        let restricted = json!({"id":"com.example.filesystem","permissions":[{"id":"workspace.write","scope":["source/**"]}]});
        assert_eq!(
            fixture
                .call(
                    &restricted,
                    "filesystem.move",
                    json!({"sourcePath":"source/note.md","destinationPath":"denied.md"})
                )
                .unwrap_err(),
            "PLUGIN_PERMISSION_SCOPE_VIOLATION"
        );
        assert!(fixture.0.join("source/note.md").is_file());
        fixture
            .call(
                &manifest,
                "filesystem.delete",
                json!({"path":"copy","options":{"recursive":true}}),
            )
            .unwrap();
        fixture
            .call(&manifest, "filesystem.delete", json!({"path":"moved.md"}))
            .unwrap();
        assert!(!fixture.0.join("copy").exists() && !fixture.0.join("moved.md").exists());
        assert_eq!(
            fixture
                .call(&manifest, "filesystem.delete", json!({"path":"."}))
                .unwrap_err(),
            "PLUGIN_FILESYSTEM_ROOT_PROTECTED"
        );
    }

    #[test]
    fn copy_rechecks_entries_added_after_preflight_and_never_overwrites_new_targets() {
        let fixture = Fixture::new();
        fixture.put("source/public.md", "public");
        let restricted = json!({"id":"com.example.filesystem","permissions":[
            {"id":"workspace.read","scope":["source","source/*.md"]},
            {"id":"workspace.write","scope":["copy","copy/**"]}
        ]});
        let calls = Cell::new(0);
        let result = super::super::copy_plugin_path_checked(
            &fixture.0,
            &restricted,
            "source",
            "copy",
            true,
            &|| {
                calls.set(calls.get() + 1);
                if calls.get() == 3 {
                    fixture.put("source/private.txt", "private");
                }
                Ok(())
            },
        );
        assert_eq!(result.unwrap_err(), "PLUGIN_PERMISSION_SCOPE_VIOLATION");
        assert!(!fixture.0.join("copy").exists());
        assert!(!fixture.0.join("copy/private.txt").exists());
        assert_eq!(
            fs::read_to_string(fixture.0.join("source/private.txt")).unwrap(),
            "private"
        );

        calls.set(0);
        let result = super::super::copy_plugin_path_checked(
            &fixture.0,
            &manifest(),
            "source/public.md",
            "occupied.md",
            false,
            &|| {
                calls.set(calls.get() + 1);
                if calls.get() == 2 {
                    fixture.put("occupied.md", "external data");
                }
                Ok(())
            },
        );
        assert_eq!(result.unwrap_err(), "PLUGIN_FILESYSTEM_ALREADY_EXISTS");
        assert_eq!(
            fs::read_to_string(fixture.0.join("occupied.md")).unwrap(),
            "external data"
        );
        let mut remaining = 0;
        let mut created_paths = Vec::new();
        assert_eq!(
            super::super::copy_plugin_tree(
                &fixture.0,
                &manifest(),
                &fixture.0.join("source/public.md"),
                &fixture.0.join("budget.md"),
                &|| Ok(()),
                &mut remaining,
                0,
                &mut created_paths,
            )
            .unwrap_err(),
            "PLUGIN_FILESYSTEM_TRAVERSAL_LIMIT_EXCEEDED"
        );
        assert!(!fixture.0.join("budget.md").exists());
    }

    #[test]
    fn failed_recursive_copy_rolls_back_only_paths_created_by_the_operation() {
        let fixture = Fixture::new();
        fixture.put("source/first.md", "first");
        fixture.put("source/second.md", "second");
        let manifest = manifest();
        let calls = Cell::new(0);
        let result = super::super::copy_plugin_path_checked(
            &fixture.0,
            &manifest,
            "source",
            "copy",
            true,
            &|| {
                calls.set(calls.get() + 1);
                if calls.get() == 9 {
                    fixture.put("copy/external.md", "external");
                    return Err("PLUGIN_REQUEST_TIMEOUT".into());
                }
                Ok(())
            },
        );
        assert_eq!(result.unwrap_err(), "PLUGIN_REQUEST_TIMEOUT");
        assert!(!fixture.0.join("copy/first.md").exists());
        assert!(!fixture.0.join("copy/second.md").exists());
        assert_eq!(
            fs::read_to_string(fixture.0.join("copy/external.md")).unwrap(),
            "external"
        );
    }

    #[test]
    fn transfer_rejects_source_replacement_after_scope_preflight() {
        let fixture = Fixture::new();
        fixture.put("source.md", "original");
        let calls = Cell::new(0);
        let result = super::super::move_plugin_path_checked(
            &fixture.0,
            &manifest(),
            "source.md",
            "moved.md",
            &|| {
                calls.set(calls.get() + 1);
                if calls.get() == 2 {
                    fs::rename(fixture.0.join("source.md"), fixture.0.join("old.md")).unwrap();
                    fixture.put("source.md", "original");
                }
                Ok(())
            },
        );
        assert_eq!(result.unwrap_err(), "PLUGIN_FILESYSTEM_PATH_INVALID");
        assert_eq!(
            fs::read_to_string(fixture.0.join("old.md")).unwrap(),
            "original"
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join("source.md")).unwrap(),
            "original"
        );
        assert!(!fixture.0.join("moved.md").exists());
    }

    #[test]
    fn copy_rejects_same_content_source_replacement_during_preflight_and_execution() {
        for replace_at in [1, 2, 3] {
            let fixture = Fixture::new();
            fixture.put("source.md", "same content");
            let calls = Cell::new(0);
            let result = super::super::copy_plugin_path_checked(
                &fixture.0,
                &manifest(),
                "source.md",
                "copy.md",
                false,
                &|| {
                    calls.set(calls.get() + 1);
                    if calls.get() == replace_at {
                        fs::rename(fixture.0.join("source.md"), fixture.0.join("old.md")).unwrap();
                        fixture.put("source.md", "same content");
                    }
                    Ok(())
                },
            );
            assert_eq!(result.unwrap_err(), "PLUGIN_FILESYSTEM_PATH_INVALID");
            assert!(!fixture.0.join("copy.md").exists());
            assert_eq!(
                fs::read_to_string(fixture.0.join("old.md")).unwrap(),
                "same content"
            );
            assert_eq!(
                fs::read_to_string(fixture.0.join("source.md")).unwrap(),
                "same content"
            );
        }
    }

    #[test]
    fn transfers_preserve_replaced_destination_parents() {
        for copy in [false, true] {
            let fixture = Fixture::new();
            fixture.put("source.md", "source");
            fs::create_dir(fixture.0.join("target")).unwrap();
            let calls = Cell::new(0);
            let blocked = Cell::new(false);
            let checkpoint = || {
                calls.set(calls.get() + 1);
                if calls.get() == 2 {
                    let renamed =
                        fs::rename(fixture.0.join("target"), fixture.0.join("old-target"));
                    #[cfg(windows)]
                    {
                        assert!(renamed.is_err());
                        blocked.set(true);
                        return Err("PLUGIN_REQUEST_TIMEOUT".into());
                    }
                    #[cfg(not(windows))]
                    renamed.unwrap();
                    #[cfg(not(windows))]
                    fs::create_dir(fixture.0.join("target")).unwrap();
                    #[cfg(not(windows))]
                    fixture.put("target/external.md", "external");
                }
                Ok(())
            };
            let result = if copy {
                super::super::copy_plugin_path_checked(
                    &fixture.0,
                    &manifest(),
                    "source.md",
                    "target/new.md",
                    false,
                    &checkpoint,
                )
            } else {
                super::super::move_plugin_path_checked(
                    &fixture.0,
                    &manifest(),
                    "source.md",
                    "target/new.md",
                    &checkpoint,
                )
            };
            assert_eq!(
                result.unwrap_err(),
                if blocked.get() {
                    "PLUGIN_REQUEST_TIMEOUT"
                } else {
                    "PLUGIN_FILESYSTEM_PATH_INVALID"
                }
            );
            assert!(fixture.0.join("source.md").is_file());
            assert!(!fixture.0.join("target/new.md").exists());
            assert!(!fixture.0.join("old-target/new.md").exists());
            if !blocked.get() {
                assert_eq!(
                    fs::read_to_string(fixture.0.join("target/external.md")).unwrap(),
                    "external"
                );
            }
        }
    }

    #[test]
    fn copy_rollback_preserves_external_replacements_of_created_paths() {
        let fixture = Fixture::new();
        fixture.put("source/a.md", "a");
        fixture.put("source/b.md", "b");
        let replaced = Cell::new(false);
        let result = super::super::copy_plugin_path_checked(
            &fixture.0,
            &manifest(),
            "source",
            "copy",
            true,
            &|| {
                for name in ["a.md", "b.md"] {
                    let copied = fixture.0.join("copy").join(name);
                    if copied.is_file() && !replaced.replace(true) {
                        fs::rename(&copied, fixture.0.join("saved.md")).unwrap();
                        fs::write(&copied, "external").unwrap();
                        return Err("PLUGIN_REQUEST_TIMEOUT".into());
                    }
                }
                Ok(())
            },
        );
        assert!(replaced.get());
        assert_eq!(result.unwrap_err(), "PLUGIN_REQUEST_TIMEOUT");
        let retained: Vec<_> = fs::read_dir(fixture.0.join("copy")).unwrap().collect();
        assert_eq!(retained.len(), 1);
        assert_eq!(
            fs::read_to_string(retained[0].as_ref().unwrap().path()).unwrap(),
            "external"
        );
        assert!(fixture.0.join("saved.md").is_file());
    }

    #[test]
    fn malformed_parameters_and_paths_do_not_reach_filesystem_mutations() {
        let fixture = Fixture::new();
        let manifest = manifest();
        fixture.put("note.md", "text");
        for options in [
            json!({"limit":0}),
            json!({"limit":2001}),
            json!({"limit":1.5}),
            json!({"recursive":"yes"}),
            json!({"extensions":["../md"]}),
            json!({"extensions":[""]}),
        ] {
            assert_eq!(
                fixture
                    .call(
                        &manifest,
                        "filesystem.listFiles",
                        json!({"options":options})
                    )
                    .unwrap_err(),
                "PLUGIN_INVALID_ARGUMENT"
            );
        }
        for params in [
            json!({"path":"note.md","pluginId":"com.other.plugin"}),
            json!({"path":false}),
            json!({"path":"note.md","window":"other"}),
        ] {
            assert_eq!(
                fixture
                    .call(&manifest, "filesystem.readText", params)
                    .unwrap_err(),
                "PLUGIN_INVALID_ARGUMENT"
            );
        }
        for path in ["../note.md", fixture.0.join("note.md").to_str().unwrap()] {
            assert_eq!(
                fixture
                    .call(&manifest, "filesystem.readText", json!({"path":path}))
                    .unwrap_err(),
                "PLUGIN_FILESYSTEM_PATH_INVALID"
            );
        }
        assert_eq!(
            fixture
                .call(
                    &json!({"id":"com.example.filesystem"}),
                    "filesystem.readText",
                    json!({"path":"note.md"})
                )
                .unwrap_err(),
            "PLUGIN_PERMISSION_NOT_DECLARED"
        );
        assert_eq!(
            fixture
                .call(&manifest, "filesystem.unknown", json!({}))
                .unwrap_err(),
            "PLUGIN_API_UNAVAILABLE"
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join("note.md")).unwrap(),
            "text"
        );
    }

    #[test]
    fn traversal_budget_and_expired_owner_stop_queries_and_mutations() {
        let fixture = Fixture::new();
        let manifest = manifest();
        fixture.put("a.md", "text");
        let mut budget = Budget {
            remaining: 1,
            checkpoint: &|| Ok(()),
        };
        assert_eq!(
            children(&fixture.0, &mut budget, 0, true).unwrap_err(),
            "PLUGIN_FILESYSTEM_TRAVERSAL_LIMIT_EXCEEDED"
        );
        for method in [
            "filesystem.listFiles",
            "filesystem.delete",
            "filesystem.copy",
        ] {
            let params = match method {
                "filesystem.copy" => json!({"sourcePath":"a.md","destinationPath":"copy.md"}),
                "filesystem.delete" => json!({"path":"a.md"}),
                _ => json!({}),
            };
            assert_eq!(
                invoke(&fixture.0, &manifest, method, &params, &|| Err(
                    "PLUGIN_RUNTIME_TERMINATED".into()
                ))
                .unwrap_err(),
                "PLUGIN_RUNTIME_TERMINATED"
            );
        }
        assert!(fixture.0.join("a.md").is_file() && !fixture.0.join("copy.md").exists());
        let calls = Cell::new(0);
        assert_eq!(
            invoke(
                &fixture.0,
                &manifest,
                "filesystem.move",
                &json!({"sourcePath":"a.md","destinationPath":"moved.md"}),
                &|| {
                    calls.set(calls.get() + 1);
                    if calls.get() >= 3 {
                        Err("PLUGIN_REQUEST_TIMEOUT".into())
                    } else {
                        Ok(())
                    }
                }
            )
            .unwrap_err(),
            "PLUGIN_REQUEST_TIMEOUT"
        );
        assert!(fixture.0.join("a.md").is_file() && !fixture.0.join("moved.md").exists());
    }

    #[test]
    fn encryption_checkpoint_rejects_late_revocation_and_external_changes() {
        let fixture = Fixture::new();
        let manifest = manifest();
        fixture.put("secret.bin", "plaintext");
        let staged = Cell::new(false);
        let result = invoke(
            &fixture.0,
            &manifest,
            "filesystem.encrypt",
            &json!({"path":"secret.bin","password":"passphrase"}),
            &|| {
                if fixture.staged_write() {
                    staged.set(true);
                    Err("PLUGIN_RUNTIME_TERMINATED".into())
                } else {
                    Ok(())
                }
            },
        );
        assert_eq!(result.unwrap_err(), "PLUGIN_RUNTIME_TERMINATED");
        assert!(staged.get());
        assert!(!fixture.staged_write());
        assert_eq!(
            fs::read_to_string(fixture.0.join("secret.bin")).unwrap(),
            "plaintext"
        );
        let changed = Cell::new(false);
        let result = invoke(
            &fixture.0,
            &manifest,
            "filesystem.encrypt",
            &json!({"path":"secret.bin","password":"passphrase"}),
            &|| {
                if fixture.staged_write() && !changed.replace(true) {
                    fs::write(fixture.0.join("secret.bin"), "external change").unwrap();
                }
                Ok(())
            },
        );
        assert_eq!(result.unwrap_err(), "PLUGIN_WRITE_CONFLICT");
        assert!(changed.get());
        assert!(!fixture.staged_write());
        assert_eq!(
            fs::read_to_string(fixture.0.join("secret.bin")).unwrap(),
            "external change"
        );
    }

    #[test]
    fn text_and_markdown_routes_recheck_staged_writes_and_revocation() {
        let fixture = Fixture::new();
        for markdown in [false, true] {
            for revoke in [false, true] {
                fixture.put("note.md", "original");
                let reached_stage = Cell::new(false);
                let checkpoint = || {
                    if fixture.staged_write() && !reached_stage.replace(true) {
                        assert_eq!(
                            fs::read_to_string(fixture.0.join("note.md")).unwrap(),
                            "original"
                        );
                        if revoke {
                            return Err("PLUGIN_RUNTIME_TERMINATED".into());
                        }
                        fs::write(fixture.0.join("note.md"), "external").unwrap();
                    }
                    Ok(())
                };
                if markdown {
                    let result = super::super::update_markdown_at_root(
                        &fixture.0,
                        super::super::UpdateMarkdownRequest {
                            path: "note.md".into(),
                            expected_content: "original".into(),
                            content: "saved".into(),
                        },
                        &checkpoint,
                    );
                    if revoke {
                        assert_eq!(result.unwrap_err(), "PLUGIN_RUNTIME_TERMINATED");
                    } else {
                        assert!(
                            matches!(result.unwrap(), super::super::UpdateMarkdownResult::Conflict {file} if file.content == "external")
                        );
                    }
                } else {
                    let result = invoke(
                        &fixture.0,
                        &manifest(),
                        "filesystem.writeText",
                        &json!({"path":"note.md","content":"saved","options":{"expectedContent":"original"}}),
                        &checkpoint,
                    );
                    assert_eq!(
                        result.unwrap_err(),
                        if revoke {
                            "PLUGIN_RUNTIME_TERMINATED"
                        } else {
                            "PLUGIN_WRITE_CONFLICT"
                        }
                    );
                }
                assert!(reached_stage.get());
                assert!(!fixture.staged_write());
                assert_eq!(
                    fs::read_to_string(fixture.0.join("note.md")).unwrap(),
                    if revoke { "original" } else { "external" }
                );
            }
        }
    }

    #[test]
    fn creation_revoked_after_staging_never_publishes_a_partial_target() {
        let fixture = Fixture::new();
        let observed = Cell::new(false);
        let result = invoke(
            &fixture.0,
            &manifest(),
            "filesystem.createFile",
            &json!({"path":"new.md","content":"complete"}),
            &|| {
                if fixture.staged_write() {
                    observed.set(true);
                    assert!(!fixture.0.join("new.md").exists());
                    return Err("PLUGIN_RUNTIME_TERMINATED".into());
                }
                Ok(())
            },
        );
        assert_eq!(result.unwrap_err(), "PLUGIN_RUNTIME_TERMINATED");
        assert!(observed.get());
        assert!(!fixture.0.join("new.md").exists());
        assert!(!fixture.staged_write());
    }

    #[test]
    fn creation_preserves_a_destination_created_after_staging() {
        let fixture = Fixture::new();
        let injected = Cell::new(false);
        let result = invoke(
            &fixture.0,
            &manifest(),
            "filesystem.createFile",
            &json!({"path":"new.md","content":"complete"}),
            &|| {
                if fixture.staged_write() && !injected.replace(true) {
                    fixture.put("new.md", "external");
                }
                Ok(())
            },
        );
        assert_eq!(result.unwrap_err(), "PLUGIN_FILESYSTEM_ALREADY_EXISTS");
        assert!(injected.get());
        assert_eq!(
            fs::read_to_string(fixture.0.join("new.md")).unwrap(),
            "external"
        );
        assert!(!fixture.staged_write());
    }

    #[cfg(windows)]
    #[test]
    fn transfer_pins_both_parent_chains_at_commit_checkpoints() {
        for copy in [false, true] {
            let fixture = Fixture::new();
            fixture.put("from/nested/a.md", "original");
            fs::create_dir_all(fixture.0.join("to/nested")).unwrap();
            let checks = Cell::new(0);
            let checkpoint = || {
                checks.set(checks.get() + 1);
                assert!(
                    fs::rename(fixture.0.join("from"), fixture.0.join("renamed-from")).is_err()
                );
                assert!(fs::rename(fixture.0.join("to"), fixture.0.join("renamed-to")).is_err());
                Ok(())
            };
            let result = if copy {
                super::super::copy_plugin_path_checked(
                    &fixture.0,
                    &manifest(),
                    "from/nested/a.md",
                    "to/nested/a.md",
                    false,
                    &checkpoint,
                )
            } else {
                super::super::move_plugin_path_checked(
                    &fixture.0,
                    &manifest(),
                    "from/nested/a.md",
                    "to/nested/a.md",
                    &checkpoint,
                )
            };
            result.unwrap();
            assert!(checks.get() > 0);
            assert_eq!(
                fs::read_to_string(fixture.0.join("to/nested/a.md")).unwrap(),
                "original"
            );
            fs::rename(fixture.0.join("to"), fixture.0.join("renamed-to")).unwrap();
        }
    }

    #[test]
    fn deletion_rechecks_scope_for_entries_added_after_preflight() {
        let fixture = Fixture::new();
        fixture.put("tree/allowed.md", "allowed");
        let manifest = json!({"id":"com.example.filesystem","permissions":[{"id":"workspace.write","scope":["tree","tree/*.md"]}]});
        let checks = Cell::new(0);
        let injected = Cell::new(false);
        let result = invoke(
            &fixture.0,
            &manifest,
            "filesystem.delete",
            &json!({"path":"tree","options":{"recursive":true}}),
            &|| {
                checks.set(checks.get() + 1);
                // Initial lock/dispatch checkpoints plus the root and child preflight checks.
                if checks.get() == 7 && !injected.replace(true) {
                    fixture.put("tree/private.bin", "external");
                }
                Ok(())
            },
        );
        assert!(injected.get());
        assert_eq!(result.unwrap_err(), "PLUGIN_PERMISSION_SCOPE_VIOLATION");
        assert_eq!(
            fs::read_to_string(fixture.0.join("tree/private.bin")).unwrap(),
            "external"
        );
    }

    #[test]
    fn deletion_preserves_an_object_replaced_after_preflight() {
        let fixture = Fixture::new();
        fixture.put("tree/approved.md", "original");
        let checks = Cell::new(0);
        let changed = Cell::new(false);
        let result = invoke(
            &fixture.0,
            &manifest(),
            "filesystem.delete",
            &json!({"path":"tree","options":{"recursive":true}}),
            &|| {
                checks.set(checks.get() + 1);
                if checks.get() == 7 && !changed.replace(true) {
                    fs::rename(
                        fixture.0.join("tree/approved.md"),
                        fixture.0.join("previous.md"),
                    )
                    .unwrap();
                    fixture.put("tree/approved.md", "external");
                }
                Ok(())
            },
        );
        assert!(changed.get());
        assert_eq!(result.unwrap_err(), "PLUGIN_WRITE_CONFLICT");
        assert_eq!(
            fs::read_to_string(fixture.0.join("tree/approved.md")).unwrap(),
            "external"
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join("previous.md")).unwrap(),
            "original"
        );
    }

    #[cfg(windows)]
    #[test]
    fn streamed_copy_keeps_source_bytes_stable_until_publication() {
        let fixture = Fixture::new();
        fixture.put("source.md", "original");
        let observed = Cell::new(false);
        fixture
            .call(
                &manifest(),
                "filesystem.readText",
                json!({"path":"source.md"}),
            )
            .unwrap();
        invoke(
            &fixture.0,
            &manifest(),
            "filesystem.copy",
            &json!({"sourcePath":"source.md","destinationPath":"copy.md"}),
            &|| {
                if fixture.staged_write() {
                    observed.set(true);
                    assert!(fs::write(fixture.0.join("source.md"), "external").is_err());
                    assert!(
                        fs::rename(fixture.0.join("source.md"), fixture.0.join("replaced.md"))
                            .is_err()
                    );
                }
                Ok(())
            },
        )
        .unwrap();
        assert!(observed.get());
        assert_eq!(
            fs::read_to_string(fixture.0.join("copy.md")).unwrap(),
            "original"
        );
        fs::write(fixture.0.join("source.md"), "external").unwrap();
    }

    #[test]
    fn recursive_delete_uses_one_visit_per_approved_node() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("tree")).unwrap();
        for index in 0..5500 {
            fixture.put(&format!("tree/{index}.md"), "x");
        }
        fixture
            .call(
                &manifest(),
                "filesystem.delete",
                json!({"path":"tree","options":{"recursive":true}}),
            )
            .unwrap();
        assert!(!fixture.0.join("tree").exists());
    }

    #[cfg(windows)]
    #[test]
    fn aborted_recursive_copy_cleans_its_readonly_copies_without_changing_source() {
        let fixture = Fixture::new();
        fixture.put("source/a.md", "readonly");
        fixture.put("source/b.md", "normal");
        let original = fixture.0.join("source/a.md");
        let mut permissions = fs::metadata(&original).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&original, permissions).unwrap();
        let reached = Cell::new(false);
        let result = super::super::copy_plugin_path_checked(
            &fixture.0,
            &manifest(),
            "source",
            "copy",
            true,
            &|| {
                if fixture.0.join("copy/a.md").is_file() {
                    reached.set(true);
                    return Err("PLUGIN_REQUEST_TIMEOUT".into());
                }
                Ok(())
            },
        );
        // Restore only the source test fixture's attribute so fixture cleanup always succeeds.
        let preserved = fs::metadata(&original).unwrap().permissions().readonly();
        let mut permissions = fs::metadata(&original).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&original, permissions).unwrap();
        assert!(reached.get());
        assert!(preserved);
        assert_eq!(result.unwrap_err(), "PLUGIN_REQUEST_TIMEOUT");
        assert!(!fixture.0.join("copy").exists());
    }

    #[cfg(windows)]
    #[test]
    fn recursive_creation_pins_created_ancestors_and_checks_revocation() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("notes")).unwrap();
        let reached = Cell::new(false);
        let result = invoke(
            &fixture.0,
            &manifest(),
            "filesystem.createDirectory",
            &json!({"path":"notes/deep/last","options":{"recursive":true}}),
            &|| {
                if fixture.0.join("notes/deep").is_dir() {
                    reached.set(true);
                    assert!(
                        fs::rename(fixture.0.join("notes"), fixture.0.join("renamed-notes"))
                            .is_err()
                    );
                    return Err("PLUGIN_RUNTIME_TERMINATED".into());
                }
                Ok(())
            },
        );
        assert_eq!(result.unwrap_err(), "PLUGIN_RUNTIME_TERMINATED");
        assert!(reached.get());
        assert!(!fixture.0.join("notes/deep/last").exists());
        fs::rename(fixture.0.join("notes"), fixture.0.join("renamed-notes")).unwrap();
    }

    #[test]
    fn storage_routes_preserve_null_absence_other_keys_and_reject_spoofed_identity() {
        let fixture = Fixture::new();
        let manifest = manifest();
        let path = fixture.0.join("data/storage.json");
        assert_eq!(
            storage(
                &path,
                &manifest,
                "storage.get",
                &json!({"key":"missing"}),
                &|| Ok(())
            )
            .unwrap(),
            json!({"found":false})
        );
        for (key, value) in [("null", Value::Null), ("other", json!({"nested":[1,true]}))] {
            storage(
                &path,
                &manifest,
                "storage.set",
                &json!({"key":key,"value":value}),
                &|| Ok(()),
            )
            .unwrap();
        }
        assert_eq!(
            storage(
                &path,
                &manifest,
                "storage.get",
                &json!({"key":"null"}),
                &|| Ok(())
            )
            .unwrap(),
            json!({"found":true,"value":null})
        );
        storage(
            &path,
            &manifest,
            "storage.delete",
            &json!({"key":"null"}),
            &|| Ok(()),
        )
        .unwrap();
        assert_eq!(
            storage(
                &path,
                &manifest,
                "storage.get",
                &json!({"key":"other"}),
                &|| Ok(())
            )
            .unwrap()["value"],
            json!({"nested":[1,true]})
        );
        for params in [
            json!({"key":"other","value":3,"pluginId":"com.other.plugin"}),
            json!({"key":"other"}),
        ] {
            assert_eq!(
                storage(&path, &manifest, "storage.set", &params, &|| Ok(())).unwrap_err(),
                "PLUGIN_INVALID_ARGUMENT"
            );
        }
    }

    #[test]
    fn storage_rechecks_owner_at_commit_and_cleans_unused_temporary_files() {
        let fixture = Fixture::new();
        let manifest = manifest();
        let path = fixture.0.join("data/storage.json");
        storage(
            &path,
            &manifest,
            "storage.set",
            &json!({"key":"value","value":"original"}),
            &|| Ok(()),
        )
        .unwrap();
        let before = fs::read(&path).unwrap();
        let checks = Cell::new(0);
        let result = storage(
            &path,
            &manifest,
            "storage.set",
            &json!({"key":"value","value":"changed"}),
            &|| {
                checks.set(checks.get() + 1);
                if checks.get() == 4 {
                    Err("PLUGIN_RUNTIME_TERMINATED".into())
                } else {
                    Ok(())
                }
            },
        );
        assert_eq!(result.unwrap_err(), "PLUGIN_RUNTIME_TERMINATED");
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn revoked_shared_host_generation_rejects_real_filesystem_route() {
        let package_fixture = super::super::plugin_package::tests::Fixture::new();
        let mut manifest = super::super::plugin_package::tests::manifest("1.0.0");
        manifest["permissions"] = json!([{"id":"workspace.read","reason":"Read notes"}]);
        let session = super::super::plugin_host::Session::new(
            package_fixture.package("1.0.0"),
            manifest,
            vec!["workspace.read".into()],
        )
        .unwrap();
        let generation = session.id.clone();
        let host = RefCell::new(super::super::plugin_host::PluginHost::default());
        host.borrow_mut()
            .replace("com.example.reader", Some(session));
        host.borrow_mut().contributions("main");
        let granted = host
            .borrow()
            .authorized_manifest("com.example.reader")
            .unwrap()
            .1;
        let fixture = Fixture::new();
        fixture.put("note.md", "content");
        let checkpoint = || {
            host.borrow()
                .authorize("com.example.reader", &generation, "main")
        };
        assert_eq!(
            invoke(
                &fixture.0,
                &granted,
                "filesystem.readText",
                &json!({"path":"note.md"}),
                &checkpoint
            )
            .unwrap()["content"],
            "content"
        );
        host.borrow_mut().dispose_window("main");
        assert_eq!(
            invoke(
                &fixture.0,
                &granted,
                "filesystem.readText",
                &json!({"path":"note.md"}),
                &checkpoint
            )
            .unwrap_err(),
            "PLUGIN_RUNTIME_TERMINATED"
        );
    }
}
