//! Validate and stage ordinary plugin directories/archives without executing their code.
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MAX_FILES: usize = 1_000;
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_PACKAGE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 512 * 1024;

/// The compiled application version is the compatibility baseline, not the plugin version.
pub(crate) fn validate_app_compatibility(manifest: &Value) -> Result<(), String> {
    compare_app_version(manifest, env!("CARGO_PKG_VERSION"))
}

/// Compare SemVer precedence so build metadata never changes the minimum requirement.
fn compare_app_version(manifest: &Value, app_version: &str) -> Result<(), String> {
    let minimum = semver::Version::parse(
        manifest["minAppVersion"]
            .as_str()
            .ok_or("PLUGIN_MANIFEST_INVALID")?,
    )
    .map_err(|_| "PLUGIN_MANIFEST_INVALID")?;
    let current = semver::Version::parse(app_version).map_err(|_| "PLUGIN_APP_VERSION_INVALID")?;
    if current.cmp_precedence(&minimum) == std::cmp::Ordering::Less {
        return Err("PLUGIN_APP_VERSION_UNSUPPORTED".into());
    }
    Ok(())
}

/// Plugin ID grammar also prevents path traversal in managed directory names.
pub(crate) fn valid_id(id: &str) -> bool {
    (3..=120).contains(&id.len())
        && id.split(['.', '-']).all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
        && safe_path(id).is_ok()
}

