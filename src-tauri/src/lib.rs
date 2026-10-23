//! WStudio Tauri host: native commands, workspace services and desktop lifecycle.
mod ai_credentials;
mod file_commit;
mod login;
mod native_process;
mod plugin_filesystem;
mod plugin_host;
mod plugin_package;
mod plugin_registry;
mod plugin_rpc;
mod plugin_settings;
mod plugin_sidecar;
#[cfg(target_os = "macos")]
mod system_fonts_macos;
mod taskbar_jump_list;
mod user_data_migration;
mod web_viewer;
mod web_viewer_save;
mod workspace_entry_picker;
mod workspace_lock;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use futures_util::StreamExt;
use login::{
    login_cancel, login_get_receipt, login_get_receipts, login_github_begin, login_google_begin,
    login_logout, login_select_account, login_wait, LoginState,
};
use plugin_registry::migrate_legacy_data;
use plugin_registry::{
    plugin_install, plugin_rollback, plugin_set_enabled, plugin_set_permissions, plugin_uninstall,
    plugin_update, PluginRegistryState,
};
use plugin_rpc::{plugin_invoke_renderer, PluginRpcState};
use plugin_settings::PluginSettingsState;
use rand::{rngs::OsRng, RngCore};
use rusqlite::{
    params_from_iter,
    types::{Value as SqlValue, ValueRef},
    Connection, OptionalExtension,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, SystemTime};
use taskbar_jump_list::taskbar_record_closed_tab;
use tauri::{
    AppHandle, Emitter, Manager, Runtime, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    Window,
};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::{oneshot, Notify};
use uuid::Uuid;
use workspace_entry_picker::workspace_pick_entry;

