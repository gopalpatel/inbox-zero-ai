/**
 * FilterCreator — creates Gmail filters for noise senders.
 *
 * For each noise sender (decision = "filter" or "unsubscribe"):
 * - Creates a Gmail filter that matches emails from that sender.
 * - Applies the `_noise` label and removes from INBOX.
 * - For "unsubscribe" senders, also marks as read (removes UNREAD label).
 *
 * Design decisions:
 * - `ensureNoiseLabel()` is idempotent: creates only if not present.
 * - `batchCreateFilters()` supports dry-run mode for previewing changes.
 * - Partial failures are captured per-sender; all senders are attempted.
 */

import type { gmail_v1 } from "googleapis";
import type { GmailClient } from "../auth/gmail-client.js";
import type { Result } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The Gmail label name used to tag noise emails. */
export const NOISE_LABEL_NAME = "_noise";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BatchCreateFiltersOptions {
  /** When true, logs what would be created without calling the Gmail API. */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

export interface BatchCreateFiltersResult {
  /** Number of filters successfully created. */
  created: number;
  /** Per-sender failures. */
  failures: Array<{ sender: string; error: string }>;
}

// ---------------------------------------------------------------------------
// findNoiseLabelId
// ---------------------------------------------------------------------------

/**
 * Looks up the existing `_noise` label without creating it.
 *
 * Used by dry-run flows that need the real label ID for accurate reporting
 * but must not mutate Gmail state.
 */
export async function findNoiseLabelId(client: GmailClient): Promise<Result<string | null>> {
  const listResult = await client.listLabels();

  if (!listResult.ok) {
    return { ok: false, error: listResult.error };
  }

  const existing = listResult.value.find((label) => label.name === NOISE_LABEL_NAME && typeof label.id === "string");
  return { ok: true, value: existing?.id ?? null };
}

// ---------------------------------------------------------------------------
// ensureNoiseLabel
// ---------------------------------------------------------------------------

/**
 * Ensures the `_noise` label exists, creating it if needed.
 *
 * @returns `Result<labelId>` — the ID of the `_noise` label.
 */
export async function ensureNoiseLabel(client: GmailClient): Promise<Result<string>> {
  const existingResult = await findNoiseLabelId(client);
  if (!existingResult.ok) {
    return existingResult;
  }

  if (existingResult.value !== null) {
    return { ok: true, value: existingResult.value };
  }

  // Create the label.
  const createResult = await client.createLabel(NOISE_LABEL_NAME);

  if (!createResult.ok) {
    return { ok: false, error: createResult.error };
  }

  const labelId = createResult.value.id ?? "";
  return { ok: true, value: labelId };
}

// ---------------------------------------------------------------------------
// createNoiseFilter
// ---------------------------------------------------------------------------

/**
 * Creates a single Gmail filter for a noise sender.
 *
 * @param client - Authenticated GmailClient.
 * @param sender - The sender email address to filter.
 * @param decision - "filter" (skip inbox + label) or "unsubscribe" (also mark read).
 * @param noiseLabelId - The ID of the `_noise` label.
 */
export async function createNoiseFilter(
  client: GmailClient,
  sender: string,
  decision: "filter" | "unsubscribe",
  noiseLabelId: string,
): Promise<Result<gmail_v1.Schema$Filter>> {
  const removeLabelIds = ["INBOX"];

  if (decision === "unsubscribe") {
    removeLabelIds.push("UNREAD");
  }

  return client.createFilter({ from: sender }, { addLabelIds: [noiseLabelId], removeLabelIds });
}

// ---------------------------------------------------------------------------
// batchCreateFilters
// ---------------------------------------------------------------------------

/**
 * Creates Gmail filters for a batch of noise senders.
 *
 * Processes all senders with "filter" or "unsubscribe" decisions.
 * Partial failures are captured and returned; processing continues for
 * remaining senders even when one fails.
 *
 * @param client - Authenticated GmailClient.
 * @param senders - Map of senderEmail → decision ("filter" | "unsubscribe").
 * @param options - Optional configuration (dryRun).
 * @returns Summary of created filters and per-sender failures.
 */
export async function batchCreateFilters(
  client: GmailClient,
  senders: Map<string, "filter" | "unsubscribe">,
  options: BatchCreateFiltersOptions = {},
): Promise<BatchCreateFiltersResult> {
  const failures: Array<{ sender: string; error: string }> = [];
  let created = 0;

  if (senders.size === 0) {
    return { created, failures };
  }

  if (options.dryRun) {
    for (const [sender, decision] of senders) {
      console.log(`[dry-run] Would create filter for ${sender} (decision: ${decision})`);
    }
    return { created: 0, failures: [] };
  }

  // Ensure the _noise label exists before creating any filters.
  const labelResult = await ensureNoiseLabel(client);

  if (!labelResult.ok) {
    // Record a single failure indicating the label could not be created.
    for (const [sender] of senders) {
      failures.push({
        sender,
        error: `Failed to ensure _noise label: ${labelResult.error}`,
      });
    }
    return { created: 0, failures };
  }

  const noiseLabelId = labelResult.value;

  for (const [sender, decision] of senders) {
    const filterResult = await createNoiseFilter(client, sender, decision, noiseLabelId);

    if (!filterResult.ok) {
      failures.push({ sender, error: filterResult.error });
    } else {
      created++;
    }
  }

  return { created, failures };
}