/// Reject traversal, aliases, Windows device names and archive paths escaping staging.
pub(crate) fn safe_path(name: &str) -> Result<PathBuf, String> {
    let normalized = name.replace('\\', "/");
    if normalized.is_empty() || normalized.len() > 2_048 || normalized.starts_with('/') {
        return Err("PLUGIN_ARCHIVE_PATH_INVALID".into());
    }
    let mut result = PathBuf::new();
    for part in normalized.trim_end_matches('/').split('/') {
        let device = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if part.is_empty()
            || matches!(part, "." | "..")
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|ch| ch.is_control() || matches!(ch, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
            || matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (device.len() == 4
                && (device.starts_with("COM") || device.starts_with("LPT"))
                && matches!(device.as_bytes()[3], b'1'..=b'9'))
        {
            return Err("PLUGIN_ARCHIVE_PATH_INVALID".into());
        }
        result.push(part);
    }
    Ok(result)
}

/// Bound all JSON reads before parsing; a malformed package never reaches installation.
fn read_json(path: &Path, limit: u64) -> Result<Value, String> {
    let file = fs::File::open(path).map_err(|_| "PLUGIN_MANIFEST_READ_FAILED")?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "PLUGIN_MANIFEST_READ_FAILED")?;
    if bytes.len() as u64 > limit {
        return Err("PLUGIN_MANIFEST_INVALID".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "PLUGIN_MANIFEST_INVALID".into())
}

/// Reuse the repository's schema, then check ownership and cross-field invariants.
pub(crate) fn validate_manifest(manifest: &Value) -> Result<(), String> {
    static SCHEMA: OnceLock<Result<jsonschema::Validator, String>> = OnceLock::new();
    let validator = SCHEMA
        .get_or_init(|| {
            let schema: Value =
                serde_json::from_str(include_str!("../../plugin/schema/manifest.schema.json"))
                    .map_err(|_| "PLUGIN_MANIFEST_SCHEMA_INVALID".to_string())?;
            jsonschema::options()
                .should_validate_formats(true)
                .build(&schema)
                .map_err(|_| "PLUGIN_MANIFEST_SCHEMA_INVALID".to_string())
        })
        .as_ref()
        .map_err(Clone::clone)?;
    if !validator.is_valid(manifest) || manifest["apiVersion"] != "1.0" {
        return Err("PLUGIN_MANIFEST_INVALID".into());
    }
    if let Some(sidecar) = manifest.get("sidecar") {
        let executable = sidecar["executable"]
            .as_str()
            .ok_or("PLUGIN_MANIFEST_INVALID")?;
        safe_path(executable).map_err(|_| "PLUGIN_MANIFEST_INVALID")?;
    }
    validate_labels(manifest)?;
    let id = manifest["id"].as_str().ok_or("PLUGIN_MANIFEST_INVALID")?;
    if !valid_id(id) {
        return Err("PLUGIN_MANIFEST_INVALID".into());
    }
    for key in ["version", "minAppVersion"] {
        semver::Version::parse(manifest[key].as_str().unwrap_or_default())
            .map_err(|_| "PLUGIN_MANIFEST_INVALID")?;
    }
    for value in [
        manifest.get("homepage"),
        manifest.get("repository"),
        manifest["author"].get("url"),
    ]
    .into_iter()
    .flatten()
    {
        let url = reqwest::Url::parse(value.as_str().unwrap_or_default())
            .map_err(|_| "PLUGIN_MANIFEST_INVALID")?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err("PLUGIN_MANIFEST_INVALID".into());
        }
    }
    if let Some(icon) = manifest["icon"].as_str() {
        safe_path(icon).map_err(|_| "PLUGIN_MANIFEST_INVALID")?;
    }
    let mut permissions = HashSet::new();
    for permission in manifest["permissions"].as_array().into_iter().flatten() {
        if !permissions.insert(permission["id"].as_str().unwrap_or_default()) {
            return Err("PLUGIN_MANIFEST_INVALID".into());
        }
    }
    let mut all_fields = HashSet::new();
    for (kind, identity) in [
        ("commands", "id"),
        ("views", "type"),
        ("settings", "id"),
        ("statusBar", "id"),
    ] {
        let mut ids = HashSet::new();
        for item in manifest["contributes"][kind]
            .as_array()
            .into_iter()
            .flatten()
        {
            let contribution_id = item[identity].as_str().unwrap_or_default();
            if !contribution_id.starts_with(&format!("{id}.")) || !ids.insert(contribution_id) {
                return Err("PLUGIN_MANIFEST_INVALID".into());
            }
            if kind == "settings" {
                for field in item["fields"].as_array().into_iter().flatten() {
                    let field_id = field["id"].as_str().unwrap_or_default();
                    if !field_id.starts_with(&format!("{id}."))
                        || !all_fields.insert(field_id)
                        || field["min"]
                            .as_f64()
                            .zip(field["max"].as_f64())
                            .is_some_and(|(min, max)| min > max)
                    {
                        return Err("PLUGIN_MANIFEST_INVALID".into());
                    }
                    let mut normalized = field.clone();
                    if matches!(field["type"].as_str(), Some("file" | "folder")) {
                        if let Some(path) = field["defaultValue"].as_str() {
                            normalized["defaultValue"] = Value::String(path.replace('\\', "/"));
                        }
                        if let Some(extensions) = normalized["extensions"].as_array_mut() {
                            for extension in extensions {
                                *extension =
                                    Value::String(extension.as_str().unwrap().to_ascii_lowercase());
                            }
                        }
                    }
                    if let Some(default) = normalized.get("defaultValue") {
                        super::plugin_settings::validate_value(&normalized, default)
                            .map_err(|_| "PLUGIN_MANIFEST_INVALID")?;
                    }
                    let mut options = HashSet::new();
                    if field["options"].as_array().is_some_and(|items| {
                        items.iter().any(|option| {
                            !options.insert(option["value"].as_str().unwrap_or_default())
                        })
                    }) {
                        return Err("PLUGIN_MANIFEST_INVALID".into());
                    }
                }
            }
        }
    }
    Ok(())
}

