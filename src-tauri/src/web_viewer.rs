//! Native child WebViews for permission-controlled plugin views; remote content has no host API.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, PermissionResponse, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview, WebviewUrl,
};

const REMOTE_PREFIX: &str = "webviewer-";
const MAX_TABS: usize = 128;
const MAX_WINDOW_TABS: usize = 32;

/// Share only the host's scrollbar colors with remote documents and their child frames.
const REMOTE_SCROLLBAR_SCRIPT: &str = r#"
(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
        :root {
            --ws-editor-scrollbarSlider-background: GrayText;
            --ws-editor-scrollbarSlider-hoverBackground: GrayText;
            --ws-editor-scrollbarSlider-activeBackground: GrayText;
            --wstudio-scrollbar-thumb-radius: 0px;
        }
        ::-webkit-scrollbar {
            width: 12px !important;
            height: 8px !important;
            background: transparent !important;
        }
        ::-webkit-scrollbar-corner { background: transparent !important; }
        ::-webkit-scrollbar-thumb {
            min-height: 24px !important;
            min-width: 24px !important;
            background-color: var(--ws-editor-scrollbarSlider-background) !important;
            border-radius: var(--wstudio-scrollbar-thumb-radius) !important;
        }
        ::-webkit-scrollbar-thumb:hover { background-color: var(--ws-editor-scrollbarSlider-hoverBackground) !important; }
        ::-webkit-scrollbar-thumb:active { background-color: var(--ws-editor-scrollbarSlider-activeBackground) !important; }
        ::-webkit-scrollbar-button { display: none !important; width: 0 !important; height: 0 !important; }
    `);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    const properties = [
        ['background', '--ws-editor-scrollbarSlider-background'],
        ['hoverBackground', '--ws-editor-scrollbarSlider-hoverBackground'],
        ['activeBackground', '--ws-editor-scrollbarSlider-activeBackground']
    ];
    let currentTheme = null;
    const sendTheme = frame => frame.postMessage({ type: 'wstudio:scrollbar-theme', theme: currentTheme }, '*');
    const applyTheme = theme => {
        if (theme !== null && (!theme || !properties.every(([key]) =>
            typeof theme[key] === 'string' && theme[key].length <= 128 && CSS.supports('color', theme[key])))) return;
        currentTheme = theme;
        for (const [key, property] of properties) {
            sheet.cssRules[0].style.setProperty(property, theme === null ? 'GrayText' : theme[key], 'important');
        }
        sheet.cssRules[0].style.setProperty(
            '--wstudio-scrollbar-thumb-radius', theme && theme.modernUiEnabled ? '4px' : '0px', 'important'
        );
        for (let index = 0; index < window.frames.length; index++) sendTheme(window.frames[index]);
    };
    // These messages carry public colors only; remote frames receive no host API or script runner.
    window.addEventListener('message', event => {
        if (!event.data || typeof event.data !== 'object') return;
        if (event.data.type === 'wstudio:scrollbar-theme' && window !== window.top && event.source === window.parent) {
            applyTheme(event.data.theme);
        } else if (event.data.type === 'wstudio:scrollbar-theme-request') {
            for (let index = 0; index < window.frames.length; index++) {
                if (window.frames[index] === event.source) sendTheme(event.source);
            }
        }
    });
    window.addEventListener('wstudio:scrollbar-theme', event => {
        if (window === window.top) applyTheme(event.detail);
    });
    applyTheme(__WSTUDIO_SCROLLBAR_THEME__);
    if (window !== window.top) window.parent.postMessage({ type: 'wstudio:scrollbar-theme-request' }, '*');
})();
"#;

/// Bounded color-only snapshot supplied by the trusted host through the existing view scope.
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScrollbarTheme {
    background: String,
    hover_background: String,
    active_background: String,
    #[serde(default)]
    modern_ui_enabled: bool,
}

impl ScrollbarTheme {
    /// Reject declarations, URLs and script fragments; the browser validates color semantics.
    pub(crate) fn is_valid(&self) -> bool {
        [
            &self.background,
            &self.hover_background,
            &self.active_background,
        ]
        .into_iter()
        .all(|value| {
            if value.is_empty()
                || value.len() > 128
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"#() .,%/+-".contains(&byte))
            {
                return false;
            }
            if value.starts_with('#') {
                return matches!(value.len(), 4 | 5 | 7 | 9)
                    && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit());
            }
            if value.bytes().all(|byte| byte.is_ascii_alphabetic()) {
                return true;
            }
            let normalized = value.to_ascii_lowercase();
            [
                "rgb(",
                "rgba(",
                "hsl(",
                "hsla(",
                "hwb(",
                "lab(",
                "lch(",
                "oklab(",
                "oklch(",
                "color(",
                "color-mix(",
                "light-dark(",
            ]
            .iter()
            .any(|prefix| normalized.starts_with(prefix))
                && value.ends_with(')')
        })
    }
}

/// JSON-encode colors as data rather than interpolating them into executable JavaScript or CSS.
fn scrollbar_initialization_script(theme: Option<&ScrollbarTheme>) -> String {
    REMOTE_SCROLLBAR_SCRIPT.replace("__WSTUDIO_SCROLLBAR_THEME__", &json!(theme).to_string())
}

/// Reapply the latest snapshot after navigation and update already-loaded child frames.
fn refresh_scrollbar_theme(view: &Webview) {
    let app = view.app_handle();
    let state = app.state::<WebViewerState>();
    let theme = {
        let Ok(catalog) = state.catalog.lock() else {
            return;
        };
        let Some(tab) = catalog.tabs.get(view.label()) else {
            return;
        };
        catalog.scrollbar_themes.get(&tab.scope).cloned()
    };
    let script = format!(
        "window.dispatchEvent(new CustomEvent('wstudio:scrollbar-theme', {{ detail: {} }}));",
        json!(theme),
    );
    if let Err(error) = view.eval(script) {
        eprintln!("[webViewer] Scrollbar theme synchronization failed: {error}");
    }
}

/// Bind every tab and rectangle to the caller, contribution, instance and revocable generation.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Scope {
    pub(crate) window: String,
    pub(crate) plugin: String,
    pub(crate) runtime: String,
    pub(crate) view_type: String,
    pub(crate) instance: String,
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Bounds {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Clone)]
struct Tab {
    scope: Scope,
    id: String,
    title: String,
    favicon_url: String,
    url: String,
    loading: bool,
    back: bool,
    forward: bool,
    zoom_level: i8,
    revision: u64,
}

impl Tab {
    fn summary(&self) -> Value {
        json!({ "id": self.id, "instanceId": self.scope.instance, "title": self.title,
            "viewType": self.scope.view_type, "faviconUrl": self.favicon_url,
            "url": self.url, "active": true, "loading": self.loading,
            "canGoBack": self.back, "canGoForward": self.forward })
    }
}

#[derive(Default)]
struct Catalog {
    tabs: HashMap<String, Tab>,
    bounds: HashMap<Scope, Bounds>,
    occlusions: HashMap<Scope, Vec<Bounds>>,
    scrollbar_themes: HashMap<Scope, ScrollbarTheme>,
}

impl Catalog {
    fn list(&self, scope: &Scope) -> Value {
        json!(self
            .tabs
            .values()
            .filter(|tab| &tab.scope == scope)
            .map(Tab::summary)
            .collect::<Vec<_>>())
    }

    fn require(&self, scope: &Scope, id: &str) -> Result<Tab, String> {
        self.tabs
            .get(id)
            .filter(|tab| &tab.scope == scope)
            .cloned()
            .ok_or_else(|| "PLUGIN_WEBVIEWER_TAB_NOT_FOUND".into())
    }

    /// Saving is bound to the same loaded document as well as the original instance identity.
    fn require_snapshot(&self, expected: &Tab) -> Result<Tab, String> {
        let current = self.require(&expected.scope, &expected.id)?;
        if current.loading || current.revision != expected.revision || current.url != expected.url {
            return Err("PLUGIN_WEBVIEWER_PAGE_CHANGED".into());
        }
        Ok(current)
    }

    /// Menus resolve ownership using the native source window, never a supplied tab label.
    fn menu_tab(&self, window: &str, request: &MenuRequest) -> Result<Tab, String> {
        self.tabs
            .values()
            .find(|tab| {
                tab.scope.window == window
                    && tab.scope.plugin == request.plugin_id
                    && tab.scope.view_type == request.view_type
                    && tab.scope.instance == request.instance_id
            })
            .cloned()
            .ok_or_else(|| "PLUGIN_WEBVIEWER_TAB_NOT_FOUND".into())
    }

    /// Remove ownership before closing native handles, so late callbacks become harmless.
    fn remove(&mut self, matches: impl Fn(&Scope) -> bool) -> Vec<Tab> {
        self.bounds.retain(|scope, _| !matches(scope));
        self.occlusions.retain(|scope, _| !matches(scope));
        self.scrollbar_themes.retain(|scope, _| !matches(scope));
        let ids: Vec<_> = self
            .tabs
            .iter()
            .filter(|(_, tab)| matches(&tab.scope))
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| self.tabs.remove(&id))
            .collect()
    }

    /// A fatal process exit removes the old document but retains this instance's cached placement.
    fn fail(&mut self, id: &str) -> Option<Tab> {
        self.tabs.remove(id)
    }
}

#[derive(Default)]
pub(crate) struct WebViewerState {
    catalog: Mutex<Catalog>,
    operations: Mutex<()>,
    saves: Mutex<HashSet<String>>,
}

/// Shared SDK/menu actions; deserialization rejects unknown names before side effects.
#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Action {
    NewWindow,
    OpenExternal,
    ZoomIn,
    ZoomReset,
    ZoomOut,
    SaveToRepository,
    Favorite,
}

/// Trusted workbench request; window and generation come from native ownership records.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MenuRequest {
    plugin_id: String,
    instance_id: String,
    view_type: String,
    action: Action,
}

impl MenuRequest {
    /// Interactive saves allow five minutes; ordinary toolbar actions retain their short deadline.
    pub(crate) fn timeout_ms(&self) -> u64 {
        if matches!(self.action, Action::SaveToRepository) {
            300_000
        } else {
            15_000
        }
    }
}

/// Prevent duplicate dialogs per window and release the slot on every exit path.
struct SavePermit<'a> {
    saves: &'a Mutex<HashSet<String>>,
    window: String,
}

impl Drop for SavePermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut saves) = self.saves.lock() {
            saves.remove(&self.window);
        }
    }
}

/// Menu actions never broaden navigation permission to arbitrary files, URLs or windows.
fn validate_action(manifest: &Value, scope: &Scope, action: Action) -> Result<(), String> {
    validate_scope(manifest, scope)?;
    let permission = match action {
        Action::NewWindow => Some("window.manage"),
        Action::OpenExternal => Some("external.open"),
        Action::Favorite => Some("storage.plugin"),
        Action::SaveToRepository => {
            for id in ["workspace.write", "dialogs.show"] {
                if !super::plugin_permission_is_declared(manifest, id) {
                    return Err("PLUGIN_PERMISSION_NOT_DECLARED".into());
                }
            }
            None
        }
        _ => None,
    };
    if permission.is_some_and(|id| !super::plugin_permission_is_declared(manifest, id)) {
        return Err("PLUGIN_PERMISSION_NOT_DECLARED".into());
    }
    Ok(())
}

/// Match Electron's bounded zoom levels without accumulating floating point drift.
fn next_zoom(current: i8, action: Action) -> i8 {
    match action {
        Action::ZoomReset => 0,
        Action::ZoomIn => current.saturating_add(1).clamp(-5, 5),
        Action::ZoomOut => current.saturating_sub(1).clamp(-5, 5),
        _ => current,
    }
}

/// Application commands and local resource protocols must reject every remote child label.
pub(crate) fn is_remote(label: &str) -> bool {
    label.starts_with(REMOTE_PREFIX)
}

pub(super) fn parse_url(value: &str) -> Result<Url, String> {
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    let url = Url::parse(value).map_err(|_| "PLUGIN_INVALID_ARGUMENT")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || matches!(
            url.host_str(),
            Some("tauri.localhost" | "wstudio-media.localhost" | "wstudio-plugin.localhost")
        )
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    Ok(url)
}

/// Append a URL to the existing plugin-private list without losing unrelated storage keys.
/// The shared storage mutation holds the cross-process lock across list deduplication and append.
pub(super) fn save_favorite(
    path: &std::path::Path,
    manifest: &Value,
    url: &str,
    checkpoint: &dyn Fn() -> Result<(), String>,
) -> Result<(), String> {
    const KEY: &str = "webViewer.favorites";
    super::validate_plugin_storage_request(manifest, KEY, None)?;
    checkpoint()?;
    let url = parse_url(url)?.to_string();
    super::mutate_plugin_storage_checked(path, checkpoint, |values| {
        let mut urls: Vec<String> = match values.get(KEY) {
            Some(value) => {
                serde_json::from_value(value.clone()).map_err(|_| "PLUGIN_STORAGE_INVALID")?
            }
            None => Vec::new(),
        };
        for saved in &urls {
            parse_url(saved).map_err(|_| "PLUGIN_STORAGE_INVALID")?;
        }
        if urls.iter().any(|saved| saved == &url) {
            return Ok(false);
        }
        urls.push(url);
        let value = json!(urls);
        super::validate_plugin_storage_request(manifest, KEY, Some(&value))?;
        values.insert(KEY.into(), value);
        Ok(true)
    })
}

/// This uses the granted manifest; a declared but ungranted permission grants no navigation.
pub(crate) fn validate_scope(manifest: &Value, scope: &Scope) -> Result<(), String> {
    if !super::plugin_package::valid_id(&scope.plugin)
        || [
            &scope.window,
            &scope.runtime,
            &scope.view_type,
            &scope.instance,
        ]
        .iter()
        .any(|value| value.trim().is_empty() || value.len() > 256)
        || is_remote(&scope.window)
    {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    if !super::plugin_permission_is_declared(manifest, "webViewer.navigate") {
        return Err("PLUGIN_PERMISSION_NOT_DECLARED".into());
    }
    let declared = manifest["contributes"]["views"]
        .as_array()
        .is_some_and(|views| {
            views.iter().any(|view| {
                view["type"] == scope.view_type
                    && view["capabilities"].as_array().is_some_and(|capabilities| {
                        capabilities
                            .iter()
                            .any(|capability| capability == "webViewer")
                    })
            })
        });
    if !declared {
        return Err("PLUGIN_VIEW_CAPABILITY_NOT_DECLARED".into());
    }
    Ok(())
}

fn authorize(app: &AppHandle, scope: &Scope) -> Result<(), String> {
    if app.get_window(&scope.window).is_none() {
        return Err("PLUGIN_RUNTIME_TERMINATED".into());
    }
    let registry = app.state::<super::PluginRegistryState>();
    registry.authorize_runtime(&scope.plugin, &scope.runtime, &scope.window)?;
    let (_, manifest) = registry.active_manifest(&scope.plugin)?;
    validate_scope(&manifest, scope)
}

/// Route remote new-window requests through the opener's navigation capability.
fn navigate_new_window(
    url: &Url,
    authorize_source: impl FnOnce() -> Result<(), String>,
    navigate_source: impl FnOnce(Url) -> Result<(), String>,
) -> Result<(), String> {
    let target = parse_url(url.as_str())?;
    authorize_source()?;
    navigate_source(target)
}

/// Reject a request that expired while waiting for another native operation or browser creation.
fn check_deadline(deadline: u64) -> Result<(), String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(u64::MAX);
    if now >= deadline {
        return Err("PLUGIN_REQUEST_TIMEOUT".into());
    }
    Ok(())
}

/// Clip logical CSS coordinates to the native client area and hide empty rectangles.
fn clip(bounds: Bounds, width: f64, height: f64) -> Option<Bounds> {
    let x = bounds.x.max(0.0).min(width);
    let y = bounds.y.max(0.0).min(height);
    let right = (bounds.x + bounds.width).min(width);
    let bottom = (bounds.y + bounds.height).min(height);
    (right > x && bottom > y).then_some(Bounds {
        x,
        y,
        width: right - x,
        height: bottom - y,
    })
}

impl WebViewerState {
    /// SDK operations are serialized; platform callbacks never hold this operation lock.
    pub(crate) fn invoke(
        &self,
        app: &AppHandle,
        scope: Scope,
        method: &str,
        params: &Value,
        deadline: u64,
    ) -> Result<Value, String> {
        let _operation = self.operations.lock().map_err(|_| "PLUGIN_API_FAILED")?;
        check_deadline(deadline)?;
        authorize(app, &scope)?;
        check_deadline(deadline)?;
        match method {
            "webViewer.open" => self.open(app, scope, params, deadline),
            "webViewer.list" => Ok(self
                .catalog
                .lock()
                .map_err(|_| "PLUGIN_API_FAILED")?
                .list(&scope)),
            "webViewer.navigate"
            | "webViewer.back"
            | "webViewer.forward"
            | "webViewer.reload"
            | "webViewer.activate"
            | "webViewer.close"
            | "webViewer.executeAction" => {
                let id = params["tabId"].as_str().ok_or("PLUGIN_INVALID_ARGUMENT")?;
                let tab = self
                    .catalog
                    .lock()
                    .map_err(|_| "PLUGIN_API_FAILED")?
                    .require(&scope, id)?;
                let view = app
                    .get_webview(&tab.id)
                    .ok_or("PLUGIN_WEBVIEWER_TAB_NOT_FOUND")?;
                if method == "webViewer.executeAction" {
                    let action = serde_json::from_value(params["action"].clone())
                        .map_err(|_| "PLUGIN_INVALID_ARGUMENT")?;
                    if matches!(action, Action::SaveToRepository) {
                        drop(_operation);
                    }
                    return self
                        .execute_action(app, &tab, &view, action, deadline)
                        .map(Value::Bool);
                }
                match method {
                    "webViewer.navigate" => {
                        let url =
                            parse_url(params["url"].as_str().ok_or("PLUGIN_INVALID_ARGUMENT")?)?;
                        view.navigate(url)
                            .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED")?;
                    }
                    "webViewer.reload" => view
                        .reload()
                        .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED")?,
                    "webViewer.back" | "webViewer.forward" => {
                        history(&view, method == "webViewer.back")?
                    }
                    "webViewer.activate" => self.apply_bounds(app, &tab)?,
                    "webViewer.close" => {
                        view.close()
                            .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED")?;
                        self.catalog
                            .lock()
                            .map_err(|_| "PLUGIN_API_FAILED")?
                            .tabs
                            .remove(id);
                        app.state::<super::native_process::NativeProcessState>()
                            .forget(id);
                        self.publish(app, &scope);
                    }
                    _ => unreachable!(),
                }
                Ok(Value::Null)
            }
            _ => Err("PLUGIN_API_UNAVAILABLE".into()),
        }
    }

    /// Resolve only a tab owned by the actual caller; never trust Renderer-supplied generations.
    pub(crate) fn context_menu(
        &self,
        app: &AppHandle,
        window: &str,
        request: MenuRequest,
        deadline: u64,
    ) -> Result<bool, String> {
        let _operation = self.operations.lock().map_err(|_| "PLUGIN_API_FAILED")?;
        check_deadline(deadline)?;
        let tab = self
            .catalog
            .lock()
            .map_err(|_| "PLUGIN_API_FAILED")?
            .menu_tab(window, &request)?;
        let view = app
            .get_webview(&tab.id)
            .ok_or("PLUGIN_WEBVIEWER_TAB_NOT_FOUND")?;
        if matches!(request.action, Action::SaveToRepository) {
            drop(_operation);
        }
        self.execute_action(app, &tab, &view, request.action, deadline)
    }

    /// Shared permission-controlled implementation for public SDK and trusted menus.
    fn execute_action(
        &self,
        app: &AppHandle,
        tab: &Tab,
        view: &Webview,
        action: Action,
        deadline: u64,
    ) -> Result<bool, String> {
        authorize(app, &tab.scope)?;
        let (_, manifest) = app
            .state::<super::PluginRegistryState>()
            .active_manifest(&tab.scope.plugin)?;
        validate_action(&manifest, &tab.scope, action)?;
        check_deadline(deadline)?;
        match action {
            Action::ZoomIn | Action::ZoomOut | Action::ZoomReset => {
                let level = next_zoom(tab.zoom_level, action);
                view.set_zoom(1.2_f64.powi(i32::from(level)))
                    .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED")?;
                // A tab disposed during the native operation must never be restored.
                if let Some(current) = self
                    .catalog
                    .lock()
                    .map_err(|_| "PLUGIN_API_FAILED")?
                    .tabs
                    .get_mut(&tab.id)
                {
                    current.zoom_level = level;
                }
            }
            Action::OpenExternal => {
                // Read the native URL, including same-document history, rather than a supplied string.
                let url = parse_url(
                    view.url()
                        .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED")?
                        .as_str(),
                )?;
                authorize(app, &tab.scope)?;
                check_deadline(deadline)?;
                open::that(url.as_str()).map_err(|_| "PLUGIN_EXTERNAL_OPEN_FAILED")?;
            }
            Action::NewWindow => {
                let url = parse_url(
                    view.url()
                        .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED")?
                        .as_str(),
                )?;
                let request = super::PluginWindowOpenRequest {
                    kind: Some("plugin".into()),
                    plugin_id: Some(tab.scope.plugin.clone()),
                    view_type: Some(tab.scope.view_type.clone()),
                    title: Some(tab.title.chars().take(50).collect()),
                    reuse: Some("always-new".into()),
                    ..Default::default()
                };
                authorize(app, &tab.scope)?;
                check_deadline(deadline)?;
                let created = super::open_plugin_window(request, app.clone(), Some(url.as_str()))
                    .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED")?;
                if let Err(error) =
                    authorize(app, &tab.scope).and_then(|_| check_deadline(deadline))
                {
                    if let Some(window) = created["id"].as_str().and_then(|id| app.get_window(id)) {
                        let _ = window.close();
                    }
                    return Err(error);
                }
            }
            Action::SaveToRepository => return self.save_to_repository(app, tab, view, deadline),
            Action::Favorite => {
                let storage = app.state::<super::PluginStorageState>();
                let _storage = storage.operation.lock().map_err(|_| "PLUGIN_API_FAILED")?;
                let path = super::plugin_storage_path(app, &tab.scope.plugin)?;
                let url = parse_url(
                    view.url()
                        .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED")?
                        .as_str(),
                )?;
                save_favorite(&path, &manifest, url.as_str(), &|| {
                    authorize(app, &tab.scope)?;
                    check_deadline(deadline)?;
                    let (_, grants) = app
                        .state::<super::PluginRegistryState>()
                        .active_manifest(&tab.scope.plugin)?;
                    validate_action(&grants, &tab.scope, Action::Favorite)?;
                    self.catalog
                        .lock()
                        .map_err(|_| "PLUGIN_API_FAILED")?
                        .require_snapshot(tab)?;
                    if view
                        .url()
                        .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED")?
                        != url
                    {
                        return Err("PLUGIN_WEBVIEWER_PAGE_CHANGED".into());
                    }
                    Ok(())
                })?;
            }
        }
        Ok(true)
    }

    /// Long-running save dialogs do not hold the global navigation lock.
    fn save_permit(&self, window: &str) -> Result<SavePermit<'_>, String> {
        let mut saves = self.saves.lock().map_err(|_| "PLUGIN_API_FAILED")?;
        if saves.contains(window) {
            return Err("PLUGIN_WEBVIEWER_SAVE_BUSY".into());
        }
        if saves.len() >= 8 {
            return Err("PLUGIN_WEBVIEWER_LIMIT_EXCEEDED".into());
        }
        saves.insert(window.into());
        Ok(SavePermit {
            saves: &self.saves,
            window: window.into(),
        })
    }

    /// Validate again after UI waits; revoked/disposed/navigated views cannot commit a link.
    fn check_save(&self, app: &AppHandle, tab: &Tab, deadline: u64) -> Result<Value, String> {
        check_deadline(deadline)?;
        authorize(app, &tab.scope)?;
        let (_, manifest) = app
            .state::<super::PluginRegistryState>()
            .active_manifest(&tab.scope.plugin)?;
        validate_action(&manifest, &tab.scope, Action::SaveToRepository)?;
        self.catalog
            .lock()
            .map_err(|_| "PLUGIN_API_FAILED")?
            .require_snapshot(tab)?;
        Ok(manifest)
    }

    /// Save only the native URL through the user-selected, scoped repository destination.
    fn save_to_repository(
        &self,
        app: &AppHandle,
        tab: &Tab,
        view: &Webview,
        deadline: u64,
    ) -> Result<bool, String> {
        let _permit = self.save_permit(&tab.scope.window)?;
        self.check_save(app, tab, deadline)?;
        let state = app.state::<super::WorkspaceState>();
        let root = super::workspace_root(&state).map_err(|_| "PLUGIN_API_FAILED")?;
        let selected = super::web_viewer_save::pick_destination(
            app,
            &tab.scope.window,
            &root,
            &tab.title,
            deadline,
        )?;
        let Some(selected) = selected else {
            return Ok(false);
        };
        let current = self
            .catalog
            .lock()
            .map_err(|_| "PLUGIN_API_FAILED")?
            .require_snapshot(tab)?;
        let manifest = self.check_save(app, &current, deadline)?;
        let url = parse_url(
            view.url()
                .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED")?
                .as_str(),
        )?;
        let target = super::web_viewer_save::select_target(&root, &selected, &manifest)?;
        // Freeze repository switching only during the bounded filesystem commit, never during the dialog.
        let active_root = state.root.lock().map_err(|_| "PLUGIN_API_FAILED")?;
        if *active_root != root {
            return Err("PLUGIN_WEBVIEWER_REPOSITORY_CHANGED".into());
        }
        super::web_viewer_save::commit_link(&root, &target, url.as_str(), &|| {
            let grants = self.check_save(app, &current, deadline)?;
            if !super::plugin_path_has_permission(&grants, "workspace.write", &target.relative) {
                return Err("PLUGIN_PERMISSION_SCOPE_VIOLATION".into());
            }
            let native_url = view
                .url()
                .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED")?;
            if native_url != url {
                return Err("PLUGIN_WEBVIEWER_PAGE_CHANGED".into());
            }
            Ok(())
        })?;
        drop(active_root);
        let _ = app.emit(
            "workspace:directoryChanged",
            json!({ "repositoryId": super::repository_id(&root) }),
        );
        Ok(true)
    }

    /// Build a real child WebView without changing the workbench's existing plugin DOM or layout.
    fn open(
        &self,
        app: &AppHandle,
        scope: Scope,
        params: &Value,
        deadline: u64,
    ) -> Result<Value, String> {
        let requested_theme = params
            .get("scrollbarTheme")
            .filter(|value| !value.is_null())
            .map(|value| {
                serde_json::from_value::<ScrollbarTheme>(value.clone())
                    .map_err(|_| "PLUGIN_INVALID_ARGUMENT".to_string())
            })
            .transpose()?;
        if requested_theme
            .as_ref()
            .is_some_and(|theme| !theme.is_valid())
        {
            return Err("PLUGIN_INVALID_ARGUMENT".into());
        }
        let url = match params.get("url") {
            None => parse_url("https://example.com/")?,
            Some(value) => parse_url(value.as_str().ok_or("PLUGIN_INVALID_ARGUMENT")?)?,
        };
        let title = match params.get("title") {
            None => url.host_str().unwrap_or("WebViewer").to_string(),
            Some(Value::String(value)) if value.len() <= 512 => value.clone(),
            _ => return Err("PLUGIN_INVALID_ARGUMENT".into()),
        };
        {
            let catalog = self.catalog.lock().map_err(|_| "PLUGIN_API_FAILED")?;
            if let Some(tab) = catalog.tabs.values().find(|tab| tab.scope == scope) {
                return Ok(tab.summary());
            }
            if catalog.tabs.len() >= MAX_TABS
                || (!catalog.scrollbar_themes.contains_key(&scope)
                    && catalog.scrollbar_themes.len() >= MAX_TABS)
                || catalog
                    .tabs
                    .values()
                    .filter(|tab| tab.scope.window == scope.window)
                    .count()
                    >= MAX_WINDOW_TABS
            {
                return Err("PLUGIN_WEBVIEWER_LIMIT_EXCEEDED".into());
            }
        }
        let id = format!("{REMOTE_PREFIX}{}", uuid::Uuid::new_v4().simple());
        let data_directory = app
            .path()
            .app_data_dir()
            .map_err(|_| "PLUGIN_API_FAILED")?
            .join("plugins/data")
            .join(&scope.plugin)
            .join("webviewer");
        let tab = Tab {
            scope: scope.clone(),
            id: id.clone(),
            title,
            favicon_url: String::new(),
            url: url.to_string(),
            loading: true,
            back: false,
            forward: false,
            zoom_level: 0,
            revision: 0,
        };
        let scrollbar_theme = {
            let mut catalog = self.catalog.lock().map_err(|_| "PLUGIN_API_FAILED")?;
            if let Some(theme) = requested_theme {
                catalog.scrollbar_themes.insert(scope.clone(), theme);
            }
            catalog.tabs.insert(id.clone(), tab.clone());
            catalog.scrollbar_themes.get(&scope).cloned()
        };
        let navigation_app = app.clone();
        let navigation_scope = scope.clone();
        let navigation_id = id.clone();
        let popup_app = app.clone();
        let popup_scope = scope.clone();
        let popup_id = id.clone();
        let builder = WebviewBuilder::new(&id, WebviewUrl::External(url))
            .focused(false)
            .data_directory(data_directory)
            .initialization_script_for_all_frames(scrollbar_initialization_script(
                scrollbar_theme.as_ref(),
            ))
            .on_navigation(move |url| {
                let allowed = parse_url(url.as_str()).is_ok()
                    && authorize(&navigation_app, &navigation_scope).is_ok();
                if allowed {
                    navigation_app.state::<WebViewerState>().change(
                        &navigation_app,
                        &navigation_id,
                        |tab| {
                            tab.url = url.to_string();
                        },
                    );
                }
                allowed
            })
            .on_new_window(move |url, _| {
                let app = popup_app.clone();
                let scope = popup_scope.clone();
                let id = popup_id.clone();
                // Leave the WebView2 callback before taking operation locks or navigating.
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = app
                        .state::<WebViewerState>()
                        .redirect_new_window(&app, &scope, &id, &url)
                    {
                        eprintln!("[webViewer] New-window navigation rejected: {error}");
                    }
                });
                NewWindowResponse::Deny
            })
            .on_download(|_, _| false)
            .on_permission_request(|_, _| PermissionResponse::Deny)
            .on_document_title_changed(|view, title| {
                let app = view.app_handle();
                app.state::<WebViewerState>()
                    .change(app, view.label(), |tab| {
                        tab.title = title.chars().take(512).collect();
                    });
            })
            .on_page_load(|view, payload| {
                let app = view.app_handle();
                app.state::<WebViewerState>()
                    .change(app, view.label(), |tab| {
                        tab.loading = payload.event() == PageLoadEvent::Started;
                        if tab.loading {
                            tab.revision = tab.revision.wrapping_add(1);
                        }
                        if parse_url(payload.url().as_str()).is_ok() {
                            tab.url = payload.url().to_string();
                        }
                    });
                refresh_history(&view);
                if payload.event() == PageLoadEvent::Finished {
                    refresh_scrollbar_theme(&view);
                }
            });
        let result = (|| {
            let window = app
                .get_window(&scope.window)
                .ok_or("PLUGIN_RUNTIME_TERMINATED")?;
            let view = window
                .add_child(
                    builder,
                    LogicalPosition::new(-10_000.0, -10_000.0),
                    LogicalSize::new(1.0, 1.0),
                )
                .map_err(|_| "PLUGIN_WEBVIEWER_CREATE_FAILED")?;
            if let Err(error) = check_deadline(deadline) {
                let _ = view.close();
                return Err(error);
            }
            if let Err(error) = authorize(app, &scope) {
                let _ = view.close();
                return Err(error);
            }
            let current = self
                .catalog
                .lock()
                .map_err(|_| "PLUGIN_API_FAILED")?
                .require(&scope, &id);
            let current = match current {
                Ok(tab) => tab,
                Err(_) => {
                    let _ = view.close();
                    return Err("PLUGIN_RUNTIME_TERMINATED".into());
                }
            };
            install_history_listener(&view)?;
            super::native_process::observe_remote(&view)?;
            check_deadline(deadline)?;
            self.catalog
                .lock()
                .map_err(|_| "PLUGIN_API_FAILED")?
                .require(&scope, &id)?;
            self.apply_bounds(app, &current)?;
            self.publish(app, &scope);
            Ok(current.summary())
        })();
        if result.is_err() {
            app.state::<super::native_process::NativeProcessState>()
                .forget(&id);
            {
                let mut catalog = self.catalog.lock().map_err(|_| "PLUGIN_API_FAILED")?;
                catalog.tabs.remove(&id);
                if !catalog.bounds.contains_key(&scope) {
                    catalog.scrollbar_themes.remove(&scope);
                }
            }
            if let Some(view) = app.get_webview(&id) {
                let _ = view.close();
            }
        }
        result
    }

    /// Keep target=_blank/window.open links in the existing, permission-controlled native view.
    fn redirect_new_window(
        &self,
        app: &AppHandle,
        scope: &Scope,
        id: &str,
        url: &Url,
    ) -> Result<(), String> {
        let _operation = self.operations.lock().map_err(|_| "PLUGIN_API_FAILED")?;
        navigate_new_window(
            url,
            || {
                authorize(app, scope)?;
                self.catalog
                    .lock()
                    .map_err(|_| "PLUGIN_API_FAILED")?
                    .require(scope, id)?;
                Ok(())
            },
            |target| {
                app.get_webview(id)
                    .ok_or("PLUGIN_WEBVIEWER_TAB_NOT_FOUND")?
                    .navigate(target)
                    .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED".into())
            },
        )
    }

    /// Accept bounds before open and keep cached placement when native content is still loading.
    pub(crate) fn update_bounds(
        &self,
        app: &AppHandle,
        scope: Scope,
        bounds: Bounds,
        occlusions: Vec<Bounds>,
        scrollbar_theme: Option<ScrollbarTheme>,
    ) -> Result<(), String> {
        let _operation = self.operations.lock().map_err(|_| "PLUGIN_API_FAILED")?;
        authorize(app, &scope)?;
        if scrollbar_theme
            .as_ref()
            .is_some_and(|theme| !theme.is_valid())
        {
            return Err("PLUGIN_VIEW_BOUNDS_INVALID".into());
        }
        let (tab, theme_changed) = {
            let mut catalog = self.catalog.lock().map_err(|_| "PLUGIN_API_FAILED")?;
            if (!catalog.bounds.contains_key(&scope) && catalog.bounds.len() >= MAX_TABS)
                || (scrollbar_theme.is_some()
                    && !catalog.scrollbar_themes.contains_key(&scope)
                    && catalog.scrollbar_themes.len() >= MAX_TABS)
            {
                return Err("PLUGIN_WEBVIEWER_LIMIT_EXCEEDED".into());
            }
            catalog.bounds.insert(scope.clone(), bounds);
            catalog.occlusions.insert(scope.clone(), occlusions);
            let previous_theme = catalog.scrollbar_themes.remove(&scope);
            let theme_changed = previous_theme != scrollbar_theme;
            if let Some(theme) = scrollbar_theme {
                catalog.scrollbar_themes.insert(scope.clone(), theme);
            }
            let tab = catalog
                .tabs
                .values()
                .find(|tab| tab.scope == scope)
                .cloned();
            (tab, theme_changed)
        };
        if let Some(tab) = tab {
            self.apply_bounds(app, &tab)?;
            if theme_changed {
                if let Some(view) = app.get_webview(&tab.id) {
                    refresh_scrollbar_theme(&view);
                }
            }
        }
        Ok(())
    }

    fn apply_bounds(&self, app: &AppHandle, tab: &Tab) -> Result<(), String> {
        let (bounds, occlusions) = {
            let catalog = self.catalog.lock().map_err(|_| "PLUGIN_API_FAILED")?;
            (
                catalog.bounds.get(&tab.scope).copied(),
                catalog
                    .occlusions
                    .get(&tab.scope)
                    .cloned()
                    .unwrap_or_default(),
            )
        };
        let window = app
            .get_window(&tab.scope.window)
            .ok_or("PLUGIN_RUNTIME_TERMINATED")?;
        let view = app
            .get_webview(&tab.id)
            .ok_or("PLUGIN_WEBVIEWER_TAB_NOT_FOUND")?;
        let scale = window.scale_factor().map_err(|_| "PLUGIN_API_FAILED")?;
        let size = window.inner_size().map_err(|_| "PLUGIN_API_FAILED")?;
        if let Some(bounds) = bounds.and_then(|bounds| {
            clip(
                bounds,
                f64::from(size.width) / scale,
                f64::from(size.height) / scale,
            )
        }) {
            view.set_bounds(Rect {
                position: LogicalPosition::new(bounds.x, bounds.y).into(),
                size: LogicalSize::new(bounds.width, bounds.height).into(),
            })
            .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED")?;
            apply_menu_region(&view, bounds, occlusions, scale)?;
            view.show()
                .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED")?;
        } else {
            view.hide()
                .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED")?;
        }
        Ok(())
    }

    fn change(&self, app: &AppHandle, id: &str, update: impl FnOnce(&mut Tab)) {
        let scope = {
            let Ok(mut catalog) = self.catalog.lock() else {
                return;
            };
            let Some(tab) = catalog.tabs.get_mut(id) else {
                return;
            };
            let previous_url = tab.url.clone();
            update(tab);
            if tab.url != previous_url {
                tab.revision = tab.revision.wrapping_add(1);
            }
            tab.scope.clone()
        };
        self.publish(app, &scope);
    }

    fn publish(&self, app: &AppHandle, scope: &Scope) {
        self.publish_failure(app, scope, None);
    }

    /// Deliver failure together with the post-removal snapshot to the owning trusted renderer.
    fn publish_failure(&self, app: &AppHandle, scope: &Scope, failure: Option<Value>) {
        let Ok(catalog) = self.catalog.lock() else {
            return;
        };
        let tabs: Vec<_> = catalog
            .tabs
            .values()
            .filter(|tab| tab.scope.window == scope.window && tab.scope.plugin == scope.plugin)
            .map(Tab::summary)
            .collect();
        let _ = app.emit_to(
            tauri::EventTarget::webview(&scope.window),
            "plugin:webViewerChanged",
            json!({ "pluginId": scope.plugin, "tabs": tabs,
                "runtimeId": scope.runtime, "failures": failure.into_iter().collect::<Vec<_>>() }),
        );
    }

    /// Invalidate the old handle/save immediately, preserving placement for an explicit new open.
    pub(crate) fn process_failed(&self, app: &AppHandle, id: &str, reason: &str) {
        let removed = self
            .catalog
            .lock()
            .ok()
            .and_then(|mut catalog| catalog.fail(id));
        let Some(tab) = removed else {
            return;
        };
        close_removed(app, &tab);
        self.publish_failure(
            app,
            &tab.scope,
            Some(json!({
                "tabId": tab.id, "instanceId": tab.scope.instance, "viewType": tab.scope.view_type,
                "url": tab.url, "reason": reason,
            })),
        );
    }

    /// Lifecycle cleanup also works after generation revocation; it never grants capabilities.
    pub(crate) fn dispose(&self, app: &AppHandle, matches: impl Fn(&Scope) -> bool) {
        let removed = self
            .catalog
            .lock()
            .map(|mut catalog| catalog.remove(matches))
            .unwrap_or_default();
        for tab in removed {
            close_removed(app, &tab);
            self.publish(app, &tab.scope);
        }
    }
}

/// Native close must run outside WebView2 callbacks; the catalog identity is already removed.
fn close_removed(app: &AppHandle, tab: &Tab) {
    app.state::<super::native_process::NativeProcessState>()
        .forget(&tab.id);
    if let Some(view) = app.get_webview(&tab.id) {
        tauri::async_runtime::spawn_blocking(move || {
            let _ = view.close();
        });
    }
}

/// Own a GDI region until it is transferred to Windows by SetWindowRgn.
#[cfg(target_os = "windows")]
struct OwnedRegion(windows::Win32::Graphics::Gdi::HRGN);

#[cfg(target_os = "windows")]
impl Drop for OwnedRegion {
    fn drop(&mut self) {
        // SAFETY: this wrapper owns the region; transferred regions are forgotten on success.
        unsafe {
            let _ = windows::Win32::Graphics::Gdi::DeleteObject(self.0.into());
        }
    }
}

/// Subtract menus in physical container coordinates, leaving webpage layout unchanged.
#[cfg(target_os = "windows")]
fn menu_region(bounds: Bounds, menus: &[Bounds], scale: f64) -> Result<OwnedRegion, String> {
    use windows::Win32::Graphics::Gdi::{CombineRgn, CreateRectRgn, ERROR, RGN_DIFF};
    // SAFETY: finite validated CSS coordinates are converted to bounded physical rectangles.
    unsafe {
        let region = OwnedRegion(CreateRectRgn(
            0,
            0,
            (bounds.width * scale).ceil() as i32,
            (bounds.height * scale).ceil() as i32,
        ));
        if region.0.is_invalid() {
            return Err("PLUGIN_WEBVIEWER_OPERATION_FAILED".into());
        }
        for menu in menus {
            let x = (menu.x - bounds.x).max(0.0);
            let y = (menu.y - bounds.y).max(0.0);
            let right = (menu.x + menu.width - bounds.x).min(bounds.width);
            let bottom = (menu.y + menu.height - bounds.y).min(bounds.height);
            if right <= x || bottom <= y {
                continue;
            }
            let cut = OwnedRegion(CreateRectRgn(
                (x * scale).floor() as i32,
                (y * scale).floor() as i32,
                (right * scale).ceil() as i32,
                (bottom * scale).ceil() as i32,
            ));
            if cut.0.is_invalid()
                || CombineRgn(Some(region.0), Some(region.0), Some(cut.0), RGN_DIFF).0 == ERROR
            {
                return Err("PLUGIN_WEBVIEWER_OPERATION_FAILED".into());
            }
        }
        Ok(region)
    }
}

/// Clip Wry's child container so DOM menus beneath it are visible and receive input.
#[cfg(target_os = "windows")]
fn apply_menu_region(
    view: &Webview,
    bounds: Bounds,
    menus: Vec<Bounds>,
    scale: f64,
) -> Result<(), String> {
    use windows::Win32::Graphics::Gdi::SetWindowRgn;
    let (send, receive) = mpsc::sync_channel(1);
    view.with_webview(move |native| {
        let result = (|| {
            // SAFETY: the controller and its own parent HWND are accessed on the UI thread.
            unsafe {
                let mut container = Default::default();
                native
                    .controller()
                    .ParentWindow(&mut container)
                    .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED")?;
                if menus.is_empty() {
                    if SetWindowRgn(container, None, true) == 0 {
                        return Err("PLUGIN_WEBVIEWER_OPERATION_FAILED".to_string());
                    }
                } else {
                    let region = menu_region(bounds, &menus, scale)?;
                    if SetWindowRgn(container, Some(region.0), true) == 0 {
                        return Err("PLUGIN_WEBVIEWER_OPERATION_FAILED".to_string());
                    }
                    std::mem::forget(region);
                }
                Ok(())
            }
        })();
        let _ = send.send(result);
    })
    .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED")?;
    receive
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "PLUGIN_REQUEST_TIMEOUT")?
}

#[cfg(not(target_os = "windows"))]
fn apply_menu_region(
    _view: &Webview,
    _bounds: Bounds,
    _menus: Vec<Bounds>,
    _scale: f64,
) -> Result<(), String> {
    Ok(())
}

/// Observe native history and favicon changes, including same-document navigation in SPA pages.
#[cfg(target_os = "windows")]
fn install_history_listener(view: &Webview) -> Result<(), String> {
    let app = view.app_handle().clone();
    let id = view.label().to_string();
    let favicon_app = app.clone();
    let favicon_id = id.clone();
    let (send, receive) = mpsc::sync_channel(1);
    view.with_webview(move |native| {
        // SAFETY: registration and callbacks execute on the WebView2 owning UI thread.
        let result = unsafe {
            native.controller().CoreWebView2().and_then(|core| {
                let handler =
                    webview2_com::HistoryChangedEventHandler::create(Box::new(move |core, _| {
                        let Some(core) = core else {
                            return Ok(());
                        };
                        let mut back = Default::default();
                        let mut forward = Default::default();
                        let mut source = Default::default();
                        core.CanGoBack(&mut back)?;
                        core.CanGoForward(&mut forward)?;
                        core.Source(&mut source)?;
                        let url = webview2_com::take_pwstr(source);
                        app.state::<WebViewerState>().change(&app, &id, |tab| {
                            tab.back = back.as_bool();
                            tab.forward = forward.as_bool();
                            if parse_url(&url).is_ok() {
                                tab.url = url;
                            }
                        });
                        Ok(())
                    }));
                let mut token = 0;
                core.add_HistoryChanged(&handler, &mut token)?;
                if let Err(error) = install_favicon_listener(&core, &favicon_app, &favicon_id) {
                    eprintln!("[webViewer] Favicon observation failed: {error}");
                }
                Ok(())
            })
        }
        .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED".to_string());
        let _ = send.send(result);
    })
    .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED")?;
    receive
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "PLUGIN_REQUEST_TIMEOUT")?
}

#[cfg(not(target_os = "windows"))]
fn install_history_listener(_view: &Webview) -> Result<(), String> {
    Ok(())
}

/// Observe the actual site's favicon without injecting scripts or exposing remote DOM to plugins.
#[cfg(target_os = "windows")]
fn install_favicon_listener(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    app: &AppHandle,
    id: &str,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_15;
    use windows::core::Interface;
    let Ok(core15) = core.cast::<ICoreWebView2_15>() else {
        // Older WebView2 versions still support navigation and the plugin's default icon.
        return Ok(());
    };
    let favicon_app = app.clone();
    let favicon_id = id.to_string();
    let handler = webview2_com::FaviconChangedEventHandler::create(Box::new(move |core, _| {
        if let Some(core) = core {
            let core15 = core.cast::<ICoreWebView2_15>()?;
            let favicon = read_favicon_url(&core15)?;
            favicon_app
                .state::<WebViewerState>()
                .change(&favicon_app, &favicon_id, |tab| {
                    tab.favicon_url = favicon;
                });
        }
        Ok(())
    }));
    let mut token = 0;
    // SAFETY: registration executes on the browser's owning UI thread.
    unsafe {
        core15.add_FaviconChanged(&handler, &mut token)?;
    }
    let favicon = read_favicon_url(&core15)?;
    app.state::<WebViewerState>().change(app, id, |tab| {
        tab.favicon_url = favicon;
    });
    Ok(())
}

/// Read and validate the browser-provided URI; local schemes never enter the trusted renderer.
#[cfg(target_os = "windows")]
fn read_favicon_url(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_15,
) -> windows::core::Result<String> {
    let mut uri = Default::default();
    // SAFETY: callers run on the owning UI thread; take_pwstr releases the COM-allocated string.
    unsafe {
        core.FaviconUri(&mut uri)?;
    }
    Ok(parse_url(&webview2_com::take_pwstr(uri))
        .map(|url| url.to_string())
        .unwrap_or_default())
}

/// Read browser history from native WebView2, so page JavaScript cannot forge toolbar state.
#[cfg(target_os = "windows")]
fn refresh_history(view: &Webview) {
    let app = view.app_handle().clone();
    let id = view.label().to_string();
    let _ = view.with_webview(move |native| {
        // SAFETY: with_webview runs on the owning UI thread; output BOOLs are initialized.
        let result = unsafe {
            native.controller().CoreWebView2().and_then(|core| {
                let mut back = Default::default();
                let mut forward = Default::default();
                core.CanGoBack(&mut back)?;
                core.CanGoForward(&mut forward)?;
                Ok((back.as_bool(), forward.as_bool()))
            })
        };
        if let Ok((back, forward)) = result {
            app.state::<WebViewerState>().change(&app, &id, |tab| {
                tab.back = back;
                tab.forward = forward;
            });
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn refresh_history(_view: &Webview) {}

#[cfg(target_os = "windows")]
fn history(view: &Webview, back: bool) -> Result<(), String> {
    let (send, receive) = mpsc::sync_channel(1);
    view.with_webview(move |native| {
        // SAFETY: the native controller is accessed only on its owning UI thread.
        let result = unsafe {
            native.controller().CoreWebView2().and_then(|core| {
                if back {
                    core.GoBack()
                } else {
                    core.GoForward()
                }
            })
        }
        .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED".to_string());
        let _ = send.send(result);
    })
    .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED")?;
    receive
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "PLUGIN_REQUEST_TIMEOUT")?
}

#[cfg(not(target_os = "windows"))]
fn history(_view: &Webview, _back: bool) -> Result<(), String> {
    Err("PLUGIN_API_UNAVAILABLE".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn menu_region_preserves_page_outside_multiple_menus_and_restores_on_close() {
        use windows::Win32::Graphics::Gdi::PtInRegion;
        let bounds = Bounds {
            x: 100.0,
            y: 50.0,
            width: 400.0,
            height: 300.0,
        };
        let menus = vec![
            Bounds {
                x: 80.0,
                y: 40.0,
                width: 80.0,
                height: 90.0,
            },
            Bounds {
                x: 200.0,
                y: 150.0,
                width: 50.0,
                height: 60.0,
            },
        ];
        let region = menu_region(bounds, &menus, 1.5).unwrap();
        // SAFETY: menu_region returns an owned, live GDI region.
        unsafe {
            assert!(!PtInRegion(region.0, 10, 10).as_bool());
            assert!(!PtInRegion(region.0, 160, 160).as_bool());
            assert!(PtInRegion(region.0, 400, 300).as_bool());
        }
        let restored = menu_region(bounds, &[], 1.5).unwrap();
        unsafe {
            assert!(PtInRegion(restored.0, 10, 10).as_bool());
            assert!(PtInRegion(restored.0, 160, 160).as_bool());
        }
    }

    fn scope() -> Scope {
        Scope {
            window: "main".into(),
            plugin: "com.example.viewer".into(),
            runtime: "generation-one".into(),
            view_type: "com.example.viewer.browser".into(),
            instance: "first".into(),
        }
    }
    fn manifest() -> Value {
        json!({ "permissions": [{ "id": "webViewer.navigate" }], "contributes": {
            "views": [{ "type": "com.example.viewer.browser", "capabilities": ["webViewer"] }] } })
    }

    #[test]
    fn new_window_links_navigate_the_authorized_source() {
        for target in ["http://news.baidu.com/", "https://map.baidu.com/"] {
            let mut navigated = None;
            navigate_new_window(
                &Url::parse(target).unwrap(),
                || validate_scope(&manifest(), &scope()),
                |url| {
                    navigated = Some(url.to_string());
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(navigated.as_deref(), Some(target));
        }
    }

    #[test]
    fn new_window_links_reject_invalid_urls_revoked_permissions_and_closed_sources() {
        for target in [
            "file:///C:/secret.txt",
            "javascript:alert(1)",
            "about:blank",
            "https://tauri.localhost/",
            "https://user:password@example.com/",
        ] {
            let error = navigate_new_window(
                &Url::parse(target).unwrap(),
                || panic!("invalid targets must be rejected before authorization"),
                |_| panic!("invalid targets must never navigate"),
            )
            .unwrap_err();
            assert_eq!(error, "PLUGIN_INVALID_ARGUMENT");
        }
        let url = Url::parse("https://news.baidu.com/").unwrap();
        let mut revoked = manifest();
        revoked["permissions"] = json!([]);
        assert_eq!(
            navigate_new_window(
                &url,
                || validate_scope(&revoked, &scope()),
                |_| panic!("revoked permissions must never navigate"),
            )
            .unwrap_err(),
            "PLUGIN_PERMISSION_NOT_DECLARED"
        );
        let catalog = Catalog::default();
        assert_eq!(
            navigate_new_window(
                &url,
                || catalog.require(&scope(), "closed-source").map(|_| ()),
                |_| panic!("closed source must never navigate"),
            )
            .unwrap_err(),
            "PLUGIN_WEBVIEWER_TAB_NOT_FOUND"
        );
        assert_eq!(
            navigate_new_window(
                &url,
                || Err("PLUGIN_RUNTIME_TERMINATED".into()),
                |_| panic!("revoked generations must never navigate"),
            )
            .unwrap_err(),
            "PLUGIN_RUNTIME_TERMINATED"
        );
        assert_eq!(
            navigate_new_window(
                &url,
                || Ok(()),
                |_| Err("PLUGIN_WEBVIEWER_OPERATION_FAILED".into()),
            )
            .unwrap_err(),
            "PLUGIN_WEBVIEWER_OPERATION_FAILED"
        );
    }

    #[test]
    fn favorite_requires_plugin_private_storage_permission() {
        let action: Action =
            serde_json::from_value(json!("favorite")).expect("public favorite action");
        let mut grants = manifest();
        assert_eq!(
            validate_action(&grants, &scope(), action).unwrap_err(),
            "PLUGIN_PERMISSION_NOT_DECLARED"
        );
        grants["permissions"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id": "storage.plugin"}));
        assert!(validate_action(&grants, &scope(), action).is_ok());
    }

    #[test]
    fn favorites_persist_deduplicate_isolate_plugins_and_preserve_other_keys() {
        let root = std::env::temp_dir().join(format!("wstudio-favorites-{}", uuid::Uuid::new_v4()));
        let first = root.join("first/storage.json");
        let second = root.join("second/storage.json");
        let grants = json!({"permissions": [{"id": "storage.plugin"}]});
        super::super::update_plugin_storage_value(&first, "other".into(), Some(json!(42))).unwrap();
        for _ in 0..2 {
            save_favorite(&first, &grants, "https://example.com/", &|| Ok(())).unwrap();
        }
        save_favorite(&first, &grants, "https://second.example/", &|| Ok(())).unwrap();
        assert_eq!(
            super::super::get_plugin_storage_value(&first, "webViewer.favorites")
                .unwrap()
                .value,
            Some(json!(["https://example.com/", "https://second.example/"]))
        );
        assert_eq!(
            super::super::get_plugin_storage_value(&first, "other")
                .unwrap()
                .value,
            Some(json!(42))
        );
        assert!(
            !super::super::get_plugin_storage_value(&second, "webViewer.favorites")
                .unwrap()
                .found
        );
        let original = std::fs::read(&first).unwrap();
        assert_eq!(
            save_favorite(&first, &manifest(), "https://example.com/", &|| Ok(())).unwrap_err(),
            "PLUGIN_PERMISSION_NOT_DECLARED"
        );
        assert_eq!(
            save_favorite(&first, &grants, "https://third.example/", &|| Err(
                "PLUGIN_RUNTIME_TERMINATED".into()
            ))
            .unwrap_err(),
            "PLUGIN_RUNTIME_TERMINATED"
        );
        assert_eq!(std::fs::read(&first).unwrap(), original);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn favorites_reject_corrupt_lists_and_revoke_before_atomic_commit() {
        let root = std::env::temp_dir().join(format!("wstudio-favorites-{}", uuid::Uuid::new_v4()));
        let path = root.join("storage.json");
        let grants = json!({"permissions": [{"id": "storage.plugin"}]});
        for invalid in [json!(null), json!(["file:///private"]), json!([42])] {
            super::super::update_plugin_storage_value(
                &path,
                "webViewer.favorites".into(),
                Some(invalid),
            )
            .unwrap();
            let original = std::fs::read(&path).unwrap();
            assert_eq!(
                save_favorite(&path, &grants, "https://example.com/", &|| Ok(())).unwrap_err(),
                "PLUGIN_STORAGE_INVALID"
            );
            assert_eq!(std::fs::read(&path).unwrap(), original);
        }
        super::super::update_plugin_storage_value(
            &path,
            "webViewer.favorites".into(),
            Some(json!([])),
        )
        .unwrap();
        let calls = std::cell::Cell::new(0);
        assert_eq!(
            save_favorite(&path, &grants, "https://example.com/", &|| {
                calls.set(calls.get() + 1);
                if calls.get() == 3 {
                    Err("PLUGIN_RUNTIME_TERMINATED".into())
                } else {
                    Ok(())
                }
            })
            .unwrap_err(),
            "PLUGIN_RUNTIME_TERMINATED"
        );
        assert_eq!(
            super::super::get_plugin_storage_value(&path, "webViewer.favorites")
                .unwrap()
                .value,
            Some(json!([]))
        );
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn url_gate_rejects_local_schemes_credentials_and_control_characters() {
        for url in ["https://example.com/", "http://localhost:8080/page?q=中文"] {
            assert!(parse_url(url).is_ok());
        }
        for url in [
            "file:///C:/data",
            "javascript:alert(1)",
            "data:text/html,test",
            "about:blank",
            "wstudio-media://localhost/path",
            "wstudio-plugin://localhost/runtime/main.js",
            "http://tauri.localhost/index.html",
            "http://wstudio-media.localhost/private.mp4",
            "https://user:pass@example.com/",
            "https://example.com/\n",
            "invalid",
        ] {
            assert_eq!(parse_url(url).unwrap_err(), "PLUGIN_INVALID_ARGUMENT");
        }
        assert!(parse_url(&format!("https://example.com/{}", "x".repeat(4096))).is_err());
    }

    #[test]
    fn ordinary_view_requires_granted_navigation_and_matching_capability() {
        let current = scope();
        assert!(validate_scope(&manifest(), &current).is_ok());
        let mut value = manifest();
        value["permissions"] = json!([]);
        assert_eq!(
            validate_scope(&value, &current).unwrap_err(),
            "PLUGIN_PERMISSION_NOT_DECLARED"
        );
        value = manifest();
        value["contributes"]["views"][0]["capabilities"] = json!([]);
        assert_eq!(
            validate_scope(&value, &current).unwrap_err(),
            "PLUGIN_VIEW_CAPABILITY_NOT_DECLARED"
        );
        let mut other = current.clone();
        other.view_type = "undeclared".into();
        assert!(validate_scope(&manifest(), &other).is_err());
        other = current;
        other.plugin = "../escape".into();
        assert!(validate_scope(&manifest(), &other).is_err());
        other.plugin = "com.example.viewer".into();
        other.window = "webviewer-remote".into();
        assert!(validate_scope(&manifest(), &other).is_err());
    }

    #[test]
    fn scrollbar_theme_accepts_colors_but_rejects_css_and_script_injection() {
        let theme = ScrollbarTheme {
            background: "#4f5359".into(),
            hover_background: "rgb(148 163 184 / 0.8)".into(),
            active_background: "rgba(226, 232, 240, 1)".into(),
            modern_ui_enabled: true,
        };
        assert!(theme.is_valid());
        for color in [
            "GrayText",
            "#fff8",
            "hsl(210 40% 60%)",
            "oklch(0.5 0.1 180)",
            "RGB(10, 20, 30)",
            "color-mix(in srgb, red 50%, blue)",
        ] {
            assert!(ScrollbarTheme {
                background: color.into(),
                ..theme.clone()
            }
            .is_valid());
        }
        for color in [
            "",
            "#ggg",
            "red; color: blue",
            "url(https://example.com/)",
            "');alert(1);//",
            "</script>",
            "rgb(1 2 3)\n",
            "var(--site-secret)",
        ] {
            assert!(!ScrollbarTheme {
                background: color.into(),
                ..theme.clone()
            }
            .is_valid());
        }
        assert!(!ScrollbarTheme {
            background: "a".repeat(129),
            ..theme.clone()
        }
        .is_valid());
        let script = scrollbar_initialization_script(Some(&theme));
        assert!(!script.contains("__WSTUDIO_SCROLLBAR_THEME__"));
        assert!(script.contains(&json!(theme).to_string()));
    }

    #[test]
    fn scrollbar_theme_cache_is_scoped_and_released_with_its_view() {
        let mut catalog = catalog();
        let original = scope();
        let other = Scope {
            runtime: "next-generation".into(),
            ..original.clone()
        };
        let theme = ScrollbarTheme {
            background: "#4f5359".into(),
            hover_background: "#94a3b8".into(),
            active_background: "#e2e8f0".into(),
            modern_ui_enabled: true,
        };
        catalog
            .scrollbar_themes
            .insert(original.clone(), theme.clone());
        catalog
            .scrollbar_themes
            .insert(other.clone(), theme.clone());
        catalog.fail("tab-one");
        assert_eq!(
            catalog.scrollbar_themes.get(&original),
            Some(&theme),
            "recovery retains the theme"
        );
        catalog.remove(|scope| scope == &original);
        assert!(!catalog.scrollbar_themes.contains_key(&original));
        assert_eq!(catalog.scrollbar_themes.get(&other), Some(&theme));
    }

    fn catalog() -> Catalog {
        let current = scope();
        let mut catalog = Catalog::default();
        catalog.bounds.insert(current.clone(), Bounds::default());
        catalog.tabs.insert(
            "tab-one".into(),
            Tab {
                scope: current,
                id: "tab-one".into(),
                title: "Example".into(),
                favicon_url: String::new(),
                url: "https://example.com/".into(),
                loading: false,
                back: true,
                forward: false,
                zoom_level: 0,
                revision: 0,
            },
        );
        catalog
    }

    #[test]
    fn webpage_summary_includes_title_icon_and_exact_view_identity() {
        let mut catalog = catalog();
        let summary = catalog.require(&scope(), "tab-one").unwrap().summary();
        assert_eq!(summary["title"], "Example");
        assert_eq!(summary["faviconUrl"], "");
        assert_eq!(summary["viewType"], "com.example.viewer.browser");
        let tab = catalog.tabs.get_mut("tab-one").unwrap();
        tab.title = "百度一下，你就知道".into();
        tab.favicon_url = "https://www.baidu.com/favicon.ico".into();
        let updated = tab.summary();
        assert_eq!(updated["title"], "百度一下，你就知道");
        assert_eq!(updated["faviconUrl"], "https://www.baidu.com/favicon.ico");
    }

    #[test]
    fn menu_actions_require_current_navigation_and_their_own_additional_grants() {
        let scope = scope();
        let mut grants = manifest();
        for action in [Action::ZoomIn, Action::ZoomOut, Action::ZoomReset] {
            assert!(validate_action(&grants, &scope, action).is_ok());
        }
        for (action, permission) in [
            (Action::NewWindow, "window.manage"),
            (Action::OpenExternal, "external.open"),
        ] {
            assert_eq!(
                validate_action(&grants, &scope, action).unwrap_err(),
                "PLUGIN_PERMISSION_NOT_DECLARED"
            );
            grants["permissions"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "id": permission }));
            assert!(validate_action(&grants, &scope, action).is_ok());
        }
        assert_eq!(
            validate_action(&grants, &scope, Action::SaveToRepository).unwrap_err(),
            "PLUGIN_PERMISSION_NOT_DECLARED"
        );
        grants["permissions"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "id": "dialogs.show" }));
        assert!(validate_action(&grants, &scope, Action::SaveToRepository).is_err());
        grants["permissions"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "id": "workspace.write" }));
        assert!(validate_action(&grants, &scope, Action::SaveToRepository).is_ok());
        grants["permissions"] = json!([{ "id": "window.manage" }, { "id": "external.open" }]);
        assert_eq!(
            validate_action(&grants, &scope, Action::NewWindow).unwrap_err(),
            "PLUGIN_PERMISSION_NOT_DECLARED"
        );
    }

    #[test]
    fn menu_request_cannot_supply_window_runtime_tab_or_arbitrary_urls() {
        let catalog = catalog();
        let request = json!({ "pluginId": "com.example.viewer", "viewType": "com.example.viewer.browser", "instanceId": "first", "action": "zoom-in" });
        let menu: MenuRequest = serde_json::from_value(request.clone()).unwrap();
        assert_eq!(menu.timeout_ms(), 15_000);
        let mut save = request.clone();
        save["action"] = json!("save-to-repository");
        assert_eq!(
            serde_json::from_value::<MenuRequest>(save)
                .unwrap()
                .timeout_ms(),
            300_000
        );
        let tab = catalog.menu_tab("main", &menu).unwrap();
        assert_eq!(tab.scope.runtime, "generation-one");
        assert!(catalog.menu_tab("other-window", &menu).is_err());
        for field in ["pluginId", "instanceId", "viewType"] {
            let mut altered = request.clone();
            altered[field] = json!("other");
            assert!(catalog
                .menu_tab("main", &serde_json::from_value(altered).unwrap())
                .is_err());
        }
        for field in ["window", "runtimeId", "tabId", "url"] {
            let mut altered = request.clone();
            altered[field] = json!("untrusted");
            assert!(serde_json::from_value::<MenuRequest>(altered).is_err());
        }
        for action in [json!("unknown"), json!(null), json!(1)] {
            assert!(serde_json::from_value::<Action>(action).is_err());
        }
    }

    #[test]
    fn native_zoom_is_bounded_and_reset_recovers_the_original_scale() {
        let mut level = 0;
        for _ in 0..20 {
            level = next_zoom(level, Action::ZoomIn);
        }
        assert_eq!(level, 5);
        for _ in 0..20 {
            level = next_zoom(level, Action::ZoomOut);
        }
        assert_eq!(level, -5);
        assert_eq!(next_zoom(level, Action::ZoomReset), 0);
        assert_eq!(
            1.2_f64.powi(i32::from(next_zoom(level, Action::ZoomReset))),
            1.0
        );
    }

    #[test]
    fn snapshot_rejects_navigation_reload_disposal_and_replacement_generation() {
        let mut catalog = catalog();
        let original = catalog.require(&scope(), "tab-one").unwrap();
        assert!(catalog.require_snapshot(&original).is_ok());
        for kind in 0..4 {
            let mut changed = original.clone();
            match kind {
                0 => changed.revision += 1,
                1 => changed.url = "https://example.com/next".into(),
                2 => changed.loading = true,
                _ => changed.scope.runtime = "replacement".into(),
            }
            catalog.tabs.insert(changed.id.clone(), changed);
            assert!(catalog.require_snapshot(&original).is_err());
        }
        catalog.tabs.clear();
        assert_eq!(
            catalog.require_snapshot(&original).err().unwrap(),
            "PLUGIN_WEBVIEWER_TAB_NOT_FOUND"
        );
    }

    #[test]
    fn process_failure_invalidates_old_handles_and_saves_but_preserves_other_views_and_bounds() {
        let mut catalog = catalog();
        let original = catalog.require(&scope(), "tab-one").unwrap();
        let mut other = original.clone();
        other.id = "other-window-tab".into();
        other.scope.window = "other-window".into();
        catalog.tabs.insert(other.id.clone(), other.clone());
        let mut same_window = original.clone();
        same_window.id = "other-instance-tab".into();
        same_window.scope.instance = "other-instance".into();
        catalog
            .tabs
            .insert(same_window.id.clone(), same_window.clone());
        assert!(catalog.fail(&original.id).is_some());
        assert!(catalog.fail(&original.id).is_none());
        assert!(catalog.require_snapshot(&original).is_err());
        assert!(catalog.require(&original.scope, &original.id).is_err());
        assert!(catalog.bounds.contains_key(&original.scope));
        assert!(catalog.require(&other.scope, &other.id).is_ok());
        assert!(catalog.require(&same_window.scope, &same_window.id).is_ok());
        let mut recovered = original.clone();
        recovered.id = "recovered-tab".into();
        catalog.tabs.insert(recovered.id.clone(), recovered);
        assert!(catalog.fail(&original.id).is_none());
        assert_eq!(catalog.list(&original.scope)[0]["id"], "recovered-tab");
        assert!(catalog.require_snapshot(&original).is_err());
        catalog.remove(|scope| scope == &original.scope);
        assert!(!catalog.bounds.contains_key(&original.scope));
    }

    #[test]
    fn save_dialog_slots_are_bounded_isolated_and_released_on_drop() {
        let state = WebViewerState::default();
        let first = state.save_permit("main").unwrap();
        assert_eq!(
            state.save_permit("main").err().unwrap(),
            "PLUGIN_WEBVIEWER_SAVE_BUSY"
        );
        let others: Vec<_> = (0..7)
            .map(|id| state.save_permit(&format!("window-{id}")).unwrap())
            .collect();
        assert_eq!(
            state.save_permit("overflow").err().unwrap(),
            "PLUGIN_WEBVIEWER_LIMIT_EXCEEDED"
        );
        drop(first);
        assert!(state.save_permit("main").is_ok());
        drop(others);
        assert!(state.saves.lock().unwrap().is_empty());
    }

    #[test]
    fn detached_webpage_preserves_url_without_injecting_workbench_parameters() {
        let request = super::super::PluginWindowOpenRequest {
            plugin_id: Some("com.example.viewer".into()),
            view_type: Some("example.browser".into()),
            ..Default::default()
        };
        let webpage = "https://example.com/path?q=中文&pluginId=com.other.viewer#section";
        let query =
            super::super::plugin_window_query(&request, "plugin", "new-instance", Some(webpage));
        let url = Url::parse(&format!("https://tauri.localhost/{query}")).unwrap();
        let values: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(values["pluginId"], "com.example.viewer");
        assert_eq!(values["pluginViewType"], "example.browser");
        assert_eq!(values["pluginInstanceId"], "new-instance");
        assert_eq!(values["pluginUrl"], webpage);
        assert!(url.fragment().is_none());
    }

    #[test]
    fn tab_handles_cannot_cross_window_plugin_instance_view_or_generation() {
        let catalog = catalog();
        let current = scope();
        assert_eq!(catalog.list(&current)[0]["canGoBack"], true);
        assert!(catalog.require(&current, "tab-one").is_ok());
        for field in 0..5 {
            let mut other = current.clone();
            match field {
                0 => other.window = "second".into(),
                1 => other.plugin = "com.other.viewer".into(),
                2 => other.instance = "second".into(),
                3 => other.runtime = "generation-two".into(),
                _ => other.view_type = "second".into(),
            }
            assert_eq!(
                catalog.require(&other, "tab-one").err().unwrap(),
                "PLUGIN_WEBVIEWER_TAB_NOT_FOUND"
            );
            assert_eq!(catalog.list(&other), json!([]));
        }
    }

    #[test]
    fn disposal_removes_tabs_and_bounds_and_is_idempotent() {
        let mut catalog = catalog();
        assert!(catalog.remove(|scope| scope.window == "other").is_empty());
        assert_eq!(
            catalog
                .remove(|scope| scope.plugin == "com.example.viewer")
                .len(),
            1
        );
        assert!(catalog.tabs.is_empty() && catalog.bounds.is_empty());
        assert!(catalog.remove(|_| true).is_empty());
    }

    #[test]
    fn stale_generation_disposal_preserves_new_generation_and_other_windows() {
        let mut catalog = catalog();
        let mut replacement = catalog.tabs["tab-one"].clone();
        replacement.id = "tab-two".into();
        replacement.scope.runtime = "generation-two".into();
        catalog
            .bounds
            .insert(replacement.scope.clone(), Bounds::default());
        catalog
            .tabs
            .insert(replacement.id.clone(), replacement.clone());
        let mut second_window = replacement;
        second_window.id = "tab-three".into();
        second_window.scope.window = "second".into();
        catalog
            .bounds
            .insert(second_window.scope.clone(), Bounds::default());
        catalog.tabs.insert(second_window.id.clone(), second_window);
        assert_eq!(
            catalog
                .remove(|scope| scope.runtime == "generation-one")
                .len(),
            1
        );
        assert_eq!(catalog.tabs.len(), 2);
        assert_eq!(catalog.bounds.len(), 2);
        assert_eq!(catalog.remove(|scope| scope.window == "main").len(), 1);
        assert_eq!(catalog.tabs.len(), 1);
        assert!(catalog.tabs.contains_key("tab-three"));
    }

    #[test]
    fn rectangles_clip_to_client_area_and_hide_zero_or_offscreen_content() {
        let clipped = clip(
            Bounds {
                x: 80.0,
                y: 40.0,
                width: 50.0,
                height: 50.0,
            },
            100.0,
            60.0,
        )
        .unwrap();
        assert_eq!(
            (clipped.x, clipped.y, clipped.width, clipped.height),
            (80.0, 40.0, 20.0, 20.0)
        );
        assert!(clip(Bounds::default(), 100.0, 60.0).is_none());
        assert!(clip(
            Bounds {
                x: 110.0,
                width: 10.0,
                height: 10.0,
                ..Bounds::default()
            },
            100.0,
            60.0
        )
        .is_none());
    }

    #[test]
    fn expired_native_operations_are_rejected_before_committing_resources() {
        assert_eq!(check_deadline(0).unwrap_err(), "PLUGIN_REQUEST_TIMEOUT");
        assert!(check_deadline(u64::MAX).is_ok());
        assert!(is_remote("webviewer-one"));
        assert!(!is_remote("main"));
    }

    #[test]
    fn configured_capabilities_are_bound_to_trusted_webviews_instead_of_parent_windows() {
        let capability: tauri::utils::acl::capability::Capability =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(
            capability.windows.is_empty(),
            "Window grants would apply to every child WebView"
        );
        assert!(capability.local && capability.remote.is_none());
        assert!(capability.webviews.iter().any(|label| label == "main"));
        assert!(capability
            .webviews
            .iter()
            .all(|label| !label.starts_with('*') && !is_remote(label)));
    }
}
