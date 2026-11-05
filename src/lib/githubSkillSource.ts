/** Public provenance belongs to a registration, not a content-addressed cache. */
export interface GithubSkillSource {
  repository: string;
  branch: string;
}

export function normalizeGithubSkillSource(value: unknown): GithubSkillSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { repository, branch } = value as Record<string, unknown>;
  if (typeof repository !== "string" || typeof branch !== "string") return undefined;
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !part || part.length > 100 ||
    part === "." || part === ".." || !/^[A-Za-z0-9_.-]+$/.test(part))) return undefined;
  if (!branch || branch.length > 256 || branch.includes("..") || !/^[A-Za-z0-9_./-]+$/.test(branch) ||
    branch.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
  return { repository, branch };
}
