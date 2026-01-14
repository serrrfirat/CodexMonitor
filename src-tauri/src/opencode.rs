use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::io::ErrorKind;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStderr, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::time::timeout;

use crate::state::AppState;
use crate::types::{OpenCodeProviderInfo, OpenCodeProviderModel, OpenCodeSessionInfo, WorkspaceEntry};

#[derive(Serialize, Clone)]
struct OpenCodeEvent {
    #[serde(rename = "workspaceId")]
    workspace_id: String,
    method: String,
    params: Option<Value>,
}

#[derive(Serialize, Clone)]
struct WorkspaceEvent {
    workspace_id: String,
    event_type: String,
    server_url: Option<String>,
    error: Option<String>,
}

pub(crate) struct OpenCodeSession {
    pub(crate) entry: WorkspaceEntry,
    pub(crate) child: Mutex<Child>,
    pub(crate) stdin: Mutex<ChildStdin>,
    pub(crate) stdout_reader: Mutex<BufReader<ChildStdout>>,
    pub(crate) next_id: AtomicU64,
    pub(crate) pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
}

fn build_opencode_command(opencode_bin: Option<String>) -> Command {
    let default_bin = opencode_bin
        .as_ref()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true);
    let bin = opencode_bin
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "opencode".into());
    let mut command = Command::new(bin);
    if default_bin {
        let mut paths: Vec<String> = env::var("PATH")
            .unwrap_or_default()
            .split(':')
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .collect();
        let mut extras = vec![
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        .into_iter()
        .map(|value| value.to_string())
        .collect::<Vec<String>>();
        if let Ok(home) = env::var("HOME") {
            extras.push(format!("{home}/.local/bin"));
            extras.push(format!("{home}/.cargo/bin"));
            extras.push(format!("{home}/.bun/bin"));
        }
        for extra in extras {
            if !paths.contains(&extra) {
                paths.push(extra);
            }
        }
        if !paths.is_empty() {
            command.env("PATH", paths.join(":"));
        }
    }
    command
}

async fn check_opencode_installation(opencode_bin: Option<String>) -> Result<Option<String>, String> {
    let mut command = build_opencode_command(opencode_bin);
    command.arg("--version");
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let output = match timeout(Duration::from_secs(5), command.output()).await {
        Ok(result) => result.map_err(|e| {
            if e.kind() == ErrorKind::NotFound {
                "OpenCode CLI not found. Install OpenCode and ensure `opencode` is on your PATH."
                    .to_string()
            } else {
                e.to_string()
            }
        })?,
        Err(_) => {
            return Err(
                "Timed out while checking OpenCode CLI. Make sure `opencode --version` runs in Terminal."
                    .to_string(),
            );
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        if detail.is_empty() {
            return Err(
                "OpenCode CLI failed to start. Try running `opencode --version` in Terminal."
                    .to_string(),
            );
        }
        return Err(format!(
            "OpenCode CLI failed to start: {detail}. Try running `opencode --version` in Terminal."
        ));
    }

    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(if version.is_empty() { None } else { Some(version) })
}

async fn send_jsonrpc_request_with_timeout(
    session: &Arc<OpenCodeSession>,
    method: &str,
    params: Value,
    request_timeout: Duration,
) -> Result<Value, String> {
    let id = session.next_id.fetch_add(1, Ordering::SeqCst);
    let request = json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": id
    });

    let (tx, rx) = oneshot::channel();
    {
        let mut pending = session.pending.lock().await;
        pending.insert(id, tx);
    }

    {
        let mut stdin = session.stdin.lock().await;
        let request_str = format!("{}\n", request.to_string());
        stdin
            .write_all(request_str.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;
    }

    match timeout(request_timeout, rx).await {
        Ok(Ok(response)) => {
            if let Some(error) = response.get("error") {
                let message = error
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error");
                return Err(message.to_string());
            }
            Ok(response.get("result").cloned().unwrap_or(Value::Null))
        }
        Ok(Err(_)) => Err("Response channel closed".to_string()),
        Err(_) => {
            session.pending.lock().await.remove(&id);
            Err("Request timed out".to_string())
        }
    }
}

