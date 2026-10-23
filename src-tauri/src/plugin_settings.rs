//! Rust authority for plugin settings definitions, window ownership and atomic values.
use super::{plugin_setting_default_value, plugin_setting_definition};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;

const DEFINITION_INVALID: &str = "PLUGIN_SETTING_DEFINITION_INVALID";
const MAX_SETTINGS_BYTES: usize = 1024 * 1024;
const MAX_DEFINITION_NODES: usize = 2_000;
const MAX_DEFINITION_DEPTH: usize = 24;

#[derive(Clone)]
struct RegisteredPage {
    window: String,
    plugin_id: String,
    page: Value,
    revision: u64,
}

#[derive(Default)]
struct Registry {
    pages: Vec<RegisteredPage>,
    revision: u64,
}

/// Share definitions with settings windows and serialize registry changes and file writes.
#[derive(Default)]
pub(crate) struct PluginSettingsState {
    registry: Mutex<Registry>,
}

impl Registry {
    /// Resolve the latest live owner while preserving manifest order and fallback fields.
    fn resolve(&self, plugin_id: &str, manifest: &Value) -> Value {
        Value::Array(
            manifest["contributes"]["settings"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|shell| {
                    let latest = self
                        .pages
                        .iter()
                        .filter(|entry| {
                            entry.plugin_id == plugin_id && entry.page["id"] == shell["id"]
                        })
                        .max_by_key(|entry| entry.revision);
                    let Some(entry) = latest else {
                        return shell.clone();
                    };
                    let mut page = shell.clone();
                    for key in ["title", "description"] {
                        if let Some(value) = entry.page.get(key) {
                            page[key] = value.clone();
                        }
                    }
                    if let Some(definitions) = entry.page.get("definitions") {
                        page["definitions"] = definitions.clone();
                        page["fields"] = Value::Array(flatten_fields(definitions));
                    }
                    page
                })
                .collect(),
        )
    }

    /// Return a manifest carrying the same effective definitions used by contributions.
    fn manifest(&self, plugin_id: &str, manifest: &Value) -> Value {
        let mut effective = manifest.clone();
        effective["contributes"]["settings"] = self.resolve(plugin_id, manifest);
        effective
    }
}

impl PluginSettingsState {
    /// Stop/regrant invalidates every window's definitions without deleting persisted values.
    pub(crate) fn dispose_plugin(&self, plugin: &str) {
        if let Ok(mut state) = self.registry.lock() {
            state.pages.retain(|entry| entry.plugin_id != plugin);
        }
    }
    /// Validate before replacing an owner's page; failures leave existing state intact.
    pub(crate) fn register(
        &self,
        window: &str,
        plugin_id: &str,
        manifest: &Value,
        input: &Value,
        ensure_active: &dyn Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        let page = parse_page(plugin_id, manifest, input)?;
        let mut state = self.registry.lock().map_err(|_| "PLUGIN_API_FAILED")?;
        // Include dormant owner definitions and manifest fallbacks so closing a window
        // cannot resurrect a conflicting field from another settings page.
        let fields = page
            .get("definitions")
            .map(flatten_fields)
            .unwrap_or_else(|| {
                plugin_setting_definition(manifest, page["id"].as_str().unwrap())
                    .ok()
                    .and_then(|shell| shell["fields"].as_array().cloned())
                    .unwrap_or_default()
            });
        let field_ids: HashSet<_> = fields
            .iter()
            .filter_map(|field| field["id"].as_str())
            .collect();
        for other in manifest["contributes"]["settings"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|other| other["id"] != page["id"])
        {
            let mut candidates = other["fields"].as_array().cloned().unwrap_or_default();
            for entry in state
                .pages
                .iter()
                .filter(|entry| entry.plugin_id == plugin_id && entry.page["id"] == other["id"])
            {
                if let Some(definitions) = entry.page.get("definitions") {
                    candidates.extend(flatten_fields(definitions));
                }
            }
            if candidates.iter().any(|field| {
                field["id"]
                    .as_str()
                    .is_some_and(|id| field_ids.contains(id))
            }) {
                return Err(DEFINITION_INVALID.into());
            }
        }
        ensure_active()?;
        state.revision += 1;
        let revision = state.revision;
        state.pages.retain(|entry| {
            !(entry.window == window
                && entry.plugin_id == plugin_id
                && entry.page["id"] == page["id"])
        });
        state.pages.push(RegisteredPage {
            window: window.into(),
            plugin_id: plugin_id.into(),
            page,
            revision,
        });
        Ok(())
    }

    /// Remove only this window's registration; stored values and other owners survive.
    pub(crate) fn unregister(
        &self,
        window: &str,
        plugin_id: &str,
        manifest: &Value,
        id: &str,
        ensure_active: &dyn Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        validate_page_id(manifest, id)?;
        let mut state = self.registry.lock().map_err(|_| "PLUGIN_API_FAILED")?;
        ensure_active()?;
        state.pages.retain(|entry| {
            !(entry.window == window
                && entry.plugin_id == plugin_id
                && entry.page["id"].as_str() == Some(id))
        });
        Ok(())
    }

    /// Release closed-window definitions and return affected plugins for contribution events.
    pub(crate) fn dispose_window(&self, window: &str) -> Vec<String> {
        let Ok(mut state) = self.registry.lock() else {
            return Vec::new();
        };
        let plugins: HashSet<_> = state
            .pages
            .iter()
            .filter(|entry| entry.window == window)
            .map(|entry| entry.plugin_id.clone())
            .collect();
        state.pages.retain(|entry| entry.window != window);
        plugins.into_iter().collect()
    }

