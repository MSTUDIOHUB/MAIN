import type { ReplyOption } from "./workflowModels";

const USER_OPTIONS_BLOCK_RE = /<user_options>([\s\S]*?)<\/user_options>/gi;
const OPTION_RE = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
const OPTION_ATTR_RE = /\b(label|value|text|title|action)\s*=\s*"([^"]*)"/gi;
const DECISION_CUE_RE = /(?:请选择|请确认|请告诉我|请说明|你可以选择|可选方案|备选方案|选项|选择下一步|下一步可以|选一个|选一项|任选其一|从下面.*选|options?|choices?|would you like|do you want|please choose|please confirm|choose one|pick one|select one)/i;
const ENUMERATED_DECISION_CUE_RE = /(?:请选择|请确认|选一个|选一项|任选其一|从下面.*选|please choose|please confirm|choose one|pick one|select one)/i;
const ENUM_OPTION_RE = /^\s*(?:[-*]|(?:\d+|[A-Za-z])[\.\)、:：])\s+(.+?)\s*$/;
const BINARY_SEPARATOR_RE = /\s*(?:，|,)?\s*(或者|还是|或是|\bor\b)\s*/i;
const ENUMERATED_LINE_RE = /^\s*(?:[-*]|(?:\d+|[A-Za-z])[\.\)、:：])\s+/;
const READONLY_PERMISSION_CUE_RE = /(?:是否|能否|可否|要不要|是否同意|是否允许|是否批准|请问|would you like|do you want|may i|shall i|should i|allow|permission|do you approve)/i;
const READONLY_ACTION_RE = /(?:读取|查看|分析|检查|扫描|搜索|查询|浏览|梳理|提取|汇总|read|open|view|inspect|analy[sz]e|scan|search|query|review|summari[sz]e)/i;
const READONLY_WRITE_EXCLUSION_RE = /(?:写入|修改|删除|创建|执行命令|运行命令|改动|更改|write|modify|delete|create|edit|run command|execute command)/i;
const READONLY_TARGET_RE = /[`"“']([^`"“”']{2,160})[`"”']|([A-Za-z0-9_.\-\/\\]+\.[A-Za-z0-9]{1,12})/;
const EXECUTE_REPLY_NEGATION_RE = /(?:不(?:要|用|进入|开始|继续)?执行|不运行|不部署|暂不执行|暂不运行|停止执行|结束执行|中止执行|仅查看|只查看|查看当前进度|继续讨论|先确认|我来确认|don't execute|do not execute|do not run|don't run|not execute|not run|stop execution|end execution|just view|view current progress|discuss first|confirm first)/i;
const EXECUTE_REPLY_ACTION_RE = /(?:直接|开始|继续|立即|马上|现在)?(?:执行|运行|部署|发布|同步|上传|实现|处理|重构|完善|改造|开发|接入|集成|修复|修改|改动)(?:部署脚本|脚本|命令|deploy(?:\.sh)?|deployment script|command|控制器|系统|逻辑|功能|模块|bug|错误|问题)?|(?:deploy(?:\.sh)?|部署脚本|执行命令|运行命令)|\b(?:run|execute|deploy|ship|implement|refactor|complete|continue|integrate|build|fix|patch|modify)(?:\s+(?:the\s+)?)?(?:deploy(?:\.sh)?|deployment script|script|command|controller|system|logic|feature|module|bug|issue|error)?\b/i;
const PLAN_ARTIFACT_PATH_RE = /\.MAIN[\/\\]plans[\/\\](?:plan|requirements|design|bugfix|tasks)\.md/i;
const PLAN_ARTIFACT_FILE_RE = /\b(?:plan|requirements|design|bugfix|tasks)\.md\b/i;
const PLAN_ARTIFACT_DOC_RE = /(?:计划文档|计划文件|规划文档|规划文件|plan documents?|plan files?|planning documents?|planning files?)/i;
const INTERNAL_PLAN_ARTIFACT_STEP_RE = /(?:创建|生成|写入|更新|保存|落盘|create|generate|write|update|save)/i;
const INTERNAL_PROCESS_OPTION_RE = /(?:切换(?:到)?(?:执行|讨论|计划)模式|进入(?:执行|讨论|计划)模式|进入执行能力|执行模式|workflow mode|mode switch|switch mode|我要调用工具|将调用工具|tool call|^\s*\[?\s*tool[_ ]?call)/i;
const PLAN_SUMMARY_HEADING_RE = /(?:方案总结|需求规格|设计方案|关键设计决策|设计决策|方案正文|计划摘要|方案摘要|requirements?|design|proposal|plan summary|design decisions?)/i;
const PLAN_SUMMARY_ITEM_RE = /^(?:\*\*)?(?:技术栈|核心玩法|交互控制|交付物|架构|游戏循环|渲染|碰撞检测|执行顺序|关键设计决策|需求规格|设计方案|文件|模块|验证方式|测试方案|范围|目标|验收标准)(?:\*\*)?\s*[:：]/i;
const DIAGNOSTIC_STATEMENT_OPTION_RE = /(?:问题可能|可能(?:是|在|出在)|看起来|似乎|应该是|原因(?:可能)?|被(?:自动)?(?:引入|加载|调用|覆盖)|已经(?:存在|完成|失败)|没有(?:被|正确)|is likely|likely due to|probably|seems? like|appears? to|was automatically|has been|is already)/i;
const ACTIONABLE_OPTION_RE = /(?:^方案\s*[A-Z0-9一二三四五六七八九十]|^option\s*[A-Z0-9]|先|直接|继续|开始|执行|运行|批准|确认|选择|使用|改用|采用|切换|修复|修改|实现|重构|完善|生成|创建|删除|保留|跳过|我来|请|proceed|continue|start|run|execute|approve|confirm|choose|use|switch|fix|modify|implement|refactor|create|delete|skip)/i;
const OPERATION_APPROVAL_REPLY_RE = /(?:批准|允许|同意).{0,16}(?:执行|操作|修改|修复|运行|写入)|(?:approve|allow).{0,24}(?:operation|execution|changes?|write|run)/i;
const EXECUTABLE_PROPOSAL_CUE_RE = /(?:修复方案|实现方案|执行方案|改造方案|重构方案|落地方案|方案建议|建议方案|方案如下|执行步骤|实施步骤|下一步(?:可以|建议)?(?:执行|修复|修改|实现|落地)|是否(?:现在|立刻|开始|按上述方案)?(?:执行|修复|修改|实现|落地)|是否需要(?:我|MAIN)?(?:开始|继续)?(?:执行|修复|修改|实现)|要不要(?:开始|按方案)?(?:执行|修复|修改|实现)|proposed fix|fix plan|implementation plan|execution plan|proposal|next steps?.{0,24}(?:implement|execute|apply|fix|patch)|do you want me to.{0,24}(?:start|implement|execute|apply|fix|patch)|should I.{0,24}(?:start|implement|execute|apply|fix|patch)|ready to execute)/i;
const OPERATION_CUE_RE = /(?:写入|修改|改动|更改|删除|创建|生成(?:文件|交付物)?|执行命令|运行命令|运行测试|部署|发布|提交|推送|Git|修复|实现|重构|落地|write|modify|edit|delete|create|generate|run command|execute command|run tests?|deploy|publish|commit|push|git|fix|implement|refactor|patch|ship)/i;
const PLAN_CONTINUATION_ACTION_RE = /^(?:请)?(?:先|继续|直接|再|尝试|立刻|马上|现在)?(?:我来)?(?:确认|检查|分析|读取|查看|定位|排查|验证|核对|梳理|搜索|查询|浏览|测试|尝试(?:确认|检查|分析|读取|查看|定位|排查|验证|核对)|check|verify|confirm|inspect|analy[sz]e|read|look into|debug|investigate|validate|search|query|test)/i;
const PLAN_CONTINUATION_TECH_TARGET_RE = /(?:是否|能否|能不能|有没有|是否能|是否可以|成功|正确|读取|存入|计算|渲染|解析|冲突|代码|源码|文件|接口|组件|函数|状态|数据|日志|表格|Store|store|CSV|csv|src[\/\\]|[A-Za-z0-9_.\-\/\\]+\.[A-Za-z0-9]{1,12}|\bstate\b|\bdata\b|\bfile\b|\bcomponent\b|\bfunction\b|\binterface\b|\blog\b|\bparse\b|\brender\b|\bload\b|\bstore\b)/i;
const PLAN_CONTINUATION_DECISION_RE = /(?:方案|设计|需求|范围|风格|体验|取舍|批准|执行|修复|修改|实现|生成|创建|采用|选择|保留|跳过|提交|部署|开始执行|product|design|requirement|scope|tradeoff|approve|execute|implement|fix|modify|create|choose|adopt|deploy)/i;

function normalizeOptionText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function rewriteExecutionModeChoice(text: string): string {
  const normalized = normalizeOptionText(text);
  if (!normalized) return "";

  const zhMatch = normalized.match(/^(?:请)?(?:切换(?:到)?|进入)(?:执行模式|执行能力)(.*)$/i);
  if (zhMatch) {
    const suffix = normalizeOptionText(zhMatch[1] || "")
      .replace(/^[,，:：;；\-\s]+/, "")
      .replace(/^(?:并|来|以便|然后|继续)\s*/, "");
    return suffix ? `开始执行${suffix}` : "开始执行";
  }

  const enMatch = normalized.match(/^(?:please\s+)?(?:switch(?:\s+to)?|enter)\s+(?:execution|execute)\s+mode\b(.*)$/i);
  if (enMatch) {
    const suffix = normalizeOptionText(enMatch[1] || "")
      .replace(/^[,，:：;；\-\s]+/, "")
      .replace(/^(?:and|then|to|continue)\s+/i, "");
    return suffix ? `Start execution: ${suffix}` : "Start execution";
  }

  return normalized;
}

const OPTION_FILLER_PREFIX_RE = /^(?:下一步行动计划[:：]?\s*|请稍候[,，]?\s*|接下来(?:我)?(?:将|会)?\s*|我(?:将|会|先|现在|接下来)(?:继续)?\s*|I(?:'ll| will)\s+|Next action plan:?\s*|Please wait[, ]*\s*)/i;
const ASSISTANT_FIRST_PERSON_TECH_CONFIRM_RE = /^我来(确认.+(?:是否|能否|能不能|有没有|是否能|是否可以|成功|正确|读取|存入|计算|渲染|解析|Store|store|CSV|csv|代码|文件|接口|组件|函数|状态|数据).*)$/;
const ASSISTANT_FIRST_PERSON_ACTION_RE = /^我来((?:检查|分析|读取|查看|定位|排查|验证).+)$/;

function rewriteAssistantFirstPersonAction(text: string): string {
  const normalized = normalizeOptionText(text);
  if (!normalized) return "";
  const actionMatch = normalized.match(ASSISTANT_FIRST_PERSON_ACTION_RE);
  if (actionMatch?.[1]) return `请${normalizeOptionText(actionMatch[1])}`;
  const confirmMatch = normalized.match(ASSISTANT_FIRST_PERSON_TECH_CONFIRM_RE);
  if (confirmMatch?.[1]) return `请${normalizeOptionText(confirmMatch[1])}`;
  return normalized;
}

export function normalizeReplyOptionLabel(text: string): string {
  const cleaned = rewriteExecutionModeChoice(text)
    .replace(OPTION_FILLER_PREFIX_RE, "")
    .replace(/[。.!！？?]+$/, "");
  const converted = rewriteAssistantFirstPersonAction(convertAssistantClauseToUserChoice(cleaned));
  return normalizeOptionText(converted.replace(/^请\s*/, ""));
}

export function normalizeReplyOptionValue(text: string): string {
  const cleaned = rewriteExecutionModeChoice(text)
    .replace(OPTION_FILLER_PREFIX_RE, "")
    .replace(/^请选择[:：]?\s*/i, "");
  const converted = normalizeOptionText(rewriteAssistantFirstPersonAction(convertAssistantClauseToUserChoice(cleaned)));
  if (/^请(?:先|直接|继续|进入|输出|总结|报告|按|使用|切换|选择|讨论|生成|开始|执行)/.test(converted)) {
    return converted.replace(/^请/, "");
  }
  return converted;
}

function looksLikeInternalPlanArtifactStep(text: string): boolean {
  const normalized = normalizeOptionText(text);
  if (!INTERNAL_PLAN_ARTIFACT_STEP_RE.test(normalized)) return false;
  return (
    PLAN_ARTIFACT_PATH_RE.test(normalized) ||
    PLAN_ARTIFACT_FILE_RE.test(normalized) ||
    PLAN_ARTIFACT_DOC_RE.test(normalized)
  );
}

function looksLikePlanSummaryItem(text: string): boolean {
  return PLAN_SUMMARY_ITEM_RE.test(normalizeOptionText(text));
}

function addReplyOption(
  replyOptions: ReplyOption[],
  seenValues: Set<string>,
  rawLabel: string,
  rawValue?: string,
  action?: ReplyOption["action"],
  source?: ReplyOption["source"],
) {
  const label = normalizeReplyOptionLabel(rawLabel || rawValue || "");
  const value = normalizeReplyOptionValue(rawValue || rawLabel);
  if (!label || !value || seenValues.has(value)) return;
  if (INTERNAL_PROCESS_OPTION_RE.test(label) || INTERNAL_PROCESS_OPTION_RE.test(value)) return;
  if (looksLikeInternalPlanArtifactStep(label) || looksLikeInternalPlanArtifactStep(value)) return;
  if (looksLikePlanSummaryItem(label) || looksLikePlanSummaryItem(value)) return;
  seenValues.add(value);
  const resolvedAction = action ?? inferReplyOptionAction(label, value);
  replyOptions.push({ label, value, ...(resolvedAction ? { action: resolvedAction } : {}), ...(source ? { source } : {}) });
}

function parseOptionAttributes(rawAttributes: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  OPTION_ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OPTION_ATTR_RE.exec(rawAttributes || "")) !== null) {
    const key = String(match[1] || "").toLowerCase();
    const value = normalizeOptionText(match[2] || "");
    if (key && value) attrs[key] = value;
  }
  return attrs;
}

function normalizeReplyOptionAction(value: string | undefined): ReplyOption["action"] | undefined {
  const normalized = String(value || "").trim();
  if (
    normalized === "continue_readonly_once" ||
    normalized === "allow_readonly_session" ||
    normalized === "execute_once" ||
    normalized === "approve_operation_once" ||
    normalized === "adjust_plan" ||
    normalized === "cancel_operation"
  ) {
    return normalized;
  }
  return undefined;
}

function looksLikeExecuteReplyOption(text: string): boolean {
  const normalized = normalizeOptionText(text);
  if (!normalized || EXECUTE_REPLY_NEGATION_RE.test(normalized)) return false;
  return EXECUTE_REPLY_ACTION_RE.test(normalized);
}

function looksLikeDiagnosticStatementOption(text: string): boolean {
  const normalized = normalizeOptionText(text).replace(/^请\s*/, "");
  if (!normalized) return false;
  if (looksLikeExecuteReplyOption(normalized)) return false;
  if (ACTIONABLE_OPTION_RE.test(normalized) && !DIAGNOSTIC_STATEMENT_OPTION_RE.test(normalized)) return false;
  return DIAGNOSTIC_STATEMENT_OPTION_RE.test(normalized);
}

function looksLikeActionableReplyOption(text: string, source?: ReplyOption["source"]): boolean {
  const normalized = normalizeOptionText(text);
  if (!normalized) return false;
  if (source === "readonly_permission") return true;
  if (looksLikeExecuteReplyOption(normalized)) return true;
  if (looksLikeDiagnosticStatementOption(normalized)) return false;
  if (ACTIONABLE_OPTION_RE.test(normalized)) return true;
  return /^方案\s*[A-Z0-9一二三四五六七八九十][\s:：-]/i.test(normalized);
}

function inferReplyOptionAction(label: string, value: string): ReplyOption["action"] | undefined {
  const combined = `${label}\n${value}`;
  if (OPERATION_APPROVAL_REPLY_RE.test(combined)) return "approve_operation_once";
  return looksLikeExecuteReplyOption(combined) ? "execute_once" : undefined;
}

export function inferReplyOptionActionFromText(text: string): ReplyOption["action"] | undefined {
  return inferReplyOptionAction(text, text);
}

function convertAssistantClauseToUserChoice(clause: string): string {
  let normalized = normalizeOptionText(clause)
    .replace(/^[,，:：;；\-]+/, "")
    .replace(/[。.!！？?]+$/, "")
    .trim();

  if (!normalized) return "";

  const opinionMatch = normalized.match(/(?:请)?(?:告诉我|说明)?(?:您|你)?对(.+?)的看法/i);
  if (opinionMatch?.[1]) {
    return `我来确认${normalizeOptionText(opinionMatch[1])}`;
  }

  const confirmMatch = normalized.match(/(?:请)?(?:您|你)?确认(.+)/i);
  if (confirmMatch?.[1]) {
    return `我来确认${normalizeOptionText(confirmMatch[1])}`;
  }

  normalized = normalized
    .replace(/^(?:您|你)?(?:想|希望|要)?(?:让我|要我|叫我)/, "")
    .replace(/^(?:您|你)?是否希望我/, "")
    .replace(/^(?:是否需要|是否要|要不要|是否)/, "")
    .replace(/^(?:Would you like me to|Do you want me to)\s+/i, "")
    .replace(/^(?:Please let me know whether you want me to)\s+/i, "")
    .replace(/^根据我的经验/, "根据你的经验")
    .replace(/我的经验/g, "你的经验")
    .replace(/\bmy experience\b/gi, "your experience")
    .replace(/\bmy\b/gi, "your")
    .replace(/\bme\b/gi, "you")
    .trim();

  if (!normalized) return "";

  if (/^(?:根据你的经验|根据经验|先|直接|继续|假设|开始|构建|执行|proceed|continue|start|assume|build|use your)/i.test(normalized)) {
    return normalizeOptionText(`请${normalized}`.replace(/^请\s*/, "请"));
  }

  return normalized;
}

function hasMultipleEnumeratedLines(text: string): boolean {
  return text
    .split(/\r?\n/)
    .filter((line) => ENUMERATED_LINE_RE.test(line))
    .length > 1;
}

function inferReplyOptionsFromEnumeratedChoices(
  text: string,
  replyOptions: ReplyOption[],
  seenValues: Set<string>,
) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const cueLine = lines[i] || "";
    if (!ENUMERATED_DECISION_CUE_RE.test(cueLine)) continue;
    if (PLAN_SUMMARY_HEADING_RE.test(cueLine) && !/(?:请选择|请确认|请告诉我|选一个|选一项|任选其一|从下面.*选|please choose|choose one|pick one|select one)/i.test(cueLine)) {
      continue;
    }

    const inferred: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const matched = lines[j].match(ENUM_OPTION_RE);
      if (!matched) {
        if (inferred.length > 0) break;
        continue;
      }
      const body = normalizeOptionText(matched[1] || "");
      if (!body || /[？?]$/.test(body) || /是否/.test(body)) {
        inferred.length = 0;
        break;
      }
      if (looksLikeInternalPlanArtifactStep(body) || looksLikePlanSummaryItem(body)) {
        inferred.length = 0;
        break;
      }
      inferred.push(body);
      if (inferred.length >= 4) break;
    }

    if (inferred.length >= 2) {
      inferred
        .filter((option) => looksLikeActionableReplyOption(option, "inferred_enumerated"))
        .forEach((option) => addReplyOption(replyOptions, seenValues, option, undefined, undefined, "inferred_enumerated"));
      return;
    }
  }
}

