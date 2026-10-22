import {
  isSkillVisibleToModel,
  listSkillCatalog,
  loadSkillContent,
  loadSkillResourceContent,
  type SkillCatalogSnapshot,
  type SkillDisclosureOptions,
} from "./agentSkills";

function number(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** The existing read-only tool is the only resource surface. Its immutable
 * catalog supplies package identity; no workspace or authority is replaced. */
export async function executeAgentSkillTool(
  catalog: SkillCatalogSnapshot | null | undefined,
  args: Record<string, unknown>,
): Promise<string> {
  if (!catalog) throw new Error("SKILL_CATALOG_UNAVAILABLE: no Skill catalog was admitted for this Turn.");
  const operation = String(args.operation || "load").trim();
  if (operation === "list") {
    if (args.resource !== undefined) throw new Error("SKILL_RESOURCE_OPERATION_INVALID: resources require operation=load.");
    return JSON.stringify(listSkillCatalog(catalog, { query: string(args.query), cursor: string(args.cursor), limit: number(args.limit) }));
  }
  if (operation !== "load") throw new Error(`SKILL_OPERATION_INVALID: ${operation}`);
  const skillId = String(args.skill_id || "").trim();
  if (!isSkillVisibleToModel(catalog, skillId)) throw new Error(`SKILL_NOT_AUTHORIZED: ${skillId || "missing skill id"}`);
  const options: SkillDisclosureOptions = {
    maxChars: number(args.max_chars), section: string(args.section), startLine: number(args.start_line),
    maxLines: number(args.max_lines), startChar: number(args.start_char), expectedVersion: string(args.expected_version), sectionCursor: string(args.section_cursor),
  };
  const resourceRequested = args.resource !== undefined;
  if (resourceRequested && (typeof args.resource !== "string" || !args.resource)) throw new Error("SKILL_RESOURCE_PATH_INVALID: resource must be a relative file path.");
  const loaded = resourceRequested
    ? await loadSkillResourceContent(catalog, skillId, args.resource as string, options)
    : loadSkillContent(catalog, skillId, options);
  return JSON.stringify({
    type: resourceRequested ? "skill.resource" : "skill.loaded",
    ...loaded,
    effect: resourceRequested
      ? "resource_guidance_no_additional_permissions"
      : loaded.complete === false ? "instructions_partially_read_no_additional_permissions" : "instructions_loaded_no_additional_permissions",
  });
}
