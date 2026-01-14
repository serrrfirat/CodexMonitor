import { useCallback, useEffect, useReducer, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ConversationItem,
  OpenCodeSessionInfo,
  SessionSummary,
  MessagePart,
  TurnPlan,
  WorkspaceInfo,
} from "../types";
import {
  listOpenCodeSessions,
  createOpenCodeSession,
  sendOpenCodeMessage,
  cancelOpenCodeOperation,
} from "../services/tauri";

const MAX_ITEMS_PER_SESSION = 400;
const STORAGE_KEY_SESSION_ACTIVITY = "codexmonitor.sessionLastUserActivity";

type SessionActivityMap = Record<string, Record<string, number>>;

type SessionState = {
  activeSessionIdByWorkspace: Record<string, string | null>;
  itemsBySession: Record<string, ConversationItem[]>;
  sessionsByWorkspace: Record<string, SessionSummary[]>;
  sessionStatusById: Record<string, { isProcessing: boolean; hasUnread: boolean }>;
  sessionListLoadingByWorkspace: Record<string, boolean>;
  planBySession: Record<string, TurnPlan | null>;
};

type SessionAction =
  | { type: "setActiveSessionId"; workspaceId: string; sessionId: string | null }
  | { type: "ensureSession"; workspaceId: string; sessionId: string; title?: string }
  | { type: "removeSession"; workspaceId: string; sessionId: string }
  | { type: "clearWorkspaceSessions"; workspaceId: string }
  | { type: "markProcessing"; sessionId: string; isProcessing: boolean }
  | { type: "markUnread"; sessionId: string; hasUnread: boolean }
  | { type: "addUserMessage"; workspaceId: string; sessionId: string; text: string }
  | { type: "appendAssistantDelta"; sessionId: string; itemId: string; delta: string }
  | { type: "appendReasoningDelta"; sessionId: string; itemId: string; delta: string }
  | { type: "appendToolOutput"; sessionId: string; itemId: string; delta: string }
  | { type: "setToolStatus"; sessionId: string; itemId: string; status: string }
  | {
      type: "appendToolChanges";
      sessionId: string;
      itemId: string;
      changes: { path: string; kind?: string; diff?: string }[];
    }
  | { type: "upsertItem"; sessionId: string; item: ConversationItem }
  | { type: "setSessionItems"; sessionId: string; items: ConversationItem[] }
  | { type: "setSessions"; workspaceId: string; sessions: SessionSummary[] }
  | { type: "setSessionListLoading"; workspaceId: string; isLoading: boolean }
  | { type: "setSessionPlan"; sessionId: string; plan: TurnPlan | null }
  | { type: "setSessionTitle"; workspaceId: string; sessionId: string; title: string };

const initialState: SessionState = {
  activeSessionIdByWorkspace: {},
  itemsBySession: {},
  sessionsByWorkspace: {},
  sessionStatusById: {},
  sessionListLoadingByWorkspace: {},
  planBySession: {},
};

