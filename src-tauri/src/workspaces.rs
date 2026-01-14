use std::io::Write;
use std::path::PathBuf;

use tauri::{AppHandle, State};
use tokio::process::Command;
use uuid::Uuid;

use crate::codex::spawn_workspace_session;
use crate::opencode::spawn_opencode_session;
use crate::state::AppState;
use crate::storage::write_workspaces;
use crate::types::{
    BackendType, WorkspaceEntry, WorkspaceInfo, WorkspaceKind, WorkspaceSettings, WorktreeInfo,
};
use crate::utils::normalize_git_path;

fn sanitize_worktree_name(branch: &str) -> String {
    let mut result = String::new();
    for ch in branch.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            result.push(ch);
        } else {
            result.push('-');
        }
    }
    let trimmed = result.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "worktree".to_string()
    } else {
        trimmed
    }
}

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "dist" | "target" | "release-artifacts"
    )
}

fn list_workspace_files_inner(root: &PathBuf, max_files: usize) -> Vec<String> {
    let mut results = Vec::new();
    let mut stack = vec![root.clone()];

    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if should_skip_dir(&file_name) {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if path.is_file() {
                if let Ok(rel_path) = path.strip_prefix(root) {
                    let normalized = normalize_git_path(&rel_path.to_string_lossy());
                    if !normalized.is_empty() {
                        results.push(normalized);
                    }
                }
            }
            if results.len() >= max_files {
                return results;
            }
        }
    }

    results.sort();
    results
}

fn sort_workspaces(list: &mut Vec<WorkspaceInfo>) {
    list.sort_by(|a, b| {
        let a_order = a.settings.sort_order.unwrap_or(u32::MAX);
        let b_order = b.settings.sort_order.unwrap_or(u32::MAX);
        a_order.cmp(&b_order).then_with(|| a.name.cmp(&b.name))
    });
}

async fn run_git_command(repo_path: &PathBuf, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run git: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        if detail.is_empty() {
            Err("Git command failed.".to_string())
        } else {
            Err(detail.to_string())
        }
    }
}

async fn git_branch_exists(repo_path: &PathBuf, branch: &str) -> Result<bool, String> {
    let status = Command::new("git")
        .args(["show-ref", "--verify", &format!("refs/heads/{branch}")])
        .current_dir(repo_path)
        .status()
        .await
        .map_err(|e| format!("Failed to run git: {e}"))?;
    Ok(status.success())
}

fn unique_worktree_path(base_dir: &PathBuf, name: &str) -> PathBuf {
    let mut candidate = base_dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    for index in 2..1000 {
        let next = base_dir.join(format!("{name}-{index}"));
        if !next.exists() {
            candidate = next;
            break;
        }
    }
    candidate
}