function inferReplyOptionsFromBinaryChoice(
  text: string,
  replyOptions: ReplyOption[],
  seenValues: Set<string>,
) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const paragraph = paragraphs[i];
    if (!BINARY_SEPARATOR_RE.test(paragraph)) continue;
    if (hasMultipleEnumeratedLines(paragraph)) continue;
    if (!/[？?]$/.test(paragraph) && !DECISION_CUE_RE.test(paragraph)) continue;

    BINARY_SEPARATOR_RE.lastIndex = 0;
    const parts = paragraph.split(BINARY_SEPARATOR_RE).filter(Boolean);
    if (parts.length < 3) continue;

    const firstClause = convertAssistantClauseToUserChoice(parts[0] || "");
    const secondClause = convertAssistantClauseToUserChoice(parts[2] || "");
    if (!firstClause || !secondClause) continue;

    if (!looksLikeActionableReplyOption(firstClause, "inferred_binary") || !looksLikeActionableReplyOption(secondClause, "inferred_binary")) {
      continue;
    }

    addReplyOption(replyOptions, seenValues, firstClause, undefined, undefined, "inferred_binary");
    addReplyOption(replyOptions, seenValues, secondClause, undefined, undefined, "inferred_binary");
    if (replyOptions.length >= 2) return;
  }
}

