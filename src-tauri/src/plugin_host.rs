//! Rust resource Host for the existing shared-renderer plugin model, with revocable generations.
use super::plugin_sidecar::{SidecarHost, SidecarSpec};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_RESOURCE_BYTES: u64 = 10 * 1024 * 1024;

/// One enabled generation; readiness belongs to individual renderer windows.
pub(crate) struct Session {
    pub(crate) id: String,
    pub(crate) path: PathBuf,
    pub(crate) manifest: Value,
    pub(crate) grants: Vec<String>,
    owners: HashSet<String>,
    ready: HashSet<String>,
    failed: bool,
    sidecar: Option<SidecarHost>,
}

impl Session {
    /// Validate before committing desired state; registering resources does not execute code.
    pub(crate) fn new(path: PathBuf, manifest: Value, grants: Vec<String>) -> Result<Self, String> {
        super::plugin_package::validate_app_compatibility(&manifest)?;
        if manifest["permissions"]
            .as_array()
            .is_some_and(|permissions| {
                permissions.iter().any(|p| {
                    matches!(
                        p["id"].as_str(),
                        Some(
                            "renderer.code"
                                | "node.fs"
                                | "node.process"
                                | "node.native"
                                | "electron.system"
                        )
                    )
                })
            })
        {
            return Err("PLUGIN_PRIVILEGED_RUNTIME_NOT_IMPLEMENTED".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let sidecar = sidecar_spec(&path, &manifest, &id)?
            .map(SidecarHost::start)
            .transpose()?;
        Ok(Self {
            id,
            path,
            manifest,
            grants,
            owners: HashSet::new(),
            ready: HashSet::new(),
            failed: false,
            sidecar,
        })
    }

    /// Preserve permission scopes while exposing only grants available in this generation.
    pub(crate) fn authorized_manifest(&self) -> Result<Value, String> {
        if self.failed {
            return Err("PLUGIN_NOT_RUNNING".into());
        }
        let mut manifest = self.manifest.clone();
        manifest["permissions"] = json!(self.manifest["permissions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| self.grants.iter().any(|grant| p["id"] == *grant))
            .collect::<Vec<_>>());
        Ok(manifest)
    }

    /// Running means at least one window has acknowledged successful activate().
    pub(crate) fn state(&self) -> &str {
        if self.failed {
            "crashed"
        } else if self.ready.is_empty() {
            "starting"
        } else {
            "running"
        }
    }

    pub(crate) fn invoke_sidecar(
        &mut self,
        runtime: &str,
        request_id: &str,
        method: &str,
        params: &Value,
        deadline: u64,
    ) -> Result<Option<Value>, String> {
        let Some(sidecar) = &self.sidecar else {
            return Ok(None);
        };
        if self.failed || self.id != runtime {
            return Err("PLUGIN_RUNTIME_TERMINATED".into());
        }
        sidecar
            .invoke(request_id, method, params, deadline)
            .map(Some)
    }
}

fn sidecar_spec(
    install_root: &Path,
    manifest: &Value,
    runtime_id: &str,
) -> Result<Option<SidecarSpec>, String> {
    let Some(sidecar) = manifest.get("sidecar") else {
        return Ok(None);
    };
    let executable = sidecar
        .get("executable")
        .and_then(Value::as_str)
        .ok_or("PLUGIN_SIDECAR_SPEC_INVALID")?;
    let executable =
        super::plugin_package::safe_path(executable).map_err(|_| "PLUGIN_SIDECAR_SPEC_INVALID")?;
    let args = sidecar
        .get("args")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    item.as_str()
                        .map(str::to_owned)
                        .ok_or("PLUGIN_SIDECAR_SPEC_INVALID")
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(Some(SidecarSpec {
        plugin_id: manifest["id"]
            .as_str()
            .ok_or("PLUGIN_SIDECAR_SPEC_INVALID")?
            .to_owned(),
        runtime_id: runtime_id.to_owned(),
        install_root: install_root.to_owned(),
        executable: install_root.join(executable),
        args,
    }))
}

#[derive(Default)]
pub(crate) struct PluginHost {
    sessions: HashMap<String, Session>,
}

impl PluginHost {
    /// Replace the entire generation on enable/regrant, revoking old URLs and RPC identities.
    pub(crate) fn replace(&mut self, plugin: &str, session: Option<Session>) {
        self.sessions.remove(plugin);
        if let Some(session) = session {
            self.sessions.insert(plugin.into(), session);
        }
    }
    pub(crate) fn state(&self, plugin: &str) -> Option<&str> {
        self.sessions.get(plugin).map(Session::state)
    }
    pub(crate) fn authorized_manifest(&self, plugin: &str) -> Result<(PathBuf, Value), String> {
        let session = self.sessions.get(plugin).ok_or("PLUGIN_NOT_RUNNING")?;
        Ok((session.path.clone(), session.authorized_manifest()?))
    }
    /// Bind the RPC to both the currently enabled generation and the calling window.
    pub(crate) fn authorize(
        &self,
        plugin: &str,
        runtime: &str,
        window: &str,
    ) -> Result<(), String> {
        let session = self.sessions.get(plugin).ok_or("PLUGIN_NOT_RUNNING")?;
        if session.failed {
            return Err("PLUGIN_NOT_RUNNING".into());
        }
        if session.id != runtime || !session.owners.contains(window) {
            return Err("PLUGIN_RUNTIME_TERMINATED".into());
        }
        Ok(())
    }
    pub(crate) fn invoke_sidecar(
        &mut self,
        plugin: &str,
        runtime: &str,
        request_id: &str,
        method: &str,
        params: &Value,
        deadline: u64,
    ) -> Result<Option<Value>, String> {
        let session = self.sessions.get_mut(plugin).ok_or("PLUGIN_NOT_RUNNING")?;
        match session.invoke_sidecar(runtime, request_id, method, params, deadline) {
            Ok(result) => Ok(result),
            Err(error) => {
                session.failed = true;
                session.ready.clear();
                if let Some(sidecar) = &session.sidecar {
                    sidecar.stop();
                }
                Err(error)
            }
        }
    }
    /// Produce the same URLs for core and user packages, without leaking absolute paths.
    pub(crate) fn contributions(&mut self, window: &str) -> Vec<Value> {
        self.sessions
            .values_mut()
            .filter(|s| !s.failed)
            .filter_map(|session| {
                let mut summary =
                    super::plugin_contribution_summary_from_manifest(&session.manifest)?;
                session.owners.insert(window.into());
                summary["runtimeId"] = json!(session.id);
                summary["entryUrl"] = json!(resource_url(&session.id, "main.js"));
                summary["stylesUrl"] = json!(resource_url(&session.id, "styles.css"));
                if let Some(icon) = session.manifest["icon"].as_str() {
                    for view in summary["views"].as_array_mut().into_iter().flatten() {
                        view["iconUrl"] = json!(resource_url(&session.id, icon));
                    }
                }
                Some(summary)
            })
            .collect()
    }
    /// Report one activation result; failure revokes resources for every owner until restart.
    pub(crate) fn report(
        &mut self,
        plugin: &str,
        runtime: &str,
        window: &str,
        failed: bool,
    ) -> Result<(), String> {
        self.authorize(plugin, runtime, window)?;
        let session = self.sessions.get_mut(plugin).unwrap();
        if failed {
            session.failed = true;
            session.ready.clear();
            if let Some(sidecar) = &session.sidecar {
                sidecar.stop();
            }
        } else {
            session.ready.insert(window.into());
        }
        Ok(())
    }
    /// A destroyed renderer can no longer use its RPC identity or load package resources.
    pub(crate) fn dispose_window(&mut self, window: &str) -> Vec<String> {
        let mut affected = Vec::new();
        for (plugin, session) in &mut self.sessions {
            if session.owners.remove(window) {
                affected.push(plugin.clone());
            }
            session.ready.remove(window);
        }
        affected
    }
    /// Read a bounded, regular resource only for a live generation owned by this WebView.
    pub(crate) fn resource(
        &self,
        window: &str,
        uri: &str,
    ) -> Result<(Vec<u8>, &'static str), String> {
        let (runtime, relative) = parse_resource(uri)?;
        let session = self
            .sessions
            .values()
            .find(|s| s.id == runtime && !s.failed && s.owners.contains(window))
            .ok_or("PLUGIN_RUNTIME_TERMINATED")?;
        let target = checked_resource(&session.path, &relative)?;
        let mut file = fs::File::open(&target).map_err(|_| "PLUGIN_RESOURCE_NOT_FOUND")?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(MAX_RESOURCE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "PLUGIN_RESOURCE_NOT_FOUND")?;
        if bytes.len() as u64 > MAX_RESOURCE_BYTES {
            return Err("PLUGIN_RESOURCE_TOO_LARGE".into());
        }
        Ok((bytes, resource_mime(&target)))
    }
}

/// Tauri maps custom protocols to http://<scheme>.localhost on Windows.
fn resource_url(runtime: &str, path: &str) -> String {
    let encoded = path
        .replace('\\', "/")
        .split('/')
        .map(|s| urlencoding::encode(s).into_owned())
        .collect::<Vec<_>>()
        .join("/");
    if cfg!(windows) {
        format!("http://wstudio-plugin.localhost/runtime/{runtime}/plugin/{encoded}")
    } else {
        format!("wstudio-plugin://localhost/runtime/{runtime}/plugin/{encoded}")
    }
}

/// Accept only the two platform mappings, exact path segments and a UUID generation.
fn parse_resource(uri: &str) -> Result<(String, PathBuf), String> {
    let url = reqwest::Url::parse(uri).map_err(|_| "PLUGIN_RESOURCE_PATH_INVALID")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("PLUGIN_RESOURCE_PATH_INVALID".into());
    }
    let path = match (url.scheme(), url.host_str()) {
        // Tauri's callback receives the custom scheme with localhost as its host.
        ("wstudio-plugin", Some("localhost")) => url.path().to_string(),
        // Keep accepting the early internal form for already-issued runtime URLs.
        ("wstudio-plugin", Some("runtime")) => format!("/runtime{}", url.path()),
        ("http", Some("wstudio-plugin.localhost")) => url
            .path()
            .strip_prefix("/runtime")
            .map(|path| format!("/runtime{path}"))
            .ok_or("PLUGIN_RESOURCE_PATH_INVALID")?,
        _ => return Err("PLUGIN_RESOURCE_PATH_INVALID".into()),
    };
    let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
    if parts.len() < 4
        || parts[0] != "runtime"
        || parts[2] != "plugin"
        || uuid::Uuid::parse_str(parts[1]).is_err()
    {
        return Err("PLUGIN_RESOURCE_PATH_INVALID".into());
    }
    let mut relative = PathBuf::new();
    for part in &parts[3..] {
        let decoded = urlencoding::decode(part).map_err(|_| "PLUGIN_RESOURCE_PATH_INVALID")?;
        if decoded.is_empty() || decoded.contains(['/', '\\']) {
            return Err("PLUGIN_RESOURCE_PATH_INVALID".into());
        }
        relative.push(
            super::plugin_package::safe_path(&decoded)
                .map_err(|_| "PLUGIN_RESOURCE_PATH_INVALID")?,
        );
    }
    Ok((parts[1].into(), relative))
}

/// Reject each linked ancestor as well as canonical escapes from the package root.
fn checked_resource(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let root_metadata = fs::symlink_metadata(root).map_err(|_| "PLUGIN_RESOURCE_NOT_FOUND")?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("PLUGIN_RESOURCE_PATH_INVALID".into());
    }
    let canonical = root
        .canonicalize()
        .map_err(|_| "PLUGIN_RESOURCE_NOT_FOUND")?;
    let mut target = root.to_path_buf();
    for part in relative.components() {
        target.push(part);
        let metadata = fs::symlink_metadata(&target).map_err(|_| "PLUGIN_RESOURCE_NOT_FOUND")?;
        if metadata.file_type().is_symlink() {
            return Err("PLUGIN_RESOURCE_PATH_INVALID".into());
        }
    }
    let target = target
        .canonicalize()
        .map_err(|_| "PLUGIN_RESOURCE_NOT_FOUND")?;
    if !target.starts_with(canonical) || !target.is_file() {
        return Err("PLUGIN_RESOURCE_PATH_INVALID".into());
    }
    Ok(target)
}

fn resource_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_package::tests::{manifest, Fixture};
    use serde_json::json;

