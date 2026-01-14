export type WorkspaceSettings = {
  sidebarCollapsed: boolean;
  sortOrder?: number | null;
};

export type WorkspaceKind = "main" | "worktree";

export type BackendType = "codex" | "opencode";

export type WorktreeInfo = {
  branch: string;
};

export type WorkspaceInfo = {
  id: string;
  name: string;
  path: string;
  connected: boolean;
  codex_bin?: string | null;
  opencode_bin?: string | null;
  backend?: BackendType;
  kind?: WorkspaceKind;
  parentId?: string | null;
  worktree?: WorktreeInfo | null;
  settings: WorkspaceSettings;
};

export type AppServerEvent = {
  workspace_id: string;
  message: Record<string, unknown>;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type ConversationItem =
  | { id: string; kind: "message"; role: "user" | "assistant"; text: string }
  | { id: string; kind: "reasoning"; summary: string; content: string }
  | { id: string; kind: "diff"; title: string; diff: string; status?: string }
  | { id: string; kind: "review"; state: "started" | "completed"; text: string }
  | {
      id: string;
      kind: "tool";
      toolType: string;
      title: string;
      detail: string;
      status?: string;
      output?: string;
      changes?: { path: string; kind?: string; diff?: string }[];
    };

export type ThreadSummary = {
  id: string;
  name: string;
};

export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | { type: "custom"; instructions: string };

export type AccessMode = "read-only" | "current" | "full-access";

export type AppSettings = {
  codexBin: string | null;
  opencodeBin: string | null;
  defaultAccessMode: AccessMode;
};

export type CodexDoctorResult = {
  ok: boolean;
  codexBin: string | null;
  version: string | null;
  appServerOk: boolean;
  details: string | null;
};

export type ApprovalRequest = {
  workspace_id: string;
  request_id: number;
  method: string;
  params: Record<string, unknown>;
};

export type GitFileStatus = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

export type GitFileDiff = {
  path: string;
  diff: string;
};

export type GitLogEntry = {
  sha: string;
  summary: string;
  author: string;
  timestamp: number;
};

export type GitLogResponse = {
  total: number;
  entries: GitLogEntry[];
};

export type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type ThreadTokenUsage = {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
};

export type TurnPlanStepStatus = "pending" | "inProgress" | "completed";

export type TurnPlanStep = {
  step: string;
  status: TurnPlanStepStatus;
};

export type TurnPlan = {
  turnId: string;
  explanation: string | null;
  steps: TurnPlanStep[];
};

export type RateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type CreditsSnapshot = {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
};

export type RateLimitSnapshot = {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: CreditsSnapshot | null;
  planType: string | null;
};

export type QueuedMessage = {
  id: string;
  text: string;
  createdAt: number;
};

export type ModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
  isDefault: boolean;
  providerId?: string;
};

export type SkillOption = {
  name: string;
  path: string;
  description?: string;
};

export type BranchInfo = {
  name: string;
  lastCommit: number;
};

export type DebugEntry = {
  id: string;
  timestamp: number;
  source: "client" | "server" | "event" | "stderr" | "error";
  label: string;
  payload?: unknown;
};

export type OpenCodeSessionInfo = {
  id: string;
  title?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
};

export type SessionSummary = {
  id: string;
  title: string;
};

export type OpenCodeMessage = {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  parts: MessagePart[];
  createdAt?: number | null;
};

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "patch"; hash: string; files: string[] }
  | { type: "file"; url: string; mime: string };

export type ProviderModel = {
  id: string;
  name: string;
};

export type ProviderInfo = {
  id: string;
  name: string;
  models: ProviderModel[];
};

export type OpenCodeDoctorResult = {
  ok: boolean;
  opencodeBin: string | null;
  version: string | null;
  acpOk: boolean;
  details: string | null;
};
