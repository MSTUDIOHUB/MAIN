export interface WorkspaceInstructionProjectionLease {
  readonly generation: number;
  readonly workspace: string;
}

export interface WorkspaceInstructionProjectionOwner {
  claim: (workspace: string) => WorkspaceInstructionProjectionLease;
  invalidate: () => void;
  canCommit: (
    lease: WorkspaceInstructionProjectionLease | null,
    currentWorkspace: string,
  ) => boolean;
}

/**
 * Owns only the live UI projection of workspace instructions.
 *
 * A Turn keeps the snapshot returned by its own immutable workspace load and
 * never needs this lease. The lease exists solely to prevent an older async UI
 * refresh from overwriting the workspace selected after that refresh began.
 */
export function createWorkspaceInstructionProjectionOwner():
  WorkspaceInstructionProjectionOwner {
  let generation = 0;
  let active: WorkspaceInstructionProjectionLease | null = null;

  return {
    claim: (workspace) => {
      generation += 1;
      active = Object.freeze({
        generation,
        workspace: String(workspace || "").trim(),
      });
      return active;
    },
    invalidate: () => {
      generation += 1;
      active = null;
    },
    canCommit: (lease, currentWorkspace) =>
      lease !== null &&
      active !== null &&
      lease.generation === active.generation &&
      lease.workspace === active.workspace &&
      String(currentWorkspace || "").trim() === lease.workspace,
  };
}