    fn session(fixture: &Fixture) -> (Session, PathBuf) {
        let package = fixture.package("1.0.0");
        fs::write(package.join("icon.svg"), "<svg/>").unwrap();
        let mut manifest = manifest("1.0.0");
        manifest["permissions"] = json!([
            { "id": "workspace.read", "reason": "Read notes" }
        ]);
        let session =
            Session::new(package.clone(), manifest, vec!["workspace.read".into()]).unwrap();
        (session, package)
    }

    #[test]
    fn replacement_revokes_old_generation_and_preserves_window_isolation() {
        let fixture = Fixture::new();
        let (first, package) = session(&fixture);
        let old_runtime = first.id.clone();
        let mut host = PluginHost::default();
        host.replace("com.example.reader", Some(first));

        let first_summary = host.contributions("window-a");
        assert_eq!(first_summary.len(), 1);
        assert_eq!(host.state("com.example.reader"), Some("starting"));
        let old_url = first_summary[0]["entryUrl"].as_str().unwrap().to_string();
        assert!(host
            .authorize("com.example.reader", &old_runtime, "window-a")
            .is_ok());
        assert_eq!(
            host.resource("window-a", &old_url).unwrap().0,
            fs::read(package.join("main.js")).unwrap()
        );
        assert_eq!(
            host.resource("window-b", &old_url).unwrap_err(),
            "PLUGIN_RUNTIME_TERMINATED"
        );

        host.report("com.example.reader", &old_runtime, "window-a", false)
            .unwrap();
        assert_eq!(host.state("com.example.reader"), Some("running"));

        let (second, _) = session(&fixture);
        let new_runtime = second.id.clone();
        host.replace("com.example.reader", Some(second));
        assert_ne!(old_runtime, new_runtime);
        assert_eq!(
            host.authorize("com.example.reader", &old_runtime, "window-a")
                .unwrap_err(),
            "PLUGIN_RUNTIME_TERMINATED"
        );
        assert_eq!(
            host.resource("window-a", &old_url).unwrap_err(),
            "PLUGIN_RUNTIME_TERMINATED"
        );
    }