function looksLikeReadOnlyPermissionPrompt(text: string): boolean {
  const normalized = normalizeOptionText(text);
  if (!normalized) return false;
  if (READONLY_WRITE_EXCLUSION_RE.test(normalized)) return false;
  return READONLY_PERMISSION_CUE_RE.test(normalized) && READONLY_ACTION_RE.test(normalized);
}

function extractReadOnlyActionLabel(text: string): string {
  const normalized = normalizeOptionText(text);
  const targetMatch = normalized.match(READONLY_TARGET_RE);
  const target = normalizeOptionText(targetMatch?.[1] || targetMatch?.[2] || "");
  const isAnalysis = /(?:分析|检查|扫描|搜索|查询|梳理|提取|汇总|inspect|analy[sz]e|scan|search|query|review|summari[sz]e)/i.test(normalized);
  const verb = isAnalysis ? "分析" : "读取";
  return target ? `继续${verb} ${target}` : `继续当前只读${verb}`;
}

function inferReadOnlyPermissionOptions(
  text: string,
  replyOptions: ReplyOption[],
  seenValues: Set<string>,
) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const candidate = [...paragraphs].reverse().find(looksLikeReadOnlyPermissionPrompt) || "";
  if (!candidate) return;

  const actionLabel = extractReadOnlyActionLabel(candidate);
  addReplyOption(
    replyOptions,
    seenValues,
    actionLabel,
    `请${actionLabel}。`,
    "continue_readonly_once",
    "readonly_permission",
  );
  addReplyOption(
    replyOptions,
    seenValues,
    "当前会话只读步骤全部批准",
    `本会话只读读取、搜索和分析步骤全部允许，请${actionLabel}。`,
    "allow_readonly_session",
    "readonly_permission",
  );
}