/// Required metadata must contain visible text; user default values may remain empty.
fn validate_labels(value: &Value) -> Result<(), String> {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                if matches!(
                    key.as_str(),
                    "name"
                        | "title"
                        | "description"
                        | "label"
                        | "reason"
                        | "text"
                        | "tooltip"
                        | "placeholder"
                        | "license"
                ) && value.as_str().is_some_and(|text| text.trim().is_empty())
                {
                    return Err("PLUGIN_MANIFEST_INVALID".into());
                }
                validate_labels(value)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                validate_labels(item)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Validate all mandatory root files after staging and whenever a version is reused.
pub(crate) fn read_manifest(root: &Path) -> Result<Value, String> {
    for (file, code) in [
        ("manifest.json", "PLUGIN_MANIFEST_READ_FAILED"),
        ("main.js", "PLUGIN_ENTRY_NOT_FOUND"),
        ("styles.css", "PLUGIN_STYLES_NOT_FOUND"),
    ] {
        let metadata = fs::symlink_metadata(root.join(file)).map_err(|_| code)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(code.into());
        }
    }
    let mut manifest = read_json(&root.join("manifest.json"), MAX_MANIFEST_BYTES)?;
    validate_manifest(&manifest)?;
    if let Some(sidecar) = manifest.get("sidecar") {
        let executable = sidecar["executable"]
            .as_str()
            .ok_or("PLUGIN_SIDECAR_SPEC_INVALID")?;
        let target = root.join(safe_path(executable).map_err(|_| "PLUGIN_SIDECAR_SPEC_INVALID")?);
        let metadata =
            fs::symlink_metadata(target).map_err(|_| "PLUGIN_SIDECAR_ENTRY_NOT_FOUND")?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("PLUGIN_SIDECAR_ENTRY_NOT_FOUND".into());
        }
    }
    // Match the SDK's normalized workspace paths without rewriting source packages.
    for page in manifest["contributes"]["settings"]
        .as_array_mut()
        .into_iter()
        .flatten()
    {
        for field in page["fields"].as_array_mut().into_iter().flatten() {
            if matches!(field["type"].as_str(), Some("file" | "folder")) {
                if let Some(path) = field["defaultValue"].as_str() {
                    field["defaultValue"] = Value::String(path.replace('\\', "/"));
                }
                if let Some(extensions) = field["extensions"].as_array_mut() {
                    for extension in extensions {
                        *extension =
                            Value::String(extension.as_str().unwrap().to_ascii_lowercase());
                    }
                }
            }
        }
    }
    Ok(manifest)
}

#[derive(Default)]
struct Quota {
    files: usize,
    bytes: u64,
    paths: HashSet<String>,
    spelling: HashMap<String, String>,
}
impl Quota {
    /// Apply the same bounded, case-insensitive package namespace to directories and ZIPs.
    fn admit(&mut self, name: &str, size: u64) -> Result<PathBuf, String> {
        let path = safe_path(name)?;
        if path.components().count() > 32 {
            return Err("PLUGIN_ARCHIVE_PATH_INVALID".into());
        }
        self.files += 1;
        if self.files > MAX_FILES {
            return Err("PLUGIN_ARCHIVE_TOO_MANY_FILES".into());
        }
        if size > MAX_FILE_BYTES {
            return Err("PLUGIN_ARCHIVE_FILE_TOO_LARGE".into());
        }
        self.bytes += size;
        if self.bytes > MAX_PACKAGE_BYTES {
            return Err("PLUGIN_ARCHIVE_TOO_LARGE".into());
        }
        let normalized = path.to_string_lossy().replace('\\', "/");
        // Include implicit parent directories so Assets/a + assets/b never aliases on Windows.
        let mut prefix = String::new();
        for part in normalized.split('/') {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            let key = prefix.to_lowercase();
            if self
                .spelling
                .get(&key)
                .is_some_and(|prior| prior != &prefix)
            {
                return Err("PLUGIN_ARCHIVE_PATH_INVALID".into());
            }
            self.spelling.insert(key, prefix.clone());
        }
        if !self.paths.insert(normalized.to_lowercase()) {
            return Err("PLUGIN_ARCHIVE_PATH_INVALID".into());
        }
        Ok(path)
    }
}

/// Copy regular files only; links and excessive recursion are rejected before commit.
fn copy_directory(
    source: &Path,
    destination: &Path,
    relative: &Path,
    depth: usize,
    quota: &mut Quota,
) -> Result<(), String> {
    if depth > 32 {
        return Err("PLUGIN_ARCHIVE_TOO_MANY_FILES".into());
    }
    for entry in fs::read_dir(source.join(relative)).map_err(|_| "PLUGIN_INSTALL_READ_FAILED")? {
        let entry = entry.map_err(|_| "PLUGIN_INSTALL_READ_FAILED")?;
        let path = relative.join(entry.file_name());
        let name = path.to_str().ok_or("PLUGIN_ARCHIVE_PATH_INVALID")?;
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| "PLUGIN_INSTALL_READ_FAILED")?;
        if metadata.file_type().is_symlink() {
            return Err("PLUGIN_INSTALL_SYMLINK_NOT_ALLOWED".into());
        }
        let safe = quota.admit(
            name,
            if metadata.is_file() {
                metadata.len()
            } else {
                0
            },
        )?;
        let target = destination.join(safe);
        if metadata.is_dir() {
            fs::create_dir(&target).map_err(|_| "PLUGIN_INSTALL_WRITE_FAILED")?;
            copy_directory(source, destination, &path, depth + 1, quota)?;
        } else if metadata.is_file() {
            let mut input = fs::File::open(entry.path())
                .map_err(|_| "PLUGIN_INSTALL_READ_FAILED")?
                .take(MAX_FILE_BYTES + 1);
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)
                .map_err(|_| "PLUGIN_INSTALL_WRITE_FAILED")?;
            let bytes =
                std::io::copy(&mut input, &mut output).map_err(|_| "PLUGIN_INSTALL_READ_FAILED")?;
            if bytes != metadata.len() || bytes > MAX_FILE_BYTES {
                return Err("PLUGIN_ARCHIVE_FILE_TOO_LARGE".into());
            }
        } else {
            return Err("PLUGIN_INSTALL_SOURCE_UNSUPPORTED".into());
        }
    }
    Ok(())
}

