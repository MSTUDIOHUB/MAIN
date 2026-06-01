const STRONG_FRESH_FACT_RE =
  /(?:最新|最近|今天|昨日|昨天|明天|本周|本月|今年|刚刚|实时|已(?:经)?(?:更新|发布|上线)|更新到|发布(?:了|到)?|发行|变更|release(?:d)?|latest|newest|recent|today|changelog|release notes?)/i;
const WEAK_CURRENT_FACT_RE = /(?:当前|现在|目前|current|now)/i;
const EXTERNAL_FACT_SUBJECT_RE =
  /(?:\bUE\b|unreal(?:\s+engine)?|虚幻(?:引擎)?|unity|github|gitlab|官方|官网|外部|网页|文档|api|sdk|npm|pypi|天气|气象|新闻|价格|法规|法律|政策|release|tag)/i;
const VERSION_CLAIM_RE =
  /(?:\b\d+(?:\.\d+){1,3}(?:\.x)?\b|\b\d+\.x\b).{0,24}(?:版本|版|release|tag)?|(?:版本|release|tag).{0,24}(?:\b\d+(?:\.\d+){1,3}(?:\.x)?\b|\b\d+\.x\b)/i;
const DIRECT_WEB_TARGET_RE = /(?:https?:\/\/|github\.com|gitlab\.com|release notes?|官方(?:文档|页面|公告)?|官网)/i;

function compactForSearch(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function formatWebResearchLocalDate(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getWebResearchTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  } catch {
    return "local";
  }
}

export function buildWebResearchDateContext(language: "zh" | "en", date: Date = new Date()): string {
  const localDate = formatWebResearchLocalDate(date);
  const year = localDate.slice(0, 4);
  const timeZone = getWebResearchTimeZone();
  if (language === "en") {
    return `Current local date for web research: ${localDate} (${timeZone}). Interpret "today", "current", "latest", and "recent" relative to this date, not the model training cutoff. For latest version/release searches, include ${year} or ${localDate} in the query and verify official sources before concluding.`;
  }
  return `网络搜索日期锚点：当前本地日期为 ${localDate}（${timeZone}）。把“今天、当前、最新、最近”都按这个日期理解，不要按模型训练截止日期或旧年份理解。搜索最新版本/发布信息时，优先在 query 中加入 ${year} 或 ${localDate}，并用官方来源核验后再下结论。`;
}

function buildDateAnchoredQuery(text: string, date: Date = new Date()): string {
  const localDate = formatWebResearchLocalDate(date);
  return `as of ${localDate} ${text}`;
}

export function shouldRequireWebResearchForPrompt(prompt: string): boolean {
  const text = compactForSearch(prompt);
  if (!text) return false;
  if (DIRECT_WEB_TARGET_RE.test(text)) return true;

  const hasStrongFreshCue = STRONG_FRESH_FACT_RE.test(text);
  const hasWeakCurrentCue = WEAK_CURRENT_FACT_RE.test(text);
  const hasExternalSubject = EXTERNAL_FACT_SUBJECT_RE.test(text);
  const hasVersionClaim = VERSION_CLAIM_RE.test(text);

  if (hasStrongFreshCue && hasExternalSubject) return true;
  return hasVersionClaim && hasExternalSubject && (hasStrongFreshCue || hasWeakCurrentCue);
}

export function buildRequiredWebResearchQuery(prompt: string, date: Date = new Date()): string {
  const text = compactForSearch(prompt);
  if (/(?:\bUE\b|unreal(?:\s+engine)?|虚幻(?:引擎)?)/i.test(text)) {
    return buildDateAnchoredQuery(`Unreal Engine latest official release version release notes ${text}`, date);
  }
  if (/(?:\bunity\b|Unity|团结引擎)/i.test(text)) {
    return buildDateAnchoredQuery(`Unity latest official release version release notes ${text}`, date);
  }
  if (/(?:天气|气象|weather)/i.test(text)) {
    return buildDateAnchoredQuery(text, date);
  }
  if (/(?:github\.com|github)/i.test(text)) {
    return `${text} site:github.com`;
  }
  return buildDateAnchoredQuery(text, date);
}

export function buildRequiredWebResearchPrompt(language: "zh" | "en", prompt: string): string {
  const query = buildRequiredWebResearchQuery(prompt);
  if (language === "en") {
    return [
      "Web search is enabled and the user is asking about a current external fact.",
      "The previous response did not use `web_search` or `web_fetch`, so do not answer from model memory.",
      `Call \`web_search\` now with this query: ${query}`,
      "If the search result points to an official page, GitHub release, or release notes, call `web_fetch` on that URL before the final answer.",
      "The final answer must cite source URLs and must clearly say when evidence is inconclusive.",
    ].join("\n");
  }
  return [
    "网络搜索已开启，并且用户正在询问/断言一个需要实时核验的外部事实。",
    "上一条回复没有实际调用 `web_search` 或 `web_fetch`，因此不能根据模型记忆直接确认或否定。",
    `现在必须先调用 \`web_search\`，查询：${query}`,
    "如果搜索结果指向官方页面、GitHub release 或 release notes，请继续调用 `web_fetch` 读取该 URL 后再给最终答案。",
    "最终答案必须引用来源 URL；如果证据不足，要明确说明证据不足，不能武断下结论。",
  ].join("\n");
}
