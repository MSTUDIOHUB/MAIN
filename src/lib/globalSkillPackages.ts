import type { Skill } from "./appTypes";
import type { GlobalSkillPackageMeta } from "./ipc";

export const SKILL_PACKAGE_BACKUP_KEY = "main-skill-package-migration-backup-v1";

export function globalSkillPackageId(skill: Pick<Skill, "packageStorage">): string | null {
  const storage = skill.packageStorage;
  return storage?.kind === "global" && /^[a-f0-9]{64}$/.test(storage.packageId)
    ? storage.packageId : null;
}

function verifiedMeta(meta: GlobalSkillPackageMeta): GlobalSkillPackageMeta {
  if (!/^[a-f0-9]{64}$/.test(meta?.packageId) || !meta.entryPoint ||
    !Array.isArray(meta.entryPoints) || !meta.entryPoints.includes(meta.entryPoint) ||
    !Array.isArray(meta.files) || !meta.entryPoints.every((entry) => meta.files.includes(entry))) {
    throw new Error("GLOBAL_SKILL_PACKAGE_METADATA_INVALID");
  }
  return meta;
}

export function globalSkillRegistration(skill: Skill, rawMeta: GlobalSkillPackageMeta): Skill {
  const meta = verifiedMeta(rawMeta);
  const { packagePath: _path, workspaceScope: _scope, ...record } = skill;
  return {
    ...record,
    type: "package",
    packageStorage: { kind: "global", packageId: meta.packageId },
    entryPoint: meta.entryPoint,
    entryPoints: [...meta.entryPoints],
  };
}

/** Importing cached bytes is not a request to reset the existing user's policy. */
export function upsertGlobalSkillRegistration(skills: Skill[], incoming: Skill): Skill[] {
  const packageId = globalSkillPackageId(incoming);
  if (packageId && skills.some((skill) => globalSkillPackageId(skill) === packageId)) return skills;
  return [...skills, incoming];
}

function legacyPackage(skill: Skill): boolean {
  return skill.type === "package" && !skill.packageStorage &&
    typeof skill.packagePath === "string" && skill.packagePath.startsWith(".protocols/") &&
    !!skill.workspaceScope?.trim();
}

/** Only package registration fields are backed up; never provider config or credentials. */
export function backupLegacySkillRegistrations(skills: readonly Skill[]): void {
  const storage = globalThis.localStorage;
  if (!storage) throw new Error("SKILL_PACKAGE_BACKUP_STORAGE_UNAVAILABLE");
  const previous = JSON.parse(storage.getItem(SKILL_PACKAGE_BACKUP_KEY) || "[]");
  if (!Array.isArray(previous)) throw new Error("SKILL_PACKAGE_BACKUP_INVALID");
  const records = skills.filter(legacyPackage).map((skill) => ({
    id: skill.id, name: skill.name, desc: skill.desc, type: "package",
    active: skill.active, allowImplicitInvocation: skill.allowImplicitInvocation,
    packagePath: skill.packagePath, workspaceScope: skill.workspaceScope,
    entryPoint: skill.entryPoint, entryPoints: skill.entryPoints,
  }));
  const key = (item: Record<string, unknown>) => JSON.stringify([item.id, item.workspaceScope, item.packagePath]);
  const saved = new Set(previous.map(key));
  storage.setItem(SKILL_PACKAGE_BACKUP_KEY, JSON.stringify([
    ...previous, ...records.filter((record) => !saved.has(key(record))),
  ]));
}

export interface SkillPackageMigrationIo {
  getSkills(): Skill[];
  updateSkills(apply: (current: Skill[]) => Skill[]): void;
  promote(workspace: string, localPath: string): Promise<GlobalSkillPackageMeta>;
  inspect(packageId: string): Promise<GlobalSkillPackageMeta>;
  backup?(records: readonly Skill[]): void;
}

/** One conditional commit after verified copies. Source directories remain intact. */
export async function migrateLegacySkillRegistrations(io: SkillPackageMigrationIo): Promise<{
  migrated: number; failures: Array<{ id: string; error: string }>;
}> {
  const initial = io.getSkills();
  const captured = initial.filter(legacyPackage);
  if (!captured.length) return { migrated: 0, failures: [] };
  (io.backup || backupLegacySkillRegistrations)(captured);
  const verified = new Map<Skill, GlobalSkillPackageMeta>();
  const failures: Array<{ id: string; error: string }> = [];
  for (const record of captured) {
    try {
      const promoted = verifiedMeta(await io.promote(record.workspaceScope!, record.packagePath!));
      const inspected = verifiedMeta(await io.inspect(promoted.packageId));
      if (inspected.packageId !== promoted.packageId) throw new Error("GLOBAL_SKILL_PACKAGE_ID_MISMATCH");
      verified.set(record, inspected);
    } catch (error) {
      failures.push({ id: record.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  let migrated = 0;
  let before: Skill[] | undefined;
  let committed: Skill[] | undefined;
  const applyMigration = (current: Skill[]): Skill[] => {
    const groups = new Map<string, Skill[]>();
    const stale = new Set<string>();
    for (const [record, meta] of verified) {
      const latest = current.find((skill) => skill.id === record.id);
      if (latest && latest !== record) stale.add(meta.packageId);
      if (latest !== record) continue;
      groups.set(meta.packageId, [...(groups.get(meta.packageId) || []), record]);
    }
    const replacements = new Map<Skill, Skill>();
    const removed = new Set<Skill>();
    for (const [packageId, records] of groups) {
      // A concurrent edit/toggle of a duplicate is not consent to change its policy.
      if (stale.has(packageId)) continue;
      const existing = current.find((skill) => globalSkillPackageId(skill) === packageId);
      if (existing) {
        // Existing migration policy is conservative; a new/edited global
        // registration during the copy is a later user choice and wins.
        if (initial.includes(existing)) {
          replacements.set(existing, {
            ...existing,
            active: existing.active && records.every((record) => record.active),
            allowImplicitInvocation: existing.allowImplicitInvocation !== false &&
              records.every((record) => record.allowImplicitInvocation !== false),
          });
        }
        records.forEach((record) => removed.add(record));
      } else {
        const first = records[0]!;
        replacements.set(first, {
          ...globalSkillRegistration(first, verified.get(first)!),
          active: records.every((record) => record.active),
          allowImplicitInvocation: records.every((record) => record.allowImplicitInvocation !== false),
        });
        records.slice(1).forEach((record) => removed.add(record));
      }
      migrated += records.length;
    }
    before = current;
    committed = current.filter((record) => !removed.has(record)).map((record) => replacements.get(record) || record);
    return committed;
  };
  try {
    io.updateSkills(applyMigration);
  } catch (error) {
    // Zustand's synchronous storage write follows its in-memory update. If
    // that write fails, roll back only our exact array, never a later edit.
    if (before && committed && io.getSkills() === committed) {
      try { io.updateSkills((current) => current === committed ? before! : current); }
      catch { /* The old registrations are restored in memory even if storage stays unavailable. */ }
    }
    throw error;
  }
  return { migrated, failures };
}
