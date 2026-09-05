import { useEffect, useRef } from "react";

type Props = {
  language: "zh" | "en";
  themeMode: "light" | "dark" | "black";
  onDismiss: () => void;
  onOpenSlashCommands: () => void;
};

export default function MainOnboardingPanel({
  language,
  themeMode,
  onDismiss,
  onOpenSlashCommands,
}: Props) {
  const dismissButtonRef = useRef<HTMLButtonElement>(null);
  const isEnglish = language === "en";
  const isLightTheme = themeMode === "light";
  const isBlackTheme = themeMode === "black";
  const shellStyle = isLightTheme
    ? {
        borderColor: "var(--accent-subtle-border)",
        background: "radial-gradient(circle at top right, var(--accent-subtle), transparent 58%), linear-gradient(135deg, rgba(255,255,255,0.98), rgba(248,250,252,0.98))",
      }
    : {
        borderColor: "var(--accent-subtle-border)",
        background: isBlackTheme
          ? "radial-gradient(circle at top right, var(--accent-subtle), transparent 54%), linear-gradient(135deg, rgba(0,0,0,0.98), rgba(8,8,12,0.98))"
          : "radial-gradient(circle at top right, var(--accent-subtle), transparent 54%), linear-gradient(135deg, rgba(10,14,12,0.96), rgba(16,18,30,0.96))",
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
        backgroundColor: isBlackTheme ? "rgba(4,4,6,0.9)" : "rgba(11,13,16,0.82)",
      };
  const cardTitleStyle = {
    color: isLightTheme ? "#18181b" : "#f4f4f5",
  };
  const stepLabelStyle = {
    color: isLightTheme ? "var(--accent-hover)" : "var(--accent-light)",
  };

  const copy = isEnglish
    ? {
        title: "MAIN QUICK GUIDE",
        intro: "Describe the outcome naturally. These shortcuts help you add context or choose an explicit workflow when you want one.",
        dismiss: "Close",
        cards: [
          {
            label: "Commands",
            title: "/ Slash commands",
            description: "Type / to browse workflows and output styles. /init opens a reviewable AGENTS.md setup; /init --refresh opens a rebuild preview and writes only after confirmation.",
          },
          {
            label: "Context",
            title: "@ Reference files",
            description: "Type @ or use the @ button to add exact workspace files. Use + to attach files that are outside the current workspace.",
          },
          {
            label: "Workflow",
            title: "Shift + Tab",
            description: "Toggle Plan for a reviewable proposal before implementation. Press it again to return to automatic intent routing.",
          },
          {
            label: "Controls",
            title: "Auto Review & Collaboration",
            description: "The shield controls non-destructive approvals. The collaboration button lets MAIN use available child capacity for independent work.",
          },
        ],
        openSlash: "Browse / commands",
        note: "Game-development and MCP work now stay in the same MAIN agent loop. Configured tools remain subject to the current workspace and approval boundaries.",
      }
    : {
        title: "MAIN 使用指南",
        intro: "直接用自然语言说明目标即可；需要补充上下文或明确选择工作流时，可以使用下面这些快捷入口。",
        dismiss: "关闭",
        cards: [
          {
            label: "命令",
            title: "/ 斜杠命令",
            description: "输入 / 可浏览工作流与输出方式；/init 会打开可审阅的 AGENTS.md 初始化预览，/init --refresh 会打开重建预览，确认后才写入。",
          },
          {
            label: "上下文",
            title: "@ 引用文件",
            description: "输入 @ 或点击 @ 按钮可精确引用工作区文件；使用 + 可以附加当前工作区之外的文件。",
          },
          {
            label: "工作流",
            title: "Shift + Tab",
            description: "切换到 Plan，先生成可审阅方案再实施；再次按下可回到自动意图路由。",
          },
          {
            label: "控制",
            title: "自动审查与协作",
            description: "盾牌按钮控制非破坏性操作的自动批准；协作按钮允许 MAIN 为独立任务使用可用的子智能体容量。",
          },
        ],
        openSlash: "浏览 / 命令",
        note: "游戏开发与 MCP 工作现在统一进入 MAIN 的 agent loop；已配置工具仍受当前工作区范围和审批边界约束。",
      };

  useEffect(() => {
    dismissButtonRef.current?.focus();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismiss();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onDismiss]);

  return (
    <section
      id="main-onboarding-panel"
      data-testid="main-onboarding-panel"
      data-theme-mode={themeMode}
      className="mb-3 overflow-hidden rounded-[24px] border"
      style={shellStyle}
      role="region"
      aria-labelledby="main-onboarding-title"
    >
      <div className="flex items-start justify-between gap-3 border-b px-5 py-4" style={dividerStyle}>
        <div>
          <div
            id="main-onboarding-title"
            data-guide-title
            className="text-[16px] font-semibold tracking-[0.08em]"
            style={titleStyle}
          >
            {copy.title}
          </div>
          <div className="mt-1 text-[12px] leading-relaxed" style={bodyStyle}>
            {copy.intro}
          </div>
        </div>
        <button
          ref={dismissButtonRef}
          type="button"
          data-testid="main-onboarding-dismiss"
          onClick={onDismiss}
          className="shrink-0 rounded-full border px-3 py-1 text-[11px] font-medium transition-colors hover:opacity-90"
          style={dismissStyle}
        >
          {copy.dismiss}
        </button>
      </div>

      <div className="grid gap-2 p-4 md:grid-cols-2">
        {copy.cards.map((card) => (
          <div
            key={card.title}
            data-guide-card
            className="rounded-2xl border px-4 py-3"
            style={cardStyle}
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={stepLabelStyle}>
              {card.label}
            </div>
            <div data-guide-card-title className="mt-1 text-[13px] font-semibold" style={cardTitleStyle}>
              {card.title}
            </div>
            <div className="mt-1 text-[11px] leading-snug" style={bodyStyle}>
              {card.description}
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3 border-t px-4 pb-4 pt-3 md:flex-row md:items-center md:justify-between" style={dividerStyle}>
        <div className="text-[11px] leading-relaxed md:max-w-[72%]" style={bodyStyle}>
          {copy.note}
        </div>
        <button
          type="button"
          data-testid="main-onboarding-open-slash"
          onClick={onOpenSlashCommands}
          className="shrink-0 rounded-full border px-3.5 py-1.5 text-[11px] font-semibold text-white transition-colors hover:opacity-90"
          style={{ borderColor: "var(--accent)", backgroundColor: "var(--accent)" }}
        >
          {copy.openSlash}
        </button>
      </div>
    </section>
  );
}
