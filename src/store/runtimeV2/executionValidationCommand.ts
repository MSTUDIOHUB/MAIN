import { analyzeValidationCommand } from "../../lib/validationContract";

export interface RuntimeV2FiniteValidationRejection {
  readonly reasonCode: "finite_validation_contract_required";
  readonly rejectionReason: string;
  readonly message: string;
}

/** One finite-validation contract shared by provider admission and execution.
 * Checking before scheduling prevents a search command from entering a
 * validating phase as an ordinary tool effect; authorization repeats the
 * same check so no adapter can bypass it. */
export function finiteValidationCommandRejection(
  value: unknown,
): RuntimeV2FiniteValidationRejection | null {
  const command = String(value || "").trim();
  const analysis = analyzeValidationCommand(command);
  if (analysis.spec?.kind === "finite_command") return null;
  const rejectionReason = analysis.rejectionReason ||
    "no_validation_segment";
  return {
    reasonCode: "finite_validation_contract_required",
    rejectionReason,
    message: [
      "验证阶段需要能以退出状态证明结果的有限 build、test、lint、typecheck 或 check 命令。",
      "cat、grep、sed、head、tail、wc 等只读检查只能补充观察，不能作为验收。",
      `当前命令未满足有限验证契约：${rejectionReason}。`,
    ].join(" "),
  };
}

function validationShellFragments(value: string): string[] {
  const fragments: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  const push = () => {
    const fragment = current.trim();
    current = "";
    if (fragment) fragments.push(fragment);
  };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] || "";
    const next = value[index + 1] || "";
    const previous = value[index - 1] || "";
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quote) {
      current += char;
      if (char === "\\" && quote !== "'") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === "&" && (previous === ">" || previous === "<" || next === ">")) {
      current += char;
      continue;
    }
    if (
      char === ";" ||
      char === "\n" ||
      (char === "&" && next === "&") ||
      (char === "|" && next === "|") ||
      (char === "|" && next !== "|")
    ) {
      push();
      if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
        index += 1;
      }
      continue;
    }
    current += char;
  }
  push();
  return fragments;
}

function stripTrailingShellRedirections(value: string): string {
  let command = value.trim();
  const trailingRedirection =
    /\s+(?:\d*>>?\s*(?:&\d+|[^\s]+)|\d*<<?\s*[^\s]+)\s*$/;
  while (trailingRedirection.test(command)) {
    command = command.replace(trailingRedirection, "").trim();
  }
  return command;
}

/**
 * Recover only a validator that the provider already requested inside an
 * invalid shell wrapper. This is next-request guidance, never an executable
 * rewrite: the model must submit the returned command explicitly, and the
 * ordinary validation authorization still checks it again before execution.
 */
export function correctiveFiniteValidationCommand(
  value: unknown,
): string | null {
  const command = String(value || "").trim();
  if (!command) return null;
  const direct = analyzeValidationCommand(command);
  if (direct.spec?.kind === "finite_command") return direct.spec.command;
  for (const fragment of validationShellFragments(command)) {
    const candidate = stripTrailingShellRedirections(fragment);
    if (!candidate || /^(?:cd|pushd|popd)\b/i.test(candidate)) continue;
    const analysis = analyzeValidationCommand(candidate);
    if (analysis.spec?.kind === "finite_command") {
      return analysis.spec.command;
    }
  }
  return null;
}
