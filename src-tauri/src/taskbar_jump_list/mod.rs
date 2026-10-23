//! Integrates recent repositories with Windows Jump Lists and single-instance launch routing.
#[cfg(any(target_os = "windows", test))]
mod arguments;
mod history;
#[cfg(target_os = "windows")]
mod native;

use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::{collections::VecDeque, ffi::OsString, sync::Mutex};
#[cfg(target_os = "windows")]
use tauri::{AppHandle, Emitter, Manager};

pub(crate) use history::RecentClosedTab;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClosedTabRequest {
    relative_path: String,
    title: String,
}

#[cfg(target_os = "windows")]
#[derive(Default)]
struct PendingLaunches(Mutex<VecDeque<arguments::LaunchRequest>>);

/// Register single-instance forwarding before every other plugin; leave other platforms unchanged.
pub(crate) fn install(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    #[cfg(target_os = "windows")]
    {
        if let Err(error) = native::set_process_identity() {
            eprintln!("[taskbar] Set application identity failed: {error}");
        }
        return builder.manage(PendingLaunches::default()).plugin(
            tauri_plugin_single_instance::init(|app, args, _cwd| {
                match arguments::repository_argument(
                    &args.into_iter().map(OsString::from).collect::<Vec<_>>(),
                ) {
                    Ok(Some(request)) => {
                        if let Ok(mut pending) = app.state::<PendingLaunches>().0.lock() {
                            pending.push_back(request);
                        }
                    }
                    Ok(None) => {}
                    Err(error) => eprintln!("[taskbar] Invalid launch request: {error}"),
                }
                let app_handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    process_pending_launches(&app_handle, false);
                    focus_main_window(&app_handle);
                });
            }),
        );
    }
    #[cfg(not(target_os = "windows"))]
    builder
}

/// Apply cold-start arguments before the frontend initializes, then publish the restored history.
pub(crate) fn initialize(_app: &tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    {
        match arguments::repository_argument(&std::env::args_os().collect::<Vec<_>>()) {
            Ok(Some(request)) => {
                if let Ok(mut pending) = _app.state::<PendingLaunches>().0.lock() {
                    pending.push_front(request);
                }
            }
            Ok(None) => {}
            Err(error) => eprintln!("[taskbar] Invalid startup request: {error}"),
        }
        process_pending_launches(_app, true);
        if let Err(error) = native::start_worker() {
            eprintln!("[taskbar] Start Jump List worker failed: {error}");
        }
        let state = _app.state::<super::WorkspaceState>();
        if let (Ok(recent), Ok(closed)) = (state.recent.lock(), state.recent_closed.lock()) {
            repositories_saved(&recent, &closed);
        };
    }
}

/// Queue an ordered snapshot after persistence succeeds; Shell failures never fail repository saves.
pub(crate) fn repositories_saved(_recent: &[super::RecentRepository], _closed: &[RecentClosedTab]) {
    #[cfg(target_os = "windows")]
    native::queue(_recent.to_vec(), _closed.to_vec());
}

/// Record a file-backed tab in the shared recent-closed history before DockingThree removes it.
#[tauri::command]
pub(crate) fn taskbar_record_closed_tab(
    request: ClosedTabRequest,
    state: tauri::State<'_, super::WorkspaceState>,
) -> Result<(), String> {
    let relative_path = request.relative_path.replace('\\', "/");
    if relative_path.trim().is_empty()
        || PathBuf::from(&relative_path).is_absolute()
        || PathBuf::from(&relative_path)
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("TASKBAR_FILE_PATH_INVALID".to_string());
    }
    let root = super::workspace_root_from_inner(state.inner())?;
    let repository_name = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("WStudio")
        .to_string();
    let title = request.title.trim();
    if title.is_empty() {
        return Err("TASKBAR_FILE_TITLE_REQUIRED".to_string());
    }
    let entry = RecentClosedTab {
        repository_name,
        root_path: root.to_string_lossy().into_owned(),
        relative_path,
        title: title.to_string(),
    };
    let mut history = state
        .recent_closed
        .lock()
        .map_err(|_| "workspace-state-poisoned".to_string())?;
    history::remember(&mut history, entry);
    drop(history);
    state.persist()
}

/// Reuse the authoritative repository validation, persistence and change event for all launches.
#[cfg(target_os = "windows")]
fn process_pending_launches(app: &AppHandle, store_initial_file: bool) {
    let Some(workspace) = app.try_state::<super::WorkspaceState>() else {
        return;
    };
    let pending = app.state::<PendingLaunches>();
    let Ok(mut pending) = pending.0.lock() else {
        return;
    };
    let requests = pending.drain(..).collect::<Vec<_>>();
    drop(pending);
    for request in requests {
        let result =
            super::canonical_directory(&request.repository.to_string_lossy()).and_then(|root| {
                super::remember_repository(&workspace, &root)?;
                super::publish_repository_changed(app, &root)?;
                let Some(relative_path) = request.file.as_ref() else {
                    return Ok(());
                };
                let relative_path = relative_path.to_string_lossy().replace('\\', "/");
                let Some(payload) = super::build_workspace_open_file_request(
                    &root,
                    &relative_path,
                    Some("current-group"),
                )?
                else {
                    return Ok(());
                };
                if store_initial_file {
                    let mut initial = workspace
                        .initial_open_file
                        .lock()
                        .map_err(|_| "workspace-state-poisoned".to_string())?;
                    *initial = Some(relative_path);
                } else {
                    app.emit("workspace:openFileRequested", payload)
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            });
        if let Err(error) = result {
            eprintln!("[taskbar] Open repository failed: {error}");
        }
    }
}

/// Restore a minimized/hidden workbench without constructing another host window.
#[cfg(target_os = "windows")]
fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
