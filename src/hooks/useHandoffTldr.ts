import { useMemo } from "react";
import type { TurnPlan } from "../types";

type HandoffKind = "thread" | "session";

type UseHandoffTldrParams = {
  workspaceId: string | null;
  kind: HandoffKind;
  id: string | null;
  plan: TurnPlan | null;
  isProcessing: boolean;
  hasMessages: boolean;
};

type HandoffTldr = {
  kind: HandoffKind;
  title: string;
  isFirstView: boolean;
  nextStep: string | null;
};

function getNextStep(plan: TurnPlan | null): string | null {
  if (!plan) return null;
  const next = plan.steps.find((step) => step.status !== "completed") ?? null;
  return next?.step ?? null;
}

function clampText(input: string, maxLen: number): string {
  if (input.length <= maxLen) return input;
  return `${input.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

export function useHandoffTldr({
  workspaceId,
  kind,
  id,
  plan,
  isProcessing,
  hasMessages,
}: UseHandoffTldrParams) {
  const tldr: HandoffTldr | null = useMemo(() => {
    if (!workspaceId || !id) return null;

    const title = kind === "session" ? "Session" : "Agent";
    const isFirstView = !hasMessages;

    const nextRaw = isProcessing ? getNextStep(plan) : null;
    const nextStep = nextRaw ? clampText(nextRaw, 64) : null;

    if (!isFirstView && !nextStep) return null;

    return { kind, title, isFirstView, nextStep };
  }, [hasMessages, id, isProcessing, kind, plan, workspaceId]);

  return { tldr };
}