    /// Settings contributions are shared across editor and independent settings windows.
    pub(crate) fn resolve(&self, plugin_id: &str, manifest: &Value) -> Result<Value, String> {
        Ok(self
            .registry
            .lock()
            .map_err(|_| "PLUGIN_API_FAILED")?
            .resolve(plugin_id, manifest))
    }

    /// Read a page through current host definitions rather than renderer snapshots.
    pub(crate) fn get_page(
        &self,
        plugin_id: &str,
        manifest: &Value,
        page_id: &str,
        path: &Path,
    ) -> Result<Value, String> {
        let state = self.registry.lock().map_err(|_| "PLUGIN_API_FAILED")?;
        let effective = state.manifest(plugin_id, manifest);
        let page = plugin_setting_definition(&effective, page_id)?;
        Ok(Value::Object(super::normalize_plugin_settings(
            page,
            &read_values(path)?,
        )?))
    }

    /// Resolve SDK field reads against all effective pages, including runtime fields.
    pub(crate) fn get_field(
        &self,
        plugin_id: &str,
        manifest: &Value,
        field_id: &str,
        path: &Path,
    ) -> Result<Value, String> {
        let state = self.registry.lock().map_err(|_| "PLUGIN_API_FAILED")?;
        let pages = state.resolve(plugin_id, manifest);
        let field = pages
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(page_fields)
            .find(|field| field["id"].as_str() == Some(field_id))
            .ok_or("PLUGIN_CONTRIBUTION_NOT_DECLARED")?;
        let values = read_values(path)?;
        Ok(normalized_value(&field, &values))
    }

    /// Preserve every other page and dormant value while atomically saving one field.
    pub(crate) fn set_field(
        &self,
        plugin_id: &str,
        manifest: &Value,
        page_id: &str,
        field_id: &str,
        value: &Value,
        path: &Path,
    ) -> Result<Value, String> {
        let state = self.registry.lock().map_err(|_| "PLUGIN_API_FAILED")?;
        let effective = state.manifest(plugin_id, manifest);
        let page = plugin_setting_definition(&effective, page_id)?;
        let field = page_fields(page)
            .into_iter()
            .find(|field| field["id"].as_str() == Some(field_id))
            .ok_or("PLUGIN_SETTING_FIELD_NOT_DECLARED")?;
        validate_value(&field, value)?;
        let mut values = read_values(path)?;
        values.insert(field_id.into(), value.clone());
        let snapshot = project_values(page, &values)?;
        write_values(path, &values)?;
        Ok(snapshot)
    }
}

