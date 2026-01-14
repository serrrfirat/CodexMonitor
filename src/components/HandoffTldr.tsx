import type { TurnPlan } from "../types";

type HandoffKind = "thread" | "session";

type HandoffTldr = {
  kind: HandoffKind;
  title: string;
  isFirstView: boolean;
  nextStep: string | null;
};

type HandoffTldrCardProps = {
  tldr: HandoffTldr;
  isProcessing: boolean;
  kind: HandoffKind;
  plan: TurnPlan | null;
};

export function HandoffTldrCard({ tldr }: HandoffTldrCardProps) {
  return (
    <div className="handoff-tldr" role="status" aria-label="Agent status">
      <div className="handoff-tldr-inner">
        <span className="handoff-pill">{tldr.title}</span>
        {tldr.isFirstView && <span className="handoff-flag">FIRST VIEW</span>}
        {tldr.nextStep && (
          <span className="handoff-next">
            <span className="handoff-next-label">Next:</span> {tldr.nextStep}
          </span>
        )}
      </div>
    </div>
  );
}
