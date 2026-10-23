//! Isolated plugin sidecar process transport.
//!
//! The shared Renderer Host remains the compatibility path. This module provides
//! the process boundary used by the later sidecar activation path: a package-local
//! executable, a clean environment, and a bounded JSONL request/response channel.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_MESSAGE_BYTES: usize = 512 * 1024;
const MAX_METHOD_BYTES: usize = 256;
const MAX_REQUEST_TIMEOUT_MS: u64 = 15_000;

#[derive(Debug, Clone)]
pub(crate) struct SidecarSpec {
    pub(crate) plugin_id: String,
    pub(crate) runtime_id: String,
    pub(crate) install_root: PathBuf,
    pub(crate) executable: PathBuf,
    pub(crate) args: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarRequest<'a> {
    protocol_version: u8,
    request_id: &'a str,
    method: &'a str,
    params: &'a Value,
    deadline: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarResponse {
    protocol_version: u8,
    request_id: String,
    ok: bool,
    #[serde(default, deserialize_with = "deserialize_present_result")]
    result: Option<Value>,
    error: Option<SidecarError>,
}

/// Preserve an explicit JSON null while distinguishing an omitted result field.
fn deserialize_present_result<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Value::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize)]
struct SidecarError {
    code: String,
    message: String,
}

type ReaderMessage = Result<SidecarResponse, String>;

/// A running package-local sidecar and its authenticated RPC stream.
pub(crate) struct SidecarHost {
    runtime_id: String,
    child: Mutex<Option<Child>>,
    rpc: Mutex<()>,
    stdin: Mutex<ChildStdin>,
    responses: Mutex<Receiver<ReaderMessage>>,
}

impl SidecarHost {
    pub(crate) fn start(spec: SidecarSpec) -> Result<Self, String> {
        validate_spec(&spec)?;
        let runtime_id = spec.runtime_id.clone();
        let mut command = Command::new(&spec.executable);
        command
            .args(&spec.args)
            .current_dir(&spec.install_root)
            .env_clear()
            .env("WSTUDIO_PLUGIN_ID", &spec.plugin_id)
            .env("WSTUDIO_RUNTIME_ID", &runtime_id)
            .env("WSTUDIO_RPC_PROTOCOL", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // Background RPC processes must not create or inherit a console on Windows.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "PLUGIN_SIDECAR_START_FAILED".to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "PLUGIN_SIDECAR_START_FAILED".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "PLUGIN_SIDECAR_START_FAILED".to_string())?;
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || read_responses(stdout, sender));
        Ok(Self {
            runtime_id,
            child: Mutex::new(Some(child)),
            rpc: Mutex::new(()),
            stdin: Mutex::new(stdin),
            responses: Mutex::new(receiver),
        })
    }

    pub(crate) fn runtime_id(&self) -> &str {
        &self.runtime_id
    }

    pub(crate) fn invoke(
        &self,
        request_id: &str,
        method: &str,
        params: &Value,
        deadline: u64,
    ) -> Result<Value, String> {
        let result = self.invoke_locked(request_id, method, params, deadline);
        if result.is_err() {
            self.stop();
        }
        result
    }