async fn send_jsonrpc_request(
    session: &Arc<OpenCodeSession>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    send_jsonrpc_request_with_timeout(session, method, params, Duration::from_secs(30)).await
}

fn spawn_stdout_reader(session: Arc<OpenCodeSession>, app: AppHandle, workspace_id: String) {
    tokio::spawn(async move {
        let mut reader = session.stdout_reader.lock().await;
        let mut line = String::new();

        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => {
                    break;
                }
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }

                    if let Ok(msg) = serde_json::from_str::<Value>(trimmed) {
                        if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
                            if let Some(tx) = session.pending.lock().await.remove(&id) {
                                let _ = tx.send(msg);
                            }
                        } else if let Some(method) = msg.get("method").and_then(|v| v.as_str()) {
                            let event_payload = OpenCodeEvent {
                                workspace_id: workspace_id.clone(),
                                method: method.to_string(),
                                params: msg.get("params").cloned(),
                            };
                            let _ = app.emit("opencode-event", event_payload);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Error reading stdout: {}", e);
                    break;
                }
            }
        }

        let payload = WorkspaceEvent {
            workspace_id: workspace_id.clone(),
            event_type: "disconnected".to_string(),
            server_url: None,
            error: Some("OpenCode process ended".to_string()),
        };
        let _ = app.emit("workspace-event", payload);
    });
}

fn spawn_stderr_reader(stderr: ChildStderr, app: AppHandle, workspace_id: String) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();

        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => {
                    break;
                }
                Ok(_) => {
                    let trimmed = line.trim_end();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let _ = app.emit(
                        "opencode-stderr",
                        json!({
                            "workspaceId": workspace_id,
                            "line": trimmed
                        }),
                    );
                }
                Err(_) => {
                    break;
                }
            }
        }
    });
}

async fn initialize_acp_session(session: &Arc<OpenCodeSession>) -> Result<(), String> {
    let _ = send_jsonrpc_request_with_timeout(
        session,
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientInfo": {
                "name": "codex_monitor",
                "version": env!("CARGO_PKG_VERSION")
            },
            "clientCapabilities": {}
        }),
        Duration::from_secs(120),
    )
    .await?;

    Ok(())
}