function looksLikeExecutableProposalFollowUp(text: string): boolean {
  const normalized = normalizeOptionText(text);
  if (!normalized) return false;
  if (READONLY_WRITE_EXCLUSION_RE.test(normalized) && READONLY_ACTION_RE.test(normalized) && !OPERATION_CUE_RE.test(normalized)) {
    return false;
  }
  return EXECUTABLE_PROPOSAL_CUE_RE.test(normalized) && OPERATION_CUE_RE.test(normalized);
}

function inferProposalFollowUpOptions(
  text: string,
  replyOptions: ReplyOption[],
  seenValues: Set<string>,
) {
  if (!looksLikeExecutableProposalFollowUp(text)) return;

  addReplyOption(
    replyOptions,
    seenValues,
    "批准执行本轮操作",
    "我批准按上面的方案开始真实操作，请复用上一轮方案，不要重新规划，直接执行并验证。",
    "approve_operation_once",
    "proposal_follow_up",
  );
  addReplyOption(
    replyOptions,
    seenValues,
    "继续调整方案",
    "请继续调整上面的方案，暂不执行真实操作。",
    "adjust_plan",
    "proposal_follow_up",
  );
  addReplyOption(
    replyOptions,
    seenValues,
    "取消操作",
    "取消上面的执行操作，本轮到此为止。",
    "cancel_operation",
    "operation_approval",
  );
}

