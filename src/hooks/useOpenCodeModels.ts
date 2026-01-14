import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProviderInfo, WorkspaceInfo } from "../types";
import { getOpenCodeProviders } from "../services/tauri";

const STORAGE_KEY = "codexmonitor.opencodeModelByWorkspace";

type StoredSelection = { providerId: string; modelId: string };

type StoredMap = Record<string, StoredSelection>;

function loadStoredMap(): StoredMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as StoredMap;
  } catch {
    return {};
  }
}

function saveStoredMap(map: StoredMap) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
  }
}

export type OpenCodeModelSelection = { providerId: string; modelId: string };

export function useOpenCodeModels(activeWorkspace: WorkspaceInfo | null) {
  const workspaceId = activeWorkspace?.id ?? null;
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectionByWorkspace, setSelectionByWorkspace] = useState<StoredMap>(() =>
    loadStoredMap(),
  );
  const [isLoadingProviders, setIsLoadingProviders] = useState(false);
  const inFlight = useRef(false);

  const selection: OpenCodeModelSelection | null = useMemo(() => {
    if (!workspaceId) return null;
    return selectionByWorkspace[workspaceId] ?? null;
  }, [selectionByWorkspace, workspaceId]);

  const label = useMemo(() => {
    if (!selection) return "Auto (OpenCode default)";
    const provider = providers.find((p) => p.id === selection.providerId) ?? null;
    const model = provider?.models.find((m) => m.id === selection.modelId) ?? null;
    if (provider && model) {
      return `${model.name} — ${provider.name}`;
    }
    return `${selection.modelId} — ${selection.providerId}`;
  }, [providers, selection]);

  const refreshProviders = useCallback(async () => {
    if (!workspaceId) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setIsLoadingProviders(true);
    try {
      const next = await getOpenCodeProviders(workspaceId);
      setProviders(next);
    } catch {
      setProviders([]);
    } finally {
      setIsLoadingProviders(false);
      inFlight.current = false;
    }
  }, [workspaceId]);

  const setSelection = useCallback(
    (next: OpenCodeModelSelection | null) => {
      if (!workspaceId) return;
      setSelectionByWorkspace((prev) => {
        const updated: StoredMap = { ...prev };
        if (next) {
          updated[workspaceId] = next;
        } else {
          delete updated[workspaceId];
        }
        saveStoredMap(updated);
        return updated;
      });
    },
    [workspaceId],
  );

  useEffect(() => {
    if (!workspaceId) return;
    refreshProviders();
  }, [refreshProviders, workspaceId]);

  return {
    providers,
    isLoadingProviders,
    refreshProviders,
    selection,
    setSelection,
    label,
  };
}
