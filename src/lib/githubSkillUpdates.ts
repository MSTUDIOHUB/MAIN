import type { Skill } from "./appTypes";
import { fetchAndInstallGithubSkillPackage, type GlobalSkillPackageMeta } from "./ipc";
import { globalSkillPackageId, globalSkillRegistration } from "./globalSkillPackages";
import { normalizeGithubSkillSource, type GithubSkillSource } from "./githubSkillSource";
import { isSafeGlobalSkillRelativePath } from "./protocolPackages";

export interface GithubSkillUpdateCandidate {
  /** Exact in-memory owner. A later edit requires another explicit check. */
  readonly registration: Skill;
  readonly packageId: string;
  readonly meta: GlobalSkillPackageMeta;
  readonly source: GithubSkillSource;
}

export interface GithubSkillUpdateResult {
  status: "updated" | "unchanged" | "stale" | "conflict";
  conflictId?: string;
}

function sameSource(left: GithubSkillSource | undefined, right: GithubSkillSource): boolean {
  return !!left && left.repository.toLowerCase() === right.repository.toLowerCase() && left.branch === right.branch;
}

/** Download only to the immutable cache. Registration changes require Apply. */
export async function checkGithubSkillUpdate(
  registration: Skill,
  fetcher = fetchAndInstallGithubSkillPackage,
): Promise<GithubSkillUpdateCandidate> {
  const source = normalizeGithubSkillSource(registration.githubSource);
  const packageId = globalSkillPackageId(registration);
  if (registration.type !== "package" || !packageId || !source) {
    throw new Error("SKILL_GITHUB_SOURCE_REQUIRED");
  }
  const result = await fetcher(source.repository, source.branch);
  // Reuse registration validation, then enforce the same relative-path contract
  // used by the native immutable package reader before presenting a candidate.
  globalSkillRegistration(registration, result);
  if (!result.files.every(isSafeGlobalSkillRelativePath) || result.entryPoints.length === 0) {
    throw new Error("GLOBAL_SKILL_PACKAGE_METADATA_INVALID");
  }
  const downloadedSource = normalizeGithubSkillSource(result.githubSource);
  if (!sameSource(downloadedSource, source)) throw new Error("SKILL_GITHUB_SOURCE_MISMATCH");
  return Object.freeze({
    registration,
    packageId,
    source: Object.freeze({ ...source }),
    meta: Object.freeze({
      ...result,
      githubSource: Object.freeze({ ...downloadedSource! }),
      entryPoints: Object.freeze([...result.entryPoints]) as unknown as string[],
      files: Object.freeze([...result.files]) as unknown as string[],
    }),
  });
}

/** One registration commit. Never merge another registration's user policy. */
export function applyGithubSkillPackageCandidate(
  skills: Skill[], candidate: GithubSkillUpdateCandidate,
): GithubSkillUpdateResult & { skills: Skill[] } {
  const original = candidate.registration;
  const current = skills.find((skill) => skill.id === original.id);
  if (current !== original || current.type !== "package" || globalSkillPackageId(current) !== candidate.packageId ||
    !sameSource(normalizeGithubSkillSource(current.githubSource), candidate.source)) {
    return { skills, status: "stale" };
  }
  const updated = globalSkillRegistration(current, candidate.meta);
  if (!sameSource(normalizeGithubSkillSource(candidate.meta.githubSource), candidate.source) ||
    !candidate.meta.files.every(isSafeGlobalSkillRelativePath)) {
    throw new Error("GLOBAL_SKILL_PACKAGE_METADATA_INVALID");
  }
  if (globalSkillPackageId(current) === candidate.meta.packageId) return { skills, status: "unchanged" };
  const duplicate = skills.find((skill) => skill !== current && globalSkillPackageId(skill) === candidate.meta.packageId);
  if (duplicate) return { skills, status: "conflict", conflictId: duplicate.id };
  return {
    status: "updated",
    skills: skills.map((skill) => skill === current ? { ...updated, githubSource: { ...candidate.source } } : skill),
  };
}