export function hasReadOnlyPermissionReplyOptions(replyOptions: ReplyOption[]): boolean {
  return Array.isArray(replyOptions) && replyOptions.some((option) =>
    option.action === "continue_readonly_once" || option.action === "allow_readonly_session"
  );
}

export function hasOnlyReadOnlyPermissionReplyOptions(replyOptions: ReplyOption[]): boolean {
  return (
    Array.isArray(replyOptions) &&
    replyOptions.length > 0 &&
    replyOptions.every((option) =>
      option.action === "continue_readonly_once" || option.action === "allow_readonly_session"
    )
  );
}

export function hasExecutableProposalReplyOptions(replyOptions: ReplyOption[]): boolean {
  return Array.isArray(replyOptions) && replyOptions.some((option) =>
    option.source === "proposal_follow_up" ||
    option.source === "operation_approval" ||
    option.action === "approve_operation_once"
  );
}

function looksLikePlanContinuationReplyOption(option: ReplyOption): boolean {
  const combined = normalizeOptionText(`${option.label || ""} ${option.value || ""}`);
  if (!combined) return false;
  if (option.action && option.action !== "continue_readonly_once" && option.action !== "allow_readonly_session") return false;
  if (option.source === "readonly_permission") return true;
  if (!PLAN_CONTINUATION_ACTION_RE.test(combined)) return false;
  if (!PLAN_CONTINUATION_TECH_TARGET_RE.test(combined)) return false;
  if (PLAN_CONTINUATION_DECISION_RE.test(combined)) return false;
  return true;
}