/// Stream ZIP entries with declared and actual size checks, never bulk-unzip in memory.
fn extract_archive(source: &Path, destination: &Path) -> Result<(), String> {
    let input = fs::File::open(source).map_err(|_| "PLUGIN_INSTALL_READ_FAILED")?;
    if input
        .metadata()
        .map_err(|_| "PLUGIN_INSTALL_READ_FAILED")?
        .len()
        > MAX_PACKAGE_BYTES
    {
        return Err("PLUGIN_ARCHIVE_TOO_LARGE".into());
    }
    let mut archive = zip::ZipArchive::new(input).map_err(|_| "PLUGIN_ARCHIVE_INVALID")?;
    if archive.len() > MAX_FILES {
        return Err("PLUGIN_ARCHIVE_TOO_MANY_FILES".into());
    }
    let mut quota = Quota::default();
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|_| "PLUGIN_ARCHIVE_INVALID")?;
        if let Some(mode) = file.unix_mode() {
            match mode & 0o170000 {
                0 | 0o100000 | 0o040000 => {}
                0o120000 => return Err("PLUGIN_INSTALL_SYMLINK_NOT_ALLOWED".into()),
                _ => return Err("PLUGIN_INSTALL_SOURCE_UNSUPPORTED".into()),
            }
        }
        let relative = quota.admit(file.name(), file.size())?;
        let target = destination.join(relative);
        if file.is_dir() {
            fs::create_dir_all(target).map_err(|_| "PLUGIN_INSTALL_WRITE_FAILED")?;
        } else {
            fs::create_dir_all(target.parent().ok_or("PLUGIN_ARCHIVE_PATH_INVALID")?)
                .map_err(|_| "PLUGIN_INSTALL_WRITE_FAILED")?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)
                .map_err(|_| "PLUGIN_ARCHIVE_PATH_INVALID")?;
            let declared = file.size();
            let actual = std::io::copy(&mut (&mut file).take(MAX_FILE_BYTES + 1), &mut output)
                .map_err(|_| "PLUGIN_ARCHIVE_INVALID")?;
            if actual != declared || actual > MAX_FILE_BYTES {
                return Err("PLUGIN_ARCHIVE_FILE_TOO_LARGE".into());
            }
            output.flush().map_err(|_| "PLUGIN_INSTALL_WRITE_FAILED")?;
        }
    }
    Ok(())
}