/// Constrain lifecycle requests to manifest-declared page IDs.
fn validate_page_id(manifest: &Value, id: &str) -> Result<(), String> {
    if id.trim().is_empty() || id.len() > 256 {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    plugin_setting_definition(manifest, id)
        .map(|_| ())
        .map_err(|_| "PLUGIN_CONTRIBUTION_NOT_DECLARED".into())
}

/// Read required text with the same whitespace semantics as JavaScript String.trim().
fn nonempty(value: &Value) -> Result<&str, String> {
    value
        .as_str()
        .filter(|s| !js_trim(s).is_empty())
        .ok_or_else(|| DEFINITION_INVALID.into())
}

/// Enforce the public lowercase dotted/hyphenated plugin namespace, not filesystem paths.
fn namespaced_id<'a>(value: &'a Value, plugin_id: &str) -> Result<&'a str, String> {
    let id = nonempty(value)?;
    if id.len() > 256
        || !id.starts_with(&format!("{plugin_id}."))
        || id.split(['.', '-']).any(|part| {
            part.is_empty()
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
    {
        return Err(DEFINITION_INVALID.into());
    }
    Ok(id)
}

/// Copy only SDK string fields; optional nulls and non-string payloads are invalid.
fn copy_strings(source: &Value, target: &mut Value, keys: &[&str]) -> Result<(), String> {
    for key in keys {
        if let Some(value) = source.get(*key) {
            if !value.is_string() {
                return Err(DEFINITION_INVALID.into());
            }
            target[*key] = value.clone();
        }
    }
    Ok(())
}

/// Validate ECMAScript flags before passing them to the JavaScript-compatible Rust engine.
fn pattern(rule: &Value) -> Result<regress::Regex, String> {
    let source = nonempty(&rule["value"])?;
    let flags = match rule.get("flags") {
        None => "",
        Some(flags) => flags.as_str().ok_or(DEFINITION_INVALID)?,
    };
    let mut seen = HashSet::new();
    if flags
        .chars()
        .any(|flag| !"dgimsuvy".contains(flag) || !seen.insert(flag))
        || (flags.contains('u') && flags.contains('v'))
    {
        return Err(DEFINITION_INVALID.into());
    }
    regress::Regex::with_flags(source, flags).map_err(|_| DEFINITION_INVALID.into())
}

/// Strip private input fields and verify rule syntax without running plugin code.
fn parse_rules(input: &Value) -> Result<Value, String> {
    let rules = input.as_array().ok_or(DEFINITION_INVALID)?;
    let mut result = Vec::new();
    for rule in rules {
        let kind = nonempty(&rule["type"])?;
        let mut clean = json!({"type":kind, "message":nonempty(&rule["message"])?});
        match kind {
            "required" => {}
            "minLength" | "maxLength" => {
                let count = rule["value"]
                    .as_f64()
                    .filter(|v| *v >= 0.0 && v.fract() == 0.0)
                    .ok_or(DEFINITION_INVALID)?;
                clean["value"] = json!(count);
            }
            "pattern" => {
                pattern(rule)?;
                clean["value"] = rule["value"].clone();
                copy_strings(rule, &mut clean, &["flags"])?;
            }
            _ => return Err(DEFINITION_INVALID.into()),
        }
        result.push(clean);
    }
    Ok(Value::Array(result))
}

/// Validate same-page conditions after the entire field tree has been collected.
fn parse_condition(input: &Value, plugin_id: &str) -> Result<Value, String> {
    if input.is_boolean() {
        return Ok(input.clone());
    }
    let id = namespaced_id(&input["fieldId"], plugin_id)?;
    if !matches!(input["operator"].as_str(), Some("equals" | "not-equals"))
        || !(input["value"].is_string()
            || input["value"].is_boolean()
            || input["value"].is_number())
    {
        return Err(DEFINITION_INVALID.into());
    }
    Ok(json!({"fieldId":id,"operator":input["operator"],"value":input["value"]}))
}

/// Parse bounded nested pages/groups into public SDK data and reject duplicate IDs.
fn parse_node(
    input: &Value,
    plugin_id: &str,
    ids: &mut HashSet<String>,
    depth: usize,
    field_only: bool,
) -> Result<Value, String> {
    if depth > MAX_DEFINITION_DEPTH || ids.len() >= MAX_DEFINITION_NODES {
        return Err(DEFINITION_INVALID.into());
    }
    let id = namespaced_id(&input["id"], plugin_id)?;
    if !ids.insert(id.into()) {
        return Err(DEFINITION_INVALID.into());
    }
    let kind = nonempty(&input["type"])?;
    if field_only && matches!(kind, "group" | "page" | "status") {
        return Err(DEFINITION_INVALID.into());
    }
    let mut node = json!({"id":id,"type":kind});
    let heading = if matches!(kind, "group" | "page") {
        "title"
    } else {
        "label"
    };
    node[heading] = json!(nonempty(&input[heading])?);
    copy_strings(input, &mut node, &["description"])?;
    for key in ["visible", "disabled"] {
        if kind == "status" && key == "disabled" {
            continue;
        }
        if let Some(value) = input.get(key) {
            node[key] = parse_condition(value, plugin_id)?;
        }
    }
    if matches!(kind, "group" | "page") {
        let items = input["items"].as_array().ok_or(DEFINITION_INVALID)?;
        node["items"] = Value::Array(
            items
                .iter()
                .map(|item| parse_node(item, plugin_id, ids, depth + 1, kind == "group"))
                .collect::<Result<Vec<_>, _>>()?,
        );
        return Ok(node);
    }
    if kind == "status" {
        copy_strings(input, &mut node, &["value"])?;
        return Ok(node);
    }
    if let Some(rules) = input.get("validate") {
        node["validate"] = parse_rules(rules)?;
        if !matches!(kind, "text" | "select") && !node["validate"].as_array().unwrap().is_empty() {
            return Err(DEFINITION_INVALID.into());
        }
    }
    match kind {
        "text" => {
            copy_strings(input, &mut node, &["defaultValue", "placeholder"])?;
        }
        "number" => {
            for key in ["defaultValue", "min", "max", "step"] {
                if let Some(value) = input.get(key) {
                    if value.as_f64().is_none() {
                        return Err(DEFINITION_INVALID.into());
                    }
                    node[key] = value.clone();
                }
            }
            if node["step"].as_f64().is_some_and(|step| step <= 0.0)
                || node["min"]
                    .as_f64()
                    .zip(node["max"].as_f64())
                    .is_some_and(|(min, max)| min > max)
            {
                return Err(DEFINITION_INVALID.into());
            }
        }
        "boolean" => {
            if let Some(default) = input.get("defaultValue") {
                if !default.is_boolean() {
                    return Err(DEFINITION_INVALID.into());
                }
                node["defaultValue"] = default.clone();
            }
        }
        "select" => {
            let options = input["options"]
                .as_array()
                .filter(|a| !a.is_empty())
                .ok_or(DEFINITION_INVALID)?;
            let mut values = HashSet::new();
            let mut clean = Vec::new();
            for option in options {
                let value = nonempty(&option["value"])?;
                if !values.insert(value) {
                    return Err(DEFINITION_INVALID.into());
                }
                clean.push(json!({"label":nonempty(&option["label"])?,"value":value}));
            }
            node["options"] = Value::Array(clean);
            copy_strings(input, &mut node, &["defaultValue"])?;
        }
        "file" | "folder" => {
            if let Some(default) = input.get("defaultValue") {
                let normalized = default
                    .as_str()
                    .ok_or(DEFINITION_INVALID)?
                    .replace('\\', "/");
                let normalized = normalized.trim();
                if !workspace_path(normalized) {
                    return Err(DEFINITION_INVALID.into());
                }
                node["defaultValue"] = json!(normalized);
            }
            if kind == "file" {
                if let Some(extensions) = input.get("extensions") {
                    let extensions = extensions
                        .as_array()
                        .filter(|a| !a.is_empty())
                        .ok_or(DEFINITION_INVALID)?;
                    let mut unique = HashSet::new();
                    let mut clean = Vec::new();
                    for extension in extensions {
                        let extension = nonempty(extension)?.trim().to_lowercase();
                        let rest = extension.strip_prefix('.').ok_or(DEFINITION_INVALID)?;
                        if rest.is_empty()
                            || !rest.as_bytes()[0].is_ascii_alphanumeric()
                            || !rest.bytes().all(|b| {
                                b.is_ascii_lowercase()
                                    || b.is_ascii_digit()
                                    || matches!(b, b'.' | b'_' | b'-')
                            })
                            || !unique.insert(extension.clone())
                        {
                            return Err(DEFINITION_INVALID.into());
                        }
                        clean.push(json!(extension));
                    }
                    node["extensions"] = Value::Array(clean);
                }
            }
        }
        _ => return Err(DEFINITION_INVALID.into()),
    }
    if let Some(default) = node.get("defaultValue") {
        // String validation rules may intentionally require the user to fill an empty default.
        let mut field = node.clone();
        field.as_object_mut().unwrap().remove("validate");
        validate_value(&field, default).map_err(|_| DEFINITION_INVALID)?;
    }
    Ok(node)
}

/// Check namespace/ownership, public properties and same-page condition references.
fn parse_page(plugin_id: &str, manifest: &Value, input: &Value) -> Result<Value, String> {
    let id = input["id"].as_str().ok_or("PLUGIN_INVALID_ARGUMENT")?;
    validate_page_id(manifest, id)?;
    namespaced_id(&input["id"], plugin_id)?;
    let mut page = json!({"id":id});
    copy_strings(input, &mut page, &["title", "description"])?;
    if page
        .get("title")
        .is_some_and(|title| nonempty(title).is_err())
    {
        return Err(DEFINITION_INVALID.into());
    }
    if let Some(definitions) = input.get("definitions") {
        let definitions = definitions.as_array().ok_or(DEFINITION_INVALID)?;
        let mut ids = HashSet::from([id.into()]);
        let nodes = definitions
            .iter()
            .map(|node| parse_node(node, plugin_id, &mut ids, 0, false))
            .collect::<Result<Vec<_>, _>>()?;
        let definitions = Value::Array(nodes);
        let fields = flatten_fields(&definitions);
        let field_ids: HashSet<_> = fields
            .iter()
            .filter_map(|field| field["id"].as_str())
            .collect();
        validate_conditions(&definitions, &field_ids)?;
        page["definitions"] = definitions;
    }
    Ok(page)
}

/// Validate condition targets after all nodes have been parsed, allowing forward references.
fn validate_conditions(nodes: &Value, ids: &HashSet<&str>) -> Result<(), String> {
    for node in nodes.as_array().into_iter().flatten() {
        for key in ["visible", "disabled"] {
            if let Some(id) = node[key]["fieldId"].as_str() {
                if !ids.contains(id) {
                    return Err(DEFINITION_INVALID.into());
                }
            }
        }
        if let Some(items) = node.get("items") {
            validate_conditions(items, ids)?;
        }
    }
    Ok(())
}

/// Nested pages/groups store values in the same flat field namespace; status has no value.
fn flatten_fields(definitions: &Value) -> Vec<Value> {
    definitions
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|node| match node["type"].as_str() {
            Some("page" | "group") => flatten_fields(&node["items"]),
            Some("status") => Vec::new(),
            _ => vec![node.clone()],
        })
        .collect()
}

