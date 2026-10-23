//! Native backend client and OS credential storage. Bearer tokens never cross renderer IPC.
use super::receipt::LoginReceipt;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;
use zeroize::Zeroizing;

const MAX_RESPONSE_BYTES: usize = 64 * 1024;
// Match the backend's five-year session limit (1825 days).
const MAX_SESSION_SECONDS: u64 = 5 * 365 * 24 * 60 * 60;
pub(crate) const MAX_ACCOUNTS: usize = 3;

#[derive(Clone)]
pub(crate) struct ServerClient {
    client: reqwest::Client,
    pub origin: String,
}

#[derive(Deserialize)]
pub(crate) struct StartResponse {
    pub authorization_url: String,
    pub flow_id: String,
    pub expires_in: u64,
}

#[derive(Default, Deserialize, Serialize)]
pub(crate) struct User {
    pub id: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub avatar_url: String,
}

#[derive(Deserialize)]
pub(crate) struct LoginResponse {
    pub access_token: String,
    pub token_type: String,
    pub expires_in: u64,
    pub user: User,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct StoredSession {
    pub token: String,
    pub account_id: String,
    pub expires_at: u64,
}

#[derive(Deserialize, Serialize)]
struct StoredSessions {
    active_account_hash: Option<String>,
    sessions: Vec<StoredSession>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StoredCredential {
    Multi(StoredSessions),
    Legacy(StoredSession),
}

/// Reject untrusted origins before sending a proof or bearer token.
impl ServerClient {
    pub(crate) fn new(origin: &str) -> Result<Self, String> {
        let url = reqwest::Url::parse(origin).map_err(|_| "LOGIN_SERVER_NOT_CONFIGURED")?;
        let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !matches!(url.path(), "" | "/")
            || !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        {
            return Err("LOGIN_SERVER_NOT_CONFIGURED".into());
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "LOGIN_SERVER_REQUEST_FAILED")?;
        Ok(Self {
            client,
            origin: url.as_str().trim_end_matches('/').to_owned(),
        })
    }

    pub(crate) fn configured() -> Result<Self, String> {
        let origin = std::env::var("WSTUDIO_SERVER_URL")
            .ok()
            .or_else(|| option_env!("WSTUDIO_SERVER_URL").map(str::to_owned))
            .ok_or("LOGIN_SERVER_NOT_CONFIGURED")?;
        Self::new(&origin)
    }

    /// Server creates state/nonce and provider PKCE; only the client's challenge leaves this process.
    pub(crate) async fn start(
        &self,
        provider: &str,
        challenge: &str,
    ) -> Result<StartResponse, String> {
        let response = self
            .client
            .post(format!(
                "{}/api/v1/auth/oauth/{provider}/start",
                self.origin
            ))
            .json(&serde_json::json!({"code_challenge": challenge}))
            .send()
            .await
            .map_err(|_| "LOGIN_SERVER_REQUEST_FAILED")?;
        read_json(response).await
    }

    /// Exchange a short-lived WStudio ticket, never a Google authorization code.
    pub(crate) async fn exchange(
        &self,
        code: &str,
        verifier: &str,
    ) -> Result<LoginResponse, String> {
        let response = self
            .client
            .post(format!("{}/api/v1/auth/oauth/exchange", self.origin))
            .json(&serde_json::json!({"code": code, "code_verifier": verifier}))
            .send()
            .await
            .map_err(|_| "LOGIN_SERVER_REQUEST_FAILED")?;
        let login: LoginResponse = read_json(response).await?;
        if !super::google::valid_ticket(&login.access_token)
            || login.token_type != "Bearer"
            || login.expires_in == 0
            || login.expires_in > MAX_SESSION_SECONDS
            || !super::google::valid_ticket(&login.user.id)
        {
            return Err("LOGIN_SERVER_RESPONSE_INVALID".into());
        }
        Ok(login)
    }

