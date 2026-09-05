import type { RuntimeV2ResultKind } from "../../lib/runtime-v2";

export interface RuntimeV2PlanTerminalFailure {
  readonly resultKind: Extract<RuntimeV2ResultKind, "blocked" | "error">;
  readonly reason: string;
  readonly detailCode: string;
}

/** Fail closed when an explicit collaboration requirement cannot be admitted. */
export function requiredPlanCollaborationFailure(input: {
  readonly error: unknown;
}): RuntimeV2PlanTerminalFailure | null {
  if (!(input.error instanceof Error) || input.error.message !== "RUNTIME_V2_PLAN_REQUIRED_COLLABORATION_UNAVAILABLE") return null;
  return {
    resultKind: "blocked",
    reason: "用户明确要求使用规划子智能体，但当前模型通道没有可安全调度的并发 child 容量；本轮已如实结束，未把未满足的协作要求当作成功。",
    detailCode: "runtime_v2_plan_required_collaboration_unavailable",
  };
}
