import { useEffect, useMemo, useRef, useState } from "react";
import type { ConversationItem, TurnPlan } from "../types";

type HandoffKind = "thread" | "session";

type UseHandoffTldrParams = {
  workspaceId: string | null;
  kind: HandoffKind;
  id: string | null;
  title: string | null;
  items: ConversationItem[];
  plan: TurnPlan | null;
  isProcessing: boolean;
  hasPendingApproval: boolean;
};

export type HandoffTldr = {
  kind: HandoffKind;
  title: string;
  summary: string | null;
  status: "idle" | "working" | "waiting-approval" | "new";
};

type ActivitySnapshot = {
  messageCount: number;
  toolCallCount: number;
  diffCount: number;
  planCompleted: number;
};

type HandoffBaseline = {
  openedAt: number;
  activity: ActivitySnapshot;
};

const BASELINE_VERSION = "v2";
const BASELINE_RESET_MS = 30_000;

function baselineKey(kind: HandoffKind, workspaceId: string, id: string) {
  return `handoff:baseline:${BASELINE_VERSION}:${kind}:${workspaceId}:${id}`;
}

function clampText(input: string, maxLen: number): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

function snapshotActivity(items: ConversationItem[], plan: TurnPlan | null): ActivitySnapshot {
  let messageCount = 0;
  let toolCallCount = 0;
  let diffCount = 0;

  for (const item of items) {
    if (item.kind === "message" && item.role === "assistant") {
      messageCount++;
    } else if (item.kind === "tool") {
      toolCallCount++;
    } else if (item.kind === "diff") {
      diffCount++;
    }
  }

  const planCompleted = plan?.steps.filter((s) => s.status === "completed").length ?? 0;

  return { messageCount, toolCallCount, diffCount, planCompleted };
}

function buildSummary(params: {
  baseline: HandoffBaseline | null;
  current: ActivitySnapshot;
  isProcessing: boolean;
  hasPendingApproval: boolean;
  hasItems: boolean;
}): string | null {
  const { baseline, current, isProcessing, hasPendingApproval, hasItems } = params;

  if (!hasItems) {
    return null;
  }

  if (!baseline) {
    return buildCurrentSummary(current);
  }

  const msgDelta = current.messageCount - baseline.activity.messageCount;
  const toolDelta = current.toolCallCount - baseline.activity.toolCallCount;
  const diffDelta = current.diffCount - baseline.activity.diffCount;
  const planDelta = current.planCompleted - baseline.activity.planCompleted;

  if (msgDelta === 0 && toolDelta === 0 && diffDelta === 0 && planDelta === 0) {
    if (isProcessing) return "Working…";
    if (hasPendingApproval) return "Waiting for approval";
    return "No new activity";
  }

  const parts: string[] = [];

  if (planDelta > 0) {
    parts.push(`${planDelta} task${planDelta === 1 ? "" : "s"} done`);
  }
  if (diffDelta > 0) {
    parts.push(`${diffDelta} file${diffDelta === 1 ? "" : "s"} changed`);
  }
  if (toolDelta > 0 && diffDelta === 0) {
    parts.push(`${toolDelta} action${toolDelta === 1 ? "" : "s"}`);
  }
  if (msgDelta > 0 && parts.length === 0) {
    parts.push(`${msgDelta} response${msgDelta === 1 ? "" : "s"}`);
  }

  if (parts.length === 0) {
    return isProcessing ? "Working…" : "Caught up";
  }

  return parts.join(", ");
}

function buildCurrentSummary(current: ActivitySnapshot): string {
  const parts: string[] = [];

  if (current.planCompleted > 0) {
    parts.push(`${current.planCompleted} task${current.planCompleted === 1 ? "" : "s"} done`);
  }
  if (current.diffCount > 0) {
    parts.push(`${current.diffCount} file${current.diffCount === 1 ? "" : "s"} changed`);
  }
  if (current.messageCount > 0 && parts.length === 0) {
    parts.push(`${current.messageCount} response${current.messageCount === 1 ? "" : "s"}`);
  }

  return parts.length > 0 ? parts.join(", ") : "Session active";
}

export function useHandoffTldr({
  workspaceId,
  kind,
  id,
  title,
  items,
  plan,
  isProcessing,
  hasPendingApproval,
}: UseHandoffTldrParams) {
  const [baseline, setBaseline] = useState<HandoffBaseline | null>(null);
  const latestItemsRef = useRef<ConversationItem[]>(items);
  const latestPlanRef = useRef<TurnPlan | null>(plan);

  useEffect(() => {
    latestItemsRef.current = items;
  }, [items]);

  useEffect(() => {
    latestPlanRef.current = plan;
  }, [plan]);

  useEffect(() => {
    if (!workspaceId || !id) {
      setBaseline(null);
      return;
    }

    const key = baselineKey(kind, workspaceId, id);
    const stored = localStorage.getItem(key);
    
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as HandoffBaseline;
        setBaseline(parsed);
        return;
      } catch {
      }
    }

    const now = Date.now();
    const baselineValue: HandoffBaseline = {
      openedAt: now,
      activity: snapshotActivity(latestItemsRef.current, latestPlanRef.current),
    };
    localStorage.setItem(key, JSON.stringify(baselineValue));
    setBaseline(baselineValue);
  }, [kind, workspaceId, id]);

  useEffect(() => {
    if (!workspaceId || !id) return;

    const timer = setTimeout(() => {
      const key = baselineKey(kind, workspaceId, id);
      const now = Date.now();
      const baselineValue: HandoffBaseline = {
        openedAt: now,
        activity: snapshotActivity(latestItemsRef.current, latestPlanRef.current),
      };
      localStorage.setItem(key, JSON.stringify(baselineValue));
      setBaseline(baselineValue);
    }, BASELINE_RESET_MS);

    return () => clearTimeout(timer);
  }, [kind, workspaceId, id, items, plan]);

  const tldr: HandoffTldr | null = useMemo(() => {
    if (!workspaceId || !id) return null;

    const fallbackTitle = kind === "session" ? "Session" : "Thread";
    const resolvedTitle = clampText(title || fallbackTitle, 40);
    const hasItems = items.length > 0;

    const current = snapshotActivity(items, plan);

    const summary = buildSummary({
      baseline,
      current,
      isProcessing,
      hasPendingApproval,
      hasItems,
    });

    let status: HandoffTldr["status"];
    if (!hasItems) {
      status = "new";
    } else if (hasPendingApproval) {
      status = "waiting-approval";
    } else if (isProcessing) {
      status = "working";
    } else {
      status = "idle";
    }

    return { kind, title: resolvedTitle, summary, status };
  }, [baseline, hasPendingApproval, id, isProcessing, items, kind, plan, title, workspaceId]);

  return { tldr };
}