    /// Restore UI identity only after the backend accepts the stored WStudio bearer session.
    pub(crate) async fn me(&self, token: &str) -> Result<User, String> {
        #[derive(Deserialize)]
        struct Response {
            user: User,
        }
        let response = self
            .client
            .get(format!("{}/api/v1/auth/me", self.origin))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| "LOGIN_SERVER_REQUEST_FAILED")?;
        let response: Response = read_json(response).await?;
        if !super::google::valid_ticket(&response.user.id) {
            return Err("LOGIN_SERVER_RESPONSE_INVALID".into());
        }
        Ok(response.user)
    }

    pub(crate) fn owner(&self) -> String {
        format!("host:{:x}", Sha256::digest(self.origin.as_bytes()))
    }

    fn credential(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new("com.wstudio.desktop.login", &self.owner())
            .map_err(|_| "LOGIN_STORAGE_FAILED".into())
    }

    fn parse_sessions(raw: &str) -> Result<StoredSessions, String> {
        match serde_json::from_str::<StoredCredential>(raw).map_err(|_| "LOGIN_STORAGE_FAILED")? {
            StoredCredential::Multi(value) => Ok(value),
            StoredCredential::Legacy(value) => Ok(StoredSessions {
                active_account_hash: Some(super::receipt::account_hash(&value.account_id)),
                sessions: vec![value],
            }),
        }
    }

    fn read_sessions(&self) -> Result<StoredSessions, String> {
        let raw = match self.credential()?.get_password() {
            Ok(raw) => Zeroizing::new(raw),
            Err(keyring::Error::NoEntry) => {
                return Ok(StoredSessions {
                    active_account_hash: None,
                    sessions: Vec::new(),
                })
            }
            Err(_) => return Err("LOGIN_STORAGE_FAILED".into()),
        };
        let mut stored = Self::parse_sessions(&raw)?;
        stored.sessions.retain(|session| {
            session.expires_at > super::now_ms() / 1000
                && super::google::valid_ticket(&session.token)
                && super::google::valid_ticket(&session.account_id)
        });
        if stored.sessions.len() > MAX_ACCOUNTS {
            stored.sessions.truncate(MAX_ACCOUNTS);
        }
        if stored.active_account_hash.as_ref().is_none_or(|active| {
            !stored
                .sessions
                .iter()
                .any(|session| super::receipt::account_hash(&session.account_id) == *active)
        }) {
            stored.active_account_hash = stored
                .sessions
                .first()
                .map(|session| super::receipt::account_hash(&session.account_id));
        }
        Ok(stored)
    }

    pub(crate) fn load_sessions(&self) -> Result<Vec<StoredSession>, String> {
        Ok(self.read_sessions()?.sessions)
    }

    pub(crate) fn load_session(&self) -> Result<Option<StoredSession>, String> {
        let stored = self.read_sessions()?;
        let Some(active) = stored.active_account_hash else {
            return Ok(None);
        };
        Ok(stored
            .sessions
            .into_iter()
            .find(|session| super::receipt::account_hash(&session.account_id) == active))
    }

    pub(crate) fn select_session(&self, account_hash: &str) -> Result<(), String> {
        let mut stored = self.read_sessions()?;
        if !stored
            .sessions
            .iter()
            .any(|session| super::receipt::account_hash(&session.account_id) == account_hash)
        {
            return Err("LOGIN_ACCOUNT_NOT_FOUND".into());
        }
        stored.active_account_hash = Some(account_hash.to_owned());
        let encoded =
            Zeroizing::new(serde_json::to_string(&stored).map_err(|_| "LOGIN_STORAGE_FAILED")?);
        self.credential()?
            .set_password(&encoded)
            .map_err(|_| "LOGIN_STORAGE_FAILED".into())
    }