function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "setActiveSessionId":
      return {
        ...state,
        activeSessionIdByWorkspace: {
          ...state.activeSessionIdByWorkspace,
          [action.workspaceId]: action.sessionId,
        },
      };

    case "ensureSession": {
      const existing = state.sessionsByWorkspace[action.workspaceId] || [];
      if (existing.some((s) => s.id === action.sessionId)) {
        return state;
      }
      return {
        ...state,
        sessionsByWorkspace: {
          ...state.sessionsByWorkspace,
          [action.workspaceId]: [
            ...existing,
            { id: action.sessionId, title: action.title || "New Session" },
          ],
        },
      };
    }

    case "removeSession": {
      const sessions = state.sessionsByWorkspace[action.workspaceId] || [];
      return {
        ...state,
        sessionsByWorkspace: {
          ...state.sessionsByWorkspace,
          [action.workspaceId]: sessions.filter((s) => s.id !== action.sessionId),
        },
      };
    }

    case "clearWorkspaceSessions": {
      const oldSessions = state.sessionsByWorkspace[action.workspaceId] || [];
      const newItemsBySession = { ...state.itemsBySession };
      const newSessionStatusById = { ...state.sessionStatusById };
      const newPlanBySession = { ...state.planBySession };
      for (const session of oldSessions) {
        delete newItemsBySession[session.id];
        delete newSessionStatusById[session.id];
        delete newPlanBySession[session.id];
      }
      return {
        ...state,
        activeSessionIdByWorkspace: {
          ...state.activeSessionIdByWorkspace,
          [action.workspaceId]: null,
        },
        sessionsByWorkspace: {
          ...state.sessionsByWorkspace,
          [action.workspaceId]: [],
        },
        itemsBySession: newItemsBySession,
        sessionStatusById: newSessionStatusById,
        planBySession: newPlanBySession,
      };
    }

    case "markProcessing":
      return {
        ...state,
        sessionStatusById: {
          ...state.sessionStatusById,
          [action.sessionId]: {
            ...state.sessionStatusById[action.sessionId],
            isProcessing: action.isProcessing,
          },
        },
      };

    case "markUnread":
      return {
        ...state,
        sessionStatusById: {
          ...state.sessionStatusById,
          [action.sessionId]: {
            ...state.sessionStatusById[action.sessionId],
            hasUnread: action.hasUnread,
          },
        },
      };

    case "addUserMessage": {
      const items = state.itemsBySession[action.sessionId] || [];
      const newItem: ConversationItem = {
        id: `user-${Date.now()}`,
        kind: "message",
        role: "user",
        text: action.text,
      };
      return {
        ...state,
        itemsBySession: {
          ...state.itemsBySession,
          [action.sessionId]: [...items.slice(-MAX_ITEMS_PER_SESSION + 1), newItem],
        },
      };
    }

    case "appendAssistantDelta": {
      const items = state.itemsBySession[action.sessionId] || [];
      const idx = items.findIndex((i) => i.id === action.itemId);
      if (idx === -1) {
        const newItem: ConversationItem = {
          id: action.itemId,
          kind: "message",
          role: "assistant",
          text: action.delta,
        };
        return {
          ...state,
          itemsBySession: {
            ...state.itemsBySession,
            [action.sessionId]: [...items.slice(-MAX_ITEMS_PER_SESSION + 1), newItem],
          },
        };
      }
      const existingItem = items[idx];
      if (existingItem.kind !== "message") return state;
      const updatedItems = [...items];
      updatedItems[idx] = { ...existingItem, text: existingItem.text + action.delta };
      return {
        ...state,
        itemsBySession: {
          ...state.itemsBySession,
          [action.sessionId]: updatedItems,
        },
      };
    }

    case "appendReasoningDelta": {
      const items = state.itemsBySession[action.sessionId] || [];
      const idx = items.findIndex((i) => i.id === action.itemId);
      if (idx === -1) {
        const newItem: ConversationItem = {
          id: action.itemId,
          kind: "reasoning",
          summary: "Thinking",
          content: action.delta,
        };
        return {
          ...state,
          itemsBySession: {
            ...state.itemsBySession,
            [action.sessionId]: [...items.slice(-MAX_ITEMS_PER_SESSION + 1), newItem],
          },
        };
      }
      const existingItem = items[idx];
      if (existingItem.kind !== "reasoning") return state;
      const updatedItems = [...items];
      updatedItems[idx] = {
        ...existingItem,
        content: (existingItem.content ?? "") + action.delta,
      };
      return {
        ...state,
        itemsBySession: {
          ...state.itemsBySession,
          [action.sessionId]: updatedItems,
        },
      };
    }

    case "appendToolOutput": {
      const items = state.itemsBySession[action.sessionId] || [];
      const idx = items.findIndex((i) => i.id === action.itemId);
      if (idx === -1) {
        const newItem: ConversationItem = {
          id: action.itemId,
          kind: "tool",
          toolType: "acpToolCall",
          title: "Tool",
          detail: "",
          status: "in_progress",
          output: action.delta,
        };
        return {
          ...state,
          itemsBySession: {
            ...state.itemsBySession,
            [action.sessionId]: [...items.slice(-MAX_ITEMS_PER_SESSION + 1), newItem],
          },
        };
      }
      const existingItem = items[idx];
      if (existingItem.kind !== "tool") return state;
      const updatedItems = [...items];
      updatedItems[idx] = {
        ...existingItem,
        output: (existingItem.output ?? "") + action.delta,
      };
      return {
        ...state,
        itemsBySession: {
          ...state.itemsBySession,
          [action.sessionId]: updatedItems,
        },
      };
    }

    case "setToolStatus": {
      const items = state.itemsBySession[action.sessionId] || [];
      const idx = items.findIndex((i) => i.id === action.itemId);
      if (idx === -1) {
        const newItem: ConversationItem = {
          id: action.itemId,
          kind: "tool",
          toolType: "acpToolCall",
          title: "Tool",
          detail: "",
          status: action.status,
        };
        return {
          ...state,
          itemsBySession: {
            ...state.itemsBySession,
            [action.sessionId]: [...items.slice(-MAX_ITEMS_PER_SESSION + 1), newItem],
          },
        };
      }
      const existingItem = items[idx];
      if (existingItem.kind !== "tool") return state;
      const updatedItems = [...items];
      updatedItems[idx] = { ...existingItem, status: action.status };
      return {
        ...state,
        itemsBySession: {
          ...state.itemsBySession,
          [action.sessionId]: updatedItems,
        },
      };
    }

    case "appendToolChanges": {
      const items = state.itemsBySession[action.sessionId] || [];
      const idx = items.findIndex((i) => i.id === action.itemId);
      if (idx === -1) {
        const newItem: ConversationItem = {
          id: action.itemId,
          kind: "tool",
          toolType: "acpToolCall",
          title: "Tool",
          detail: "",
          status: "in_progress",
          changes: action.changes,
        };
        return {
          ...state,
          itemsBySession: {
            ...state.itemsBySession,
            [action.sessionId]: [...items.slice(-MAX_ITEMS_PER_SESSION + 1), newItem],
          },
        };
      }
      const existingItem = items[idx];
      if (existingItem.kind !== "tool") return state;
      const updatedItems = [...items];
      const existingChanges = existingItem.changes ?? [];
      updatedItems[idx] = { ...existingItem, changes: [...existingChanges, ...action.changes] };
      return {
        ...state,
        itemsBySession: {
          ...state.itemsBySession,
          [action.sessionId]: updatedItems,
        },
      };
    }

    case "upsertItem": {
      const items = state.itemsBySession[action.sessionId] || [];
      const idx = items.findIndex((i) => i.id === action.item.id);
      if (idx === -1) {
        return {
          ...state,
          itemsBySession: {
            ...state.itemsBySession,
            [action.sessionId]: [...items.slice(-MAX_ITEMS_PER_SESSION + 1), action.item],
          },
        };
      }
      const updatedItems = [...items];
      updatedItems[idx] = { ...updatedItems[idx], ...action.item };
      return {
        ...state,
        itemsBySession: {
          ...state.itemsBySession,
          [action.sessionId]: updatedItems,
        },
      };
    }

    case "setSessionItems":
      return {
        ...state,
        itemsBySession: {
          ...state.itemsBySession,
          [action.sessionId]: action.items.slice(-MAX_ITEMS_PER_SESSION),
        },
      };

    case "setSessions":
      return {
        ...state,
        sessionsByWorkspace: {
          ...state.sessionsByWorkspace,
          [action.workspaceId]: action.sessions,
        },
      };

    case "setSessionListLoading":
      return {
        ...state,
        sessionListLoadingByWorkspace: {
          ...state.sessionListLoadingByWorkspace,
          [action.workspaceId]: action.isLoading,
        },
      };

    case "setSessionPlan":
      return {
        ...state,
        planBySession: {
          ...state.planBySession,
          [action.sessionId]: action.plan,
        },
      };

    case "setSessionTitle": {
      const sessions = state.sessionsByWorkspace[action.workspaceId] || [];
      const idx = sessions.findIndex((s) => s.id === action.sessionId);
      if (idx === -1) return state;
      const updatedSessions = [...sessions];
      updatedSessions[idx] = { ...updatedSessions[idx], title: action.title };
      return {
        ...state,
        sessionsByWorkspace: {
          ...state.sessionsByWorkspace,
          [action.workspaceId]: updatedSessions,
        },
      };
    }

    default:
      return state;
  }
}

