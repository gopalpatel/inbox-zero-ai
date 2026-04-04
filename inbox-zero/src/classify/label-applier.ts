/**
 * label-applier.ts
 *
 * Creates Gmail labels for each category in the approved taxonomy and
 * batch-applies them to classified threads.
 *
 * Design decisions:
 * - `ensureLabelsExist` checks existing labels first to avoid duplicates.
 * - `applyClassifications` groups messages by action (archive vs triage) and
 *   calls `batchModifyMessages` in chunks of 1000 (Gmail API limit).
 * - Non-actionable threads: add category label, remove INBOX (archived).
 * - Actionable threads: add category label + `_triage`, keep INBOX.
 * - Batch failures are collected across all remaining batches and surfaced as
 *   a final error so callers never mistake a partial apply for success.
 */

import type { GmailClient } from "../auth/gmail-client.js";
import type { ThreadClassification } from "../schemas/classification.js";
import type { Result } from "../types.js";
import { chunkArray } from "../utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Operational label applied to actionable threads awaiting review. */
export const TRIAGE_LABEL = "_triage";

/** Operational label marking threads that have had data extracted. */
export const EXTRACTED_LABEL = "_extracted";

/** Gmail API limit for IDs per batchModify call. */
const BATCH_SIZE = 1000;

/** System labels that are always ensured, regardless of category list. */
const OPERATIONAL_LABELS = [TRIAGE_LABEL, EXTRACTED_LABEL] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApplySummary {
  /** Total message-level modifications applied successfully. */
  totalApplied: number;
  /** Total messages archived (INBOX removed). */
  totalArchived: number;
  /** Total messages moved to triage (kept in INBOX, _triage added). */
  totalTriaged: number;
  /** Error messages from failed batches. */
  failures: string[];
}

export interface ApplyOptions {
  /** When true, compute the summary but do not call the Gmail API. */
  dryRun?: boolean;
  /** Called after each batch with cumulative progress. */
  onProgress?: (progress: { applied: number; total: number }) => void;
}

// ---------------------------------------------------------------------------
// ensureLabelsExist
// ---------------------------------------------------------------------------

/**
 * Ensures all provided category names and operational labels exist in Gmail.
 * Skips any label that already exists (by name). Returns a Map<name, id>.
 */
export async function ensureLabelsExist(
  categories: string[],
  client: GmailClient,
): Promise<Result<Map<string, string>>> {
  // 1. Fetch all existing labels
  const listResult = await client.listLabels();
  if (!listResult.ok) {
    return { ok: false, error: listResult.error };
  }

  const existingLabels = listResult.value;
  const labelMap = new Map<string, string>();

  // Seed map with already-existing labels
  for (const label of existingLabels) {
    if (label.name !== undefined && label.name !== null && label.id !== undefined && label.id !== null) {
      labelMap.set(label.name, label.id);
    }
  }

  // Deduplicate requested labels
  const uniqueCategories = [...new Set(categories)];
  const allRequired = [...uniqueCategories, ...OPERATIONAL_LABELS];

  // 2. Create labels that are missing
  for (const name of allRequired) {
    if (labelMap.has(name)) continue;

    const createResult = await client.createLabel(name);
    if (!createResult.ok) {
      return { ok: false, error: createResult.error };
    }

    const created = createResult.value;
    if (created.id === undefined || created.id === null) {
      return { ok: false, error: `Created label "${name}" is missing an id` };
    }
    labelMap.set(name, created.id);
  }

  return { ok: true, value: labelMap };
}

// ---------------------------------------------------------------------------
// applyClassifications
// ---------------------------------------------------------------------------

/**
 * Batch-applies Gmail labels to classified threads.
 *
 * @param classifications - The classification results to apply.
 * @param threads - Map of threadId → array of message IDs.
 * @param labelMap - Map of label name → Gmail label ID.
 * @param client - Authenticated GmailClient.
 * @param options - Optional dryRun and progress callback.
 */