const MAX_PLUGIN_TEXT_FILE_SIZE: u64 = 2 * 1024 * 1024;
const MAX_PLUGIN_PROTECTED_FILE_SIZE: u64 = 64 * 1024 * 1024;
const PLUGIN_ENCRYPTION_MAGIC: &[u8; 8] = b"WSTUDIO3";
const PLUGIN_ENCRYPTION_VERSION: u8 = 1;
const PLUGIN_ENCRYPTION_SALT_LENGTH: usize = 16;
const PLUGIN_ENCRYPTION_NONCE_LENGTH: usize = 12;
const PLUGIN_ENCRYPTION_TAG_LENGTH: usize = 16;
const PLUGIN_ENCRYPTION_HEADER_LENGTH: usize = 8 + 1 + 16 + 12 + 16;
const MAX_PLUGIN_NOTIFICATION_MESSAGE_LENGTH: usize = 300;
const MAX_PLUGIN_NOTIFICATION_TITLE_LENGTH: usize = 120;
const DEFAULT_PLUGIN_NOTIFICATION_DURATION_MS: u64 = 4_000;
const MIN_PLUGIN_NOTIFICATION_DURATION_MS: u64 = 1_000;
const MAX_PLUGIN_NOTIFICATION_DURATION_MS: u64 = 30_000;
const MAX_PLUGIN_STORAGE_FILE_SIZE: usize = 1024 * 1024;
const MAX_PLUGIN_STORAGE_VALUE_SIZE: usize = 512 * 1024;
const MAX_PLUGIN_STORAGE_KEY_LENGTH: usize = 128;
const AI_PROVIDER_RETRY_DELAYS_MS: [u64; 2] = [400, 1_000];
static ACTIVE_PLUGIN_KEY_DERIVATIONS: AtomicUsize = AtomicUsize::new(0);
static WORKBENCH_WINDOW_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
struct AppInfo {
    runtime: &'static str,
    version: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositorySummary {
    id: String,
    name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentRepository {
    id: String,
    name: String,
    display_path: String,
    root_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentRepositorySummary {
    id: String,
    name: String,
    display_path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileChangedEvent {
    repository_id: String,
    path: String,
    kind: WorkspaceFileChangeKind,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum WorkspaceFileChangeKind {
    Created,
    Modified,
    Deleted,
}

#[derive(Clone, Copy)]
enum LocalMediaRange {
    None,
    Range { start: u64, end: u64 },
    Unsatisfiable,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistedWorkspace {
    current_path: Option<String>,
    recent_repositories: Vec<RecentRepository>,
    #[serde(default)]
    recent_closed_tabs: Vec<taskbar_jump_list::RecentClosedTab>,
}

struct WorkspaceState {
    root: Mutex<PathBuf>,
    recent: Mutex<Vec<RecentRepository>>,
    recent_closed: Mutex<Vec<taskbar_jump_list::RecentClosedTab>>,
    initial_open_file: Mutex<Option<String>>,
    persistence_path: PathBuf,
}

struct DatabaseState {
    connection: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditorDocumentSnapshot {
    path: String,
    content: String,
    selection: Option<EditorSelectionSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EditorSelectionSnapshot {
    start: usize,
    end: usize,
}

#[derive(Default)]
struct EditorState {
    active_document: Mutex<Option<EditorDocumentSnapshot>>,
}

#[derive(Default)]
struct ActivityState {
    last_activity: Mutex<Option<SystemTime>>,
}

/// Serialize storage reads and mutations across plugin windows to prevent lost updates.
#[derive(Default)]
struct PluginStorageState {
    operation: Mutex<()>,
}

/// Tracks pending Tauri plugin dialog requests until a trusted window responds.
#[derive(Default)]
struct PluginDialogState {
    pending: Mutex<HashMap<String, oneshot::Sender<PluginDialogResponseRequest>>>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PluginWindowOpenRequest {
    kind: Option<String>,
    title: Option<String>,
    file_path: Option<String>,
    reuse: Option<String>,
    position: Option<PluginWindowPositionRequest>,
    size: Option<PluginWindowSizeRequest>,
    bounds: Option<PluginWindowBoundsRequest>,
    state: Option<String>,
    view_type: Option<String>,
    plugin_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginWindowUpdateRequest {
    window_id: String,
    title: Option<String>,
    position: Option<PluginWindowPositionRequest>,
    size: Option<PluginWindowSizeRequest>,
    bounds: Option<PluginWindowBoundsRequest>,
    state: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginWindowIdRequest {
    window_id: String,
}

#[derive(Debug, Clone, Deserialize)]
struct PluginWindowPositionRequest {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Deserialize)]
struct PluginWindowSizeRequest {
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, Deserialize)]
struct PluginWindowBoundsRequest {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Clone)]
struct PluginWindowMetadata {
    kind: String,
    owner_plugin_id: Option<String>,
    view_type: Option<String>,
}

static PLUGIN_WINDOW_METADATA: OnceLock<Mutex<HashMap<String, PluginWindowMetadata>>> =
    OnceLock::new();

static PENDING_REPOSITORY_MANAGER_REQUESTS: OnceLock<Mutex<HashMap<String, serde_json::Value>>> =
    OnceLock::new();

fn plugin_window_metadata() -> &'static Mutex<HashMap<String, PluginWindowMetadata>> {
    PLUGIN_WINDOW_METADATA.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pending_repository_manager_requests() -> &'static Mutex<HashMap<String, serde_json::Value>> {
    PENDING_REPOSITORY_MANAGER_REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Keep native macOS corners and traffic lights alongside the custom toolbar.
fn with_default_window_chrome<'a, R, M>(
    builder: WebviewWindowBuilder<'a, R, M>,
    icon: Option<tauri::image::Image<'static>>,
) -> Result<WebviewWindowBuilder<'a, R, M>, String>
where
    R: Runtime,
    M: Manager<R>,
{
    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        // This inset sizes the native titlebar container; it is not a top offset.
        // AppKit's button frame already has a vertical inset: 18 centers it in 32px.
        .traffic_light_position(tauri::LogicalPosition::new(12.0, 18.0));

    let Some(icon) = icon else {
        return Ok(builder);
    };
    builder.icon(icon).map_err(|error| error.to_string())
}

/// Set the large native icon used by the Windows taskbar for a created window.
#[cfg(target_os = "windows")]
fn apply_windows_taskbar_icon<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HINSTANCE, LPARAM, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        LoadImageW, ICON_BIG, IMAGE_ICON, LR_DEFAULTSIZE, LR_SHARED, WM_SETICON,
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let module = unsafe { GetModuleHandleW(None) }.map_err(|error| error.to_string())?;
    let icon = unsafe {
        LoadImageW(
            Some(HINSTANCE(module.0)),
            PCWSTR(tauri::utils::platform::WINDOWS_APP_ICON_RESOURCE_ID as *const u16),
            IMAGE_ICON,
            32,
            32,
            LR_DEFAULTSIZE | LR_SHARED,
        )
    }
    .map_err(|error| error.to_string())?;
    unsafe {
        windows::Win32::UI::WindowsAndMessaging::SendMessageW(
            hwnd,
            WM_SETICON,
            Some(WPARAM(ICON_BIG as usize)),
            Some(LPARAM(icon.0 as isize)),
        );
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn apply_windows_taskbar_icon<R: Runtime>(_window: &WebviewWindow<R>) -> Result<(), String> {
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThemeMaterializeBuiltinRequest {
    category: String,
    file_name: String,
    variant: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceOpenTextRequest {
    repository_id: String,
    file_path: String,
    relative_path: String,
    title: String,
    kind: &'static str,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    position: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selection_end: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vertical_alignment: Option<String>,
    disposition: &'static str,
}

#[derive(Debug, Deserialize)]
struct SqlQueryRequest {
    sql: String,
    params: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SqlRunResult {
    changes: u64,
    last_insert_rowid: i64,
}

fn normalize_sql_request(request: &SqlQueryRequest) -> Result<Vec<SqlValue>, String> {
    if request.sql.trim().is_empty() {
        return Err("SQL_QUERY_REQUIRED".to_string());
    }
    if request.sql.len() > 1_000_000 {
        return Err("SQL_QUERY_TOO_LARGE".to_string());
    }
    let params = request.params.as_deref().unwrap_or_default();
    if params.len() > 10_000 {
        return Err("SQL_PARAMETERS_INVALID".to_string());
    }
    params.iter().map(json_to_sql_value).collect()
}

fn json_to_sql_value(value: &serde_json::Value) -> Result<SqlValue, String> {
    match value {
        serde_json::Value::Null => Ok(SqlValue::Null),
        serde_json::Value::String(value) => Ok(SqlValue::Text(value.clone())),
        serde_json::Value::Number(value) => value
            .as_i64()
            .map(SqlValue::Integer)
            .or_else(|| value.as_u64().map(|value| SqlValue::Integer(value as i64)))
            .or_else(|| value.as_f64().map(SqlValue::Real))
            .ok_or_else(|| "SQL_PARAMETERS_INVALID".to_string()),
        serde_json::Value::Array(values)
            if values
                .iter()
                .all(|value| value.as_u64().is_some_and(|item| item <= 255)) =>
        {
            Ok(SqlValue::Blob(
                values
                    .iter()
                    .map(|value| value.as_u64().unwrap_or_default() as u8)
                    .collect(),
            ))
        }
        _ => Err("SQL_PARAMETERS_INVALID".to_string()),
    }
}

fn sql_value_to_json(value: ValueRef<'_>) -> serde_json::Value {
    match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(value) => serde_json::Value::from(value),
        ValueRef::Real(value) => serde_json::Value::from(value),
        ValueRef::Text(value) => {
            serde_json::Value::String(String::from_utf8_lossy(value).into_owned())
        }
        ValueRef::Blob(value) => serde_json::Value::Array(
            value
                .iter()
                .map(|item| serde_json::Value::from(*item))
                .collect(),
        ),
    }
}

fn sql_row_to_json(
    row: &rusqlite::Row<'_>,
) -> Result<serde_json::Map<String, serde_json::Value>, rusqlite::Error> {
    let mut result = serde_json::Map::new();
    for index in 0..row.as_ref().column_count() {
        let name = row.as_ref().column_name(index)?.to_string();
        result.insert(name, sql_value_to_json(row.get_ref(index)?));
    }
    Ok(result)
}

impl WorkspaceState {
    fn persist(&self) -> Result<(), String> {
        let current_path = self
            .root
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())?;
        let recent = self
            .recent
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())?;
        let recent_closed = self
            .recent_closed
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())?;
        let payload = PersistedWorkspace {
            current_path: Some(current_path.to_string_lossy().into_owned()),
            recent_repositories: recent.clone(),
            recent_closed_tabs: recent_closed.clone(),
        };
        if let Some(parent) = self.persistence_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let contents = serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?;
        fs::write(&self.persistence_path, contents).map_err(|error| error.to_string())?;
        taskbar_jump_list::repositories_saved(
            &payload.recent_repositories,
            &payload.recent_closed_tabs,
        );
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileEntry {
    path: String,
    relative_path: String,
    name: String,
    #[serde(rename = "type")]
    entry_type: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceMarkdownFileMetadata {
    path: String,
    relative_path: String,
    name: String,
    size: u64,
    modified_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDirectoryEntry {
    relative_path: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveFileRequest {
    source_relative_path: String,
    target_directory_relative_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
enum MoveFileResult {
    #[serde(rename = "moved")]
    Moved {
        file_path: String,
        relative_path: String,
        title: String,
    },
    #[serde(rename = "rejected")]
    Rejected { reason: &'static str },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDateNoteRequest {
    source_file_path: String,
    date: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportExternalMediaRequest {
    source_path: String,
    markdown_file_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "status")]
enum ImportExternalMediaResult {
    #[serde(rename = "copied")]
    Copied {
        relative_path: String,
        reference_path: String,
        title: String,
    },
    #[serde(rename = "rejected")]
    Rejected { reason: &'static str },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
enum CreateDateNoteResult {
    #[serde(rename = "created")]
    Created { file: MarkdownFile },
    #[serde(rename = "existing")]
    Existing { file: MarkdownFile },
    #[serde(rename = "rejected")]
    Rejected { reason: &'static str },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkdownFile {
    path: String,
    relative_path: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateMarkdownRequest {
    path: String,
    expected_content: String,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
enum UpdateMarkdownResult {
    #[serde(rename = "updated")]
    Updated { file: MarkdownFile },
    #[serde(rename = "unchanged")]
    Unchanged { file: MarkdownFile },
    #[serde(rename = "conflict")]
    Conflict { file: MarkdownFile },
    #[serde(rename = "rejected")]
    Rejected { reason: &'static str },
}

fn workspace_root(state: &State<'_, WorkspaceState>) -> Result<PathBuf, String> {
    workspace_root_from_inner(state.inner())
}

fn workspace_root_from_inner(state: &WorkspaceState) -> Result<PathBuf, String> {
    state
        .root
        .lock()
        .map(|root| root.clone())
        .map_err(|_| "workspace-state-poisoned".to_string())
}

fn workspace_root_from_app(app: &AppHandle) -> Result<PathBuf, String> {
    let state = app
        .try_state::<WorkspaceState>()
        .ok_or_else(|| "workspace-state-unavailable".to_string())?;
    workspace_root_from_inner(state.inner())
}

fn repository_id(root: &Path) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    root.hash(&mut hasher);
    format!("tauri-{:#x}", hasher.finish())
}

fn repository_summary(root: &Path) -> RepositorySummary {
    RepositorySummary {
        id: repository_id(root),
        name: root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("WStudio")
            .to_string(),
    }
}

fn display_path(root: &Path) -> String {
    let components: Vec<String> = root
        .components()
        .filter_map(|component| {
            let value = component.as_os_str().to_string_lossy().into_owned();
            (!value.is_empty()).then_some(value)
        })
        .collect();
    if components.len() <= 2 {
        return components.join("/");
    }
    format!(
        ".../{}/{}",
        components[components.len() - 2],
        components[components.len() - 1]
    )
}

fn recent_from_root(root: &Path) -> RecentRepository {
    RecentRepository {
        id: repository_id(root),
        name: root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("WStudio")
            .to_string(),
        display_path: display_path(root),
        root_path: root.to_string_lossy().into_owned(),
    }
}

/// Restore the same persisted workspace used by startup after legacy-data migration.
fn restore_workspace_state(persistence_path: PathBuf) -> Result<WorkspaceState, String> {
    let persisted = fs::read(&persistence_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PersistedWorkspace>(&bytes).ok())
        .unwrap_or_default();
    let root = persisted
        .current_path
        .as_deref()
        .and_then(|path| canonical_directory(path).ok())
        .or_else(|| std::env::current_dir().ok()?.canonicalize().ok())
        .ok_or_else(|| "WORKSPACE_ROOT_UNAVAILABLE".to_string())?;
    let mut recent = persisted.recent_repositories;
    let mut current = recent_from_root(&root);
    if let Some(previous) = recent
        .iter()
        .find(|item| item.id == current.id && !item.name.trim().is_empty())
    {
        current.name = previous.name.clone();
    }
    recent.retain(|item| item.id != current.id);
    recent.insert(0, current);
    Ok(WorkspaceState {
        root: Mutex::new(root),
        recent: Mutex::new(recent),
        recent_closed: Mutex::new(persisted.recent_closed_tabs),
        initial_open_file: Mutex::new(None),
        persistence_path,
    })
}

fn publish_repository_changed(app: &AppHandle, root: &Path) -> Result<(), String> {
    app.emit("workspace:repositoryChanged", repository_summary(root))
        .map_err(|error| error.to_string())
}

fn canonical_directory(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value)
        .canonicalize()
        .map_err(|_| "repository-not-found".to_string())?;
    if !path.is_dir() {
        return Err("repository-not-directory".to_string());
    }
    Ok(path)
}

fn remember_repository(state: &WorkspaceState, root: &Path) -> Result<(), String> {
    {
        let mut current = state
            .root
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())?;
        *current = root.to_path_buf();
    }
    {
        let mut recent = state
            .recent
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())?;
        let entry = recent_from_root(root);
        recent.retain(|item| item.id != entry.id);
        recent.insert(0, entry);
        recent.truncate(20);
    }
    state.persist()
}

fn normalize_relative_path(root: &Path, value: &str) -> Result<PathBuf, &'static str> {
    let candidate = Path::new(value);
    if value.trim().is_empty() {
        return Err("outside-workspace");
    }

    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    let normalized = joined.canonicalize().map_err(|_| "not-found")?;
    if normalized.strip_prefix(root).is_err() {
        return Err("outside-workspace");
    }
    Ok(normalized)
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn markdown_file(root: &Path, path: &Path) -> Result<MarkdownFile, &'static str> {
    let content = fs::read_to_string(path).map_err(|_| "unsupported-encoding")?;
    let relative_path = relative_path(root, path);
    Ok(MarkdownFile {
        path: path.to_string_lossy().into_owned(),
        relative_path,
        content,
    })
}

fn collect_files(
    root: &Path,
    directory: &Path,
    result: &mut Vec<WorkspaceFileEntry>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.')
            || matches!(
                name.as_str(),
                "node_modules" | "dist" | "dist-electron" | "target"
            )
        {
            continue;
        }
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            collect_files(root, &path, result)?;
        } else if metadata.is_file() {
            result.push(WorkspaceFileEntry {
                path: path.to_string_lossy().into_owned(),
                relative_path: relative_path(root, &path),
                name,
                entry_type: "file",
            });
        }
    }
    Ok(())
}

fn collect_markdown_files(
    root: &Path,
    directory: &Path,
    result: &mut Vec<WorkspaceMarkdownFileMetadata>,
) -> Result<(), String> {
    collect_scoped_markdown_files(root, directory, result, usize::MAX, &|_| true, &|| Ok(()))
}

/// Share bounded Markdown enumeration between the workbench and the plugin scope gateway.
fn collect_scoped_markdown_files(
    root: &Path,
    directory: &Path,
    result: &mut Vec<WorkspaceMarkdownFileMetadata>,
    limit: usize,
    is_allowed: &impl Fn(&str) -> bool,
    check_active: &impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    check_active()?;
    if result.len() >= limit {
        return Ok(());
    }
    let mut entries = fs::read_dir(directory)
        .map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED".to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED".to_string())?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        check_active()?;
        if result.len() >= limit {
            break;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.')
            || matches!(
                name.as_str(),
                "node_modules" | "dist" | "dist-electron" | "target"
            )
        {
            continue;
        }
        // Never follow directory links during traversal, including links forming a cycle.
        let file_type = entry
            .file_type()
            .map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED".to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_scoped_markdown_files(root, &path, result, limit, is_allowed, check_active)?;
            continue;
        }
        if !file_type.is_file()
            || !is_allowed(&relative_path(root, &path))
            || !matches!(
                path.extension().and_then(|value| value.to_str()),
                Some(extension) if extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
            )
        {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED".to_string())?;
        let modified_at = metadata
            .modified()
            .unwrap_or(SystemTime::UNIX_EPOCH)
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        result.push(WorkspaceMarkdownFileMetadata {
            path: path.to_string_lossy().into_owned(),
            relative_path: relative_path(root, &path),
            name,
            size: metadata.len(),
            modified_at,
        });
    }
    Ok(())
}

fn collect_directories(
    root: &Path,
    directory: &Path,
    result: &mut Vec<WorkspaceDirectoryEntry>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.')
            || matches!(
                name.as_str(),
                "node_modules" | "dist" | "dist-electron" | "target"
            )
        {
            continue;
        }
        if entry
            .metadata()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            let relative = relative_path(root, &path);
            let parent = Path::new(&relative)
                .parent()
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            result.push(WorkspaceDirectoryEntry {
                relative_path: relative,
                name,
                parent_path: parent,
            });
            collect_directories(root, &path, result)?;
        }
    }
    Ok(())
}

fn workspace_snapshot(root: &Path) -> Result<std::collections::HashMap<String, u128>, String> {
    fn collect(
        directory: &Path,
        result: &mut std::collections::HashMap<String, u128>,
    ) -> Result<(), String> {
        for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.')
                || matches!(
                    name.as_str(),
                    "node_modules" | "dist" | "dist-electron" | "target"
                )
            {
                continue;
            }
            let metadata = entry.metadata().map_err(|error| error.to_string())?;
            if metadata.is_dir() {
                collect(&path, result)?;
            } else if metadata.is_file() {
                let modified = metadata
                    .modified()
                    .unwrap_or(SystemTime::UNIX_EPOCH)
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                result.insert(path.to_string_lossy().into_owned(), modified);
            }
        }
        Ok(())
    }
    let mut result = std::collections::HashMap::new();
    collect(root, &mut result)?;
    Ok(result)
}

fn workspace_file_changes(
    root: &Path,
    repository_id: &str,
    previous: &HashMap<String, u128>,
    current: &HashMap<String, u128>,
) -> Vec<WorkspaceFileChangedEvent> {
    let mut paths: Vec<String> = previous.keys().chain(current.keys()).cloned().collect();
    paths.sort_unstable();
    paths.dedup();

    paths
        .into_iter()
        .filter_map(|path| {
            let kind = match (previous.get(&path), current.get(&path)) {
                (None, Some(_)) => WorkspaceFileChangeKind::Created,
                (Some(_), None) => WorkspaceFileChangeKind::Deleted,
                (Some(previous), Some(current)) if previous != current => {
                    WorkspaceFileChangeKind::Modified
                }
                _ => return None,
            };
            Some(WorkspaceFileChangedEvent {
                repository_id: repository_id.to_string(),
                path: relative_path(root, Path::new(&path)),
                kind,
            })
        })
        .collect()
}

fn start_workspace_watcher(app: AppHandle) {
    thread::spawn(move || {
        let mut previous = std::collections::HashMap::new();
        loop {
            thread::sleep(Duration::from_millis(1000));
            let state = app.state::<WorkspaceState>();
            let root = match workspace_root(&state) {
                Ok(root) => root,
                Err(_) => continue,
            };
            let current = match workspace_snapshot(&root) {
                Ok(snapshot) => snapshot,
                Err(_) => continue,
            };
            if current != previous {
                if !previous.is_empty() {
                    let repository = repository_id(&root);
                    for event in workspace_file_changes(&root, &repository, &previous, &current) {
                        let _ = app.emit("workspace:fileChanged", event);
                    }
                    let payload = serde_json::json!({
                        "repositoryId": repository
                    });
                    let _ = app.emit("workspace:directoryChanged", payload);
                }
                previous = current;
            }
        }
    });
}

fn normalize_existing_relative_path(root: &Path, value: &str) -> Result<PathBuf, &'static str> {
    if value.trim().is_empty() || Path::new(value).is_absolute() {
        return Err("outside-workspace");
    }
    normalize_relative_path(root, value)
}

fn normalize_date(value: &str) -> Option<String> {
    let parts: Vec<&str> = value.split(['-', '/']).collect();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
        return None;
    }
    let year = parts[0].parse::<u32>().ok()?;
    let month = parts[1].parse::<u32>().ok()?;
    let day = parts[2].parse::<u32>().ok()?;
    if year == 0 || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days_in_month = match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if day > days_in_month {
        return None;
    }
    Some(format!("{}-{}-{}", parts[0], parts[1], parts[2]))
}

fn is_supported_media(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some(
            "png"
                | "jpg"
                | "jpeg"
                | "gif"
                | "webp"
                | "svg"
                | "bmp"
                | "ico"
                | "mp3"
                | "wav"
                | "ogg"
                | "m4a"
                | "flac"
                | "aac"
                | "mp4"
                | "webm"
                | "mov"
                | "mkv"
                | "avi"
        )
    )
}

#[tauri::command]
fn app_ping() -> &'static str {
    "pong"
}

#[tauri::command]
fn app_get_version() -> AppInfo {
    AppInfo {
        runtime: "tauri",
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[tauri::command]
fn editor_set_active_document(
    document: Option<EditorDocumentSnapshot>,
    app: AppHandle,
    state: State<'_, EditorState>,
) -> Result<Option<EditorDocumentSnapshot>, String> {
    if let Some(snapshot) = document.as_ref() {
        if snapshot.path.trim().is_empty() || snapshot.path.len() > 4096 {
            return Err("EDITOR_DOCUMENT_INVALID".to_string());
        }
        if snapshot.content.len() > 16 * 1024 * 1024 {
            return Err("EDITOR_DOCUMENT_TOO_LARGE".to_string());
        }
        if let Some(selection) = snapshot.selection.as_ref() {
            if selection.start > selection.end
                || selection.end > snapshot.content.encode_utf16().count()
            {
                return Err("EDITOR_SELECTION_INVALID".to_string());
            }
        }
    }
    let mut active = state
        .active_document
        .lock()
        .map_err(|_| "EDITOR_STATE_POISONED".to_string())?;
    *active = document.clone();
    app.emit("plugin:editorDocumentChanged", document.clone())
        .map_err(|error| error.to_string())?;
    Ok(document)
}

#[tauri::command]
fn editor_get_active_document(
    state: State<'_, EditorState>,
) -> Result<Option<EditorDocumentSnapshot>, String> {
    state
        .active_document
        .lock()
        .map_err(|_| "EDITOR_STATE_POISONED".to_string())
        .map(|document| document.clone())
}

#[tauri::command]
fn theme_list_user_themes(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let themes_root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("themes");
    fs::create_dir_all(&themes_root).map_err(|error| error.to_string())?;
    let mut files = Vec::new();
    collect_theme_json_files(&themes_root, &mut files)?;
    let mut entries = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for file_path in files {
        if let Some(entry) = read_user_theme_entry(&themes_root, &file_path) {
            let id = entry
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string();
            if !id.is_empty() && ids.insert(id) {
                entries.push(entry);
            }
        }
    }
    entries.sort_by(|left, right| {
        let left_key = format!(
            "{}:{}",
            left.get("category")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default(),
            left.get("variant")
                .and_then(|value| value.get("displayName"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
        );
        let right_key = format!(
            "{}:{}",
            right
                .get("category")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default(),
            right
                .get("variant")
                .and_then(|value| value.get("displayName"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
        );
        left_key.cmp(&right_key)
    });
    Ok(entries)
}

#[tauri::command]
fn theme_materialize_builtin(
    request: ThemeMaterializeBuiltinRequest,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let variant = validate_theme_variant(request.variant)?;
    let category = normalize_theme_category(&request.category)?;
    let id = variant
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "THEME_VARIANT_INVALID".to_string())?;
    let file_name = normalize_theme_file_name(&request.file_name, id);
    let themes_root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("themes");
    let category_directory = themes_root.join(&category);
    fs::create_dir_all(&category_directory).map_err(|error| error.to_string())?;
    let target = category_directory.join(&file_name);
    if !target.exists() {
        let content = serde_json::to_vec_pretty(&variant).map_err(|error| error.to_string())?;
        fs::write(&target, content).map_err(|error| error.to_string())?;
    }
    read_user_theme_entry(&themes_root, &target)
        .filter(|entry| entry.get("id").and_then(serde_json::Value::as_str) == Some(id))
        .ok_or_else(|| "THEME_USER_COPY_INVALID".to_string())
}

fn collect_theme_json_files(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
    let mut paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            collect_theme_json_files(&path, files)?;
        } else if path.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
        {
            files.push(path);
        }
    }
    Ok(())
}

fn read_user_theme_entry(themes_root: &Path, file_path: &Path) -> Option<serde_json::Value> {
    let metadata = fs::metadata(file_path).ok()?;
    if metadata.len() > 2 * 1024 * 1024 {
        return None;
    }
    let variant = validate_theme_variant(
        serde_json::from_slice::<serde_json::Value>(&fs::read(file_path).ok()?).ok()?,
    )
    .ok()?;
    let relative = file_path.strip_prefix(themes_root).ok()?;
    let relative_path = relative.to_string_lossy().replace('\\', "/");
    let segments = relative_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let category = if segments.len() > 1 {
        segments[0].to_string()
    } else {
        Path::new(segments.first().copied().unwrap_or("theme"))
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("theme")
            .to_string()
    };
    let id = variant.get("id")?.clone();
    Some(serde_json::json!({
        "id": id,
        "category": category,
        "relativePath": relative_path,
        "variant": variant
    }))
}

fn validate_theme_variant(value: serde_json::Value) -> Result<serde_json::Value, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "THEME_VARIANT_INVALID".to_string())?;
    for key in ["id", "name", "displayName"] {
        if object
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map_or(true, |value| value.trim().is_empty())
        {
            return Err("THEME_VARIANT_INVALID".to_string());
        }
    }
    if !matches!(
        object.get("type").and_then(serde_json::Value::as_str),
        Some("light") | Some("dark")
    ) {
        return Err("THEME_VARIANT_INVALID".to_string());
    }
    if !object
        .get("colors")
        .is_some_and(serde_json::Value::is_object)
    {
        return Err("THEME_VARIANT_INVALID".to_string());
    }
    Ok(value)
}

fn normalize_theme_category(value: &str) -> Result<String, String> {
    let category = value.trim();
    if category.is_empty()
        || category == "."
        || category == ".."
        || category.contains('/')
        || category.contains('\\')
        || category.chars().any(|character| character.is_control())
    {
        return Err("THEME_CATEGORY_INVALID".to_string());
    }
    Ok(category.to_string())
}

fn normalize_theme_file_name(value: &str, fallback_id: &str) -> String {
    let file_name = value.trim();
    if file_name.to_ascii_lowercase().ends_with(".json")
        && Path::new(file_name)
            .file_name()
            .and_then(|name| name.to_str())
            == Some(file_name)
        && !file_name.chars().any(|character| character.is_control())
    {
        return file_name.to_string();
    }
    format!("{fallback_id}.json")
}

#[tauri::command]
fn plugin_list(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let mut summaries = app.state::<PluginRegistryState>().list()?;
    summaries.sort_by(|left, right| {
        left.get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .cmp(
                right
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default(),
            )
    });
    Ok(summaries)
}

#[tauri::command]
fn plugin_list_contributions(
    app: AppHandle,
    window: Window,
) -> Result<Vec<serde_json::Value>, String> {
    let mut contributions = app
        .state::<PluginRegistryState>()
        .contributions(window.label())?;
    for summary in &mut contributions {
        let plugin_id = summary["pluginId"].as_str().unwrap_or_default().to_string();
        let (_, manifest) = app.state::<PluginRegistryState>().metadata(&plugin_id)?;
        summary["statusBar"] = app.state::<PluginRpcState>().merge_status_items(
            window.label(),
            &plugin_id,
            &summary["statusBar"],
        )?;
        summary["settings"] = app
            .state::<PluginSettingsState>()
            .resolve(&plugin_id, &manifest)?;
    }
    contributions.sort_by(|left, right| {
        left.get("pluginName")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .cmp(
                right
                    .get("pluginName")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default(),
            )
    });
    Ok(contributions)
}

fn resolve_core_plugin_root(app: &AppHandle) -> PathBuf {
    let resource_root = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    let bundled = resource_root.join("plugin").join("core-plugins");
    if bundled.is_dir() {
        return bundled;
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("plugin")
        .join("core-plugins")
}

/// Resolve Electron application data for both plugin and native-storage migration.
fn resolve_legacy_user_data_root(app: &AppHandle) -> Option<PathBuf> {
    let base = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)?
            .join("wstudio")
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(PathBuf::from)?
            .join("Library")
            .join("Application Support")
            .join("wstudio")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?
            .join("wstudio")
    };
    let current = app.path().app_data_dir().ok()?;
    (base != current && base.is_dir()).then_some(base)
}

fn plugin_summary_from_manifest(manifest: &serde_json::Value) -> Option<serde_json::Value> {
    let object = manifest.as_object()?;
    let id = object.get("id")?.as_str()?.trim();
    let name = object.get("name")?.as_str()?.trim();
    let version = object.get("version")?.as_str()?.trim();
    if id.is_empty() || name.is_empty() || version.is_empty() {
        return None;
    }
    let permissions = object
        .get("permissions")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|permission| permission.get("id").and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    let permission_requests = object
        .get("permissions")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|permission| {
            let id = permission.get("id")?.as_str()?.to_string();
            let reason = permission
                .get("reason")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string();
            let scope = permission.get("scope").and_then(|value| {
                value.as_array().map(|items| {
                    items
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
            });
            Some(serde_json::json!({
                "id": id,
                "reason": reason,
                "scope": scope
            }))
        })
        .collect::<Vec<_>>();
    let privileged = permissions.iter().any(|permission| {
        matches!(
            permission.as_str(),
            "renderer.code" | "node.fs" | "node.process" | "node.native" | "electron.system"
        )
    });
    Some(serde_json::json!({
        "id": id,
        "name": name,
        "version": version,
        "description": object.get("description").and_then(serde_json::Value::as_str).unwrap_or_default(),
        "authorName": object.get("author").and_then(|author| author.get("name")).and_then(serde_json::Value::as_str).unwrap_or_default(),
        "enabled": false,
        "trustLevel": if privileged { "privileged" } else { "standard" },
        "state": "blocked",
        "permissions": permissions,
        "permissionRequests": permission_requests,
        "grantedPermissions": [],
        "isCore": true
    }))
}

fn plugin_contribution_summary_from_manifest(
    manifest: &serde_json::Value,
) -> Option<serde_json::Value> {
    let object = manifest.as_object()?;
    let plugin_id = object.get("id")?.as_str()?.trim();
    let plugin_name = object.get("name")?.as_str()?.trim();
    let plugin_version = object.get("version")?.as_str()?.trim();
    if plugin_id.is_empty() || plugin_name.is_empty() || plugin_version.is_empty() {
        return None;
    }
    let permissions = object
        .get("permissions")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|permission| permission.get("id").and_then(serde_json::Value::as_str));
    let privileged = permissions.clone().any(|permission| {
        matches!(
            permission,
            "renderer.code" | "node.fs" | "node.process" | "node.native" | "electron.system"
        )
    });
    let contributes = object
        .get("contributes")
        .and_then(serde_json::Value::as_object);
    let empty = serde_json::Value::Array(Vec::new());
    let commands = contributes
        .and_then(|value| value.get("commands"))
        .unwrap_or(&empty);
    let views = contributes
        .and_then(|value| value.get("views"))
        .unwrap_or(&empty);
    let settings = contributes
        .and_then(|value| value.get("settings"))
        .unwrap_or(&empty);
    let status_bar = contributes
        .and_then(|value| value.get("statusBar"))
        .unwrap_or(&empty);
    Some(serde_json::json!({
        "pluginId": plugin_id,
        "pluginName": plugin_name,
        "pluginVersion": plugin_version,
        "trustLevel": if privileged { "privileged" } else { "standard" },
        "entryUrl": "",
        "stylesUrl": "",
        "commands": commands,
        "views": views,
        "settings": settings,
        "statusBar": status_bar
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginSettingRequest {
    plugin_id: String,
    setting_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginSetSettingRequest {
    plugin_id: String,
    setting_id: String,
    field_id: String,
    value: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginCommandRequest {
    plugin_id: String,
    command_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginStorageKeyRequest {
    plugin_id: String,
    key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginStorageSetRequest {
    plugin_id: String,
    key: String,
    value: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct PluginStorageReadResult {
    found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginNotificationRequest {
    plugin_id: String,
    message: String,
    #[serde(rename = "type")]
    notification_type: Option<String>,
    title: Option<String>,
    duration: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginNotificationEvent {
    plugin_id: String,
    plugin_name: String,
    message: String,
    #[serde(rename = "type")]
    notification_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    duration: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginDialogRequest {
    plugin_id: String,
    method: String,
    params: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginDialogResponseRequest {
    request_id: String,
    status: String,
    value: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginEditorRevealRangeRequest {
    plugin_id: String,
    path: String,
    range: EditorSelectionSnapshot,
    options: Option<PluginEditorRevealRangeOptions>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginEditorRevealRangeOptions {
    vertical_alignment: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginEditorOpenFileRequest {
    plugin_id: String,
    path: String,
    options: Option<PluginEditorOpenFileOptions>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginEditorOpenFileOptions {
    disposition: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginEditorCloseTabsRequest {
    plugin_id: String,
    paths: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginWorkspacePathRequest {
    plugin_id: String,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemWriteTextOptions {
    expected_content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemWriteTextRequest {
    plugin_id: String,
    path: String,
    content: String,
    options: PluginFilesystemWriteTextOptions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemCreateFileRequest {
    plugin_id: String,
    path: String,
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemCreateDirectoryRequest {
    plugin_id: String,
    path: String,
    options: Option<PluginFilesystemCreateDirectoryOptions>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemCreateDirectoryOptions {
    recursive: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemDeleteRequest {
    plugin_id: String,
    path: String,
    options: Option<PluginFilesystemDeleteOptions>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemDeleteOptions {
    recursive: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemTransferRequest {
    plugin_id: String,
    source_path: String,
    destination_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemRenameRequest {
    plugin_id: String,
    path: String,
    new_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemProtectionRequest {
    plugin_id: String,
    path: String,
    password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemCopyOptions {
    recursive: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemCopyRequest {
    plugin_id: String,
    source_path: String,
    destination_path: String,
    options: Option<PluginFilesystemCopyOptions>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemListEntriesRequest {
    plugin_id: String,
    directory: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemEntry {
    path: String,
    name: String,
    #[serde(rename = "type")]
    entry_type: &'static str,
    size: u64,
    modified_at: u64,
    created_at: u64,
    encrypted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginFilesystemTextFile {
    path: String,
    name: String,
    #[serde(rename = "type")]
    entry_type: &'static str,
    size: u64,
    modified_at: u64,
    created_at: u64,
    encoding: &'static str,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginViewRequest {
    plugin_id: String,
    view_type: String,
    instance_id: String,
    initial_url: Option<String>,
    #[serde(default)]
    runtime_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginViewBoundsRequest {
    plugin_id: String,
    view_type: String,
    instance_id: String,
    initial_url: Option<String>,
    bounds: PluginViewBounds,
    #[serde(default)]
    occlusions: Vec<PluginViewBounds>,
    scrollbar_theme: Option<web_viewer::ScrollbarTheme>,
    #[serde(default)]
    runtime_id: String,
}

#[derive(Debug, Deserialize)]
struct PluginViewBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Resolve only enabled resources and the current grants for every core/ordinary capability.
fn find_active_plugin_manifest(
    app: &AppHandle,
    plugin_id: &str,
) -> Result<(PathBuf, serde_json::Value), String> {
    app.state::<PluginRegistryState>()
        .active_manifest(plugin_id)
}

fn plugin_setting_definition<'a>(
    manifest: &'a serde_json::Value,
    setting_id: &str,
) -> Result<&'a serde_json::Value, String> {
    manifest
        .get("contributes")
        .and_then(|value| value.get("settings"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .find(|setting| setting.get("id").and_then(serde_json::Value::as_str) == Some(setting_id))
        .ok_or_else(|| "PLUGIN_SETTING_NOT_DECLARED".to_string())
}

fn plugin_command_is_declared(manifest: &serde_json::Value, command_id: &str) -> bool {
    manifest
        .get("contributes")
        .and_then(|value| value.get("commands"))
        .and_then(serde_json::Value::as_array)
        .is_some_and(|commands| {
            commands.iter().any(|command| {
                command.get("id").and_then(serde_json::Value::as_str) == Some(command_id)
            })
        })
}

fn validate_plugin_command(manifest: &serde_json::Value, command_id: &str) -> Result<(), String> {
    if command_id.trim().is_empty() || !plugin_command_is_declared(manifest, command_id) {
        return Err("PLUGIN_COMMAND_NOT_DECLARED".to_string());
    }
    Ok(())
}

fn plugin_permission_is_declared(manifest: &serde_json::Value, permission_id: &str) -> bool {
    manifest
        .get("permissions")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|permissions| {
            permissions.iter().any(|permission| {
                permission.get("id").and_then(serde_json::Value::as_str) == Some(permission_id)
            })
        })
}

fn plugin_editor_vertical_alignment_is_valid(value: Option<&str>) -> bool {
    value.is_none_or(|candidate| matches!(candidate, "nearest" | "center" | "upper-center"))
}

fn plugin_view_request_is_valid(request: &PluginViewRequest) -> bool {
    !request.plugin_id.trim().is_empty()
        && !request.view_type.trim().is_empty()
        && !request.instance_id.trim().is_empty()
        && request
            .initial_url
            .as_deref()
            .is_none_or(|url| url.len() <= 4096)
}

fn plugin_view_bounds_request_is_valid(request: &PluginViewBoundsRequest) -> bool {
    plugin_view_request_is_valid(&PluginViewRequest {
        plugin_id: request.plugin_id.clone(),
        view_type: request.view_type.clone(),
        instance_id: request.instance_id.clone(),
        initial_url: request.initial_url.clone(),
        runtime_id: request.runtime_id.clone(),
    }) && [
        request.bounds.x,
        request.bounds.y,
        request.bounds.width,
        request.bounds.height,
    ]
    .into_iter()
    .all(|value| value.is_finite() && (0.0..=100_000.0).contains(&value))
        && request.occlusions.len() <= 64
        && request.occlusions.iter().all(|rect| {
            [rect.x, rect.y, rect.width, rect.height]
                .into_iter()
                .all(|value| value.is_finite() && (0.0..=100_000.0).contains(&value))
        })
        && request
            .scrollbar_theme
            .as_ref()
            .is_none_or(|theme| theme.is_valid())
}

fn plugin_setting_default_value(field: &serde_json::Value) -> serde_json::Value {
    if let Some(value) = field.get("defaultValue") {
        return value.clone();
    }
    match field.get("type").and_then(serde_json::Value::as_str) {
        Some("number") => field
            .get("min")
            .filter(|value| value.is_number())
            .cloned()
            .unwrap_or_else(|| serde_json::Value::from(0)),
        Some("boolean") => serde_json::Value::from(false),
        Some("select") => field
            .get("options")
            .and_then(serde_json::Value::as_array)
            .and_then(|options| options.first())
            .and_then(|option| option.get("value"))
            .cloned()
            .unwrap_or_else(|| serde_json::Value::from("")),
        _ => serde_json::Value::from(""),
    }
}

/// Normalize historical values through the same validator used for host writes.
fn plugin_setting_value_is_valid(field: &serde_json::Value, value: &serde_json::Value) -> bool {
    plugin_settings::validate_value(field, value).is_ok()
}

/// Keep settings in the named plugin's private data directory.
fn plugin_settings_path(app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    if plugin_id.is_empty()
        || plugin_id.contains("..")
        || !plugin_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("PLUGIN_SETTINGS_PATH_INVALID".to_string());
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("plugins")
        .join("data")
        .join(plugin_id)
        .join("settings.json"))
}

fn plugin_storage_path(app: &AppHandle, plugin_id: &str) -> Result<PathBuf, String> {
    if plugin_id.is_empty()
        || plugin_id.contains("..")
        || !plugin_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("PLUGIN_STORAGE_PATH_INVALID".to_string());
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "PLUGIN_STORAGE_PATH_INVALID".to_string())?
        .join("plugins")
        .join("data")
        .join(plugin_id)
        .join("storage.json"))
}

fn plugin_storage_key_is_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_PLUGIN_STORAGE_KEY_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

/// Apply the same permission, key and JSON quota checks to all storage commands.
fn validate_plugin_storage_request(
    manifest: &serde_json::Value,
    key: &str,
    value: Option<&serde_json::Value>,
) -> Result<(), String> {
    if !plugin_permission_is_declared(manifest, "storage.plugin") {
        return Err("PLUGIN_PERMISSION_NOT_DECLARED".to_string());
    }
    if !plugin_storage_key_is_valid(key) {
        return Err("PLUGIN_INVALID_ARGUMENT".to_string());
    }
    if let Some(value) = value {
        let bytes = serde_json::to_vec(value).map_err(|_| "PLUGIN_INVALID_ARGUMENT".to_string())?;
        if bytes.len() > MAX_PLUGIN_STORAGE_VALUE_SIZE {
            return Err("PLUGIN_INVALID_ARGUMENT".to_string());
        }
    }
    Ok(())
}

/// Reject redirected plugin data directories and storage files before disk access.
fn validate_plugin_storage_path(path: &Path) -> Result<(), String> {
    for (index, candidate) in path.ancestors().take(4).enumerate() {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink()
                    || (index == 0 && !metadata.is_file())
                    || (index > 0 && !metadata.is_dir())
                {
                    return Err("PLUGIN_STORAGE_INVALID".to_string());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("PLUGIN_STORAGE_INVALID".to_string()),
        }
    }
    Ok(())
}

/// Retain the exact disk baseline used for a storage merge and optimistic publication.
struct PluginStorageSnapshot {
    values: serde_json::Map<String, serde_json::Value>,
    original: Option<(Vec<u8>, String)>,
}

/// Read a bounded JSON object; only an absent file represents empty storage.
fn read_plugin_storage(path: &Path) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    Ok(read_plugin_storage_snapshot(path)?.values)
}

/// Read complete bytes with an object identity, denying concurrent Windows writes during the read.
fn read_plugin_storage_snapshot(path: &Path) -> Result<PluginStorageSnapshot, String> {
    validate_plugin_storage_path(path)?;
    let file = match fs::symlink_metadata(path) {
        Ok(_) => file_commit::open_read_snapshot(path)
            .map_err(|_| "PLUGIN_STORAGE_INVALID".to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PluginStorageSnapshot {
                values: serde_json::Map::new(),
                original: None,
            });
        }
        Err(_) => return Err("PLUGIN_STORAGE_INVALID".to_string()),
    };
    let identity = plugin_path_identity(path).map_err(|_| "PLUGIN_STORAGE_INVALID".to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_PLUGIN_STORAGE_FILE_SIZE as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "PLUGIN_STORAGE_INVALID".to_string())?;
    if bytes.len() > MAX_PLUGIN_STORAGE_FILE_SIZE {
        return Err("PLUGIN_STORAGE_INVALID".to_string());
    }
    let values = serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|_| "PLUGIN_STORAGE_INVALID".to_string())?
        .as_object()
        .cloned()
        .ok_or_else(|| "PLUGIN_STORAGE_INVALID".to_string())?;
    Ok(PluginStorageSnapshot {
        values,
        original: Some((bytes, identity)),
    })
}

/// Keep shared filesystem errors behind the existing storage-specific SDK boundary.
fn plugin_storage_commit_error(error: String) -> String {
    match error.as_str() {
        "PLUGIN_FILESYSTEM_BUSY" => "PLUGIN_STORAGE_BUSY".into(),
        "PLUGIN_FILESYSTEM_ALREADY_EXISTS" => "PLUGIN_WRITE_CONFLICT".into(),
        "PLUGIN_FILESYSTEM_PATH_INVALID"
        | "PLUGIN_FILESYSTEM_SYMLINK_NOT_ALLOWED"
        | "PLUGIN_FILESYSTEM_PARENT_NOT_DIRECTORY"
        | "PLUGIN_FILESYSTEM_NOT_FILE"
        | "PLUGIN_FILESYSTEM_READ_FAILED"
        | "PLUGIN_FILESYSTEM_NOT_FOUND" => "PLUGIN_STORAGE_INVALID".into(),
        "PLUGIN_FILESYSTEM_WRITE_FAILED" => "PLUGIN_STORAGE_WRITE_FAILED".into(),
        _ => error,
    }
}

/// Serialize the whole read/merge/commit transaction across participating Rust host processes.
fn mutate_plugin_storage_checked(
    path: &Path,
    checkpoint: &dyn Fn() -> Result<(), String>,
    mutate: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> Result<bool, String>,
) -> Result<(), String> {
    checkpoint()?;
    validate_plugin_storage_path(path)?;
    let directory = path.parent().ok_or("PLUGIN_STORAGE_PATH_INVALID")?;
    fs::create_dir_all(directory).map_err(|_| "PLUGIN_STORAGE_WRITE_FAILED")?;
    validate_plugin_storage_path(path)?;
    let base = directory
        .ancestors()
        .take(3)
        .last()
        .ok_or("PLUGIN_STORAGE_PATH_INVALID")?;
    let _pins =
        file_commit::pin_directories(base, directory).map_err(plugin_storage_commit_error)?;
    let _lock =
        workspace_lock::acquire(directory, checkpoint).map_err(plugin_storage_commit_error)?;
    validate_plugin_storage_path(path)?;
    let root = directory
        .canonicalize()
        .map_err(|_| "PLUGIN_STORAGE_PATH_INVALID")?;
    let target = root.join(path.file_name().ok_or("PLUGIN_STORAGE_PATH_INVALID")?);
    let mut snapshot = read_plugin_storage_snapshot(&target)?;
    if !mutate(&mut snapshot.values)? {
        return checkpoint();
    }
    let content = serde_json::to_vec_pretty(&serde_json::Value::Object(snapshot.values))
        .map_err(|_| "PLUGIN_STORAGE_INVALID".to_string())?;
    if content.len() > MAX_PLUGIN_STORAGE_FILE_SIZE {
        return Err("PLUGIN_STORAGE_QUOTA_EXCEEDED".to_string());
    }
    let check = || {
        checkpoint()?;
        validate_plugin_storage_path(path)
    };
    match snapshot.original {
        Some((bytes, identity)) => {
            file_commit::replace_existing(&root, &target, &content, &bytes, &identity, &check)
        }
        None => file_commit::create_new(&root, &target, &content, &check),
    }
    .map_err(plugin_storage_commit_error)
}

/// Commit one storage snapshot atomically without replacing it on quota failure.
#[cfg(test)]
fn write_plugin_storage(
    path: &Path,
    values: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    mutate_plugin_storage_checked(path, &|| Ok(()), |current| {
        *current = values.clone();
        Ok(true)
    })
}

/// Return an explicit presence flag so JSON null survives the IPC boundary.
fn get_plugin_storage_value(path: &Path, key: &str) -> Result<PluginStorageReadResult, String> {
    let values = read_plugin_storage(path)?;
    Ok(PluginStorageReadResult {
        found: values.contains_key(key),
        value: values.get(key).cloned(),
    })
}

/// Preserve other keys when setting or deleting one plugin-private value.
fn update_plugin_storage_value(
    path: &Path,
    key: String,
    value: Option<serde_json::Value>,
) -> Result<(), String> {
    update_plugin_storage_value_checked(path, key, value, &|| Ok(()))
}

/// Merge one key while preserving other values, then recheck the owner immediately before commit.
fn update_plugin_storage_value_checked(
    path: &Path,
    key: String,
    value: Option<serde_json::Value>,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    mutate_plugin_storage_checked(path, checkpoint, |values| {
        match value {
            Some(value) => {
                values.insert(key, value);
            }
            None => {
                values.remove(&key);
            }
        }
        Ok(true)
    })
}

/// Project only this page's current fields while keeping other persisted pages intact.
fn normalize_plugin_settings(
    setting: &serde_json::Value,
    raw: &serde_json::Map<String, serde_json::Value>,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    plugin_settings::project_values(setting, raw)?
        .as_object()
        .cloned()
        .ok_or_else(|| "PLUGIN_SETTINGS_INVALID".to_string())
}

#[tauri::command]
fn plugin_get_settings(
    request: PluginSettingRequest,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let (_plugin_path, manifest) = app
        .state::<PluginRegistryState>()
        .metadata(&request.plugin_id)?;
    let settings_path = plugin_settings_path(&app, &request.plugin_id)?;
    app.state::<PluginSettingsState>().get_page(
        &request.plugin_id,
        &manifest,
        &request.setting_id,
        &settings_path,
    )
}

#[tauri::command]
fn plugin_set_setting(
    request: PluginSetSettingRequest,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let (_plugin_path, manifest) = app
        .state::<PluginRegistryState>()
        .metadata(&request.plugin_id)?;
    let settings_path = plugin_settings_path(&app, &request.plugin_id)?;
    let values = app.state::<PluginSettingsState>().set_field(
        &request.plugin_id,
        &manifest,
        &request.setting_id,
        &request.field_id,
        &request.value,
        &settings_path,
    )?;
    app.emit(
        "plugin:settingChanged",
        serde_json::json!({
            "pluginId": request.plugin_id,
            "settingId": request.setting_id,
            "fieldId": request.field_id,
            "value": request.value
        }),
    )
    .map_err(|error| error.to_string())?;
    Ok(values)
}

#[tauri::command]
fn plugin_execute_command(request: PluginCommandRequest, app: AppHandle) -> Result<(), String> {
    let (_plugin_path, manifest) = find_active_plugin_manifest(&app, &request.plugin_id)?;
    validate_plugin_command(&manifest, &request.command_id)?;
    // The renderer runtime owns the JavaScript handler. Rust is the authority
    // for manifest validation; a successful return lets the renderer invoke
    // the already-activated handler in the current WebView.
    Ok(())
}

#[tauri::command]
fn plugin_show_notification(
    request: PluginNotificationRequest,
    app: AppHandle,
) -> Result<(), String> {
    let (_plugin_path, manifest) = find_active_plugin_manifest(&app, &request.plugin_id)?;
    if !plugin_permission_is_declared(&manifest, "notifications.show") {
        return Err("PLUGIN_PERMISSION_NOT_DECLARED".to_string());
    }

    let message = request.message.trim();
    if message.is_empty() {
        return Err("PLUGIN_INVALID_ARGUMENT".to_string());
    }
    let message = message
        .chars()
        .take(MAX_PLUGIN_NOTIFICATION_MESSAGE_LENGTH)
        .collect();
    let title = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .chars()
                .take(MAX_PLUGIN_NOTIFICATION_TITLE_LENGTH)
                .collect()
        });
    let duration = request
        .duration
        .filter(|value| value.is_finite())
        .map(|value| value.trunc() as u64)
        .map(|value| {
            value.clamp(
                MIN_PLUGIN_NOTIFICATION_DURATION_MS,
                MAX_PLUGIN_NOTIFICATION_DURATION_MS,
            )
        })
        .unwrap_or(DEFAULT_PLUGIN_NOTIFICATION_DURATION_MS);
    let notification_type = match request.notification_type.as_deref() {
        Some("warning") => "warning",
        Some("error") => "error",
        _ => "normal",
    };
    let plugin_name = manifest
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&request.plugin_id)
        .to_string();

    app.emit(
        "plugin:notificationRequested",
        PluginNotificationEvent {
            plugin_id: request.plugin_id,
            plugin_name,
            message,
            notification_type: notification_type.to_string(),
            title,
            duration,
        },
    )
    .map_err(|error| error.to_string())
}

/// Show a native operating-system notification after manifest permission checks.
#[tauri::command]
fn plugin_show_system_notification(
    request: PluginNotificationRequest,
    app: AppHandle,
) -> Result<(), String> {
    let (_plugin_path, manifest) = find_active_plugin_manifest(&app, &request.plugin_id)?;
    if !plugin_permission_is_declared(&manifest, "notifications.system") {
        return Err("PLUGIN_PERMISSION_NOT_DECLARED".to_string());
    }
    let message = request.message.trim();
    if message.is_empty() {
        return Err("PLUGIN_INVALID_ARGUMENT".to_string());
    }
    let message = message
        .chars()
        .take(MAX_PLUGIN_NOTIFICATION_MESSAGE_LENGTH)
        .collect::<String>();
    let title = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .chars()
                .take(MAX_PLUGIN_NOTIFICATION_TITLE_LENGTH)
                .collect::<String>()
        })
        .unwrap_or_else(|| {
            manifest
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(&request.plugin_id)
                .to_string()
        });
    app.notification()
        .builder()
        .title(title)
        .body(message)
        .show()
        .map_err(|error| format!("PLUGIN_SYSTEM_NOTIFICATION_FAILED:{error}"))
}

/// Queue a validated plugin dialog request and wait for the first window response.
pub(crate) async fn plugin_dialog_request_impl(
    request: PluginDialogRequest,
    app: AppHandle,
    state: &PluginDialogState,
) -> Result<serde_json::Value, String> {
    let (_plugin_path, manifest) = find_active_plugin_manifest(&app, &request.plugin_id)?;
    if !matches!(
        request.method.as_str(),
        "dialogs.pick" | "dialogs.repositoryManager" | "dialogs.prompt" | "dialogs.confirm"
    ) {
        return Err("PLUGIN_METHOD_NOT_FOUND".to_string());
    }
    if !plugin_permission_is_declared(&manifest, "dialogs.show") {
        return Err("PLUGIN_PERMISSION_NOT_DECLARED".to_string());
    }
    let params = request
        .params
        .as_object()
        .ok_or_else(|| "PLUGIN_INVALID_ARGUMENT".to_string())?;
    let title = params
        .get("title")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "PLUGIN_INVALID_ARGUMENT".to_string())?;
    if title.chars().count() > 200 {
        return Err("PLUGIN_INVALID_ARGUMENT".to_string());
    }
    if request.method == "dialogs.confirm"
        && params
            .get("message")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return Err("PLUGIN_INVALID_ARGUMENT".to_string());
    }
    if request.method == "dialogs.pick"
        && !params
            .get("items")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|items| !items.is_empty() && items.len() <= 1_000)
    {
        return Err("PLUGIN_INVALID_ARGUMENT".to_string());
    }

    let request_id = Uuid::new_v4().to_string();
    let plugin_name = manifest
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&request.plugin_id);
    let kind = match request.method.as_str() {
        "dialogs.pick" => "pick",
        "dialogs.repositoryManager" => "repository-manager",
        "dialogs.prompt" => "prompt",
        _ => "confirm",
    };
    let event = serde_json::json!({
        "requestId": request_id.clone(),
        "pluginId": request.plugin_id,
        "pluginName": plugin_name,
        "kind": kind,
        "options": request.params
    });
    let (sender, receiver) = oneshot::channel();
    state
        .pending
        .lock()
        .map_err(|_| "PLUGIN_DIALOG_STATE_LOCK_FAILED".to_string())?
        .insert(
            event["requestId"].as_str().unwrap_or_default().to_string(),
            sender,
        );
    if dialog_event_requires_dedicated_window(&event) {
        let label = match open_workbench_blank_window(
            &app,
            "repository-manager",
            "仓库管理",
            720.0,
            560.0,
            None,
        ) {
            Ok(label) => label,
            Err(error) => {
                let _ = state
                    .pending
                    .lock()
                    .ok()
                    .and_then(|mut pending| pending.remove(&request_id));
                return Err(error);
            }
        };
        if let Err(error) = pending_repository_manager_requests()
            .lock()
            .map_err(|_| "REPOSITORY_MANAGER_REQUEST_STATE_POISONED".to_string())
            .map(|mut pending| {
                pending.insert(label.clone(), event.clone());
            })
        {
            let _ = state
                .pending
                .lock()
                .ok()
                .and_then(|mut pending| pending.remove(&request_id));
            if let Some(window) = app.get_window(&label) {
                let _ = window.close();
            }
            return Err(error);
        }
    } else if let Err(error) = app.emit("plugin:dialogRequested", &event) {
        let _ = state
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&request_id));
        return Err(error.to_string());
    }
    let response = match tokio::time::timeout(Duration::from_secs(5 * 60), receiver).await {
        Ok(result) => result.map_err(|_| "PLUGIN_DIALOG_CANCELLED".to_string())?,
        Err(_) => {
            if let Ok(mut pending) = state.pending.lock() {
                pending.remove(&request_id);
            }
            if dialog_event_requires_dedicated_window(&event) {
                if let Ok(mut pending) = pending_repository_manager_requests().lock() {
                    pending.retain(|_, value| value["requestId"] != request_id);
                }
            }
            return Err("PLUGIN_DIALOG_TIMEOUT".to_string());
        }
    };
    if response.request_id != request_id {
        return Err("PLUGIN_DIALOG_RESPONSE_INVALID".to_string());
    }
    if response.status == "cancelled" {
        return Ok(if request.method == "dialogs.confirm" {
            serde_json::Value::Bool(false)
        } else {
            serde_json::Value::Null
        });
    }
    if response.status != "confirmed" {
        return Err("PLUGIN_DIALOG_RESPONSE_INVALID".to_string());
    }
    let value = response
        .value
        .ok_or_else(|| "PLUGIN_DIALOG_RESPONSE_INVALID".to_string())?;
    if request.method == "dialogs.confirm" {
        return Ok(serde_json::Value::Bool(value.as_bool() == Some(true)));
    }
    let Some(selected) = value.as_str() else {
        return Err("PLUGIN_DIALOG_RESPONSE_INVALID".to_string());
    };
    if request.method == "dialogs.pick" {
        let valid = params
            .get("items")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("id").and_then(serde_json::Value::as_str) == Some(selected)
                        && item.get("disabled").and_then(serde_json::Value::as_bool) != Some(true)
                })
            });
        if !valid {
            return Err("PLUGIN_DIALOG_RESPONSE_INVALID".to_string());
        }
    }
    if request.method == "dialogs.repositoryManager" {
        let valid_item = params
            .get("items")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .any(|item| item.get("id").and_then(serde_json::Value::as_str) == Some(selected));
        let valid_action = params
            .get("actions")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .any(|item| item.get("id").and_then(serde_json::Value::as_str) == Some(selected));
        let valid_repository_action =
            selected
                .strip_prefix("repository-action:")
                .is_some_and(|raw| {
                    let parts: Vec<&str> = raw.split(':').collect();
                    parts.len() >= 2 && ["rename", "move", "reveal", "remove"].contains(&parts[1])
                });
        if !valid_item && !valid_action && !valid_repository_action {
            return Err("PLUGIN_DIALOG_RESPONSE_INVALID".to_string());
        }
    }
    Ok(value)
}

/// Send each dialog to exactly one host; repository requests must never block the inline queue.
fn dialog_event_requires_dedicated_window(event: &serde_json::Value) -> bool {
    event["kind"] == "repository-manager"
}

/// Tauri command wrapper for the shared dialog implementation.
#[tauri::command]
async fn plugin_dialog_request(
    request: PluginDialogRequest,
    app: AppHandle,
    state: State<'_, PluginDialogState>,
) -> Result<serde_json::Value, String> {
    plugin_dialog_request_impl(request, app, state.inner()).await
}

/// Deliver the first trusted window response to the waiting plugin request.
#[tauri::command]
fn plugin_dialog_respond(
    response: PluginDialogResponseRequest,
    state: State<'_, PluginDialogState>,
) -> Result<bool, String> {
    let sender = state
        .pending
        .lock()
        .map_err(|_| "PLUGIN_DIALOG_STATE_LOCK_FAILED".to_string())?
        .remove(&response.request_id);
    let Some(sender) = sender else {
        return Ok(false);
    };
    sender
        .send(response)
        .map_err(|_| "PLUGIN_DIALOG_CANCELLED".to_string())?;
    Ok(true)
}

#[tauri::command]
fn plugin_storage_get(
    request: PluginStorageKeyRequest,
    app: AppHandle,
    state: State<'_, PluginStorageState>,
) -> Result<PluginStorageReadResult, String> {
    let (_plugin_path, manifest) = find_active_plugin_manifest(&app, &request.plugin_id)?;
    validate_plugin_storage_request(&manifest, &request.key, None)?;
    let _operation = state
        .operation
        .lock()
        .map_err(|_| "PLUGIN_STORAGE_LOCK_FAILED".to_string())?;
    get_plugin_storage_value(
        &plugin_storage_path(&app, &request.plugin_id)?,
        &request.key,
    )
}

#[tauri::command]
fn plugin_storage_set(
    request: PluginStorageSetRequest,
    app: AppHandle,
    state: State<'_, PluginStorageState>,
) -> Result<(), String> {
    let (_plugin_path, manifest) = find_active_plugin_manifest(&app, &request.plugin_id)?;
    validate_plugin_storage_request(&manifest, &request.key, Some(&request.value))?;
    let _operation = state
        .operation
        .lock()
        .map_err(|_| "PLUGIN_STORAGE_LOCK_FAILED".to_string())?;
    let path = plugin_storage_path(&app, &request.plugin_id)?;
    update_plugin_storage_value(&path, request.key, Some(request.value))
}

#[tauri::command]
fn plugin_storage_delete(
    request: PluginStorageKeyRequest,
    app: AppHandle,
    state: State<'_, PluginStorageState>,
) -> Result<(), String> {
    let (_plugin_path, manifest) = find_active_plugin_manifest(&app, &request.plugin_id)?;
    validate_plugin_storage_request(&manifest, &request.key, None)?;
    let _operation = state
        .operation
        .lock()
        .map_err(|_| "PLUGIN_STORAGE_LOCK_FAILED".to_string())?;
    let path = plugin_storage_path(&app, &request.plugin_id)?;
    update_plugin_storage_value(&path, request.key, None)
}

#[tauri::command]
fn plugin_editor_reveal_range(
    request: PluginEditorRevealRangeRequest,
    app: AppHandle,
    editor_state: State<'_, EditorState>,
    workspace_state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let (_plugin_path, manifest) = find_active_plugin_manifest(&app, &request.plugin_id)?;
    if !plugin_permission_is_declared(&manifest, "editor.read")
        || !plugin_permission_is_declared(&manifest, "editor.write")
    {
        return Err("PLUGIN_PERMISSION_NOT_DECLARED".to_string());
    }
    if request.path.trim().is_empty()
        || request.range.start > request.range.end
        || !plugin_editor_vertical_alignment_is_valid(
            request
                .options
                .as_ref()
                .and_then(|options| options.vertical_alignment.as_deref()),
        )
    {
        return Err("PLUGIN_INVALID_ARGUMENT".to_string());
    }

    let root = workspace_root(&workspace_state)?;
    let target = normalize_relative_path(&root, &request.path).map_err(|reason| match reason {
        "not-found" => "PLUGIN_FILESYSTEM_NOT_FOUND".to_string(),
        _ => "PLUGIN_FILESYSTEM_PATH_INVALID".to_string(),
    })?;
    if !target.is_file() {
        return Err("PLUGIN_FILESYSTEM_NOT_FILE".to_string());
    }
    let relative = relative_path(&root, &target);
    if !plugin_path_has_permission(&manifest, "editor.read", &relative)
        || !plugin_path_has_permission(&manifest, "editor.write", &relative)
    {
        return Err("PLUGIN_PERMISSION_SCOPE_VIOLATION".to_string());
    }

    let active = editor_state
        .active_document
        .lock()
        .map_err(|_| "EDITOR_STATE_POISONED".to_string())?
        .clone()
        .ok_or_else(|| "PLUGIN_EDITOR_DOCUMENT_NOT_ACTIVE".to_string())?;
    let active_path = if Path::new(&active.path).is_absolute() {
        normalize_relative_path(&root, &active.path)
            .map(|path| relative_path(&root, &path))
            .unwrap_or_else(|_| active.path.replace('\\', "/"))
    } else {
        active.path.replace('\\', "/")
    };
    if active_path != relative {
        return Err("PLUGIN_EDITOR_DOCUMENT_NOT_ACTIVE".to_string());
    }
    if request.range.end > active.content.encode_utf16().count() {
        return Err("PLUGIN_EDITOR_RANGE_INVALID".to_string());
    }

    let title = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("文件")
        .to_string();
    let repository = repository_summary(&root);
    app.emit(
        "workspace:openFileRequested",
        WorkspaceOpenTextRequest {
            repository_id: repository.id,
            file_path: target.to_string_lossy().into_owned(),
            relative_path: relative,
            title,
            kind: "text",
            content: active.content,
            position: Some(request.range.start),
            selection_end: Some(request.range.end),
            vertical_alignment: request
                .options
                .and_then(|options| options.vertical_alignment),
            disposition: "current-group",
        },
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn plugin_editor_open_file(
    request: PluginEditorOpenFileRequest,
    app: AppHandle,
    workspace_state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let (_plugin_path, manifest) = find_active_plugin_manifest(&app, &request.plugin_id)?;
    if !plugin_permission_is_declared(&manifest, "workspace.read")
        || !plugin_permission_is_declared(&manifest, "editor.write")
    {
        return Err("PLUGIN_PERMISSION_NOT_DECLARED".to_string());
    }

    let root = workspace_root(&workspace_state)?;
    let target = normalize_relative_path(&root, &request.path).map_err(|reason| match reason {
        "not-found" => "PLUGIN_FILESYSTEM_NOT_FOUND".to_string(),
        _ => "PLUGIN_FILESYSTEM_PATH_INVALID".to_string(),
    })?;
    if !target.is_file() {
        return Err("PLUGIN_FILESYSTEM_NOT_FILE".to_string());
    }
    let relative = relative_path(&root, &target);
    if !plugin_path_has_permission(&manifest, "workspace.read", &relative)
        || !plugin_path_has_permission(&manifest, "editor.write", &relative)
    {
        return Err("PLUGIN_PERMISSION_SCOPE_VIOLATION".to_string());
    }

    let disposition = request
        .options
        .as_ref()
        .and_then(|options| options.disposition.as_deref());
    let payload = build_workspace_open_file_request(&root, &relative, disposition)?
        .ok_or_else(|| "PLUGIN_FILESYSTEM_UNSUPPORTED_EXTENSION".to_string())?;
    app.emit("workspace:openFileRequested", payload)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn plugin_editor_close_tabs(
    request: PluginEditorCloseTabsRequest,
    app: AppHandle,
) -> Result<(), String> {
    let (_plugin_path, manifest) = find_active_plugin_manifest(&app, &request.plugin_id)?;
    if !plugin_permission_is_declared(&manifest, "editor.write") {
        return Err("PLUGIN_PERMISSION_NOT_DECLARED".to_string());
    }
    if let Some(paths) = request.paths.as_ref() {
        if paths.is_empty() {
            return Err("PLUGIN_INVALID_ARGUMENT".to_string());
        }
        for path in paths {
            let normalized = path.replace('\\', "/");
            plugin_relative_components(&normalized)
                .map_err(|_| "PLUGIN_FILESYSTEM_PATH_INVALID".to_string())?;
            if !plugin_path_has_permission(&manifest, "editor.write", &normalized) {
                return Err("PLUGIN_PERMISSION_SCOPE_VIOLATION".to_string());
            }
        }
    }
    app.emit(
        "workspace:closeTabsRequested",
        serde_json::json!({ "paths": request.paths }),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn plugin_dispose_view(
    request: PluginViewRequest,
    app: AppHandle,
    window: Window,
) -> Result<(), String> {
    if !plugin_view_request_is_valid(&request) {
        return Err("PLUGIN_VIEW_REQUEST_INVALID".to_string());
    }
    app.state::<web_viewer::WebViewerState>()
        .dispose(&app, |scope| {
            scope.window == window.label()
                && scope.plugin == request.plugin_id
                && scope.view_type == request.view_type
                && scope.instance == request.instance_id
                && scope.runtime == request.runtime_id
        });
    Ok(())
}

#[tauri::command]
async fn plugin_update_view_bounds(
    request: PluginViewBoundsRequest,
    app: AppHandle,
    window: Window,
) -> Result<(), String> {
    if !plugin_view_bounds_request_is_valid(&request) {
        return Err("PLUGIN_VIEW_BOUNDS_INVALID".to_string());
    }
    let scope = web_viewer::Scope {
        window: window.label().into(),
        plugin: request.plugin_id,
        runtime: request.runtime_id,
        view_type: request.view_type,
        instance: request.instance_id,
    };
    let bounds = web_viewer::Bounds {
        x: request.bounds.x,
        y: request.bounds.y,
        width: request.bounds.width,
        height: request.bounds.height,
    };
    let occlusions = request
        .occlusions
        .into_iter()
        .map(|rect| web_viewer::Bounds {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        })
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<web_viewer::WebViewerState>().update_bounds(
            &app,
            scope,
            bounds,
            occlusions,
            request.scrollbar_theme,
        )
    })
    .await
    .map_err(|_| "PLUGIN_API_FAILED".to_string())?
}

/// Route trusted workbench menus through the same scoped native service as plugin SDK calls.
#[tauri::command]
async fn plugin_web_viewer_context_menu(
    request: web_viewer::MenuRequest,
    app: AppHandle,
    window: Window,
) -> Result<bool, String> {
    let window_label = window.label().to_string();
    let timeout = request.timeout_ms();
    let deadline = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|_| "PLUGIN_API_FAILED")?
        .as_millis() as u64
        + timeout;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<web_viewer::WebViewerState>().context_menu(
            &app,
            &window_label,
            request,
            deadline,
        )
    })
    .await
    .map_err(|_| "PLUGIN_API_FAILED".to_string())?
}

#[tauri::command]
fn plugin_open_with_default_app(
    request: PluginWorkspacePathRequest,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let (_plugin_path, manifest) = find_active_plugin_manifest(&app, &request.plugin_id)?;
    if !plugin_permission_is_declared(&manifest, "external.open") {
        return Err("PLUGIN_PERMISSION_NOT_DECLARED".to_string());
    }
    let root = workspace_root(&state)?;
    let target = resolve_plugin_external_workspace_path(&manifest, &root, &request.path)?;
    if open::that(target).is_err() {
        return Err("SYSTEM_OPEN_FAILED".to_string());
    }
    Ok(())
}

#[tauri::command]
fn plugin_reveal_in_file_manager(
    request: PluginWorkspacePathRequest,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let (_plugin_path, manifest) = find_active_plugin_manifest(&app, &request.plugin_id)?;
    if !plugin_permission_is_declared(&manifest, "external.open") {
        return Err("PLUGIN_PERMISSION_NOT_DECLARED".to_string());
    }
    let root = workspace_root(&state)?;
    let target = resolve_plugin_external_workspace_path(&manifest, &root, &request.path)?;
    if !reveal_path_in_file_manager(&target, &root)? {
        return Err("SYSTEM_REVEAL_FAILED".to_string());
    }
    Ok(())
}

fn resolve_plugin_external_workspace_path(
    manifest: &serde_json::Value,
    root: &Path,
    requested_path: &str,
) -> Result<PathBuf, String> {
    if !plugin_permission_is_declared(manifest, "workspace.read") {
        return Err("PLUGIN_PERMISSION_NOT_DECLARED".to_string());
    }
    let normalized = requested_path.replace('\\', "/");
    let target = if normalized == "." {
        root.to_path_buf()
    } else {
        resolve_plugin_existing_path(root, &normalized)?
    };
    let relative = relative_path(root, &target);
    if !plugin_path_has_permission(manifest, "workspace.read", &relative) {
        return Err("PLUGIN_PERMISSION_SCOPE_VIOLATION".to_string());
    }
    Ok(target)
}

fn reveal_path_in_file_manager(target: &Path, _root: &Path) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let status = Command::new("explorer.exe")
            .args(["/select,", &target.to_string_lossy()])
            .status()
            .map_err(|_| "SYSTEM_REVEAL_FAILED".to_string())?;
        Ok(status.success())
    }
    #[cfg(not(target_os = "windows"))]
    {
        open::that(target.parent().unwrap_or(_root))
            .map(|_| true)
            .map_err(|_| "SYSTEM_REVEAL_FAILED".to_string())
    }
}

fn filesystem_timestamp(value: Option<SystemTime>) -> u64 {
    value
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn plugin_file_is_encrypted(path: &Path, is_file: bool) -> bool {
    if !is_file {
        return false;
    }
    let mut header = [0u8; 9];
    fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .is_ok()
        && &header[..PLUGIN_ENCRYPTION_MAGIC.len()] == PLUGIN_ENCRYPTION_MAGIC
        && header[PLUGIN_ENCRYPTION_MAGIC.len()] == PLUGIN_ENCRYPTION_VERSION
}

/// Direct native adapters and SDK RPC share the same scope-aware filesystem service.
fn invoke_plugin_filesystem(
    app: &AppHandle,
    state: &WorkspaceState,
    plugin_id: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let (package, manifest) = find_active_plugin_manifest(app, plugin_id)?;
    let root = state.root.lock().map_err(|_| "PLUGIN_API_FAILED")?;
    plugin_filesystem::invoke(&root, &manifest, method, &params, &|| {
        let (current_package, current_manifest) = find_active_plugin_manifest(app, plugin_id)?;
        if current_package != package || current_manifest != manifest {
            return Err("PLUGIN_RUNTIME_TERMINATED".into());
        }
        Ok(())
    })
}

#[tauri::command]
fn plugin_filesystem_list_entries(
    request: PluginFilesystemListEntriesRequest,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<serde_json::Value, String> {
    invoke_plugin_filesystem(
        &app,
        &state,
        &request.plugin_id,
        "filesystem.listEntries",
        serde_json::json!({ "directory": request.directory.unwrap_or_else(|| ".".into()) }),
    )
}

fn read_plugin_text_file(
    root: &Path,
    requested_path: &str,
) -> Result<PluginFilesystemTextFile, String> {
    let file_path = normalize_relative_path(root, requested_path).map_err(|error| match error {
        "not-found" => "PLUGIN_FILESYSTEM_NOT_FOUND".to_string(),
        other => other.to_string(),
    })?;
    let metadata =
        fs::metadata(&file_path).map_err(|_| "PLUGIN_FILESYSTEM_NOT_FOUND".to_string())?;
    if !metadata.is_file() {
        return Err("PLUGIN_FILESYSTEM_NOT_FILE".to_string());
    }
    if metadata.len() > MAX_PLUGIN_TEXT_FILE_SIZE {
        return Err("PLUGIN_FILESYSTEM_FILE_TOO_LARGE".to_string());
    }
    let bytes = fs::read(&file_path).map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED".to_string())?;
    if bytes.len() as u64 > MAX_PLUGIN_TEXT_FILE_SIZE {
        return Err("PLUGIN_FILESYSTEM_FILE_TOO_LARGE".to_string());
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| "PLUGIN_FILESYSTEM_ENCODING_UNSUPPORTED".to_string())?;
    let name = file_path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(PluginFilesystemTextFile {
        path: relative_path(root, &file_path),
        name,
        entry_type: "file",
        size: metadata.len(),
        modified_at: filesystem_timestamp(metadata.modified().ok()),
        created_at: filesystem_timestamp(metadata.created().ok()),
        encoding: "utf-8",
        content,
    })
}

fn stat_plugin_filesystem_entry(
    root: &Path,
    requested_path: &str,
) -> Result<PluginFilesystemEntry, String> {
    let entry_path =
        normalize_relative_path(root, requested_path).map_err(|error| match error {
            "not-found" => "PLUGIN_FILESYSTEM_NOT_FOUND".to_string(),
            other => other.to_string(),
        })?;
    let metadata =
        fs::metadata(&entry_path).map_err(|_| "PLUGIN_FILESYSTEM_NOT_FOUND".to_string())?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("PLUGIN_FILESYSTEM_TYPE_UNSUPPORTED".to_string());
    }
    let relative_entry_path = if requested_path == "." || entry_path == root {
        ".".to_string()
    } else {
        relative_path(root, &entry_path)
    };
    Ok(PluginFilesystemEntry {
        path: relative_entry_path,
        name: if requested_path == "." || entry_path == root {
            ".".to_string()
        } else {
            entry_path
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| ".".to_string())
        },
        entry_type: if metadata.is_dir() {
            "directory"
        } else {
            "file"
        },
        size: metadata.len(),
        modified_at: filesystem_timestamp(metadata.modified().ok()),
        created_at: filesystem_timestamp(metadata.created().ok()),
        encrypted: plugin_file_is_encrypted(&entry_path, metadata.is_file()),
    })
}

#[tauri::command]
fn plugin_filesystem_stat(
    request: PluginWorkspacePathRequest,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<serde_json::Value, String> {
    invoke_plugin_filesystem(
        &app,
        &state,
        &request.plugin_id,
        "filesystem.stat",
        serde_json::json!({ "path": request.path }),
    )
}

#[tauri::command]
fn plugin_filesystem_read_text(
    request: PluginWorkspacePathRequest,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<serde_json::Value, String> {
    invoke_plugin_filesystem(
        &app,
        &state,
        &request.plugin_id,
        "filesystem.readText",
        serde_json::json!({ "path": request.path }),
    )
}

#[cfg(test)]
fn write_plugin_text_file(
    root: &Path,
    requested_path: &str,
    content: &str,
    expected_content: &str,
) -> Result<PluginFilesystemTextFile, String> {
    write_plugin_text_file_checked(root, requested_path, content, expected_content, &|| Ok(()))
}

/// Commit text with the same revocable checkpoint and atomic replacement used by other writes.
fn write_plugin_text_file_checked(
    root: &Path,
    requested_path: &str,
    content: &str,
    expected_content: &str,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<PluginFilesystemTextFile, String> {
    if content.len() as u64 > MAX_PLUGIN_TEXT_FILE_SIZE {
        return Err("PLUGIN_FILESYSTEM_FILE_TOO_LARGE".to_string());
    }
    let file_path = resolve_plugin_existing_path(root, requested_path)?;
    let identity = plugin_path_identity(&file_path)?;
    let current_file = read_plugin_text_file(root, requested_path)?;
    if current_file.content != expected_content {
        return Err("PLUGIN_WRITE_CONFLICT".to_string());
    }
    if content != current_file.content {
        file_commit::replace_existing(
            root,
            &file_path,
            content.as_bytes(),
            expected_content.as_bytes(),
            &identity,
            checkpoint,
        )?;
    }
    read_plugin_text_file(root, requested_path)
}

#[cfg(test)]
fn create_plugin_text_file(
    root: &Path,
    requested_path: &str,
    content: &str,
) -> Result<PluginFilesystemTextFile, String> {
    create_plugin_text_file_checked(root, requested_path, content, &|| Ok(()))
}

/// Stage complete new text and retain any destination published by a competing writer.
fn create_plugin_text_file_checked(
    root: &Path,
    requested_path: &str,
    content: &str,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<PluginFilesystemTextFile, String> {
    if content.len() as u64 > MAX_PLUGIN_TEXT_FILE_SIZE {
        return Err("PLUGIN_FILESYSTEM_FILE_TOO_LARGE".to_string());
    }
    let target = resolve_plugin_new_path(root, requested_path)?;
    file_commit::create_new(root, &target, content.as_bytes(), checkpoint)?;
    read_plugin_text_file(root, requested_path)
}

#[tauri::command]
fn plugin_filesystem_create_file(
    request: PluginFilesystemCreateFileRequest,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<serde_json::Value, String> {
    invoke_plugin_filesystem(
        &app,
        &state,
        &request.plugin_id,
        "filesystem.createFile",
        serde_json::json!({ "path": request.path, "content": request.content }),
    )
}

#[cfg(test)]
fn create_plugin_directory(
    root: &Path,
    requested_path: &str,
    recursive: bool,
) -> Result<PluginFilesystemEntry, String> {
    create_plugin_directory_checked(root, requested_path, recursive, &|| Ok(()))
}

/// Pin each existing/created ancestor and observe cancellation before creating the next directory.
fn create_plugin_directory_checked(
    root: &Path,
    requested_path: &str,
    recursive: bool,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<PluginFilesystemEntry, String> {
    let candidate = Path::new(requested_path);
    if requested_path.trim().is_empty()
        || candidate.is_absolute()
        || candidate
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("PLUGIN_FILESYSTEM_PATH_INVALID".to_string());
    }
    let components: Vec<_> = candidate
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => Some(part),
            _ => None,
        })
        .collect();
    let mut current_path = root.to_path_buf();
    let mut pins = file_commit::pin_directories(root, root)?;
    for (index, component) in components.iter().enumerate() {
        checkpoint()?;
        current_path.push(component);
        let is_target = index + 1 == components.len();
        match fs::symlink_metadata(&current_path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err("PLUGIN_FILESYSTEM_SYMLINK_NOT_ALLOWED".to_string());
                }
                if !metadata.is_dir() {
                    return Err("PLUGIN_FILESYSTEM_PARENT_NOT_DIRECTORY".to_string());
                }
                if is_target {
                    return Err("PLUGIN_FILESYSTEM_ALREADY_EXISTS".to_string());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !recursive && !is_target {
                    return Err("PLUGIN_FILESYSTEM_PARENT_NOT_FOUND".to_string());
                }
                fs::create_dir(&current_path)
                    .map_err(|_| "PLUGIN_FILESYSTEM_CREATE_FAILED".to_string())?;
            }
            Err(_) => return Err("PLUGIN_FILESYSTEM_CREATE_FAILED".to_string()),
        }
        pins.extend(file_commit::pin_directories(root, &current_path)?);
    }
    stat_plugin_filesystem_entry(root, requested_path)
}

#[tauri::command]
fn plugin_filesystem_create_directory(
    request: PluginFilesystemCreateDirectoryRequest,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<serde_json::Value, String> {
    invoke_plugin_filesystem(
        &app,
        &state,
        &request.plugin_id,
        "filesystem.createDirectory",
        serde_json::json!({ "path": request.path, "options": { "recursive": request.options.and_then(|options| options.recursive).unwrap_or(false) } }),
    )
}

#[cfg(test)]
fn delete_plugin_path(root: &Path, requested_path: &str, recursive: bool) -> Result<(), String> {
    plugin_filesystem::invoke(
        root,
        &serde_json::json!({"id":"com.example.delete-test","permissions":[{"id":"workspace.write"}]}),
        "filesystem.delete",
        &serde_json::json!({"path": requested_path, "options":{"recursive":recursive}}),
        &|| Ok(()),
    )?;
    Ok(())
}

fn plugin_relative_components(value: &str) -> Result<Vec<PathBuf>, String> {
    let path = Path::new(value);
    if value.trim().is_empty() || path.is_absolute() {
        return Err("PLUGIN_FILESYSTEM_PATH_INVALID".to_string());
    }
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(part) => components.push(PathBuf::from(part)),
            _ => return Err("PLUGIN_FILESYSTEM_PATH_INVALID".to_string()),
        }
    }
    if components.is_empty() {
        return Err("PLUGIN_FILESYSTEM_PATH_INVALID".to_string());
    }
    Ok(components)
}

fn resolve_plugin_existing_path(root: &Path, value: &str) -> Result<PathBuf, String> {
    let components = plugin_relative_components(value)?;
    let mut current = root.to_path_buf();
    for component in components {
        current.push(component);
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "PLUGIN_FILESYSTEM_NOT_FOUND".to_string()
            } else {
                "PLUGIN_FILESYSTEM_READ_FAILED".to_string()
            }
        })?;
        if metadata.file_type().is_symlink() {
            return Err("PLUGIN_FILESYSTEM_SYMLINK_NOT_ALLOWED".to_string());
        }
    }
    normalize_relative_path(root, value).map_err(|_| "PLUGIN_FILESYSTEM_NOT_FOUND".to_string())
}

fn resolve_plugin_new_path(root: &Path, value: &str) -> Result<PathBuf, String> {
    let components = plugin_relative_components(value)?;
    let (file_name, parents) = components
        .split_last()
        .ok_or_else(|| "PLUGIN_FILESYSTEM_PATH_INVALID".to_string())?;
    let mut parent = root.to_path_buf();
    for component in parents {
        parent.push(component);
        let metadata = fs::symlink_metadata(&parent).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "PLUGIN_FILESYSTEM_PARENT_NOT_FOUND".to_string()
            } else {
                "PLUGIN_FILESYSTEM_READ_FAILED".to_string()
            }
        })?;
        if metadata.file_type().is_symlink() {
            return Err("PLUGIN_FILESYSTEM_SYMLINK_NOT_ALLOWED".to_string());
        }
        if !metadata.is_dir() {
            return Err("PLUGIN_FILESYSTEM_PARENT_NOT_DIRECTORY".to_string());
        }
    }
    let parent = parent
        .canonicalize()
        .map_err(|_| "PLUGIN_FILESYSTEM_PARENT_NOT_FOUND".to_string())?;
    if parent.strip_prefix(root).is_err() {
        return Err("PLUGIN_FILESYSTEM_PATH_INVALID".to_string());
    }
    let target = parent.join(file_name);
    match fs::symlink_metadata(&target) {
        Ok(_) => Err("PLUGIN_FILESYSTEM_ALREADY_EXISTS".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(target),
        Err(_) => Err("PLUGIN_FILESYSTEM_CREATE_FAILED".to_string()),
    }
}

/// Identify the filesystem object, independently of its contents and timestamps.
fn plugin_path_identity(path: &Path) -> Result<String, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::symlink_metadata(path).map_err(|_| "PLUGIN_FILESYSTEM_PATH_INVALID")?;
        if metadata.file_type().is_symlink() {
            return Err("PLUGIN_FILESYSTEM_SYMLINK_NOT_ALLOWED".into());
        }
        return Ok(format!("{}:{}", metadata.dev(), metadata.ino()));
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        // Win32 BY_HANDLE_FILE_INFORMATION contains only DWORDs and FILETIMEs.
        #[repr(C)]
        #[derive(Default)]
        struct FileInformation {
            attributes: u32,
            created: [u32; 2],
            accessed: [u32; 2],
            written: [u32; 2],
            volume: u32,
            size_high: u32,
            size_low: u32,
            links: u32,
            index_high: u32,
            index_low: u32,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetFileInformationByHandle(
                handle: *mut std::ffi::c_void,
                information: *mut FileInformation,
            ) -> i32;
        }
        let file = fs::OpenOptions::new()
            .access_mode(0)
            .share_mode(7)
            // BACKUP_SEMANTICS permits directories; OPEN_REPARSE_POINT avoids
            // following a replaced final link while querying its identity.
            .custom_flags(0x02200000)
            .open(path)
            .map_err(|_| "PLUGIN_FILESYSTEM_PATH_INVALID")?;
        let mut information = FileInformation::default();
        // SAFETY: the live File owns this HANDLE and the output has the Win32
        // layout above. The synchronous call writes only this output buffer.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
            return Err("PLUGIN_FILESYSTEM_PATH_INVALID".into());
        }
        if information.attributes & 0x400 != 0 {
            return Err("PLUGIN_FILESYSTEM_SYMLINK_NOT_ALLOWED".into());
        }
        Ok(format!(
            "{}:{}:{}",
            information.volume, information.index_high, information.index_low
        ))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Err("PLUGIN_FILESYSTEM_TYPE_UNSUPPORTED".into())
    }
}

fn plugin_permission_scope_matches(path: &str, scope: &str) -> bool {
    let pattern = scope.trim().replace('\\', "/");
    if pattern.is_empty() || pattern.starts_with('/') || pattern.split('/').any(|part| part == "..")
    {
        return false;
    }
    let pattern = pattern.as_bytes();
    let path = path.as_bytes();
    let mut table = vec![vec![false; path.len() + 1]; pattern.len() + 1];
    table[0][0] = true;
    for pattern_index in 0..pattern.len() {
        for path_index in 0..=path.len() {
            if !table[pattern_index][path_index] {
                continue;
            }
            if pattern[pattern_index] == b'*' {
                let double = pattern.get(pattern_index + 1) == Some(&b'*');
                let next_pattern = pattern_index + if double { 2 } else { 1 };
                table[next_pattern][path_index] = true;
                let mut next_path = path_index;
                while next_path < path.len() && (double || path[next_path] != b'/') {
                    next_path += 1;
                    table[next_pattern][next_path] = true;
                }
            } else if path_index < path.len() && pattern[pattern_index] == path[path_index] {
                table[pattern_index + 1][path_index + 1] = true;
            } else if pattern[pattern_index] == b'?'
                && path_index < path.len()
                && path[path_index] != b'/'
            {
                table[pattern_index + 1][path_index + 1] = true;
            }
        }
    }
    table[pattern.len()][path.len()]
}

fn plugin_path_has_permission(
    manifest: &serde_json::Value,
    permission_id: &str,
    path: &str,
) -> bool {
    manifest
        .get("permissions")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .find(|permission| {
            permission.get("id").and_then(serde_json::Value::as_str) == Some(permission_id)
        })
        .and_then(|permission| permission.get("scope"))
        .and_then(serde_json::Value::as_array)
        .map_or(true, |scopes| {
            scopes.is_empty()
                || scopes
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .any(|scope| plugin_permission_scope_matches(path, scope))
        })
}

fn collect_plugin_tree(
    path: &Path,
    entries: &mut Vec<PathBuf>,
    checkpoint: &dyn Fn() -> Result<(), String>,
    depth: usize,
) -> Result<(), String> {
    checkpoint()?;
    if depth > 64 || entries.len() >= 10_000 {
        return Err("PLUGIN_FILESYSTEM_TRAVERSAL_LIMIT_EXCEEDED".into());
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED".to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("PLUGIN_FILESYSTEM_SYMLINK_NOT_ALLOWED".to_string());
    }
    entries.push(path.to_path_buf());
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED".to_string())? {
            let entry = entry.map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED".to_string())?;
            collect_plugin_tree(&entry.path(), entries, checkpoint, depth + 1)?;
        }
    }
    Ok(())
}

fn validate_plugin_transfer_scopes(
    root: &Path,
    manifest: &serde_json::Value,
    source: &Path,
    destination: &Path,
    source_permission: &str,
    destination_permission: &str,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    let mut entries = Vec::new();
    collect_plugin_tree(source, &mut entries, checkpoint, 0)?;
    for entry in entries {
        let source_relative = relative_path(root, &entry);
        let suffix = entry.strip_prefix(source).unwrap_or(Path::new(""));
        let mapped = destination.join(suffix);
        let destination_relative = relative_path(root, &mapped);
        if !plugin_path_has_permission(manifest, source_permission, &source_relative)
            || !plugin_path_has_permission(manifest, destination_permission, &destination_relative)
        {
            return Err("PLUGIN_PERMISSION_SCOPE_VIOLATION".to_string());
        }
    }
    Ok(())
}

/// Revalidate each copied entry so changes after preflight cannot bypass scopes or traversal limits.
fn copy_plugin_tree(
    root: &Path,
    manifest: &serde_json::Value,
    source: &Path,
    destination: &Path,
    checkpoint: &dyn Fn() -> Result<(), String>,
    remaining: &mut usize,
    depth: usize,
    created_paths: &mut Vec<(PathBuf, String)>,
) -> Result<(), String> {
    let source_identity = plugin_path_identity(source)?;
    let destination_parent = destination
        .parent()
        .ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?;
    let _source_pins = file_commit::pin_directories(
        root,
        source.parent().ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?,
    )?;
    let _destination_pins = file_commit::pin_directories(root, destination_parent)?;
    let destination_parent_identity = plugin_path_identity(destination_parent)?;
    checkpoint()?;
    if depth > 64 || *remaining == 0 {
        return Err("PLUGIN_FILESYSTEM_TRAVERSAL_LIMIT_EXCEEDED".into());
    }
    *remaining -= 1;
    let source_relative = relative_path(root, source);
    let destination_relative = relative_path(root, destination);
    // Use the paths returned by canonical validation for the actual I/O.
    // Object checks detect replacement observed around revocation checkpoints;
    // handle-relative I/O is still required to close the final syscall race.
    let validated_source = resolve_plugin_existing_path(root, &source_relative)?;
    let validated_destination = resolve_plugin_new_path(root, &destination_relative)?;
    if validated_source != source || validated_destination != destination {
        return Err("PLUGIN_FILESYSTEM_PATH_INVALID".into());
    }
    let source = validated_source;
    let destination = validated_destination;
    if plugin_path_identity(&source)? != source_identity
        || plugin_path_identity(
            destination
                .parent()
                .ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?,
        )? != destination_parent_identity
    {
        return Err("PLUGIN_FILESYSTEM_PATH_INVALID".into());
    }
    if !plugin_path_has_permission(manifest, "workspace.read", &source_relative)
        || !plugin_path_has_permission(manifest, "workspace.write", &destination_relative)
    {
        return Err("PLUGIN_PERMISSION_SCOPE_VIOLATION".into());
    }
    let metadata =
        fs::symlink_metadata(&source).map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED".to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("PLUGIN_FILESYSTEM_SYMLINK_NOT_ALLOWED".into());
    }
    checkpoint()?;
    if plugin_path_identity(&source)? != source_identity
        || plugin_path_identity(
            destination
                .parent()
                .ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?,
        )? != destination_parent_identity
    {
        return Err("PLUGIN_FILESYSTEM_PATH_INVALID".into());
    }
    if metadata.is_dir() {
        fs::create_dir(&destination).map_err(|_| "PLUGIN_FILESYSTEM_COPY_FAILED".to_string())?;
        created_paths.push((destination.clone(), plugin_path_identity(&destination)?));
        let _source_directory_pins = file_commit::pin_directories(root, &source)?;
        let _destination_directory_pins = file_commit::pin_directories(root, &destination)?;
        for entry in
            fs::read_dir(source).map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED".to_string())?
        {
            let entry = entry.map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED".to_string())?;
            copy_plugin_tree(
                root,
                manifest,
                &entry.path(),
                &destination.join(entry.file_name()),
                checkpoint,
                remaining,
                depth + 1,
                created_paths,
            )?;
        }
    } else if metadata.is_file() {
        let mut input = file_commit::open_read_snapshot(&source)?;
        file_commit::create_new_with(
            root,
            &destination,
            Some(&source),
            &mut |output| {
                use std::io::{Read, Write};
                let mut buffer = [0u8; 64 * 1024];
                loop {
                    checkpoint()?;
                    let count = input
                        .read(&mut buffer)
                        .map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")?;
                    if count == 0 {
                        break;
                    }
                    output
                        .write_all(&buffer[..count])
                        .map_err(|_| "PLUGIN_FILESYSTEM_COPY_FAILED")?;
                }
                if plugin_path_identity(&source)? != source_identity {
                    return Err("PLUGIN_FILESYSTEM_PATH_INVALID".into());
                }
                Ok(())
            },
            checkpoint,
        )?;
        created_paths.push((destination.clone(), plugin_path_identity(&destination)?));
        fs::set_permissions(&destination, metadata.permissions())
            .map_err(|_| "PLUGIN_FILESYSTEM_COPY_FAILED".to_string())?;
    } else {
        return Err("PLUGIN_FILESYSTEM_TYPE_UNSUPPORTED".to_string());
    }
    Ok(())
}

fn move_plugin_path_checked(
    root: &Path,
    manifest: &serde_json::Value,
    source_value: &str,
    destination_value: &str,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<PluginFilesystemEntry, String> {
    let source = resolve_plugin_existing_path(root, source_value)?;
    if source == root {
        return Err("PLUGIN_FILESYSTEM_ROOT_PROTECTED".to_string());
    }
    let destination = resolve_plugin_new_path(root, destination_value)?;
    if destination.starts_with(&source) {
        return Err("PLUGIN_FILESYSTEM_PATH_INVALID".to_string());
    }
    let _source_pins = file_commit::pin_directories(
        root,
        source.parent().ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?,
    )?;
    let _destination_pins = file_commit::pin_directories(
        root,
        destination
            .parent()
            .ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?,
    )?;
    let source_identity = plugin_path_identity(&source)?;
    let destination_parent_identity = plugin_path_identity(
        destination
            .parent()
            .ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?,
    )?;
    validate_plugin_transfer_scopes(
        root,
        manifest,
        &source,
        &destination,
        "workspace.write",
        "workspace.write",
        checkpoint,
    )?;
    checkpoint()?;
    // Re-resolve immediately before rename so a replaced parent cannot redirect
    // the mutation after the scope and type checks have completed.
    let current_source = resolve_plugin_existing_path(root, source_value)?;
    let current_destination = resolve_plugin_new_path(root, destination_value)?;
    if current_source != source
        || current_destination != destination
        || plugin_path_identity(&current_source)? != source_identity
        || plugin_path_identity(
            current_destination
                .parent()
                .ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?,
        )? != destination_parent_identity
    {
        return Err("PLUGIN_FILESYSTEM_PATH_INVALID".into());
    }
    #[cfg(windows)]
    file_commit::install(&source, &destination, false).map_err(|error| {
        if error == "PLUGIN_WRITE_CONFLICT" {
            "PLUGIN_FILESYSTEM_ALREADY_EXISTS".to_string()
        } else {
            "PLUGIN_FILESYSTEM_MOVE_FAILED".to_string()
        }
    })?;
    #[cfg(not(windows))]
    fs::rename(&source, &destination).map_err(|_| "PLUGIN_FILESYSTEM_MOVE_FAILED".to_string())?;
    stat_plugin_filesystem_entry(root, destination_value)
}

fn copy_plugin_path_checked(
    root: &Path,
    manifest: &serde_json::Value,
    source_value: &str,
    destination_value: &str,
    recursive: bool,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<PluginFilesystemEntry, String> {
    let source = resolve_plugin_existing_path(root, source_value)?;
    if source == root {
        return Err("PLUGIN_FILESYSTEM_ROOT_PROTECTED".to_string());
    }
    let metadata = fs::metadata(&source).map_err(|_| "PLUGIN_FILESYSTEM_NOT_FOUND".to_string())?;
    if metadata.is_dir() && !recursive {
        return Err("PLUGIN_FILESYSTEM_RECURSIVE_REQUIRED".to_string());
    }
    let destination = resolve_plugin_new_path(root, destination_value)?;
    if metadata.is_dir() && destination.starts_with(&source) {
        return Err("PLUGIN_FILESYSTEM_PATH_INVALID".to_string());
    }
    let _source_pins = file_commit::pin_directories(
        root,
        source.parent().ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?,
    )?;
    let _destination_pins = file_commit::pin_directories(
        root,
        destination
            .parent()
            .ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?,
    )?;
    let source_identity = plugin_path_identity(&source)?;
    let parent = destination
        .parent()
        .ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?;
    let parent_identity = plugin_path_identity(parent)?;
    validate_plugin_transfer_scopes(
        root,
        manifest,
        &source,
        &destination,
        "workspace.read",
        "workspace.write",
        checkpoint,
    )?;
    if plugin_path_identity(&source)? != source_identity
        || plugin_path_identity(parent)? != parent_identity
    {
        return Err("PLUGIN_FILESYSTEM_PATH_INVALID".into());
    }
    let mut created_paths = Vec::new();
    let copy_result = copy_plugin_tree(
        root,
        manifest,
        &source,
        &destination,
        checkpoint,
        &mut 10_000,
        0,
        &mut created_paths,
    );
    if let Err(error) = copy_result {
        // Remove only paths created by this operation. A directory containing
        // a late external entry is intentionally left in place.
        for (created, identity) in created_paths.into_iter().rev() {
            let result = match fs::symlink_metadata(&created) {
                Ok(metadata) => {
                    // A replaced path or redirected ancestor belongs to another
                    // writer. Preserve it, including links, during rollback.
                    if resolve_plugin_existing_path(root, &relative_path(root, &created)).is_err()
                        || plugin_path_identity(&created).as_ref() != Ok(&identity)
                    {
                        continue;
                    }
                    if metadata.is_dir() {
                        fs::remove_dir(&created)
                    } else {
                        fs::remove_file(&created)
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error),
            };
            if let Err(cleanup_error) = result {
                if cleanup_error.kind() != std::io::ErrorKind::DirectoryNotEmpty {
                    return Err("PLUGIN_FILESYSTEM_COPY_ROLLBACK_FAILED".into());
                }
            }
        }
        return Err(error);
    }
    stat_plugin_filesystem_entry(root, destination_value)
}

#[tauri::command]
fn plugin_filesystem_move(
    request: PluginFilesystemTransferRequest,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<serde_json::Value, String> {
    invoke_plugin_filesystem(
        &app,
        &state,
        &request.plugin_id,
        "filesystem.move",
        serde_json::json!({ "sourcePath": request.source_path, "destinationPath": request.destination_path }),
    )
}

#[tauri::command]
fn plugin_filesystem_copy(
    request: PluginFilesystemCopyRequest,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<serde_json::Value, String> {
    invoke_plugin_filesystem(
        &app,
        &state,
        &request.plugin_id,
        "filesystem.copy",
        serde_json::json!({ "sourcePath": request.source_path, "destinationPath": request.destination_path, "options": { "recursive": request.options.and_then(|options| options.recursive).unwrap_or(false) } }),
    )
}

#[tauri::command]
fn plugin_filesystem_rename(
    request: PluginFilesystemRenameRequest,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<serde_json::Value, String> {
    invoke_plugin_filesystem(
        &app,
        &state,
        &request.plugin_id,
        "filesystem.rename",
        serde_json::json!({ "path": request.path, "newName": request.new_name }),
    )
}

struct PluginKeyDerivationGuard;

impl PluginKeyDerivationGuard {
    fn acquire() -> Result<Self, String> {
        ACTIVE_PLUGIN_KEY_DERIVATIONS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < 2).then_some(active + 1)
            })
            .map(|_| Self)
            .map_err(|_| "PLUGIN_FILESYSTEM_CRYPTO_BUSY".to_string())
    }
}

impl Drop for PluginKeyDerivationGuard {
    fn drop(&mut self) {
        ACTIVE_PLUGIN_KEY_DERIVATIONS.fetch_sub(1, Ordering::AcqRel);
    }
}

fn derive_plugin_encryption_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let _guard = PluginKeyDerivationGuard::acquire()?;
    let params = scrypt::Params::new(14, 8, 1, 32)
        .map_err(|_| "PLUGIN_FILESYSTEM_ENCRYPTION_FAILED".to_string())?;
    let mut key = [0u8; 32];
    scrypt::scrypt(password.as_bytes(), salt, &params, &mut key)
        .map_err(|_| "PLUGIN_FILESYSTEM_ENCRYPTION_FAILED".to_string())?;
    Ok(key)
}

#[cfg(test)]
fn protect_plugin_file(
    root: &Path,
    requested_path: &str,
    password: &str,
    encrypt: bool,
) -> Result<PluginFilesystemEntry, String> {
    protect_plugin_file_checked(root, requested_path, password, encrypt, &|| Ok(()))
}

/// Recheck caller lifetime after costly key derivation and before replacing the original bytes.
fn protect_plugin_file_checked(
    root: &Path,
    requested_path: &str,
    password: &str,
    encrypt: bool,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<PluginFilesystemEntry, String> {
    if password.is_empty() || password.chars().count() > 1024 {
        return Err("PLUGIN_INVALID_ARGUMENT".to_string());
    }
    let path = resolve_plugin_existing_path(root, requested_path)?;
    let metadata = fs::metadata(&path).map_err(|_| "PLUGIN_FILESYSTEM_NOT_FOUND".to_string())?;
    if !metadata.is_file() {
        return Err("PLUGIN_FILESYSTEM_NOT_FILE".to_string());
    }
    let max_size = if encrypt {
        MAX_PLUGIN_PROTECTED_FILE_SIZE
    } else {
        MAX_PLUGIN_PROTECTED_FILE_SIZE + PLUGIN_ENCRYPTION_HEADER_LENGTH as u64
    };
    if metadata.len() > max_size {
        return Err("PLUGIN_FILESYSTEM_FILE_TOO_LARGE".to_string());
    }
    let identity = plugin_path_identity(&path)?;
    let contents = fs::read(&path).map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED".to_string())?;
    if encrypt {
        if contents.starts_with(PLUGIN_ENCRYPTION_MAGIC) {
            return Err("PLUGIN_FILESYSTEM_ALREADY_ENCRYPTED".to_string());
        }
        let mut salt = [0u8; PLUGIN_ENCRYPTION_SALT_LENGTH];
        let mut nonce = [0u8; PLUGIN_ENCRYPTION_NONCE_LENGTH];
        OsRng.fill_bytes(&mut salt);
        OsRng.fill_bytes(&mut nonce);
        let mut aad = Vec::with_capacity(8 + 1 + salt.len() + nonce.len());
        aad.extend_from_slice(PLUGIN_ENCRYPTION_MAGIC);
        aad.push(PLUGIN_ENCRYPTION_VERSION);
        aad.extend_from_slice(&salt);
        aad.extend_from_slice(&nonce);
        let mut key = derive_plugin_encryption_key(password, &salt)?;
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| "PLUGIN_FILESYSTEM_ENCRYPTION_FAILED".to_string())?;
        let encrypted = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &contents,
                    aad: &aad,
                },
            )
            .map_err(|_| "PLUGIN_FILESYSTEM_ENCRYPTION_FAILED".to_string())?;
        key.fill(0);
        let ciphertext_length = encrypted.len().saturating_sub(PLUGIN_ENCRYPTION_TAG_LENGTH);
        let mut output = aad;
        output.extend_from_slice(&encrypted[ciphertext_length..]);
        output.extend_from_slice(&encrypted[..ciphertext_length]);
        checkpoint()?;
        if fs::read(&path).map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")? != contents {
            return Err("PLUGIN_WRITE_CONFLICT".into());
        }
        file_commit::replace_existing(root, &path, &output, &contents, &identity, checkpoint)?;
    } else {
        if contents.len() < PLUGIN_ENCRYPTION_HEADER_LENGTH
            || !contents.starts_with(PLUGIN_ENCRYPTION_MAGIC)
        {
            return Err("PLUGIN_FILESYSTEM_NOT_ENCRYPTED".to_string());
        }
        let version_offset = PLUGIN_ENCRYPTION_MAGIC.len();
        if contents[version_offset] != PLUGIN_ENCRYPTION_VERSION {
            return Err("PLUGIN_FILESYSTEM_ENCRYPTION_VERSION_UNSUPPORTED".to_string());
        }
        let salt_start = version_offset + 1;
        let salt_end = salt_start + PLUGIN_ENCRYPTION_SALT_LENGTH;
        let nonce_end = salt_end + PLUGIN_ENCRYPTION_NONCE_LENGTH;
        let tag_end = nonce_end + PLUGIN_ENCRYPTION_TAG_LENGTH;
        let mut key = derive_plugin_encryption_key(password, &contents[salt_start..salt_end])?;
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| "PLUGIN_FILESYSTEM_DECRYPT_FAILED".to_string())?;
        let mut encrypted = contents[tag_end..].to_vec();
        encrypted.extend_from_slice(&contents[nonce_end..tag_end]);
        let plaintext = cipher.decrypt(
            Nonce::from_slice(&contents[salt_end..nonce_end]),
            Payload {
                msg: &encrypted,
                aad: &contents[..nonce_end],
            },
        );
        key.fill(0);
        let plaintext = plaintext.map_err(|_| "PLUGIN_FILESYSTEM_DECRYPT_FAILED".to_string())?;
        checkpoint()?;
        if fs::read(&path).map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")? != contents {
            return Err("PLUGIN_WRITE_CONFLICT".into());
        }
        file_commit::replace_existing(root, &path, &plaintext, &contents, &identity, checkpoint)?;
    }
    stat_plugin_filesystem_entry(root, requested_path)
}

#[tauri::command]
fn plugin_filesystem_encrypt(
    request: PluginFilesystemProtectionRequest,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<serde_json::Value, String> {
    invoke_plugin_filesystem(
        &app,
        &state,
        &request.plugin_id,
        "filesystem.encrypt",
        serde_json::json!({ "path": request.path, "password": request.password }),
    )
}

#[tauri::command]
fn plugin_filesystem_decrypt(
    request: PluginFilesystemProtectionRequest,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<serde_json::Value, String> {
    invoke_plugin_filesystem(
        &app,
        &state,
        &request.plugin_id,
        "filesystem.decrypt",
        serde_json::json!({ "path": request.path, "password": request.password }),
    )
}

#[tauri::command]
fn plugin_filesystem_delete(
    request: PluginFilesystemDeleteRequest,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<serde_json::Value, String> {
    invoke_plugin_filesystem(
        &app,
        &state,
        &request.plugin_id,
        "filesystem.delete",
        serde_json::json!({ "path": request.path, "options": { "recursive": request.options.and_then(|options| options.recursive).unwrap_or(false) } }),
    )
}

#[tauri::command]
fn plugin_filesystem_write_text(
    request: PluginFilesystemWriteTextRequest,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<serde_json::Value, String> {
    invoke_plugin_filesystem(
        &app,
        &state,
        &request.plugin_id,
        "filesystem.writeText",
        serde_json::json!({ "path": request.path, "content": request.content, "options": { "expectedContent": request.options.expected_content } }),
    )
}

#[tauri::command]
fn plugin_window_list(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    Ok(plugin_window_snapshots(&app))
}

#[tauri::command]
async fn plugin_window_open(
    request: PluginWindowOpenRequest,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || open_plugin_window(request, app, None))
        .await
        .map_err(|_| "PLUGIN_WINDOW_CREATE_FAILED".to_string())?
}

/// Reuse native plugin windows and pass an optional validated initial webpage to the new view.
fn open_plugin_window(
    mut request: PluginWindowOpenRequest,
    app: AppHandle,
    initial_url: Option<&str>,
) -> Result<serde_json::Value, String> {
    let kind = request.kind.as_deref().unwrap_or("workbench");
    if kind != "workbench" && kind != "plugin" {
        return Err("PLUGIN_INVALID_ARGUMENT".to_string());
    }
    if request
        .title
        .as_ref()
        .is_some_and(|title| title.len() > 200)
    {
        return Err("PLUGIN_INVALID_ARGUMENT".to_string());
    }
    if request
        .file_path
        .as_ref()
        .is_some_and(|path| path.trim().is_empty())
    {
        return Err("PLUGIN_INVALID_ARGUMENT".to_string());
    }
    if request.file_path.is_some() && kind == "plugin" {
        return Err("PLUGIN_INVALID_ARGUMENT".to_string());
    }
    if let Some(file_path) = request.file_path.as_deref() {
        let root = workspace_root_from_app(&app)?;
        let target = normalize_relative_path(&root, file_path)
            .map_err(|_| "PLUGIN_WORKSPACE_FILE_NOT_FOUND".to_string())?;
        if !target.is_file() || workspace_file_kind(&target).is_none() {
            return Err("PLUGIN_WORKSPACE_FILE_NOT_FOUND".to_string());
        }
        request.file_path = Some(relative_path(&root, &target));
        if request.title.is_none() {
            request.title = target
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string);
        }
    }
    if kind == "plugin"
        && (request
            .plugin_id
            .as_ref()
            .map_or(true, |value| value.trim().is_empty())
            || request
                .view_type
                .as_ref()
                .map_or(true, |value| value.trim().is_empty()))
    {
        return Err("PLUGIN_WINDOW_VIEW_NOT_DECLARED".to_string());
    }
    validate_window_state(request.state.as_deref(), true)?;
    validate_window_geometry(
        request.position.as_ref(),
        request.size.as_ref(),
        request.bounds.as_ref(),
    )?;

    if let Some(existing) = find_reusable_plugin_window(&app, &request, kind)? {
        apply_plugin_window_options(&existing, &request)?;
        if request.position.is_none() && request.bounds.is_none() {
            center_window_in_host(&app, &existing)?;
        }
        if request.state.as_deref() != Some("minimized") {
            existing.show().map_err(|error| error.to_string())?;
            existing.set_focus().map_err(|error| error.to_string())?;
        }
        let id = existing.label().to_string();
        return plugin_window_snapshot(&app, &id);
    }

    let id = format!("plugin-window-{}", Uuid::new_v4().simple());
    let instance_id = Uuid::new_v4().simple().to_string();
    let query = plugin_window_query(&request, kind, &instance_id, initial_url);
    let url = WebviewUrl::App(PathBuf::from(query));
    let (width, height) = initial_window_size(&request);
    let title = request
        .title
        .as_deref()
        .filter(|value| !value.is_empty())
        .unwrap_or(if kind == "plugin" {
            request.view_type.as_deref().unwrap_or("Plugin")
        } else {
            "WStudio"
        });
    let builder = WebviewWindowBuilder::new(&app, &id, url)
        .title(title)
        .decorations(false)
        .inner_size(width, height)
        .min_inner_size(200.0, 200.0);
    let builder = with_default_window_chrome(
        builder,
        app.default_window_icon()
            .cloned()
            .map(tauri::image::Image::to_owned),
    )?;
    let (x, y) = host_center_position(&app, (width, height))?;
    let builder = builder.position(x, y);
    let window = builder.build().map_err(|error| error.to_string())?;
    apply_windows_taskbar_icon(&window)?;
    plugin_window_metadata()
        .lock()
        .map_err(|_| "plugin-window-metadata-poisoned".to_string())?
        .insert(
            id.clone(),
            PluginWindowMetadata {
                kind: kind.to_string(),
                owner_plugin_id: (kind == "plugin")
                    .then(|| request.plugin_id.clone())
                    .flatten(),
                view_type: (kind == "plugin")
                    .then(|| request.view_type.clone())
                    .flatten(),
            },
        );
    let parent = app.get_window(&id).ok_or("PLUGIN_WINDOW_NOT_FOUND")?;
    apply_plugin_window_options(&parent, &request)?;
    plugin_window_snapshot(&app, &id)
}

/// Encode initial view identity and URL separately so a webpage cannot inject window parameters.
fn plugin_window_query(
    request: &PluginWindowOpenRequest,
    kind: &str,
    instance_id: &str,
    initial_url: Option<&str>,
) -> String {
    let mut query = if kind == "workbench" {
        request.file_path.as_deref().map_or_else(
            || "index.html?windowMode=blank&windowPage=empty".to_string(),
            |file_path| {
                format!(
                    "index.html?windowMode=tab&initialFilePath={}",
                    urlencoding::encode(file_path)
                )
            },
        )
    } else {
        // The tab host mounts the declared plugin view; the blank host has no plugin runtime.
        "index.html?windowMode=tab".to_string()
    };
    if kind == "plugin" {
        query.push_str("&pluginId=");
        query.push_str(&urlencoding::encode(
            request.plugin_id.as_deref().unwrap_or_default(),
        ));
        query.push_str("&pluginViewType=");
        query.push_str(&urlencoding::encode(
            request.view_type.as_deref().unwrap_or_default(),
        ));
        query.push_str("&pluginInstanceId=");
        query.push_str(&urlencoding::encode(instance_id));
        if let Some(url) = initial_url {
            query.push_str("&pluginUrl=");
            query.push_str(&urlencoding::encode(url));
        }
    }
    query
}

#[tauri::command]
fn plugin_window_update(
    request: PluginWindowUpdateRequest,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    if request.window_id.trim().is_empty()
        || request
            .title
            .as_ref()
            .is_some_and(|title| title.len() > 200)
    {
        return Err("PLUGIN_INVALID_ARGUMENT".to_string());
    }
    validate_window_state(request.state.as_deref(), false)?;
    validate_window_geometry(
        request.position.as_ref(),
        request.size.as_ref(),
        request.bounds.as_ref(),
    )?;
    let window = app
        .get_window(&request.window_id)
        .ok_or_else(|| "PLUGIN_WINDOW_NOT_FOUND".to_string())?;
    apply_plugin_window_options(
        &window,
        &PluginWindowOpenRequest {
            title: request.title,
            position: request.position,
            size: request.size,
            bounds: request.bounds,
            state: request.state,
            ..PluginWindowOpenRequest::default()
        },
    )?;
    plugin_window_snapshot(&app, &request.window_id)
}

#[tauri::command]
fn plugin_window_focus(request: PluginWindowIdRequest, app: AppHandle) -> Result<(), String> {
    let window = app
        .get_window(&request.window_id)
        .ok_or_else(|| "PLUGIN_WINDOW_NOT_FOUND".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
async fn plugin_window_close(request: PluginWindowIdRequest, app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || plugin_window_close_impl(request, app))
        .await
        .map_err(|_| "PLUGIN_WINDOW_CLOSE_FAILED".to_string())?
}

fn plugin_window_close_impl(request: PluginWindowIdRequest, app: AppHandle) -> Result<(), String> {
    let window = app
        .get_window(&request.window_id)
        .ok_or_else(|| "PLUGIN_WINDOW_NOT_FOUND".to_string())?;
    window.close().map_err(|error| error.to_string())?;
    plugin_window_metadata()
        .lock()
        .map_err(|_| "plugin-window-metadata-poisoned".to_string())?
        .remove(&request.window_id);
    Ok(())
}

fn plugin_window_snapshots(app: &AppHandle) -> Vec<serde_json::Value> {
    let labels = app
        .windows()
        .keys()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    if let Ok(mut metadata) = plugin_window_metadata().lock() {
        metadata.retain(|label, _| labels.contains(label));
    }
    let metadata = plugin_window_metadata().lock().ok();
    let mut windows = app
        .windows()
        .into_iter()
        .map(|(label, window)| {
            let window_metadata = metadata.as_ref().and_then(|values| values.get(&label));
            let state = if window.is_fullscreen().unwrap_or(false) {
                "fullscreen"
            } else if window.is_maximized().unwrap_or(false) {
                "maximized"
            } else if window.is_minimized().unwrap_or(false) {
                "minimized"
            } else {
                "normal"
            };
            let (logical_position, logical_size) = window
                .outer_position()
                .ok()
                .zip(window.outer_size().ok())
                .and_then(|(position, size)| {
                    physical_window_geometry_to_logical(
                        (position.x, position.y),
                        (size.width, size.height),
                        window.scale_factor().ok()?,
                    )
                    .ok()
                })
                .unwrap_or_default();
            let mut snapshot = serde_json::json!({
                "id": label,
                "kind": window_metadata.map(|value| value.kind.as_str()).unwrap_or("workbench"),
                "state": state,
                "bounds": {
                    "x": logical_position.0,
                    "y": logical_position.1,
                    "width": logical_size.0,
                    "height": logical_size.1
                },
                "focused": window.is_focused().unwrap_or(false)
            });
            if let Ok(title) = window.title() {
                if !title.is_empty() {
                    snapshot["title"] = serde_json::json!(title);
                }
            }
            if let Some(owner_plugin_id) =
                window_metadata.and_then(|value| value.owner_plugin_id.as_ref())
            {
                snapshot["ownerPluginId"] = serde_json::json!(owner_plugin_id);
            }
            if let Some(view_type) = window_metadata.and_then(|value| value.view_type.as_ref()) {
                snapshot["viewType"] = serde_json::json!(view_type);
            }
            snapshot
        })
        .collect::<Vec<_>>();
    windows.sort_by(|left, right| {
        left.get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .cmp(
                right
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default(),
            )
    });
    windows
}

fn plugin_window_snapshot(app: &AppHandle, id: &str) -> Result<serde_json::Value, String> {
    plugin_window_snapshots(app)
        .into_iter()
        .find(|window| window.get("id").and_then(serde_json::Value::as_str) == Some(id))
        .ok_or_else(|| "PLUGIN_WINDOW_NOT_FOUND".to_string())
}

fn find_reusable_plugin_window(
    app: &AppHandle,
    request: &PluginWindowOpenRequest,
    kind: &str,
) -> Result<Option<Window>, String> {
    let Some(reuse) = request.reuse.as_deref() else {
        return Ok(None);
    };
    if reuse != "reuse-focused" && reuse != "reuse-existing" {
        if reuse == "always-new" {
            return Ok(None);
        }
        return Err("PLUGIN_INVALID_ARGUMENT".to_string());
    }
    let metadata = plugin_window_metadata()
        .lock()
        .map_err(|_| "plugin-window-metadata-poisoned".to_string())?;
    let mut candidates = app
        .windows()
        .into_iter()
        .filter(|(label, window)| {
            if kind == "plugin" {
                let Some(value) = metadata.get(label) else {
                    return false;
                };
                value.kind == "plugin"
                    && value.owner_plugin_id == request.plugin_id
                    && value.view_type == request.view_type
                    && !window.is_minimized().unwrap_or(false)
            } else {
                metadata
                    .get(label)
                    .map_or(true, |value| value.kind == "workbench")
            }
        })
        .map(|(_, window)| window);
    if reuse == "reuse-focused" {
        Ok(candidates.find(|window| window.is_focused().unwrap_or(false)))
    } else {
        Ok(candidates.next())
    }
}

fn initial_window_size(request: &PluginWindowOpenRequest) -> (f64, f64) {
    if let Some(bounds) = request.bounds.as_ref() {
        return (bounds.width, bounds.height);
    }
    if let Some(size) = request.size.as_ref() {
        return (size.width, size.height);
    }
    (800.0, 600.0)
}

/// Calculate a child window's logical top-left position centered within its host window.
fn center_position_within_host(
    host_position: (f64, f64),
    host_size: (f64, f64),
    child_size: (f64, f64),
) -> (f64, f64) {
    (
        host_position.0 + (host_size.0 - child_size.0) / 2.0,
        host_position.1 + (host_size.1 - child_size.1) / 2.0,
    )
}

/// Read the main workbench's outer bounds and return a centered logical position.
fn host_center_position(app: &AppHandle, child_size: (f64, f64)) -> Result<(f64, f64), String> {
    let host = app
        .get_window("main")
        .ok_or_else(|| "HOST_WINDOW_NOT_FOUND".to_string())?;
    let position = host.outer_position().map_err(|error| error.to_string())?;
    let size = host.outer_size().map_err(|error| error.to_string())?;
    let ((x, y), (width, height)) = physical_window_geometry_to_logical(
        (position.x, position.y),
        (size.width, size.height),
        host.scale_factor().map_err(|error| error.to_string())?,
    )?;
    Ok(center_position_within_host(
        (x, y),
        (width, height),
        child_size,
    ))
}

/// Center an existing child using its current outer size and the main workbench bounds.
fn center_window_in_host(app: &AppHandle, window: &Window) -> Result<(), String> {
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let (_, child_size) = physical_window_geometry_to_logical(
        (0, 0),
        (size.width, size.height),
        window.scale_factor().map_err(|error| error.to_string())?,
    )?;
    let position = host_center_position(app, child_size)?;
    window
        .set_position(tauri::Position::Logical(tauri::LogicalPosition {
            x: position.0,
            y: position.1,
        }))
        .map_err(|error| error.to_string())
}

fn validate_window_geometry(
    position: Option<&PluginWindowPositionRequest>,
    size: Option<&PluginWindowSizeRequest>,
    bounds: Option<&PluginWindowBoundsRequest>,
) -> Result<(), String> {
    if let Some(value) = position {
        finite_i32(value.x)?;
        finite_i32(value.y)?;
    }
    if let Some(value) = size {
        window_dimension(value.width)?;
        window_dimension(value.height)?;
    }
    if let Some(value) = bounds {
        finite_i32(value.x)?;
        finite_i32(value.y)?;
        window_dimension(value.width)?;
        window_dimension(value.height)?;
    }
    Ok(())
}

fn validate_window_state(state: Option<&str>, opening: bool) -> Result<(), String> {
    let valid = match state {
        None => true,
        Some("minimized" | "maximized" | "fullscreen") => true,
        Some("normal") => !opening,
        Some(_) => false,
    };
    if valid {
        Ok(())
    } else {
        Err("PLUGIN_INVALID_ARGUMENT".to_string())
    }
}

fn finite_i32(value: f64) -> Result<i32, String> {
    if !value.is_finite() || value < i32::MIN as f64 || value > i32::MAX as f64 {
        return Err("PLUGIN_INVALID_ARGUMENT".to_string());
    }
    Ok(value.round() as i32)
}

fn window_dimension(value: f64) -> Result<u32, String> {
    if !value.is_finite() || value < 200.0 || value > u32::MAX as f64 {
        return Err("PLUGIN_INVALID_ARGUMENT".to_string());
    }
    Ok(value.round() as u32)
}

/// Convert native physical geometry to the logical pixels exposed by the SDK.
fn physical_window_geometry_to_logical(
    position: (i32, i32),
    size: (u32, u32),
    scale_factor: f64,
) -> Result<((f64, f64), (f64, f64)), String> {
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return Err("PLUGIN_API_FAILED".to_string());
    }
    Ok((
        (
            f64::from(position.0) / scale_factor,
            f64::from(position.1) / scale_factor,
        ),
        (
            f64::from(size.0) / scale_factor,
            f64::from(size.1) / scale_factor,
        ),
    ))
}

fn apply_plugin_window_options(
    window: &Window,
    request: &PluginWindowOpenRequest,
) -> Result<(), String> {
    if let Some(title) = request.title.as_deref() {
        window.set_title(title).map_err(|error| error.to_string())?;
    }
    let (position, size) = match (&request.position, &request.size, &request.bounds) {
        (None, None, None) => (None, None),
        (position, size, bounds) => {
            let position = position
                .as_ref()
                .map(|value| (value.x, value.y))
                .or_else(|| bounds.as_ref().map(|value| (value.x, value.y)));
            let size = size
                .as_ref()
                .map(|value| (value.width, value.height))
                .or_else(|| bounds.as_ref().map(|value| (value.width, value.height)));
            (position, size)
        }
    };
    if let Some((x, y)) = position {
        window
            .set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
            .map_err(|error| error.to_string())?;
    }
    if let Some((width, height)) = size {
        window
            .set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }))
            .map_err(|error| error.to_string())?;
    }
    if let Some(state) = request.state.as_deref() {
        match state {
            "normal" => {
                if window.is_fullscreen().map_err(|error| error.to_string())? {
                    window
                        .set_fullscreen(false)
                        .map_err(|error| error.to_string())?;
                }
                if window.is_maximized().map_err(|error| error.to_string())? {
                    window.unmaximize().map_err(|error| error.to_string())?;
                }
                if window.is_minimized().map_err(|error| error.to_string())? {
                    window.unminimize().map_err(|error| error.to_string())?;
                }
            }
            "minimized" => window.minimize().map_err(|error| error.to_string())?,
            "maximized" => window.maximize().map_err(|error| error.to_string())?,
            "fullscreen" => window
                .set_fullscreen(true)
                .map_err(|error| error.to_string())?,
            _ => return Err("PLUGIN_INVALID_ARGUMENT".to_string()),
        }
    }
    Ok(())
}

fn start_window_watcher(app: AppHandle) {
    thread::spawn(move || {
        let mut previous: Option<Vec<serde_json::Value>> = None;
        loop {
            thread::sleep(Duration::from_millis(300));
            let current = plugin_window_snapshots(&app);
            if previous.as_ref() != Some(&current) {
                let _ = app.emit("plugin:windowChanged", &current);
                previous = Some(current);
            }
        }
    });
}

#[tauri::command]
async fn workbench_open_settings(
    navigation_id: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _window_lock = WORKBENCH_WINDOW_LOCK
            .lock()
            .map_err(|_| "WORKBENCH_WINDOW_STATE_POISONED".to_string())?;
        if let Some(window) = find_workbench_page_window(&app, "settings") {
            window.unminimize().map_err(|error| error.to_string())?;
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
            app.emit(
                "workbench:settingsWindowState",
                serde_json::json!({ "open": true }),
            )
            .map_err(|error| error.to_string())?;
            return Ok(());
        }
        if let Some(window) = app.get_window("search") {
            window.close().map_err(|error| error.to_string())?;
        }
        let _label = open_workbench_blank_window(
            &app,
            "settings",
            "设置",
            980.0,
            720.0,
            navigation_id.as_deref(),
        )?;
        app.emit(
            "workbench:settingsWindowState",
            serde_json::json!({ "open": true }),
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    })
    .await
    .map_err(|_| "WINDOW_CREATE_FAILED".to_string())?
    .map(|_| ())
}

#[tauri::command]
async fn workbench_open_search(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _window_lock = WORKBENCH_WINDOW_LOCK
            .lock()
            .map_err(|_| "WORKBENCH_WINDOW_STATE_POISONED".to_string())?;
        if find_workbench_page_window(&app, "settings").is_some() {
            return Ok(());
        }
        if let Some(window) = app.get_window("search") {
            center_window_in_host(&app, &window)?;
            window.unminimize().map_err(|error| error.to_string())?;
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
            return Ok(());
        }
        open_workbench_blank_window(&app, "search", "搜索", 760.0, 600.0, None).map(|_| ())
    })
    .await
    .map_err(|_| "WINDOW_CREATE_FAILED".to_string())?
    .map(|_| ())
}