    pub(crate) fn clear_session(&self, account_hash: Option<&str>) -> Result<(), String> {
        let mut stored = self.read_sessions()?;
        if let Some(account_hash) = account_hash {
            stored.sessions.retain(|session| {
                super::receipt::account_hash(&session.account_id) != account_hash
            });
            if stored.sessions.is_empty() {
                return match self.credential()?.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(_) => Err("LOGIN_STORAGE_FAILED".into()),
                };
            }
            if stored.active_account_hash.as_deref() == Some(account_hash) {
                stored.active_account_hash = stored
                    .sessions
                    .first()
                    .map(|session| super::receipt::account_hash(&session.account_id));
            }
        } else {
            stored.sessions.clear();
            stored.active_account_hash = None;
        }
        if stored.sessions.is_empty() {
            return match self.credential()?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err("LOGIN_STORAGE_FAILED".into()),
            };
        }
        let encoded =
            Zeroizing::new(serde_json::to_string(&stored).map_err(|_| "LOGIN_STORAGE_FAILED")?);
        self.credential()?
            .set_password(&encoded)
            .map_err(|_| "LOGIN_STORAGE_FAILED".into())
    }

    /// Write the OS secret first and restore it if saving non-secret metadata fails.
    pub(crate) fn persist(
        &self,
        login: LoginResponse,
        receipt: &LoginReceipt,
        connection: &rusqlite::Connection,
    ) -> Result<(), String> {
        let entry = self.credential()?;
        let previous = match entry.get_password() {
            Ok(raw) => Some(Zeroizing::new(raw)),
            Err(keyring::Error::NoEntry) => None,
            Err(_) => return Err("LOGIN_STORAGE_FAILED".into()),
        };
        let mut stored = previous
            .as_deref()
            .map(|raw| Self::parse_sessions(raw))
            .transpose()?
            .unwrap_or(StoredSessions {
                active_account_hash: None,
                sessions: Vec::new(),
            });
        stored.sessions.retain(|session| {
            session.expires_at > super::now_ms() / 1000
                && super::google::valid_ticket(&session.token)
                && super::google::valid_ticket(&session.account_id)
        });
        let account_hash = super::receipt::account_hash(&login.user.id);
        if let Some(existing) = stored
            .sessions
            .iter_mut()
            .find(|session| session.account_id == login.user.id)
        {
            *existing = StoredSession {
                token: login.access_token.clone(),
                account_id: login.user.id.clone(),
                expires_at: receipt.expires_at,
            };
        } else {
            if stored.sessions.len() >= MAX_ACCOUNTS {
                return Err("LOGIN_ACCOUNT_LIMIT".into());
            }
            stored.sessions.push(StoredSession {
                token: login.access_token.clone(),
                account_id: login.user.id.clone(),
                expires_at: receipt.expires_at,
            });
        }
        stored.active_account_hash = Some(account_hash);
        let encoded =
            Zeroizing::new(serde_json::to_string(&stored).map_err(|_| "LOGIN_STORAGE_FAILED")?);
        entry
            .set_password(&encoded)
            .map_err(|_| "LOGIN_STORAGE_FAILED")?;
        if let Err(error) = super::receipt::save(connection, &self.owner(), receipt) {
            match previous {
                Some(raw) => entry
                    .set_password(&raw)
                    .map_err(|_| "LOGIN_STORAGE_FAILED")?,
                None => entry
                    .delete_credential()
                    .map_err(|_| "LOGIN_STORAGE_FAILED")?,
            }
            return Err(error);
        }
        Ok(())
    }
}

impl Drop for LoginResponse {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.access_token);
    }
}
impl Drop for StoredSession {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.token);
    }
}

/// Bound success and error bodies; expose only stable application errors.
async fn read_json<T: DeserializeOwned>(mut response: reqwest::Response) -> Result<T, String> {
    let success = response.status().is_success();
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err("LOGIN_SERVER_RESPONSE_INVALID".into());
    }
    let mut body = Zeroizing::new(Vec::new());
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "LOGIN_SERVER_REQUEST_FAILED")?
    {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("LOGIN_SERVER_RESPONSE_INVALID".into());
        }
        body.extend_from_slice(&chunk);
    }
    if !success {
        #[derive(Deserialize)]
        struct ErrorResponse {
            code: String,
        }
        let code = serde_json::from_slice::<ErrorResponse>(&body)
            .map(|error| error.code)
            .unwrap_or_default();
        return Err(login_error_code(&code).into());
    }
    serde_json::from_slice(&body).map_err(|_| "LOGIN_SERVER_RESPONSE_INVALID".into())
}

