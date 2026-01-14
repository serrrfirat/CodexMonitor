import type { HandoffTldr } from "../hooks/useHandoffTldr";

type HandoffTldrCardProps = {
  tldr: HandoffTldr;
};

const STATUS_LABELS: Record<HandoffTldr["status"], string> = {
  new: "NEW",
  working: "WORKING",
  "waiting-approval": "NEEDS APPROVAL",
  idle: "",
};

export function HandoffTldrCard({ tldr }: HandoffTldrCardProps) {
  const statusLabel = STATUS_LABELS[tldr.status];
  const hasContent = statusLabel || tldr.summary;

  if (!hasContent) return null;

  return (
    <div className="handoff-tldr" role="status" aria-label="Session status">
      <div className="handoff-tldr-inner">
        {statusLabel && <span className={`handoff-flag handoff-flag--${tldr.status}`}>{statusLabel}</span>}
        {tldr.summary && <span className="handoff-summary">{tldr.summary}</span>}
      </div>
    </div>
  );
}
