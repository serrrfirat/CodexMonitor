import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProviderInfo } from "../types";
import type { OpenCodeModelSelection } from "../hooks/useOpenCodeModels";

type OpenCodeModelPickerProps = {
  providers: ProviderInfo[];
  selection: OpenCodeModelSelection | null;
  onSelect: (selection: OpenCodeModelSelection | null) => void;
  onClose: () => void;
};

export function OpenCodeModelPicker({
  providers,
  selection,
  onSelect,
  onClose,
}: OpenCodeModelPickerProps) {
  const [query, setQuery] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filteredProviders = useMemo(() => {
    const lower = query.toLowerCase().trim();
    if (!lower) return providers;
    return providers
      .map((provider) => ({
        ...provider,
        models: provider.models.filter(
          (m) =>
            m.name.toLowerCase().includes(lower) ||
            m.id.toLowerCase().includes(lower) ||
            provider.name.toLowerCase().includes(lower)
        ),
      }))
      .filter((provider) => provider.models.length > 0);
  }, [providers, query]);

  const flatItems = useMemo(() => {
    const items: { type: "auto" | "model"; providerId?: string; modelId?: string; label: string; sublabel?: string }[] = [];
    items.push({ type: "auto", label: "Auto (OpenCode default)" });
    for (const provider of filteredProviders) {
      for (const model of provider.models) {
        items.push({
          type: "model",
          providerId: provider.id,
          modelId: model.id,
          label: model.name,
          sublabel: provider.name,
        });
      }
    }
    return items;
  }, [filteredProviders]);

  const handleSelect = useCallback(
    (item: (typeof flatItems)[number]) => {
      if (item.type === "auto") {
        onSelect(null);
      } else if (item.providerId && item.modelId) {
        onSelect({ providerId: item.providerId, modelId: item.modelId });
      }
      onClose();
    },
    [onClose, onSelect]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightIndex((prev) => Math.min(prev + 1, flatItems.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightIndex((prev) => Math.max(prev - 1, -1));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (highlightIndex >= 0 && highlightIndex < flatItems.length) {
          handleSelect(flatItems[highlightIndex]);
        }
        return;
      }
    },
    [flatItems, handleSelect, highlightIndex, onClose]
  );

  useEffect(() => {
    const list = listRef.current;
    if (!list || highlightIndex < 0) return;
    const highlighted = list.querySelector(`[data-index="${highlightIndex}"]`);
    if (highlighted) {
      highlighted.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIndex]);

  useEffect(() => {
    setHighlightIndex(-1);
  }, [query]);

  const isSelected = (item: (typeof flatItems)[number]) => {
    if (item.type === "auto") {
      return selection === null;
    }
    return (
      selection?.providerId === item.providerId &&
      selection?.modelId === item.modelId
    );
  };

  return (
    <div
      className="opencode-picker"
      role="dialog"
      aria-modal="true"
      aria-label="Select model"
      onKeyDown={handleKeyDown}
    >
      <div className="opencode-picker-backdrop" onClick={onClose} />
      <div className="opencode-picker-card">
        <div className="opencode-picker-header">
          <span className="opencode-picker-title">Select model</span>
          <button
            className="opencode-picker-close"
            onClick={onClose}
            aria-label="Close"
            type="button"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M18 6L6 18M6 6l12 12"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="opencode-picker-search">
          <svg className="opencode-picker-search-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M20 20l-4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="opencode-picker-input"
            placeholder="Search models..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search models"
          />
        </div>
        <div className="opencode-picker-list" ref={listRef}>
          {filteredProviders.length === 0 && query && (
            <div className="opencode-picker-empty">No models match "{query}"</div>
          )}
          <button
            className={`opencode-picker-item opencode-picker-item--auto${
              isSelected(flatItems[0]) ? " is-selected" : ""
            }${highlightIndex === 0 ? " is-highlighted" : ""}`}
            onClick={() => handleSelect(flatItems[0])}
            data-index={0}
            type="button"
          >
            <span className="opencode-picker-item-icon">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M12 3v18M3 12h18"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span className="opencode-picker-item-label">Auto (OpenCode default)</span>
            {isSelected(flatItems[0]) && (
              <span className="opencode-picker-check" aria-hidden>
                <svg viewBox="0 0 24 24" fill="none">
                  <path
                    d="M5 13l4 4L19 7"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            )}
          </button>

          {filteredProviders.map((provider) => {
            const providerStartIndex = flatItems.findIndex(
              (item) => item.type === "model" && item.providerId === provider.id
            );
            return (
              <div key={provider.id} className="opencode-picker-group">
                <div className="opencode-picker-group-label">{provider.name}</div>
                {provider.models.map((model, modelIndex) => {
                  const itemIndex = providerStartIndex + modelIndex;
                  const item = flatItems[itemIndex];
                  return (
                    <button
                      key={model.id}
                      className={`opencode-picker-item${
                        isSelected(item) ? " is-selected" : ""
                      }${highlightIndex === itemIndex ? " is-highlighted" : ""}`}
                      onClick={() => handleSelect(item)}
                      data-index={itemIndex}
                      type="button"
                    >
                      <span className="opencode-picker-item-label">{model.name}</span>
                      {isSelected(item) && (
                        <span className="opencode-picker-check" aria-hidden>
                          <svg viewBox="0 0 24 24" fill="none">
                            <path
                              d="M5 13l4 4L19 7"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