pub(crate) fn login_error_code(code: &str) -> &'static str {
    match code {
        "authorization_denied" => "LOGIN_AUTHORIZATION_DENIED",
        "provider_unavailable" => "LOGIN_GOOGLE_NOT_CONFIGURED",
        "provider_configuration_error" => "LOGIN_PROVIDER_INVALID_CLIENT",
        "authorization_failed" => "LOGIN_AUTHORIZATION_FAILED",
        "invalid_flow" => "LOGIN_AUTHORIZATION_CODE_INVALID",
        "invalid_token" => "LOGIN_SESSION_EXPIRED",
        "account_disabled" => "LOGIN_ACCOUNT_DISABLED",
        "rate_limited" => "LOGIN_RATE_LIMITED",
        _ => "LOGIN_SERVER_REQUEST_FAILED",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backend_origin_requires_https_or_loopback_and_no_credentials_or_path() {
        for origin in [
            "http://localhost:8080",
            "http://127.0.0.1:8080",
            "https://api.example.com/",
        ] {
            assert!(ServerClient::new(origin).is_ok());
        }
        for origin in [
            "http://public.example",
            "https://user:secret@api.example.com",
            "https://api.example.com/path",
            "https://api.example.com?token=x",
            "https://api.example.com#x",
            "",
        ] {
            assert!(ServerClient::new(origin).is_err());
        }
    }
    #[test]
    fn session_is_stored_in_os_keyring_and_sql_failure_restores_prior_session() {
        let client =
            ServerClient::new(&format!("https://{}.example.com", uuid::Uuid::new_v4())).unwrap();
        let entry = client.credential().unwrap();
        struct Cleanup(keyring::Entry);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = self.0.delete_credential();
            }
        }
        let _cleanup = Cleanup(entry);
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        super::super::receipt::initialize(&connection).unwrap();
        let now = super::super::now_ms() / 1000;
        let receipt =
            super::super::receipt::create("google", &"D".repeat(43), now + 157_680_000, now);
        let login = || LoginResponse {
            access_token: "C".repeat(43),
            token_type: "Bearer".into(),
            expires_in: 157_680_000,
            user: User {
                id: "D".repeat(43),
                ..User::default()
            },
        };
        client.persist(login(), &receipt, &connection).unwrap();
        let stored = client.load_session().unwrap().unwrap();
        assert_eq!(stored.token, "C".repeat(43));
        assert_eq!(stored.account_id, "D".repeat(43));
        assert_eq!(stored.expires_at, now + 157_680_000);
        let restarted = ServerClient::new(&client.origin).unwrap();
        assert_eq!(
            restarted.load_session().unwrap().unwrap().expires_at,
            receipt.expires_at
        );
        let restored_receipt = super::super::receipt::load(
            &connection,
            &restarted.owner(),
            now + 4 * 365 * 24 * 60 * 60,
        )
        .unwrap()
        .unwrap();
        assert_eq!(restored_receipt, receipt);
        assert!(
            super::super::receipt::load(&connection, &restarted.owner(), receipt.expires_at,)
                .unwrap()
                .is_none()
        );
        let raw = serde_json::to_string(
            &super::super::receipt::load(&connection, &client.owner(), now).unwrap(),
        )
        .unwrap();
        assert!(!raw.contains(&"C".repeat(43)));
        let bad = rusqlite::Connection::open_in_memory().unwrap();
        let next = LoginResponse {
            access_token: "E".repeat(43),
            token_type: "Bearer".into(),
            expires_in: 3600,
            user: User {
                id: "F".repeat(43),
                ..User::default()
            },
        };
        assert!(client.persist(next, &receipt, &bad).is_err());
        assert_eq!(
            client.load_session().unwrap().unwrap().token,
            "C".repeat(43)
        );
        let other =
            ServerClient::new(&format!("https://{}.example.com", uuid::Uuid::new_v4())).unwrap();
        let _other_cleanup = Cleanup(other.credential().unwrap());
        let other_receipt =
            super::super::receipt::create("google", &"D".repeat(43), now + 3600, now);
        other.persist(login(), &other_receipt, &connection).unwrap();
        assert_ne!(other.owner(), client.owner());
        assert!(
            super::super::receipt::load(&connection, &client.owner(), now)
                .unwrap()
                .is_some()
        );
        assert!(
            super::super::receipt::load(&connection, &other.owner(), now)
                .unwrap()
                .is_some()
        );
        client.clear_session(None).unwrap();
        assert!(client.load_session().unwrap().is_none());
    }

    #[tokio::test]
    async fn backend_http_exchanges_ticket_and_verifier_and_authenticates_me() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let worker = tokio::spawn(async move {
            for step in 0..7 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buf = [0; 1024];
                loop {
                    let count = stream.read(&mut buf).await.unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buf[..count]);
                    if let Some(end) = request.windows(4).position(|b| b == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
                        let size = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length: "))
                            .and_then(|value| value.parse::<usize>().ok())
                            .unwrap_or(0);
                        if request.len() >= end + 4 + size {
                            break;
                        }
                    }
                }
                let request = String::from_utf8(request).unwrap();
                let body = request.split("\r\n\r\n").nth(1).unwrap();
                let response = match step {
                    0 => {
                        assert!(request.starts_with("POST /api/v1/auth/oauth/google/start "));
                        let body: serde_json::Value = serde_json::from_str(body).unwrap();
                        assert_eq!(body["code_challenge"],"challenge");
                        assert!(body.get("client_secret").is_none());
                        serde_json::json!({"authorization_url":"https://oauth.example.test/authorize", "flow_id":"A".repeat(43),"expires_in":300})
                    },
                    1 => {
                        assert!(request.starts_with("POST /api/v1/auth/oauth/exchange "));
                        let body: serde_json::Value = serde_json::from_str(body).unwrap();
                        assert_eq!(body["code"],"B".repeat(43));
                        assert_eq!(body["code_verifier"],"verifier");
                        serde_json::json!({"access_token":"C".repeat(43),"token_type":"Bearer","expires_in":157680000,"user":{"id":"D".repeat(43),"email":"user@example.com","name":"Google User","avatar_url":"https://lh3.googleusercontent.com/avatar"}})
                    },
                    2 => {
                        assert!(request.starts_with("GET /api/v1/auth/me "));
                        assert!(request.to_lowercase().contains(&format!("authorization: bearer {}","C".repeat(43).to_lowercase())));
                        serde_json::json!({"user":{"id":"D".repeat(43),"email":"user@example.com","name":"Google User","avatar_url":"https://lh3.googleusercontent.com/avatar"}})
                    },
                    3 => serde_json::json!({"code":"invalid_flow","message":"DO_NOT_LEAK_SECRET","request_id":"fixture"}),
                    _ => {
                        let ttl = match step { 4 => 0, 5 => 157_680_001, _ => u64::MAX };
                        serde_json::json!({"access_token":"C".repeat(43),"token_type":"Bearer","expires_in":ttl,"user":{"id":"D".repeat(43)}})
                    },
                }.to_string();
                let status = if step == 3 {
                    "401 Unauthorized"
                } else {
                    "200 OK"
                };
                let reply = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len());
                stream.write_all(reply.as_bytes()).await.unwrap();
            }
        });
        let client = ServerClient::new(&origin).unwrap();
        assert_eq!(
            client.start("google", "challenge").await.unwrap().flow_id,
            "A".repeat(43)
        );
        let login = client.exchange(&"B".repeat(43), "verifier").await.unwrap();
        assert_eq!(login.user.id, "D".repeat(43));
        assert_eq!(login.user.email, "user@example.com");
        assert_eq!(login.user.name, "Google User");
        assert_eq!(
            login.user.avatar_url,
            "https://lh3.googleusercontent.com/avatar"
        );
        assert_eq!(login.expires_in, 157_680_000);
        let restored = client.me(&login.access_token).await.unwrap();
        assert_eq!(restored.id, login.user.id);
        assert_eq!(restored.avatar_url, login.user.avatar_url);
        assert_eq!(
            client
                .exchange(&"B".repeat(43), "verifier")
                .await
                .err()
                .unwrap(),
            "LOGIN_AUTHORIZATION_CODE_INVALID"
        );
        for _ in 0..3 {
            assert_eq!(
                client
                    .exchange(&"B".repeat(43), "verifier")
                    .await
                    .err()
                    .unwrap(),
                "LOGIN_SERVER_RESPONSE_INVALID"
            );
        }
        worker.await.unwrap();
    }
}