export async function applyClassifications(
  classifications: ThreadClassification[],
  threads: Map<string, string[]>,
  labelMap: Map<string, string>,
  client: GmailClient,
  options: ApplyOptions = {},
): Promise<Result<ApplySummary>> {
  const { dryRun = false, onProgress } = options;

  const triageLabelId = labelMap.get(TRIAGE_LABEL);

  // ---------------------------------------------------------------------------
  // Build batches: group by (categoryLabelId, action) to minimize API calls
  // ---------------------------------------------------------------------------

  interface BatchDescriptor {
    ids: string[];
    addLabelIds: string[];
    removeLabelIds: string[];
    action: "archive" | "triage";
  }

  const archiveIds: Map<string, string[]> = new Map(); // key = categoryLabelId
  const triageIds: Map<string, string[]> = new Map(); // key = categoryLabelId
  const earlyFailures: string[] = [];

  let totalMessages = 0;

  for (const classification of classifications) {
    const messageIds = threads.get(classification.threadId);
    if (messageIds === undefined || messageIds.length === 0) {
      earlyFailures.push(`No message IDs found for thread "${classification.threadId}"`);
      continue;
    }

    const categoryLabelId = labelMap.get(classification.category);
    if (categoryLabelId === undefined) {
      earlyFailures.push(
        `No label ID found for category "${classification.category}" (thread ${classification.threadId})`,
      );
      continue;
    }

    totalMessages += messageIds.length;

    if (classification.actionable) {
      const existing = triageIds.get(categoryLabelId) ?? [];
      existing.push(...messageIds);
      triageIds.set(categoryLabelId, existing);
    } else {
      const existing = archiveIds.get(categoryLabelId) ?? [];
      existing.push(...messageIds);
      archiveIds.set(categoryLabelId, existing);
    }
  }

  // ---------------------------------------------------------------------------
  // Flatten into BatchDescriptor list
  // ---------------------------------------------------------------------------

  const batches: BatchDescriptor[] = [];

  for (const [categoryLabelId, ids] of archiveIds) {
    const chunks = chunkArray(ids, BATCH_SIZE);
    for (const chunk of chunks) {
      batches.push({
        ids: chunk,
        addLabelIds: [categoryLabelId],
        removeLabelIds: ["INBOX"],
        action: "archive",
      });
    }
  }

  for (const [categoryLabelId, ids] of triageIds) {
    const addLabels = triageLabelId !== undefined ? [categoryLabelId, triageLabelId] : [categoryLabelId];
    const chunks = chunkArray(ids, BATCH_SIZE);
    for (const chunk of chunks) {
      batches.push({
        ids: chunk,
        addLabelIds: addLabels,
        removeLabelIds: [],
        action: "triage",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Dry-run: return summary without API calls
  // ---------------------------------------------------------------------------

  const summary: ApplySummary = {
    totalApplied: 0,
    totalArchived: 0,
    totalTriaged: 0,
    failures: [...earlyFailures],
  };

  if (dryRun) {
    // Compute totals from the planned batches
    for (const batch of batches) {
      const count = batch.ids.length;
      summary.totalApplied += count;
      if (batch.action === "archive") {
        summary.totalArchived += count;
      } else {
        summary.totalTriaged += count;
      }
    }
    onProgress?.({ applied: summary.totalApplied, total: totalMessages });
    if (summary.failures.length > 0) {
      return { ok: false, error: formatApplyFailures(summary.failures) };
    }
    return { ok: true, value: summary };
  }

  // ---------------------------------------------------------------------------
  // Execute batches
  // ---------------------------------------------------------------------------

  let applied = 0;

  for (const batch of batches) {
    const removeLabelIds = batch.removeLabelIds.length > 0 ? batch.removeLabelIds : undefined;

    const modifyResult = await client.batchModifyMessages(batch.ids, batch.addLabelIds, removeLabelIds);

    if (!modifyResult.ok) {
      summary.failures.push(modifyResult.error);
      // Continue collecting failures so the caller receives the full problem set.
      continue;
    }

    const count = batch.ids.length;
    applied += count;
    summary.totalApplied += count;

    if (batch.action === "archive") {
      summary.totalArchived += count;
    } else {
      summary.totalTriaged += count;
    }

    onProgress?.({ applied, total: totalMessages });
  }

  if (summary.failures.length > 0) {
    return { ok: false, error: formatApplyFailures(summary.failures) };
  }

  return { ok: true, value: summary };
}

function formatApplyFailures(failures: string[]): string {
  const failureCount = failures.length;
  const failureList = failures.join("; ");
  return `Failed to apply classifications (${failureCount} issue${failureCount === 1 ? "" : "s"}): ${failureList}`;
}