fn ensure_worktree_ignored(repo_path: &PathBuf) -> Result<(), String> {
    let ignore_path = repo_path.join(".gitignore");
    let entry = ".codex-worktrees/";
    let existing = std::fs::read_to_string(&ignore_path).unwrap_or_default();
    if existing.lines().any(|line| line.trim() == entry) {
        return Ok(());
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&ignore_path)
        .map_err(|e| format!("Failed to update .gitignore: {e}"))?;
    if !existing.ends_with('\n') && !existing.is_empty() {
        file.write_all(b"\n")
            .map_err(|e| format!("Failed to update .gitignore: {e}"))?;
    }
    file.write_all(format!("{entry}\n").as_bytes())
        .map_err(|e| format!("Failed to update .gitignore: {e}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn list_workspaces(
    state: State<'_, AppState>,
) -> Result<Vec<WorkspaceInfo>, String> {
    let workspaces = state.workspaces.lock().await;
    let codex_sessions = state.sessions.lock().await;
    let opencode_sessions = state.opencode_sessions.lock().await;
    let mut result = Vec::new();
    for entry in workspaces.values() {
        let connected = match entry.backend {
            BackendType::Codex => codex_sessions.contains_key(&entry.id),
            BackendType::OpenCode => opencode_sessions.contains_key(&entry.id),
        };
        result.push(WorkspaceInfo {
            id: entry.id.clone(),
            name: entry.name.clone(),
            path: entry.path.clone(),
            codex_bin: entry.codex_bin.clone(),
            opencode_bin: entry.opencode_bin.clone(),
            backend: entry.backend.clone(),
            connected,
            kind: entry.kind.clone(),
            parent_id: entry.parent_id.clone(),
            worktree: entry.worktree.clone(),
            settings: entry.settings.clone(),
        });
    }
    sort_workspaces(&mut result);
    Ok(result)
}

#[tauri::command]
pub(crate) async fn add_workspace(
    path: String,
    codex_bin: Option<String>,
    opencode_bin: Option<String>,
    backend: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkspaceInfo, String> {
    let name = PathBuf::from(&path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Workspace")
        .to_string();
    
    let backend_type = match backend.as_deref() {
        Some("opencode") => BackendType::OpenCode,
        _ => BackendType::Codex,
    };

    let entry = WorkspaceEntry {
        id: Uuid::new_v4().to_string(),
        name: name.clone(),
        path: path.clone(),
        codex_bin,
        opencode_bin,
        backend: backend_type.clone(),
        kind: WorkspaceKind::Main,
        parent_id: None,
        worktree: None,
        settings: WorkspaceSettings::default(),
    };

    match backend_type {
        BackendType::Codex => {
            let default_bin = {
                let settings = state.app_settings.lock().await;
                settings.codex_bin.clone()
            };
            let session = spawn_workspace_session(entry.clone(), default_bin, app).await?;
            {
                let mut workspaces = state.workspaces.lock().await;
                workspaces.insert(entry.id.clone(), entry.clone());
                let list: Vec<_> = workspaces.values().cloned().collect();
                write_workspaces(&state.storage_path, &list)?;
            }
            state
                .sessions
                .lock()
                .await
                .insert(entry.id.clone(), session);
        }
        BackendType::OpenCode => {
            let default_bin = {
                let settings = state.app_settings.lock().await;
                settings.opencode_bin.clone()
            };
            let session = spawn_opencode_session(entry.clone(), default_bin, app).await?;
            {
                let mut workspaces = state.workspaces.lock().await;
                workspaces.insert(entry.id.clone(), entry.clone());
                let list: Vec<_> = workspaces.values().cloned().collect();
                write_workspaces(&state.storage_path, &list)?;
            }
            state
                .opencode_sessions
                .lock()
                .await
                .insert(entry.id.clone(), session);
        }
    }

    Ok(WorkspaceInfo {
        id: entry.id,
        name: entry.name,
        path: entry.path,
        codex_bin: entry.codex_bin,
        opencode_bin: entry.opencode_bin,
        backend: entry.backend,
        connected: true,
        kind: entry.kind,
        parent_id: entry.parent_id,
        worktree: entry.worktree,
        settings: entry.settings,
    })
}

#[tauri::command]
pub(crate) async fn add_worktree(
    parent_id: String,
    branch: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<WorkspaceInfo, String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("Branch name is required.".to_string());
    }

    let parent_entry = {
        let workspaces = state.workspaces.lock().await;
        workspaces
            .get(&parent_id)
            .cloned()
            .ok_or("parent workspace not found")?
    };

    if parent_entry.kind.is_worktree() {
        return Err("Cannot create a worktree from another worktree.".to_string());
    }

    let worktree_root = PathBuf::from(&parent_entry.path).join(".codex-worktrees");
    std::fs::create_dir_all(&worktree_root)
        .map_err(|e| format!("Failed to create worktree directory: {e}"))?;
    ensure_worktree_ignored(&PathBuf::from(&parent_entry.path))?;

    let safe_name = sanitize_worktree_name(branch);
    let worktree_path = unique_worktree_path(&worktree_root, &safe_name);
    let worktree_path_string = worktree_path.to_string_lossy().to_string();

    let branch_exists = git_branch_exists(&PathBuf::from(&parent_entry.path), branch).await?;
    if branch_exists {
        run_git_command(
            &PathBuf::from(&parent_entry.path),
            &["worktree", "add", &worktree_path_string, branch],
        )
        .await?;
    } else {
        run_git_command(
            &PathBuf::from(&parent_entry.path),
            &["worktree", "add", "-b", branch, &worktree_path_string],
        )
        .await?;
    }

    let entry = WorkspaceEntry {
        id: Uuid::new_v4().to_string(),
        name: branch.to_string(),
        path: worktree_path_string,
        codex_bin: parent_entry.codex_bin.clone(),
        opencode_bin: parent_entry.opencode_bin.clone(),
        backend: parent_entry.backend.clone(),
        kind: WorkspaceKind::Worktree,
        parent_id: Some(parent_entry.id.clone()),
        worktree: Some(WorktreeInfo {
            branch: branch.to_string(),
        }),
        settings: WorkspaceSettings::default(),
    };

    match entry.backend {
        BackendType::Codex => {
            let default_bin = {
                let settings = state.app_settings.lock().await;
                settings.codex_bin.clone()
            };
            let session = spawn_workspace_session(entry.clone(), default_bin, app).await?;
            {
                let mut workspaces = state.workspaces.lock().await;
                workspaces.insert(entry.id.clone(), entry.clone());
                let list: Vec<_> = workspaces.values().cloned().collect();
                write_workspaces(&state.storage_path, &list)?;
            }
            state
                .sessions
                .lock()
                .await
                .insert(entry.id.clone(), session);
        }
        BackendType::OpenCode => {
            let default_bin = {
                let settings = state.app_settings.lock().await;
                settings.opencode_bin.clone()
            };
            let session = spawn_opencode_session(entry.clone(), default_bin, app).await?;
            {
                let mut workspaces = state.workspaces.lock().await;
                workspaces.insert(entry.id.clone(), entry.clone());
                let list: Vec<_> = workspaces.values().cloned().collect();
                write_workspaces(&state.storage_path, &list)?;
            }
            state
                .opencode_sessions
                .lock()
                .await
                .insert(entry.id.clone(), session);
        }
    }

    Ok(WorkspaceInfo {
        id: entry.id,
        name: entry.name,
        path: entry.path,
        codex_bin: entry.codex_bin,
        opencode_bin: entry.opencode_bin,
        backend: entry.backend,
        connected: true,
        kind: entry.kind,
        parent_id: entry.parent_id,
        worktree: entry.worktree,
        settings: entry.settings,
    })
}

#[tauri::command]
pub(crate) async fn remove_workspace(
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (entry, child_worktrees) = {
        let workspaces = state.workspaces.lock().await;
        let entry = workspaces
            .get(&id)
            .cloned()
            .ok_or("workspace not found")?;
        if entry.kind.is_worktree() {
            return Err("Use remove_worktree for worktree agents.".to_string());
        }
        let children = workspaces
            .values()
            .filter(|workspace| workspace.parent_id.as_deref() == Some(&id))
            .cloned()
            .collect::<Vec<_>>();
        (entry, children)
    };

    let parent_path = PathBuf::from(&entry.path);
    for child in &child_worktrees {
        match child.backend {
            BackendType::Codex => {
                if let Some(session) = state.sessions.lock().await.remove(&child.id) {
                    let mut child_process = session.child.lock().await;
                    let _ = child_process.kill().await;
                }
            }
            BackendType::OpenCode => {
                if let Some(session) = state.opencode_sessions.lock().await.remove(&child.id) {
                    let mut child_process = session.child.lock().await;
                    let _ = child_process.kill().await;
                }
            }
        }
        let child_path = PathBuf::from(&child.path);
        if child_path.exists() {
            run_git_command(
                &parent_path,
                &["worktree", "remove", "--force", &child.path],
            )
            .await?;
        }
    }
    let _ = run_git_command(&parent_path, &["worktree", "prune", "--expire", "now"]).await;

    match entry.backend {
        BackendType::Codex => {
            if let Some(session) = state.sessions.lock().await.remove(&id) {
                let mut child = session.child.lock().await;
                let _ = child.kill().await;
            }
        }
        BackendType::OpenCode => {
            if let Some(session) = state.opencode_sessions.lock().await.remove(&id) {
                let mut child = session.child.lock().await;
                let _ = child.kill().await;
            }
        }
    }

    {
        let mut workspaces = state.workspaces.lock().await;
        workspaces.remove(&id);
        for child in child_worktrees {
            workspaces.remove(&child.id);
        }
        let list: Vec<_> = workspaces.values().cloned().collect();
        write_workspaces(&state.storage_path, &list)?;
    }

    Ok(())
}

#[tauri::command]
pub(crate) async fn remove_worktree(
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (entry, parent) = {
        let workspaces = state.workspaces.lock().await;
        let entry = workspaces
            .get(&id)
            .cloned()
            .ok_or("workspace not found")?;
        if !entry.kind.is_worktree() {
            return Err("Not a worktree workspace.".to_string());
        }
        let parent_id = entry
            .parent_id
            .clone()
            .ok_or("worktree parent not found")?;
        let parent = workspaces
            .get(&parent_id)
            .cloned()
            .ok_or("worktree parent not found")?;
        (entry, parent)
    };

    match entry.backend {
        BackendType::Codex => {
            if let Some(session) = state.sessions.lock().await.remove(&entry.id) {
                let mut child = session.child.lock().await;
                let _ = child.kill().await;
            }
        }
        BackendType::OpenCode => {
            if let Some(session) = state.opencode_sessions.lock().await.remove(&entry.id) {
                let mut child = session.child.lock().await;
                let _ = child.kill().await;
            }
        }
    }

    let parent_path = PathBuf::from(&parent.path);
    let entry_path = PathBuf::from(&entry.path);
    if entry_path.exists() {
        run_git_command(
            &parent_path,
            &["worktree", "remove", "--force", &entry.path],
        )
        .await?;
    }
    let _ = run_git_command(&parent_path, &["worktree", "prune", "--expire", "now"]).await;

    {
        let mut workspaces = state.workspaces.lock().await;
        workspaces.remove(&entry.id);
        let list: Vec<_> = workspaces.values().cloned().collect();
        write_workspaces(&state.storage_path, &list)?;
    }

    Ok(())
}

#[tauri::command]
pub(crate) async fn update_workspace_settings(
    id: String,
    settings: WorkspaceSettings,
    state: State<'_, AppState>,
) -> Result<WorkspaceInfo, String> {
    let (entry_snapshot, list) = {
        let mut workspaces = state.workspaces.lock().await;
        let entry_snapshot = match workspaces.get_mut(&id) {
            Some(entry) => {
                entry.settings = settings.clone();
                entry.clone()
            }
            None => return Err("workspace not found".to_string()),
        };
        let list: Vec<_> = workspaces.values().cloned().collect();
        (entry_snapshot, list)
    };
    write_workspaces(&state.storage_path, &list)?;

    let connected = match entry_snapshot.backend {
        BackendType::Codex => state.sessions.lock().await.contains_key(&id),
        BackendType::OpenCode => state.opencode_sessions.lock().await.contains_key(&id),
    };
    Ok(WorkspaceInfo {
        id: entry_snapshot.id,
        name: entry_snapshot.name,
        path: entry_snapshot.path,
        codex_bin: entry_snapshot.codex_bin,
        opencode_bin: entry_snapshot.opencode_bin,
        backend: entry_snapshot.backend,
        connected,
        kind: entry_snapshot.kind,
        parent_id: entry_snapshot.parent_id,
        worktree: entry_snapshot.worktree,
        settings: entry_snapshot.settings,
    })
}

#[tauri::command]
pub(crate) async fn update_workspace_codex_bin(
    id: String,
    codex_bin: Option<String>,
    state: State<'_, AppState>,
) -> Result<WorkspaceInfo, String> {
    let (entry_snapshot, list) = {
        let mut workspaces = state.workspaces.lock().await;
        let entry_snapshot = match workspaces.get_mut(&id) {
            Some(entry) => {
                entry.codex_bin = codex_bin.clone();
                entry.clone()
            }
            None => return Err("workspace not found".to_string()),
        };
        let list: Vec<_> = workspaces.values().cloned().collect();
        (entry_snapshot, list)
    };
    write_workspaces(&state.storage_path, &list)?;

    let connected = match entry_snapshot.backend {
        BackendType::Codex => state.sessions.lock().await.contains_key(&id),
        BackendType::OpenCode => state.opencode_sessions.lock().await.contains_key(&id),
    };
    Ok(WorkspaceInfo {
        id: entry_snapshot.id,
        name: entry_snapshot.name,
        path: entry_snapshot.path,
        codex_bin: entry_snapshot.codex_bin,
        opencode_bin: entry_snapshot.opencode_bin,
        backend: entry_snapshot.backend,
        connected,
        kind: entry_snapshot.kind,
        parent_id: entry_snapshot.parent_id,
        worktree: entry_snapshot.worktree,
        settings: entry_snapshot.settings,
    })
}

#[tauri::command]
pub(crate) async fn connect_workspace(
    id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let entry = {
        let workspaces = state.workspaces.lock().await;
        workspaces
            .get(&id)
            .cloned()
            .ok_or("workspace not found")?
    };

    match entry.backend {
        BackendType::Codex => {
            let default_bin = {
                let settings = state.app_settings.lock().await;
                settings.codex_bin.clone()
            };
            let session = spawn_workspace_session(entry.clone(), default_bin, app).await?;
            state.sessions.lock().await.insert(entry.id, session);
        }
        BackendType::OpenCode => {
            let default_bin = {
                let settings = state.app_settings.lock().await;
                settings.opencode_bin.clone()
            };
            let session = spawn_opencode_session(entry.clone(), default_bin, app).await?;
            state.opencode_sessions.lock().await.insert(entry.id, session);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn list_workspace_files(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let workspaces = state.workspaces.lock().await;
    let entry = workspaces
        .get(&workspace_id)
        .ok_or("workspace not found")?;
    let root = PathBuf::from(&entry.path);
    Ok(list_workspace_files_inner(&root, 20000))
}

#[cfg(test)]
mod tests {
    use super::{sanitize_worktree_name, sort_workspaces};
    use crate::types::{BackendType, WorkspaceInfo, WorkspaceKind, WorkspaceSettings};

    fn workspace(name: &str, sort_order: Option<u32>) -> WorkspaceInfo {
        WorkspaceInfo {
            id: name.to_string(),
            name: name.to_string(),
            path: "/tmp".to_string(),
            connected: false,
            codex_bin: None,
            opencode_bin: None,
            backend: BackendType::Codex,
            kind: WorkspaceKind::Main,
            parent_id: None,
            worktree: None,
            settings: WorkspaceSettings {
                sidebar_collapsed: false,
                sort_order,
            },
        }
    }

    #[test]
    fn sanitize_worktree_name_rewrites_specials() {
        assert_eq!(sanitize_worktree_name("feature/new-thing"), "feature-new-thing");
        assert_eq!(sanitize_worktree_name("///"), "worktree");
        assert_eq!(sanitize_worktree_name("--branch--"), "branch");
    }

    #[test]
    fn sort_workspaces_orders_by_sort_then_name() {
        let mut items = vec![
            workspace("beta", None),
            workspace("alpha", None),
            workspace("delta", Some(2)),
            workspace("gamma", Some(1)),
        ];

        sort_workspaces(&mut items);

        let names: Vec<_> = items.into_iter().map(|item| item.name).collect();
        assert_eq!(names, vec!["gamma", "delta", "alpha", "beta"]);
    }
}