export function loadSessionActivity(): SessionActivityMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_SESSION_ACTIVITY);
    if (!raw) return {};
    return JSON.parse(raw) as SessionActivityMap;
  } catch {
    return {};
  }
}

export function saveSessionActivity(activity: SessionActivityMap) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY_SESSION_ACTIVITY, JSON.stringify(activity));
  } catch {}
}

export function messagePartsToItems(
  messageId: string,
  role: "user" | "assistant",
  parts: MessagePart[],
): ConversationItem[] {
  const items: ConversationItem[] = [];

  for (const part of parts) {
    switch (part.type) {
      case "text":
        items.push({
          id: `${messageId}-text`,
          kind: "message",
          role,
          text: part.text,
        });
        break;

      case "reasoning":
        items.push({
          id: `${messageId}-reasoning`,
          kind: "reasoning",
          summary: part.text.slice(0, 100),
          content: part.text,
        });
        break;

      case "tool_use":
        items.push({
          id: part.id,
          kind: "tool",
          toolType: part.name,
          title: part.name,
          detail: JSON.stringify(part.input, null, 2),
          status: "running",
        });
        break;

      case "tool_result":
        items.push({
          id: part.tool_use_id,
          kind: "tool",
          toolType: "result",
          title: "Tool Result",
          detail: "",
          output: part.content,
          status: "completed",
        });
        break;

      case "patch":
        items.push({
          id: `${messageId}-patch`,
          kind: "diff",
          title: `Changes to ${part.files.length} file(s)`,
          diff: part.files.join("\n"),
          status: "completed",
        });
        break;
    }
  }

  return items;
}

