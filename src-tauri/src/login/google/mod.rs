//! Browser OAuth flow uses backend-owned provider credentials and client-owned PKCE.
use super::server::ServerClient;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub(crate) struct GoogleFlow {
    pub server: ServerClient,
    pub flow_id: String,
    pub verifier: Zeroizing<String>,
    pub expires_at: u64,
}

pub(crate) struct BackendCallback {
    pub flow_id: String,
    pub code: Result<Zeroizing<String>, String>,
}

/// PKCE verifier stays in the native process until the WStudio ticket is exchanged.
pub(crate) fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub(crate) fn valid_ticket(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Bind each deep link to an outstanding server flow, with no duplicate credential fields.
pub(crate) fn parse_backend_callback(value: &str) -> Option<BackendCallback> {
    if value.len() > 4096 {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    if url.scheme() != "wstudio"
        || url.host_str() != Some("auth")
        || url.path() != "/callback"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    let field = |name: &str| {
        pairs
            .iter()
            .filter(|(key, _)| key == name)
            .map(|(_, value)| value.as_ref())
            .collect::<Vec<_>>()
    };
    let flow = field("flow_id");
    let codes = field("code");
    let errors = field("error");
    if flow.len() != 1 || !valid_ticket(flow[0]) {
        return None;
    }
    let code = if codes.len() == 1 && errors.is_empty() && valid_ticket(codes[0]) {
        Ok(Zeroizing::new(codes[0].to_owned()))
    } else if errors.len() == 1 && codes.is_empty() {
        Err(super::server::login_error_code(errors[0]).to_owned())
    } else {
        return None;
    };
    Some(BackendCallback {
        flow_id: flow[0].to_owned(),
        code,
    })
}

pub(crate) async fn prepare_provider(provider: &str) -> Result<(GoogleFlow, reqwest::Url), String> {
    let expected_host = match provider {
        "google" => "accounts.google.com",
        "github" => "github.com",
        _ => return Err("LOGIN_PROVIDER_UNAVAILABLE".into()),
    };
    let server = ServerClient::configured()?;
    let mut random = [0u8; 32];
    OsRng.fill_bytes(&mut random);
    let verifier = Zeroizing::new(URL_SAFE_NO_PAD.encode(random));
    let issued_at = super::now_ms();
    let start = server.start(provider, &pkce_challenge(&verifier)).await?;
    let url = reqwest::Url::parse(&start.authorization_url)
        .map_err(|_| "LOGIN_SERVER_RESPONSE_INVALID")?;
    if url.scheme() != "https"
        || url.host_str() != Some(expected_host)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || url.query_pairs().any(|(key, _)| key == "client_secret")
        || !valid_ticket(&start.flow_id)
        || start.expires_in == 0
        || start.expires_in > 300
    {
        return Err("LOGIN_SERVER_RESPONSE_INVALID".into());
    }
    let expires_at = issued_at + start.expires_in * 1000;
    Ok((
        GoogleFlow {
            server,
            flow_id: start.flow_id,
            verifier,
            expires_at,
        },
        url,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pkce_matches_rfc7636_vector() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }
    #[test]
    fn backend_callback_binds_flow_and_requires_one_code() {
        let flow = "A".repeat(43);
        let code = "B".repeat(43);
        let result = parse_backend_callback(&format!(
            "wstudio://auth/callback?flow_id={flow}&code={code}"
        ))
        .unwrap();
        assert_eq!(result.flow_id, flow);
        assert_eq!(result.code.unwrap().as_str(), code);
        for link in [
            "https://auth/callback?flow_id=a&code=b",
            "wstudio://other/callback?flow_id=a&code=b",
            "wstudio://auth/other?flow_id=a&code=b",
            "wstudio://auth/callback?flow_id=a&code=b",
            "wstudio://auth/callback?flow_id=a&code=b&code=c",
        ] {
            assert!(parse_backend_callback(link).is_none());
        }
        for extra in [
            format!("&flow_id={flow}"),
            format!("&code={code}"),
            "&error=authorization_failed".into(),
            "#fragment".into(),
        ] {
            assert!(parse_backend_callback(&format!(
                "wstudio://auth/callback?flow_id={flow}&code={code}{extra}"
            ))
            .is_none());
        }
        let error = parse_backend_callback(&format!(
            "wstudio://auth/callback?flow_id={flow}&error=authorization_denied"
        ))
        .unwrap();
        assert_eq!(error.code.unwrap_err(), "LOGIN_AUTHORIZATION_DENIED");
    }
}