pub(crate) async fn spawn_opencode_session(
    entry: WorkspaceEntry,
    default_opencode_bin: Option<String>,
    app_handle: AppHandle,
) -> Result<Arc<OpenCodeSession>, String> {
    let opencode_bin = entry
        .opencode_bin
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or(default_opencode_bin);
    let _ = check_opencode_installation(opencode_bin.clone()).await?;

    let mut command = build_opencode_command(opencode_bin);
    command.arg("acp");
    command.current_dir(&entry.path);
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let mut child = command.spawn().map_err(|e| format!("Failed to spawn opencode: {}", e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or("Failed to capture stdin")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture stdout")?;

    if let Some(stderr) = child.stderr.take() {
        spawn_stderr_reader(stderr, app_handle.clone(), entry.id.clone());
    }

    let session = Arc::new(OpenCodeSession {
        entry: entry.clone(),
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        stdout_reader: Mutex::new(BufReader::new(stdout)),
        next_id: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
    });

    spawn_stdout_reader(session.clone(), app_handle.clone(), entry.id.clone());

    if let Err(error) = initialize_acp_session(&session).await {
        let mut child = session.child.lock().await;
        let _ = child.kill().await;
        return Err(format!("Failed to initialize OpenCode ACP: {error}"));
    }

    let payload = WorkspaceEvent {
        workspace_id: entry.id.clone(),
        event_type: "connected".to_string(),
        server_url: Some("acp://local".to_string()),
        error: None,
    };
    let _ = app_handle.emit("workspace-event", payload);

    Ok(session)
}

async fn get_or_spawn_acp_session(
    workspace_id: &str,
    state: &AppState,
    app: &AppHandle,
) -> Result<Arc<OpenCodeSession>, String> {
    {
        let sessions = state.opencode_sessions.lock().await;
        if let Some(existing) = sessions.get(workspace_id) {
            return Ok(existing.clone());
        }
    }

    let entry = {
        let workspaces = state.workspaces.lock().await;
        workspaces
            .get(workspace_id)
            .ok_or("Workspace not found")?
            .clone()
    };

    let default_bin = {
        let settings = state.app_settings.lock().await;
        settings.opencode_bin.clone()
    };

    let session = spawn_opencode_session(entry, default_bin, app.clone()).await?;

    let mut sessions = state.opencode_sessions.lock().await;
    if let Some(existing) = sessions.get(workspace_id) {
        return Ok(existing.clone());
    }
    sessions.insert(workspace_id.to_string(), session.clone());
    Ok(session)
}

#[tauri::command]
pub(crate) async fn opencode_doctor(
    opencode_bin: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let default_bin = {
        let settings = state.app_settings.lock().await;
        settings.opencode_bin.clone()
    };
    let resolved = opencode_bin
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or(default_bin);
    let version = check_opencode_installation(resolved.clone()).await?;
    let mut command = build_opencode_command(resolved.clone());
    command.arg("acp");
    command.arg("--help");
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    let acp_ok = match timeout(Duration::from_secs(5), command.output()).await {
        Ok(result) => result.map(|output| output.status.success()).unwrap_or(false),
        Err(_) => false,
    };
    let details = if acp_ok {
        None
    } else {
        Some("Failed to run `opencode acp --help`.".to_string())
    };
    Ok(json!({
        "ok": version.is_some() && acp_ok,
        "opencodeBin": resolved,
        "version": version,
        "acpOk": acp_ok,
        "details": details,
    }))
}

#[tauri::command]
pub(crate) async fn list_opencode_sessions(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<OpenCodeSessionInfo>, String> {
    let workspaces = state.workspaces.lock().await;
    let entry = workspaces
        .get(&workspace_id)
        .ok_or("Workspace not found")?
        .clone();
    drop(workspaces);

    let default_bin = {
        let settings = state.app_settings.lock().await;
        settings.opencode_bin.clone()
    };
    let opencode_bin = entry
        .opencode_bin
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or(default_bin);

    let mut command = build_opencode_command(opencode_bin);
    command.arg("session");
    command.arg("list");
    command.arg("--format");
    command.arg("json");
    command.current_dir(&entry.path);
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let output = command.output().await
        .map_err(|e| format!("Failed to run opencode session list: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);

    if stdout.trim().is_empty() {
        return Ok(Vec::new());
    }

    let sessions: Vec<OpenCodeSessionInfo> = serde_json::from_str(&stdout)
        .unwrap_or_else(|_| Vec::new());

    Ok(sessions)
}

#[tauri::command]
pub(crate) async fn create_opencode_session(
    workspace_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<OpenCodeSessionInfo, String> {
    let session = get_or_spawn_acp_session(&workspace_id, state.inner(), &app).await?;
    let cwd = session.entry.path.clone();

    let result = send_jsonrpc_request(&session, "session/new", json!({
        "cwd": cwd,
        "mcpServers": []
    })).await?;

    #[derive(serde::Deserialize)]
    struct NewSessionResult {
        #[serde(rename = "sessionId")]
        session_id: String,
    }

    let new_session: NewSessionResult = serde_json::from_value(result)
        .map_err(|e| format!("Failed to parse session/new result: {e}"))?;

    Ok(OpenCodeSessionInfo {
        id: new_session.session_id,
        title: Some("New Session".to_string()),
        created_at: None,
        updated_at: None,
    })
}

#[tauri::command]
pub(crate) async fn get_opencode_session(
    workspace_id: String,
    session_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<OpenCodeSessionInfo, String> {
    let session = get_or_spawn_acp_session(&workspace_id, state.inner(), &app).await?;

    let result = send_jsonrpc_request(&session, "session/get", json!({
        "sessionId": session_id
    })).await?;

    serde_json::from_value::<OpenCodeSessionInfo>(result)
        .map_err(|e| format!("Failed to parse session: {}", e))
}

#[tauri::command]
pub(crate) async fn load_opencode_session(
    workspace_id: String,
    session_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<OpenCodeSessionInfo, String> {
    let session = get_or_spawn_acp_session(&workspace_id, state.inner(), &app).await?;

    let result = send_jsonrpc_request(&session, "session/load", json!({
        "sessionId": session_id
    })).await?;

    serde_json::from_value::<OpenCodeSessionInfo>(result)
        .map_err(|e| format!("Failed to parse loaded session: {}", e))
}

#[tauri::command]
pub(crate) async fn delete_opencode_session(
    workspace_id: String,
    session_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let session = get_or_spawn_acp_session(&workspace_id, state.inner(), &app).await?;

    send_jsonrpc_request(&session, "session/delete", json!({
        "sessionId": session_id
    })).await?;

    Ok(())
}

#[tauri::command]
pub(crate) async fn get_opencode_messages(
    workspace_id: String,
    session_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Value, String> {
    let session = get_or_spawn_acp_session(&workspace_id, state.inner(), &app).await?;

    let result = send_jsonrpc_request(&session, "message/list", json!({
        "sessionId": session_id
    })).await?;

    Ok(result)
}

#[tauri::command]
pub(crate) async fn send_opencode_message(
    workspace_id: String,
    session_id: String,
    text: String,
    provider_id: Option<String>,
    model_id: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let session = get_or_spawn_acp_session(&workspace_id, state.inner(), &app).await?;

    let mut params = json!({
        "sessionId": session_id,
        "prompt": [{
            "type": "text",
            "text": text
        }]
    });

    if let (Some(provider), Some(model)) = (provider_id, model_id) {
        params["modelId"] = json!(format!("{}/{}", provider, model));
    }

    let _ = send_jsonrpc_request(&session, "session/prompt", params).await?;

    Ok(())
}

#[tauri::command]
pub(crate) async fn cancel_opencode_operation(
    workspace_id: String,
    session_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let session = get_or_spawn_acp_session(&workspace_id, state.inner(), &app).await?;

    send_jsonrpc_request(&session, "session/cancel", json!({
        "sessionId": session_id
    })).await?;

    Ok(())
}

#[tauri::command]
pub(crate) async fn get_opencode_providers(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<OpenCodeProviderInfo>, String> {
    let workspaces = state.workspaces.lock().await;
    let entry = workspaces
        .get(&workspace_id)
        .ok_or("Workspace not found")?
        .clone();
    drop(workspaces);

    let default_bin = {
        let settings = state.app_settings.lock().await;
        settings.opencode_bin.clone()
    };
    let opencode_bin = entry
        .opencode_bin
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or(default_bin);

    let mut command = build_opencode_command(opencode_bin);
    command.arg("models");
    command.current_dir(&entry.path);
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let output = command.output().await
        .map_err(|e| format!("Failed to run opencode models: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut providers_map: HashMap<String, Vec<OpenCodeProviderModel>> = HashMap::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        if let Some((provider_id, model_id)) = line.split_once('/') {
            let models = providers_map.entry(provider_id.to_string()).or_default();
            models.push(OpenCodeProviderModel {
                id: model_id.to_string(),
                name: model_id.to_string(),
            });
        }
    }

    let mut providers: Vec<OpenCodeProviderInfo> = providers_map
        .into_iter()
        .map(|(id, models)| OpenCodeProviderInfo {
            name: id.clone(),
            id,
            models,
        })
        .collect();

    providers.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(providers)
}
