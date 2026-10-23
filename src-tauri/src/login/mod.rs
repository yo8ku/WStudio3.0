//! Host-owned backend login, deep-link delivery, cancellation and server-validated session restore.
pub(crate) mod google;
pub(crate) mod receipt;
pub(crate) mod server;

use receipt::LoginReceipt;
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tokio::sync::watch;
use uuid::Uuid;
use zeroize::Zeroizing;

type Callback = Result<Arc<Zeroizing<String>>, String>;
struct PendingAttempt {
    flow: google::GoogleFlow,
    provider: String,
    callback: watch::Sender<Option<Callback>>,
    waiting: bool,
}

#[derive(Default)]
pub(crate) struct LoginState {
    attempts: Mutex<HashMap<String, PendingAttempt>>,
    completion: tokio::sync::Mutex<()>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginAttempt {
    attempt_id: String,
    expires_at: u64,
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl LoginState {
    /// Ignore unsolicited, expired and duplicate links without consuming an active login.
    fn receive(&self, url: &str) {
        let Some(callback) = google::parse_backend_callback(url) else {
            return;
        };
        if let Ok(attempts) = self.attempts.lock() {
            if let Some(pending) = attempts.values().find(|pending| {
                pending.flow.flow_id == callback.flow_id && pending.flow.expires_at > now_ms()
            }) {
                if pending.callback.borrow().is_none() {
                    pending
                        .callback
                        .send_replace(Some(callback.code.map(Arc::new)));
                }
            }
        }
    }

    /// Drop verifier and wake any pending wait as soon as the user cancels.
    fn cancel(&self, id: &str) -> Result<(), String> {
        if let Some(attempt) = self
            .attempts
            .lock()
            .map_err(|_| "LOGIN_STATE_FAILED")?
            .remove(id)
        {
            attempt
                .callback
                .send_replace(Some(Err("LOGIN_CANCELLED".into())));
        }
        Ok(())
    }
}

/// Install native deep-link handling after LoginState exists; renderer never receives the ticket.
pub(crate) fn initialize(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(any(windows, target_os = "linux"))]
    app.deep_link().register_all()?;
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            handle.state::<LoginState>().receive(url.as_str());
        }
    });
    Ok(())
}

/// Login belongs to trusted first-party host/settings windows; plugin and remote windows cannot change host sessions.
fn require_host(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" && !window.label().starts_with("wstudio-settings-") {
        return Err("LOGIN_HOST_ONLY".into());
    }
    Ok(())
}

async fn login_provider_begin(
    _app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, LoginState>,
    provider: &'static str,
) -> Result<LoginAttempt, String> {
    require_host(&window)?;
    let (flow, url) = google::prepare_provider(provider).await?;
    let attempt_id = Uuid::new_v4().to_string();
    let expires_at = flow.expires_at;
    {
        let mut attempts = state.attempts.lock().map_err(|_| "LOGIN_STATE_FAILED")?;
        attempts.retain(|_, value| value.flow.expires_at > now_ms());
        if !attempts.is_empty() {
            return Err("LOGIN_ALREADY_PENDING".into());
        }
        let (callback, _) = watch::channel(None);
        attempts.insert(
            attempt_id.clone(),
            PendingAttempt {
                flow,
                provider: provider.into(),
                callback,
                waiting: false,
            },
        );
    }
    if open::that(url.as_str()).is_err() {
        state.cancel(&attempt_id)?;
        return Err("LOGIN_BROWSER_OPEN_FAILED".into());
    }
    // Clean up abandoned attempts even when the renderer never calls wait/cancel.
    let app = _app.clone();
    let id = attempt_id.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(expires_at.saturating_sub(now_ms()))).await;
        if let Some(state) = app.try_state::<LoginState>() {
            let _ = state.cancel(&id);
        }
    });
    Ok(LoginAttempt {
        attempt_id,
        expires_at,
    })
}

#[tauri::command]
pub(crate) async fn login_google_begin(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, LoginState>,
) -> Result<LoginAttempt, String> {
    login_provider_begin(app, window, state, "google").await
}

#[tauri::command]
pub(crate) async fn login_github_begin(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, LoginState>,
) -> Result<LoginAttempt, String> {
    login_provider_begin(app, window, state, "github").await
}