/// A newly created staging directory is owned solely by this install transaction.
pub(crate) struct StagedPackage {
    pub(crate) path: PathBuf,
    pub(crate) manifest: Value,
}
impl Drop for StagedPackage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Build a validated temporary package; never mutate the original directory/archive.
pub(crate) fn stage(source: &Path, staging_root: &Path) -> Result<StagedPackage, String> {
    let metadata = fs::symlink_metadata(source).map_err(|_| "PLUGIN_INSTALL_SOURCE_NOT_FOUND")?;
    if metadata.file_type().is_symlink() {
        return Err("PLUGIN_INSTALL_SYMLINK_NOT_ALLOWED".into());
    }
    let path = staging_root.join(format!("install-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&path).map_err(|_| "PLUGIN_INSTALL_WRITE_FAILED")?;
    let mut staged = StagedPackage {
        path,
        manifest: Value::Null,
    };
    if metadata.is_dir() {
        copy_directory(
            source,
            &staged.path,
            Path::new(""),
            0,
            &mut Quota::default(),
        )?;
    } else if metadata.is_file()
        && source
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("wstudio-plugin"))
    {
        extract_archive(source, &staged.path)?;
    } else {
        return Err("PLUGIN_INSTALL_SOURCE_UNSUPPORTED".into());
    }
    staged.manifest = read_manifest(&staged.path)?;
    Ok(staged)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use zip::write::SimpleFileOptions;

    /// Ordinary third-party package fixture with deterministic cleanup, including assertion failures.
    pub(crate) struct Fixture(pub(crate) PathBuf);
    impl Fixture {
        pub(crate) fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("wstudio-packages-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("staging")).unwrap();
            Self(root)
        }
        pub(crate) fn package(&self, version: &str) -> PathBuf {
            let root = self.0.join(format!("source-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            fs::write(
                root.join("manifest.json"),
                serde_json::to_vec(&manifest(version)).unwrap(),
            )
            .unwrap();
            fs::write(root.join("main.js"), "export function activate() {}").unwrap();
            fs::write(root.join("styles.css"), "").unwrap();
            root
        }
        pub(crate) fn archive(&self, entries: &[(&str, &[u8])]) -> PathBuf {
            let path = self
                .0
                .join(format!("{}.wstudio-plugin", uuid::Uuid::new_v4()));
            let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
            for (name, bytes) in entries {
                zip.start_file(*name, SimpleFileOptions::default()).unwrap();
                zip.write_all(bytes).unwrap();
            }
            zip.finish().unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    pub(crate) fn manifest(version: &str) -> Value {
        json!({"id":"com.example.reader", "name":"Reader", "version":version,
            "description":"Ordinary package", "author":{"name":"Example"},
            "minAppVersion":"0.1.0", "apiVersion":"1.0", "main":"main.js",
            "activationEvents":["onStartupFinished"],
            "permissions":[{"id":"workspace.read","reason":"Read notes"},
                {"id":"storage.plugin","reason":"Save state"},
                {"id":"renderer.code","reason":"Privileged feature"}],
            "contributes":{"commands":[],"views":[],"settings":[],"statusBar":[]}})
    }

    #[test]
    fn app_compatibility_uses_semver_precedence_and_rejects_malformed_versions() {
        for (current, minimum, allowed) in [
            ("0.1.0", "0.0.1", true),
            ("0.1.0", "0.1.0", true),
            ("0.1.0+host.1", "0.1.0+plugin.9", true),
            ("0.1.0", "0.1.1", false),
            ("0.1.0-beta.2", "0.1.0-beta.10", false),
            ("0.1.0-beta.10", "0.1.0-beta.2", true),
            ("0.1.0-beta.10", "0.1.0", false),
            ("0.1.0", "0.1.0-beta.10", true),
        ] {
            let mut manifest = manifest("9.0.0");
            manifest["minAppVersion"] = json!(minimum);
            let result = compare_app_version(&manifest, current);
            if allowed {
                assert_eq!(result, Ok(()), "{current} >= {minimum}");
            } else {
                assert_eq!(result.unwrap_err(), "PLUGIN_APP_VERSION_UNSUPPORTED");
            }
        }
        for minimum in [json!(null), json!(12), json!("0.1"), json!("latest")] {
            let mut manifest = manifest("1.0.0");
            manifest["minAppVersion"] = minimum;
            assert_eq!(
                compare_app_version(&manifest, "0.1.0").unwrap_err(),
                "PLUGIN_MANIFEST_INVALID"
            );
        }
        assert_eq!(
            compare_app_version(&manifest("1.0.0"), "invalid").unwrap_err(),
            "PLUGIN_APP_VERSION_INVALID"
        );
    }

    #[test]
    fn packaged_core_and_example_manifests_are_compatible_with_current_app() {
        let plugins = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugin");
        for package in [
            "core-plugins/file-explorer",
            "core-plugins/outline",
            "core-plugins/web-viewer",
            "examples/minimal",
            "examples/web-viewer",
        ] {
            let manifest = read_manifest(&plugins.join(package)).unwrap();
            validate_app_compatibility(&manifest).unwrap();
        }
    }

    #[test]
    fn directories_and_zip_are_staged_without_touching_the_source() {
        let f = Fixture::new();
        let source = f.package("1.0.0");
        fs::create_dir(source.join("assets")).unwrap();
        fs::write(source.join("assets/icon.svg"), "<svg/>").unwrap();
        let staged = stage(&source, &f.0.join("staging")).unwrap();
        assert_eq!(
            fs::read(staged.path.join("assets/icon.svg")).unwrap(),
            b"<svg/>"
        );
        assert_eq!(staged.manifest["id"], "com.example.reader");
        let temporary = staged.path.clone();
        drop(staged);
        assert!(!temporary.exists());
        assert!(source.join("main.js").is_file());
        let bytes = fs::read(source.join("manifest.json")).unwrap();
        let archive = f.archive(&[
            ("manifest.json", &bytes),
            ("main.js", b"export {}"),
            ("styles.css", b""),
        ]);
        let staged = stage(&archive, &f.0.join("staging")).unwrap();
        assert_eq!(staged.manifest["version"], "1.0.0");
        assert!(archive.is_file());
        drop(staged);
        assert_eq!(fs::read_dir(f.0.join("staging")).unwrap().count(), 0);
    }

    #[test]
    fn manifest_rejects_unknown_fields_wrong_namespace_duplicates_and_invalid_defaults() {
        let base = manifest("1.0.0");
        validate_manifest(&base).unwrap();
        let mut bad = base.clone();
        bad["unknown"] = json!(true);
        assert!(validate_manifest(&bad).is_err());
        for key in ["name", "description"] {
            let mut bad = base.clone();
            bad[key] = json!("   ");
            assert!(validate_manifest(&bad).is_err());
        }
        let mut bad = base.clone();
        bad["contributes"]["commands"] = json!([{"id":"other.run","title":"Run"}]);
        assert!(validate_manifest(&bad).is_err());
        let mut bad = base.clone();
        bad["contributes"]["commands"] = json!([
            {"id":"com.example.reader.run","title":"Run"},
            {"id":"com.example.reader.run","title":"Other"}]);
        assert!(validate_manifest(&bad).is_err());
        for field in [
            json!({"id":"com.example.reader.count","label":"Count","type":"number","min":5,"max":2}),
            json!({"id":"com.example.reader.count","label":"Count","type":"number","min":5,"defaultValue":2}),
            json!({"id":"com.example.reader.mode","label":"Mode","type":"select","defaultValue":"bad","options":[{"label":"Good","value":"good"}]}),
            json!({"id":"com.example.reader.mode","label":"Mode","type":"select","options":[{"label":"First","value":"x"},{"label":"Second","value":"x"}]}),
        ] {
            let mut bad = base.clone();
            bad["contributes"]["settings"] =
                json!([{"id":"com.example.reader.page","title":"Page","fields":[field]}]);
            assert!(validate_manifest(&bad).is_err());
        }
        let mut bad = base.clone();
        bad["contributes"]["settings"] = json!([
            {"id":"com.example.reader.first","title":"First","fields":[{"id":"com.example.reader.shared","label":"Shared","type":"text"}]},
            {"id":"com.example.reader.second","title":"Second","fields":[{"id":"com.example.reader.shared","label":"Shared","type":"text"}]}]);
        assert!(validate_manifest(&bad).is_err());
        for version in ["01.0.0", "1.0.0-01", "1.0.0-alpha..beta"] {
            let mut bad = base.clone();
            bad["version"] = json!(version);
            assert!(validate_manifest(&bad).is_err());
        }
        let mut bad = base.clone();
        bad["homepage"] = json!("file:///private");
        assert!(validate_manifest(&bad).is_err());
        let mut bad = base.clone();
        bad["apiVersion"] = json!("2.0");
        assert!(validate_manifest(&bad).is_err());
    }

    #[test]
    fn sidecar_manifest_requires_a_package_local_regular_executable() {
        let fixture = Fixture::new();
        let root = fixture.package("1.0.0");
        let mut value = manifest("1.0.0");
        value["sidecar"] = json!({"type":"sidecar", "executable":"host.exe", "args":["--serve"]});
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        fs::write(root.join("host.exe"), b"fixture").unwrap();
        assert_eq!(
            read_manifest(&root).unwrap()["sidecar"]["executable"],
            "host.exe"
        );

        fs::remove_file(root.join("host.exe")).unwrap();
        assert_eq!(
            read_manifest(&root).unwrap_err(),
            "PLUGIN_SIDECAR_ENTRY_NOT_FOUND"
        );
        value["sidecar"]["executable"] = json!("../host.exe");
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        assert_eq!(
            validate_manifest(&value).unwrap_err(),
            "PLUGIN_MANIFEST_INVALID"
        );
    }

    #[test]
    fn workspace_defaults_are_normalized_and_root_files_are_required() {
        let f = Fixture::new();
        let source = f.package("1.0.0");
        let mut value = manifest("1.0.0");
        value["contributes"]["settings"] = json!([{"id":"com.example.reader.page","title":"Page","fields":[
            {"id":"com.example.reader.file","type":"file","label":"File","defaultValue":"notes\\a.MD","extensions":[".MD"]}]}]);
        fs::write(
            source.join("manifest.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        let normalized = read_manifest(&source).unwrap();
        assert_eq!(
            normalized["contributes"]["settings"][0]["fields"][0]["defaultValue"],
            "notes/a.MD"
        );
        assert_eq!(
            normalized["contributes"]["settings"][0]["fields"][0]["extensions"][0],
            ".md"
        );
        assert_eq!(
            fs::read(source.join("manifest.json")).unwrap(),
            serde_json::to_vec(&value).unwrap()
        );
        fs::remove_file(source.join("styles.css")).unwrap();
        assert_eq!(
            read_manifest(&source).unwrap_err(),
            "PLUGIN_STYLES_NOT_FOUND"
        );
    }

    #[test]
    fn archive_rejects_traversal_devices_and_case_aliases_and_cleans_failures() {
        let f = Fixture::new();
        for name in [
            "../outside",
            "/absolute",
            "C:/outside",
            "dir/../../outside",
            "file:stream",
            "NUL.txt",
            "a/COM1",
            "name.",
            "dir/name ",
        ] {
            let archive = f.archive(&[(name, b"bad")]);
            assert_eq!(
                stage(&archive, &f.0.join("staging")).err().unwrap(),
                "PLUGIN_ARCHIVE_PATH_INVALID",
                "{name}"
            );
        }
        for entries in [
            vec![("Main.js", &b"a"[..]), ("main.js", &b"b"[..])],
            vec![("Assets/a", &b"a"[..]), ("assets/b", &b"b"[..])],
        ] {
            let archive = f.archive(&entries);
            assert_eq!(
                stage(&archive, &f.0.join("staging")).err().unwrap(),
                "PLUGIN_ARCHIVE_PATH_INVALID"
            );
        }
        assert_eq!(fs::read_dir(f.0.join("staging")).unwrap().count(), 0);
        assert!(!f.0.join("outside").exists());
    }

    #[test]
    fn archive_links_depth_and_expansion_limits_are_enforced() {
        let f = Fixture::new();
        let path = f.0.join("link.wstudio-plugin");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        zip.add_symlink("link", "../outside", SimpleFileOptions::default())
            .unwrap();
        zip.finish().unwrap();
        assert_eq!(
            stage(&path, &f.0.join("staging")).err().unwrap(),
            "PLUGIN_INSTALL_SYMLINK_NOT_ALLOWED"
        );
        let deep = format!("{}file", "dir/".repeat(33));
        let path = f.archive(&[(&deep, b"bad")]);
        assert_eq!(
            stage(&path, &f.0.join("staging")).err().unwrap(),
            "PLUGIN_ARCHIVE_PATH_INVALID"
        );
        let path = f.0.join("expanded.wstudio-plugin");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        zip.start_file(
            "large",
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
        zip.write_all(&vec![0; MAX_FILE_BYTES as usize + 1])
            .unwrap();
        zip.finish().unwrap();
        assert_eq!(
            stage(&path, &f.0.join("staging")).err().unwrap(),
            "PLUGIN_ARCHIVE_FILE_TOO_LARGE"
        );
        let mut quota = Quota::default();
        for index in 0..MAX_FILES {
            quota.admit(&format!("file{index}"), 0).unwrap();
        }
        assert_eq!(
            quota.admit("overflow", 0).unwrap_err(),
            "PLUGIN_ARCHIVE_TOO_MANY_FILES"
        );
        let mut quota = Quota::default();
        for index in 0..5 {
            quota
                .admit(&format!("file{index}"), MAX_FILE_BYTES)
                .unwrap();
        }
        assert_eq!(
            quota.admit("overflow", 1).unwrap_err(),
            "PLUGIN_ARCHIVE_TOO_LARGE"
        );
        assert_eq!(fs::read_dir(f.0.join("staging")).unwrap().count(), 0);
    }
}