type OpenCodeEvent = {
  workspaceId: string;
  method: string;
  params?: unknown;
};

export function useSessions(
  activeWorkspace: WorkspaceInfo | null,
  _debugLog?: (entry: { source: string; label: string; payload?: unknown }) => void,
) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const activeAssistantMessageIdRef = useRef<Record<string, string>>({});
  const activeReasoningItemIdRef = useRef<Record<string, string>>({});

  const workspaceId = activeWorkspace?.id || null;

  const activeSessionId = workspaceId
    ? state.activeSessionIdByWorkspace[workspaceId] ?? null
    : null;

  const sessions = workspaceId ? state.sessionsByWorkspace[workspaceId] || [] : [];

  const items = activeSessionId ? state.itemsBySession[activeSessionId] || [] : [];

  const sessionStatus = activeSessionId
    ? state.sessionStatusById[activeSessionId] || { isProcessing: false, hasUnread: false }
    : { isProcessing: false, hasUnread: false };

  const isSessionListLoading = workspaceId
    ? state.sessionListLoadingByWorkspace[workspaceId] || false
    : false;

  const plan = activeSessionId ? state.planBySession[activeSessionId] ?? null : null;

  useEffect(() => {
    if (!workspaceId) {
      return;
    }

    dispatch({ type: "clearWorkspaceSessions", workspaceId });

    const setupEventListener = async () => {
      const unlisten = await listen<OpenCodeEvent>("opencode-event", (event) => {
        const { workspaceId: eventWorkspaceId, method, params } = event.payload;

        if (eventWorkspaceId !== workspaceId) return;

        switch (method) {
          case "session/created": {
            const session = params as OpenCodeSessionInfo;
            dispatch({
              type: "ensureSession",
              workspaceId,
              sessionId: session.id,
              title: session.title || "New Session",
            });
            break;
          }

          case "session/updated": {
            const session = params as OpenCodeSessionInfo;
            dispatch({
              type: "setSessionTitle",
              workspaceId,
              sessionId: session.id,
              title: session.title || "Untitled Session",
            });
            break;
          }

          case "session/deleted": {
            const { sessionId } = params as { sessionId: string };
            dispatch({ type: "removeSession", workspaceId, sessionId });
            break;
          }

          case "session/update": {
            const data = params as Record<string, unknown>;
            const targetSessionId = String(data.sessionId ?? "");
            if (!targetSessionId) {
              break;
            }
            const update = data.update;
            if (!update || typeof update !== "object") {
              break;
            }
            const updateRecord = update as Record<string, unknown>;
            const updateType = String(updateRecord.sessionUpdate ?? "");

            if (updateType === "agent_message_chunk") {
              const content = updateRecord.content;
              if (!content || typeof content !== "object") {
                break;
              }
              const contentRecord = content as Record<string, unknown>;
              const delta = String(contentRecord.text ?? "");
              if (!delta) {
                break;
              }
              const itemId =
                activeAssistantMessageIdRef.current[targetSessionId] ?? `assistant-${targetSessionId}`;
              dispatch({
                type: "appendAssistantDelta",
                sessionId: targetSessionId,
                itemId,
                delta,
              });
              break;
            }

            if (updateType === "tool_call" || updateType === "tool_call_update") {
              const toolCallId = String(updateRecord.toolCallId ?? "");
              if (!toolCallId) {
                break;
              }
              const itemId = `tool-${targetSessionId}-${toolCallId}`;

              if (updateType === "tool_call") {
                const title = String(updateRecord.title ?? "Tool");
                const kind = String(updateRecord.kind ?? "");
                const status = String(updateRecord.status ?? "pending");
                const rawInput = updateRecord.rawInput;
                const rawInputText = rawInput ? JSON.stringify(rawInput, null, 2) : "";
                const detailRaw = [kind, rawInputText].filter(Boolean).join("\n");
                const detail = detailRaw.length > 4000 ? `${detailRaw.slice(0, 4000)}…` : detailRaw;

                dispatch({
                  type: "upsertItem",
                  sessionId: targetSessionId,
                  item: {
                    id: itemId,
                    kind: "tool",
                    toolType: "acpToolCall",
                    title: kind ? `${kind}: ${title}` : title,
                    detail,
                    status,
                  },
                });
              }

              const status = updateRecord.status;
              if (typeof status === "string" && status) {
                dispatch({
                  type: "setToolStatus",
                  sessionId: targetSessionId,
                  itemId,
                  status,
                });
              }

              const content = updateRecord.content;
              if (Array.isArray(content)) {
                for (const item of content) {
                  if (!item || typeof item !== "object") {
                    continue;
                  }
                  const contentItem = item as Record<string, unknown>;
                  const contentType = String(contentItem.type ?? "");

                  if (contentType === "content") {
                    const inner = contentItem.content;
                    if (!inner || typeof inner !== "object") {
                      continue;
                    }
                    const innerRecord = inner as Record<string, unknown>;
                    if (innerRecord.type !== "text") {
                      continue;
                    }
                    const text = String(innerRecord.text ?? "");
                    if (!text) {
                      continue;
                    }
                    dispatch({
                      type: "appendToolOutput",
                      sessionId: targetSessionId,
                      itemId,
                      delta: text,
                    });
                  }

                  if (contentType === "diff") {
                    const path = String(contentItem.path ?? "");
                    const oldText = String(contentItem.oldText ?? "");
                    const newText = String(contentItem.newText ?? "");
                    if (!path) {
                      continue;
                    }
                    const diffBody = `--- ${path}\n+++ ${path}\n@@\n-${oldText}\n+${newText}`;
                    const diff = diffBody.length > 10000 ? `${diffBody.slice(0, 10000)}…` : diffBody;
                    dispatch({
                      type: "appendToolChanges",
                      sessionId: targetSessionId,
                      itemId,
                      changes: [
                        {
                          path,
                          kind: "MOD",
                          diff,
                        },
                      ],
                    });
                  }

                  if (contentType === "terminal") {
                    const terminalId = String(contentItem.terminalId ?? "");
                    if (terminalId) {
                      dispatch({
                        type: "appendToolOutput",
                        sessionId: targetSessionId,
                        itemId,
                        delta: `\n[terminal:${terminalId}]\n`,
                      });
                    }
                  }
                }
              }

              break;
            }

            if (updateType === "plan") {
              const entries = updateRecord.entries;
              if (!Array.isArray(entries)) {
                break;
              }
              const steps = entries
                .map((entry) => {
                  if (!entry || typeof entry !== "object") {
                    return null;
                  }
                  const record = entry as Record<string, unknown>;
                  const stepContent = String(record.content ?? "");
                  const statusRaw = String(record.status ?? "pending");
                  const stepStatus =
                    statusRaw === "in_progress"
                      ? "inProgress"
                      : statusRaw === "completed"
                        ? "completed"
                        : "pending";
                  return stepContent
                    ? {
                        step: stepContent,
                        status: stepStatus,
                      }
                    : null;
                })
                .filter(Boolean) as TurnPlan["steps"];

              dispatch({
                type: "setSessionPlan",
                sessionId: targetSessionId,
                plan: {
                  turnId: targetSessionId,
                  explanation: null,
                  steps,
                },
              });
              break;
            }

            if (updateType === "agent_thought_chunk") {
              const content = updateRecord.content;
              if (!content || typeof content !== "object") {
                break;
              }
              const contentRecord = content as Record<string, unknown>;
              if (contentRecord.type !== "text") {
                break;
              }
              const delta = String(contentRecord.text ?? "");
              if (!delta) {
                break;
              }
              let itemId = activeReasoningItemIdRef.current[targetSessionId];
              if (!itemId) {
                itemId = `reasoning-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                activeReasoningItemIdRef.current[targetSessionId] = itemId;
              }
              dispatch({
                type: "appendReasoningDelta",
                sessionId: targetSessionId,
                itemId,
                delta,
              });
              break;
            }

            break;
          }

          case "content/updated": {
            const data = params as { sessionId: string; messageId: string; text?: string };
            if (data.text) {
              dispatch({
                type: "appendAssistantDelta",
                sessionId: data.sessionId,
                itemId: data.messageId || `assistant-${Date.now()}`,
                delta: data.text,
              });
            }
            break;
          }

          case "turn/completed": {
            const { sessionId } = params as { sessionId: string };
            delete activeAssistantMessageIdRef.current[sessionId];
            delete activeReasoningItemIdRef.current[sessionId];
            dispatch({ type: "markProcessing", sessionId, isProcessing: false });
            break;
          }
        }
      });

      unlistenRef.current = unlisten;
    };

    setupEventListener();

    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, [workspaceId]);

  const startSession = useCallback(async () => {
    if (!workspaceId) return null;

    try {
      const session = await createOpenCodeSession(workspaceId);
      dispatch({
        type: "ensureSession",
        workspaceId,
        sessionId: session.id,
        title: session.title || "New Session",
      });
      dispatch({
        type: "setActiveSessionId",
        workspaceId,
        sessionId: session.id,
      });
      return session.id;
    } catch (error) {
      console.error("[useSessions] Failed to create session:", error);
      return null;
    }
  }, [workspaceId]);

  const switchSession = useCallback(
    (sessionId: string | null) => {
      if (!workspaceId) return;
      dispatch({ type: "setActiveSessionId", workspaceId, sessionId });
      if (sessionId) {
        dispatch({ type: "markUnread", sessionId, hasUnread: false });
      }
    },
    [workspaceId],
  );

  const sendMessage = useCallback(
    async (
      text: string,
      options?: { modelId?: string; providerId?: string; sessionId?: string },
    ) => {
      const targetSessionId = options?.sessionId || activeSessionId;
      if (!workspaceId || !targetSessionId) return;

      dispatch({
        type: "addUserMessage",
        workspaceId,
        sessionId: targetSessionId,
        text,
      });

      dispatch({ type: "markProcessing", sessionId: targetSessionId, isProcessing: true });
      dispatch({ type: "setSessionPlan", sessionId: targetSessionId, plan: null });
      delete activeReasoningItemIdRef.current[targetSessionId];

      const assistantItemId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      activeAssistantMessageIdRef.current[targetSessionId] = assistantItemId;
      dispatch({
        type: "upsertItem",
        sessionId: targetSessionId,
        item: {
          id: assistantItemId,
          kind: "message",
          role: "assistant",
          text: "",
        },
      });

      try {
        await sendOpenCodeMessage(workspaceId, targetSessionId, text, {
          providerId: options?.providerId,
          modelId: options?.modelId,
        });
      } catch (error) {
        console.error("[useSessions] Failed to send message:", error);
        dispatch({ type: "markProcessing", sessionId: targetSessionId, isProcessing: false });
      }
    },
    [workspaceId, activeSessionId],
  );

  const cancelCurrentOperation = useCallback(async () => {
    if (!workspaceId || !activeSessionId) return;

    try {
      await cancelOpenCodeOperation(workspaceId, activeSessionId);
      dispatch({ type: "markProcessing", sessionId: activeSessionId, isProcessing: false });
    } catch (error) {
      console.error("[useSessions] Failed to cancel operation:", error);
    }
  }, [workspaceId, activeSessionId]);

  const refreshSessions = useCallback(async () => {
    if (!workspaceId) return;

    dispatch({ type: "setSessionListLoading", workspaceId, isLoading: true });
    try {
      const sessionList = await listOpenCodeSessions(workspaceId);
      const summaries: SessionSummary[] = sessionList.map((s) => ({
        id: s.id,
        title: s.title || "Untitled Session",
      }));
      dispatch({ type: "setSessions", workspaceId, sessions: summaries });
    } catch (error) {
      console.error("[useSessions] Failed to refresh sessions:", error);
    } finally {
      dispatch({ type: "setSessionListLoading", workspaceId, isLoading: false });
    }
  }, [workspaceId]);

  return {
    activeSessionId,
    sessions,
    items,
    plan,
    isProcessing: sessionStatus.isProcessing,
    hasUnread: sessionStatus.hasUnread,
    isSessionListLoading,

    startSession,
    switchSession,
    sendMessage,
    cancelCurrentOperation,
    refreshSessions,

    dispatch,
  };
}
