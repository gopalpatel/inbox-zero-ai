// src/state/sender-state-manager.ts
import * as fs from "node:fs/promises";
import type { SenderStateEntry, SenderStateFile } from "../schemas/sender-state.js";
import { SenderStateFileSchema } from "../schemas/sender-state.js";
import type { Result } from "../types.js";
import { atomicWriteFile } from "../utils.js";

export async function readSenderState(filePath: string): Promise<Result<SenderStateFile | null>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = SenderStateFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { ok: false, error: `Invalid sender state: ${parsed.error.message}` };
    return { ok: true, value: parsed.data };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, value: null };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function writeSenderState(filePath: string, state: SenderStateFile): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(state, null, 2));
}

/** Enrichment/review fields to carry forward from existing state */
const ENRICHMENT_FIELDS = [
  "senderType",
  "senderTypeConfidence",
  "senderTypeSource",
  "extractionCandidate",
  "reviewedSenderType",
  "reviewedAt",
  "processedAt",
] as const;

export function mergeSenderState(fresh: SenderStateEntry[], existing: SenderStateEntry[]): SenderStateEntry[] {
  const existingMap = new Map<string, SenderStateEntry>();
  for (const entry of existing) {
    existingMap.set(entry.senderEmail.toLowerCase(), entry);
  }

  return fresh.map((freshEntry) => {
    const prev = existingMap.get(freshEntry.senderEmail.toLowerCase());
    if (!prev) return freshEntry;

    // Start with fresh deterministic fields
    const merged: SenderStateEntry = { ...freshEntry };

    if (prev.senderTypeSource === "user") {
      merged.senderType = prev.reviewedSenderType ?? prev.senderType;
      merged.reviewedSenderType = prev.reviewedSenderType;
      merged.reviewedAt = prev.reviewedAt;
      merged.senderTypeSource = "user";
      merged.senderTypeConfidence = prev.senderTypeConfidence;
    } else if (prev.senderTypeSource === "llm" && freshEntry.senderTypeSource === "llm") {
      const prevConfidence = prev.senderTypeConfidence ?? 0;
      const freshConfidence = freshEntry.senderTypeConfidence ?? 0;

      if (prevConfidence >= freshConfidence) {
        merged.senderType = prev.senderType;
        merged.senderTypeConfidence = prev.senderTypeConfidence;
        merged.senderTypeSource = prev.senderTypeSource;
      }
    }

    // Carry forward enrichment/review fields from existing state
    for (const field of ENRICHMENT_FIELDS) {
      if (prev[field] !== undefined && prev[field] !== null) {
        // User-reviewed senderType was already handled by the early check above.
        if (field === "senderType" && prev.senderTypeSource === "user") {
          continue;
        }
        if (merged[field] === undefined) {
          (merged as Record<string, unknown>)[field] = prev[field];
        }
      }
    }

    return merged;
  });
  // Senders not in fresh are dropped (they disappeared from the current pull)
}
