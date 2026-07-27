import {
  readFile,
  writeFileAtomic,
  writeFileCreateNew,
} from "../../lib/ipc";
import { sha256Hex } from "../../lib/sha256";
import {
  normalizeRuntimeV2StudioReceipt,
  type RuntimeV2StudioReceiptPort,
  type RuntimeV2StudioReceiptV1,
} from "./studioAdapter";

export interface RuntimeV2StudioReceiptFileIo {
  readonly read: (path: string, workspace: string) => Promise<string | null>;
  readonly create: (
    path: string,
    content: string,
    workspace: string,
  ) => Promise<void>;
  readonly replace: (
    path: string,
    content: string,
    workspace: string,
  ) => Promise<void>;
}

const receiptQueues = new Map<string, Promise<void>>();

function receiptPath(receiptKey: string): string {
  return `.MAIN/game-studio/runtime-v2-receipts/${
    sha256Hex(receiptKey).slice(0, 40)
  }.json`;
}

function defaultIo(): RuntimeV2StudioReceiptFileIo {
  return {
    async read(path, workspace) {
      try {
        return await readFile(path, workspace);
      } catch {
        return null;
      }
    },
    create: (path, content, workspace) =>
      writeFileCreateNew(path, content, workspace),
    replace: (path, content, workspace) =>
      writeFileAtomic(path, content, workspace),
  };
}

async function serialized<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = receiptQueues.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current, () => current);
  receiptQueues.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (receiptQueues.get(key) === tail) receiptQueues.delete(key);
  }
}

function serialize(receipt: RuntimeV2StudioReceiptV1): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

async function readReceipt(input: {
  readonly io: RuntimeV2StudioReceiptFileIo;
  readonly workspace: string;
  readonly receiptKey: string;
}): Promise<RuntimeV2StudioReceiptV1 | null> {
  const source = await input.io.read(
    receiptPath(input.receiptKey),
    input.workspace,
  );
  if (source == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("RUNTIME_V2_STUDIO_RECEIPT_CORRUPT");
  }
  const receipt = normalizeRuntimeV2StudioReceipt(parsed);
  if (!receipt || receipt.receiptKey !== input.receiptKey) {
    throw new Error("RUNTIME_V2_STUDIO_RECEIPT_CORRUPT_OR_FOREIGN");
  }
  return receipt;
}

export function createRuntimeV2StudioReceiptFilePort(input: {
  readonly workspace: string;
  readonly io?: RuntimeV2StudioReceiptFileIo;
}): RuntimeV2StudioReceiptPort {
  const workspace = String(input.workspace || "").trim();
  if (!workspace) throw new Error("RUNTIME_V2_STUDIO_WORKSPACE_REQUIRED");
  const io = input.io || defaultIo();
  return {
    load({ receiptKey }) {
      return readReceipt({ io, workspace, receiptKey });
    },

    claim({ receipt }) {
      return serialized(`${workspace}\u0000${receipt.receiptKey}`, async () => {
        const existing = await readReceipt({
          io,
          workspace,
          receiptKey: receipt.receiptKey,
        });
        if (existing) {
          return { disposition: "existing" as const, receipt: existing };
        }
        try {
          await io.create(
            receiptPath(receipt.receiptKey),
            serialize(receipt),
            workspace,
          );
          return { disposition: "claimed" as const, receipt };
        } catch (error) {
          const raced = await readReceipt({
            io,
            workspace,
            receiptKey: receipt.receiptKey,
          });
          if (!raced) throw error;
          return { disposition: "existing" as const, receipt: raced };
        }
      });
    },

    settle({ receiptKey, expectedRevision, receipt }) {
      return serialized(`${workspace}\u0000${receiptKey}`, async () => {
        const current = await readReceipt({ io, workspace, receiptKey });
        if (!current) {
          return { disposition: "conflict" as const, receipt: current };
        }
        if (JSON.stringify(current) === JSON.stringify(receipt)) {
          return { disposition: "idempotent" as const, receipt: current };
        }
        if (current.revision !== expectedRevision) {
          return { disposition: "conflict" as const, receipt: current };
        }
        if (
          receipt.receiptKey !== receiptKey ||
          receipt.revision !== expectedRevision + 1 ||
          !normalizeRuntimeV2StudioReceipt(receipt)
        ) {
          return { disposition: "conflict" as const, receipt: current };
        }
        await io.replace(
          receiptPath(receiptKey),
          serialize(receipt),
          workspace,
        );
        return { disposition: "committed" as const, receipt };
      });
    },
  };
}

export function resolveRuntimeV2StudioReceiptFilePath(
  receiptKey: string,
): string {
  return receiptPath(receiptKey);
}
