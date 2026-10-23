//! WebView2 fatal-process observation with controller-lifetime stamps and idempotent cleanup.
use std::collections::HashMap;
use std::sync::{mpsc, Mutex};
use tauri::{Manager, Webview};

#[derive(Default)]
struct Listeners {
    entries: HashMap<String, (String, bool)>,
}

impl Listeners {
    /// Reserve before dispatching to the UI thread so repeated loads register only once.
    fn reserve(&mut self, label: &str) -> Option<String> {
        if self.entries.contains_key(label) {
            return None;
        }
        let stamp = uuid::Uuid::new_v4().to_string();
        self.entries.insert(label.into(), (stamp.clone(), false));
        Some(stamp)
    }

    fn current(&self, label: &str, stamp: &str) -> bool {
        self.entries
            .get(label)
            .is_some_and(|entry| entry.0 == stamp)
    }

    /// Native callbacks claim cleanup synchronously; queued/duplicate callbacks do no work.
    fn claim(&mut self, label: &str, stamp: &str) -> bool {
        let Some(entry) = self.entries.get_mut(label) else {
            return false;
        };
        if entry.0 != stamp || entry.1 {
            return false;
        }
        entry.1 = true;
        true
    }

    fn forget_if(&mut self, label: &str, stamp: &str) {
        if self.current(label, stamp) {
            self.entries.remove(label);
        }
    }
}

#[derive(Default)]
pub(crate) struct NativeProcessState {
    listeners: Mutex<Listeners>,
}

impl NativeProcessState {
    pub(crate) fn forget(&self, label: &str) {
        if let Ok(mut listeners) = self.listeners.lock() {
            listeners.entries.remove(label);
        }
    }

    /// An explicitly reloaded trusted controller may recover and fail again later.
    pub(crate) fn started(&self, label: &str) {
        if let Ok(mut listeners) = self.listeners.lock() {
            if let Some(entry) = listeners.entries.get_mut(label) {
                entry.1 = false;
            }
        }
    }
}

/// Only browser/main-renderer exits invalidate the entire WebView; auxiliary faults do not.
#[cfg(target_os = "windows")]
fn fatal_reason(
    kind: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND,
) -> Option<&'static str> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    match kind {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => Some("browser-exited"),
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => Some("renderer-exited"),
        _ => None,
    }
}

/// Registration never waits on the UI thread. Remote creation may await the returned receipt.
#[cfg(target_os = "windows")]
fn install(view: &Webview) -> Result<Option<mpsc::Receiver<Result<(), String>>>, String> {
    let app = view.app_handle().clone();
    let Some(state) = app.try_state::<NativeProcessState>() else {
        return Ok(None);
    };
    let label = view.label().to_string();
    let stamp = state
        .listeners
        .lock()
        .map_err(|_| "PLUGIN_API_FAILED")?
        .reserve(&label);
    let Some(stamp) = stamp else {
        return Ok(None);
    };
    let (send, receive) = mpsc::sync_channel(1);
    let cleanup_app = app.clone();
    let cleanup_label = label.clone();
    let cleanup_stamp = stamp.clone();
    let dispatched = view.with_webview(move |native| {
        if !app
            .state::<NativeProcessState>()
            .listeners
            .lock()
            .is_ok_and(|listeners| listeners.current(&label, &stamp))
        {
            let _ = send.send(Err("PLUGIN_RUNTIME_TERMINATED".into()));
            return;
        }
        let callback_app = app.clone();
        let callback_label = label.clone();
        let callback_stamp = stamp.clone();
        // SAFETY: WebView2 registration and event callbacks run on the owning UI thread.
        let result = unsafe {
            native.controller().CoreWebView2().and_then(|core| {
                let handler =
                    webview2_com::ProcessFailedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else {
                            return Ok(());
                        };
                        let mut kind = Default::default();
                        args.ProcessFailedKind(&mut kind)?;
                        let Some(reason) = fatal_reason(kind) else {
                            return Ok(());
                        };
                        let claimed = callback_app
                            .state::<NativeProcessState>()
                            .listeners
                            .lock()
                            .is_ok_and(|mut listeners| {
                                listeners.claim(&callback_label, &callback_stamp)
                            });
                        if claimed {
                            if super::web_viewer::is_remote(&callback_label) {
                                callback_app
                                    .state::<super::web_viewer::WebViewerState>()
                                    .process_failed(&callback_app, &callback_label, reason);
                            } else {
                                super::dispose_renderer_resources(&callback_app, &callback_label);
                            }
                        }
                        Ok(())
                    }));
                let mut token = 0;
                core.add_ProcessFailed(&handler, &mut token)
            })
        }
        .map_err(|_| "PLUGIN_WEBVIEWER_OPERATION_FAILED".to_string());
        if result.is_err() {
            app.state::<NativeProcessState>()
                .listeners
                .lock()
                .ok()
                .map(|mut listeners| listeners.forget_if(&label, &stamp));
            eprintln!("WebView2 process listener registration failed: {label}");
        }
        let _ = send.send(result);
    });
    if dispatched.is_err() {
        cleanup_app
            .state::<NativeProcessState>()
            .listeners
            .lock()
            .ok()
            .map(|mut listeners| listeners.forget_if(&cleanup_label, &cleanup_stamp));
        return Err("PLUGIN_WEBVIEWER_OPERATION_FAILED".into());
    }
    Ok(Some(receive))
}

/// Trusted renderer registration is asynchronous; reload/destruction already has its own cleanup.
pub(crate) fn observe(view: &Webview) {
    #[cfg(target_os = "windows")]
    if let Err(error) = install(view) {
        eprintln!("WebView2 process listener: {error}");
    }
    #[cfg(not(target_os = "windows"))]
    let _ = view;
}

/// Fail remote creation if fatal-process observation could not be installed.
pub(crate) fn observe_remote(view: &Webview) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    if let Some(receive) = install(view)? {
        return receive
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "PLUGIN_REQUEST_TIMEOUT")?;
    }
    #[cfg(not(target_os = "windows"))]
    let _ = view;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listener_identity_rejects_duplicate_destroyed_and_reused_labels() {
        let mut listeners = Listeners::default();
        let original = listeners.reserve("main").unwrap();
        let other = listeners.reserve("settings").unwrap();
        assert!(listeners.reserve("main").is_none());
        assert!(!listeners.claim("main", &other));
        assert!(listeners.claim("main", &original));
        assert!(!listeners.claim("main", &original));
        listeners.forget_if("main", &original);
        assert!(!listeners.claim("main", &original));
        let replacement = listeners.reserve("main").unwrap();
        listeners.forget_if("main", &original);
        assert!(!listeners.claim("main", &original));
        assert!(listeners.claim("main", &replacement));
        assert!(listeners.claim("settings", &other));
    }

    #[test]
    fn explicit_reload_rearms_only_the_current_controller() {
        let state = NativeProcessState::default();
        let stamp = state.listeners.lock().unwrap().reserve("main").unwrap();
        assert!(state.listeners.lock().unwrap().claim("main", &stamp));
        state.started("main");
        assert!(state.listeners.lock().unwrap().claim("main", &stamp));
        state.forget("main");
        state.started("main");
        assert!(!state.listeners.lock().unwrap().claim("main", &stamp));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn auxiliary_unresponsive_and_subframe_faults_do_not_destroy_webviews() {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        assert_eq!(
            fatal_reason(COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED),
            Some("browser-exited")
        );
        assert_eq!(
            fatal_reason(COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED),
            Some("renderer-exited")
        );
        for kind in [
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
            COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED,
        ] {
            assert_eq!(fatal_reason(kind), None);
        }
    }
}
