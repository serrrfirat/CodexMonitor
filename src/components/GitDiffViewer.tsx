import { useEffect, useRef, useState } from "react";
import { DiffBlock } from "./DiffBlock";
import { parseDiff } from "../utils/diff";
import { languageFromPath } from "../utils/syntax";
import type { DiffLineReference } from "../types";
import type { ParsedDiffLine } from "../utils/diff";

type GitDiffViewerItem = {
  path: string;
  status: string;
  diff: string;
};

type GitDiffViewerProps = {
  diffs: GitDiffViewerItem[];
  selectedPath: string | null;
  isLoading: boolean;
  error: string | null;
  onLineReference?: (reference: DiffLineReference) => void;
};

type SelectedRange = {
  path: string;
  start: number;
  end: number;
  anchor: number;
};

type SelectableDiffLine = ParsedDiffLine & {
  type: "add" | "del" | "context";
};

function isSelectableLine(line: ParsedDiffLine): line is SelectableDiffLine {
  return line.type === "add" || line.type === "del" || line.type === "context";
}

export function GitDiffViewer({
  diffs,
  selectedPath,
  isLoading,
  error,
  onLineReference,
}: GitDiffViewerProps) {
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const lastScrolledPath = useRef<string | null>(null);
  const [selectedRange, setSelectedRange] = useState<SelectedRange | null>(null);

  useEffect(() => {
    if (!selectedPath) {
      return;
    }
    if (lastScrolledPath.current === selectedPath) {
      return;
    }
    const target = itemRefs.current.get(selectedPath);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      lastScrolledPath.current = selectedPath;
    }
  }, [selectedPath, diffs.length]);

  useEffect(() => {
    if (!selectedRange) {
      return;
    }
    const stillExists = diffs.some((entry) => entry.path === selectedRange.path);
    if (!stillExists) {
      setSelectedRange(null);
    }
  }, [diffs, selectedRange]);

  const handleLineSelect = (
    entry: GitDiffViewerItem,
    parsedLines: ParsedDiffLine[],
    line: ParsedDiffLine,
    index: number,
    isRangeSelect: boolean,
  ) => {
    if (!isSelectableLine(line)) {
      return;
    }
    const hasAnchor = selectedRange?.path === entry.path;
    const anchor = isRangeSelect && hasAnchor ? selectedRange.anchor : index;
    const start = isRangeSelect ? Math.min(anchor, index) : index;
    const end = isRangeSelect ? Math.max(anchor, index) : index;
    setSelectedRange({ path: entry.path, start, end, anchor });

    const selectedLines = parsedLines
      .slice(start, end + 1)
      .filter(isSelectableLine);
    if (selectedLines.length === 0) {
      return;
    }

    const typeSet = new Set(selectedLines.map((item) => item.type));
    const selectionType = typeSet.size === 1 ? selectedLines[0].type : "mixed";
    const firstOldLine = selectedLines.find((item) => item.oldLine !== null)?.oldLine ?? null;
    const firstNewLine = selectedLines.find((item) => item.newLine !== null)?.newLine ?? null;
    const lastOldLine =
      [...selectedLines].reverse().find((item) => item.oldLine !== null)?.oldLine ??
      null;
    const lastNewLine =
      [...selectedLines].reverse().find((item) => item.newLine !== null)?.newLine ??
      null;

    onLineReference?.({
      path: entry.path,
      type: selectionType,
      oldLine: firstOldLine,
      newLine: firstNewLine,
      endOldLine: lastOldLine,
      endNewLine: lastNewLine,
      lines: selectedLines.map((item) => item.text),
    });
  };

  return (
    <div className="diff-viewer">
      {error && <div className="diff-viewer-empty">{error}</div>}
      {!error && isLoading && diffs.length > 0 && (
        <div className="diff-viewer-loading">Refreshing diff...</div>
      )}
      {!error && !isLoading && !diffs.length && (
        <div className="diff-viewer-empty">No changes detected.</div>
      )}
      {!error &&
        diffs.map((entry) => {
          const isSelected = entry.path === selectedPath;
          const hasDiff = entry.diff.trim().length > 0;
          const language = languageFromPath(entry.path);
          const parsedLines = parseDiff(entry.diff);
          const selectedRangeForEntry =
            selectedRange?.path === entry.path
              ? { start: selectedRange.start, end: selectedRange.end }
              : null;
          return (
            <div
              key={entry.path}
              ref={(node) => {
                if (node) {
                  itemRefs.current.set(entry.path, node);
                } else {
                  itemRefs.current.delete(entry.path);
                }
              }}
              className={`diff-viewer-item ${isSelected ? "active" : ""}`}
            >
              <div className="diff-viewer-header">
                <span className="diff-viewer-status">{entry.status}</span>
                <span className="diff-viewer-path">{entry.path}</span>
              </div>
              {hasDiff ? (
                <div className="diff-viewer-output">
                  <DiffBlock
                    diff={entry.diff}
                    language={language}
                    parsedLines={parsedLines}
                    onLineSelect={(line, index, event) =>
                      handleLineSelect(
                        entry,
                        parsedLines,
                        line,
                        index,
                        "shiftKey" in event && event.shiftKey,
                      )
                    }
                    selectedRange={selectedRangeForEntry}
                  />
                </div>
              ) : (
                <div className="diff-viewer-placeholder">Diff unavailable.</div>
              )}
            </div>
          );
        })}
    </div>
  );
}