    fn invoke_locked(
        &self,
        request_id: &str,
        method: &str,
        params: &Value,
        deadline: u64,
    ) -> Result<Value, String> {
        let _rpc = self.rpc.lock().map_err(|_| "PLUGIN_SIDECAR_FAILED")?;
        validate_request(request_id, method, deadline)?;
        let request = SidecarRequest {
            protocol_version: 1,
            request_id,
            method,
            params,
            deadline,
        };
        let bytes = serde_json::to_vec(&request).map_err(|_| "PLUGIN_SIDECAR_PROTOCOL_ERROR")?;
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err("PLUGIN_INVALID_ARGUMENT".into());
        }
        {
            let mut stdin = self.stdin.lock().map_err(|_| "PLUGIN_SIDECAR_FAILED")?;
            stdin
                .write_all(&bytes)
                .and_then(|_| stdin.write_all(b"\n"))
                .and_then(|_| stdin.flush())
                .map_err(|_| "PLUGIN_SIDECAR_TERMINATED")?;
        }
        let wait_ms = deadline
            .saturating_sub(now_ms())
            .min(MAX_REQUEST_TIMEOUT_MS);
        let response = match self
            .responses
            .lock()
            .map_err(|_| "PLUGIN_SIDECAR_FAILED")?
            .recv_timeout(Duration::from_millis(wait_ms.max(1)))
        {
            Ok(response) => response?,
            Err(RecvTimeoutError::Timeout) => {
                return Err("PLUGIN_REQUEST_TIMEOUT".into());
            }
            Err(RecvTimeoutError::Disconnected) => return Err("PLUGIN_SIDECAR_TERMINATED".into()),
        };
        if response.protocol_version != 1 || response.request_id != request_id {
            return Err("PLUGIN_SIDECAR_PROTOCOL_ERROR".into());
        }
        if response.ok {
            response
                .result
                .ok_or_else(|| "PLUGIN_SIDECAR_PROTOCOL_ERROR".into())
        } else {
            Err(response
                .error
                .map(|error| error.code)
                .filter(|code| code.starts_with("PLUGIN_"))
                .unwrap_or_else(|| "PLUGIN_SIDECAR_FAILED".into()))
        }
    }

    pub(crate) fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut child) = child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for SidecarHost {
    fn drop(&mut self) {
        self.stop();
    }
}

