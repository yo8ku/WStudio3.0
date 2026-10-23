//! Trusted renderer plugin RPC boundary: protocol validation, quotas and initial routes.
use super::{
    find_active_plugin_manifest, plugin_path_has_permission, plugin_permission_is_declared,
    plugin_relative_components, relative_path, repository_summary, resolve_plugin_existing_path,
    validate_plugin_command, workspace_list_plugin_markdown_files,
    workspace_open_recent_repository, workspace_read_markdown_file,
    workspace_remove_recent_repository, workspace_rename_recent_repository, workspace_root,
    MarkdownFile, UpdateMarkdownRequest, UpdateMarkdownResult, WorkspaceState,
    MAX_PLUGIN_TEXT_FILE_SIZE,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Window};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const MAX_PAYLOAD: usize = 512 * 1024;
const MAX_PLUGIN_MARKDOWN_FILES: usize = 2_000;
const RATE_WINDOW_MS: u64 = 10_000;
const MAX_REQUESTS: usize = 500;
const MAX_INTERACTIVE_TIMEOUT_MS: u64 = 5 * 60 * 1_000;
const MAX_NETWORK_BODY: usize = 256 * 1024;
const MAX_NETWORK_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_NETWORK_HEADERS: usize = 64;
const MAX_LOG_MESSAGE_BYTES: usize = 4 * 1024;
const MAX_LOG_DETAILS_BYTES: usize = 32 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    plugin_id: String,
    request: Request,
    view: Option<ViewScope>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    #[serde(default)]
    runtime_id: String,
    protocol_version: u8,
    request_id: String,
    method: String,
    params: Value,
    deadline: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewScope {
    view_type: String,
    instance_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Response {
    protocol_version: u8,
    request_id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
struct RpcError {
    code: String,
    message: String,
}

#[derive(Default)]
struct WindowQuota {
    started_at: u64,
    requests: usize,
    request_ids: HashSet<String>,
}

#[derive(Default)]
struct Registrations {
    quotas: HashMap<(String, String), WindowQuota>,
    commands: HashMap<(String, String), HashSet<String>>,
    status_items: HashMap<(String, String), HashMap<String, Option<Value>>>,
}

#[derive(Default)]
pub(crate) struct PluginRpcState {
    registrations: Mutex<Registrations>,
}

impl PluginRpcState {
    /// Clear all registrations owned by a stopped/regranted plugin across windows.
    pub(crate) fn dispose_plugin(&self, plugin: &str) {
        if let Ok(mut state) = self.registrations.lock() {
            state.quotas.retain(|(_, id), _| id != plugin);
            state.commands.retain(|(_, id), _| id != plugin);
            state.status_items.retain(|(_, id), _| id != plugin);
        }
    }
    /// Release contributions, commands and rate-limit memory owned by a closed window.
    pub(crate) fn dispose_window(&self, label: &str) {
        if let Ok(mut state) = self.registrations.lock() {
            state.quotas.retain(|(window, _), _| window != label);
            state.commands.retain(|(window, _), _| window != label);
            state.status_items.retain(|(window, _), _| window != label);
        }
    }

    /// Overlay runtime status items on the calling window's manifest contributions.
    pub(crate) fn merge_status_items(
        &self,
        window: &str,
        plugin_id: &str,
        manifest_items: &Value,
    ) -> Result<Value, String> {
        let state = self.registrations.lock().map_err(|_| "PLUGIN_API_FAILED")?;
        Ok(status_items_snapshot(
            manifest_items,
            state
                .status_items
                .get(&(window.to_string(), plugin_id.to_string())),
        ))
    }
}

/// Manifest order is stable; removed items stay hidden until registered again.
fn status_items_snapshot(
    manifest_items: &Value,
    overrides: Option<&HashMap<String, Option<Value>>>,
) -> Value {
    Value::Array(
        manifest_items
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(
                |item| match overrides.and_then(|items| items.get(item["id"].as_str()?)) {
                    Some(value) => value.clone(),
                    None => Some(item.clone()),
                },
            )
            .collect(),
    )
}

/// Only status item IDs declared by this plugin may be registered or removed.
fn validate_status_item_id(manifest: &Value, id: &str) -> Result<(), String> {
    if id.trim().is_empty() || id.len() > 256 {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    if !manifest["contributes"]["statusBar"]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item["id"].as_str() == Some(id)))
    {
        return Err("PLUGIN_CONTRIBUTION_NOT_DECLARED".into());
    }
    Ok(())
}

/// Bound display strings and retain only public status item fields.
fn read_status_item(manifest: &Value, params: &Value) -> Result<Value, String> {
    let item = &params["item"];
    let id = required_string(item, "id")?;
    validate_status_item_id(manifest, id)?;
    let text = item["text"].as_str().ok_or("PLUGIN_INVALID_ARGUMENT")?;
    if text.len() > 4_096 {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    let mut result = serde_json::json!({ "id": id, "text": text });
    if let Some(tooltip) = item.get("tooltip") {
        let tooltip = tooltip.as_str().ok_or("PLUGIN_INVALID_ARGUMENT")?;
        if tooltip.len() > 4_096 {
            return Err("PLUGIN_INVALID_ARGUMENT".into());
        }
        result["tooltip"] = Value::String(tooltip.to_string());
    }
    Ok(result)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

/// Validate the envelope before identity resolution or side effects.
fn validate_envelope(raw: &Value, now: u64) -> Result<Envelope, String> {
    if serde_json::to_vec(raw)
        .map_err(|_| "PLUGIN_INVALID_ARGUMENT")?
        .len()
        > MAX_PAYLOAD
    {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    let envelope: Envelope =
        serde_json::from_value(raw.clone()).map_err(|_| "PLUGIN_INVALID_ARGUMENT")?;
    let request = &envelope.request;
    if request.protocol_version != 1
        || request.request_id.trim().is_empty()
        || request.request_id.len() > 256
        || request.method.trim().is_empty()
        || request.method.len() > 128
        || envelope.plugin_id.trim().is_empty()
        || envelope.plugin_id.len() > 256
    {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    if request.deadline <= now {
        return Err("PLUGIN_REQUEST_TIMEOUT".into());
    }
    Ok(envelope)
}

/// Count requests per plugin and originating window, with bounded replay memory.
fn admit_request(quota: &mut WindowQuota, request: &Request, now: u64) -> Result<(), String> {
    if now.saturating_sub(quota.started_at) >= RATE_WINDOW_MS {
        *quota = WindowQuota {
            started_at: now,
            ..Default::default()
        };
    }
    if quota.requests >= MAX_REQUESTS {
        return Err("PLUGIN_RATE_LIMITED".into());
    }
    quota.requests += 1;
    if !quota.request_ids.insert(request.request_id.clone()) {
        return Err("PLUGIN_REQUEST_REPLAYED".into());
    }
    Ok(())
}

/// Validate view contributions and prevent activation-only methods in a view.
fn validate_view(manifest: &Value, envelope: &Envelope) -> Result<(), String> {
    if let Some(view) = &envelope.view {
        if view.instance_id.trim().is_empty() || view.instance_id.len() > 256 {
            return Err("PLUGIN_INVALID_ARGUMENT".into());
        }
        let declared = manifest["contributes"]["views"]
            .as_array()
            .is_some_and(|views| {
                views
                    .iter()
                    .any(|item| item["type"].as_str() == Some(view.view_type.as_str()))
            });
        if !declared {
            return Err("PLUGIN_CONTRIBUTION_NOT_DECLARED".into());
        }
        if matches!(
            envelope.request.method.as_str(),
            "registerCommand"
                | "unregisterCommand"
                | "statusBar.registerItem"
                | "statusBar.unregisterItem"
                | "settings.registerPage"
                | "settings.unregisterPage"
        ) {
            return Err("PLUGIN_VIEW_METHOD_FORBIDDEN".into());
        }
    }
    Ok(())
}

fn required_string<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "PLUGIN_INVALID_ARGUMENT".into())
}

/// Sidecar calls pass through the same explicit per-method capability gate as
/// the shared renderer route. Prefix inference is intentionally avoided.
fn validate_sidecar_capability(manifest: &Value, method: &str) -> Result<(), String> {
    let permissions: &[&str] = match method {
        "network.request" => &["network.request"],
        "filesystem.listFiles"
        | "filesystem.listEntries"
        | "filesystem.stat"
        | "filesystem.readText"
        | "workspace.getRepository"
        | "workspace.listMarkdownFiles"
        | "workspace.readMarkdownFile"
        | "workspace.listRecentRepositories" => &["workspace.read"],
        "filesystem.writeText"
        | "filesystem.createFile"
        | "filesystem.createDirectory"
        | "filesystem.delete"
        | "filesystem.move"
        | "filesystem.rename"
        | "workspace.updateMarkdownFile" => &["workspace.write"],
        "filesystem.copy" | "filesystem.encrypt" | "filesystem.decrypt" => {
            &["workspace.read", "workspace.write"]
        }
        "storage.get" | "storage.set" | "storage.delete" => &["storage.plugin"],
        "window.list" | "window.open" | "window.update" | "window.focus" | "window.close" => {
            &["window.manage"]
        }
        "editor.getActiveDocument" => &["editor.read"],
        "editor.openFile" => &["workspace.read", "editor.write"],
        "editor.revealRange" => &["editor.read", "editor.write"],
        "editor.closeTab" | "editor.closeTabs" | "editor.closeAllTabs" => &["editor.write"],
        "editor.applyTextChange" => &["editor.write"],
        "workspace.openRepository" => &["workspace.open"],
        "workspace.createRepository" => &["workspace.open", "workspace.write"],
        "workspace.openFile" => &["workspace.open", "editor.write"],
        "workspace.openRecentRepository" => &["workspace.open"],
        "workspace.renameRecentRepository" | "workspace.moveRecentRepository" => {
            &["workspace.open", "workspace.write"]
        }
        "workspace.revealRecentRepository" => &["workspace.read", "external.open"],
        "workspace.removeRecentRepository" => &["workspace.write"],
        "workspace.openWithDefaultApp" | "workspace.revealInFileManager" => {
            &["workspace.read", "external.open"]
        }
        "workspace.copyPath" => &["workspace.read", "clipboard.write"],
        "dialogs.pick" | "dialogs.repositoryManager" | "dialogs.prompt" | "dialogs.confirm" => {
            &["dialogs.show"]
        }
        "notifications.show" => &["notifications.show"],
        "notifications.showSystem" => &["notifications.system"],
        "log" => &[],
        "webViewer.open"
        | "webViewer.list"
        | "webViewer.activate"
        | "webViewer.navigate"
        | "webViewer.back"
        | "webViewer.forward"
        | "webViewer.reload"
        | "webViewer.close"
        | "webViewer.executeAction" => &["webViewer.navigate"],
        "registerCommand"
        | "unregisterCommand"
        | "statusBar.registerItem"
        | "statusBar.unregisterItem"
        | "settings.registerPage"
        | "settings.unregisterPage"
        | "settings.get"
        | "workspace.openView"
        | "workspace.closeView"
        | "runtimeReady"
        | "runtimeFailed" => &[],
        _ => return Err("PLUGIN_API_UNAVAILABLE".into()),
    };
    for permission in permissions {
        validate_permission(manifest, permission)?;
    }
    Ok(())
}

fn dispatch_network_request(
    manifest: &Value,
    app: &AppHandle,
    window_label: &str,
    params: &Value,
    deadline: u64,
) -> Result<Value, String> {
    validate_permission(manifest, "network.request")?;
    let object = params.as_object().ok_or("PLUGIN_INVALID_ARGUMENT")?;
    let url = object
        .get("url")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or("PLUGIN_INVALID_ARGUMENT")?;
    let parsed = reqwest::Url::parse(url).map_err(|_| "PLUGIN_INVALID_ARGUMENT")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("GET")
        .to_ascii_uppercase();
    if !matches!(
        method.as_str(),
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"
    ) {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    let body = object.get("body").and_then(Value::as_str).unwrap_or("");
    if body.len() > MAX_NETWORK_BODY {
        return Err("PLUGIN_RESPONSE_TOO_LARGE".into());
    }
    let timeout_ms = deadline.saturating_sub(now_ms()).min(15_000).max(1);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|_| "PLUGIN_NETWORK_FAILED")?;
    let mut request = client.request(
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "PLUGIN_INVALID_ARGUMENT")?,
        parsed,
    );
    if let Some(headers) = object.get("headers") {
        let headers = headers.as_object().ok_or("PLUGIN_INVALID_ARGUMENT")?;
        if headers.len() > MAX_NETWORK_HEADERS {
            return Err("PLUGIN_INVALID_ARGUMENT".into());
        }
        for (name, value) in headers {
            let value = value.as_str().ok_or("PLUGIN_INVALID_ARGUMENT")?;
            let header_name = reqwest::header::HeaderName::try_from(name)
                .map_err(|_| "PLUGIN_INVALID_ARGUMENT")?;
            let header_value = reqwest::header::HeaderValue::try_from(value)
                .map_err(|_| "PLUGIN_INVALID_ARGUMENT")?;
            request = request.header(header_name, header_value);
        }
    }
    if !body.is_empty() {
        request = request.body(body.to_owned());
    }
    ensure_request_active(app, window_label, deadline)?;
    let response = tauri::async_runtime::block_on(async {
        let response = request
            .send()
            .await
            .map_err(|_| "PLUGIN_NETWORK_FAILED".to_string())?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.to_string(), value.to_string()))
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "PLUGIN_NETWORK_FAILED".to_string())?;
        if bytes.len() > MAX_NETWORK_RESPONSE {
            return Err("PLUGIN_RESPONSE_TOO_LARGE".to_string());
        }
        let body =
            String::from_utf8(bytes.to_vec()).map_err(|_| "PLUGIN_NETWORK_ENCODING_UNSUPPORTED")?;
        Ok::<_, String>(serde_json::json!({ "status": status, "headers": headers, "body": body }))
    })?;
    ensure_request_active(app, window_label, deadline)?;
    Ok(response)
}

