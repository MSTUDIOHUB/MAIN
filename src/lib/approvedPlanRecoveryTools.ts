import { isReadOnlyNoProgressDetail } from "./executeRecoveryTools";

export interface ApprovedPlanToolResultLike {
  name?: string;
  isError?: boolean;
  detail?: string;
  content?: string;
  displayContent?: string;
}

function isCachedReadOnlyResult(result: ApprovedPlanToolResultLike): boolean {
  return isReadOnlyNoProgressDetail(
    result.detail || result.displayContent || result.content || "",
  );
}

export function isApprovedPlanCachedReadOnlyNoProgressBatch(input: {
  results: ApprovedPlanToolResultLike[];
  readOnlyTools: Set<string>;
  sawExecutionEvidence?: boolean;
}): boolean {
  if (input.sawExecutionEvidence) return false;
  const results = Array.isArray(input.results) ? input.results : [];
  if (results.length === 0) return false;
  const successful = results.filter((result) => !result.isError);
  if (successful.length === 0) return false;
  if (!successful.every((result) => input.readOnlyTools.has(String(result.name || "")))) return false;
  const readOnlyResults = successful.filter((result) => input.readOnlyTools.has(String(result.name || "")));
  if (readOnlyResults.length === 0) return false;
  return readOnlyResults.every(isCachedReadOnlyResult);
}
