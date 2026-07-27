import type { ShellPermissionApproval } from "./ipc";

/** User resolution for one explicitly pending tool authorization request. */
export type ToolReviewDecision =
  | {
      readonly action: "accept";
      readonly grantLocalFileReadPath?: string;
      readonly shellPermissionApproval?: ShellPermissionApproval;
    }
  | { readonly action: "reject" }
  | { readonly action: "error"; readonly error: string };