/// Locate the single native window that hosts a named blank workbench page.
fn find_workbench_page_window(app: &AppHandle, page: &str) -> Option<Window> {
    let prefix = format!("wstudio-{page}-");
    app.windows()
        .into_iter()
        .find_map(|(label, window)| label.starts_with(&prefix).then_some(window))
}

#[tauri::command]
async fn workbench_open_repository_manager(
    request: Option<serde_json::Value>,
    app: AppHandle,
) -> Result<(), String> {
    let create_app = app.clone();
    let label = tauri::async_runtime::spawn_blocking(move || {
        open_workbench_blank_window(
            &create_app,
            "repository-manager",
            "仓库管理",
            720.0,
            560.0,
            None,
        )
    })
    .await
    .map_err(|_| "WINDOW_CREATE_FAILED".to_string())??;
    if let Some(request) = request {
        pending_repository_manager_requests()
            .lock()
            .map_err(|_| "REPOSITORY_MANAGER_REQUEST_STATE_POISONED".to_string())?
            .insert(label, request);
    }
    Ok(())
}

#[tauri::command]
fn workbench_take_repository_manager_request(
    window: Window,
) -> Result<Option<serde_json::Value>, String> {
    Ok(pending_repository_manager_requests()
        .lock()
        .map_err(|_| "REPOSITORY_MANAGER_REQUEST_STATE_POISONED".to_string())?
        .remove(window.label()))
}