export function hasOnlyPlanContinuationReplyOptions(replyOptions: ReplyOption[]): boolean {
  return (
    Array.isArray(replyOptions) &&
    replyOptions.length > 0 &&
    replyOptions.every((option) => looksLikePlanContinuationReplyOption(option))
  );
}

export function shouldAutoContinueReadOnlyPermission(params: {
  replyOptions: ReplyOption[];
  readOnlyAutoApproveForSession: boolean;
}): boolean {
  return params.readOnlyAutoApproveForSession && hasReadOnlyPermissionReplyOptions(params.replyOptions);
}

export function stripReadOnlyPermissionPrompt(text: string): string {
  const original = String(text || "");
  if (!original.trim()) return "";

  const paragraphs = original.split(/\n{2,}/);
  const trimmedParagraphs = paragraphs.map((part) => part.trim()).filter(Boolean);
  if (trimmedParagraphs.length === 0) return original.trim();

  const lastParagraph = trimmedParagraphs[trimmedParagraphs.length - 1];
  const lines = lastParagraph.split(/\r?\n/);
  const lastLine = lines[lines.length - 1]?.trim() || "";
  if (lastLine && looksLikeReadOnlyPermissionPrompt(lastLine)) {
    const remainingLastParagraph = lines.slice(0, -1).join("\n").trim();
    const remaining = trimmedParagraphs.slice(0, -1);
    if (remainingLastParagraph) remaining.push(remainingLastParagraph);
    return remaining.join("\n\n").trim();
  }

  if (looksLikeReadOnlyPermissionPrompt(lastParagraph)) {
    return trimmedParagraphs.slice(0, -1).join("\n\n").trim();
  }

  return original.trim();
}