/// Consume one callback and save a backend-confirmed session, with cancellation checked before commit.
#[tauri::command]
pub(crate) async fn login_wait(
    attempt_id: String,
    window: tauri::WebviewWindow,
    state: State<'_, LoginState>,
    database: State<'_, super::DatabaseState>,
) -> Result<LoginReceipt, String> {
    require_host(&window)?;
    if attempt_id.trim().is_empty() || attempt_id.len() > 128 {
        return Err("LOGIN_INVALID_ATTEMPT".into());
    }
    let (mut receiver, deadline) = {
        let mut attempts = state.attempts.lock().map_err(|_| "LOGIN_STATE_FAILED")?;
        let pending = attempts
            .get_mut(&attempt_id)
            .ok_or("LOGIN_ATTEMPT_NOT_FOUND")?;
        if pending.waiting {
            return Err("LOGIN_ALREADY_PENDING".into());
        }
        pending.waiting = true;
        (pending.callback.subscribe(), pending.flow.expires_at)
    };
    let callback = tokio::time::timeout(
        Duration::from_millis(deadline.saturating_sub(now_ms())),
        async {
            loop {
                if let Some(value) = receiver.borrow().clone() {
                    break value;
                }
                receiver
                    .changed()
                    .await
                    .map_err(|_| "LOGIN_CANCELLED".to_owned())?;
            }
        },
    )
    .await
    .map_err(|_| "LOGIN_TIMEOUT".to_owned())
    .and_then(|value| value);
    let code = match callback {
        Ok(code) => code,
        Err(error) => {
            state.cancel(&attempt_id)?;
            return Err(error);
        }
    };
    let (server, verifier) = {
        let attempts = state.attempts.lock().map_err(|_| "LOGIN_STATE_FAILED")?;
        let pending = attempts.get(&attempt_id).ok_or("LOGIN_CANCELLED")?;
        (
            pending.flow.server.clone(),
            Zeroizing::new(pending.flow.verifier.to_string()),
        )
    };
    let exchange_started = now_ms() / 1000;
    let result = server.exchange(code.as_str(), &verifier).await;
    let login = match result {
        Ok(login) => login,
        Err(error) => {
            state.cancel(&attempt_id)?;
            return Err(error);
        }
    };
    let _completion = state.completion.lock().await;
    let mut attempts = state.attempts.lock().map_err(|_| "LOGIN_STATE_FAILED")?;
    let pending = attempts.get(&attempt_id).ok_or("LOGIN_CANCELLED")?;
    if pending.flow.expires_at <= now_ms() {
        attempts.remove(&attempt_id);
        return Err("LOGIN_TIMEOUT".into());
    }
    let now = now_ms() / 1000;
    let mut receipt = receipt::create(
        &pending.provider,
        &login.user.id,
        exchange_started + login.expires_in,
        now,
    );
    receipt.email = login.user.email.clone();
    receipt.name = login.user.name.clone();
    receipt.avatar_url = login.user.avatar_url.clone();
    let connection = database
        .connection
        .lock()
        .map_err(|_| "LOGIN_STORAGE_FAILED")?;
    let result = server.persist(login, &receipt, &connection);
    attempts.remove(&attempt_id);
    result?;
    Ok(receipt)
}

#[tauri::command]
pub(crate) fn login_cancel(
    attempt_id: String,
    window: tauri::WebviewWindow,
    state: State<'_, LoginState>,
) -> Result<(), String> {
    require_host(&window)?;
    state.cancel(&attempt_id)
}

/// Confirm every stored OS session with `/me` before exposing account metadata to the renderer.
#[tauri::command]
pub(crate) async fn login_get_receipts(
    window: tauri::WebviewWindow,
    state: State<'_, LoginState>,
    database: State<'_, super::DatabaseState>,
) -> Result<Vec<LoginReceipt>, String> {
    require_host(&window)?;
    let _completion = state.completion.lock().await;
    let server = server::ServerClient::configured()?;
    let sessions = server.load_sessions()?;
    if sessions.is_empty() {
        return Ok(Vec::new());
    }
    let mut confirmed = Vec::with_capacity(sessions.len());
    for session in sessions {
        let user = match server.me(&session.token).await {
            Ok(user) if user.id == session.account_id => user,
            Ok(_) => return Err("LOGIN_SERVER_RESPONSE_INVALID".into()),
            Err(error) if error == "LOGIN_SESSION_EXPIRED" || error == "LOGIN_ACCOUNT_DISABLED" => {
                continue
            }
            Err(error) => return Err(error),
        };
        confirmed.push((session, user));
    }
    let connection = database
        .connection
        .lock()
        .map_err(|_| "LOGIN_STORAGE_FAILED")?;
    let stored = receipt::load_all(&connection, &server.owner(), now_ms() / 1000)?;
    let mut receipts = Vec::with_capacity(confirmed.len());
    for (session, user) in confirmed {
        let account_hash = receipt::account_hash(&session.account_id);
        if let Some(mut value) = stored
            .iter()
            .find(|value| {
                value.account_hash == account_hash && value.expires_at == session.expires_at
            })
            .cloned()
        {
            value.email = user.email;
            value.name = user.name;
            value.avatar_url = user.avatar_url;
            receipts.push(value);
        }
    }
    Ok(receipts)
}