#[tauri::command]
fn workbench_open_settings_tab(
    navigation_id: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    app.emit(
        "workbench:openSettingsTabRequested",
        serde_json::json!({ "navigationId": navigation_id }),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn workbench_open_search_result(
    relative_path_value: String,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<bool, String> {
    let root = workspace_root(&state)?;
    let target = match normalize_relative_path(&root, &relative_path_value) {
        Ok(path) if path.is_file() => path,
        _ => return Ok(false),
    };
    let content = match fs::read_to_string(&target) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    let relative_path = relative_path(&root, &target);
    let title = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("文件")
        .to_string();
    let repository = repository_summary(&root);
    app.emit(
        "workspace:openFileRequested",
        WorkspaceOpenTextRequest {
            repository_id: repository.id,
            file_path: target.to_string_lossy().into_owned(),
            relative_path,
            title,
            kind: "text",
            content,
            position: None,
            selection_end: None,
            vertical_alignment: None,
            disposition: "current-group",
        },
    )
    .map_err(|error| error.to_string())?;
    Ok(true)
}

fn open_workbench_blank_window(
    app: &AppHandle,
    page: &str,
    title: &str,
    width: f64,
    height: f64,
    navigation_id: Option<&str>,
) -> Result<String, String> {
    let label = if page == "search" {
        "search".to_string()
    } else {
        format!("wstudio-{page}-{}", Uuid::new_v4().simple())
    };
    let mut query = format!("index.html?windowMode=blank&windowPage={page}");
    if let Some(navigation_id) = navigation_id.filter(|value| !value.trim().is_empty()) {
        query.push_str("&settingsNavigationId=");
        query.push_str(&urlencoding::encode(navigation_id));
    }
    let url = WebviewUrl::App(PathBuf::from(query));
    let builder = WebviewWindowBuilder::new(app, &label, url)
        .title(title)
        .decorations(false)
        .maximizable(page != "settings")
        .inner_size(width, height)
        .min_inner_size(560.0, 420.0);
    let builder = with_default_window_chrome(
        builder,
        app.default_window_icon()
            .cloned()
            .map(tauri::image::Image::to_owned),
    )?;
    let (x, y) = host_center_position(app, (width, height))?;
    let builder = builder.position(x, y);
    let window = builder.build().map_err(|error| error.to_string())?;
    apply_windows_taskbar_icon(&window)?;
    Ok(label)
}

#[tauri::command]
fn system_list_fonts() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name",
            ])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err("SYSTEM_FONTS_UNAVAILABLE".to_string());
        }
        let mut fonts: Vec<String> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(normalize_font_family_name)
            .collect();
        fonts.sort_unstable_by_key(|value| value.to_ascii_lowercase());
        fonts.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
        return Ok(fonts);
    }

    #[cfg(target_os = "macos")]
    {
        system_fonts_macos::list_fonts()
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let mut fonts = Vec::new();
        for directory in ["/usr/share/fonts", "/usr/local/share/fonts"] {
            collect_font_names(Path::new(directory), &mut fonts);
        }
        fonts.sort_unstable_by_key(|value| value.to_ascii_lowercase());
        fonts.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
        Ok(fonts)
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn collect_font_names(directory: &Path, result: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_font_names(&path, result);
        } else if matches!(
            path.extension().and_then(|value| value.to_str()),
            Some("ttf" | "otf" | "woff" | "woff2")
        ) {
            if let Some(name) = path.file_stem().and_then(|value| value.to_str()) {
                result.push(normalize_font_family_name(name));
            }
        }
    }
}

fn normalize_font_family_name(value: &str) -> String {
    let without_type = value
        .trim()
        .split_once(" (")
        .map(|(name, _)| name)
        .unwrap_or(value)
        .trim()
        .replace(['-', '_'], " ");
    let style_words = [
        "Bold",
        "Italic",
        "Oblique",
        "Regular",
        "Light",
        "SemiLight",
        "Semilight",
        "SemiBold",
        "Semibold",
        "ExtraLight",
        "Medium",
        "Black",
        "Thin",
        "Condensed",
        "SemiCondensed",
        "Expanded",
    ];
    let mut parts: Vec<&str> = without_type.split_whitespace().collect();
    while parts.last().is_some_and(|part| {
        style_words
            .iter()
            .any(|style| style.eq_ignore_ascii_case(part))
    }) {
        parts.pop();
    }
    parts.join(" ").trim().to_string()
}