/// Preserve compatibility with manifest fields when no runtime definition tree exists.
fn page_fields(page: &Value) -> Vec<Value> {
    page.get("definitions")
        .map(flatten_fields)
        .unwrap_or_else(|| page["fields"].as_array().cloned().unwrap_or_default())
}

/// Keep path-valued settings relative and reject Windows or POSIX escape forms.
fn workspace_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains([':', '\\', '\0'])
        && !path.split('/').any(|part| part.is_empty() || part == "..")
}

/// ECMAScript whitespace includes BOM but excludes Unicode NEL (unlike Rust trim()).
fn js_trim(text: &str) -> &str {
    text.trim_matches(|ch| {
        matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}'
        | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
    })
}

/// Match SDK value errors and JavaScript UTF-16 lengths/regex behavior on the Rust host.
pub(crate) fn validate_value(field: &Value, value: &Value) -> Result<(), String> {
    match field["type"].as_str() {
        Some("text") if value.is_string() => {}
        Some("boolean") if value.is_boolean() => {}
        Some("number") => {
            let number = value.as_f64().ok_or("PLUGIN_SETTING_VALUE_TYPE_INVALID")?;
            if field["min"].as_f64().is_some_and(|min| number < min)
                || field["max"].as_f64().is_some_and(|max| number > max)
            {
                return Err("PLUGIN_SETTING_VALUE_OUT_OF_RANGE".into());
            }
        }
        Some("select") => {
            let selected = value.as_str().ok_or("PLUGIN_SETTING_VALUE_TYPE_INVALID")?;
            if !field["options"].as_array().is_some_and(|options| {
                options
                    .iter()
                    .any(|option| option["value"].as_str() == Some(selected))
            }) {
                return Err("PLUGIN_SETTING_VALUE_INVALID_OPTION".into());
            }
        }
        Some("file" | "folder") => {
            let path = value
                .as_str()
                .filter(|path| workspace_path(path))
                .ok_or("PLUGIN_SETTING_VALUE_TYPE_INVALID")?;
            if field["type"] == "file"
                && field["extensions"].as_array().is_some_and(|extensions| {
                    !extensions.iter().any(|extension| {
                        extension
                            .as_str()
                            .is_some_and(|ext| path.to_lowercase().ends_with(ext))
                    })
                })
            {
                return Err("PLUGIN_SETTING_VALUE_TYPE_INVALID".into());
            }
        }
        _ => return Err("PLUGIN_SETTING_VALUE_TYPE_INVALID".into()),
    }
    if let Some(text) = value.as_str() {
        for rule in field["validate"].as_array().into_iter().flatten() {
            let failed = match rule["type"].as_str() {
                Some("required") => js_trim(text).is_empty(),
                Some("minLength") => {
                    (text.encode_utf16().count() as f64)
                        < rule["value"].as_f64().ok_or(DEFINITION_INVALID)?
                }
                Some("maxLength") => {
                    (text.encode_utf16().count() as f64)
                        > rule["value"].as_f64().ok_or(DEFINITION_INVALID)?
                }
                Some("pattern") => {
                    let regex = pattern(rule)?;
                    let units: Vec<_> = text.encode_utf16().collect();
                    let flags = rule["flags"].as_str().unwrap_or_default();
                    let found = if flags.contains('u') || flags.contains('v') {
                        regex.find_from_utf16(&units, 0).next()
                    } else {
                        regex.find_from_ucs2(&units, 0).next()
                    };
                    !found.is_some_and(|found| !flags.contains('y') || found.start() == 0)
                }
                _ => return Err(DEFINITION_INVALID.into()),
            };
            if failed {
                return Err("PLUGIN_SETTING_VALIDATION_FAILED".into());
            }
        }
    }
    Ok(())
}