/// Pending legacy local receipts are ignored; /me must confirm the active OS-stored session.
#[tauri::command]
pub(crate) async fn login_get_receipt(
    window: tauri::WebviewWindow,
    state: State<'_, LoginState>,
    database: State<'_, super::DatabaseState>,
) -> Result<Option<LoginReceipt>, String> {
    require_host(&window)?;
    let server = server::ServerClient::configured()?;
    let Some(session) = server.load_session()? else {
        return Ok(None);
    };
    let receipts = login_get_receipts(window, state, database).await?;
    Ok(receipts.into_iter().find(|value| {
        value.account_hash == receipt::account_hash(&session.account_id)
            && value.expires_at == session.expires_at
    }))
}

/// Switch the active local session without re-running provider authorization.
#[tauri::command]
pub(crate) fn login_select_account(
    account_hash: String,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    require_host(&window)?;
    if account_hash.len() != 64 || !account_hash.chars().all(|value| value.is_ascii_hexdigit()) {
        return Err("LOGIN_ACCOUNT_NOT_FOUND".into());
    }
    server::ServerClient::configured()?.select_session(&account_hash)
}

/// Clear one local OS session and its non-secret receipt; the backend session simply expires later.
#[tauri::command]
pub(crate) fn login_logout(
    account_hash: Option<String>,
    window: tauri::WebviewWindow,
    database: State<'_, super::DatabaseState>,
) -> Result<(), String> {
    require_host(&window)?;
    let server = server::ServerClient::configured()?;
    let target = match account_hash {
        Some(value) => value,
        None => server
            .load_session()?
            .map(|session| receipt::account_hash(&session.account_id))
            .ok_or("LOGIN_ACCOUNT_NOT_FOUND")?,
    };
    let connection = database
        .connection
        .lock()
        .map_err(|_| "LOGIN_STORAGE_FAILED")?;
    server.clear_session(Some(&target))?;
    receipt::clear(&connection, &server.owner(), Some(&target))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn insert(state: &LoginState, id: &str) -> watch::Receiver<Option<Callback>> {
        let (callback, receiver) = watch::channel(None);
        let flow = google::GoogleFlow {
            server: server::ServerClient::new("http://localhost:8080").unwrap(),
            flow_id: "A".repeat(43),
            verifier: Zeroizing::new("B".repeat(43)),
            expires_at: now_ms() + 60000,
        };
        state.attempts.lock().unwrap().insert(
            id.into(),
            PendingAttempt {
                flow,
                provider: "google".into(),
                callback,
                waiting: false,
            },
        );
        receiver
    }
    #[test]
    fn unrelated_and_duplicate_links_do_not_replace_the_expected_ticket() {
        let state = LoginState::default();
        let receiver = insert(&state, "attempt");
        state.receive(&format!(
            "wstudio://auth/callback?flow_id={}&code={}",
            "C".repeat(43),
            "B".repeat(43)
        ));
        assert!(receiver.borrow().is_none());
        state.receive(&format!(
            "wstudio://auth/callback?flow_id={}&code={}",
            "A".repeat(43),
            "B".repeat(43)
        ));
        assert_eq!(
            receiver
                .borrow()
                .as_ref()
                .unwrap()
                .as_ref()
                .unwrap()
                .as_str(),
            "B".repeat(43)
        );
        state.receive(&format!(
            "wstudio://auth/callback?flow_id={}&code={}",
            "A".repeat(43),
            "D".repeat(43)
        ));
        assert_eq!(
            receiver
                .borrow()
                .as_ref()
                .unwrap()
                .as_ref()
                .unwrap()
                .as_str(),
            "B".repeat(43)
        );
    }
    #[tokio::test]
    async fn cancel_wakes_waiter_and_discards_verifier() {
        let state = LoginState::default();
        let mut receiver = insert(&state, "attempt");
        state.cancel("attempt").unwrap();
        receiver.changed().await.unwrap();
        assert_eq!(
            receiver.borrow().as_ref().unwrap().as_ref().unwrap_err(),
            "LOGIN_CANCELLED"
        );
        assert!(state.attempts.lock().unwrap().is_empty());
    }
}