#[tauri::command]
fn window_minimize(window: Window) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_toggle_maximize(window: Window) -> Result<bool, String> {
    if window.is_maximized().map_err(|error| error.to_string())? {
        window.unmaximize().map_err(|error| error.to_string())?;
        Ok(false)
    } else {
        window.maximize().map_err(|error| error.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
async fn window_close(window: Window) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || window.close())
        .await
        .map_err(|_| "WINDOW_CLOSE_FAILED".to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn window_is_maximized(window: Window) -> Result<bool, String> {
    window.is_maximized().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_get_position(window: Window) -> Result<(f64, f64), String> {
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    Ok((
        f64::from(position.x) / scale_factor,
        f64::from(position.y) / scale_factor,
    ))
}

#[tauri::command]
fn window_move_to(x: f64, y: f64, window: Window) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("PLUGIN_INVALID_ARGUMENT".to_string());
    }
    window
        .set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn window_report_activity(state: State<ActivityState>) -> Result<(), String> {
    let mut last_activity = state
        .last_activity
        .lock()
        .map_err(|_| "ACTIVITY_STATE_POISONED".to_string())?;
    *last_activity = Some(SystemTime::now());
    Ok(())
}

#[tauri::command]
fn sql_exec(request: SqlQueryRequest, state: State<'_, DatabaseState>) -> Result<(), String> {
    let params = normalize_sql_request(&request)?;
    if !params.is_empty() {
        return Err("SQL_EXEC_DOES_NOT_ACCEPT_PARAMS".to_string());
    }
    state
        .connection
        .lock()
        .map_err(|_| "database-state-poisoned".to_string())?
        .execute_batch(&request.sql)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn sql_run(
    request: SqlQueryRequest,
    state: State<'_, DatabaseState>,
) -> Result<SqlRunResult, String> {
    let params = normalize_sql_request(&request)?;
    let connection = state
        .connection
        .lock()
        .map_err(|_| "database-state-poisoned".to_string())?;
    let changes = connection
        .execute(&request.sql, params_from_iter(params.iter()))
        .map_err(|error| error.to_string())?;
    Ok(SqlRunResult {
        changes: changes as u64,
        last_insert_rowid: connection.last_insert_rowid(),
    })
}

#[tauri::command]
fn sql_get(
    request: SqlQueryRequest,
    state: State<'_, DatabaseState>,
) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
    let params = normalize_sql_request(&request)?;
    let connection = state
        .connection
        .lock()
        .map_err(|_| "database-state-poisoned".to_string())?;
    let mut statement = connection
        .prepare(&request.sql)
        .map_err(|error| error.to_string())?;
    let mut rows = statement
        .query(params_from_iter(params.iter()))
        .map_err(|error| error.to_string())?;
    rows.next()
        .map_err(|error| error.to_string())?
        .map(|row| sql_row_to_json(row).map_err(|error| error.to_string()))
        .transpose()
}

#[tauri::command]
fn sql_all(
    request: SqlQueryRequest,
    state: State<'_, DatabaseState>,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    let params = normalize_sql_request(&request)?;
    let connection = state
        .connection
        .lock()
        .map_err(|_| "database-state-poisoned".to_string())?;
    let mut statement = connection
        .prepare(&request.sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params_from_iter(params.iter()), sql_row_to_json)
        .map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string()))
        .collect()
}

#[derive(Debug, Deserialize)]
struct AppSettingRequest {
    key: String,
    value: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiConfigurationRecord {
    id: String,
    name: String,
    enabled: bool,
    has_connected_model: bool,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAiConfigurationRequest {
    name: String,
    enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiModelRecord {
    id: String,
    name: String,
    group_name: String,
    endpoint_type: String,
    connection_succeeded: bool,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiConnectedModelRecord {
    configuration_id: String,
    configuration_name: String,
    id: String,
    name: String,
    group_name: String,
    endpoint_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAiModelRequest {
    id: String,
    name: String,
    group_name: String,
    endpoint_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAiModelRequest {
    original_id: String,
    id: String,
    name: String,
    group_name: String,
    endpoint_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiConnectionSettingsRecord {
    api_endpoint: String,
    api_key: String,
    has_api_key: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAiConnectionSettingsRequest {
    api_endpoint: String,
    api_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiChatBridgeStartRequest {
    session_id: String,
    request: AiChatBridgeRequest,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiChatBridgeRequest {
    model: AiChatBridgeModel,
    messages: Vec<AiChatBridgeMessage>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiChatBridgeModel {
    id: String,
    endpoint_type: String,
    api_endpoint: String,
    api_key: String,
}

#[derive(Debug, Clone, Deserialize)]
struct AiChatBridgeMessage {
    role: String,
    content: String,
    name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiChatBridgeError {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum AiChatBridgeEvent {
    Delta {
        session_id: String,
        text: String,
    },
    Usage {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        input_tokens: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        output_tokens: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total_tokens: Option<u64>,
    },
    Completed {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        finish_reason: Option<String>,
    },
    Cancelled {
        session_id: String,
    },
    Error {
        session_id: String,
        error: AiChatBridgeError,
    },
}

#[derive(Clone, Default)]
struct AiChatState {
    runs: Arc<Mutex<HashMap<String, AiChatRunControl>>>,
}

#[derive(Clone)]
struct AiChatRunControl {
    cancelled: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl AiChatRunControl {
    fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            paused: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
        }
    }
}

#[derive(Debug)]
enum AiProviderEvent {
    Delta(String),
    Usage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        total_tokens: Option<u64>,
    },
    Completed(Option<String>),
}

#[cfg(all(test, windows))]
fn credential_entry(configuration_id: &str) -> Result<keyring::Entry, String> {
    ai_credentials::entry(configuration_id)
}

fn normalize_ai_endpoint(value: &str) -> Result<String, String> {
    let endpoint = value.trim();
    if endpoint.len() > 2048 {
        return Err("AI_CONNECTION_ENDPOINT_TOO_LONG".to_string());
    }
    if endpoint.is_empty() {
        return Ok(String::new());
    }
    let parsed =
        reqwest::Url::parse(endpoint).map_err(|_| "AI_CONNECTION_ENDPOINT_INVALID".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("AI_CONNECTION_ENDPOINT_INVALID".to_string());
    }
    Ok(endpoint.trim_end_matches('/').to_string())
}

fn normalize_ai_key(value: &str) -> Result<String, String> {
    let key = value.trim();
    if key.len() > 4096 {
        return Err("AI_CONNECTION_API_KEY_TOO_LONG".to_string());
    }
    Ok(key.to_string())
}

fn normalize_ai_text(value: &str, field: &str, required: bool) -> Result<String, String> {
    let normalized = value.trim();
    if required && normalized.is_empty() {
        return Err(format!("AI_MODEL_{field}_REQUIRED"));
    }
    if normalized.len() > 256 {
        return Err(format!("AI_MODEL_{field}_TOO_LONG"));
    }
    Ok(normalized.to_string())
}

fn normalize_ai_configuration_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    if name.is_empty() {
        return Err("AI_CONFIGURATION_NAME_INVALID".to_string());
    }
    if name.chars().count() > 11 {
        return Err("AI_CONFIGURATION_NAME_TOO_LONG".to_string());
    }
    Ok(name.to_string())
}

fn validate_ai_endpoint(value: &str) -> Result<String, String> {
    if matches!(value, "openai" | "openai-response" | "anthropic" | "gemini") {
        Ok(value.to_string())
    } else {
        Err("AI_MODEL_ENDPOINT_TYPE_INVALID".to_string())
    }
}

fn read_ai_configuration(
    row: &rusqlite::Row<'_>,
) -> Result<AiConfigurationRecord, rusqlite::Error> {
    Ok(AiConfigurationRecord {
        id: row.get("id")?,
        name: row.get("name")?,
        enabled: row.get::<_, i64>("enabled")? == 1,
        has_connected_model: row.get::<_, i64>("has_connected_model")? == 1,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn list_ai_configurations(
    connection: &Connection,
) -> Result<Vec<AiConfigurationRecord>, rusqlite::Error> {
    let mut statement = connection.prepare("SELECT configurations.id, configurations.name, configurations.enabled, EXISTS (SELECT 1 FROM ai_models AS models WHERE models.configuration_id = configurations.id AND models.connection_succeeded = 1) AS has_connected_model, configurations.created_at, configurations.updated_at FROM ai_configurations AS configurations ORDER BY configurations.created_at, configurations.id")?;
    let rows = statement.query_map([], read_ai_configuration)?.collect();
    rows
}

fn list_connected_models(
    connection: &Connection,
) -> Result<Vec<AiConnectedModelRecord>, rusqlite::Error> {
    let mut statement = connection.prepare("SELECT configurations.id AS configuration_id, configurations.name AS configuration_name, models.id, models.name, models.group_name, models.endpoint_type FROM ai_models AS models JOIN ai_configurations AS configurations ON configurations.id = models.configuration_id WHERE configurations.enabled = 1 AND models.connection_succeeded = 1 ORDER BY configurations.name, models.group_name, models.name, models.id")?;
    let rows = statement
        .query_map([], |row| {
            Ok(AiConnectedModelRecord {
                configuration_id: row.get("configuration_id")?,
                configuration_name: row.get("configuration_name")?,
                id: row.get("id")?,
                name: row.get("name")?,
                group_name: row.get("group_name")?,
                endpoint_type: row.get("endpoint_type")?,
            })
        })?
        .collect();
    rows
}

fn validate_setting_key(key: &str) -> Result<(), String> {
    const KEYS: [&str; 7] = [
        "wstudio.theme.activeThemeId",
        "wstudio.appearance.modernUiEnabled",
        "wstudio.note-property-types.v1",
        "wstudio.inline-chat.selected-model",
        "wstudio.shortcuts.bindings.v1",
        "wstudio.editor.font-families.v1",
        "wstudio.editor.font-size.v1",
    ];
    if KEYS.contains(&key) {
        Ok(())
    } else {
        Err("APP_SETTING_KEY_INVALID".to_string())
    }
}

#[tauri::command]
fn app_settings_get(
    key: String,
    state: State<'_, DatabaseState>,
) -> Result<Option<String>, String> {
    validate_setting_key(&key)?;
    let connection = state
        .connection
        .lock()
        .map_err(|_| "database-state-poisoned".to_string())?;
    connection
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [&key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn app_settings_set(
    request: AppSettingRequest,
    app: AppHandle,
    state: State<'_, DatabaseState>,
) -> Result<(), String> {
    validate_setting_key(&request.key)?;
    let value = request
        .value
        .ok_or_else(|| "APP_SETTING_VALUE_INVALID".to_string())?;
    if value.len() > 1024 * 1024 {
        return Err("APP_SETTING_VALUE_INVALID".to_string());
    }
    state.connection.lock().map_err(|_| "database-state-poisoned".to_string())?
        .execute("INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", (&request.key, &value, chrono_like_now())).map_err(|error| error.to_string())?;
    app.emit(
        "appSettings:changed",
        serde_json::json!({ "key": request.key, "value": value }),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn app_settings_remove(
    key: String,
    app: AppHandle,
    state: State<'_, DatabaseState>,
) -> Result<(), String> {
    validate_setting_key(&key)?;
    state
        .connection
        .lock()
        .map_err(|_| "database-state-poisoned".to_string())?
        .execute("DELETE FROM app_settings WHERE key = ?1", [&key])
        .map_err(|error| error.to_string())?;
    app.emit(
        "appSettings:changed",
        serde_json::json!({ "key": key, "value": serde_json::Value::Null }),
    )
    .map_err(|error| error.to_string())
}

fn chrono_like_now() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn initialize_database(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS app_settings_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
             INSERT OR IGNORE INTO app_settings_migrations (version, applied_at) VALUES (1, 0);
             CREATE TABLE IF NOT EXISTS ai_configurations (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)), api_endpoint TEXT NOT NULL DEFAULT '', encrypted_api_key TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS ai_credential_recovery (configuration_id TEXT PRIMARY KEY, had_original INTEGER NOT NULL CHECK (had_original IN (0, 1)), finalized INTEGER NOT NULL DEFAULT 0 CHECK (finalized IN (0, 1)));
             INSERT OR IGNORE INTO ai_configurations (id, name, enabled, api_endpoint, encrypted_api_key, created_at, updated_at) VALUES ('default', 'WsDefault', 1, '', '', 0, 0);",
        )
        .map_err(|error| error.to_string())?;

    let model_columns: Vec<String> = {
        let mut statement = connection
            .prepare("PRAGMA table_info(ai_models)")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    if model_columns.contains(&"id".to_string())
        && !model_columns.contains(&"configuration_id".to_string())
    {
        connection
            .execute_batch(
                "ALTER TABLE ai_models RENAME TO ai_models_legacy;
                 CREATE TABLE ai_models (configuration_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', group_name TEXT NOT NULL DEFAULT '', endpoint_type TEXT NOT NULL CHECK (endpoint_type IN ('openai', 'openai-response', 'anthropic', 'gemini')), connection_succeeded INTEGER NOT NULL DEFAULT 0 CHECK (connection_succeeded IN (0, 1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (configuration_id, id), FOREIGN KEY (configuration_id) REFERENCES ai_configurations(id) ON DELETE CASCADE);
                 INSERT INTO ai_models (configuration_id, id, name, group_name, endpoint_type, created_at, updated_at) SELECT 'default', id, name, group_name, endpoint_type, created_at, updated_at FROM ai_models_legacy;
                 DROP TABLE ai_models_legacy;",
            )
            .map_err(|error| error.to_string())?;
    } else if model_columns.is_empty() {
        connection
            .execute_batch(
                "CREATE TABLE ai_models (configuration_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', group_name TEXT NOT NULL DEFAULT '', endpoint_type TEXT NOT NULL CHECK (endpoint_type IN ('openai', 'openai-response', 'anthropic', 'gemini')), connection_succeeded INTEGER NOT NULL DEFAULT 0 CHECK (connection_succeeded IN (0, 1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (configuration_id, id), FOREIGN KEY (configuration_id) REFERENCES ai_configurations(id) ON DELETE CASCADE);",
            )
            .map_err(|error| error.to_string())?;
    } else if !model_columns.contains(&"connection_succeeded".to_string()) {
        connection
            .execute_batch("ALTER TABLE ai_models ADD COLUMN connection_succeeded INTEGER NOT NULL DEFAULT 0 CHECK (connection_succeeded IN (0, 1));")
            .map_err(|error| error.to_string())?;
    }

    let has_connection_settings: bool = connection
        .query_row("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_connection_settings')", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if has_connection_settings {
        connection
            .execute_batch("UPDATE ai_configurations SET api_endpoint = COALESCE((SELECT api_endpoint FROM ai_connection_settings WHERE singleton = 1), ''), encrypted_api_key = COALESCE((SELECT encrypted_api_key FROM ai_connection_settings WHERE singleton = 1), '') WHERE id = 'default'; DROP TABLE ai_connection_settings;")
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn ai_configurations_list(
    state: State<'_, DatabaseState>,
) -> Result<Vec<AiConfigurationRecord>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "database-state-poisoned".to_string())?;
    list_ai_configurations(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn ai_configurations_create(
    app: AppHandle,
    state: State<'_, DatabaseState>,
) -> Result<AiConfigurationRecord, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "database-state-poisoned".to_string())?;
    let existing: Vec<String> = {
        let mut statement = connection
            .prepare("SELECT name FROM ai_configurations")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let mut number = 1;
    let name = loop {
        let candidate = format!("配置{number}");
        if !existing
            .iter()
            .any(|value| value.eq_ignore_ascii_case(&candidate))
        {
            break candidate;
        }
        number += 1;
    };
    let now = chrono_like_now();
    let id = Uuid::new_v4().to_string();
    connection.execute("INSERT INTO ai_configurations (id, name, enabled, api_endpoint, encrypted_api_key, created_at, updated_at) VALUES (?1, ?2, 1, '', '', ?3, ?3)", (&id, &name, now)).map_err(|error| error.to_string())?;
    let configuration = list_ai_configurations(&connection)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "AI_CONFIGURATION_NOT_FOUND".to_string())?;
    app.emit(
        "aiConfigurations:changed",
        list_ai_configurations(&connection).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(configuration)
}

#[tauri::command]
fn ai_configurations_delete(
    configuration_id: String,
    app: AppHandle,
    state: State<'_, DatabaseState>,
) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "database-state-poisoned".to_string())?;
    ai_credentials::delete_configuration(&connection, &configuration_id)?;
    app.emit(
        "aiConfigurations:changed",
        list_ai_configurations(&connection).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn ai_configurations_update(
    configuration_id: String,
    request: UpdateAiConfigurationRequest,
    app: AppHandle,
    state: State<'_, DatabaseState>,
) -> Result<AiConfigurationRecord, String> {
    let name = normalize_ai_configuration_name(&request.name)?;
    let connection = state
        .connection
        .lock()
        .map_err(|_| "database-state-poisoned".to_string())?;
    let duplicate: Option<String> = connection
        .query_row(
            "SELECT id FROM ai_configurations WHERE name = ?1 COLLATE NOCASE AND id <> ?2",
            (&name, &configuration_id),
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if duplicate.is_some() {
        return Err("AI_CONFIGURATION_NAME_EXISTS".to_string());
    }
    let now = chrono_like_now();
    let changed = connection
        .execute(
            "UPDATE ai_configurations SET name = ?1, enabled = ?2, updated_at = ?3 WHERE id = ?4",
            (
                &name,
                if request.enabled { 1 } else { 0 },
                now,
                &configuration_id,
            ),
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("AI_CONFIGURATION_NOT_FOUND".to_string());
    }
    let configuration = list_ai_configurations(&connection)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|item| item.id == configuration_id)
        .ok_or_else(|| "AI_CONFIGURATION_NOT_FOUND".to_string())?;
    app.emit(
        "aiConfigurations:changed",
        list_ai_configurations(&connection).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(configuration)
}

#[tauri::command]
fn ai_models_list(
    configuration_id: String,
    state: State<'_, DatabaseState>,
) -> Result<Vec<AiModelRecord>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "database-state-poisoned".to_string())?;
    let mut statement = connection.prepare("SELECT id, name, group_name, endpoint_type, connection_succeeded, created_at, updated_at FROM ai_models WHERE configuration_id = ?1 ORDER BY group_name, name, id").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([configuration_id], |row| {
            Ok(AiModelRecord {
                id: row.get("id")?,
                name: row.get("name")?,
                group_name: row.get("group_name")?,
                endpoint_type: row.get("endpoint_type")?,
                connection_succeeded: row.get::<_, i64>("connection_succeeded")? == 1,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string());
    rows
}

#[tauri::command]
fn ai_models_list_connected(
    state: State<'_, DatabaseState>,
) -> Result<Vec<AiConnectedModelRecord>, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "database-state-poisoned".to_string())?;
    list_connected_models(&connection).map_err(|error| error.to_string())
}

#[tauri::command]
fn ai_models_create(
    configuration_id: String,
    request: CreateAiModelRequest,
    state: State<'_, DatabaseState>,
) -> Result<AiModelRecord, String> {
    let id = normalize_ai_text(&request.id, "ID", true)?;
    let name = normalize_ai_text(&request.name, "NAME", false)?;
    let group_name = normalize_ai_text(&request.group_name, "GROUP_NAME", false)?;
    let endpoint_type = validate_ai_endpoint(&request.endpoint_type)?;
    let connection = state
        .connection
        .lock()
        .map_err(|_| "database-state-poisoned".to_string())?;
    let now = chrono_like_now();
    let changed = connection.execute("INSERT INTO ai_models (configuration_id, id, name, group_name, endpoint_type, connection_succeeded, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6) ON CONFLICT(configuration_id, id) DO NOTHING", (&configuration_id, &id, &name, &group_name, &endpoint_type, now)).map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("AI_MODEL_ID_EXISTS".to_string());
    }
    Ok(AiModelRecord {
        id,
        name,
        group_name,
        endpoint_type,
        connection_succeeded: false,
        created_at: now,
        updated_at: now,
    })
}

#[tauri::command]
fn ai_models_update(
    configuration_id: String,
    request: UpdateAiModelRequest,
    state: State<'_, DatabaseState>,
) -> Result<AiModelRecord, String> {
    let original_id = normalize_ai_text(&request.original_id, "ORIGINAL_ID", true)?;
    let id = normalize_ai_text(&request.id, "ID", true)?;
    let name = normalize_ai_text(&request.name, "NAME", false)?;
    let group_name = normalize_ai_text(&request.group_name, "GROUP_NAME", false)?;
    let endpoint_type = validate_ai_endpoint(&request.endpoint_type)?;
    let connection = state
        .connection
        .lock()
        .map_err(|_| "database-state-poisoned".to_string())?;
    let previous: Option<(i64, i64)> = connection
        .query_row(
            "SELECT created_at, connection_succeeded FROM ai_models WHERE configuration_id = ?1 AND id = ?2",
            (&configuration_id, &original_id),
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((created_at, connection_succeeded)) = previous else {
        return Err("AI_MODEL_NOT_FOUND".to_string());
    };
    let now = chrono_like_now();
    let changed = connection.execute("UPDATE ai_models SET id = ?1, name = ?2, group_name = ?3, endpoint_type = ?4, updated_at = ?5 WHERE configuration_id = ?6 AND id = ?7", (&id, &name, &group_name, &endpoint_type, now, &configuration_id, &original_id)).map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("AI_MODEL_NOT_FOUND".to_string());
    }
    Ok(AiModelRecord {
        id,
        name,
        group_name,
        endpoint_type,
        connection_succeeded: connection_succeeded == 1,
        created_at,
        updated_at: now,
    })
}

#[tauri::command]
fn ai_models_delete(
    configuration_id: String,
    model_id: String,
    state: State<'_, DatabaseState>,
) -> Result<(), String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "database-state-poisoned".to_string())?;
    let changed = connection
        .execute(
            "DELETE FROM ai_models WHERE configuration_id = ?1 AND id = ?2",
            (&configuration_id, &model_id),
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("AI_MODEL_NOT_FOUND".to_string());
    }
    Ok(())
}

#[tauri::command]
fn ai_connection_get_settings(
    configuration_id: String,
    app: AppHandle,
    state: State<'_, DatabaseState>,
) -> Result<AiConnectionSettingsRecord, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "database-state-poisoned".to_string())?;
    let (api_endpoint, api_key) = ai_credentials::read_snapshot(
        &connection,
        &configuration_id,
        resolve_legacy_user_data_root(&app).as_deref(),
        |transaction| {
            transaction
                .query_row(
                    "SELECT api_endpoint FROM ai_configurations WHERE id = ?1",
                    [&configuration_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|_| "AI_CONNECTION_SETTINGS_READ_FAILED".to_string())
        },
    )?;
    Ok(AiConnectionSettingsRecord {
        api_endpoint,
        has_api_key: !api_key.is_empty(),
        api_key,
    })
}

#[tauri::command]
fn ai_connection_update_settings(
    configuration_id: String,
    request: UpdateAiConnectionSettingsRequest,
    app: AppHandle,
    state: State<'_, DatabaseState>,
) -> Result<AiConnectionSettingsRecord, String> {
    let api_endpoint = normalize_ai_endpoint(&request.api_endpoint)?;
    let api_key = request
        .api_key
        .as_deref()
        .map(normalize_ai_key)
        .transpose()?;
    {
        let connection = state
            .connection
            .lock()
            .map_err(|_| "database-state-poisoned".to_string())?;
        ai_credentials::update_settings(
            &connection,
            &configuration_id,
            &api_endpoint,
            api_key.as_deref(),
        )?;
    }
    ai_connection_get_settings(configuration_id, app, state)
}

#[tauri::command]
async fn ai_connection_test_model(
    configuration_id: String,
    model_id: String,
    app: AppHandle,
    state: State<'_, DatabaseState>,
) -> Result<serde_json::Value, String> {
    let ((model_name, group_name, endpoint_type, api_endpoint, configuration_name), api_key) = {
        let connection = state
            .connection
            .lock()
            .map_err(|_| "database-state-poisoned".to_string())?;
        ai_credentials::read_snapshot(
            &connection,
            &configuration_id,
            resolve_legacy_user_data_root(&app).as_deref(),
            |transaction| {
                transaction.query_row(
            "SELECT models.name, models.group_name, models.endpoint_type, configurations.api_endpoint, configurations.name FROM ai_models AS models JOIN ai_configurations AS configurations ON configurations.id = models.configuration_id WHERE models.configuration_id = ?1 AND models.id = ?2",
            (&configuration_id, &model_id),
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?)),
        ).optional().map_err(|_| "AI_CONNECTION_SETTINGS_READ_FAILED".to_string())?
            .ok_or_else(|| "AI_MODEL_NOT_FOUND".to_string())
            },
        )?
    };
    let normalized_endpoint = normalize_ai_endpoint(&api_endpoint)?;
    if normalized_endpoint.is_empty() || api_key.is_empty() {
        return Err("AI_CONNECTION_SETTINGS_INCOMPLETE".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| "AI_CONNECTION_TEST_FAILED".to_string())?;
    let (protocol, request) = match endpoint_type.as_str() {
        "openai" => {
            let url = append_ai_chat_path(&normalized_endpoint, "/chat/completions")?;
            let response = client
                .post(url)
                .bearer_auth(api_key)
                .json(&serde_json::json!({
                    "model": model_id,
                    "messages": [{"role": "user", "content": "Reply with OK."}],
                    "max_tokens": 1
                }))
                .send()
                .await;
            ("openai", response)
        }
        "openai-response" => {
            let url = append_ai_chat_path(&normalized_endpoint, "/responses")?;
            let response = client
                .post(url)
                .bearer_auth(api_key)
                .json(&serde_json::json!({
                    "model": model_id,
                    "input": [{"role": "user", "content": "Reply with OK."}]
                }))
                .send()
                .await;
            ("openai-response", response)
        }
        "anthropic" => {
            let url = append_ai_chat_path(&normalized_endpoint, "/messages")?;
            let response = client
                .post(url)
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&serde_json::json!({
                    "model": model_id,
                    "max_tokens": 1,
                    "messages": [{"role": "user", "content": "Reply with OK."}]
                }))
                .send()
                .await;
            ("anthropic", response)
        }
        "gemini" => {
            let (url, headers, body) = build_gemini_content_request(
                &AiChatBridgeRequest {
                    model: AiChatBridgeModel {
                        id: model_id.clone(),
                        endpoint_type: "gemini".into(),
                        api_endpoint: normalized_endpoint.clone(),
                        api_key,
                    },
                    messages: vec![AiChatBridgeMessage {
                        role: "user".into(),
                        content: "Reply with OK.".into(),
                        name: None,
                    }],
                    temperature: None,
                    max_tokens: Some(1),
                },
                false,
            )?;
            let response = client
                .post(url)
                .header(headers[0].0, &headers[0].1)
                .json(&body)
                .send()
                .await;
            ("gemini", response)
        }
        _ => return Err("AI_MODEL_ENDPOINT_TYPE_INVALID".to_string()),
    };
    // A provider website can return HTTP 200; only a matching API response is a successful test.
    let success = match request {
        Ok(response) if response.status().is_success() => response
            .json::<serde_json::Value>()
            .await
            .map(|payload| is_ai_connection_response(protocol, &payload))
            .unwrap_or(false),
        _ => false,
    };
    let connection = state
        .connection
        .lock()
        .map_err(|_| "database-state-poisoned".to_string())?;
    save_ai_connection_test_result(
        &connection,
        &configuration_id,
        &model_id,
        success,
        |models| {
            app.emit("aiModels:connectedChanged", models)
                .map_err(|error| error.to_string())
        },
    )?;
    if success {
        Ok(
            serde_json::json!({"success": true, "message": "连接成功", "model": {
                "configurationId": configuration_id,
            "configurationName": configuration_name,
                "id": model_id,
                "name": model_name,
            "groupName": group_name,
                "endpointType": endpoint_type
            }}),
        )
    } else {
        Ok(serde_json::json!({"success": false, "message": "连接失败"}))
    }
}

#[tauri::command]
fn ai_connection_cancel_test(_configuration_id: String) {}

/// Persist a connection result before notifying every window of its available models.
fn save_ai_connection_test_result(
    connection: &Connection,
    configuration_id: &str,
    model_id: &str,
    success: bool,
    publish: impl FnOnce(Vec<AiConnectedModelRecord>) -> Result<(), String>,
) -> Result<(), String> {
    connection.execute(
        "UPDATE ai_models SET connection_succeeded = ?1, updated_at = ?2 WHERE configuration_id = ?3 AND id = ?4",
        (if success { 1 } else { 0 }, chrono_like_now(), configuration_id, model_id),
    ).map_err(|error| error.to_string())?;
    publish(list_connected_models(connection).map_err(|error| error.to_string())?)
}

/// Verify the protocol's response envelope instead of trusting the HTTP status alone.
fn is_ai_connection_response(protocol: &str, payload: &serde_json::Value) -> bool {
    if payload.get("error").is_some() {
        return false;
    }
    match protocol {
        "openai" => payload
            .get("choices")
            .and_then(|value| value.get(0))
            .and_then(|value| value.get("message"))
            .is_some_and(serde_json::Value::is_object),
        "openai-response" => payload
            .get("output")
            .is_some_and(serde_json::Value::is_array),
        "anthropic" => payload
            .get("content")
            .is_some_and(serde_json::Value::is_array),
        "gemini" => payload
            .get("candidates")
            .is_some_and(serde_json::Value::is_array),
        _ => false,
    }
}

#[tauri::command]
fn ai_chat_start(
    request: AiChatBridgeStartRequest,
    app: AppHandle,
    state: State<'_, AiChatState>,
) -> Result<(), String> {
    validate_ai_chat_request(&request)?;
    let session_id = request.session_id.trim().to_string();
    let control = AiChatRunControl::new();
    {
        let mut runs = state
            .runs
            .lock()
            .map_err(|_| "AI_CHAT_STATE_POISONED".to_string())?;
        if runs.contains_key(&session_id) {
            return Err("AI_CHAT_SESSION_BUSY".to_string());
        }
        runs.insert(session_id.clone(), control.clone());
    }
    let runs = state.runs.clone();
    tauri::async_runtime::spawn(async move {
        execute_ai_chat(app, session_id.clone(), request.request, control).await;
        if let Ok(mut active) = runs.lock() {
            active.remove(&session_id);
        }
    });
    Ok(())
}

#[tauri::command]
fn ai_chat_pause(session_id: String, state: State<'_, AiChatState>) -> Result<(), String> {
    if let Some(control) = state
        .runs
        .lock()
        .map_err(|_| "AI_CHAT_STATE_POISONED".to_string())?
        .get(session_id.trim())
        .cloned()
    {
        control.paused.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
fn ai_chat_resume(session_id: String, state: State<'_, AiChatState>) -> Result<(), String> {
    if let Some(control) = state
        .runs
        .lock()
        .map_err(|_| "AI_CHAT_STATE_POISONED".to_string())?
        .get(session_id.trim())
        .cloned()
    {
        control.paused.store(false, Ordering::Release);
        control.notify.notify_waiters();
    }
    Ok(())
}

#[tauri::command]
fn ai_chat_cancel(session_id: String, state: State<'_, AiChatState>) -> Result<(), String> {
    if let Some(control) = state
        .runs
        .lock()
        .map_err(|_| "AI_CHAT_STATE_POISONED".to_string())?
        .get(session_id.trim())
        .cloned()
    {
        control.cancelled.store(true, Ordering::Release);
        control.notify.notify_waiters();
    }
    Ok(())
}

fn validate_ai_chat_request(request: &AiChatBridgeStartRequest) -> Result<(), String> {
    if request.session_id.trim().is_empty() || request.session_id.len() > 256 {
        return Err("AI_CHAT_SESSION_INVALID".to_string());
    }
    let model = &request.request.model;
    if model.id.trim().is_empty()
        || model.api_key.trim().is_empty()
        || model.api_endpoint.trim().is_empty()
        || !matches!(
            model.endpoint_type.as_str(),
            "openai" | "openai-response" | "anthropic" | "gemini"
        )
    {
        return Err("AI_CHAT_MODEL_INVALID".to_string());
    }
    if request.request.messages.is_empty() || request.request.messages.len() > 512 {
        return Err("AI_CHAT_MESSAGES_INVALID".to_string());
    }
    if request.request.messages.iter().any(|message| {
        message.content.len() > 1_000_000
            || !matches!(
                message.role.as_str(),
                "system" | "user" | "assistant" | "tool"
            )
    }) {
        return Err("AI_CHAT_MESSAGE_INVALID".to_string());
    }
    Ok(())
}

async fn execute_ai_chat(
    app: AppHandle,
    session_id: String,
    request: AiChatBridgeRequest,
    control: AiChatRunControl,
) {
    let result = run_ai_provider(&session_id, &request, &control, |event| {
        emit_ai_chat(&app, event)
    })
    .await;
    if control.cancelled.load(Ordering::Acquire) {
        emit_ai_chat(&app, AiChatBridgeEvent::Cancelled { session_id });
        return;
    }
    match result {
        Ok(finish_reason) => emit_ai_chat(
            &app,
            AiChatBridgeEvent::Completed {
                session_id,
                finish_reason,
            },
        ),
        Err((code, message, status)) => emit_ai_chat(
            &app,
            AiChatBridgeEvent::Error {
                session_id,
                error: AiChatBridgeError {
                    code: code.to_string(),
                    message,
                    status,
                },
            },
        ),
    }
}

fn emit_ai_chat(app: &AppHandle, event: AiChatBridgeEvent) {
    let _ = app.emit("aiChat:event", event);
}

/// Streams provider events until the AI protocol ends, independently of HTTP teardown.
async fn run_ai_provider(
    session_id: &str,
    request: &AiChatBridgeRequest,
    control: &AiChatRunControl,
    mut emit: impl FnMut(AiChatBridgeEvent),
) -> Result<Option<String>, (&'static str, String, Option<u16>)> {
    let (url, headers, body) =
        build_ai_chat_request(request).map_err(|message| ("INVALID_REQUEST", message, None))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|_| ("NETWORK", "AI provider request failed".to_string(), None))?;
    let response = send_ai_provider_request(&client, &url, &headers, &body, control).await?;
    let status = response.status();
    if !status.is_success() {
        return Err((
            "HTTP",
            "AI provider request failed".to_string(),
            Some(status.as_u16()),
        ));
    }
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut event_name = String::new();
    let mut data_lines: Vec<String> = Vec::new();
    let mut finish_reason = None;
    let mut received_text = false;
    'stream: while let Some(chunk) = tokio::select! {
        value = stream.next() => value,
        _ = control.notify.notified(), if control.cancelled.load(Ordering::Acquire) => None,
    } {
        let bytes = chunk.map_err(|error| {
            if error.is_timeout() {
                ("TIMEOUT", "AI provider stream timed out".to_string(), None)
            } else {
                ("NETWORK", "AI provider stream failed".to_string(), None)
            }
        })?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(index) = buffer.find('\n') {
            let mut line = buffer.drain(..=index).collect::<String>();
            line = line.trim_end_matches(['\r', '\n']).to_string();
            if line.is_empty() {
                if !data_lines.is_empty() {
                    let data = data_lines.join("\n");
                    let events =
                        parse_ai_provider_event(&request.model.endpoint_type, &event_name, &data)
                            .map_err(|message| ("PROTOCOL", message, None))?;
                    // OpenAI may send usage after finish_reason. DONE ends the stream;
                    // the other protocols expose a terminal message/response event.
                    let stream_ended = events
                        .iter()
                        .any(|event| matches!(event, AiProviderEvent::Completed(_)))
                        && (request.model.endpoint_type != "openai" || data.trim() == "[DONE]");
                    for event in events {
                        wait_ai_chat_if_paused(control).await;
                        if control.cancelled.load(Ordering::Acquire) {
                            return Ok(finish_reason);
                        }
                        match event {
                            AiProviderEvent::Delta(text) => {
                                received_text = true;
                                emit(AiChatBridgeEvent::Delta {
                                    session_id: session_id.to_string(),
                                    text,
                                });
                            }
                            AiProviderEvent::Usage {
                                input_tokens,
                                output_tokens,
                                total_tokens,
                            } => emit(AiChatBridgeEvent::Usage {
                                session_id: session_id.to_string(),
                                input_tokens,
                                output_tokens,
                                total_tokens,
                            }),
                            AiProviderEvent::Completed(reason) => {
                                finish_reason = reason.or(finish_reason)
                            }
                        }
                    }
                    if stream_ended {
                        buffer.clear();
                        data_lines.clear();
                        break 'stream;
                    }
                }
                event_name.clear();
                data_lines.clear();
            } else if let Some(value) = line.strip_prefix("event:") {
                event_name = value.trim().to_string();
            } else if let Some(value) = line.strip_prefix("data:") {
                data_lines.push(value.trim_start().to_string());
            }
        }
    }
    if !buffer.trim().is_empty() {
        data_lines.push(buffer.trim().to_string());
    }
    if !data_lines.is_empty() {
        let data = data_lines.join("\n");
        let events = parse_ai_provider_event(&request.model.endpoint_type, &event_name, &data)
            .map_err(|message| ("PROTOCOL", message, None))?;
        for event in events {
            wait_ai_chat_if_paused(control).await;
            if control.cancelled.load(Ordering::Acquire) {
                return Ok(finish_reason);
            }
            match event {
                AiProviderEvent::Delta(text) => {
                    received_text = true;
                    emit(AiChatBridgeEvent::Delta {
                        session_id: session_id.to_string(),
                        text,
                    });
                }
                AiProviderEvent::Usage {
                    input_tokens,
                    output_tokens,
                    total_tokens,
                } => emit(AiChatBridgeEvent::Usage {
                    session_id: session_id.to_string(),
                    input_tokens,
                    output_tokens,
                    total_tokens,
                }),
                AiProviderEvent::Completed(reason) => finish_reason = reason.or(finish_reason),
            }
        }
    }
    if !received_text && !control.cancelled.load(Ordering::Acquire) {
        return Err((
            "PROTOCOL",
            "服务商未返回回复内容，请检查模型与流式接口配置。".to_string(),
            None,
        ));
    }
    Ok(finish_reason)
}

/// Retries only before a response stream is established, so a partial assistant
/// response is never duplicated. Cancellation interrupts the backoff.
async fn send_ai_provider_request(
    client: &reqwest::Client,
    url: &str,
    headers: &[(&'static str, String)],
    body: &serde_json::Value,
    control: &AiChatRunControl,
) -> Result<reqwest::Response, (&'static str, String, Option<u16>)> {
    let mut attempt = 0usize;
    loop {
        if control.cancelled.load(Ordering::Acquire) {
            return Err((
                "CANCELLED",
                "AI provider request cancelled".to_string(),
                None,
            ));
        }
        let mut builder = client.post(url).json(body);
        for (name, value) in headers {
            builder = builder.header(*name, value);
        }
        let response = match builder.send().await {
            Ok(response) => response,
            Err(_) if attempt < AI_PROVIDER_RETRY_DELAYS_MS.len() => {
                if !wait_ai_provider_retry(AI_PROVIDER_RETRY_DELAYS_MS[attempt], control).await {
                    return Err((
                        "CANCELLED",
                        "AI provider request cancelled".to_string(),
                        None,
                    ));
                }
                attempt += 1;
                continue;
            }
            Err(error) => {
                // Report the stage, never raw request URLs, headers or provider credentials.
                let (code, message) = if error.is_timeout() {
                    ("TIMEOUT", "AI provider request timed out")
                } else if error.is_connect() {
                    ("NETWORK", "AI provider connection failed")
                } else {
                    ("NETWORK", "AI provider disconnected before response")
                };
                return Err((code, message.to_string(), None));
            }
        };
        if response.status().is_success() {
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .split(';')
                .next()
                .unwrap_or("")
                .trim();
            if !content_type.eq_ignore_ascii_case("text/event-stream") {
                return Err((
                    "PROTOCOL",
                    "服务商返回的不是流式 AI 回复，请检查 API 地址与接口类型。".to_string(),
                    Some(response.status().as_u16()),
                ));
            }
            return Ok(response);
        }
        let status = response.status().as_u16();
        if !is_retryable_ai_provider_status(status) || attempt >= AI_PROVIDER_RETRY_DELAYS_MS.len()
        {
            return Err((
                "HTTP",
                "AI provider request failed".to_string(),
                Some(status),
            ));
        }
        drop(response);
        if !wait_ai_provider_retry(AI_PROVIDER_RETRY_DELAYS_MS[attempt], control).await {
            return Err((
                "CANCELLED",
                "AI provider request cancelled".to_string(),
                None,
            ));
        }
        attempt += 1;
    }
}

fn is_retryable_ai_provider_status(status: u16) -> bool {
    matches!(status, 408 | 409 | 425 | 429) || status >= 500
}

async fn wait_ai_provider_retry(delay_ms: u64, control: &AiChatRunControl) -> bool {
    let sleep = tokio::time::sleep(Duration::from_millis(delay_ms));
    tokio::pin!(sleep);
    loop {
        tokio::select! {
            _ = &mut sleep => return true,
            _ = control.notify.notified() => {
                if control.cancelled.load(Ordering::Acquire) {
                    return false;
                }
            }
        }
    }
}

async fn wait_ai_chat_if_paused(control: &AiChatRunControl) {
    while control.paused.load(Ordering::Acquire) && !control.cancelled.load(Ordering::Acquire) {
        control.notify.notified().await;
    }
}

fn build_ai_chat_request(
    request: &AiChatBridgeRequest,
) -> Result<(String, Vec<(&'static str, String)>, serde_json::Value), String> {
    if request.model.endpoint_type == "gemini" {
        return build_gemini_content_request(request, true);
    }
    let endpoint = normalize_ai_endpoint(&request.model.api_endpoint)?;
    let messages: Vec<serde_json::Value> = request
        .messages
        .iter()
        .map(|message| {
            serde_json::json!({
                "role": message.role,
                "content": message.content,
                "name": message.name
            })
        })
        .collect();
    let mut body = serde_json::json!({ "stream": true });
    let (path, headers) = match request.model.endpoint_type.as_str() {
        "openai" => {
            body["model"] = serde_json::Value::String(request.model.id.clone());
            body["messages"] = serde_json::Value::Array(messages);
            (
                "/chat/completions",
                vec![("authorization", format!("Bearer {}", request.model.api_key))],
            )
        }
        "openai-response" => {
            body["model"] = serde_json::Value::String(request.model.id.clone());
            body["input"] = serde_json::Value::Array(messages);
            (
                "/responses",
                vec![("authorization", format!("Bearer {}", request.model.api_key))],
            )
        }
        "anthropic" => {
            body["model"] = serde_json::Value::String(request.model.id.clone());
            body["messages"] = serde_json::Value::Array(messages);
            body["max_tokens"] = serde_json::Value::from(request.max_tokens.unwrap_or(4096));
            (
                "/messages",
                vec![
                    ("x-api-key", request.model.api_key.clone()),
                    ("anthropic-version", "2023-06-01".to_string()),
                ],
            )
        }
        _ => return Err("AI_MODEL_ENDPOINT_TYPE_INVALID".to_string()),
    };
    if let Some(temperature) = request.temperature {
        body["temperature"] = serde_json::Value::from(temperature);
    }
    if let Some(max_tokens) = request.max_tokens {
        body["max_tokens"] = serde_json::Value::from(max_tokens);
    }
    let url = append_ai_chat_path(&endpoint, path)?;
    Ok((url, headers, body))
}

/// Build Gemini native content requests from either an origin, version base or models base.
fn build_gemini_content_request(
    request: &AiChatBridgeRequest,
    streaming: bool,
) -> Result<(String, Vec<(&'static str, String)>, serde_json::Value), String> {
    let mut url = reqwest::Url::parse(&normalize_ai_endpoint(&request.model.api_endpoint)?)
        .map_err(|_| "AI_CONNECTION_ENDPOINT_INVALID".to_string())?;
    let path = url.path().trim_end_matches('/');
    let base = if path.is_empty() {
        "/v1beta/models".to_string()
    } else if path.ends_with("/models") {
        path.to_string()
    } else {
        format!("{path}/models")
    };
    let model = request
        .model
        .id
        .trim()
        .strip_prefix("models/")
        .unwrap_or(request.model.id.trim());
    if model.is_empty() || model.contains(['/', '?', '#', ':']) {
        return Err("AI_MODEL_ID_INVALID".to_string());
    }
    let method = if streaming {
        "streamGenerateContent"
    } else {
        "generateContent"
    };
    url.set_path(&format!("{base}/{model}:{method}"));
    // Credentials belong in the header; preserve unrelated proxy query parameters.
    let parameters: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| key != "key" && key != "alt")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    url.set_query(None);
    if !parameters.is_empty() || streaming {
        let mut query = url.query_pairs_mut();
        query.extend_pairs(parameters);
        if streaming {
            query.append_pair("alt", "sse");
        }
    }
    let mut contents = Vec::new();
    let mut instructions = Vec::new();
    for message in &request.messages {
        let part = serde_json::json!({"text": message.content});
        match message.role.as_str() {
            "system" => instructions.push(part),
            "user" | "assistant" => contents.push(serde_json::json!({
                "role": if message.role == "assistant" { "model" } else { "user" },
                "parts": [part],
            })),
            _ => return Err("AI_CHAT_MESSAGE_ROLE_INVALID".to_string()),
        }
    }
    let mut body = serde_json::json!({"contents": contents});
    if !instructions.is_empty() {
        body["systemInstruction"] = serde_json::json!({"parts": instructions});
    }
    let mut generation = serde_json::Map::new();
    if let Some(value) = request.temperature {
        generation.insert("temperature".into(), value.into());
    }
    if let Some(value) = request.max_tokens {
        generation.insert("maxOutputTokens".into(), value.into());
    }
    if !generation.is_empty() {
        body["generationConfig"] = generation.into();
    }
    Ok((
        url.to_string(),
        vec![("x-goog-api-key", request.model.api_key.clone())],
        body,
    ))
}

fn append_ai_chat_path(endpoint: &str, suffix: &str) -> Result<String, String> {
    let mut parsed =
        reqwest::Url::parse(endpoint).map_err(|_| "AI_CONNECTION_ENDPOINT_INVALID".to_string())?;
    let pathname = parsed.path().trim_end_matches('/').to_string();
    if pathname.ends_with(suffix) {
        return Ok(parsed.to_string());
    }
    // 裸域名使用标准 /v1；用户显式配置的版本、代理前缀和完整接口地址保持原样。
    let base_path = if pathname.is_empty() {
        "/v1"
    } else {
        &pathname
    };
    parsed.set_path(&format!("{base_path}{suffix}"));
    Ok(parsed.to_string())
}

fn parse_ai_provider_event(
    endpoint_type: &str,
    event_name: &str,
    data: &str,
) -> Result<Vec<AiProviderEvent>, String> {
    if data.trim() == "[DONE]" {
        return Ok(vec![AiProviderEvent::Completed(None)]);
    }
    let payload: serde_json::Value =
        serde_json::from_str(data).map_err(|_| "AI provider returned invalid JSON".to_string())?;
    let mut events = Vec::new();
    match endpoint_type {
        "openai" => {
            let choice = payload.get("choices").and_then(|value| value.get(0));
            if let Some(text) = choice
                .and_then(|value| value.get("delta"))
                .and_then(|value| value.get("content"))
                .and_then(serde_json::Value::as_str)
            {
                if !text.is_empty() {
                    events.push(AiProviderEvent::Delta(text.to_string()));
                }
            }
            if let Some(reason) = choice
                .and_then(|value| value.get("finish_reason"))
                .and_then(serde_json::Value::as_str)
            {
                events.push(AiProviderEvent::Completed(Some(reason.to_string())));
            }
            if let Some(usage) = parse_ai_usage(payload.get("usage")) {
                events.push(usage);
            }
        }
        "openai-response" => {
            let kind = if event_name.is_empty() {
                payload
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
            } else {
                event_name
            };
            let text = payload
                .get("delta")
                .or_else(|| payload.get("text"))
                .or_else(|| payload.get("output_text"))
                .and_then(serde_json::Value::as_str);
            if kind.contains("output_text.delta") || kind.is_empty() {
                if let Some(value) = text {
                    if !value.is_empty() {
                        events.push(AiProviderEvent::Delta(value.to_string()));
                    }
                }
            }
            if kind == "response.completed" {
                events.push(AiProviderEvent::Completed(
                    payload
                        .get("finish_reason")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string),
                ));
            }
            if let Some(usage) = parse_ai_usage(payload.get("usage")) {
                events.push(usage);
            }
        }
        "anthropic" => {
            let kind = if event_name.is_empty() {
                payload
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
            } else {
                event_name
            };
            let text = payload
                .get("delta")
                .and_then(|value| value.get("text"))
                .and_then(serde_json::Value::as_str)
                .or_else(|| payload.get("text").and_then(serde_json::Value::as_str));
            if let Some(value) = text {
                if !value.is_empty() {
                    events.push(AiProviderEvent::Delta(value.to_string()));
                }
            }
            if kind == "message_stop" || kind == "message_end" {
                events.push(AiProviderEvent::Completed(None));
            }
            if let Some(usage) = parse_ai_usage(
                payload
                    .get("usage")
                    .or_else(|| payload.get("delta").and_then(|value| value.get("usage"))),
            ) {
                events.push(usage);
            }
        }
        "gemini" => {
            let candidate = payload.get("candidates").and_then(|value| value.get(0));
            if let Some(parts) = candidate
                .and_then(|value| value.get("content"))
                .and_then(|value| value.get("parts"))
                .and_then(serde_json::Value::as_array)
            {
                let text = parts
                    .iter()
                    .filter(|part| {
                        part.get("thought").and_then(serde_json::Value::as_bool) != Some(true)
                    })
                    .filter_map(|part| part.get("text").and_then(serde_json::Value::as_str))
                    .collect::<String>();
                if !text.is_empty() {
                    events.push(AiProviderEvent::Delta(text));
                }
            }
            if let Some(reason) = candidate
                .and_then(|value| value.get("finishReason"))
                .and_then(serde_json::Value::as_str)
            {
                events.push(AiProviderEvent::Completed(Some(reason.to_string())));
            }
            if let Some(usage) = parse_ai_usage(
                payload
                    .get("usageMetadata")
                    .or_else(|| payload.get("usage")),
            ) {
                events.push(usage);
            }
        }
        _ => return Err("AI_MODEL_ENDPOINT_TYPE_INVALID".to_string()),
    }
    Ok(events)
}

fn parse_ai_usage(value: Option<&serde_json::Value>) -> Option<AiProviderEvent> {
    let value = value?.as_object()?;
    let input = value
        .get("prompt_tokens")
        .or_else(|| value.get("input_tokens"))
        .or_else(|| value.get("inputTokenCount"))
        .or_else(|| value.get("promptTokenCount"))
        .and_then(serde_json::Value::as_u64);
    let output = value
        .get("completion_tokens")
        .or_else(|| value.get("output_tokens"))
        .or_else(|| value.get("outputTokenCount"))
        .or_else(|| value.get("candidatesTokenCount"))
        .and_then(serde_json::Value::as_u64);
    let total = value
        .get("total_tokens")
        .or_else(|| value.get("totalTokenCount"))
        .and_then(serde_json::Value::as_u64);
    if input.is_none() && output.is_none() && total.is_none() {
        None
    } else {
        Some(AiProviderEvent::Usage {
            input_tokens: input,
            output_tokens: output,
            total_tokens: total,
        })
    }
}

#[tauri::command]
fn workspace_get_repository(state: State<'_, WorkspaceState>) -> Result<RepositorySummary, String> {
    Ok(repository_summary(&workspace_root(&state)?))
}

#[tauri::command]
fn workspace_open_with_system(
    relative_path: String,
    state: State<'_, WorkspaceState>,
) -> Result<bool, String> {
    let root = workspace_root(&state)?;
    let target = normalize_relative_path(&root, &relative_path).map_err(str::to_string)?;
    if !target.exists() {
        return Ok(false);
    }
    open::that(&target)
        .map(|_| true)
        .map_err(|_| "SYSTEM_OPEN_FAILED".to_string())
}

#[tauri::command]
fn workspace_reveal_in_file_manager(
    relative_path: String,
    state: State<'_, WorkspaceState>,
) -> Result<bool, String> {
    let root = workspace_root(&state)?;
    let target = normalize_relative_path(&root, &relative_path).map_err(str::to_string)?;
    if !target.exists() {
        return Ok(false);
    }
    reveal_path_in_file_manager(&target, &root)
}

#[tauri::command]
fn workspace_copy_path(
    requested_relative_path: String,
    kind: String,
    state: State<'_, WorkspaceState>,
) -> Result<bool, String> {
    let root = workspace_root(&state)?;
    let target =
        normalize_relative_path(&root, &requested_relative_path).map_err(str::to_string)?;
    if !target.exists() {
        return Ok(false);
    }
    let value = match kind.as_str() {
        "absolute" => target.to_string_lossy().into_owned(),
        "repository-root" => root.to_string_lossy().into_owned(),
        "content-root" => relative_path(&root, &target),
        _ => return Err("WORKSPACE_COPY_KIND_INVALID".to_string()),
    };
    let mut clipboard =
        arboard::Clipboard::new().map_err(|_| "CLIPBOARD_UNAVAILABLE".to_string())?;
    clipboard
        .set_text(value)
        .map(|_| true)
        .map_err(|_| "CLIPBOARD_WRITE_FAILED".to_string())
}

#[tauri::command]
fn workspace_list_files(
    state: State<'_, WorkspaceState>,
) -> Result<Vec<WorkspaceFileEntry>, String> {
    let root = workspace_root(&state)?;
    let mut files = Vec::new();
    collect_files(&root, &root, &mut files)?;
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(files)
}

#[tauri::command]
fn workspace_list_markdown_files(
    state: State<'_, WorkspaceState>,
) -> Result<Vec<WorkspaceMarkdownFileMetadata>, String> {
    let root = workspace_root(&state)?;
    let mut files = Vec::new();
    collect_markdown_files(&root, &root, &mut files)?;
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(files)
}

/// Enumerate only manifest-scoped Markdown files while the originating RPC remains active.
fn workspace_list_plugin_markdown_files(
    manifest: &serde_json::Value,
    root: &Path,
    limit: usize,
    check_active: &impl Fn() -> Result<(), String>,
) -> Result<Vec<WorkspaceMarkdownFileMetadata>, String> {
    let mut files = Vec::new();
    collect_scoped_markdown_files(
        &root,
        &root,
        &mut files,
        limit,
        &|relative| plugin_path_has_permission(manifest, "workspace.read", relative),
        check_active,
    )?;
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(files)
}

fn workspace_file_kind(path: &Path) -> Option<(&'static str, Option<&'static str>)> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let text_extensions = [
        "url",
        "txt",
        "text",
        "log",
        "out",
        "md",
        "markdown",
        "mdown",
        "mkdn",
        "mkd",
        "mdwn",
        "rst",
        "adoc",
        "asciidoc",
        "tex",
        "html",
        "htm",
        "xhtml",
        "xml",
        "xsl",
        "xsd",
        "json",
        "jsonc",
        "yaml",
        "yml",
        "toml",
        "ini",
        "cfg",
        "conf",
        "config",
        "properties",
        "csv",
        "tsv",
        "jsonl",
        "ndjson",
    ];
    if text_extensions.contains(&extension.as_str()) {
        return Some(("text", None));
    }
    let media = match extension.as_str() {
        "avif" => ("image", "image/avif"),
        "bmp" => ("image", "image/bmp"),
        "gif" => ("image", "image/gif"),
        "jpeg" | "jpg" => ("image", "image/jpeg"),
        "png" => ("image", "image/png"),
        "svg" => ("image", "image/svg+xml"),
        "webp" => ("image", "image/webp"),
        "avi" => ("video", "video/x-msvideo"),
        "m4v" => ("video", "video/x-m4v"),
        "mkv" => ("video", "video/x-matroska"),
        "mov" => ("video", "video/quicktime"),
        "mp4" => ("video", "video/mp4"),
        "ogv" => ("video", "video/ogg"),
        "webm" => ("video", "video/webm"),
        "aac" => ("audio", "audio/aac"),
        "flac" => ("audio", "audio/flac"),
        "m4a" => ("audio", "audio/mp4"),
        "mp3" => ("audio", "audio/mpeg"),
        "ogg" => ("audio", "audio/ogg"),
        "opus" => ("audio", "audio/opus"),
        "wav" => ("audio", "audio/wav"),
        _ => return None,
    };
    Some((media.0, Some(media.1)))
}

fn local_media_range(header: Option<&str>, file_size: u64) -> LocalMediaRange {
    let Some(header) = header else {
        return LocalMediaRange::None;
    };
    if file_size == 0 {
        return LocalMediaRange::Unsatisfiable;
    }
    let Some(value) = header.trim().strip_prefix("bytes=") else {
        return LocalMediaRange::Unsatisfiable;
    };
    if value.contains(',') {
        return LocalMediaRange::Unsatisfiable;
    }
    let Some((start, end)) = value.split_once('-') else {
        return LocalMediaRange::Unsatisfiable;
    };
    if start.is_empty() {
        let Ok(length) = end.parse::<u64>() else {
            return LocalMediaRange::Unsatisfiable;
        };
        if length == 0 {
            return LocalMediaRange::Unsatisfiable;
        }
        return LocalMediaRange::Range {
            start: file_size.saturating_sub(length),
            end: file_size - 1,
        };
    }
    let Ok(start) = start.parse::<u64>() else {
        return LocalMediaRange::Unsatisfiable;
    };
    let requested_end = if end.is_empty() {
        file_size - 1
    } else {
        match end.parse::<u64>() {
            Ok(value) => value,
            Err(_) => return LocalMediaRange::Unsatisfiable,
        }
    };
    if start >= file_size || requested_end < start {
        return LocalMediaRange::Unsatisfiable;
    }
    LocalMediaRange::Range {
        start,
        end: requested_end.min(file_size - 1),
    }
}

fn local_media_path(uri: &http::Uri) -> Option<PathBuf> {
    let query = uri.query()?;
    let encoded_path = query
        .split('&')
        .find_map(|part| part.strip_prefix("path="))?;
    let decoded = urlencoding::decode(encoded_path).ok()?.into_owned();
    let path = Path::new(&decoded);
    if !path.is_absolute() {
        return None;
    }
    path.canonicalize().ok().filter(|value| value.is_file())
}

fn media_response_error(status: http::StatusCode, message: &str) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .expect("valid media error response")
}

fn serve_local_media(request: http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
    let Some(path) = local_media_path(request.uri()) else {
        return media_response_error(http::StatusCode::BAD_REQUEST, "Invalid local media path.");
    };
    let Some((kind, Some(media_mime_type))) = workspace_file_kind(&path) else {
        return media_response_error(
            http::StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Unsupported local media type.",
        );
    };
    if !matches!(kind, "image" | "video" | "audio") {
        return media_response_error(
            http::StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Unsupported local media type.",
        );
    }
    let Ok(metadata) = fs::metadata(&path) else {
        return media_response_error(http::StatusCode::NOT_FOUND, "Local media file not found.");
    };
    let file_size = metadata.len();
    let range = local_media_range(
        request
            .headers()
            .get(http::header::RANGE)
            .and_then(|value| value.to_str().ok()),
        file_size,
    );
    if matches!(range, LocalMediaRange::Unsatisfiable) {
        return http::Response::builder()
            .status(http::StatusCode::RANGE_NOT_SATISFIABLE)
            .header(http::header::ACCEPT_RANGES, "bytes")
            .header(http::header::CONTENT_RANGE, format!("bytes */{file_size}"))
            .body(Vec::new())
            .expect("valid media range response");
    }

    let (status, start, end) = match range {
        LocalMediaRange::None => (http::StatusCode::OK, 0, file_size.saturating_sub(1)),
        LocalMediaRange::Range { start, end } => (http::StatusCode::PARTIAL_CONTENT, start, end),
        LocalMediaRange::Unsatisfiable => unreachable!(),
    };
    let content_length = if file_size == 0 { 0 } else { end - start + 1 };
    let mut response = http::Response::builder()
        .status(status)
        .header(http::header::ACCEPT_RANGES, "bytes")
        .header(http::header::CACHE_CONTROL, "no-store")
        .header(http::header::CONTENT_TYPE, media_mime_type)
        .header(http::header::CONTENT_LENGTH, content_length.to_string());
    if matches!(range, LocalMediaRange::Range { .. }) {
        response = response.header(
            http::header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{file_size}"),
        );
    }
    if request.method() == http::Method::HEAD || file_size == 0 {
        return response
            .body(Vec::new())
            .expect("valid media head response");
    }

    let Ok(mut file) = fs::File::open(path) else {
        return media_response_error(http::StatusCode::NOT_FOUND, "Local media file not found.");
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return media_response_error(
            http::StatusCode::INTERNAL_SERVER_ERROR,
            "Local media seek failed.",
        );
    }
    let mut body = Vec::new();
    if file.take(content_length).read_to_end(&mut body).is_err() {
        return media_response_error(
            http::StatusCode::INTERNAL_SERVER_ERROR,
            "Local media read failed.",
        );
    }
    response.body(body).expect("valid media response")
}

fn build_workspace_open_file_request(
    root: &Path,
    file_path: &str,
    disposition: Option<&str>,
) -> Result<Option<serde_json::Value>, String> {
    let target = match normalize_relative_path(root, file_path) {
        Ok(path) if path.is_file() => path,
        _ => return Ok(None),
    };
    let Some((kind, media_mime_type)) = workspace_file_kind(&target) else {
        return Ok(None);
    };
    let relative_path = relative_path(&root, &target);
    let title = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("文件")
        .to_string();
    let disposition = disposition.unwrap_or("current-group");
    if disposition != "current-group" && disposition != "new-group" {
        return Err("WORKSPACE_OPEN_DISPOSITION_INVALID".to_string());
    }
    let repository_id = repository_id(&root);
    if kind == "text" {
        let metadata = fs::metadata(&target).map_err(|error| error.to_string())?;
        if metadata.len() > 2 * 1024 * 1024 {
            return Ok(None);
        }
        let bytes = fs::read(&target).map_err(|_| "WORKSPACE_FILE_UNREADABLE".to_string())?;
        let content = String::from_utf8(
            bytes
                .strip_prefix(&[0xef, 0xbb, 0xbf])
                .unwrap_or(&bytes)
                .to_vec(),
        )
        .map_err(|_| "WORKSPACE_FILE_ENCODING_UNSUPPORTED".to_string())?;
        return Ok(Some(serde_json::json!({
            "repositoryId": repository_id,
            "filePath": target.to_string_lossy(),
            "relativePath": relative_path,
            "title": title,
            "kind": "text",
            "content": content,
            "disposition": disposition
        })));
    }
    Ok(Some(serde_json::json!({
        "repositoryId": repository_id,
        "filePath": target.to_string_lossy(),
        "relativePath": relative_path,
        "title": title,
        "kind": kind,
        "mediaMimeType": media_mime_type.unwrap_or("application/octet-stream"),
        "disposition": disposition
    })))
}

#[tauri::command]
fn workspace_open_file(
    file_path: String,
    disposition: Option<String>,
    state: State<'_, WorkspaceState>,
) -> Result<Option<serde_json::Value>, String> {
    let root = workspace_root(&state)?;
    build_workspace_open_file_request(&root, &file_path, disposition.as_deref())
}

/// 领取独立标签页 URL 中的一次性初始文件请求，并在 Rust 边界重新校验路径。
#[tauri::command]
fn workspace_take_initial_open_file(
    file_path: Option<String>,
    state: State<'_, WorkspaceState>,
) -> Result<Option<serde_json::Value>, String> {
    let file_path = file_path
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            state
                .initial_open_file
                .lock()
                .ok()
                .and_then(|mut value| value.take())
        });
    let Some(file_path) = file_path else {
        return Ok(None);
    };
    let root = workspace_root(&state)?;
    build_workspace_open_file_request(&root, &file_path, Some("current-group"))
}

#[tauri::command]
fn workspace_list_directories(
    state: State<'_, WorkspaceState>,
) -> Result<Vec<WorkspaceDirectoryEntry>, String> {
    let root = workspace_root(&state)?;
    let mut directories = vec![WorkspaceDirectoryEntry {
        relative_path: String::new(),
        name: root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("WStudio")
            .to_string(),
        parent_path: None,
    }];
    collect_directories(&root, &root, &mut directories)?;
    directories.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(directories)
}

#[tauri::command]
fn workspace_move_file(
    request: MoveFileRequest,
    state: State<'_, WorkspaceState>,
) -> Result<MoveFileResult, String> {
    let root = state.root.lock().map_err(|_| "workspace-state-poisoned")?;
    move_file_at_root(&root, request, &|| Ok(()))
}

/// Execute the trusted renderer file move against one repository root.
fn move_file_at_root(
    root: &Path,
    request: MoveFileRequest,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<MoveFileResult, String> {
    let _mutation_lock = workspace_lock::acquire(root, checkpoint)?;
    let source = match normalize_existing_relative_path(&root, &request.source_relative_path) {
        Ok(path) => path,
        Err(reason) => return Ok(MoveFileResult::Rejected { reason }),
    };
    let target_directory =
        match normalize_existing_relative_path(&root, &request.target_directory_relative_path) {
            Ok(path) => path,
            Err(reason) => {
                return Ok(MoveFileResult::Rejected {
                    reason: if reason == "not-found" {
                        "target-not-found"
                    } else {
                        reason
                    },
                })
            }
        };
    if !source.is_file() {
        return Ok(MoveFileResult::Rejected {
            reason: "source-not-file",
        });
    }
    if !target_directory.is_dir() {
        return Ok(MoveFileResult::Rejected {
            reason: "target-not-directory",
        });
    }
    if source.parent() == Some(target_directory.as_path()) {
        return Ok(MoveFileResult::Rejected {
            reason: "same-directory",
        });
    }
    let file_name = source
        .file_name()
        .ok_or_else(|| "source-not-found".to_string())?;
    let target = target_directory.join(file_name);
    let _source_pins = file_commit::pin_directories(
        root,
        source.parent().ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?,
    )?;
    let _destination_pins = file_commit::pin_directories(root, &target_directory)?;
    let identity = plugin_path_identity(&source)?;
    checkpoint()?;
    if resolve_plugin_existing_path(root, &relative_path(root, &source))? != source
        || plugin_path_identity(&source)? != identity
    {
        return Err("PLUGIN_FILESYSTEM_PATH_INVALID".into());
    }
    if target.exists() {
        return Ok(MoveFileResult::Rejected {
            reason: "target-exists",
        });
    }
    #[cfg(windows)]
    if let Err(error) = file_commit::install(&source, &target, false) {
        if error == "PLUGIN_WRITE_CONFLICT" {
            return Ok(MoveFileResult::Rejected {
                reason: "target-exists",
            });
        }
        return Err(error);
    }
    #[cfg(not(windows))]
    fs::rename(&source, &target).map_err(|_| "io-error".to_string())?;
    Ok(MoveFileResult::Moved {
        file_path: target.to_string_lossy().into_owned(),
        relative_path: relative_path(&root, &target),
        title: file_name.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn workspace_read_markdown_file(
    path: String,
    state: State<'_, WorkspaceState>,
) -> Result<Option<MarkdownFile>, String> {
    let root = workspace_root(&state)?;
    let resolved = match normalize_relative_path(&root, &path) {
        Ok(path) => path,
        Err("not-found") => return Ok(None),
        Err(reason) => return Err(reason.to_string()),
    };
    if !resolved.is_file()
        || !resolved
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| {
                extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
            })
    {
        return Ok(None);
    }
    Ok(Some(
        markdown_file(&root, &resolved).map_err(str::to_string)?,
    ))
}

#[tauri::command]
fn workspace_update_markdown_file(
    request: UpdateMarkdownRequest,
    state: State<'_, WorkspaceState>,
) -> Result<UpdateMarkdownResult, String> {
    workspace_update_markdown_file_guarded(request, state, &|| Ok(()))
}

fn workspace_update_markdown_file_guarded(
    request: UpdateMarkdownRequest,
    state: State<'_, WorkspaceState>,
    before_write: &impl Fn() -> Result<(), String>,
) -> Result<UpdateMarkdownResult, String> {
    let root = state.root.lock().map_err(|_| "workspace-state-poisoned")?;
    update_markdown_at_root(&root, request, before_write)
}

/// Share host and SDK Markdown saves with workspace locking and optimistic atomic commits.
fn update_markdown_at_root(
    root: &Path,
    request: UpdateMarkdownRequest,
    before_write: &dyn Fn() -> Result<(), String>,
) -> Result<UpdateMarkdownResult, String> {
    let _mutation_lock = workspace_lock::acquire(root, before_write)?;
    let resolved = match normalize_relative_path(root, &request.path) {
        Ok(path) => path,
        Err(reason) => return Ok(UpdateMarkdownResult::Rejected { reason }),
    };
    if !resolved
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
    {
        return Ok(UpdateMarkdownResult::Rejected {
            reason: "unsupported-extension",
        });
    }
    let identity = plugin_path_identity(&resolved)?;
    let current = markdown_file(root, &resolved).map_err(str::to_string)?;
    if current.content != request.expected_content {
        return Ok(UpdateMarkdownResult::Conflict { file: current });
    }
    if current.content == request.content {
        return Ok(UpdateMarkdownResult::Unchanged { file: current });
    }
    if let Err(error) = file_commit::replace_existing(
        root,
        &resolved,
        request.content.as_bytes(),
        request.expected_content.as_bytes(),
        &identity,
        before_write,
    ) {
        if error == "PLUGIN_WRITE_CONFLICT" {
            return Ok(UpdateMarkdownResult::Conflict {
                file: markdown_file(root, &resolved).map_err(str::to_string)?,
            });
        }
        return Err(error);
    }
    let updated = markdown_file(root, &resolved).map_err(str::to_string)?;
    Ok(UpdateMarkdownResult::Updated { file: updated })
}

#[tauri::command]
fn workspace_create_date_note(
    request: CreateDateNoteRequest,
    state: State<'_, WorkspaceState>,
) -> Result<CreateDateNoteResult, String> {
    let root = state.root.lock().map_err(|_| "workspace-state-poisoned")?;
    create_date_note_at_root(&root, request, &|| Ok(()))
}

/// Resolve a calendar note adjacent to its source Markdown file.
fn create_date_note_at_root(
    root: &Path,
    request: CreateDateNoteRequest,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<CreateDateNoteResult, String> {
    let _mutation_lock = workspace_lock::acquire(root, checkpoint)?;
    let date = match normalize_date(&request.date) {
        Some(value) => value,
        None => {
            return Ok(CreateDateNoteResult::Rejected {
                reason: "invalid-date",
            })
        }
    };
    let source = match normalize_relative_path(&root, &request.source_file_path) {
        Ok(path) => path,
        Err(reason) => {
            return Ok(CreateDateNoteResult::Rejected {
                reason: if reason == "not-found" {
                    "source-not-found"
                } else {
                    reason
                },
            })
        }
    };
    if !source.is_file() {
        return Ok(CreateDateNoteResult::Rejected {
            reason: "source-not-file",
        });
    }
    let target = source
        .parent()
        .ok_or_else(|| "io-error".to_string())?
        .join(format!("{date}.md"));
    let _pins = file_commit::pin_directories(
        root,
        target.parent().ok_or("PLUGIN_FILESYSTEM_PATH_INVALID")?,
    )?;
    if target.exists() {
        resolve_plugin_existing_path(root, &relative_path(root, &target))?;
        return Ok(CreateDateNoteResult::Existing {
            file: markdown_file(&root, &target).map_err(str::to_string)?,
        });
    }
    if let Err(error) = file_commit::create_new(root, &target, b"", checkpoint) {
        if error == "PLUGIN_FILESYSTEM_ALREADY_EXISTS" {
            resolve_plugin_existing_path(root, &relative_path(root, &target))?;
            return Ok(CreateDateNoteResult::Existing {
                file: markdown_file(root, &target).map_err(str::to_string)?,
            });
        }
        return Err(error);
    }
    Ok(CreateDateNoteResult::Created {
        file: markdown_file(&root, &target).map_err(str::to_string)?,
    })
}

#[tauri::command]
fn workspace_import_external_media_file(
    request: ImportExternalMediaRequest,
    state: State<'_, WorkspaceState>,
) -> Result<ImportExternalMediaResult, String> {
    let root = state.root.lock().map_err(|_| "workspace-state-poisoned")?;
    import_media_at_root(&root, request, &|| Ok(()))
}

/// Import user-selected external media into the Markdown file's Temp folder.
fn import_media_at_root(
    root: &Path,
    request: ImportExternalMediaRequest,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<ImportExternalMediaResult, String> {
    let _mutation_lock = workspace_lock::acquire(root, checkpoint)?;
    if request.source_path.trim().is_empty() || request.markdown_file_path.trim().is_empty() {
        return Ok(ImportExternalMediaResult::Rejected {
            reason: "invalid-request",
        });
    }
    let source = match Path::new(request.source_path.trim()).canonicalize() {
        Ok(path) => path,
        Err(_) => {
            return Ok(ImportExternalMediaResult::Rejected {
                reason: "source-not-found",
            })
        }
    };
    if !source.is_file() {
        return Ok(ImportExternalMediaResult::Rejected {
            reason: "source-not-file",
        });
    }
    if !is_supported_media(&source) {
        return Ok(ImportExternalMediaResult::Rejected {
            reason: "unsupported-media",
        });
    }
    let markdown = match normalize_relative_path(&root, request.markdown_file_path.trim()) {
        Ok(path) => path,
        Err(_) => {
            return Ok(ImportExternalMediaResult::Rejected {
                reason: "markdown-not-found",
            })
        }
    };
    if !markdown.is_file()
        || !matches!(
            markdown.extension().and_then(|value| value.to_str()),
            Some("md" | "markdown")
        )
    {
        return Ok(ImportExternalMediaResult::Rejected {
            reason: "markdown-not-found",
        });
    }
    let markdown_directory = markdown.parent().ok_or_else(|| "io-error".to_string())?;
    let _markdown_pins = file_commit::pin_directories(root, markdown_directory)?;
    checkpoint()?;
    let target_directory = markdown_directory.join("Temp");
    match fs::create_dir(&target_directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("PLUGIN_FILESYSTEM_CREATE_FAILED".into()),
    }
    resolve_plugin_existing_path(root, &relative_path(root, &target_directory))?;
    let _target_pins = file_commit::pin_directories(root, &target_directory)?;
    let source_name = source
        .file_name()
        .ok_or_else(|| "source-not-found".to_string())?;
    let source_name = source_name.to_string_lossy().into_owned();
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let stem = source_name.strip_suffix(&extension).unwrap_or(&source_name);
    let mut target = target_directory.join(&source_name);
    let mut sequence = 1;
    loop {
        checkpoint()?;
        // Bound name contention and preserve existing files, including those created after staging.
        if sequence > 10_000 {
            return Err("PLUGIN_FILESYSTEM_OPERATION_TOO_LARGE".into());
        }
        if !target.exists() {
            let mut input = file_commit::open_read_snapshot(&source)?;
            let result = file_commit::create_new_with(
                root,
                &target,
                Some(&source),
                &mut |output| {
                    use std::io::{Read, Write};
                    let mut buffer = [0u8; 64 * 1024];
                    loop {
                        checkpoint()?;
                        let count = input
                            .read(&mut buffer)
                            .map_err(|_| "PLUGIN_FILESYSTEM_READ_FAILED")?;
                        if count == 0 {
                            break;
                        }
                        output
                            .write_all(&buffer[..count])
                            .map_err(|_| "PLUGIN_FILESYSTEM_WRITE_FAILED")?;
                    }
                    Ok(())
                },
                checkpoint,
            );
            match result {
                Ok(()) => break,
                Err(error) if error == "PLUGIN_FILESYSTEM_ALREADY_EXISTS" => {}
                Err(error) => return Err(error),
            }
        }
        target = target_directory.join(format!("{stem} ({sequence}){extension}"));
        sequence += 1;
    }
    let relative_path = relative_path(&root, &target);
    let reference_path = target
        .strip_prefix(markdown_directory)
        .unwrap_or(&target)
        .to_string_lossy()
        .replace('\\', "/");
    Ok(ImportExternalMediaResult::Copied {
        relative_path,
        reference_path,
        title: target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&source_name)
            .to_string(),
    })
}

#[tauri::command]
fn workspace_open_repository(
    path: String,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<RepositorySummary, String> {
    let root = canonical_directory(&path)?;
    remember_repository(&state, &root)?;
    publish_repository_changed(&app, &root)?;
    Ok(repository_summary(&root))
}

#[tauri::command]
fn workspace_create_repository(
    name: Option<String>,
    parent_path: Option<String>,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<RepositorySummary, String> {
    let parent = match parent_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(value) => canonical_directory(value)?,
        None => app
            .path()
            .document_dir()
            .map_err(|error| error.to_string())?,
    };
    let _parent_lock = workspace_lock::acquire(&parent, &|| Ok(()))?;
    let _parent_pin = file_commit::pin_directories(&parent, &parent)?;
    fs::create_dir_all(&parent).map_err(|error| error.to_string())?;
    let requested_name = name.as_deref().unwrap_or("WStudio Vault").trim();
    let safe_name = requested_name
        .replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], " ")
        .trim()
        .to_string();
    let base_name = if safe_name.is_empty() {
        "WStudio Vault"
    } else {
        &safe_name
    };
    let mut sequence = 0;
    let root = loop {
        let suffix = if sequence == 0 {
            String::new()
        } else {
            format!(" {sequence}")
        };
        let candidate = parent.join(format!("{base_name}{suffix}"));
        match fs::create_dir(&candidate) {
            Ok(()) => break candidate,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => sequence += 1,
            Err(error) => return Err(error.to_string()),
        }
    };
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    remember_repository(&state, &root)?;
    publish_repository_changed(&app, &root)?;
    Ok(repository_summary(&root))
}

#[tauri::command]
fn workspace_list_recent_repositories(
    state: State<'_, WorkspaceState>,
) -> Result<Vec<RecentRepositorySummary>, String> {
    let mut recent = state
        .recent
        .lock()
        .map_err(|_| "workspace-state-poisoned".to_string())?
        .clone();
    recent.retain(|item| Path::new(&item.root_path).is_dir());
    Ok(recent
        .into_iter()
        .map(|item| RecentRepositorySummary {
            id: item.id,
            name: item.name,
            display_path: item.display_path,
        })
        .collect())
}

#[tauri::command]
fn workspace_open_recent_repository(
    id: String,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<Option<RepositorySummary>, String> {
    let root_path = state
        .recent
        .lock()
        .map_err(|_| "workspace-state-poisoned".to_string())?
        .iter()
        .find(|item| item.id == id)
        .map(|item| item.root_path.clone());
    let Some(root_path) = root_path else {
        return Ok(None);
    };
    let root = canonical_directory(&root_path)?;
    remember_repository(&state, &root)?;
    publish_repository_changed(&app, &root)?;
    Ok(Some(repository_summary(&root)))
}

fn copy_directory_recursive(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if entry
            .metadata()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            copy_directory_recursive(&source_path, &target_path)?;
        } else {
            fs::copy(&source_path, &target_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn normalize_repository_directory_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['\\', '/'])
        || name.contains([':', '*', '?', '"', '<', '>', '|'])
    {
        return Err("WORKSPACE_REPOSITORY_NAME_INVALID".to_string());
    }
    Ok(name.to_string())
}

#[tauri::command]
fn workspace_rename_recent_repository(
    id: String,
    name: String,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let name = normalize_repository_directory_name(&name)?;
    let current_root = workspace_root(&state)?;
    let mut recent = state
        .recent
        .lock()
        .map_err(|_| "workspace-state-poisoned".to_string())?;
    let item = recent
        .iter_mut()
        .find(|value| value.id == id)
        .ok_or_else(|| "WORKSPACE_RECENT_REPOSITORY_NOT_FOUND".to_string())?;
    let source = PathBuf::from(&item.root_path);
    let target = source
        .parent()
        .ok_or_else(|| "WORKSPACE_REPOSITORY_PATH_INVALID".to_string())?
        .join(&name);
    if target != source && target.exists() {
        return Err("WORKSPACE_REPOSITORY_EXISTS".to_string());
    }
    let _mutation_lock = workspace_lock::acquire(&source, &|| Ok(()))?;
    let _source_pin = file_commit::pin_directories(&source, &source)?;
    if target != source {
        fs::rename(&source, &target).map_err(|error| error.to_string())?;
    }
    let target = target.canonicalize().map_err(|error| error.to_string())?;
    item.root_path = target.to_string_lossy().into_owned();
    item.name = name;
    let is_current = source == current_root;
    drop(recent);
    if is_current {
        *state
            .root
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())? = target.clone();
        publish_repository_changed(&app, &target)?;
    }
    state.persist()
}

#[tauri::command]
fn workspace_move_recent_repository(
    id: String,
    target_parent_path: String,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<bool, String> {
    let target_parent = canonical_directory(&target_parent_path)?;
    let current_root = workspace_root(&state)?;
    let mut recent = state
        .recent
        .lock()
        .map_err(|_| "workspace-state-poisoned".to_string())?;
    let item = recent
        .iter_mut()
        .find(|value| value.id == id)
        .ok_or_else(|| "WORKSPACE_RECENT_REPOSITORY_NOT_FOUND".to_string())?;
    let source = PathBuf::from(&item.root_path)
        .canonicalize()
        .map_err(|_| "WORKSPACE_REPOSITORY_NOT_FOUND".to_string())?;
    let folder_name = source
        .file_name()
        .ok_or_else(|| "WORKSPACE_REPOSITORY_PATH_INVALID".to_string())?;
    let target = target_parent.join(folder_name);
    if target == source {
        return Ok(false);
    }
    if target.starts_with(&source) {
        return Err("WORKSPACE_REPOSITORY_MOVE_INTO_SELF".to_string());
    }
    if target.exists() {
        return Err("WORKSPACE_REPOSITORY_EXISTS".to_string());
    }
    let (_source_lock, _target_lock) =
        workspace_lock::acquire_pair(&source, &target_parent, &|| Ok(()))?;
    let _source_pin = file_commit::pin_directories(&source, &source)?;
    match fs::rename(&source, &target) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {
            copy_directory_recursive(&source, &target)?;
            fs::remove_dir_all(&source).map_err(|remove_error| remove_error.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    let target = target.canonicalize().map_err(|error| error.to_string())?;
    item.root_path = target.to_string_lossy().into_owned();
    let is_current = source == current_root;
    drop(recent);
    if is_current {
        *state
            .root
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())? = target.clone();
        publish_repository_changed(&app, &target)?;
    }
    state.persist()?;
    Ok(true)
}

#[tauri::command]
fn workspace_reveal_recent_repository(
    id: String,
    state: State<'_, WorkspaceState>,
) -> Result<bool, String> {
    let root_path = state
        .recent
        .lock()
        .map_err(|_| "workspace-state-poisoned".to_string())?
        .iter()
        .find(|value| value.id == id)
        .map(|value| value.root_path.clone())
        .ok_or_else(|| "WORKSPACE_RECENT_REPOSITORY_NOT_FOUND".to_string())?;
    let target = Path::new(&root_path)
        .canonicalize()
        .map_err(|_| "WORKSPACE_REPOSITORY_NOT_FOUND".to_string())?;
    #[cfg(target_os = "windows")]
    {
        let status = Command::new("explorer.exe")
            .args(["/select,", &target.to_string_lossy()])
            .status()
            .map_err(|error| error.to_string())?;
        return Ok(status.success());
    }
    #[cfg(not(target_os = "windows"))]
    {
        open::that(target.parent().unwrap_or(&target))
            .map(|_| true)
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn workspace_remove_recent_repository(
    id: String,
    state: State<'_, WorkspaceState>,
) -> Result<(), String> {
    let mut recent = state
        .recent
        .lock()
        .map_err(|_| "workspace-state-poisoned".to_string())?;
    recent.retain(|value| value.id != id);
    drop(recent);
    state.persist()
}

#[tauri::command]
async fn workspace_open_in_new_window(
    requested_relative_path: String,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<bool, String> {
    let root = workspace_root(&state)?;
    let target = match normalize_relative_path(&root, &requested_relative_path) {
        Ok(path) if path.is_file() => path,
        _ => return Ok(false),
    };
    if workspace_file_kind(&target).is_none() {
        return Ok(false);
    }
    let relative = relative_path(&root, &target);
    let label = format!("wstudio-file-{}", Uuid::new_v4().simple());
    let query = format!(
        "index.html?windowMode=tab&initialFilePath={}",
        urlencoding::encode(&relative)
    );
    let url = WebviewUrl::App(PathBuf::from(query));
    let title = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("WStudio")
        .to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let builder = WebviewWindowBuilder::new(&app, &label, url)
            .title(title)
            .decorations(false)
            .inner_size(1280.0, 800.0)
            .min_inner_size(800.0, 600.0);
        let builder = with_default_window_chrome(
            builder,
            app.default_window_icon()
                .cloned()
                .map(tauri::image::Image::to_owned),
        )?;
        let (x, y) = host_center_position(&app, (1280.0, 800.0))?;
        let builder = builder.position(x, y);
        let window = builder.build().map_err(|error| error.to_string())?;
        apply_windows_taskbar_icon(&window)?;
        Ok(true)
    })
    .await
    .map_err(|_| "WINDOW_CREATE_FAILED".to_string())?
}

#[tauri::command]
fn workspace_get_default_repository_location(app: AppHandle) -> Result<String, String> {
    app.path()
        .document_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

/// Revoke renderer-owned resources on reload as well as native window destruction.
fn dispose_renderer_resources(app: &AppHandle, label: &str) {
    if let Some(state) = app.try_state::<web_viewer::WebViewerState>() {
        state.dispose(app, |scope| scope.window == label);
    }
    if let Some(state) = app.try_state::<PluginRegistryState>() {
        for plugin_id in state.dispose_window(label) {
            // Window ownership changed, not the generation; surviving views keep their state.
            let _ = app.emit(
                "plugin:runtimeChanged",
                serde_json::json!({ "pluginId": plugin_id }),
            );
        }
    }
    if let Some(state) = app.try_state::<PluginRpcState>() {
        state.dispose_window(label);
    }
    if let Some(state) = app.try_state::<PluginSettingsState>() {
        for plugin_id in state.dispose_window(label) {
            let _ = app.emit(
                "plugin:contributionsChanged",
                serde_json::json!({ "pluginId": plugin_id }),
            );
        }
    }
}

/// Close every auxiliary native window before the main workbench exits.
fn close_auxiliary_windows(app: &AppHandle, main_label: &str) {
    for (label, child) in app.windows() {
        if label != main_label {
            let _ = child.close();
        }
    }
}

pub fn run() {
    taskbar_jump_list::install(tauri::Builder::default())
        .on_page_load(|view, payload| {
            if !web_viewer::is_remote(view.label())
                && payload.event() == tauri::webview::PageLoadEvent::Started
            {
                dispose_renderer_resources(view.app_handle(), view.label());
                if let Some(state) = view
                    .app_handle()
                    .try_state::<native_process::NativeProcessState>()
                {
                    state.started(view.label());
                }
            }
            if !web_viewer::is_remote(view.label()) {
                native_process::observe(&view);
            }
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. })
                && window.label() == "main"
            {
                close_auxiliary_windows(window.app_handle(), window.label());
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if window.label().starts_with("wstudio-settings-") {
                    let _ = window.app_handle().emit(
                        "workbench:settingsWindowState",
                        serde_json::json!({ "open": false }),
                    );
                }
                dispose_renderer_resources(window.app_handle(), window.label());
                if let Some(state) = window
                    .app_handle()
                    .try_state::<native_process::NativeProcessState>()
                {
                    state.forget(window.label());
                }
            }
        })
        .register_uri_scheme_protocol("wstudio-media", |context, request| {
            if web_viewer::is_remote(context.webview_label()) {
                return http::Response::builder()
                    .status(403)
                    .body(Vec::new())
                    .unwrap();
            }
            serve_local_media(request)
        })
        .register_uri_scheme_protocol("wstudio-plugin", |context, request| {
            if web_viewer::is_remote(context.webview_label()) {
                return http::Response::builder()
                    .status(403)
                    .body(Vec::new())
                    .unwrap();
            }
            context
                .app_handle()
                .state::<PluginRegistryState>()
                .serve_resource(context.webview_label(), request)
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            if let Some(icon) = app.default_window_icon().cloned() {
                for window in app.webview_windows().values() {
                    window.set_icon(icon.clone())?;
                    apply_windows_taskbar_icon(window)?;
                }
            }
            let user_data_root = app.path().app_data_dir()?;
            let legacy_root = resolve_legacy_user_data_root(app.handle());
            if let Some(source) = &legacy_root {
                user_data_migration::migrate_user_data(source, &user_data_root)?;
            }
            let persistence_path = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?
                .join("workspace.json");
            app.manage(restore_workspace_state(persistence_path)?);
            taskbar_jump_list::initialize(app.handle());
            let database_path = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?
                .join("database")
                .join("wstudio.sqlite");
            if let Some(parent) = database_path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let connection = Connection::open(database_path).map_err(|error| error.to_string())?;
            initialize_database(&connection)?;
            login::receipt::initialize(&connection)?;
            ai_credentials::recover_pending(&connection)?;
            app.manage(DatabaseState {
                connection: Mutex::new(connection),
            });
            app.manage(AiChatState::default());
            app.manage(EditorState::default());
            app.manage(ActivityState::default());
            app.manage(PluginStorageState::default());
            app.manage(PluginDialogState::default());
            app.manage(PluginRpcState::default());
            app.manage(LoginState::default());
            login::initialize(app.handle())?;
            app.manage(PluginSettingsState::default());
            app.manage(web_viewer::WebViewerState::default());
            app.manage(native_process::NativeProcessState::default());
            let plugin_root = app.path().app_data_dir()?.join("plugins");
            if let Some(legacy_root) = legacy_root {
                let _ = migrate_legacy_data(&legacy_root.join("plugins"), &plugin_root);
            }
            app.manage(PluginRegistryState::open(
                plugin_root,
                resolve_core_plugin_root(app.handle()),
            )?);
            for view in app.webviews().values() {
                if !web_viewer::is_remote(view.label()) {
                    native_process::observe(view);
                }
            }
            start_workspace_watcher(app.handle().clone());
            start_window_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler({
            let handler: Box<dyn Fn(tauri::ipc::Invoke) -> bool + Send + Sync> =
                Box::new(tauri::generate_handler![
                    app_ping,
                    app_get_version,
                    editor_set_active_document,
                    editor_get_active_document,
                    theme_list_user_themes,
                    theme_materialize_builtin,
                    plugin_list,
                    plugin_install,
                    plugin_update,
                    plugin_rollback,
                    plugin_set_permissions,
                    plugin_set_enabled,
                    plugin_uninstall,
                    plugin_list_contributions,
                    plugin_get_settings,
                    plugin_set_setting,
                    plugin_execute_command,
                    plugin_invoke_renderer,
                    plugin_show_notification,
                    plugin_show_system_notification,
                    plugin_dialog_request,
                    plugin_dialog_respond,
                    plugin_storage_get,
                    plugin_storage_set,
                    plugin_storage_delete,
                    plugin_editor_reveal_range,
                    plugin_editor_open_file,
                    plugin_editor_close_tabs,
                    plugin_dispose_view,
                    plugin_web_viewer_context_menu,
                    plugin_update_view_bounds,
                    plugin_filesystem_list_entries,
                    plugin_filesystem_stat,
                    plugin_filesystem_read_text,
                    plugin_filesystem_create_file,
                    plugin_filesystem_create_directory,
                    plugin_filesystem_delete,
                    plugin_filesystem_move,
                    plugin_filesystem_rename,
                    plugin_filesystem_copy,
                    plugin_filesystem_encrypt,
                    plugin_filesystem_decrypt,
                    plugin_filesystem_write_text,
                    plugin_open_with_default_app,
                    plugin_reveal_in_file_manager,
                    plugin_window_list,
                    plugin_window_open,
                    plugin_window_update,
                    plugin_window_focus,
                    plugin_window_close,
                    workbench_open_settings,
                    workbench_open_search,
                    workbench_open_repository_manager,
                    workbench_take_repository_manager_request,
                    workbench_open_settings_tab,
                    workbench_open_search_result,
                    system_list_fonts,
                    window_minimize,
                    window_toggle_maximize,
                    window_close,
                    window_is_maximized,
                    window_get_position,
                    window_move_to,
                    window_report_activity,
                    sql_exec,
                    sql_run,
                    sql_get,
                    sql_all,
                    app_settings_get,
                    app_settings_set,
                    app_settings_remove,
                    login_google_begin,
                    login_github_begin,
                    login_wait,
                    login_cancel,
                    login_get_receipt,
                    login_get_receipts,
                    login_select_account,
                    login_logout,
                    ai_configurations_list,
                    ai_configurations_create,
                    ai_configurations_delete,
                    ai_configurations_update,
                    ai_models_list,
                    ai_models_list_connected,
                    ai_models_create,
                    ai_models_update,
                    ai_models_delete,
                    ai_connection_get_settings,
                    ai_connection_update_settings,
                    ai_connection_test_model,
                    ai_connection_cancel_test,
                    ai_chat_start,
                    ai_chat_pause,
                    ai_chat_resume,
                    ai_chat_cancel,
                    workspace_get_repository,
                    workspace_open_with_system,
                    workspace_reveal_in_file_manager,
                    workspace_copy_path,
                    workspace_list_files,
                    workspace_list_markdown_files,
                    workspace_open_file,
                    workspace_take_initial_open_file,
                    taskbar_record_closed_tab,
                    workspace_list_directories,
                    workspace_move_file,
                    workspace_read_markdown_file,
                    workspace_update_markdown_file,
                    workspace_create_date_note,
                    workspace_import_external_media_file,
                    workspace_open_repository,
                    workspace_create_repository,
                    workspace_list_recent_repositories,
                    workspace_open_recent_repository,
                    workspace_rename_recent_repository,
                    workspace_move_recent_repository,
                    workspace_reveal_recent_repository,
                    workspace_remove_recent_repository,
                    workspace_open_in_new_window,
                    workspace_get_default_repository_location,
                    workspace_pick_entry
                ]);
            move |invoke: tauri::ipc::Invoke| {
                if web_viewer::is_remote(invoke.message.webview_ref().label()) {
                    invoke.resolver.reject("PLUGIN_REMOTE_CONTENT_FORBIDDEN");
                    true
                } else {
                    handler(invoke)
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running WStudio Tauri application");
}

#[cfg(test)]
mod workspace_mutation_tests {
    use super::*;
    use std::cell::Cell;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("wstudio-native-mutations-{}", Uuid::new_v4()));
            fs::create_dir_all(path.join("notes")).unwrap();
            fs::create_dir(path.join("destination")).unwrap();
            fs::write(path.join("notes/source.md"), "source").unwrap();
            Self(path.canonicalize().unwrap())
        }
        fn staged(&self, directory: &Path) -> bool {
            directory.is_dir()
                && fs::read_dir(directory).unwrap().any(|entry| {
                    entry
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".wstudio-write-")
                })
        }
        fn date_request(&self) -> CreateDateNoteRequest {
            CreateDateNoteRequest {
                source_file_path: "notes/source.md".into(),
                date: "2026-10-08".into(),
            }
        }
        fn media_request(&self, source: &Path) -> ImportExternalMediaRequest {
            ImportExternalMediaRequest {
                source_path: source.to_string_lossy().into_owned(),
                markdown_file_path: "notes/source.md".into(),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn native_mutations_observe_revocation_before_changing_files() {
        let fixture = Fixture::new();
        let external = Fixture::new();
        let media = external.0.join("photo.png");
        fs::write(&media, b"media bytes").unwrap();
        let revoked = || Err("PLUGIN_RUNTIME_TERMINATED".into());
        assert_eq!(
            create_date_note_at_root(&fixture.0, fixture.date_request(), &revoked).unwrap_err(),
            "PLUGIN_RUNTIME_TERMINATED"
        );
        assert_eq!(
            import_media_at_root(&fixture.0, fixture.media_request(&media), &revoked).unwrap_err(),
            "PLUGIN_RUNTIME_TERMINATED"
        );
        assert_eq!(
            move_file_at_root(
                &fixture.0,
                MoveFileRequest {
                    source_relative_path: "notes/source.md".into(),
                    target_directory_relative_path: "destination".into()
                },
                &revoked
            )
            .unwrap_err(),
            "PLUGIN_RUNTIME_TERMINATED"
        );
        assert!(!fixture.0.join("notes/2026-10-08.md").exists());
        assert!(!fixture.0.join("notes/Temp").exists());
        assert_eq!(
            fs::read_to_string(fixture.0.join("notes/source.md")).unwrap(),
            "source"
        );
    }

    #[test]
    fn date_note_retains_a_note_created_by_a_late_writer() {
        let fixture = Fixture::new();
        let injected = Cell::new(false);
        let result = create_date_note_at_root(&fixture.0, fixture.date_request(), &|| {
            if fixture.staged(&fixture.0.join("notes")) && !injected.replace(true) {
                fs::write(fixture.0.join("notes/2026-10-08.md"), "external note").unwrap();
            }
            Ok(())
        })
        .unwrap();
        assert!(injected.get());
        assert!(
            matches!(result, CreateDateNoteResult::Existing {file} if file.content == "external note")
        );
        assert!(!fixture.staged(&fixture.0.join("notes")));
    }

    #[test]
    fn media_import_retries_late_destination_without_overwriting_it() {
        let fixture = Fixture::new();
        let external = Fixture::new();
        let media = external.0.join("photo.png");
        fs::write(&media, b"original media").unwrap();
        let injected = Cell::new(false);
        let result = import_media_at_root(&fixture.0, fixture.media_request(&media), &|| {
            if fixture.staged(&fixture.0.join("notes/Temp")) && !injected.replace(true) {
                fs::write(fixture.0.join("notes/Temp/photo.png"), b"external media").unwrap();
            }
            Ok(())
        })
        .unwrap();
        assert!(injected.get());
        assert!(
            matches!(result, ImportExternalMediaResult::Copied {relative_path,reference_path,..} if relative_path == "notes/Temp/photo (1).png" && reference_path == "Temp/photo (1).png")
        );
        assert_eq!(
            fs::read(fixture.0.join("notes/Temp/photo.png")).unwrap(),
            b"external media"
        );
        assert_eq!(
            fs::read(fixture.0.join("notes/Temp/photo (1).png")).unwrap(),
            b"original media"
        );
        assert!(!fixture.staged(&fixture.0.join("notes/Temp")));
    }

    /// Keep imported media paths aligned with the renderer's IPC result type.
    #[test]
    fn media_import_result_uses_camel_case_paths() {
        let result = serde_json::to_value(ImportExternalMediaResult::Copied {
            relative_path: "notes/Temp/photo.png".into(),
            reference_path: "Temp/photo.png".into(),
            title: "photo.png".into(),
        })
        .unwrap();
        assert_eq!(result["referencePath"], "Temp/photo.png");
        assert_eq!(result["relativePath"], "notes/Temp/photo.png");
        assert!(result.get("reference_path").is_none());
    }
}

#[cfg(test)]
mod tests {
    /// AI credentials must survive a new host request, which constructs a fresh entry.
    #[cfg(windows)]
    #[test]
    fn ai_credentials_persist_across_independent_host_entries() {
        let _native_guard = crate::ai_credentials::NATIVE_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        struct TestCredential(keyring::Entry);
        impl Drop for TestCredential {
            fn drop(&mut self) {
                match self.0.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => (),
                    Err(error) => panic!("failed to clean test credential: {error}"),
                }
            }
        }
        let id = format!("migration-test-{}", uuid::Uuid::new_v4());
        let original = TestCredential(super::credential_entry(&id).unwrap());
        original
            .0
            .set_password("synthetic-migration-test-value")
            .unwrap();
        let reopened = super::credential_entry(&id).unwrap();
        assert_eq!(
            reopened.get_password().unwrap(),
            "synthetic-migration-test-value"
        );
        drop(original);
        assert!(matches!(
            reopened.get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }

    // Preserve existing primitive tests while production callers use revocable checkpoints.
    fn move_plugin_path(
        root: &std::path::Path,
        manifest: &serde_json::Value,
        source: &str,
        destination: &str,
    ) -> Result<super::PluginFilesystemEntry, String> {
        super::move_plugin_path_checked(root, manifest, source, destination, &|| Ok(()))
    }
    fn copy_plugin_path(
        root: &std::path::Path,
        manifest: &serde_json::Value,
        source: &str,
        destination: &str,
        recursive: bool,
    ) -> Result<super::PluginFilesystemEntry, String> {
        super::copy_plugin_path_checked(root, manifest, source, destination, recursive, &|| Ok(()))
    }
    use super::{
        build_workspace_open_file_request, center_position_within_host,
        collect_scoped_markdown_files, create_plugin_directory, create_plugin_text_file,
        delete_plugin_path, is_retryable_ai_provider_status, json_to_sql_value, local_media_range,
        normalize_font_family_name, normalize_plugin_settings, normalize_relative_path,
        normalize_sql_request, normalize_theme_category, normalize_theme_file_name,
        parse_ai_provider_event, physical_window_geometry_to_logical, plugin_command_is_declared,
        plugin_contribution_summary_from_manifest, plugin_editor_vertical_alignment_is_valid,
        plugin_path_has_permission, plugin_permission_is_declared, plugin_setting_definition,
        plugin_setting_value_is_valid, plugin_storage_key_is_valid, plugin_summary_from_manifest,
        plugin_view_bounds_request_is_valid, plugin_view_request_is_valid, plugin_window_query,
        protect_plugin_file, read_plugin_storage, read_plugin_text_file, relative_path,
        resolve_plugin_external_workspace_path, stat_plugin_filesystem_entry,
        validate_plugin_command, validate_theme_variant, workspace_file_changes,
        workspace_file_kind, write_plugin_storage, write_plugin_text_file, AiProviderEvent,
        LocalMediaRange, PluginViewBounds, PluginViewBoundsRequest, PluginViewRequest,
        PluginWindowOpenRequest, SqlQueryRequest, WorkspaceMarkdownFileMetadata,
        MAX_PLUGIN_TEXT_FILE_SIZE,
    };
    use serde_json::json;
    use std::fs;
    use std::path::Path;
    use uuid::Uuid;

    #[test]
    fn relative_path_rejects_parent_escape() {
        let root = std::env::temp_dir().join(format!("wstudio-test-{}", std::process::id()));
        let nested = root.join("notes");
        fs::create_dir_all(&nested).expect("create test directory");
        fs::write(nested.join("note.md"), "hello").expect("write test file");

        assert!(normalize_relative_path(&root, "../outside.md").is_err());
        assert_eq!(
            relative_path(&root, &nested.join("note.md")),
            "notes/note.md"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plugin_storage_validates_keys_and_round_trips_json() {
        assert!(plugin_storage_key_is_valid("panel.theme"));
        assert!(!plugin_storage_key_is_valid("panel/theme"));
        assert!(!plugin_storage_key_is_valid(
            &"x".repeat(super::MAX_PLUGIN_STORAGE_KEY_LENGTH + 1)
        ));

        let root = std::env::temp_dir().join(format!("wstudio-plugin-storage-{}", Uuid::new_v4()));
        let storage_path = root.join("storage.json");
        let mut values = serde_json::Map::new();
        values.insert("panel.theme".to_string(), json!(null));
        values.insert("count".to_string(), json!(3));
        write_plugin_storage(&storage_path, &values).expect("write storage");

        let loaded = read_plugin_storage(&storage_path).expect("read storage");
        assert_eq!(loaded.get("panel.theme"), Some(&json!(null)));
        assert_eq!(loaded.get("count"), Some(&json!(3)));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plugin_storage_rejects_permissions_bad_keys_and_oversized_values() {
        // An ordinary plugin manifest uses the same storage boundary as a core plugin.
        let manifest = json!({
            "id": "com.example.storage-test",
            "permissions": [{"id": "storage.plugin", "reason": "Save view state"}]
        });
        assert_eq!(
            super::validate_plugin_storage_request(&json!({}), "state", None),
            Err("PLUGIN_PERMISSION_NOT_DECLARED".to_string())
        );
        for key in ["", "../other", "a/b", "a\\b", "中文", "a b"] {
            assert_eq!(
                super::validate_plugin_storage_request(&manifest, key, None),
                Err("PLUGIN_INVALID_ARGUMENT".to_string())
            );
        }
        assert!(super::validate_plugin_storage_request(
            &manifest,
            "state.v1:_-",
            Some(&json!({"nested": [1, false, null]}))
        )
        .is_ok());
        let large_value = json!("x".repeat(super::MAX_PLUGIN_STORAGE_VALUE_SIZE));
        assert_eq!(
            super::validate_plugin_storage_request(&manifest, "large", Some(&large_value)),
            Err("PLUGIN_INVALID_ARGUMENT".to_string())
        );
        assert!(
            serde_json::from_value::<super::PluginStorageSetRequest>(json!({
                "pluginId": "com.example.storage-test", "key": "missing-value"
            }))
            .is_err()
        );
    }

    #[test]
    fn repository_manager_dialog_is_forwarded_without_blocking_inline_dialogs() {
        let event = json!({"requestId":"request-1", "kind":"repository-manager", "options":{
            "title":"Repositories", "items":[{"id":"repo", "label":"Repository"}],
            "actions":[{"id":"open", "label":"Open"}]
        }});
        assert!(super::dialog_event_requires_dedicated_window(&event));
        let confirm = json!({"requestId":"request-2", "kind":"confirm"});
        assert!(!super::dialog_event_requires_dedicated_window(&confirm));
    }

    #[test]
    fn plugin_storage_updates_and_deletes_preserve_other_keys_and_plugin_isolation() {
        let root =
            std::env::temp_dir().join(format!("wstudio-storage-isolation-{}", Uuid::new_v4()));
        let first = root.join("plugins/data/com.example.first/storage.json");
        let second = root.join("plugins/data/com.example.second/storage.json");
        assert!(
            !super::get_plugin_storage_value(&first, "absent")
                .unwrap()
                .found
        );
        super::update_plugin_storage_value(&first, "keep".into(), Some(json!([1, 2])))
            .expect("set first value");
        super::update_plugin_storage_value(&first, "nullable".into(), Some(json!(null)))
            .expect("set JSON null");
        super::update_plugin_storage_value(&second, "keep".into(), Some(json!("other")))
            .expect("set second plugin value");
        assert_eq!(
            serde_json::to_value(super::get_plugin_storage_value(&first, "nullable").unwrap())
                .unwrap(),
            json!({"found": true, "value": null})
        );
        super::update_plugin_storage_value(&first, "nullable".into(), None).expect("delete value");
        super::update_plugin_storage_value(&first, "absent".into(), None)
            .expect("idempotent delete");
        assert_eq!(
            read_plugin_storage(&first).unwrap().get("keep"),
            Some(&json!([1, 2]))
        );
        assert_eq!(
            read_plugin_storage(&second).unwrap().get("keep"),
            Some(&json!("other"))
        );
        assert_eq!(
            serde_json::to_value(super::get_plugin_storage_value(&first, "nullable").unwrap())
                .unwrap(),
            json!({"found": false})
        );
        // Reload from disk instead of an in-memory cache.
        super::update_plugin_storage_value(&first, "keep".into(), Some(json!(false)))
            .expect("replace existing snapshot");
        assert_eq!(
            read_plugin_storage(&first).unwrap().get("keep"),
            Some(&json!(false))
        );
        fs::remove_dir_all(root).expect("clean test data");
    }

    #[test]
    fn plugin_storage_rejects_corruption_and_file_quota_without_losing_previous_data() {
        let root = std::env::temp_dir().join(format!("wstudio-storage-errors-{}", Uuid::new_v4()));
        let path = root.join("plugins/data/com.example.test/storage.json");
        super::update_plugin_storage_value(&path, "existing".into(), Some(json!("preserved")))
            .expect("initial storage");
        let original = fs::read(&path).unwrap();
        assert_eq!(
            super::update_plugin_storage_value(
                &path,
                "oversized".into(),
                Some(json!("x".repeat(super::MAX_PLUGIN_STORAGE_FILE_SIZE)))
            ),
            Err("PLUGIN_STORAGE_QUOTA_EXCEEDED".to_string())
        );
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        for content in ["{broken", "[]", "null"] {
            fs::write(&path, content).unwrap();
            assert_eq!(
                read_plugin_storage(&path),
                Err("PLUGIN_STORAGE_INVALID".to_string())
            );
            assert_eq!(
                super::update_plugin_storage_value(&path, "new".into(), Some(json!(1))),
                Err("PLUGIN_STORAGE_INVALID".to_string())
            );
            assert_eq!(fs::read_to_string(&path).unwrap(), content);
        }
        let file = fs::File::create(&path).unwrap();
        file.set_len(super::MAX_PLUGIN_STORAGE_FILE_SIZE as u64 + 1)
            .unwrap();
        drop(file);
        assert_eq!(
            read_plugin_storage(&path),
            Err("PLUGIN_STORAGE_INVALID".to_string())
        );
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert_eq!(
            read_plugin_storage(&path),
            Err("PLUGIN_STORAGE_INVALID".to_string())
        );
        fs::remove_dir_all(root).expect("clean test data");
    }

    #[test]
    fn plugin_storage_revocation_while_waiting_for_another_writer_preserves_snapshot() {
        let root = std::env::temp_dir().join(format!("wstudio-storage-lock-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("storage.json");
        fs::write(&path, br#"{"existing":"preserved"}"#).unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_root = root.clone();
        let holder = std::thread::spawn(move || {
            let _guard = super::workspace_lock::acquire(&lock_root, &|| Ok(())).unwrap();
            ready_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        });
        ready_rx.recv().unwrap();
        let start = std::time::Instant::now();
        let result = super::update_plugin_storage_value_checked(
            &path,
            "new".into(),
            Some(json!(1)),
            &|| {
                if start.elapsed() >= std::time::Duration::from_millis(40) {
                    Err("PLUGIN_RUNTIME_TERMINATED".into())
                } else {
                    Ok(())
                }
            },
        );
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        let snapshot = fs::read_to_string(&path).unwrap();
        fs::remove_dir_all(root).unwrap();
        assert_eq!(result, Err("PLUGIN_RUNTIME_TERMINATED".into()));
        assert_eq!(snapshot, r#"{"existing":"preserved"}"#);
    }

    #[test]
    fn plugin_storage_preserves_external_changes_after_reading_the_merge_baseline() {
        let root =
            std::env::temp_dir().join(format!("wstudio-storage-conflict-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("storage.json");
        fs::write(&path, br#"{"existing":"original"}"#).unwrap();
        let changed = std::cell::Cell::new(false);
        let result = super::update_plugin_storage_value_checked(
            &path,
            "new".into(),
            Some(json!(1)),
            &|| {
                let staged = fs::read_dir(&root).unwrap().any(|entry| {
                    entry
                        .unwrap()
                        .path()
                        .extension()
                        .is_some_and(|extension| extension == "tmp")
                });
                if staged && !changed.replace(true) {
                    fs::write(&path, br#"{"external":"preserved"}"#).unwrap();
                }
                Ok(())
            },
        );
        let snapshot = fs::read_to_string(&path).unwrap();
        let count = fs::read_dir(&root).unwrap().count();
        fs::remove_dir_all(root).unwrap();
        assert!(changed.get());
        assert_eq!(result, Err("PLUGIN_WRITE_CONFLICT".into()));
        assert_eq!(snapshot, r#"{"external":"preserved"}"#);
        assert_eq!(count, 1);
    }

    #[test]
    fn plugin_storage_cleans_abandoned_staging_before_merging() {
        let root =
            std::env::temp_dir().join(format!("wstudio-storage-recovery-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("storage.json");
        fs::write(&path, br#"{"keep":42}"#).unwrap();
        let abandoned = root.join(format!(
            ".wstudio-write-{}-abandoned.tmp",
            super::workspace_lock::staging_identity(&root).unwrap(),
        ));
        fs::write(&abandoned, b"partial").unwrap();
        fs::write(root.join("unrelated.tmp"), b"keep").unwrap();
        super::update_plugin_storage_value(&path, "new".into(), Some(json!(1))).unwrap();
        let values = read_plugin_storage(&path).unwrap();
        assert_eq!(values["keep"], json!(42));
        assert_eq!(values["new"], json!(1));
        assert!(!abandoned.exists());
        assert_eq!(fs::read(root.join("unrelated.tmp")).unwrap(), b"keep");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ancestor_cleanup_preserves_a_storage_commit_owned_by_another_thread() {
        let root = std::env::temp_dir().join(format!("wstudio-storage-cleanup-{}", Uuid::new_v4()));
        let directory = root.join("plugins/data/example");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("storage.json");
        fs::write(&path, br#"{"keep":42}"#).unwrap();
        let (staged_tx, staged_rx) = std::sync::mpsc::channel();
        let (cleaned_tx, cleaned_rx) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            let signaled = std::cell::Cell::new(false);
            super::update_plugin_storage_value_checked(&path, "new".into(), Some(json!(1)), &|| {
                let staged = fs::read_dir(&directory).unwrap().any(|entry| {
                    entry
                        .unwrap()
                        .path()
                        .extension()
                        .is_some_and(|extension| extension == "tmp")
                });
                if staged && !signaled.replace(true) {
                    staged_tx.send(()).unwrap();
                    cleaned_rx
                        .recv_timeout(std::time::Duration::from_secs(3))
                        .unwrap();
                }
                Ok(())
            })
        });
        staged_rx
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap();
        let guard = super::workspace_lock::acquire(&root, &|| Ok(())).unwrap();
        cleaned_tx.send(()).unwrap();
        let result = writer.join().unwrap();
        drop(guard);
        let snapshot =
            read_plugin_storage(&root.join("plugins/data/example/storage.json")).unwrap();
        fs::remove_dir_all(root).unwrap();
        assert_eq!(result, Ok(()));
        assert_eq!(snapshot["keep"], json!(42));
        assert_eq!(snapshot["new"], json!(1));
    }

    #[test]
    fn plugin_text_file_reads_utf8_metadata_and_content() {
        let root_path =
            std::env::temp_dir().join(format!("wstudio-plugin-read-text-{}", std::process::id()));
        fs::create_dir_all(&root_path).expect("create test directory");
        let root = root_path
            .canonicalize()
            .expect("canonicalize test directory");
        fs::write(root.join("note.txt"), "hello, 世界").expect("write test file");

        let file = read_plugin_text_file(&root, "note.txt").expect("read text file");
        assert_eq!(file.path, "note.txt");
        assert_eq!(file.name, "note.txt");
        assert_eq!(file.entry_type, "file");
        assert_eq!(file.encoding, "utf-8");
        assert_eq!(file.content, "hello, 世界");
        assert_eq!(file.size, "hello, 世界".len() as u64);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plugin_text_file_rejects_missing_directory_large_and_invalid_utf8_paths() {
        let root_path = std::env::temp_dir().join(format!(
            "wstudio-plugin-read-text-errors-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root_path).expect("create test directory");
        let root = root_path
            .canonicalize()
            .expect("canonicalize test directory");
        fs::create_dir_all(root.join("directory")).expect("create test directory");
        fs::write(root.join("invalid.txt"), [0xff, 0xfe]).expect("write invalid file");
        fs::write(
            root.join("large.txt"),
            vec![b'x'; MAX_PLUGIN_TEXT_FILE_SIZE as usize + 1],
        )
        .expect("write large file");

        assert_eq!(
            read_plugin_text_file(&root, "missing.txt").unwrap_err(),
            "PLUGIN_FILESYSTEM_NOT_FOUND"
        );
        assert_eq!(
            read_plugin_text_file(&root, "directory").unwrap_err(),
            "PLUGIN_FILESYSTEM_NOT_FILE"
        );
        assert_eq!(
            read_plugin_text_file(&root, "large.txt").unwrap_err(),
            "PLUGIN_FILESYSTEM_FILE_TOO_LARGE"
        );
        assert_eq!(
            read_plugin_text_file(&root, "invalid.txt").unwrap_err(),
            "PLUGIN_FILESYSTEM_ENCODING_UNSUPPORTED"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plugin_filesystem_stat_returns_file_and_directory_metadata() {
        let root_path =
            std::env::temp_dir().join(format!("wstudio-plugin-stat-{}", std::process::id()));
        fs::create_dir_all(root_path.join("nested")).expect("create test directory");
        fs::write(root_path.join("note.txt"), "hello").expect("write test file");
        let root = root_path
            .canonicalize()
            .expect("canonicalize test directory");

        let file = stat_plugin_filesystem_entry(&root, "note.txt").expect("stat file");
        assert_eq!(file.path, "note.txt");
        assert_eq!(file.name, "note.txt");
        assert_eq!(file.entry_type, "file");
        assert_eq!(file.size, 5);

        let directory = stat_plugin_filesystem_entry(&root, "nested").expect("stat directory");
        assert_eq!(directory.path, "nested");
        assert_eq!(directory.name, "nested");
        assert_eq!(directory.entry_type, "directory");
        assert_eq!(directory.size, 0);

        let workspace = stat_plugin_filesystem_entry(&root, ".").expect("stat workspace root");
        assert_eq!(workspace.path, ".");
        assert_eq!(workspace.name, ".");
        assert_eq!(workspace.entry_type, "directory");

        assert_eq!(
            stat_plugin_filesystem_entry(&root, "missing.txt").unwrap_err(),
            "PLUGIN_FILESYSTEM_NOT_FOUND"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plugin_text_file_write_checks_expected_content_and_size() {
        let root_path =
            std::env::temp_dir().join(format!("wstudio-plugin-write-text-{}", std::process::id()));
        fs::create_dir_all(&root_path).expect("create test directory");
        fs::write(root_path.join("note.txt"), "before").expect("write initial file");
        let root = root_path
            .canonicalize()
            .expect("canonicalize test directory");

        let updated = write_plugin_text_file(&root, "note.txt", "after", "before")
            .expect("write with matching expected content");
        assert_eq!(updated.content, "after");
        assert_eq!(
            fs::read_to_string(root.join("note.txt")).expect("read updated file"),
            "after"
        );
        assert_eq!(
            write_plugin_text_file(&root, "note.txt", "stale", "before").unwrap_err(),
            "PLUGIN_WRITE_CONFLICT"
        );
        assert_eq!(
            write_plugin_text_file(
                &root,
                "note.txt",
                &"x".repeat(MAX_PLUGIN_TEXT_FILE_SIZE as usize + 1),
                "after"
            )
            .unwrap_err(),
            "PLUGIN_FILESYSTEM_FILE_TOO_LARGE"
        );
        assert_eq!(
            fs::read_to_string(root.join("note.txt")).expect("read unchanged file"),
            "after"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plugin_text_file_create_requires_new_file_and_existing_parent() {
        let root_path =
            std::env::temp_dir().join(format!("wstudio-plugin-create-file-{}", std::process::id()));
        fs::create_dir_all(root_path.join("docs")).expect("create test directory");
        fs::write(root_path.join("existing.txt"), "old").expect("write existing file");
        let root = root_path
            .canonicalize()
            .expect("canonicalize test directory");

        let created =
            create_plugin_text_file(&root, "docs/new.txt", "new").expect("create text file");
        assert_eq!(created.content, "new");
        assert_eq!(
            create_plugin_text_file(&root, "existing.txt", "replacement").unwrap_err(),
            "PLUGIN_FILESYSTEM_ALREADY_EXISTS"
        );
        assert_eq!(
            create_plugin_text_file(&root, "missing/new.txt", "new").unwrap_err(),
            "PLUGIN_FILESYSTEM_PARENT_NOT_FOUND"
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("docs"), root.join("linked"))
                .expect("create symlink");
            assert_eq!(
                create_plugin_text_file(&root, "linked/symlink.txt", "new").unwrap_err(),
                "PLUGIN_FILESYSTEM_SYMLINK_NOT_ALLOWED"
            );
        }
        assert_eq!(
            create_plugin_text_file(
                &root,
                "docs/large.txt",
                &"x".repeat(MAX_PLUGIN_TEXT_FILE_SIZE as usize + 1)
            )
            .unwrap_err(),
            "PLUGIN_FILESYSTEM_FILE_TOO_LARGE"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plugin_directory_create_checks_recursive_parent_and_existing_target() {
        let root_path = std::env::temp_dir().join(format!(
            "wstudio-plugin-create-directory-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root_path).expect("create test directory");
        let root = root_path
            .canonicalize()
            .expect("canonicalize test directory");

        assert_eq!(
            create_plugin_directory(&root, "nested/child", false).unwrap_err(),
            "PLUGIN_FILESYSTEM_PARENT_NOT_FOUND"
        );
        let created = create_plugin_directory(&root, "nested/child", true)
            .expect("create recursive directory");
        assert_eq!(created.path, "nested/child");
        assert_eq!(created.entry_type, "directory");
        assert_eq!(
            create_plugin_directory(&root, "nested/child", true).unwrap_err(),
            "PLUGIN_FILESYSTEM_ALREADY_EXISTS"
        );
        assert_eq!(
            create_plugin_directory(&root, "../outside", true).unwrap_err(),
            "PLUGIN_FILESYSTEM_PATH_INVALID"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plugin_filesystem_delete_protects_root_and_nonempty_directories() {
        let root_path =
            std::env::temp_dir().join(format!("wstudio-plugin-delete-{}", std::process::id()));
        fs::create_dir_all(root_path.join("nested")).expect("create test directory");
        fs::write(root_path.join("nested/file.txt"), "content").expect("write test file");
        let root = root_path
            .canonicalize()
            .expect("canonicalize test directory");

        assert_eq!(
            delete_plugin_path(&root, "nested", false).unwrap_err(),
            "PLUGIN_FILESYSTEM_DIRECTORY_NOT_EMPTY"
        );
        assert_eq!(
            delete_plugin_path(&root, ".", true).unwrap_err(),
            "PLUGIN_FILESYSTEM_ROOT_PROTECTED"
        );
        delete_plugin_path(&root, "nested", true).expect("delete recursive directory");
        assert!(!root.join("nested").exists());
        assert_eq!(
            delete_plugin_path(&root, "missing.txt", false).unwrap_err(),
            "PLUGIN_FILESYSTEM_NOT_FOUND"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plugin_filesystem_move_rename_and_copy_preserve_tree_and_scopes() {
        let root_path =
            std::env::temp_dir().join(format!("wstudio-plugin-transfer-{}", std::process::id()));
        fs::create_dir_all(root_path.join("source/nested")).expect("create source tree");
        fs::create_dir_all(root_path.join("target")).expect("create target directory");
        fs::write(root_path.join("source/nested/file.txt"), "payload").expect("write source file");
        fs::write(root_path.join("target/rename.txt"), "rename").expect("write rename file");
        let root = root_path
            .canonicalize()
            .expect("canonicalize test directory");
        let manifest = json!({
            "permissions": [
                {"id": "workspace.read", "scope": ["**"]},
                {"id": "workspace.write", "scope": ["**"]}
            ]
        });

        let copied = copy_plugin_path(&root, &manifest, "source", "source-copy", true)
            .expect("copy recursive directory");
        assert_eq!(copied.entry_type, "directory");
        assert_eq!(
            fs::read_to_string(root.join("source-copy/nested/file.txt")).expect("read copied file"),
            "payload"
        );
        assert_eq!(
            copy_plugin_path(&root, &manifest, "source", "source-no-recursion", false).unwrap_err(),
            "PLUGIN_FILESYSTEM_RECURSIVE_REQUIRED"
        );
        let renamed = move_plugin_path(&root, &manifest, "target/rename.txt", "target/renamed.txt")
            .expect("rename file through move");
        assert_eq!(renamed.name, "renamed.txt");
        let moved = move_plugin_path(&root, &manifest, "source-copy", "target/source-copy")
            .expect("move copied directory");
        assert_eq!(moved.path, "target/source-copy");

        let restricted_manifest = json!({
            "permissions": [
                {"id": "workspace.read", "scope": ["source/**"]},
                {"id": "workspace.write", "scope": ["target/**"]}
            ]
        });
        assert_eq!(
            copy_plugin_path(
                &root,
                &restricted_manifest,
                "source",
                "target/allowed-copy",
                true
            )
            .unwrap_err(),
            "PLUGIN_PERMISSION_SCOPE_VIOLATION"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plugin_protection_round_trips_and_rejects_wrong_password_without_mutation() {
        let root_path =
            std::env::temp_dir().join(format!("wstudio-plugin-protection-{}", std::process::id()));
        fs::create_dir_all(&root_path).expect("create test directory");
        let original = b"existing WStudio protected file compatibility payload";
        fs::write(root_path.join("secret.bin"), original).expect("write original file");
        let root = root_path
            .canonicalize()
            .expect("canonicalize test directory");

        let encrypted = protect_plugin_file(&root, "secret.bin", "correct-password", true)
            .expect("encrypt file");
        assert!(encrypted.encrypted);
        let encrypted_bytes = fs::read(root.join("secret.bin")).expect("read encrypted file");
        assert_eq!(&encrypted_bytes[..8], b"WSTUDIO3");
        assert_eq!(encrypted_bytes[8], 1);
        assert_ne!(encrypted_bytes, original);
        assert_eq!(
            protect_plugin_file(&root, "secret.bin", "correct-password", true).unwrap_err(),
            "PLUGIN_FILESYSTEM_ALREADY_ENCRYPTED"
        );
        assert_eq!(
            protect_plugin_file(&root, "secret.bin", "wrong-password", false).unwrap_err(),
            "PLUGIN_FILESYSTEM_DECRYPT_FAILED"
        );
        assert_eq!(
            fs::read(root.join("secret.bin")).expect("confirm unchanged ciphertext"),
            encrypted_bytes
        );

        let decrypted = protect_plugin_file(&root, "secret.bin", "correct-password", false)
            .expect("decrypt file");
        assert!(!decrypted.encrypted);
        assert_eq!(
            fs::read(root.join("secret.bin")).expect("read plaintext"),
            original
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plugin_external_permission_requires_manifest_declaration() {
        let manifest = json!({
            "permissions": [{ "id": "external.open" }]
        });
        assert!(plugin_permission_is_declared(&manifest, "external.open"));
        assert!(!plugin_permission_is_declared(&manifest, "clipboard.write"));
        assert!(!plugin_permission_is_declared(&json!({}), "external.open"));
    }

    #[test]
    fn plugin_external_workspace_paths_require_read_permission_and_scope() {
        let root = std::env::temp_dir().join(format!("wstudio-external-path-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("notes")).expect("create allowed directory");
        fs::create_dir_all(root.join("private")).expect("create private directory");
        fs::write(root.join("notes/note.md"), "note").expect("write allowed file");
        fs::write(root.join("private/secret.md"), "secret").expect("write private file");
        let root = root.canonicalize().expect("canonicalize workspace");
        let manifest = json!({"permissions":[
            {"id":"workspace.read","scope":["notes/**"]},
            {"id":"external.open"}
        ]});

        assert_eq!(
            resolve_plugin_external_workspace_path(&manifest, &root, "notes/note.md").unwrap(),
            root.join("notes/note.md")
        );
        assert_eq!(
            resolve_plugin_external_workspace_path(&manifest, &root, "private/secret.md")
                .unwrap_err(),
            "PLUGIN_PERMISSION_SCOPE_VIOLATION"
        );
        assert_eq!(
            resolve_plugin_external_workspace_path(&manifest, &root, "../outside").unwrap_err(),
            "PLUGIN_FILESYSTEM_PATH_INVALID"
        );
        assert_eq!(
            resolve_plugin_external_workspace_path(
                &json!({"permissions":[{"id":"external.open"}]}),
                &root,
                "notes/note.md"
            )
            .unwrap_err(),
            "PLUGIN_PERMISSION_NOT_DECLARED"
        );
        std::fs::remove_dir_all(root).expect("remove test workspace");
    }

    #[test]
    fn workspace_file_changes_reports_created_modified_and_deleted_paths() {
        let root = std::env::temp_dir().join(format!("wstudio-changes-{}", std::process::id()));
        let notes = root.join("notes");
        fs::create_dir_all(&notes).expect("create test directory");
        let created = notes.join("created.md");
        let modified = notes.join("modified.md");
        let deleted = notes.join("deleted.md");
        let unchanged = notes.join("unchanged.md");
        let previous = std::collections::HashMap::from([
            (modified.to_string_lossy().into_owned(), 1),
            (deleted.to_string_lossy().into_owned(), 2),
            (unchanged.to_string_lossy().into_owned(), 3),
        ]);
        let current = std::collections::HashMap::from([
            (created.to_string_lossy().into_owned(), 4),
            (modified.to_string_lossy().into_owned(), 5),
            (unchanged.to_string_lossy().into_owned(), 3),
        ]);

        let changes = workspace_file_changes(&root, "repo-1", &previous, &current);
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].path, "notes/created.md");
        assert_eq!(changes[0].kind, super::WorkspaceFileChangeKind::Created);
        assert_eq!(changes[1].path, "notes/deleted.md");
        assert_eq!(changes[1].kind, super::WorkspaceFileChangeKind::Deleted);
        assert_eq!(changes[2].path, "notes/modified.md");
        assert_eq!(changes[2].kind, super::WorkspaceFileChangeKind::Modified);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn local_media_range_supports_open_ended_and_suffix_ranges() {
        assert!(matches!(
            local_media_range(None, 100),
            LocalMediaRange::None
        ));
        assert!(matches!(
            local_media_range(Some("bytes=10-20"), 100),
            LocalMediaRange::Range { start: 10, end: 20 }
        ));
        assert!(matches!(
            local_media_range(Some("bytes=90-"), 100),
            LocalMediaRange::Range { start: 90, end: 99 }
        ));
        assert!(matches!(
            local_media_range(Some("bytes=-10"), 100),
            LocalMediaRange::Range { start: 90, end: 99 }
        ));
        assert!(matches!(
            local_media_range(Some("bytes=100-"), 100),
            LocalMediaRange::Unsatisfiable
        ));
    }

    #[test]
    fn sql_request_rejects_empty_or_unsupported_values() {
        assert_eq!(
            normalize_sql_request(&SqlQueryRequest {
                sql: " ".to_string(),
                params: None
            })
            .unwrap_err(),
            "SQL_QUERY_REQUIRED"
        );
        assert_eq!(
            json_to_sql_value(&json!({"nested": true})).unwrap_err(),
            "SQL_PARAMETERS_INVALID"
        );
        let request = SqlQueryRequest {
            sql: "SELECT ?".to_string(),
            params: Some(vec![json!("ok"), json!(2)]),
        };
        assert_eq!(
            normalize_sql_request(&request).expect("valid params").len(),
            2
        );
    }

    #[test]
    fn font_family_names_drop_file_type_and_style_suffixes() {
        assert_eq!(
            normalize_font_family_name("Microsoft YaHei Bold (TrueType)"),
            "Microsoft YaHei"
        );
        assert_eq!(
            normalize_font_family_name("Source_Code_Pro-Italic"),
            "Source Code Pro"
        );
    }

    /// Bare provider origins use the standard API prefix; explicit bases remain intact.
    #[test]
    fn ai_chat_url_preserves_configured_provider_base_path() {
        for (base, expected) in [
            (
                "https://fixture.example",
                "https://fixture.example/v1/chat/completions",
            ),
            (
                "https://fixture.example/",
                "https://fixture.example/v1/chat/completions",
            ),
            (
                "https://fixture.example/v1",
                "https://fixture.example/v1/chat/completions",
            ),
            (
                "https://fixture.example/compatible-mode/v1/",
                "https://fixture.example/compatible-mode/v1/chat/completions",
            ),
            (
                "https://fixture.example/chat/completions",
                "https://fixture.example/chat/completions",
            ),
        ] {
            assert_eq!(
                super::append_ai_chat_path(base, "/chat/completions").unwrap(),
                expected
            );
        }
        assert_eq!(
            super::append_ai_chat_path("https://fixture.example", "/responses").unwrap(),
            "https://fixture.example/v1/responses"
        );
        assert_eq!(
            super::append_ai_chat_path("https://fixture.example", "/messages").unwrap(),
            "https://fixture.example/v1/messages"
        );
    }

    /// Gemini's models base is shared by tests and native content streaming.
    #[test]
    fn ai_gemini_uses_models_endpoint_and_native_content_schema() {
        for base in [
            "https://generativelanguage.googleapis.com",
            "https://generativelanguage.googleapis.com/v1beta",
            "https://generativelanguage.googleapis.com/v1beta/models/",
        ] {
            let request = super::AiChatBridgeRequest {
                model: super::AiChatBridgeModel {
                    id: "models/gemini-fixture".into(),
                    endpoint_type: "gemini".into(),
                    api_endpoint: base.into(),
                    api_key: "fixture-key".into(),
                },
                messages: vec![
                    super::AiChatBridgeMessage {
                        role: "system".into(),
                        content: "Be concise".into(),
                        name: None,
                    },
                    super::AiChatBridgeMessage {
                        role: "user".into(),
                        content: "Hello".into(),
                        name: None,
                    },
                    super::AiChatBridgeMessage {
                        role: "assistant".into(),
                        content: "Hi".into(),
                        name: None,
                    },
                ],
                temperature: Some(0.5),
                max_tokens: Some(256),
            };
            let (url, headers, body) = super::build_ai_chat_request(&request).unwrap();
            assert_eq!(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse");
            assert_eq!(headers, vec![("x-goog-api-key", "fixture-key".into())]);
            assert_eq!(
                body,
                json!({
                    "systemInstruction":{"parts":[{"text":"Be concise"}]},
                    "contents":[{"role":"user","parts":[{"text":"Hello"}]},{"role":"model","parts":[{"text":"Hi"}]}],
                    "generationConfig":{"temperature":0.5,"maxOutputTokens":256}
                })
            );
            let (test_url, test_headers, test_body) =
                super::build_gemini_content_request(&request, false).unwrap();
            assert_eq!(test_url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-fixture:generateContent");
            assert_eq!(test_headers, headers);
            assert_eq!(test_body, body);
        }
    }

    /// Native Gemini streams include multiple text parts, thought parts and token metadata.
    #[test]
    fn ai_gemini_stream_reads_text_finish_reason_and_usage() {
        let events = super::parse_ai_provider_event("gemini", "", &json!({
            "candidates":[{"content":{"parts":[{"text":"private thought","thought":true},{"text":"Hello"},{"text":" world"}]},"finishReason":"STOP"}],
            "usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3,"totalTokenCount":5}
        }).to_string()).unwrap();
        assert!(
            matches!(events.as_slice(), [super::AiProviderEvent::Delta(text), super::AiProviderEvent::Completed(Some(reason)), super::AiProviderEvent::Usage{ input_tokens:Some(2),output_tokens:Some(3),total_tokens:Some(5) }] if text == "Hello world" && reason == "STOP")
        );
    }

    /// Existing editor windows receive the persisted snapshot before the test returns.
    #[test]
    fn ai_connection_test_publishes_connected_models_immediately() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        super::initialize_database(&connection).unwrap();
        connection.execute("INSERT INTO ai_models (configuration_id, id, name, group_name, endpoint_type, connection_succeeded, created_at, updated_at) VALUES ('default', 'fixture-model', 'Fixture Model', 'Fixture Group', 'openai', 0, 1, 1)", []).unwrap();
        assert!(super::list_connected_models(&connection)
            .unwrap()
            .is_empty());
        for success in [true, true, false] {
            let mut published = None;
            super::save_ai_connection_test_result(
                &connection,
                "default",
                "fixture-model",
                success,
                |models| {
                    // The database is authoritative when the event reaches the renderer.
                    let saved: bool = connection
                        .query_row(
                            "SELECT connection_succeeded FROM ai_models WHERE id = 'fixture-model'",
                            [],
                            |row| row.get(0),
                        )
                        .unwrap();
                    assert_eq!(saved, success);
                    published = Some(models);
                    Ok(())
                },
            )
            .unwrap();
            let models = published.expect("model change event must be published before returning");
            assert_eq!(models.len(), usize::from(success));
            if success {
                assert_eq!(models[0].configuration_id, "default");
                assert_eq!(models[0].id, "fixture-model");
                assert_eq!(models[0].name, "Fixture Model");
                assert_eq!(models[0].group_name, "Fixture Group");
                assert_eq!(models[0].endpoint_type, "openai");
            }
        }
    }

    /// Connection tests validate API envelopes, including HTTP-200 error payloads.
    #[test]
    fn ai_connection_response_requires_protocol_envelope() {
        for protocol in ["openai", "openai-response", "anthropic", "gemini"] {
            assert!(!super::is_ai_connection_response(
                protocol,
                &json!({"message":"website"})
            ));
            assert!(!super::is_ai_connection_response(
                protocol,
                &json!({"error":{"message":"unavailable"}})
            ));
        }
        for (protocol, payload) in [
            (
                "openai",
                json!({"choices":[{"message":{"role":"assistant","content":"OK"}}]}),
            ),
            (
                "openai-response",
                json!({"output":[{"content":[{"text":"OK"}]}]}),
            ),
            (
                "anthropic",
                json!({"content":[{"type":"text","text":"OK"}]}),
            ),
            (
                "gemini",
                json!({"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}),
            ),
        ] {
            assert!(super::is_ai_connection_response(protocol, &payload));
        }
    }

    /// Website fallback pages fail while valid SSE responses with a charset remain usable.
    #[test]
    fn ai_provider_rejects_successful_html_response() {
        use std::io::{Read, Write};
        for (content_type, body, valid) in [
            (
                "text/html; charset=utf-8",
                "<!doctype html><title>Provider website</title>",
                false,
            ),
            (
                "text/event-stream; charset=utf-8",
                "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n",
                true,
            ),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut buffer = [0; 4096];
                socket.read(&mut buffer).unwrap();
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            });
            let result = tokio::runtime::Runtime::new().unwrap().block_on(async {
                super::send_ai_provider_request(
                    &reqwest::Client::builder().no_proxy().build().unwrap(),
                    &format!("http://{address}/chat/completions"),
                    &[],
                    &json!({"stream": true}),
                    &super::AiChatRunControl::new(),
                )
                .await
                .map(|response| response.status().as_u16())
            });
            server.join().unwrap();
            if valid {
                assert_eq!(result.unwrap(), 200);
            } else {
                assert!(matches!(result, Err(("PROTOCOL", _, Some(200)))));
            }
        }
    }

    /// A finished AI stream remains successful when its proxy closes HTTP abruptly.
    #[test]
    fn ai_provider_stops_at_done_before_broken_http_trailer() {
        use std::io::{Read, Write};
        // A proxy may close chunked HTTP without its final zero-length chunk.
        // The AI protocol's DONE marker is authoritative; a partial reply is still an error.
        for complete in [true, false] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut buffer = [0; 4096];
                socket.read(&mut buffer).unwrap();
                let mut body =
                    "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\n".to_string();
                if complete {
                    body.push_str("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3}}\n\ndata: [DONE]\n\n");
                }
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{body}\r\n", body.len()).unwrap();
                socket.flush().unwrap();
            });
            let mut events = Vec::new();
            let request = super::AiChatBridgeRequest {
                model: super::AiChatBridgeModel {
                    id: "fixture".into(),
                    endpoint_type: "openai".into(),
                    api_endpoint: format!("http://{address}"),
                    api_key: "fixture".into(),
                },
                messages: vec![super::AiChatBridgeMessage {
                    role: "user".into(),
                    content: "Hello".into(),
                    name: None,
                }],
                temperature: None,
                max_tokens: None,
            };
            let result = tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(super::run_ai_provider(
                    "fixture",
                    &request,
                    &super::AiChatRunControl::new(),
                    |event| events.push(event),
                ));
            server.join().unwrap();
            assert!(events.iter().any(|event| matches!(event, super::AiChatBridgeEvent::Delta { text, .. } if text == "OK")));
            if complete {
                assert_eq!(result.unwrap(), Some("stop".into()));
                assert!(events.iter().any(|event| matches!(
                    event,
                    super::AiChatBridgeEvent::Usage {
                        total_tokens: Some(3),
                        ..
                    }
                )));
            } else {
                assert!(matches!(result, Err(("NETWORK", _, _))));
            }
        }
    }

    /// Transport failures identify the response stage without exposing credentials or URLs.
    #[test]
    fn ai_provider_reports_disconnect_before_response() {
        use std::io::Read;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for _ in 0..=super::AI_PROVIDER_RETRY_DELAYS_MS.len() {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut buffer = [0; 4096];
                socket.read(&mut buffer).unwrap();
            }
        });
        let result = tokio::runtime::Runtime::new().unwrap().block_on(async {
            super::send_ai_provider_request(
                &reqwest::Client::builder().no_proxy().build().unwrap(),
                &format!("http://{address}/chat/completions?token=fixture-secret"),
                &[],
                &json!({"stream": true}),
                &super::AiChatRunControl::new(),
            )
            .await
        });
        server.join().unwrap();
        let (code, message, status) = result.unwrap_err();
        assert_eq!(code, "NETWORK");
        assert_eq!(message, "AI provider disconnected before response");
        assert_eq!(status, None);
        assert!(!message.contains("fixture-secret"));
    }

    /// All native chat events must retain the renderer's session and camelCase contract.
    #[test]
    fn ai_chat_bridge_events_match_renderer_contract() {
        use super::{AiChatBridgeError, AiChatBridgeEvent};

        let cases = [
            (
                AiChatBridgeEvent::Delta {
                    session_id: "chat-fixture".into(),
                    text: "hello".into(),
                },
                json!({"type": "delta", "sessionId": "chat-fixture", "text": "hello"}),
            ),
            (
                AiChatBridgeEvent::Usage {
                    session_id: "chat-fixture".into(),
                    input_tokens: Some(2),
                    output_tokens: Some(3),
                    total_tokens: Some(5),
                },
                json!({"type": "usage", "sessionId": "chat-fixture", "inputTokens": 2,
                    "outputTokens": 3, "totalTokens": 5}),
            ),
            (
                AiChatBridgeEvent::Completed {
                    session_id: "chat-fixture".into(),
                    finish_reason: Some("stop".into()),
                },
                json!({"type": "completed", "sessionId": "chat-fixture", "finishReason": "stop"}),
            ),
            (
                AiChatBridgeEvent::Cancelled {
                    session_id: "chat-fixture".into(),
                },
                json!({"type": "cancelled", "sessionId": "chat-fixture"}),
            ),
            (
                AiChatBridgeEvent::Error {
                    session_id: "chat-fixture".into(),
                    error: AiChatBridgeError {
                        code: "HTTP".into(),
                        message: "AI provider request failed".into(),
                        status: Some(401),
                    },
                },
                json!({"type": "error", "sessionId": "chat-fixture",
                    "error": {"code": "HTTP", "message": "AI provider request failed", "status": 401}}),
            ),
        ];

        for (event, expected) in cases {
            assert_eq!(
                serde_json::to_value(event).expect("serialize chat event"),
                expected
            );
        }
    }

    #[test]
    fn ai_provider_events_normalize_stream_deltas_and_completion() {
        assert!(matches!(
            parse_ai_provider_event(
                "openai",
                "",
                r#"{"choices":[{"delta":{"content":"hello"}}]}"#
            )
            .expect("valid OpenAI event")
            .as_slice(),
            [AiProviderEvent::Delta(text)] if text == "hello"
        ));
        assert!(matches!(
            parse_ai_provider_event("openai", "", "[DONE]")
                .expect("done event")
                .as_slice(),
            [AiProviderEvent::Completed(None)]
        ));
        // Text/item completion precedes response completion; it must not end a Responses stream.
        for kind in ["response.output_text.done", "response.output_item.done"] {
            assert!(parse_ai_provider_event(
                "openai-response",
                "",
                &json!({"type": kind}).to_string()
            )
            .unwrap()
            .iter()
            .all(|event| !matches!(event, AiProviderEvent::Completed(_))));
        }
        assert!(matches!(
            parse_ai_provider_event("openai-response", "", r#"{"type":"response.completed"}"#)
                .unwrap()
                .as_slice(),
            [AiProviderEvent::Completed(_)]
        ));
    }

    #[test]
    fn ai_provider_retry_policy_only_retries_transient_statuses() {
        for status in [408, 409, 425, 429, 500, 503, 599] {
            assert!(is_retryable_ai_provider_status(status), "{status}");
        }
        for status in [200, 400, 401, 403, 404, 422] {
            assert!(!is_retryable_ai_provider_status(status), "{status}");
        }
        assert_eq!(super::AI_PROVIDER_RETRY_DELAYS_MS, [400, 1_000]);
    }

    #[test]
    fn theme_inputs_reject_path_escape_and_invalid_variants() {
        assert!(normalize_theme_category("../outside").is_err());
        assert_eq!(
            normalize_theme_file_name("invalid", "wstudio-light"),
            "wstudio-light.json"
        );
        assert!(validate_theme_variant(json!({
            "id": "light",
            "name": "light",
            "displayName": "Light",
            "type": "light",
            "colors": {}
        }))
        .is_ok());
        assert!(validate_theme_variant(json!({"id": "missing-colors"})).is_err());
    }

    #[test]
    fn plugin_manifest_summary_marks_unhosted_core_plugins_blocked() {
        let summary = plugin_summary_from_manifest(&json!({
            "id": "com.example.plugin",
            "name": "Example",
            "version": "1.0.0",
            "description": "Example plugin",
            "author": {"name": "WStudio"},
            "permissions": [{"id": "workspace.read", "reason": "Read files", "scope": ["**"]}]
        }))
        .expect("valid plugin manifest");
        assert_eq!(summary["state"], "blocked");
        assert_eq!(summary["isCore"], true);
        assert_eq!(summary["permissions"][0], "workspace.read");
    }

    #[test]
    fn plugin_contribution_summary_reads_manifest_extensions_without_runtime_urls() {
        let summary = plugin_contribution_summary_from_manifest(&json!({
            "id": "com.example.plugin",
            "name": "Example",
            "version": "1.0.0",
            "permissions": [{"id": "workspace.read"}],
            "contributes": {
                "commands": [{"id": "com.example.open", "title": "Open"}],
                "views": [{"type": "com.example.view", "title": "View"}],
                "settings": [{"id": "com.example.settings", "title": "Settings", "fields": []}],
                "statusBar": [{"id": "com.example.status", "text": "Ready"}]
            }
        }))
        .expect("valid contribution manifest");
        assert_eq!(summary["pluginId"], "com.example.plugin");
        assert_eq!(summary["entryUrl"], "");
        assert_eq!(summary["stylesUrl"], "");
        assert_eq!(summary["commands"][0]["id"], "com.example.open");
        assert_eq!(summary["views"][0]["type"], "com.example.view");
        assert_eq!(summary["settings"][0]["id"], "com.example.settings");
        assert_eq!(summary["statusBar"][0]["id"], "com.example.status");
    }

    #[test]
    fn plugin_settings_normalize_defaults_and_reject_invalid_values() {
        let manifest = json!({
            "contributes": {
                "settings": [{
                    "id": "com.example.settings",
                    "fields": [
                        {"id": "com.example.text", "type": "text", "defaultValue": "default"},
                        {"id": "com.example.count", "type": "number", "min": 1},
                        {"id": "com.example.mode", "type": "select", "options": [
                            {"label": "One", "value": "one"},
                            {"label": "Two", "value": "two"}
                        ]}
                    ]
                }]
            }
        });
        let setting = plugin_setting_definition(&manifest, "com.example.settings")
            .expect("setting definition");
        let mut raw = serde_json::Map::new();
        raw.insert("com.example.text".to_string(), json!("saved"));
        raw.insert("com.example.count".to_string(), json!(0));
        raw.insert("com.example.mode".to_string(), json!("invalid"));
        let values = normalize_plugin_settings(setting, &raw).expect("normalized settings");
        assert_eq!(values["com.example.text"], "saved");
        assert_eq!(values["com.example.count"], 1);
        assert_eq!(values["com.example.mode"], "one");
        let count = setting["fields"][1].clone();
        assert!(!plugin_setting_value_is_valid(&count, &json!(0)));
        assert!(plugin_setting_value_is_valid(&count, &json!(2)));
    }

    #[test]
    fn plugin_command_validation_distinguishes_declared_and_missing_commands() {
        let manifest = json!({
            "contributes": {
                "commands": [{"id": "com.example.open", "title": "Open"}]
            }
        });
        assert!(plugin_command_is_declared(&manifest, "com.example.open"));
        assert!(!plugin_command_is_declared(
            &manifest,
            "com.example.missing"
        ));
        assert!(validate_plugin_command(&manifest, "com.example.open").is_ok());
        assert_eq!(
            validate_plugin_command(&manifest, "com.example.missing"),
            Err("PLUGIN_COMMAND_NOT_DECLARED".to_string())
        );
        assert_eq!(
            validate_plugin_command(&manifest, " "),
            Err("PLUGIN_COMMAND_NOT_DECLARED".to_string())
        );
    }

    #[test]
    fn plugin_editor_reveal_range_validates_vertical_alignment() {
        assert!(plugin_editor_vertical_alignment_is_valid(None));
        assert!(plugin_editor_vertical_alignment_is_valid(Some("nearest")));
        assert!(plugin_editor_vertical_alignment_is_valid(Some("center")));
        assert!(plugin_editor_vertical_alignment_is_valid(Some(
            "upper-center"
        )));
        assert!(!plugin_editor_vertical_alignment_is_valid(Some("top")));
    }

    #[test]
    fn plugin_view_request_validation_requires_stable_identity() {
        let valid = PluginViewRequest {
            plugin_id: "com.example.plugin".to_string(),
            view_type: "com.example.view".to_string(),
            instance_id: "instance-1".to_string(),
            initial_url: Some("https://example.com".to_string()),
            runtime_id: "generation-one".into(),
        };
        assert!(plugin_view_request_is_valid(&valid));
        assert!(!plugin_view_request_is_valid(&PluginViewRequest {
            instance_id: String::new(),
            ..valid
        }));
    }

    #[test]
    fn plugin_view_bounds_validation_rejects_non_finite_or_oversized_values() {
        let request = PluginViewBoundsRequest {
            occlusions: Vec::new(),
            scrollbar_theme: None,
            plugin_id: "com.example.plugin".to_string(),
            view_type: "com.example.view".to_string(),
            instance_id: "instance-1".to_string(),
            initial_url: None,
            runtime_id: "generation-one".into(),
            bounds: PluginViewBounds {
                x: 0.0,
                y: 0.0,
                width: 640.0,
                height: 480.0,
            },
        };
        assert!(plugin_view_bounds_request_is_valid(&request));
        let mut invalid = request;
        invalid.occlusions.push(PluginViewBounds {
            x: 10.0,
            y: 20.0,
            width: f64::NAN,
            height: 100.0,
        });
        assert!(!plugin_view_bounds_request_is_valid(&invalid));
        invalid.occlusions[0].width = 100.0;
        assert!(plugin_view_bounds_request_is_valid(&invalid));
        invalid.occlusions.extend((0..64).map(|_| PluginViewBounds {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        }));
        assert!(!plugin_view_bounds_request_is_valid(&invalid));
        invalid.occlusions.clear();
        invalid.bounds.width = f64::INFINITY;
        assert!(!plugin_view_bounds_request_is_valid(&invalid));
    }

    #[test]
    fn plugin_window_geometry_uses_logical_pixels_at_high_dpi() {
        let ((x, y), (width, height)) =
            physical_window_geometry_to_logical((150, 75), (1500, 900), 1.5)
                .expect("valid scale factor");
        assert_eq!((x, y), (100.0, 50.0));
        assert_eq!((width, height), (1000.0, 600.0));
    }

    #[test]
    fn child_window_position_is_centered_inside_host_bounds() {
        assert_eq!(
            center_position_within_host((100.0, 80.0), (1200.0, 800.0), (760.0, 600.0)),
            (320.0, 180.0)
        );
    }

    #[test]
    fn plugin_window_query_routes_declared_view_to_the_tab_host() {
        let request = PluginWindowOpenRequest {
            kind: Some("plugin".to_string()),
            plugin_id: Some("com.example.viewer".to_string()),
            view_type: Some("com.example.viewer.browser".to_string()),
            ..PluginWindowOpenRequest::default()
        };
        for initial_url in [None, Some("https://example.com/?windowPage=settings&x=1")] {
            let query = plugin_window_query(&request, "plugin", "instance-1", initial_url);
            let parsed = reqwest::Url::parse(&format!("http://tauri.localhost/{query}")).unwrap();
            let params: std::collections::HashMap<_, _> = parsed.query_pairs().collect();
            assert_eq!(
                params.get("windowMode").map(|value| value.as_ref()),
                Some("tab")
            );
            assert!(!params.contains_key("windowPage"));
            assert_eq!(
                params.get("pluginId").map(|value| value.as_ref()),
                Some("com.example.viewer")
            );
            assert_eq!(
                params.get("pluginViewType").map(|value| value.as_ref()),
                Some("com.example.viewer.browser")
            );
            assert_eq!(
                params.get("pluginInstanceId").map(|value| value.as_ref()),
                Some("instance-1")
            );
            assert_eq!(
                params.get("pluginUrl").map(|value| value.as_ref()),
                initial_url
            );
        }
    }

    #[test]
    fn workbench_file_window_query_carries_initial_file_path() {
        let request = PluginWindowOpenRequest {
            kind: Some("workbench".to_string()),
            file_path: Some("nested/note.md".to_string()),
            ..PluginWindowOpenRequest::default()
        };
        let query = plugin_window_query(&request, "workbench", "instance-1", None);
        assert!(query.starts_with("index.html?windowMode=tab&initialFilePath=nested%2Fnote.md"));
    }

    #[test]
    fn workspace_file_kind_matches_supported_text_and_media_extensions() {
        assert_eq!(
            workspace_file_kind(Path::new("saved.URL")),
            Some(("text", None))
        );
        assert_eq!(
            workspace_file_kind(Path::new("note.md")),
            Some(("text", None))
        );
        assert_eq!(
            workspace_file_kind(Path::new("image.PNG")),
            Some(("image", Some("image/png")))
        );
        assert_eq!(workspace_file_kind(Path::new("archive.zip")), None);
    }

    #[test]
    fn workspace_open_file_request_preserves_text_payload_and_disposition() {
        let root_path = std::env::temp_dir().join(format!(
            "wstudio-workspace-open-file-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root_path).expect("create test directory");
        let root = root_path
            .canonicalize()
            .expect("canonicalize test directory");
        fs::write(root.join("note.md"), "# Heading\ncontent").expect("write markdown file");

        let payload = build_workspace_open_file_request(&root, "note.md", Some("new-group"))
            .expect("build open request")
            .expect("request exists");
        assert_eq!(payload["relativePath"], "note.md");
        assert_eq!(payload["kind"], "text");
        assert_eq!(payload["content"], "# Heading\ncontent");
        assert_eq!(payload["disposition"], "new-group");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plugin_markdown_enumeration_enforces_scope_limit_and_activity() {
        let root_path =
            std::env::temp_dir().join(format!("wstudio-plugin-markdown-list-{}", Uuid::new_v4()));
        fs::create_dir_all(root_path.join("allowed")).expect("create allowed directory");
        fs::create_dir_all(root_path.join("private")).expect("create private directory");
        fs::write(root_path.join("allowed/a.md"), "allowed").expect("write first markdown");
        fs::write(root_path.join("allowed/b.md"), "second").expect("write second markdown");
        fs::write(root_path.join("private/secret.md"), "secret").expect("write private markdown");
        let root = root_path
            .canonicalize()
            .expect("canonicalize test directory");
        let manifest = json!({"permissions":[{"id":"workspace.read","scope":["allowed/**"]}]});
        let mut files = Vec::<WorkspaceMarkdownFileMetadata>::new();
        let active_checks = std::cell::Cell::new(0);
        collect_scoped_markdown_files(
            &root,
            &root,
            &mut files,
            1,
            &|relative| plugin_path_has_permission(&manifest, "workspace.read", relative),
            &|| {
                active_checks.set(active_checks.get() + 1);
                Ok(())
            },
        )
        .expect("list scoped markdown");
        assert_eq!(files.len(), 1);
        assert!(files[0].relative_path.starts_with("allowed/"));
        assert!(active_checks.get() > 0);

        let mut interrupted = Vec::new();
        let error =
            collect_scoped_markdown_files(&root, &root, &mut interrupted, 2, &|_| true, &|| {
                Err("PLUGIN_REQUEST_TIMEOUT".into())
            })
            .unwrap_err();
        assert_eq!(error, "PLUGIN_REQUEST_TIMEOUT");
        assert!(interrupted.is_empty());
        fs::remove_dir_all(root).expect("clean test directory");
    }
}
