use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct GitFileStatus {
    pub(crate) path: String,
    pub(crate) status: String,
    pub(crate) additions: i64,
    pub(crate) deletions: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct GitFileDiff {
    pub(crate) path: String,
    pub(crate) diff: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct GitLogEntry {
    pub(crate) sha: String,
    pub(crate) summary: String,
    pub(crate) author: String,
    pub(crate) timestamp: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct GitLogResponse {
    pub(crate) total: usize,
    pub(crate) entries: Vec<GitLogEntry>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct BranchInfo {
    pub(crate) name: String,
    pub(crate) last_commit: i64,
}

/// Backend type for a workspace - determines which CLI to use
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum BackendType {
    Codex,
    OpenCode,
}

impl Default for BackendType {
    fn default() -> Self {
        BackendType::Codex
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct WorkspaceEntry {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) codex_bin: Option<String>,
    #[serde(default)]
    pub(crate) opencode_bin: Option<String>,
    #[serde(default)]
    pub(crate) backend: BackendType,
    #[serde(default)]
    pub(crate) kind: WorkspaceKind,
    #[serde(default, rename = "parentId")]
    pub(crate) parent_id: Option<String>,
    #[serde(default)]
    pub(crate) worktree: Option<WorktreeInfo>,
    #[serde(default)]
    pub(crate) settings: WorkspaceSettings,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct WorkspaceInfo {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) connected: bool,
    pub(crate) codex_bin: Option<String>,
    #[serde(default)]
    pub(crate) opencode_bin: Option<String>,
    #[serde(default)]
    pub(crate) backend: BackendType,
    #[serde(default)]
    pub(crate) kind: WorkspaceKind,
    #[serde(default, rename = "parentId")]
    pub(crate) parent_id: Option<String>,
    #[serde(default)]
    pub(crate) worktree: Option<WorktreeInfo>,
    #[serde(default)]
    pub(crate) settings: WorkspaceSettings,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WorkspaceKind {
    Main,
    Worktree,
}

impl Default for WorkspaceKind {
    fn default() -> Self {
        WorkspaceKind::Main
    }
}

impl WorkspaceKind {
    pub(crate) fn is_worktree(&self) -> bool {
        matches!(self, WorkspaceKind::Worktree)
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct WorktreeInfo {
    pub(crate) branch: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub(crate) struct WorkspaceSettings {
    #[serde(default, rename = "sidebarCollapsed")]
    pub(crate) sidebar_collapsed: bool,
    #[serde(default, rename = "sortOrder")]
    pub(crate) sort_order: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct AppSettings {
    #[serde(default, rename = "codexBin")]
    pub(crate) codex_bin: Option<String>,
    #[serde(default, rename = "opencodeBin")]
    pub(crate) opencode_bin: Option<String>,
    #[serde(default = "default_access_mode", rename = "defaultAccessMode")]
    pub(crate) default_access_mode: String,
}

fn default_access_mode() -> String {
    "current".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            codex_bin: None,
            opencode_bin: None,
            default_access_mode: "current".to_string(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct OpenCodeSessionInfo {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(rename = "createdAt", default)]
    pub(crate) created_at: Option<i64>,
    #[serde(rename = "updatedAt", default)]
    pub(crate) updated_at: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct OpenCodeMessagePart {
    #[serde(rename = "type")]
    pub(crate) part_type: String,
    #[serde(default)]
    pub(crate) content: Option<String>,
    #[serde(default)]
    pub(crate) tool_name: Option<String>,
    #[serde(default)]
    pub(crate) status: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct OpenCodeMessage {
    pub(crate) id: String,
    #[serde(rename = "sessionId")]
    pub(crate) session_id: String,
    pub(crate) role: String,
    #[serde(default)]
    pub(crate) parts: Vec<OpenCodeMessagePart>,
    #[serde(rename = "createdAt", default)]
    pub(crate) created_at: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct OpenCodeProviderModel {
    pub(crate) id: String,
    pub(crate) name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct OpenCodeProviderInfo {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) models: Vec<OpenCodeProviderModel>,
}

#[cfg(test)]
mod tests {
    use super::{AppSettings, WorkspaceEntry, WorkspaceKind};

    #[test]
    fn app_settings_defaults_from_empty_json() {
        let settings: AppSettings = serde_json::from_str("{}").expect("settings deserialize");
        assert!(settings.codex_bin.is_none());
        assert_eq!(settings.default_access_mode, "current");
    }

    #[test]
    fn workspace_entry_defaults_from_minimal_json() {
        let entry: WorkspaceEntry = serde_json::from_str(
            r#"{"id":"1","name":"Test","path":"/tmp","codexBin":null}"#,
        )
        .expect("workspace deserialize");
        assert!(matches!(entry.kind, WorkspaceKind::Main));
        assert!(matches!(entry.backend, BackendType::Codex));
        assert!(entry.parent_id.is_none());
        assert!(entry.worktree.is_none());
        assert!(entry.opencode_bin.is_none());
        assert!(entry.settings.sort_order.is_none());
    }

    #[test]
    fn workspace_entry_with_opencode_backend() {
        let entry: WorkspaceEntry = serde_json::from_str(
            r#"{"id":"1","name":"Test","path":"/tmp","codexBin":null,"backend":"opencode","opencodeBin":"/usr/bin/opencode"}"#,
        )
        .expect("workspace deserialize");
        assert!(matches!(entry.backend, BackendType::OpenCode));
        assert_eq!(entry.opencode_bin, Some("/usr/bin/opencode".to_string()));
    }
}