/// Invalid historical values fall back to the current field default without rewriting disk.
fn normalized_value(field: &Value, values: &Map<String, Value>) -> Value {
    values
        .get(field["id"].as_str().unwrap_or_default())
        .filter(|value| super::plugin_setting_value_is_valid(field, value))
        .cloned()
        .unwrap_or_else(|| plugin_setting_default_value(field))
}

/// Missing fields mean an empty declared page, not an undeclared contribution.
pub(crate) fn project_values(page: &Value, values: &Map<String, Value>) -> Result<Value, String> {
    Ok(Value::Object(
        page_fields(page)
            .iter()
            .filter_map(|field| {
                field["id"]
                    .as_str()
                    .map(|id| (id.to_string(), normalized_value(field, values)))
            })
            .collect(),
    ))
}

/// Reject redirected data paths and bound the read before parsing persisted settings.
fn validate_data_path(path: &Path) -> Result<(), String> {
    for (index, candidate) in path.ancestors().take(4).enumerate() {
        match fs::symlink_metadata(candidate) {
            Ok(metadata)
                if metadata.file_type().is_symlink()
                    || (index == 0 && !metadata.is_file())
                    || (index > 0 && !metadata.is_dir()) =>
            {
                return Err("PLUGIN_SETTINGS_PATH_INVALID".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("PLUGIN_SETTINGS_PATH_INVALID".into()),
        }
    }
    Ok(())
}

/// Treat only a missing file as empty; corruption is surfaced before any mutation.
fn read_values(path: &Path) -> Result<Map<String, Value>, String> {
    validate_data_path(path)?;
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(_) => return Err("PLUGIN_SETTINGS_READ_FAILED".into()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_SETTINGS_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "PLUGIN_SETTINGS_READ_FAILED")?;
    if bytes.len() > MAX_SETTINGS_BYTES {
        return Err("PLUGIN_SETTINGS_TOO_LARGE".into());
    }
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| "PLUGIN_SETTINGS_INVALID".into())
}

/// Quota and validation failures never replace the last persisted snapshot.
fn write_values(path: &Path, values: &Map<String, Value>) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(values).map_err(|_| "PLUGIN_SETTINGS_INVALID")?;
    if bytes.len() > MAX_SETTINGS_BYTES {
        return Err("PLUGIN_SETTINGS_TOO_LARGE".into());
    }
    validate_data_path(path)?;
    let directory = path.parent().ok_or("PLUGIN_SETTINGS_PATH_INVALID")?;
    fs::create_dir_all(directory).map_err(|_| "PLUGIN_SETTINGS_WRITE_FAILED")?;
    let temporary = directory.join(format!("settings.{}.tmp", uuid::Uuid::new_v4()));
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
        let _ = fs::remove_file(&temporary);
        return Err("PLUGIN_SETTINGS_WRITE_FAILED".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const PLUGIN: &str = "com.example.reader";
    const PAGE: &str = "com.example.reader.appearance";
    const FIELD: &str = "com.example.reader.theme";

    /// Isolated test data is removed even when a regression assertion fails.
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("wstudio-settings-{}", uuid::Uuid::new_v4())))
        }
        fn path(&self) -> PathBuf {
            self.0.join("plugins/data/com.example.reader/settings.json")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn manifest() -> Value {
        json!({"contributes":{"settings":[
            {"id":PAGE,"title":"Appearance","fields":[
                {"id":FIELD,"type":"text","label":"Theme","defaultValue":"static"}
            ]},
            {"id":"com.example.reader.network","title":"Network","fields":[
                {"id":"com.example.reader.retry","type":"number","label":"Retry","min":1}
            ]}
        ]}})
    }

    fn runtime_page(title: &str) -> Value {
        json!({"id":PAGE,"title":title,"privatePath":"E:/private", "definitions":[
            {"type":"page","id":"com.example.reader.details","title":"Details","items":[
                {"type":"group","id":"com.example.reader.group","title":"Theme","items":[
                    {"id":FIELD,"type":"text","label":"Theme","defaultValue":"runtime",
                     "internal":42,"validate":[{"type":"minLength","value":2,"message":"Too short"}]},
                    {"id":"com.example.reader.enabled","type":"boolean","label":"Enabled"}
                ]},
                {"type":"status","id":"com.example.reader.status","label":"Status","value":"Ready",
                 "visible":{"fieldId":"com.example.reader.enabled","operator":"equals","value":true}}
            ]}
        ]})
    }

    #[test]
    fn nested_definitions_are_shared_sanitized_and_flattened_for_settings_queries() {
        let state = PluginSettingsState::default();
        let f = Fixture::new();
        state
            .register(
                "editor",
                PLUGIN,
                &manifest(),
                &runtime_page("Runtime"),
                &|| Ok(()),
            )
            .unwrap();
        let pages = state.resolve(PLUGIN, &manifest()).unwrap();
        assert_eq!(pages[0]["title"], "Runtime");
        assert_eq!(pages[0]["fields"].as_array().unwrap().len(), 2);
        assert!(pages[0].get("privatePath").is_none());
        assert!(pages[0]["fields"][0].get("internal").is_none());
        assert_eq!(
            state
                .get_page(PLUGIN, &manifest(), PAGE, &f.path())
                .unwrap(),
            json!({FIELD:"runtime","com.example.reader.enabled":false})
        );
        assert_eq!(
            state
                .get_field(PLUGIN, &manifest(), FIELD, &f.path())
                .unwrap(),
            "runtime"
        );
        assert_eq!(
            state
                .get_field(PLUGIN, &manifest(), "other.field", &f.path())
                .unwrap_err(),
            "PLUGIN_CONTRIBUTION_NOT_DECLARED"
        );
    }

    #[test]
    fn ownership_lifecycle_restores_earlier_window_then_manifest_without_deleting_values() {
        let state = PluginSettingsState::default();
        let f = Fixture::new();
        state
            .register(
                "first",
                PLUGIN,
                &manifest(),
                &runtime_page("First"),
                &|| Ok(()),
            )
            .unwrap();
        state
            .register(
                "second",
                PLUGIN,
                &manifest(),
                &runtime_page("Second"),
                &|| Ok(()),
            )
            .unwrap();
        state
            .set_field(PLUGIN, &manifest(), PAGE, FIELD, &json!("saved"), &f.path())
            .unwrap();
        assert_eq!(
            state.resolve(PLUGIN, &manifest()).unwrap()[0]["title"],
            "Second"
        );
        state
            .unregister("unrelated", PLUGIN, &manifest(), PAGE, &|| Ok(()))
            .unwrap();
        assert_eq!(
            state.resolve(PLUGIN, &manifest()).unwrap()[0]["title"],
            "Second"
        );
        assert_eq!(state.dispose_window("second"), vec![PLUGIN]);
        assert_eq!(
            state.resolve(PLUGIN, &manifest()).unwrap()[0]["title"],
            "First"
        );
        assert_eq!(
            state.resolve("another.plugin", &manifest()).unwrap()[0]["title"],
            "Appearance"
        );
        state
            .unregister("first", PLUGIN, &manifest(), PAGE, &|| Ok(()))
            .unwrap();
        state
            .unregister("first", PLUGIN, &manifest(), PAGE, &|| Ok(()))
            .unwrap();
        assert_eq!(
            state.resolve(PLUGIN, &manifest()).unwrap(),
            manifest()["contributes"]["settings"]
        );
        assert_eq!(
            state
                .get_field(PLUGIN, &manifest(), FIELD, &f.path())
                .unwrap(),
            "saved"
        );
        state
            .register(
                "first",
                PLUGIN,
                &manifest(),
                &runtime_page("Restored"),
                &|| Ok(()),
            )
            .unwrap();
        assert_eq!(
            state
                .get_field(PLUGIN, &manifest(), FIELD, &f.path())
                .unwrap(),
            "saved"
        );
    }

    #[test]
    fn bad_definitions_and_cross_page_collisions_leave_previous_registration_intact() {
        let state = PluginSettingsState::default();
        state
            .register("main", PLUGIN, &manifest(), &runtime_page("Valid"), &|| {
                Ok(())
            })
            .unwrap();
        let field = json!({"id":FIELD,"type":"text","label":"Theme"});
        let invalid = vec![
            json!({"id":PAGE,"definitions":[field.clone(),field.clone()]}),
            json!({"id":PAGE,"definitions":[{"id":"other.field","type":"text","label":"Bad"}]}),
            json!({"id":PAGE,"definitions":[{"id":FIELD,"type":"text","label":"Bad",
                "visible":{"fieldId":"com.example.reader.missing","operator":"equals","value":true}}]}),
            json!({"id":PAGE,"definitions":[{"id":FIELD,"type":"select","label":"Bad",
                "options":[{"label":"A","value":"same"},{"label":"B","value":"same"}]}]}),
            json!({"id":PAGE,"definitions":[{"id":FIELD,"type":"number","label":"Bad","min":5,"max":1}]}),
            json!({"id":PAGE,"definitions":[{"id":FIELD,"type":"number","label":"Bad","step":0}]}),
            json!({"id":PAGE,"definitions":[{"id":FIELD,"type":"boolean","label":"Bad","defaultValue":"true"}]}),
            json!({"id":PAGE,"definitions":[{"id":FIELD,"type":"folder","label":"Bad","defaultValue":"../secret"}]}),
            json!({"id":PAGE,"definitions":[{"id":FIELD,"type":"file","label":"Bad","extensions":["md"]}]}),
            json!({"id":PAGE,"definitions":[{"id":FIELD,"type":"file","label":"Bad","extensions":[".md"],"defaultValue":"file.txt"}]}),
            json!({"id":PAGE,"definitions":[{"id":FIELD,"type":"text","label":"Bad",
                "validate":[{"type":"pattern","value":"[","message":"Bad"}]}]}),
            json!({"id":PAGE,"definitions":[{"id":FIELD,"type":"text","label":"Bad",
                "validate":[{"type":"pattern","value":"x","flags":"ii","message":"Bad"}]}]}),
            json!({"id":PAGE,"definitions":[{"id":FIELD,"type":"boolean","label":"Bad",
                "validate":[{"type":"required","message":"Bad"}]}]}),
            json!({"id":PAGE,"definitions":[{"id":"com.example.reader.retry","type":"text","label":"Collision"}]}),
            json!({"id":PAGE,"definitions":[{"id":"com.example.reader.group","type":"group","title":"Bad",
                "items":[{"id":FIELD,"type":"status","label":"Nested status"}]}]}),
        ];
        for page in invalid {
            assert_eq!(
                state
                    .register("main", PLUGIN, &manifest(), &page, &|| Ok(()))
                    .unwrap_err(),
                DEFINITION_INVALID,
                "{page}"
            );
            assert_eq!(
                state.resolve(PLUGIN, &manifest()).unwrap()[0]["title"],
                "Valid"
            );
        }
        assert_eq!(
            state
                .register(
                    "main",
                    PLUGIN,
                    &manifest(),
                    &json!({"id":"other.page"}),
                    &|| Ok(())
                )
                .unwrap_err(),
            "PLUGIN_CONTRIBUTION_NOT_DECLARED"
        );
        assert_eq!(
            state
                .unregister("main", PLUGIN, &manifest(), "", &|| Ok(()))
                .unwrap_err(),
            "PLUGIN_INVALID_ARGUMENT"
        );
        let network = json!({"id":"com.example.reader.network","definitions":[field]});
        assert_eq!(
            state
                .register("main", PLUGIN, &manifest(), &network, &|| Ok(()))
                .unwrap_err(),
            DEFINITION_INVALID
        );
    }

    #[test]
    fn timed_out_or_closed_owner_cannot_commit_a_registration_or_unregister() {
        let state = PluginSettingsState::default();
        let guard = || Err("PLUGIN_REQUEST_TIMEOUT".into());
        assert_eq!(
            state
                .register("main", PLUGIN, &manifest(), &runtime_page("Late"), &guard)
                .unwrap_err(),
            "PLUGIN_REQUEST_TIMEOUT"
        );
        assert_eq!(
            state.resolve(PLUGIN, &manifest()).unwrap()[0]["title"],
            "Appearance"
        );
        state
            .register("main", PLUGIN, &manifest(), &runtime_page("Valid"), &|| {
                Ok(())
            })
            .unwrap();
        assert_eq!(
            state
                .unregister("main", PLUGIN, &manifest(), PAGE, &|| Err(
                    "PLUGIN_RUNTIME_TERMINATED".into()
                ))
                .unwrap_err(),
            "PLUGIN_RUNTIME_TERMINATED"
        );
        assert_eq!(
            state.resolve(PLUGIN, &manifest()).unwrap()[0]["title"],
            "Valid"
        );
    }

    #[test]
    fn empty_and_metadata_only_pages_keep_static_fallback_and_bound_nested_input() {
        let state = PluginSettingsState::default();
        let f = Fixture::new();
        state
            .register(
                "main",
                PLUGIN,
                &manifest(),
                &json!({"id":PAGE,"title":"Title"}),
                &|| Ok(()),
            )
            .unwrap();
        assert_eq!(
            state
                .get_field(PLUGIN, &manifest(), FIELD, &f.path())
                .unwrap(),
            "static"
        );
        state
            .register(
                "main",
                PLUGIN,
                &manifest(),
                &json!({"id":PAGE,"definitions":[]}),
                &|| Ok(()),
            )
            .unwrap();
        assert_eq!(
            state
                .get_page(PLUGIN, &manifest(), PAGE, &f.path())
                .unwrap(),
            json!({})
        );
        assert_eq!(
            state
                .get_field(PLUGIN, &manifest(), FIELD, &f.path())
                .unwrap_err(),
            "PLUGIN_CONTRIBUTION_NOT_DECLARED"
        );
        let mut nested = json!({"id":FIELD,"type":"text","label":"Text"});
        for i in 0..=MAX_DEFINITION_DEPTH + 1 {
            nested = json!({"id":format!("com.example.reader.page-{i}"),"type":"page","title":"Nested","items":[nested]});
        }
        assert_eq!(
            parse_page(
                PLUGIN,
                &manifest(),
                &json!({"id":PAGE,"definitions":[nested]})
            )
            .unwrap_err(),
            DEFINITION_INVALID
        );
    }

    #[test]
    fn setting_rules_match_javascript_utf16_flags_lookarounds_and_backreferences() {
        let field = |rule: Value| json!({"type":"text","validate":[rule]});
        for (rule, accepted, rejected) in [
            (
                json!({"type":"required","message":"Required"}),
                "value",
                " \t",
            ),
            (
                json!({"type":"minLength","value":2,"message":"Length"}),
                "😀",
                "a",
            ),
            (
                json!({"type":"maxLength","value":1,"message":"Length"}),
                "a",
                "😀",
            ),
            (
                json!({"type":"pattern","value":"^(a)\\1$","flags":"i","message":"Pattern"}),
                "AA",
                "AB",
            ),
            (
                json!({"type":"pattern","value":"(?<=a)b","message":"Pattern"}),
                "ab",
                "cb",
            ),
            (
                json!({"type":"pattern","value":"b","flags":"y","message":"Pattern"}),
                "b",
                "ab",
            ),
            (
                json!({"type":"pattern","value":"^.$","flags":"u","message":"Pattern"}),
                "😀",
                "ab",
            ),
            (
                json!({"type":"pattern","value":"^.$","flags":"v","message":"Pattern"}),
                "😀",
                "ab",
            ),
            (
                json!({"type":"pattern","value":"^.$","message":"Pattern"}),
                "a",
                "😀",
            ),
            (
                json!({"type":"pattern","value":"^[\\p{ASCII}&&\\p{Letter}]+$","flags":"v","message":"Pattern"}),
                "Ab",
                "12",
            ),
            (
                json!({"type":"pattern","value":"b","flags":"dg","message":"Pattern"}),
                "ab",
                "ac",
            ),
        ] {
            assert!(
                validate_value(&field(rule.clone()), &json!(accepted)).is_ok(),
                "{rule}"
            );
            assert_eq!(
                validate_value(&field(rule.clone()), &json!(rejected)).unwrap_err(),
                "PLUGIN_SETTING_VALIDATION_FAILED",
                "{rule}"
            );
        }
        assert_eq!(
            validate_value(
                &field(json!({"type":"required","message":"Required"})),
                &json!("\u{feff}")
            )
            .unwrap_err(),
            "PLUGIN_SETTING_VALIDATION_FAILED"
        );
        assert!(validate_value(
            &field(json!({"type":"required","message":"Required"})),
            &json!("\u{0085}")
        )
        .is_ok());
        assert_eq!(
            validate_value(&json!({"type":"number","min":2}), &json!(1)).unwrap_err(),
            "PLUGIN_SETTING_VALUE_OUT_OF_RANGE"
        );
        assert_eq!(
            validate_value(&json!({"type":"boolean"}), &json!("false")).unwrap_err(),
            "PLUGIN_SETTING_VALUE_TYPE_INVALID"
        );
        assert_eq!(
            validate_value(
                &json!({"type":"select","options":[{"value":"yes"}]}),
                &json!("no")
            )
            .unwrap_err(),
            "PLUGIN_SETTING_VALUE_INVALID_OPTION"
        );
        for path in ["../secret", "C:/secret", "dir\\..\\secret", "/absolute"] {
            assert!(validate_value(&json!({"type":"folder"}), &json!(path)).is_err());
        }
    }

    #[test]
    fn concurrent_page_writes_preserve_other_fields_and_reject_bad_values_without_mutation() {
        let state = PluginSettingsState::default();
        let f = Fixture::new();
        let path = f.path();
        let manifest = manifest();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                state
                    .set_field(PLUGIN, &manifest, PAGE, FIELD, &json!("saved"), &path)
                    .unwrap()
            });
            scope.spawn(|| {
                state
                    .set_field(
                        PLUGIN,
                        &manifest,
                        "com.example.reader.network",
                        "com.example.reader.retry",
                        &json!(3),
                        &path,
                    )
                    .unwrap()
            });
        });
        assert_eq!(
            read_values(&path).unwrap(),
            json!({FIELD:"saved","com.example.reader.retry":3})
                .as_object()
                .unwrap()
                .clone()
        );
        let before = fs::read(&path).unwrap();
        assert_eq!(
            state
                .set_field(
                    PLUGIN,
                    &manifest,
                    PAGE,
                    "com.example.reader.retry",
                    &json!(4),
                    &path
                )
                .unwrap_err(),
            "PLUGIN_SETTING_FIELD_NOT_DECLARED"
        );
        assert_eq!(
            state
                .set_field(PLUGIN, &manifest, PAGE, FIELD, &json!(false), &path)
                .unwrap_err(),
            "PLUGIN_SETTING_VALUE_TYPE_INVALID"
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn corrupted_files_quota_failures_and_redirected_paths_do_not_replace_saved_settings() {
        let f = Fixture::new();
        let path = f.path();
        let original = json!({FIELD:"saved"}).as_object().unwrap().clone();
        write_values(&path, &original).unwrap();
        let before = fs::read(&path).unwrap();
        let oversized = json!({FIELD:"x".repeat(MAX_SETTINGS_BYTES)})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(
            write_values(&path, &oversized).unwrap_err(),
            "PLUGIN_SETTINGS_TOO_LARGE"
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::write(&path, b"broken").unwrap();
        let state = PluginSettingsState::default();
        assert_eq!(
            state
                .set_field(
                    PLUGIN,
                    &manifest(),
                    PAGE,
                    FIELD,
                    &json!("replacement"),
                    &path
                )
                .unwrap_err(),
            "PLUGIN_SETTINGS_INVALID"
        );
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        assert_eq!(
            read_values(path.parent().unwrap()).unwrap_err(),
            "PLUGIN_SETTINGS_PATH_INVALID"
        );
    }
}