export function buildReadOnlyPermissionContinuationPrompt(language: "zh" | "en"): string {
  return language === "zh"
    ? "用户已允许本会话内后续只读读取、搜索、查看、查询和分析步骤。不要再询问是否同意，也不要输出过渡台词；请立即调用合适的只读工具继续当前任务，例如 `read_file`、`get_file_outline`、`grep_search`、`glob_search`、`read_document`、`analyze_tabular_document` 或 `query_tabular_document`。"
    : "The user has allowed read-only reading, searching, inspecting, querying, and analysis steps for this session. Do not ask for permission again or output process filler; immediately call the appropriate read-only tool such as `read_file`, `get_file_outline`, `grep_search`, `glob_search`, `read_document`, `analyze_tabular_document`, or `query_tabular_document`.";
}

export function extractReplyOptions(text: string): {
  cleanText: string;
  replyOptions: ReplyOption[];
  hasExplicitUserOptionsTag: boolean;
} {
  if (!text) {
    return {
      cleanText: "",
      replyOptions: [],
      hasExplicitUserOptionsTag: false,
    };
  }

  const replyOptions: ReplyOption[] = [];
  const seenValues = new Set<string>();
  let hasExplicitUserOptionsTag = false;

  const cleanText = text
    .replace(USER_OPTIONS_BLOCK_RE, (_fullMatch, blockContent: string) => {
      hasExplicitUserOptionsTag = true;
      OPTION_RE.lastIndex = 0;

      let optionMatch: RegExpExecArray | null;
      while ((optionMatch = OPTION_RE.exec(blockContent)) !== null) {
        const attrs = parseOptionAttributes(optionMatch[1] || "");
        const attrLabel = attrs.label || attrs.title || "";
        const attrValue = attrs.value || attrs.text || "";
        const bodyValue = normalizeOptionText(optionMatch[2] || "");
        const value = attrValue || bodyValue || attrLabel;
        const label = attrLabel || bodyValue || attrValue;
        const action = normalizeReplyOptionAction(attrs.action);

        addReplyOption(replyOptions, seenValues, label, value, action, "explicit_user_options");
      }

      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (replyOptions.length === 0) {
    inferReplyOptionsFromEnumeratedChoices(cleanText, replyOptions, seenValues);
  }

  if (replyOptions.length === 0) {
    inferReplyOptionsFromBinaryChoice(cleanText, replyOptions, seenValues);
  }

  if (replyOptions.length === 0) {
    inferProposalFollowUpOptions(cleanText, replyOptions, seenValues);
  }

  if (replyOptions.length === 0) {
    inferReadOnlyPermissionOptions(cleanText, replyOptions, seenValues);
  }

  return {
    cleanText,
    replyOptions,
    hasExplicitUserOptionsTag,
  };
}

export function shouldPauseForReplyOptions(params: {
  replyOptions: ReplyOption[];
  toolCallCount: number;
  workflowMode: "chat" | "edit" | "plan";
  hasStructuredProposal?: boolean;
  hasReadyPlanArtifacts?: boolean;
  isPlanApproved?: boolean;
  forcePause?: boolean;
  finishReason?: "stop" | "length" | "tool_calls" | null;
}): boolean {
  const {
    replyOptions,
    toolCallCount,
    workflowMode,
    hasStructuredProposal = false,
    hasReadyPlanArtifacts = false,
    isPlanApproved = false,
    forcePause = false,
    finishReason = null,
  } = params;

  if (!Array.isArray(replyOptions) || replyOptions.length === 0) return false;
  const hasLengthSafeOption = replyOptions.some((option) =>
    option.source === "explicit_user_options" ||
    option.source === "proposal_follow_up" ||
    option.source === "operation_approval" ||
    option.action === "approve_operation_once"
  );
  if (finishReason === "length" && !hasLengthSafeOption) return false;
  if (
    workflowMode === "plan" &&
    !isPlanApproved &&
    toolCallCount > 0 &&
    hasExecutableProposalReplyOptions(replyOptions)
  ) {
    return false;
  }
  if (
    workflowMode === "plan" &&
    !isPlanApproved &&
    !hasStructuredProposal &&
    !hasReadyPlanArtifacts &&
    toolCallCount === 0 &&
    hasExecutableProposalReplyOptions(replyOptions)
  ) {
    return false;
  }
  if (
    workflowMode === "plan" &&
    !isPlanApproved &&
    !hasStructuredProposal &&
    !hasReadyPlanArtifacts &&
    toolCallCount === 0 &&
    hasOnlyPlanContinuationReplyOptions(replyOptions)
  ) {
    return false;
  }
  if (forcePause) return true;
  if (toolCallCount > 0 && workflowMode === "edit") return false;

  if (workflowMode === "plan" && !isPlanApproved && (hasStructuredProposal || hasReadyPlanArtifacts)) {
    return false;
  }

  return true;
}

export function serializeAssistantReplyForHistory(text: string, replyOptions: ReplyOption[]): string {
  const cleanText = String(text || "").trim();
  if (!Array.isArray(replyOptions) || replyOptions.length === 0) {
    return cleanText;
  }

  const optionLines = replyOptions
    .map((option, index) => {
      const label = normalizeOptionText(option.label || option.value || "");
      return label ? `${index + 1}. ${label}` : "";
    })
    .filter(Boolean);

  if (optionLines.length === 0) {
    return cleanText;
  }

  return [cleanText, "User choices:", optionLines.join("\n")]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