    #[test]
    fn readiness_failure_revokes_authorization_and_resource_access() {
        let fixture = Fixture::new();
        let (session, _) = session(&fixture);
        let runtime = session.id.clone();
        let mut host = PluginHost::default();
        host.replace("com.example.reader", Some(session));
        let summary = host.contributions("window-a");
        let url = summary[0]["stylesUrl"].as_str().unwrap();
        assert_eq!(host.state("com.example.reader"), Some("starting"));

        host.report("com.example.reader", &runtime, "window-a", true)
            .unwrap();
        assert_eq!(host.state("com.example.reader"), Some("crashed"));
        assert_eq!(
            host.authorize("com.example.reader", &runtime, "window-a")
                .unwrap_err(),
            "PLUGIN_NOT_RUNNING"
        );
        assert_eq!(
            host.resource("window-a", url).unwrap_err(),
            "PLUGIN_RUNTIME_TERMINATED"
        );
    }

    #[test]
    fn renderer_exit_revokes_only_its_window_and_reports_affected_plugins_once() {
        let fixture = Fixture::new();
        let (session, _) = session(&fixture);
        let runtime = session.id.clone();
        let mut host = PluginHost::default();
        host.replace("com.example.reader", Some(session));
        let summary = host.contributions("window-a");
        let url = summary[0]["entryUrl"].as_str().unwrap();
        host.contributions("window-b");
        for window in ["window-a", "window-b"] {
            host.report("com.example.reader", &runtime, window, false)
                .unwrap();
        }
        assert_eq!(host.dispose_window("window-a"), vec!["com.example.reader"]);
        assert!(host.dispose_window("window-a").is_empty());
        assert!(host
            .authorize("com.example.reader", &runtime, "window-a")
            .is_err());
        assert!(host.resource("window-a", url).is_err());
        assert!(host
            .authorize("com.example.reader", &runtime, "window-b")
            .is_ok());
        assert!(host.resource("window-b", url).is_ok());
        assert_eq!(host.state("com.example.reader"), Some("running"));
        host.contributions("window-a");
        host.report("com.example.reader", &runtime, "window-a", false)
            .unwrap();
        assert_eq!(host.state("com.example.reader"), Some("running"));
        assert!(host
            .authorize("com.example.reader", &runtime, "window-a")
            .is_ok());
    }

    #[test]
    fn resource_urls_reject_cross_origin_and_traversal_paths() {
        assert!(parse_resource("wstudio-plugin://runtime/not-a-uuid/plugin/main.js").is_err());
        assert_eq!(
            parse_resource(
                "wstudio-plugin://localhost/runtime/00000000-0000-0000-0000-000000000000/plugin/main.js"
            )
            .unwrap(),
            (
                "00000000-0000-0000-0000-000000000000".to_string(),
                PathBuf::from("main.js")
            )
        );
        assert!(parse_resource(
            "wstudio-plugin://runtime/00000000-0000-0000-0000-000000000000/plugin/%2e%2e/secret"
        )
        .is_err());
        assert!(parse_resource("http://wstudio-plugin.localhost/runtime/00000000-0000-0000-0000-000000000000/plugin/main.js?cache=1").is_err());
        assert!(parse_resource(
            "http://other.localhost/runtime/00000000-0000-0000-0000-000000000000/plugin/main.js"
        )
        .is_err());
    }
}
