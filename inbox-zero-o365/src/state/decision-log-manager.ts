/**
 * Decision log manager — reads, appends, and extracts few-shot context from the
 * persisted decision log that records every user review action.
 */

import * as fs from "node:fs/promises";
import type { FewShotExample } from "../enrichment/llm-sender-classifier.js";
import type { DecisionEntry, DecisionLog } from "../schemas/decision-log.js";
import { DecisionLogSchema } from "../schemas/decision-log.js";
import type { Result } from "../types.js";
import { atomicWriteFile, toErrorMessage } from "../utils.js";

// ---------------------------------------------------------------------------
// readDecisionLog
// ---------------------------------------------------------------------------

/**
 * Reads and validates the decision log at `filePath`.
 *
 * - Returns `{ ok: true, value: null }` when the file does not exist (ENOENT).
 * - Returns `{ ok: false, error }` when the file is corrupt or fails validation.
 * - Returns `{ ok: true, value: DecisionLog }` on success.
 */
export async function readDecisionLog(filePath: string): Promise<Result<DecisionLog | null>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (isEnoent(err)) {
      return { ok: true, value: null };
    }
    return { ok: false, error: toErrorMessage(err) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `JSON parse error: ${toErrorMessage(err)}` };
  }

  const result = DecisionLogSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: `Validation error: ${result.error.message}` };
  }

  return { ok: true, value: result.data };
}

// ---------------------------------------------------------------------------
// appendDecisions
// ---------------------------------------------------------------------------

/**
 * Upserts `entries` into the decision log at `filePath`.
 *
 * If the file does not exist it is created. Writes are atomic via a
 * temp-file + rename strategy to prevent partial writes from corrupting data.
 *
 * @throws When the existing file is corrupt/invalid (cannot safely append).
 */
export async function appendDecisions(filePath: string, entries: DecisionEntry[]): Promise<void> {
  const existing = await readDecisionLog(filePath);

  if (!existing.ok) {
    throw new Error(`Cannot append to decision log — file is corrupt: ${existing.error}`);
  }

  const current: DecisionLog = existing.value ?? { version: 1, decisions: [] };

  const mergedDecisions = [...current.decisions];
  const existingIndexes = new Map<string, number>();
  for (const [index, decision] of mergedDecisions.entries()) {
    existingIndexes.set(decisionEntryKey(decision), index);
  }

  for (const entry of entries) {
    const key = decisionEntryKey(entry);
    const existingIndex = existingIndexes.get(key);
    if (existingIndex === undefined) {
      existingIndexes.set(key, mergedDecisions.length);
      mergedDecisions.push(entry);
    } else {
      mergedDecisions[existingIndex] = entry;
    }
  }

  const updated: DecisionLog = {
    version: 1,
    decisions: mergedDecisions,
  };

  const parsed = DecisionLogSchema.safeParse(updated);
  if (!parsed.success) {
    throw new Error(`Cannot append invalid decision log: ${parsed.error.message}`);
  }

  await atomicWriteFile(filePath, JSON.stringify(parsed.data, null, 2));
}

// ---------------------------------------------------------------------------
// extractFewShotContext
// ---------------------------------------------------------------------------

/**
 * Extracts few-shot examples from a list of decision entries for use in LLM
 * classification prompts.
 *
 * Rules:
 * - Only includes entries where `senderTypeFeedback !== "none"`.
 * - Prioritises `"corrected"` entries over `"confirmed"` entries.
 * - Limits output to `maxExamples` total entries.
 * - For corrected entries, `senderType` is the `reviewedSenderType` (what the
 *   user corrected to). For confirmed entries, `senderType` is the
 *   `presentedSenderType` (what was shown and agreed with).
 * - Malformed corrected entries without `reviewedSenderType` are ignored.
 */
export function extractFewShotContext(decisions: DecisionEntry[], maxExamples: number): FewShotExample[] {
  if (maxExamples <= 0) {
    throw new RangeError("maxExamples must be greater than 0");
  }

  const corrected = decisions.filter(
    (
      d,
    ): d is DecisionEntry & {
      senderTypeFeedback: "corrected";
      reviewedSenderType: NonNullable<DecisionEntry["reviewedSenderType"]>;
    } => d.senderTypeFeedback === "corrected" && d.reviewedSenderType != null,
  );
  const confirmed = decisions.filter(
    (d): d is DecisionEntry & { senderTypeFeedback: "confirmed" } => d.senderTypeFeedback === "confirmed",
  );

  // Fill slots: corrected first, then confirmed up to the limit.
  const selected = [...corrected, ...confirmed].slice(0, maxExamples);

  return selected.map((d): FewShotExample => {
    if (d.senderTypeFeedback === "corrected") {
      return {
        email: d.senderEmail,
        senderType: d.reviewedSenderType,
        context: "corrected",
      };
    }

    return {
      email: d.senderEmail,
      senderType: d.presentedSenderType,
      context: "confirmed",
    };
  });
}

// ---------------------------------------------------------------------------
// latestDecisionsBySender
// ---------------------------------------------------------------------------

/**
 * Reduce the decision log to the latest decision per sender.
 *
 * When a sender appears multiple times (across different batches or review
 * sessions), only the entry with the latest `timestamp` is kept.
 */
export function latestDecisionsBySender(decisions: DecisionEntry[]): Map<string, DecisionEntry> {
  const map = new Map<string, DecisionEntry>();

  for (const entry of decisions) {
    const key = entry.senderEmail.trim().toLowerCase();
    const existing = map.get(key);
    if (existing === undefined || entry.timestamp > existing.timestamp) {
      map.set(key, entry);
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// NOISE_DECISIONS
// ---------------------------------------------------------------------------

/** User decisions that indicate noise (used by sweep and filter consolidation). */
export const NOISE_DECISIONS: ReadonlySet<string> = new Set(["filter", "unsubscribe"]);

// ---------------------------------------------------------------------------
// collectNoiseSenders
// ---------------------------------------------------------------------------

/** Noise senders partitioned by decision type (filter vs unsubscribe). */
export interface NoiseSenders {
  filterSenders: string[];
  unsubscribeSenders: string[];
  allNoiseSenders: string[];
}

/**
 * Reads the decision log and collects senders whose latest decision
 * is "filter" or "unsubscribe".
 */
export async function collectNoiseSenders(decisionLogPath: string): Promise<Result<NoiseSenders | null>> {
  const logResult = await readDecisionLog(decisionLogPath);
  if (!logResult.ok) {
    return { ok: false, error: logResult.error };
  }

  const decisionLog = logResult.value;
  if (decisionLog === null || decisionLog.decisions.length === 0) {
    return { ok: true, value: null };
  }

  const latest = latestDecisionsBySender(decisionLog.decisions);

  const filterSenders: string[] = [];
  const unsubscribeSenders: string[] = [];

  for (const [email, entry] of latest) {
    if (entry.userDecision === "filter") {
      filterSenders.push(email);
    } else if (entry.userDecision === "unsubscribe") {
      unsubscribeSenders.push(email);
    }
  }

  filterSenders.sort();
  unsubscribeSenders.sort();
  const allNoiseSenders = [...filterSenders, ...unsubscribeSenders];

  return { ok: true, value: { filterSenders, unsubscribeSenders, allNoiseSenders } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function decisionEntryKey(entry: DecisionEntry): string {
  return `${entry.runId}::${entry.batchId}::${entry.senderEmail.trim().toLowerCase()}`;
}
