import { runtimeV2EvidenceVersion } from "../../lib/runtime-v2";
import { extractReadFileWindowMetadata } from "../../lib/readFileWindow";

/**
 * A read window is presentation evidence, not file-version authority. Exact
 * read_file evidence always hashes the complete raw file so Plan review and
 * post-approval freshness checks compare the same bytes.
 */
export async function resolveRuntimeV2SourceEvidenceVersion(input: {
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly output: unknown;
  readonly readExactFile?: () => Promise<unknown>;
}): Promise<string> {
  if (
    input.toolName !== "read_file" ||
    input.args.__raw === true ||
    !input.readExactFile
  ) {
    return runtimeV2EvidenceVersion(input.output);
  }
  const observedVersion = typeof input.output === "string"
    ? extractReadFileWindowMetadata(input.output)?.contentVersion
    : "";
  if (/^sha256-[a-f0-9]{64}$/.test(observedVersion || "")) {
    return observedVersion!;
  }
  return runtimeV2EvidenceVersion(await input.readExactFile());
}