fn read_responses(stdout: impl std::io::Read, sender: Sender<ReaderMessage>) {
    let mut reader = BufReader::new(stdout);
    loop {
        let mut line = Vec::new();
        match (&mut reader)
            .take((MAX_MESSAGE_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)
        {
            Ok(0) => {
                let _ = sender.send(Err("PLUGIN_SIDECAR_TERMINATED".into()));
                return;
            }
            Ok(size) if size > MAX_MESSAGE_BYTES || !line.ends_with(b"\n") => {
                let _ = sender.send(Err("PLUGIN_SIDECAR_PROTOCOL_ERROR".into()));
                return;
            }
            Ok(_) => {
                let response = serde_json::from_slice::<SidecarResponse>(&line)
                    .map_err(|_| "PLUGIN_SIDECAR_PROTOCOL_ERROR".to_string());
                if sender.send(response).is_err() {
                    return;
                }
            }
            Err(_) => {
                let _ = sender.send(Err("PLUGIN_SIDECAR_TERMINATED".into()));
                return;
            }
        }
    }
}

fn validate_spec(spec: &SidecarSpec) -> Result<(), String> {
    if spec.plugin_id.trim().is_empty() || !spec.install_root.is_absolute() {
        return Err("PLUGIN_SIDECAR_SPEC_INVALID".into());
    }
    let root = spec
        .install_root
        .canonicalize()
        .map_err(|_| "PLUGIN_SIDECAR_SPEC_INVALID")?;
    let executable = spec
        .executable
        .canonicalize()
        .map_err(|_| "PLUGIN_SIDECAR_SPEC_INVALID")?;
    if !executable.starts_with(&root)
        || !fs::metadata(&executable)
            .map_err(|_| "PLUGIN_SIDECAR_SPEC_INVALID")?
            .is_file()
    {
        return Err("PLUGIN_SIDECAR_SPEC_INVALID".into());
    }
    Ok(())
}

fn validate_request(request_id: &str, method: &str, deadline: u64) -> Result<(), String> {
    if request_id.trim().is_empty()
        || request_id.len() > 256
        || method.trim().is_empty()
        || method.len() > MAX_METHOD_BYTES
    {
        return Err("PLUGIN_INVALID_ARGUMENT".into());
    }
    if deadline <= now_ms() {
        return Err("PLUGIN_REQUEST_TIMEOUT".into());
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_validation_rejects_expired_and_oversized_metadata() {
        assert_eq!(
            validate_request("id", "method", 0).unwrap_err(),
            "PLUGIN_REQUEST_TIMEOUT"
        );
        assert_eq!(
            validate_request("id", &"x".repeat(MAX_METHOD_BYTES + 1), u64::MAX).unwrap_err(),
            "PLUGIN_INVALID_ARGUMENT"
        );
    }

    #[test]
    fn response_decoder_rejects_invalid_json_and_accepts_protocol_shape() {
        let (sender, receiver) = mpsc::channel();
        let input = b"{\"protocolVersion\":1,\"requestId\":\"id\",\"ok\":true,\"result\":null}\n";
        read_responses(&input[..], sender);
        let response = receiver.recv().unwrap().unwrap();
        assert_eq!(response.protocol_version, 1);
        assert_eq!(response.request_id, "id");
        assert!(response.ok);
        assert_eq!(response.result, Some(Value::Null));
    }

    #[cfg(windows)]
    #[test]
    fn sidecar_void_reply_succeeds_but_missing_result_is_a_protocol_error() {
        let root = std::env::temp_dir().join(format!("wstudio-sidecar-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let executable = root.join("host.exe");
        fs::copy(std::env::var_os("COMSPEC").unwrap(), &executable).unwrap();
        let mut outcomes = Vec::new();
        for (reply, expected) in [
            (
                b"{\"protocolVersion\":1,\"requestId\":\"request-1\",\"ok\":true,\"result\":null}\r\n".as_slice(),
                Ok(Value::Null),
            ),
            (
                b"{\"protocolVersion\":1,\"requestId\":\"request-1\",\"ok\":true}\r\n".as_slice(),
                Err("PLUGIN_SIDECAR_PROTOCOL_ERROR".to_string()),
            ),
        ] {
            fs::write(root.join("response.jsonl"), reply).unwrap();
            let host = SidecarHost::start(SidecarSpec {
                plugin_id: "com.example.plugin".into(),
                runtime_id: "runtime-1".into(),
                install_root: root.clone(),
                executable: executable.clone(),
                args: vec!["/C".into(), "type response.jsonl".into()],
            })
            .unwrap();
            let actual = host.invoke("request-1", "log", &Value::Null, now_ms() + 5_000);
            host.stop();
            outcomes.push((actual, expected));
        }
        fs::remove_dir_all(root).unwrap();
        for (actual, expected) in outcomes {
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn sidecar_spec_requires_package_local_executable() {
        let spec = SidecarSpec {
            plugin_id: "com.example.plugin".into(),
            runtime_id: "runtime-1".into(),
            install_root: PathBuf::from("relative"),
            executable: PathBuf::from("relative/host.exe"),
            args: Vec::new(),
        };
        assert_eq!(
            validate_spec(&spec).unwrap_err(),
            "PLUGIN_SIDECAR_SPEC_INVALID"
        );
    }

    #[cfg(windows)]
    #[test]
    fn sidecar_host_round_trips_a_real_jsonl_child_process() {
        let root = std::env::temp_dir().join(format!("wstudio-sidecar-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let executable = root.join("host.exe");
        fs::copy(std::env::var_os("COMSPEC").unwrap(), &executable).unwrap();
        fs::write(
            root.join("response.jsonl"),
            b"{\"protocolVersion\":1,\"requestId\":\"request-1\",\"ok\":true,\"result\":{\"value\":42}}\r\n",
        )
        .unwrap();
        let spec = SidecarSpec {
            plugin_id: "com.example.plugin".into(),
            runtime_id: "runtime-1".into(),
            install_root: root.clone(),
            executable,
            args: vec!["/C".into(), "type response.jsonl".into()],
        };
        let host = SidecarHost::start(spec).unwrap();
        let result = host
            .invoke(
                "request-1",
                "example.echo",
                &serde_json::json!({"input":"ok"}),
                now_ms() + 5_000,
            )
            .unwrap();
        assert_eq!(result["value"], 42);
        host.stop();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn sidecar_host_maps_a_child_that_exits_before_reply() {
        let root = std::env::temp_dir().join(format!("wstudio-sidecar-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let executable = root.join("host.exe");
        fs::copy(std::env::var_os("COMSPEC").unwrap(), &executable).unwrap();
        let host = SidecarHost::start(SidecarSpec {
            plugin_id: "com.example.plugin".into(),
            runtime_id: "runtime-1".into(),
            install_root: root.clone(),
            executable,
            args: vec!["/C".into(), "exit 7".into()],
        })
        .unwrap();
        assert_eq!(
            host.invoke("request-1", "example.echo", &Value::Null, now_ms() + 5_000)
                .unwrap_err(),
            "PLUGIN_SIDECAR_TERMINATED"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