/// Query permissions are checked without granting access to any filesystem path.
fn validate_repository_permission(manifest: &Value) -> Result<(), String> {
    validate_permission(manifest, "workspace.read")
}

fn validate_permission(manifest: &Value, permission: &str) -> Result<(), String> {
    if plugin_permission_is_declared(manifest, permission) {
        Ok(())
    } else {
        Err("PLUGIN_PERMISSION_DENIED".into())
    }
}

/// Validate and emit a bounded diagnostic message without exposing host paths.
fn dispatch_plugin_log(plugin_id: &str, params: &Value) -> Result<Value, String> {
    let object = params.as_object().ok_or("PLUGIN_INVALID_ARGUMENT")?;
    let level = object
        .get("level")
        .and_then(Value::as_str)
        .unwrap_or("info");
    if !matches!(level, "debug" | "info" | "warn" | "error") {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    let message = object
        .get("message")
        .and_then(Value::as_str)
        .ok_or("PLUGIN_INVALID_ARGUMENT")?;
    if message.trim().is_empty() || message.len() > MAX_LOG_MESSAGE_BYTES {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    let details = object.get("details").cloned().unwrap_or(Value::Null);
    let details_bytes = serde_json::to_vec(&details).map_err(|_| "PLUGIN_INVALID_ARGUMENT")?;
    if details_bytes.len() > MAX_LOG_DETAILS_BYTES {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    let prefix = format!("[plugin:{plugin_id}]");
    match level {
        "debug" => eprintln!("{prefix} DEBUG {message} {details}"),
        "warn" => eprintln!("{prefix} WARN {message} {details}"),
        "error" => eprintln!("{prefix} ERROR {message} {details}"),
        _ => eprintln!("{prefix} INFO {message} {details}"),
    }
    Ok(Value::Null)
}

fn validate_declared_view(manifest: &Value, view_type: &str) -> Result<(), String> {
    if view_type.trim().is_empty() || view_type.len() > 256 {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    if manifest["contributes"]["views"]
        .as_array()
        .is_some_and(|views| {
            views
                .iter()
                .any(|view| view["type"].as_str() == Some(view_type))
        })
    {
        Ok(())
    } else {
        Err("PLUGIN_CONTRIBUTION_NOT_DECLARED".into())
    }
}

fn dispatch_view_lifecycle(
    app: &AppHandle,
    window_label: &str,
    plugin_id: &str,
    manifest: &Value,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    let view_type = required_string(params, "viewType")?;
    validate_declared_view(manifest, view_type)?;
    if method == "workspace.openView" {
        let instance_id = params
            .get("options")
            .and_then(Value::as_object)
            .and_then(|options| options.get("instanceId"))
            .map(|value| value.as_str().ok_or("PLUGIN_INVALID_ARGUMENT"))
            .transpose()?
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        if instance_id.len() > 256 {
            return Err("PLUGIN_INVALID_ARGUMENT".into());
        }
        app.emit_to(
            window_label,
            "plugin:viewOpenRequested",
            serde_json::json!({
                "pluginId": plugin_id,
                "viewType": view_type,
                "instanceId": instance_id
            }),
        )
        .map_err(|_| "PLUGIN_API_FAILED".to_string())?;
        return Ok(serde_json::json!({ "viewType": view_type, "instanceId": instance_id }));
    }

    let instance_id = params
        .get("instanceId")
        .map(|value| value.as_str().ok_or("PLUGIN_INVALID_ARGUMENT"))
        .transpose()?
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned);
    if instance_id
        .as_deref()
        .is_some_and(|value| value.len() > 256)
    {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    let mut event = serde_json::json!({
        "pluginId": plugin_id,
        "viewType": view_type
    });
    if let Some(instance_id) = instance_id {
        event["instanceId"] = Value::String(instance_id);
    }
    app.emit_to(window_label, "plugin:viewCloseRequested", event)
        .map_err(|_| "PLUGIN_API_FAILED".to_string())?;
    Ok(Value::Null)
}

fn map_workspace_error(error: &str) -> String {
    if error.starts_with("PLUGIN_")
        && error
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte == b'_')
    {
        return error.to_string();
    }
    match error {
        "not-found"
        | "WORKSPACE_RECENT_REPOSITORY_NOT_FOUND"
        | "WORKSPACE_REPOSITORY_NOT_FOUND" => "PLUGIN_FILESYSTEM_NOT_FOUND".into(),
        "outside-workspace" | "PLUGIN_FILESYSTEM_PATH_INVALID" => {
            "PLUGIN_FILESYSTEM_PATH_INVALID".into()
        }
        "unsupported-encoding" => "PLUGIN_FILESYSTEM_ENCODING_UNSUPPORTED".into(),
        "unsupported-extension" => "PLUGIN_FILESYSTEM_UNSUPPORTED_EXTENSION".into(),
        "WORKSPACE_REPOSITORY_NAME_INVALID" => "PLUGIN_INVALID_ARGUMENT".into(),
        "WORKSPACE_REPOSITORY_EXISTS" => "PLUGIN_FILESYSTEM_ALREADY_EXISTS".into(),
        "WORKSPACE_REPOSITORY_MOVE_INTO_SELF" => "PLUGIN_INVALID_ARGUMENT".into(),
        "io-error" => "PLUGIN_FILESYSTEM_WRITE_FAILED".into(),
        _ => "PLUGIN_API_FAILED".into(),
    }
}

fn resolve_plugin_workspace_file(
    manifest: &Value,
    state: &tauri::State<'_, WorkspaceState>,
    params: &Value,
    permission: &str,
) -> Result<(std::path::PathBuf, String), String> {
    let requested = required_string(params, "path")?;
    let components = plugin_relative_components(requested)?;
    let root = workspace_root(state)?;
    let target = resolve_plugin_existing_path(&root, requested)?;
    if !target.is_file() {
        return Err("PLUGIN_FILESYSTEM_NOT_FILE".into());
    }
    let relative = relative_path(&root, &target);
    if components.is_empty() || !plugin_path_has_permission(manifest, permission, &relative) {
        return Err("PLUGIN_PERMISSION_SCOPE_VIOLATION".into());
    }
    Ok((target, relative))
}

fn resolve_plugin_copy_path(
    manifest: &Value,
    root: &std::path::Path,
    requested: &str,
    kind: &str,
) -> Result<String, String> {
    validate_permission(manifest, "workspace.read")?;
    validate_permission(manifest, "clipboard.write")?;
    let normalized = requested.replace('\\', "/");
    let target = if normalized == "." {
        root.to_path_buf()
    } else {
        resolve_plugin_existing_path(root, &normalized)?
    };
    let relative = relative_path(root, &target).replace('\\', "/");
    if !plugin_path_has_permission(manifest, "workspace.read", &relative) {
        return Err("PLUGIN_PERMISSION_SCOPE_VIOLATION".into());
    }
    match kind {
        "absolute" => Ok(target.to_string_lossy().into_owned()),
        "repository-root" => Ok(root.to_string_lossy().into_owned()),
        "content-root" => Ok(relative),
        _ => Err("PLUGIN_INVALID_ARGUMENT".into()),
    }
}

fn public_markdown_file(file: MarkdownFile, relative: String) -> Value {
    serde_json::json!({
        "path": relative,
        "relativePath": relative,
        "content": file.content
    })
}

fn dispatch_markdown_list(
    manifest: &Value,
    app: &AppHandle,
    window_label: &str,
    state: &tauri::State<'_, WorkspaceState>,
    deadline: u64,
) -> Result<Value, String> {
    validate_permission(manifest, "workspace.read")?;
    let root = workspace_root(state)?;
    let check_active = || {
        if now_ms() >= deadline {
            Err("PLUGIN_REQUEST_TIMEOUT".to_string())
        } else if app.get_window(window_label).is_none() {
            Err("PLUGIN_RUNTIME_TERMINATED".to_string())
        } else {
            Ok(())
        }
    };
    let entries = workspace_list_plugin_markdown_files(
        manifest,
        &root,
        MAX_PLUGIN_MARKDOWN_FILES,
        &check_active,
    )
    .map_err(|error| map_workspace_error(&error))?;
    let mut files = Vec::with_capacity(entries.len());
    for entry in entries {
        check_active()?;
        let target = resolve_plugin_existing_path(&workspace_root(state)?, &entry.relative_path)
            .map_err(|error| map_workspace_error(&error))?;
        let size = std::fs::metadata(&target)
            .map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED".to_string())?
            .len();
        if size > MAX_PLUGIN_TEXT_FILE_SIZE {
            return Err("PLUGIN_FILESYSTEM_FILE_TOO_LARGE".into());
        }
        let content = std::fs::read_to_string(&target)
            .map_err(|_| "PLUGIN_FILESYSTEM_ENCODING_UNSUPPORTED".to_string())?;
        files.push(serde_json::json!({
            "path": entry.relative_path,
            "relativePath": entry.relative_path,
            "content": content
        }));
        if serde_json::to_vec(&files)
            .map_err(|_| "PLUGIN_API_FAILED")?
            .len()
            > MAX_PAYLOAD
        {
            return Err("PLUGIN_RESPONSE_TOO_LARGE".into());
        }
    }
    Ok(Value::Array(files))
}

fn dispatch_markdown_read(
    manifest: &Value,
    state: &tauri::State<'_, WorkspaceState>,
    params: &Value,
) -> Result<Value, String> {
    validate_permission(manifest, "workspace.read")?;
    let (target, relative) =
        resolve_plugin_workspace_file(manifest, state, params, "workspace.read")?;
    if !target
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
    {
        return Ok(Value::Null);
    }
    let file = workspace_read_markdown_file(relative.clone(), state.clone())
        .map_err(|error| map_workspace_error(&error))?;
    Ok(file
        .map(|value| public_markdown_file(value, relative))
        .unwrap_or(Value::Null))
}

fn dispatch_markdown_update(
    manifest: &Value,
    app: &AppHandle,
    window_label: &str,
    state: &tauri::State<'_, WorkspaceState>,
    params: &Value,
    deadline: u64,
) -> Result<Value, String> {
    validate_permission(manifest, "workspace.write")?;
    let expected_content = params
        .get("expectedContent")
        .and_then(Value::as_str)
        .ok_or_else(|| "PLUGIN_INVALID_ARGUMENT".to_string())?;
    let content = params
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| "PLUGIN_INVALID_ARGUMENT".to_string())?;
    if content.as_bytes().len() > MAX_PLUGIN_TEXT_FILE_SIZE as usize {
        return Err("PLUGIN_FILESYSTEM_FILE_TOO_LARGE".into());
    }
    let (_target, relative) =
        resolve_plugin_workspace_file(manifest, state, params, "workspace.write")?;
    if !std::path::Path::new(&relative)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
    {
        return Err("PLUGIN_FILESYSTEM_UNSUPPORTED_EXTENSION".into());
    }
    if now_ms() >= deadline {
        return Err("PLUGIN_REQUEST_TIMEOUT".into());
    }
    if app.get_window(window_label).is_none() {
        return Err("PLUGIN_RUNTIME_TERMINATED".into());
    }
    let result = super::workspace_update_markdown_file_guarded(
        UpdateMarkdownRequest {
            path: relative,
            expected_content: expected_content.to_string(),
            content: content.to_string(),
        },
        state.clone(),
        &|| {
            if now_ms() >= deadline {
                Err("PLUGIN_REQUEST_TIMEOUT".into())
            } else if app.get_window(window_label).is_none() {
                Err("PLUGIN_RUNTIME_TERMINATED".into())
            } else {
                Ok(())
            }
        },
    )
    .map_err(|error| map_workspace_error(&error))?;
    match result {
        UpdateMarkdownResult::Updated { .. } | UpdateMarkdownResult::Unchanged { .. } => {
            Ok(Value::Null)
        }
        UpdateMarkdownResult::Conflict { .. } => Err("PLUGIN_WRITE_CONFLICT".into()),
        UpdateMarkdownResult::Rejected { reason } => Err(map_workspace_error(reason)),
    }
}

fn ensure_request_active(app: &AppHandle, window_label: &str, deadline: u64) -> Result<(), String> {
    if now_ms() >= deadline {
        return Err("PLUGIN_REQUEST_TIMEOUT".into());
    }
    if app.get_window(window_label).is_none() {
        return Err("PLUGIN_RUNTIME_TERMINATED".into());
    }
    Ok(())
}

fn pick_native_path(
    app: &AppHandle,
    window_label: &str,
    folder: bool,
) -> Result<Option<std::path::PathBuf>, String> {
    let parent = app
        .get_window(window_label)
        .ok_or_else(|| "PLUGIN_RUNTIME_TERMINATED".to_string())?;
    let dialog = app.dialog().file().set_parent(&parent);
    let selected = if folder {
        dialog.blocking_pick_folder()
    } else {
        dialog.blocking_pick_file()
    };
    selected
        .map(|path| {
            path.into_path()
                .map_err(|_| "PLUGIN_DIALOG_PATH_INVALID".to_string())
        })
        .transpose()
}

fn decode_selected_text(bytes: &[u8]) -> Result<String, String> {
    if let Some(encoded) = bytes.strip_prefix(&[0xff, 0xfe]) {
        if encoded.len() % 2 != 0 {
            return Err("PLUGIN_FILESYSTEM_ENCODING_UNSUPPORTED".into());
        }
        let units = encoded
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16(&units)
            .map_err(|_| "PLUGIN_FILESYSTEM_ENCODING_UNSUPPORTED".to_string());
    }
    if let Some(encoded) = bytes.strip_prefix(&[0xfe, 0xff]) {
        if encoded.len() % 2 != 0 {
            return Err("PLUGIN_FILESYSTEM_ENCODING_UNSUPPORTED".into());
        }
        let units = encoded
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16(&units)
            .map_err(|_| "PLUGIN_FILESYSTEM_ENCODING_UNSUPPORTED".to_string());
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let sample = &bytes[..bytes.len().min(8_192)];
    let mut delete_bytes = 0usize;
    for byte in sample {
        if *byte == 0 || *byte < 0x09 || (0x0d < *byte && *byte < 0x20) {
            return Err("PLUGIN_FILESYSTEM_ENCODING_UNSUPPORTED".into());
        }
        if *byte == 0x7f {
            delete_bytes += 1;
        }
    }
    if !sample.is_empty() && delete_bytes * 100 > sample.len() {
        return Err("PLUGIN_FILESYSTEM_ENCODING_UNSUPPORTED".into());
    }
    match String::from_utf8(bytes.to_vec()) {
        Ok(text) => Ok(text),
        Err(_) => encoding_rs::GB18030
            .decode_without_bom_handling_and_without_replacement(bytes)
            .map(|text| text.into_owned())
            .ok_or_else(|| "PLUGIN_FILESYSTEM_ENCODING_UNSUPPORTED".to_string()),
    }
}

fn build_external_open_file_request(
    file_path: &std::path::Path,
    repository: &super::RepositorySummary,
) -> Result<Option<Value>, String> {
    let target = file_path
        .canonicalize()
        .map_err(|_| "PLUGIN_FILESYSTEM_NOT_FOUND".to_string())?;
    if !target.is_file() {
        return Err("PLUGIN_FILESYSTEM_NOT_FILE".into());
    }
    let title = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("文件");
    let common = serde_json::json!({
        "repositoryId": repository.id,
        "filePath": target.to_string_lossy(),
        "title": title,
        "disposition": "current-group",
        "temporary": true
    });
    let kind = super::workspace_file_kind(&target);
    if let Some(("image" | "video" | "audio", mime)) = kind {
        return Ok(Some(serde_json::json!({
            "repositoryId": repository.id,
            "filePath": target.to_string_lossy(),
            "title": title,
            "kind": kind.map(|value| value.0),
            "mediaMimeType": mime.unwrap_or("application/octet-stream"),
            "disposition": "current-group",
            "temporary": true
        })));
    }
    let metadata =
        std::fs::metadata(&target).map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED".to_string())?;
    if metadata.len() > MAX_PLUGIN_TEXT_FILE_SIZE {
        return Err("PLUGIN_FILESYSTEM_FILE_TOO_LARGE".into());
    }
    let bytes = std::fs::read(&target).map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED".to_string())?;
    let content = decode_selected_text(&bytes)?;
    let mut request = common;
    request["kind"] = Value::String("text".into());
    request["content"] = Value::String(content);
    Ok(Some(request))
}

/// Initial routes reuse authoritative manifest and workspace services.
fn dispatch(envelope: &Envelope, app: &AppHandle, window_label: &str) -> Result<Value, String> {
    if app.get_window(window_label).is_none() {
        return Err("PLUGIN_RUNTIME_TERMINATED".into());
    }
    let registry = app.state::<super::PluginRegistryState>();
    registry.authorize_runtime(
        &envelope.plugin_id,
        &envelope.request.runtime_id,
        window_label,
    )?;
    let (_, manifest) = find_active_plugin_manifest(app, &envelope.plugin_id)?;
    validate_view(&manifest, envelope)?;
    let key = (window_label.to_string(), envelope.plugin_id.clone());
    let rpc = app.state::<PluginRpcState>();
    {
        let mut state = rpc.registrations.lock().map_err(|_| "PLUGIN_API_FAILED")?;
        state
            .quotas
            .retain(|(label, _), _| app.get_window(label).is_some());
        state
            .commands
            .retain(|(label, _), _| app.get_window(label).is_some());
        state
            .status_items
            .retain(|(label, _), _| app.get_window(label).is_some());
        admit_request(
            state.quotas.entry(key.clone()).or_default(),
            &envelope.request,
            now_ms(),
        )?;
    }
    if now_ms() >= envelope.request.deadline {
        return Err("PLUGIN_REQUEST_TIMEOUT".into());
    }
    if !matches!(
        envelope.request.method.as_str(),
        "runtimeReady" | "runtimeFailed"
    ) {
        validate_sidecar_capability(&manifest, &envelope.request.method)?;
        match registry.invoke_sidecar(
            &envelope.plugin_id,
            &envelope.request.runtime_id,
            &envelope.request.request_id,
            &envelope.request.method,
            &envelope.request.params,
            envelope.request.deadline,
        ) {
            Ok(Some(result)) => return Ok(result),
            Ok(None) => {}
            Err(error) => {
                cleanup_failed_plugin_runtime(app, &rpc, &envelope.plugin_id);
                return Err(error);
            }
        }
    }
    match envelope.request.method.as_str() {
        "log" => dispatch_plugin_log(&envelope.plugin_id, &envelope.request.params),
        "network.request" => dispatch_network_request(
            &manifest,
            app,
            window_label,
            &envelope.request.params,
            envelope.request.deadline,
        ),
        method if method.starts_with("filesystem.") => {
            let workspace = app.state::<WorkspaceState>();
            let root = workspace.root.lock().map_err(|_| "PLUGIN_API_FAILED")?;
            super::plugin_filesystem::invoke(
                &root,
                &manifest,
                method,
                &envelope.request.params,
                &|| {
                    ensure_request_active(app, window_label, envelope.request.deadline)?;
                    registry.authorize_runtime(
                        &envelope.plugin_id,
                        &envelope.request.runtime_id,
                        window_label,
                    )
                },
            )
        }
        "storage.get" | "storage.set" | "storage.delete" => {
            let storage = app.state::<super::PluginStorageState>();
            let _operation = storage
                .operation
                .lock()
                .map_err(|_| "PLUGIN_STORAGE_LOCK_FAILED")?;
            super::plugin_filesystem::storage(
                &super::plugin_storage_path(app, &envelope.plugin_id)?,
                &manifest,
                &envelope.request.method,
                &envelope.request.params,
                &|| {
                    ensure_request_active(app, window_label, envelope.request.deadline)?;
                    registry.authorize_runtime(
                        &envelope.plugin_id,
                        &envelope.request.runtime_id,
                        window_label,
                    )
                },
            )
        }
        "notifications.show" | "notifications.showSystem" => {
            let mut params = envelope
                .request
                .params
                .as_object()
                .cloned()
                .ok_or("PLUGIN_INVALID_ARGUMENT")?;
            if params.remove("pluginId").is_some() {
                return Err("PLUGIN_INVALID_ARGUMENT".into());
            }
            params.insert("pluginId".into(), Value::String(envelope.plugin_id.clone()));
            let request: super::PluginNotificationRequest =
                serde_json::from_value(Value::Object(params))
                    .map_err(|_| "PLUGIN_INVALID_ARGUMENT".to_string())?;
            if envelope.request.method == "notifications.show" {
                super::plugin_show_notification(request, app.clone()).map(|_| Value::Null)
            } else {
                super::plugin_show_system_notification(request, app.clone()).map(|_| Value::Null)
            }
        }
        "dialogs.pick" | "dialogs.repositoryManager" | "dialogs.prompt" | "dialogs.confirm" => {
            let request = super::PluginDialogRequest {
                plugin_id: envelope.plugin_id.clone(),
                method: envelope.request.method.clone(),
                params: envelope.request.params.clone(),
            };
            tauri::async_runtime::block_on(super::plugin_dialog_request_impl(
                request,
                app.clone(),
                app.state::<super::PluginDialogState>().inner(),
            ))
        }
        "window.list" => {
            validate_permission(&manifest, "window.manage")?;
            serde_json::to_value(super::plugin_window_snapshots(app))
                .map_err(|_| "PLUGIN_API_FAILED".into())
        }
        "window.open" => {
            validate_permission(&manifest, "window.manage")?;
            let mut params = envelope
                .request
                .params
                .as_object()
                .cloned()
                .ok_or("PLUGIN_INVALID_ARGUMENT")?;
            if params.contains_key("pluginId") {
                return Err("PLUGIN_INVALID_ARGUMENT".into());
            }
            if params.contains_key("filePath") {
                validate_permission(&manifest, "workspace.read")?;
            }
            let kind = params
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("workbench");
            if kind == "plugin" {
                let view_type = params
                    .get("viewType")
                    .and_then(Value::as_str)
                    .ok_or("PLUGIN_WINDOW_VIEW_NOT_DECLARED")?;
                validate_declared_view(&manifest, view_type)?;
                params.insert("pluginId".into(), Value::String(envelope.plugin_id.clone()));
            }
            let request: super::PluginWindowOpenRequest =
                serde_json::from_value(Value::Object(params))
                    .map_err(|_| "PLUGIN_INVALID_ARGUMENT".to_string())?;
            super::open_plugin_window(request, app.clone(), None)
        }
        "window.update" => {
            validate_permission(&manifest, "window.manage")?;
            let request: super::PluginWindowUpdateRequest =
                serde_json::from_value(envelope.request.params.clone())
                    .map_err(|_| "PLUGIN_INVALID_ARGUMENT".to_string())?;
            super::plugin_window_update(request, app.clone())
        }
        "window.focus" => {
            validate_permission(&manifest, "window.manage")?;
            let request: super::PluginWindowIdRequest =
                serde_json::from_value(envelope.request.params.clone())
                    .map_err(|_| "PLUGIN_INVALID_ARGUMENT".to_string())?;
            super::plugin_window_focus(request, app.clone()).map(|_| Value::Null)
        }
        "window.close" => {
            validate_permission(&manifest, "window.manage")?;
            let request: super::PluginWindowIdRequest =
                serde_json::from_value(envelope.request.params.clone())
                    .map_err(|_| "PLUGIN_INVALID_ARGUMENT".to_string())?;
            super::plugin_window_close_impl(request, app.clone()).map(|_| Value::Null)
        }
        "editor.getActiveDocument" => {
            validate_permission(&manifest, "editor.read")?;
            serde_json::to_value(
                app.state::<super::EditorState>()
                    .active_document
                    .lock()
                    .map_err(|_| "EDITOR_STATE_POISONED")?
                    .clone(),
            )
            .map_err(|_| "PLUGIN_API_FAILED".into())
        }
        "editor.revealRange" => {
            let mut params = envelope
                .request
                .params
                .as_object()
                .cloned()
                .ok_or("PLUGIN_INVALID_ARGUMENT")?;
            if params.remove("pluginId").is_some() {
                return Err("PLUGIN_INVALID_ARGUMENT".into());
            }
            params.insert("pluginId".into(), Value::String(envelope.plugin_id.clone()));
            let request: super::PluginEditorRevealRangeRequest =
                serde_json::from_value(Value::Object(params))
                    .map_err(|_| "PLUGIN_INVALID_ARGUMENT".to_string())?;
            super::plugin_editor_reveal_range(
                request,
                app.clone(),
                app.state::<super::EditorState>(),
                app.state::<super::WorkspaceState>(),
            )
            .map(|_| Value::Null)
        }
        "editor.openFile" => {
            let mut params = envelope
                .request
                .params
                .as_object()
                .cloned()
                .ok_or("PLUGIN_INVALID_ARGUMENT")?;
            if params.remove("pluginId").is_some() {
                return Err("PLUGIN_INVALID_ARGUMENT".into());
            }
            params.insert("pluginId".into(), Value::String(envelope.plugin_id.clone()));
            let request: super::PluginEditorOpenFileRequest =
                serde_json::from_value(Value::Object(params))
                    .map_err(|_| "PLUGIN_INVALID_ARGUMENT".to_string())?;
            super::plugin_editor_open_file(
                request,
                app.clone(),
                app.state::<super::WorkspaceState>(),
            )
            .map(|_| Value::Null)
        }
        "editor.closeTab" | "editor.closeTabs" | "editor.closeAllTabs" => {
            let mut params = envelope.request.params.clone();
            if envelope.request.method == "editor.closeTab" {
                let path = params
                    .get("path")
                    .cloned()
                    .ok_or("PLUGIN_INVALID_ARGUMENT")?;
                params = serde_json::json!({"paths": [path]});
            } else if envelope.request.method == "editor.closeAllTabs" {
                params = serde_json::json!({});
            }
            let mut object = params
                .as_object()
                .cloned()
                .ok_or("PLUGIN_INVALID_ARGUMENT")?;
            object.insert("pluginId".into(), Value::String(envelope.plugin_id.clone()));
            let request: super::PluginEditorCloseTabsRequest =
                serde_json::from_value(Value::Object(object))
                    .map_err(|_| "PLUGIN_INVALID_ARGUMENT".to_string())?;
            super::plugin_editor_close_tabs(request, app.clone()).map(|_| Value::Null)
        }
        "editor.applyTextChange" => dispatch_markdown_update(
            &manifest,
            app,
            window_label,
            &app.state::<super::WorkspaceState>(),
            &envelope.request.params,
            envelope.request.deadline,
        ),
        "runtimeReady" | "runtimeFailed" => {
            let failed = envelope.request.method == "runtimeFailed";
            registry.report_runtime(
                &envelope.plugin_id,
                &envelope.request.runtime_id,
                window_label,
                failed,
            )?;
            if failed {
                app.state::<super::web_viewer::WebViewerState>()
                    .dispose(app, |scope| scope.plugin == envelope.plugin_id);
                rpc.dispose_plugin(&envelope.plugin_id);
                app.state::<super::PluginSettingsState>()
                    .dispose_plugin(&envelope.plugin_id);
                app.emit(
                    "plugin:registryChanged",
                    serde_json::json!({ "pluginId": envelope.plugin_id }),
                )
                .map_err(|_| "PLUGIN_API_FAILED".to_string())?;
            }
            app.emit(
                "plugin:runtimeChanged",
                serde_json::json!({ "pluginId": envelope.plugin_id }),
            )
            .map_err(|_| "PLUGIN_API_FAILED".to_string())?;
            Ok(Value::Null)
        }
        "settings.registerPage" | "settings.unregisterPage" => {
            ensure_request_active(app, window_label, envelope.request.deadline)?;
            let settings = app.state::<super::PluginSettingsState>();
            if envelope.request.method == "settings.registerPage" {
                settings.register(
                    window_label,
                    &envelope.plugin_id,
                    &manifest,
                    &envelope.request.params["page"],
                    &|| ensure_request_active(app, window_label, envelope.request.deadline),
                )?;
            } else {
                settings.unregister(
                    window_label,
                    &envelope.plugin_id,
                    &manifest,
                    required_string(&envelope.request.params, "id")?,
                    &|| ensure_request_active(app, window_label, envelope.request.deadline),
                )?;
            }
            app.emit(
                "plugin:contributionsChanged",
                serde_json::json!({ "pluginId": envelope.plugin_id }),
            )
            .map_err(|_| "PLUGIN_API_FAILED".to_string())?;
            Ok(Value::Null)
        }
        "settings.get" => {
            let field_id = required_string(&envelope.request.params, "fieldId")?;
            let path = super::plugin_settings_path(app, &envelope.plugin_id)?;
            app.state::<super::PluginSettingsState>().get_field(
                &envelope.plugin_id,
                &manifest,
                field_id,
                &path,
            )
        }
        "statusBar.registerItem" | "statusBar.unregisterItem" => {
            let (id, value) = if envelope.request.method == "statusBar.registerItem" {
                let item = read_status_item(&manifest, &envelope.request.params)?;
                (required_string(&item, "id")?.to_string(), Some(item))
            } else {
                let id = required_string(&envelope.request.params, "id")?;
                validate_status_item_id(&manifest, id)?;
                (id.to_string(), None)
            };
            ensure_request_active(app, window_label, envelope.request.deadline)?;
            {
                let mut state = rpc.registrations.lock().map_err(|_| "PLUGIN_API_FAILED")?;
                state.status_items.entry(key).or_default().insert(id, value);
            }
            app.emit_to(
                window_label,
                "plugin:contributionsChanged",
                serde_json::json!({ "pluginId": envelope.plugin_id }),
            )
            .map_err(|_| "PLUGIN_API_FAILED".to_string())?;
            Ok(Value::Null)
        }
        "registerCommand" | "unregisterCommand" => {
            let id = required_string(&envelope.request.params, "id")?;
            validate_plugin_command(&manifest, id)?;
            let mut state = rpc.registrations.lock().map_err(|_| "PLUGIN_API_FAILED")?;
            let commands = state.commands.entry(key).or_default();
            if envelope.request.method == "registerCommand" {
                commands.insert(id.to_string());
            } else {
                commands.remove(id);
            }
            Ok(Value::Null)
        }
        "workspace.getRepository" => {
            validate_repository_permission(&manifest)?;
            let root = workspace_root(&app.state::<WorkspaceState>())?;
            serde_json::to_value(repository_summary(&root)).map_err(|_| "PLUGIN_API_FAILED".into())
        }
        "workspace.copyPath" => {
            let root = workspace_root(&app.state::<WorkspaceState>())?;
            let path = required_string(&envelope.request.params, "path")?;
            let kind = required_string(&envelope.request.params, "kind")?;
            let value = resolve_plugin_copy_path(&manifest, &root, path, kind)?;
            let mut clipboard =
                arboard::Clipboard::new().map_err(|_| "PLUGIN_API_FAILED".to_string())?;
            clipboard
                .set_text(value)
                .map_err(|_| "PLUGIN_API_FAILED".to_string())?;
            Ok(Value::Null)
        }
        "workspace.openWithDefaultApp" | "workspace.revealInFileManager" => {
            validate_permission(&manifest, "workspace.read")?;
            validate_permission(&manifest, "external.open")?;
            let request = super::PluginWorkspacePathRequest {
                plugin_id: envelope.plugin_id.clone(),
                path: required_string(&envelope.request.params, "path")?.to_string(),
            };
            ensure_request_active(app, window_label, envelope.request.deadline)?;
            let result = if envelope.request.method == "workspace.openWithDefaultApp" {
                super::plugin_open_with_default_app(
                    request,
                    app.clone(),
                    app.state::<WorkspaceState>(),
                )
            } else {
                super::plugin_reveal_in_file_manager(
                    request,
                    app.clone(),
                    app.state::<WorkspaceState>(),
                )
            };
            result.map(|_| Value::Null).map_err(|error| {
                if matches!(
                    error.as_str(),
                    "SYSTEM_OPEN_FAILED" | "SYSTEM_REVEAL_FAILED"
                ) {
                    "PLUGIN_EXTERNAL_OPEN_FAILED".into()
                } else {
                    map_workspace_error(&error)
                }
            })
        }
        "workspace.openView" | "workspace.closeView" => dispatch_view_lifecycle(
            app,
            window_label,
            &envelope.plugin_id,
            &manifest,
            &envelope.request.method,
            &envelope.request.params,
        ),
        "workspace.listMarkdownFiles" => dispatch_markdown_list(
            &manifest,
            app,
            window_label,
            &app.state::<WorkspaceState>(),
            envelope.request.deadline,
        ),
        "workspace.readMarkdownFile" => dispatch_markdown_read(
            &manifest,
            &app.state::<WorkspaceState>(),
            &envelope.request.params,
        ),
        "workspace.updateMarkdownFile" => dispatch_markdown_update(
            &manifest,
            app,
            window_label,
            &app.state::<WorkspaceState>(),
            &envelope.request.params,
            envelope.request.deadline,
        ),
        "workspace.listRecentRepositories" => {
            validate_permission(&manifest, "workspace.read")?;
            let repositories =
                super::workspace_list_recent_repositories(app.state::<WorkspaceState>())
                    .map_err(|error| map_workspace_error(&error))?;
            serde_json::to_value(repositories).map_err(|_| "PLUGIN_API_FAILED".into())
        }
        "workspace.openRecentRepository" => {
            validate_permission(&manifest, "workspace.open")?;
            let id = required_string(&envelope.request.params, "id")?;
            let result = workspace_open_recent_repository(
                id.to_string(),
                app.clone(),
                app.state::<WorkspaceState>(),
            )
            .map_err(|error| map_workspace_error(&error))?;
            serde_json::to_value(result).map_err(|_| "PLUGIN_API_FAILED".into())
        }
        "workspace.openRepository" => {
            validate_permission(&manifest, "workspace.open")?;
            let Some(path) = pick_native_path(app, window_label, true)? else {
                return Ok(Value::Null);
            };
            ensure_request_active(app, window_label, envelope.request.deadline)?;
            let result = super::workspace_open_repository(
                path.to_string_lossy().into_owned(),
                app.clone(),
                app.state::<WorkspaceState>(),
            )
            .map_err(|error| map_workspace_error(&error))?;
            serde_json::to_value(result).map_err(|_| "PLUGIN_API_FAILED".into())
        }
        "workspace.createRepository" => {
            validate_permission(&manifest, "workspace.open")?;
            validate_permission(&manifest, "workspace.write")?;
            ensure_request_active(app, window_label, envelope.request.deadline)?;
            let result = super::workspace_create_repository(
                None,
                None,
                app.clone(),
                app.state::<WorkspaceState>(),
            )
            .map_err(|error| map_workspace_error(&error))?;
            serde_json::to_value(result).map_err(|_| "PLUGIN_API_FAILED".into())
        }
        "workspace.openFile" => {
            validate_permission(&manifest, "workspace.open")?;
            validate_permission(&manifest, "editor.write")?;
            let Some(path) = pick_native_path(app, window_label, false)? else {
                return Ok(Value::Null);
            };
            ensure_request_active(app, window_label, envelope.request.deadline)?;
            let root = workspace_root(&app.state::<WorkspaceState>())?;
            let request = build_external_open_file_request(&path, &repository_summary(&root))?
                .ok_or_else(|| "PLUGIN_FILESYSTEM_UNSUPPORTED_EXTENSION".to_string())?;
            app.emit_to("main", "workspace:openFileRequested", request)
                .map_err(|_| "PLUGIN_API_FAILED".to_string())?;
            Ok(Value::Null)
        }
        "workspace.renameRecentRepository" => {
            validate_permission(&manifest, "workspace.open")?;
            validate_permission(&manifest, "workspace.write")?;
            let id = required_string(&envelope.request.params, "id")?;
            let name = required_string(&envelope.request.params, "name")?;
            workspace_rename_recent_repository(
                id.to_string(),
                name.to_string(),
                app.clone(),
                app.state::<WorkspaceState>(),
            )
            .map_err(|error| map_workspace_error(&error))?;
            Ok(Value::Null)
        }
        "workspace.moveRecentRepository" => {
            validate_permission(&manifest, "workspace.open")?;
            validate_permission(&manifest, "workspace.write")?;
            let id = required_string(&envelope.request.params, "id")?;
            let Some(path) = pick_native_path(app, window_label, true)? else {
                return Ok(Value::Bool(false));
            };
            ensure_request_active(app, window_label, envelope.request.deadline)?;
            super::workspace_move_recent_repository(
                id.to_string(),
                path.to_string_lossy().into_owned(),
                app.clone(),
                app.state::<WorkspaceState>(),
            )
            .map(Value::Bool)
            .map_err(|error| map_workspace_error(&error))
        }
        "workspace.revealRecentRepository" => {
            validate_permission(&manifest, "workspace.read")?;
            validate_permission(&manifest, "external.open")?;
            let id = required_string(&envelope.request.params, "id")?;
            super::workspace_reveal_recent_repository(id.to_string(), app.state::<WorkspaceState>())
                .map(|_| Value::Null)
                .map_err(|error| map_workspace_error(&error))
        }
        "workspace.removeRecentRepository" => {
            validate_permission(&manifest, "workspace.write")?;
            let id = required_string(&envelope.request.params, "id")?;
            workspace_remove_recent_repository(id.to_string(), app.state::<WorkspaceState>())
                .map_err(|error| map_workspace_error(&error))?;
            Ok(Value::Null)
        }
        "webViewer.open"
        | "webViewer.list"
        | "webViewer.navigate"
        | "webViewer.back"
        | "webViewer.forward"
        | "webViewer.reload"
        | "webViewer.activate"
        | "webViewer.close"
        | "webViewer.executeAction" => {
            let view = envelope
                .view
                .as_ref()
                .ok_or("PLUGIN_VIEW_CONTEXT_REQUIRED")?;
            let scope = super::web_viewer::Scope {
                window: window_label.into(),
                plugin: envelope.plugin_id.clone(),
                runtime: envelope.request.runtime_id.clone(),
                view_type: view.view_type.clone(),
                instance: view.instance_id.clone(),
            };
            app.state::<super::web_viewer::WebViewerState>().invoke(
                app,
                scope,
                &envelope.request.method,
                &envelope.request.params,
                envelope.request.deadline,
            )
        }
        _ => Err("PLUGIN_API_UNAVAILABLE".into()),
    }
}

fn cleanup_failed_plugin_runtime(app: &AppHandle, rpc: &PluginRpcState, plugin_id: &str) {
    app.state::<super::web_viewer::WebViewerState>()
        .dispose(app, |scope| scope.plugin == plugin_id);
    rpc.dispose_plugin(plugin_id);
    app.state::<super::PluginSettingsState>()
        .dispose_plugin(plugin_id);
    for event in ["plugin:registryChanged", "plugin:runtimeChanged"] {
        if let Err(error) = app.emit(event, serde_json::json!({ "pluginId": plugin_id })) {
            eprintln!("[plugin:{plugin_id}] PLUGIN_RUNTIME_EVENT_FAILED: {error}");
        }
    }
}

fn response(request_id: String, result: Result<Value, String>) -> Response {
    match result {
        Ok(value) => Response {
            protocol_version: 1,
            request_id,
            ok: true,
            result: Some(value),
            error: None,
        },
        Err(cause) => {
            let code = if cause.starts_with("PLUGIN_")
                && cause
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte == b'_')
            {
                cause
            } else {
                "PLUGIN_API_FAILED".into()
            };
            Response {
                protocol_version: 1,
                request_id,
                ok: false,
                result: None,
                error: Some(RpcError {
                    message: code.clone(),
                    code,
                }),
            }
        }
    }
}

/// Interactive webpage saves retain the user's selection time while ordinary actions stay bounded.
fn request_timeout(request: &Request, now: u64) -> u64 {
    let interactive = matches!(
        request.method.as_str(),
        "workspace.openRepository"
            | "workspace.createRepository"
            | "workspace.openFile"
            | "workspace.moveRecentRepository"
    ) || request.method.starts_with("dialogs.")
        || (request.method == "webViewer.executeAction"
            && request.params["action"] == "save-to-repository");
    request.deadline.saturating_sub(now).min(if interactive {
        MAX_INTERACTIVE_TIMEOUT_MS
    } else {
        15_000
    })
}

/// Keep the existing IPC envelope and bind caller identity to Tauri's current window.
#[tauri::command]
pub(crate) async fn plugin_invoke_renderer(
    envelope: Value,
    app: AppHandle,
    window: Window,
) -> Response {
    let request_id = envelope["request"]["requestId"]
        .as_str()
        .filter(|id| id.len() <= 256)
        .unwrap_or_default()
        .to_string();
    let parsed = match validate_envelope(&envelope, now_ms()) {
        Ok(value) => value,
        Err(error) => return response(request_id, Err(error)),
    };
    let timeout = request_timeout(&parsed.request, now_ms());
    let window_label = window.label().to_string();
    let task = tauri::async_runtime::spawn_blocking(move || dispatch(&parsed, &app, &window_label));
    let result = match tokio::time::timeout(Duration::from_millis(timeout), task).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("PLUGIN_API_FAILED".into()),
        Err(_) => Err("PLUGIN_REQUEST_TIMEOUT".into()),
    };
    response(request_id, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn request() -> Value {
        json!({"pluginId":"com.example.plugin", "request": {
            "protocolVersion":1, "requestId":"request-1", "runtimeId":"ignored",
            "method":"workspace.getRepository", "params":{}, "deadline":20_000
        }})
    }

    #[test]
    fn sidecar_capability_gate_uses_exact_method_permissions() {
        let manifest = json!({"permissions":[
            {"id":"workspace.read"},
            {"id":"workspace.write"},
            {"id":"workspace.open"},
            {"id":"editor.write"},
            {"id":"editor.read"},
            {"id":"webViewer.navigate"}
        ]});
        assert!(validate_sidecar_capability(&manifest, "filesystem.readText").is_ok());
        assert!(validate_sidecar_capability(&manifest, "filesystem.writeText").is_ok());
        assert!(validate_sidecar_capability(&manifest, "editor.openFile").is_ok());
        assert!(validate_sidecar_capability(&manifest, "webViewer.navigate").is_ok());
        let read_only = json!({"permissions":[{"id":"workspace.read"}]});
        assert_eq!(
            validate_sidecar_capability(&read_only, "filesystem.copy").unwrap_err(),
            "PLUGIN_PERMISSION_DENIED"
        );
        assert_eq!(
            validate_sidecar_capability(&manifest, "unknown.method").unwrap_err(),
            "PLUGIN_API_UNAVAILABLE"
        );
    }

    #[test]
    fn sidecar_capability_gate_requires_secondary_permissions() {
        let manifest = json!({"permissions":[{"id":"workspace.read"}]});
        assert_eq!(
            validate_sidecar_capability(&manifest, "workspace.copyPath").unwrap_err(),
            "PLUGIN_PERMISSION_DENIED"
        );
        assert_eq!(
            validate_sidecar_capability(&manifest, "workspace.revealRecentRepository").unwrap_err(),
            "PLUGIN_PERMISSION_DENIED"
        );
    }

    #[test]
    fn sidecar_gate_covers_every_public_sdk_rpc_method() {
        let manifest = json!({"permissions":[
            {"id":"workspace.read"}, {"id":"workspace.write"},
            {"id":"workspace.open"}, {"id":"window.manage"},
            {"id":"network.request"}, {"id":"clipboard.write"},
            {"id":"notifications.show"}, {"id":"notifications.system"},
            {"id":"dialogs.show"}, {"id":"external.open"},
            {"id":"webViewer.navigate"}, {"id":"storage.plugin"},
            {"id":"editor.read"}, {"id":"editor.write"}
        ]});
        let methods = [
            "registerCommand",
            "unregisterCommand",
            "runtimeReady",
            "runtimeFailed",
            "log",
            "settings.registerPage",
            "settings.unregisterPage",
            "settings.get",
            "statusBar.registerItem",
            "statusBar.unregisterItem",
            "workspace.openView",
            "workspace.closeView",
            "storage.get",
            "storage.set",
            "storage.delete",
            "workspace.getRepository",
            "workspace.createRepository",
            "workspace.openRepository",
            "workspace.openFile",
            "workspace.listRecentRepositories",
            "workspace.openRecentRepository",
            "workspace.renameRecentRepository",
            "workspace.moveRecentRepository",
            "workspace.revealRecentRepository",
            "workspace.removeRecentRepository",
            "workspace.copyPath",
            "workspace.openWithDefaultApp",
            "workspace.revealInFileManager",
            "window.list",
            "window.open",
            "window.update",
            "window.focus",
            "window.close",
            "editor.getActiveDocument",
            "editor.openFile",
            "editor.closeTab",
            "editor.closeTabs",
            "editor.closeAllTabs",
            "editor.revealRange",
            "editor.applyTextChange",
            "filesystem.listFiles",
            "filesystem.listEntries",
            "filesystem.stat",
            "filesystem.readText",
            "filesystem.writeText",
            "filesystem.createFile",
            "filesystem.createDirectory",
            "filesystem.delete",
            "filesystem.move",
            "filesystem.rename",
            "filesystem.copy",
            "filesystem.encrypt",
            "filesystem.decrypt",
            "workspace.listMarkdownFiles",
            "workspace.readMarkdownFile",
            "workspace.updateMarkdownFile",
            "network.request",
            "notifications.show",
            "notifications.showSystem",
            "dialogs.pick",
            "dialogs.repositoryManager",
            "dialogs.prompt",
            "dialogs.confirm",
            "webViewer.open",
            "webViewer.list",
            "webViewer.activate",
            "webViewer.navigate",
            "webViewer.back",
            "webViewer.forward",
            "webViewer.reload",
            "webViewer.close",
            "webViewer.executeAction",
        ];
        for method in methods {
            assert!(
                validate_sidecar_capability(&manifest, method).is_ok(),
                "public SDK route is absent from the sidecar capability gate: {method}"
            );
        }
    }

    #[test]
    fn plugin_log_route_validates_level_message_and_details_without_permission() {
        let params = json!({"level":"info","message":"ready","details":{"count":1}});
        assert_eq!(
            dispatch_plugin_log("com.example.plugin", &params).unwrap(),
            Value::Null
        );
        assert_eq!(
            dispatch_plugin_log(
                "com.example.plugin",
                &json!({"level":"trace","message":"x"})
            )
            .unwrap_err(),
            "PLUGIN_INVALID_ARGUMENT"
        );
        assert_eq!(
            dispatch_plugin_log("com.example.plugin", &json!({"level":"info","message":" "}))
                .unwrap_err(),
            "PLUGIN_INVALID_ARGUMENT"
        );
        assert_eq!(
            dispatch_plugin_log(
                "com.example.plugin",
                &json!({"level":"info","message":"x","details":"x".repeat(MAX_LOG_DETAILS_BYTES)})
            )
            .unwrap_err(),
            "PLUGIN_INVALID_ARGUMENT"
        );
        let manifest = json!({"permissions":[]});
        assert!(validate_sidecar_capability(&manifest, "log").is_ok());
    }

    #[test]
    fn only_webpage_save_actions_receive_the_bounded_interactive_timeout() {
        let mut raw = request();
        raw["request"]["method"] = json!("webViewer.executeAction");
        raw["request"]["deadline"] = json!(u64::MAX);
        raw["request"]["params"] = json!({"action": "save-to-repository"});
        let mut envelope = validate_envelope(&raw, 1_000).unwrap();
        assert_eq!(request_timeout(&envelope.request, 1_000), 300_000);
        envelope.request.deadline = 1_050;
        assert_eq!(request_timeout(&envelope.request, 1_000), 50);
        assert_eq!(request_timeout(&envelope.request, 2_000), 0);
        envelope.request.deadline = u64::MAX;
        envelope.request.params["action"] = json!("zoom-in");
        assert_eq!(request_timeout(&envelope.request, 1_000), 15_000);
        envelope.request.params["action"] = json!("save-to-repository");
        envelope.request.method = "unrelated".into();
        assert_eq!(request_timeout(&envelope.request, 1_000), 15_000);
    }

    #[test]
    fn dialog_routes_receive_the_interactive_deadline() {
        let mut raw = request();
        raw["request"]["method"] = json!("dialogs.confirm");
        raw["request"]["deadline"] = json!(u64::MAX);
        raw["request"]["params"] = json!({"title":"Confirm","message":"Continue?"});
        let mut envelope = validate_envelope(&raw, 1_000).unwrap();
        assert_eq!(request_timeout(&envelope.request, 1_000), 300_000);
        envelope.request.deadline = 1_250;
        assert_eq!(request_timeout(&envelope.request, 1_000), 250);
    }

    #[test]
    fn network_requests_use_the_default_deadline_budget() {
        let mut raw = request();
        raw["request"]["method"] = json!("network.request");
        raw["request"]["deadline"] = json!(u64::MAX);
        let envelope = validate_envelope(&raw, 1_000).unwrap();
        assert_eq!(request_timeout(&envelope.request, 1_000), 15_000);
    }

    #[test]
    fn selected_text_decoder_supports_utf16_and_gb18030_without_replacement() {
        let expected = "中文 WStudio";
        let mut utf16_le = vec![0xff, 0xfe];
        for unit in expected.encode_utf16() {
            utf16_le.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_selected_text(&utf16_le).unwrap(), expected);

        let mut utf16_be = vec![0xfe, 0xff];
        for unit in expected.encode_utf16() {
            utf16_be.extend_from_slice(&unit.to_be_bytes());
        }
        assert_eq!(decode_selected_text(&utf16_be).unwrap(), expected);

        let (gb18030, _, had_errors) = encoding_rs::GB18030.encode(expected);
        assert!(!had_errors);
        assert_eq!(decode_selected_text(&gb18030).unwrap(), expected);
        assert_eq!(
            decode_selected_text(&[0xff, 0xfe, 0x41]).unwrap_err(),
            "PLUGIN_FILESYSTEM_ENCODING_UNSUPPORTED"
        );
        assert_eq!(
            decode_selected_text(&[0xff]).unwrap_err(),
            "PLUGIN_FILESYSTEM_ENCODING_UNSUPPORTED"
        );
    }

    #[test]
    fn envelope_rejects_invalid_protocol_deadline_and_large_payload() {
        assert!(validate_envelope(&request(), 1).is_ok());
        for value in [json!(null), json!("1"), json!(2)] {
            let mut raw = request();
            raw["request"]["protocolVersion"] = value;
            assert_eq!(
                validate_envelope(&raw, 1).err().unwrap(),
                "PLUGIN_INVALID_ARGUMENT"
            );
        }
        assert_eq!(
            validate_envelope(&request(), 20_000).err().unwrap(),
            "PLUGIN_REQUEST_TIMEOUT"
        );
        let mut raw = request();
        raw["request"]["params"] = json!("x".repeat(MAX_PAYLOAD));
        assert_eq!(
            validate_envelope(&raw, 1).err().unwrap(),
            "PLUGIN_INVALID_ARGUMENT"
        );
    }
    #[test]
    fn quota_rejects_replay_and_rate_limit_then_expires() {
        let mut quota = WindowQuota::default();
        let mut item = validate_envelope(&request(), 1).unwrap().request;
        assert!(admit_request(&mut quota, &item, 20_000).is_ok());
        assert_eq!(
            admit_request(&mut quota, &item, 20_001).unwrap_err(),
            "PLUGIN_REQUEST_REPLAYED"
        );
        for i in 2..MAX_REQUESTS {
            item.request_id = format!("request-{i}");
            assert!(admit_request(&mut quota, &item, 20_001).is_ok());
        }
        assert_eq!(
            admit_request(&mut quota, &item, 20_001).unwrap_err(),
            "PLUGIN_RATE_LIMITED"
        );
        assert!(admit_request(&mut quota, &item, 30_000).is_ok());
    }
    #[test]
    fn views_require_manifest_declaration_and_reject_activation_methods() {
        let mut raw = request();
        raw["view"] = json!({"viewType":"example.view", "instanceId":"instance-1"});
        let manifest = json!({"contributes":{"views":[{"type":"example.view"}]}});
        let mut parsed = validate_envelope(&raw, 1).unwrap();
        assert!(validate_view(&manifest, &parsed).is_ok());
        parsed.request.method = "registerCommand".into();
        assert_eq!(
            validate_view(&manifest, &parsed).unwrap_err(),
            "PLUGIN_VIEW_METHOD_FORBIDDEN"
        );
        assert_eq!(
            validate_view(&json!({}), &parsed).unwrap_err(),
            "PLUGIN_CONTRIBUTION_NOT_DECLARED"
        );
        for method in [
            "statusBar.registerItem",
            "statusBar.unregisterItem",
            "settings.registerPage",
            "settings.unregisterPage",
        ] {
            parsed.request.method = method.into();
            assert_eq!(
                validate_view(&manifest, &parsed).unwrap_err(),
                "PLUGIN_VIEW_METHOD_FORBIDDEN"
            );
        }
    }

    #[test]
    fn lifecycle_view_validation_requires_declared_type_and_bounds_instance_ids() {
        let manifest = json!({"contributes":{"views":[{"type":"example.view"}]}});
        assert!(validate_declared_view(&manifest, "example.view").is_ok());
        assert_eq!(
            validate_declared_view(&manifest, "other.view").unwrap_err(),
            "PLUGIN_CONTRIBUTION_NOT_DECLARED"
        );
        assert_eq!(
            validate_declared_view(&manifest, &"x".repeat(257)).unwrap_err(),
            "PLUGIN_INVALID_ARGUMENT"
        );
    }

    #[test]
    fn status_items_validate_manifest_identity_and_public_display_fields() {
        let manifest = json!({"contributes":{"statusBar":[
            {"id":"com.example.status","text":"Default"}
        ]}});
        let item = read_status_item(
            &manifest,
            &json!({"item":{
                "id":"com.example.status", "text":"Ready", "tooltip":"Running",
                "internalPath":"E:/private/file"
            }}),
        )
        .unwrap();
        assert_eq!(
            item,
            json!({"id":"com.example.status", "text":"Ready", "tooltip":"Running"})
        );
        assert_eq!(
            validate_status_item_id(&manifest, "other.status").unwrap_err(),
            "PLUGIN_CONTRIBUTION_NOT_DECLARED"
        );
        assert_eq!(
            validate_status_item_id(&manifest, " ").unwrap_err(),
            "PLUGIN_INVALID_ARGUMENT"
        );
        for params in [
            json!(null),
            json!({"item":{"id":"com.example.status"}}),
            json!({"item":{"id":"com.example.status","text":42}}),
            json!({"item":{"id":"com.example.status","text":"Ready","tooltip":null}}),
            json!({"item":{"id":"com.example.status","text":"x".repeat(4_097)}}),
        ] {
            assert_eq!(
                read_status_item(&manifest, &params).unwrap_err(),
                "PLUGIN_INVALID_ARGUMENT"
            );
        }
    }

    #[test]
    fn status_item_snapshots_preserve_order_and_isolate_windows_and_plugins() {
        let state = PluginRpcState::default();
        let items = json!([
            {"id":"com.example.first","text":"First"},
            {"id":"com.example.second","text":"Second"}
        ]);
        let key = ("main".to_string(), "com.example.plugin".to_string());
        state.registrations.lock().unwrap().status_items.insert(
            key.clone(),
            HashMap::from([
                (
                    "com.example.first".into(),
                    Some(json!({"id":"com.example.first","text":"Updated"})),
                ),
                ("com.example.second".into(), None),
                (
                    "undeclared.status".into(),
                    Some(json!({"id":"undeclared.status","text":"Hidden"})),
                ),
            ]),
        );
        assert_eq!(
            state
                .merge_status_items("main", "com.example.plugin", &items)
                .unwrap(),
            json!([{"id":"com.example.first","text":"Updated"}])
        );
        assert_eq!(
            state
                .merge_status_items("other", "com.example.plugin", &items)
                .unwrap(),
            items
        );
        assert_eq!(
            state
                .merge_status_items("main", "other.plugin", &items)
                .unwrap(),
            items
        );
        state
            .registrations
            .lock()
            .unwrap()
            .status_items
            .get_mut(&key)
            .unwrap()
            .insert(
                "com.example.second".into(),
                Some(json!({"id":"com.example.second","text":"Restored"})),
            );
        assert_eq!(
            state
                .merge_status_items("main", "com.example.plugin", &items)
                .unwrap()[1]["text"],
            "Restored"
        );
        state.dispose_window("main");
        assert_eq!(
            state
                .merge_status_items("main", "com.example.plugin", &items)
                .unwrap(),
            items
        );
    }
    #[test]
    fn errors_preserve_public_codes_and_hide_internal_paths() {
        let reply = response("id".into(), Err("E:/private/file: access denied".into()));
        assert_eq!(reply.error.unwrap().code, "PLUGIN_API_FAILED");
        let reply = response("id".into(), Err("PLUGIN_PERMISSION_DENIED".into()));
        assert_eq!(reply.error.unwrap().code, "PLUGIN_PERMISSION_DENIED");
        let reply = response("id".into(), Ok(Value::Null));
        assert!(reply.ok);
        assert_eq!(reply.protocol_version, 1);
        assert_eq!(reply.request_id, "id");
    }
    #[test]
    fn repository_query_requires_read_permission_for_every_plugin() {
        assert_eq!(
            validate_repository_permission(&json!({"id":"com.example.third-party"})).unwrap_err(),
            "PLUGIN_PERMISSION_DENIED"
        );
        assert!(
            validate_repository_permission(&json!({"id":"com.example.third-party",
            "permissions":[{"id":"workspace.read","scope":["notes/**"]}]}))
            .is_ok()
        );
    }

    #[test]
    fn workspace_routes_require_the_declared_permission_and_map_errors() {
        let manifest = json!({"permissions":[{"id":"workspace.read"}]});
        assert!(validate_permission(&manifest, "workspace.read").is_ok());
        assert_eq!(
            validate_permission(&manifest, "workspace.write").unwrap_err(),
            "PLUGIN_PERMISSION_DENIED"
        );
        assert_eq!(
            map_workspace_error("not-found"),
            "PLUGIN_FILESYSTEM_NOT_FOUND"
        );
        assert_eq!(
            map_workspace_error("outside-workspace"),
            "PLUGIN_FILESYSTEM_PATH_INVALID"
        );
        assert_eq!(
            map_workspace_error("unsupported-encoding"),
            "PLUGIN_FILESYSTEM_ENCODING_UNSUPPORTED"
        );
        assert_eq!(
            map_workspace_error("unexpected-internal-error"),
            "PLUGIN_API_FAILED"
        );
    }

    #[test]
    fn workspace_copy_path_checks_permissions_scope_and_path_kind() {
        let root =
            std::env::temp_dir().join(format!("wstudio-plugin-copy-path-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("allowed")).unwrap();
        std::fs::create_dir_all(root.join("private")).unwrap();
        std::fs::write(root.join("allowed/note.md"), "note").unwrap();
        std::fs::write(root.join("private/secret.md"), "secret").unwrap();
        let root = root.canonicalize().unwrap();
        let manifest = json!({"permissions":[
            {"id":"workspace.read","scope":["allowed/**"]},
            {"id":"clipboard.write"}
        ]});

        assert_eq!(
            resolve_plugin_copy_path(&manifest, &root, "allowed/note.md", "content-root").unwrap(),
            "allowed/note.md"
        );
        assert_eq!(
            resolve_plugin_copy_path(&manifest, &root, "allowed/note.md", "repository-root")
                .unwrap(),
            root.to_string_lossy()
        );
        assert_eq!(
            resolve_plugin_copy_path(&manifest, &root, "allowed/note.md", "absolute").unwrap(),
            root.join("allowed/note.md").to_string_lossy()
        );
        assert_eq!(
            resolve_plugin_copy_path(&manifest, &root, "private/secret.md", "absolute")
                .unwrap_err(),
            "PLUGIN_PERMISSION_SCOPE_VIOLATION"
        );
        assert_eq!(
            resolve_plugin_copy_path(&manifest, &root, "../outside", "absolute").unwrap_err(),
            "PLUGIN_FILESYSTEM_PATH_INVALID"
        );
        assert_eq!(
            resolve_plugin_copy_path(&manifest, &root, "allowed/note.md", "unknown").unwrap_err(),
            "PLUGIN_INVALID_ARGUMENT"
        );
        assert_eq!(
            resolve_plugin_copy_path(
                &json!({"permissions":[{"id":"workspace.read","scope":["**"]}]}),
                &root,
                "allowed/note.md",
                "absolute"
            )
            .unwrap_err(),
            "PLUGIN_PERMISSION_DENIED"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn markdown_public_dto_only_contains_repository_relative_path() {
        let dto = public_markdown_file(
            MarkdownFile {
                path: "E:/private/workspace/notes.md".into(),
                relative_path: "notes.md".into(),
                content: "# Note".into(),
            },
            "notes.md".into(),
        );
        assert_eq!(dto["path"], "notes.md");
        assert_eq!(dto["relativePath"], "notes.md");
        assert_eq!(dto["content"], "# Note");
        assert!(!dto.to_string().contains("E:/private"));
    }

    #[test]
    fn external_file_request_preserves_text_media_and_validation_contracts() {
        let root =
            std::env::temp_dir().join(format!("wstudio-plugin-open-file-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let repository = super::super::RepositorySummary {
            id: "repository-1".into(),
            name: "workspace".into(),
        };
        let text_path = root.join("note.md");
        std::fs::write(&text_path, b"\xef\xbb\xbf# Note").unwrap();
        let text = build_external_open_file_request(&text_path, &repository)
            .unwrap()
            .unwrap();
        assert_eq!(text["content"], "# Note");
        assert_eq!(text["repositoryId"], "repository-1");
        assert_eq!(text["temporary"], true);
        assert!(text.get("relativePath").is_none());

        let image_path = root.join("image.png");
        std::fs::write(&image_path, [0u8, 1, 2]).unwrap();
        let image = build_external_open_file_request(&image_path, &repository)
            .unwrap()
            .unwrap();
        assert_eq!(image["kind"], "image");
        assert_eq!(image["mediaMimeType"], "image/png");
        assert!(image.get("content").is_none());

        let binary_path = root.join("unknown.bin");
        std::fs::write(&binary_path, [0, 1, 2]).unwrap();
        assert_eq!(
            build_external_open_file_request(&binary_path, &repository).unwrap_err(),
            "PLUGIN_FILESYSTEM_ENCODING_UNSUPPORTED"
        );

        let oversized_path = root.join("large.txt");
        std::fs::File::create(&oversized_path)
            .unwrap()
            .set_len(MAX_PLUGIN_TEXT_FILE_SIZE + 1)
            .unwrap();
        assert_eq!(
            build_external_open_file_request(&oversized_path, &repository).unwrap_err(),
            "PLUGIN_FILESYSTEM_FILE_TOO_LARGE"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn closing_one_window_preserves_other_window_registrations() {
        let state = PluginRpcState::default();
        {
            let mut values = state.registrations.lock().unwrap();
            for label in ["main", "wstudio-other"] {
                let key = (label.into(), "com.example.plugin".into());
                values
                    .commands
                    .insert(key.clone(), HashSet::from(["example.command".into()]));
                values.status_items.insert(
                    key.clone(),
                    HashMap::from([(
                        "com.example.status".into(),
                        Some(json!({"id":"com.example.status","text":"Ready"})),
                    )]),
                );
                values.quotas.insert(key, WindowQuota::default());
            }
        }
        state.dispose_window("main");
        state.dispose_window("main");
        let values = state.registrations.lock().unwrap();
        assert_eq!(values.commands.len(), 1);
        assert_eq!(values.quotas.len(), 1);
        assert_eq!(values.status_items.len(), 1);
        assert!(values
            .status_items
            .keys()
            .all(|(window, _)| window == "wstudio-other"));
        assert!(values
            .commands
            .keys()
            .all(|(window, _)| window == "wstudio-other"));
    }
}
