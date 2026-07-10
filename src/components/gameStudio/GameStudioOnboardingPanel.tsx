import type { GameStudioOnboardingAction } from "../../lib/gameStudio/onboarding";
import { getGameStudioOnboardingCopy } from "../../lib/gameStudio/onboarding";

type Props = {
  language: "zh" | "en";
  isLightTheme: boolean;
  initialized: boolean;
  onDismiss: () => void;
  onAction: (action: GameStudioOnboardingAction) => void;
  onRemove: () => void;
};

export default function GameStudioOnboardingPanel({
  language,
  isLightTheme,
  initialized,
  onDismiss,
  onAction,
  onRemove,
}: Props) {
  const copy = getGameStudioOnboardingCopy(language);
  const shellStyle = isLightTheme
    ? {
        borderColor: "var(--accent-subtle-border)",
        background: "radial-gradient(circle at top right, var(--accent-subtle), transparent 58%), linear-gradient(135deg, rgba(255,255,255,0.98), rgba(248,250,252,0.98))",
      }
    : {
        borderColor: "var(--accent-subtle-border)",
        background: "radial-gradient(circle at top right, var(--accent-subtle), transparent 54%), linear-gradient(135deg, rgba(10,14,12,0.96), rgba(16,18,30,0.96))",
      };
  const dividerStyle = {
    borderColor: isLightTheme ? "rgba(15,23,42,0.08)" : "rgba(255,255,255,0.08)",
  };
  const titleStyle = {
    color: isLightTheme ? "var(--accent-hover)" : "var(--accent-light)",
  };
  const bodyStyle = {
    color: isLightTheme ? "#52525b" : "#b1b1bb",
  };
  const dismissStyle = isLightTheme
    ? {
        borderColor: "var(--accent-subtle-border)",
        backgroundColor: "rgba(255,255,255,0.88)",
        color: "var(--accent-hover)",
      }
    : {
        borderColor: "var(--accent-subtle-border)",
        backgroundColor: "rgba(255,255,255,0.04)",
        color: "var(--accent-light)",
      };
  const cardStyle = isLightTheme
    ? {
        borderColor: "rgba(15,23,42,0.08)",
        backgroundColor: "rgba(255,255,255,0.82)",
      }
    : {
        borderColor: "rgba(255,255,255,0.08)",
        backgroundColor: "rgba(11,13,16,0.82)",
      };
  const cardTitleStyle = {
    color: isLightTheme ? "#18181b" : "#f4f4f5",
  };
  const cardBodyStyle = {
    color: isLightTheme ? "#52525b" : "#b1b1bb",
  };
  const stepLabelStyle = {
    color: isLightTheme ? "var(--accent-hover)" : "var(--accent-light)",
  };
  const cards = [
    {
      action: null,
      title: copy.workspaceTitle,
      stepLabel: copy.prepareWorkspaceStepLabel,
      description: copy.workspaceDescription,
    },
    {
      action: "setup-engine",
      title: copy.setupEngineTitle,
      stepLabel: copy.continueSetupStepLabel,
      description: copy.setupEngineDescription,
    },
    {
      action: "start",
      title: copy.startTitle,
      stepLabel: copy.startWorkflowStepLabel,
      description: copy.startDescription,
    },
    {
      action: "brainstorm",
      title: copy.brainstormTitle,
      stepLabel: copy.startWorkflowStepLabel,
      description: copy.brainstormDescription,
    },
  ] as const;

  return (
    <div
      data-testid="game-studio-onboarding"
      className="mb-3 overflow-hidden rounded-[24px] border"
      style={shellStyle}
    >
      <div className="flex items-start justify-between gap-3 border-b px-5 py-4" style={dividerStyle}>
        <div>
          <div className="text-[16px] font-semibold tracking-[0.08em]" style={titleStyle}>
            {copy.title}
          </div>
          <div className="mt-1 text-[12px] leading-relaxed" style={bodyStyle}>
            {copy.intro}
          </div>
        </div>
        <button
          type="button"
          data-testid="game-studio-onboarding-dismiss"
          onClick={onDismiss}
          className="shrink-0 rounded-full border px-3 py-1 text-[11px] font-medium transition-colors hover:opacity-90"
          style={dismissStyle}
        >
          {copy.dismissLabel}
        </button>
      </div>

      <div className="grid gap-2 p-4 md:grid-cols-2">
        {cards.map((card) => {
          if (!card.action) {
            return (
              <div
                key={card.title}
                data-testid="game-studio-onboarding-workspace"
                className="rounded-2xl border px-4 py-3"
                style={cardStyle}
              >
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={stepLabelStyle}>
                  {card.stepLabel}
                </div>
                <div className="mt-1 text-[13px] font-semibold" style={cardTitleStyle}>
                  {card.title}
                </div>
                <div className="mt-1 text-[11px] leading-snug" style={cardBodyStyle}>
                  {card.description}
                </div>
              </div>
            );
          }

          return (
            <button
              key={card.action}
              type="button"
              data-testid={`game-studio-onboarding-${card.action}`}
              onClick={() => onAction(card.action)}
              className="rounded-2xl border px-4 py-3 text-left transition-colors"
              style={cardStyle}
            >
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={stepLabelStyle}>
                {card.stepLabel}
              </div>
              <div className="mt-1 text-[13px] font-semibold" style={cardTitleStyle}>
                {card.title}
              </div>
              <div className="mt-1 text-[11px] leading-snug" style={cardBodyStyle}>
                {card.description}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2 px-4 pb-4">
        <button
          type="button"
          data-testid="game-studio-onboarding-init"
          onClick={() => onAction("init")}
          className="rounded-full border px-3.5 py-1.5 text-[11px] font-semibold transition-colors hover:opacity-90"
          style={{
            borderColor: "var(--accent)",
            backgroundColor: "var(--accent)",
            color: "#ffffff",
          }}
        >
          {initialized ? copy.reinitializeLabel : copy.initializeLabel}
        </button>
        {initialized && (
          <button
            type="button"
            data-testid="game-studio-onboarding-remove"
            onClick={onRemove}
            className="rounded-full border border-[rgba(244,114,182,0.24)] bg-[rgba(76,5,25,0.28)] px-3.5 py-1.5 text-[11px] font-semibold text-[#fda4af] transition-colors hover:bg-[rgba(127,29,29,0.34)]"
          >
            {copy.removeLabel}
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t px-4 pb-4 pt-3 md:flex-row md:items-center md:justify-between" style={dividerStyle}>
        <div className="text-[11px] leading-relaxed md:max-w-[70%]" style={bodyStyle}>
          {copy.workspaceNote}
        </div>
      </div>
    </div>
  );
}
