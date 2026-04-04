/**
 * execute-batch.ts
 *
 * Resumable execute-batch pipeline: processes a frozen batch manifest,
 * executing each step (filter → archive → log → state → sheet) for each
 * sender with pending work. After each step the manifest is updated
 * atomically so the pipeline can be safely resumed after any failure.
 *
 * Design decisions:
 * - Each step is idempotent: already-done or already-skipped steps are not
 *   re-executed on resume.
 * - Filter creation is idempotent: listFilters is called first; createFilter
 *   is skipped if a matching from: filter already exists.
 * - For "keep" decisions, filterStatus and archiveStatus are set to "skipped";
 *   logStatus, stateStatus, and sheetStatus are still executed.
 * - When reviewedSenderType is set on the manifest sender, it is persisted
 *   back to sender-state with senderTypeSource: "user".
 * - The _noise label is ensured to exist once per batch, then reused.
 * - All public functions return Result<T> — never throw.
 */

import type { gmail_v1 } from "googleapis";
import { AUDIT_HEADER_ROW } from "../analysis/sheets-reporter.js";
import type { GmailClient } from "../auth/gmail-client.js";
import type { SheetsClient } from "../auth/sheets-client.js";
import { ensureNoiseLabel } from "../noise/filter-creator.js";
import type { DecisionEntry } from "../schemas/decision-log.js";
import type { SenderStateEntry } from "../schemas/sender-state.js";
import { advanceSenderStep, completeManifest, readManifest } from "../state/batch-manifest-manager.js";
import { appendDecisions, readDecisionLog } from "../state/decision-log-manager.js";
import { readSenderState, writeSenderState } from "../state/sender-state-manager.js";
import type { Result } from "../types.js";
import { atomicWriteFile, chunkArray, toErrorMessage } from "../utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Gmail batchModify hard limit. */
const BATCH_MODIFY_CHUNK_SIZE = 1_000;

/** Safety cap on pages of messages to fetch per sender (prevents runaway loops). */
const MAX_PAGES_PER_SENDER = 200;

const SENDER_EMAIL_COL = AUDIT_HEADER_ROW.indexOf("Sender email");
const YOUR_DECISION_COL = AUDIT_HEADER_ROW.indexOf("Your decision");
const SENDER_TYPE_COL = AUDIT_HEADER_ROW.indexOf("Sender type");
const PROCESSED_COL = AUDIT_HEADER_ROW.indexOf("Processed");

if (SENDER_EMAIL_COL < 0 || YOUR_DECISION_COL < 0 || SENDER_TYPE_COL < 0 || PROCESSED_COL < 0) {
  throw new Error("Audit header row is missing required execute-batch columns");
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExecuteBatchOptions {
  manifestPath: string;
  sheetId: string;
  gmailClient: GmailClient;
  sheetsClient: SheetsClient;
  senderStatePath: string;
  decisionLogPath: string;
  onProgress?: (info: { sender: string; step: string; status: string }) => void;
  /** When true (the default), skip per-sender Gmail filter creation. */
  skipFilterCreation?: boolean;
}

export interface ExecuteBatchResult {
  filtersCreated: number;
  messagesArchived: number;
  sendersProcessed: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Checks whether an equivalent from: filter already exists in Gmail for the
 * given sender email. Comparison is case-insensitive.
 */
function hasExistingFilter(
  filters: Array<{ criteria?: { from?: string | null } | null }>,
  senderEmail: string,
): boolean {
  const lower = senderEmail.toLowerCase();
  for (const f of filters) {
    const from = f.criteria?.from;
    if (typeof from === "string" && from.toLowerCase() === lower) {
      return true;
    }
  }
  return false;
}

/**
 * Paginates through all messages from a sender and returns all message IDs.
 * Bounded by MAX_PAGES_PER_SENDER to prevent infinite loops.
 */
async function collectMessageIds(client: GmailClient, senderEmail: string): Promise<Result<string[]>> {
  const allIds: string[] = [];
  let pageToken: string | undefined;
  let pageCount = 0;

  do {
    pageCount++;
    const listResult = await client.listMessages(`from:${senderEmail} in:inbox`, pageToken);
    if (!listResult.ok) {
      return { ok: false, error: listResult.error };
    }
    for (const m of listResult.value.messages) {
      allIds.push(m.id);
    }
    pageToken = listResult.value.nextPageToken;
  } while (pageToken !== undefined && pageCount < MAX_PAGES_PER_SENDER);

  if (pageToken !== undefined) {
    return {
      ok: false,
      error: `Exceeded MAX_PAGES_PER_SENDER (${MAX_PAGES_PER_SENDER}) while collecting messages for ${senderEmail}`,
    };
  }

  return { ok: true, value: allIds };
}

/**
 * Atomically updates the messagesArchived count for a sender entry in the
 * manifest. Reads the manifest, patches the entry, and writes back.
 */
async function updateMessagesArchived(manifestPath: string, senderEmail: string, count: number): Promise<void> {
  const readResult = await readManifest(manifestPath);
  if (!readResult.ok) {
    throw new Error(`updateMessagesArchived: failed to read manifest — ${readResult.error}`);
  }

  const manifest = readResult.value;
  const lower = senderEmail.toLowerCase();
  const updatedSenders = manifest.senders.map((s) => {
    if (s.senderEmail.toLowerCase() !== lower) return s;
    return { ...s, messagesArchived: count };
  });

  await atomicWriteFile(manifestPath, JSON.stringify({ ...manifest, senders: updatedSenders }, null, 2));
}

async function updateFilterApplied(manifestPath: string, senderEmail: string, filterApplied: boolean): Promise<void> {
  const readResult = await readManifest(manifestPath);
  if (!readResult.ok) {
    throw new Error(`updateFilterApplied: failed to read manifest — ${readResult.error}`);
  }

  const manifest = readResult.value;
  const lower = senderEmail.toLowerCase();
  const updatedSenders = manifest.senders.map((s) => {
    if (s.senderEmail.toLowerCase() !== lower) return s;
    return { ...s, filterApplied };
  });

  await atomicWriteFile(manifestPath, JSON.stringify({ ...manifest, senders: updatedSenders }, null, 2));
}

async function safeResultCall<T>(label: string, fn: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await fn();
  } catch (err: unknown) {
    return { ok: false, error: `${label} threw: ${toErrorMessage(err)}` };
  }
}

async function safeVoidCall(label: string, fn: () => Promise<void>): Promise<Result<void>> {
  try {
    await fn();
    return { ok: true, value: undefined };
  } catch (err: unknown) {
    return { ok: false, error: `${label} threw: ${toErrorMessage(err)}` };
  }
}

function emitProgress(
  onProgress: ExecuteBatchOptions["onProgress"],
  info: { sender: string; step: string; status: string },
): Result<void> {
  try {
    onProgress?.(info);
    return { ok: true, value: undefined };
  } catch (err: unknown) {
    return { ok: false, error: `onProgress threw: ${toErrorMessage(err)}` };
  }
}

function upsertAuditRow(
  existingRow: unknown[],
  values: { senderType: string; userDecision: string; processed: string },
): unknown[] {
  const updatedRow = [...existingRow];
  while (updatedRow.length < AUDIT_HEADER_ROW.length) {
    updatedRow.push("");
  }

  updatedRow[YOUR_DECISION_COL] = values.userDecision;
  updatedRow[SENDER_TYPE_COL] = values.senderType;
  updatedRow[PROCESSED_COL] = values.processed;
  return updatedRow;
}

function buildDashboardRows(
  totalSenders: number,
  decisionEntries: DecisionEntry[],
  runId: string,
  currentSection: string,
): unknown[][] {
  const latestBySender = new Map<string, DecisionEntry>();

  for (const entry of decisionEntries) {
    if (entry.runId !== runId) continue;
    latestBySender.set(entry.senderEmail.toLowerCase(), entry);
  }

  const processedEntries = Array.from(latestBySender.values());
  const processed = processedEntries.length;
  const emailsCleared = processedEntries.reduce((sum, entry) => sum + entry.messagesArchived, 0);
  const unsubscribed = processedEntries.filter((entry) => entry.userDecision === "unsubscribe").length;
  const filtersCreated = processedEntries.filter((entry) => entry.actionsTaken.includes("filter")).length;
  const remaining = Math.max(totalSenders - processed, 0);

  return [
    ["Total senders", totalSenders],
    ["Processed", processed],
    ["Emails cleared", emailsCleared],
    ["Unsubscribed", unsubscribed],
    ["Senders filtered", filtersCreated],
    ["Remaining", remaining],
    ["Current section", currentSection],
  ];
}

// ---------------------------------------------------------------------------
// executeBatch
// ---------------------------------------------------------------------------

/**
 * Processes a frozen batch manifest end-to-end:
 * for each sender with pending steps, executes filter → archive → log →
 * state → sheet in order, persisting manifest state after each step.
 * After all senders are done, marks the manifest as completed.
 */
export async function executeBatch(options: ExecuteBatchOptions): Promise<Result<ExecuteBatchResult>> {
  const { manifestPath, sheetId, gmailClient, sheetsClient, senderStatePath, decisionLogPath, onProgress } = options;
  const skipFilterCreation = options.skipFilterCreation ?? true;

  // -------------------------------------------------------------------------
  // 1. Read manifest
  // -------------------------------------------------------------------------
  const manifestResult = await readManifest(manifestPath);
  if (!manifestResult.ok) {
    return { ok: false, error: `Failed to read manifest: ${manifestResult.error}` };
  }
  const manifest = manifestResult.value;

  // -------------------------------------------------------------------------
  // 2. Ensure _noise label exists (needed for filter + archive steps)
  // -------------------------------------------------------------------------
  const noiseLabelResult = await safeResultCall("ensureNoiseLabel", () => ensureNoiseLabel(gmailClient));
  if (!noiseLabelResult.ok) {
    return { ok: false, error: `Failed to ensure _noise label: ${noiseLabelResult.error}` };
  }
  const noiseLabelId = noiseLabelResult.value;

  // -------------------------------------------------------------------------
  // 3. List existing filters once (for idempotent filter creation)
  // -------------------------------------------------------------------------
  let existingFilters: gmail_v1.Schema$Filter[] = [];
  const needsExistingFilterLookup =
    !skipFilterCreation ||
    manifest.senders.some(
      (s) => s.userDecision !== "keep" && s.logStatus === "pending" && s.filterStatus === "done" && s.filterApplied === undefined,
    );

  if (needsExistingFilterLookup) {
    const filtersResult = await safeResultCall("listFilters", () => gmailClient.listFilters());
    if (!filtersResult.ok) {
      return { ok: false, error: `Failed to list Gmail filters: ${filtersResult.error}` };
    }
    existingFilters = filtersResult.value;
  }

  // -------------------------------------------------------------------------
  // 4. Pre-read audit sheet + decision log (avoids re-reading per sender)
  // -------------------------------------------------------------------------
  const needsSheetUpdate = manifest.senders.some((s) => s.sheetStatus === "pending");

  /** Map from lowercase sender email to 1-based sheet row number. */
  const sheetRowMap = new Map<string, number>();
  /**
   * Cached original audit rows keyed by 1-based row number.
   * Do not replace these with blank templates during updates:
   * column A is the sender key, and wiping the rest destroys audit context
   * and makes resume/re-runs unable to find the row again.
   */
  const sheetRowCache = new Map<number, unknown[]>();
  /** Total non-empty data rows in the audit sheet (for dashboard metrics). */
  let sheetTotalSenders = 0;

  if (needsSheetUpdate) {
    const readRowsResult = await safeResultCall("sheets.readRows", () => sheetsClient.readRows(sheetId, "Sheet1!A:P"));
    if (!readRowsResult.ok) {
      return { ok: false, error: `Failed to read audit sheet: ${readRowsResult.error}` };
    }
    const rows = readRowsResult.value;
    if (rows.length === 0) {
      return { ok: false, error: `Audit sheet ${sheetId} is empty` };
    }

    for (let i = 1; i < rows.length; i++) {
      const cellValue = String(rows[i]![SENDER_EMAIL_COL] ?? "")
        .trim()
        .toLowerCase();
      if (cellValue !== "") {
        sheetRowMap.set(cellValue, i + 1); // 1-based row number (header is row 1)
        sheetRowCache.set(i + 1, [...rows[i]!]);
        sheetTotalSenders++;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. Process each sender
  // -------------------------------------------------------------------------
  let filtersCreated = 0;
  let totalMessagesArchived = 0;
  let sendersProcessed = 0;

  for (const sender of manifest.senders) {
    const isKeep = sender.userDecision === "keep";
    const email = sender.senderEmail;
    let currentMessagesArchived = sender.messagesArchived;
    /**
     * Persisted outcome of the filter step.
     * Falls back to live Gmail state for legacy manifests that predate filterApplied.
     */
    let filterApplied =
      sender.filterApplied ??
      (sender.filterStatus === "done" && !isKeep ? hasExistingFilter(existingFilters, email) : false);

    // -----------------------------------------------------------------------
    // Step a: filterStatus
    // -----------------------------------------------------------------------
    if (sender.filterStatus === "pending") {
      if (isKeep || skipFilterCreation) {
        filterApplied = false;
        const updateFilterResult = await safeVoidCall("updateFilterApplied", () =>
          updateFilterApplied(manifestPath, email, filterApplied),
        );
        if (!updateFilterResult.ok) {
          return { ok: false, error: `Failed to persist filter outcome for ${email}: ${updateFilterResult.error}` };
        }

        // Skip filter creation for keep decisions or when skipFilterCreation is enabled
        const advanceResult = await safeVoidCall("advanceSenderStep(filterStatus)", () =>
          advanceSenderStep(manifestPath, email, "filterStatus", "skipped"),
        );
        if (!advanceResult.ok) {
          return { ok: false, error: `Failed to skip filter step for ${email}: ${advanceResult.error}` };
        }

        const progressResult = emitProgress(onProgress, { sender: email, step: "filterStatus", status: "skipped" });
        if (!progressResult.ok) {
          return { ok: false, error: progressResult.error };
        }
      } else {
        // Check for existing equivalent filter before creating
        if (hasExistingFilter(existingFilters, email)) {
          // Filter already exists — idempotent, mark done without creating
          filterApplied = true;
        } else {
          const createResult = await safeResultCall("createFilter", () =>
            gmailClient.createFilter({ from: email }, { addLabelIds: [noiseLabelId], removeLabelIds: ["INBOX"] }),
          );
          if (!createResult.ok) {
            // Filter creation is best-effort — archive is the critical step.
            // Skip gracefully on any filter error (duplicates, limit hit, internal errors).
            // The filter can be recreated later if needed.
            filterApplied = false;
          } else {
            filtersCreated++;
            filterApplied = true;
            existingFilters.push(createResult.value);
          }
        }

        const updateFilterResult = await safeVoidCall("updateFilterApplied", () =>
          updateFilterApplied(manifestPath, email, filterApplied),
        );
        if (!updateFilterResult.ok) {
          return { ok: false, error: `Failed to persist filter outcome for ${email}: ${updateFilterResult.error}` };
        }

        const advanceResult = await safeVoidCall("advanceSenderStep(filterStatus)", () =>
          advanceSenderStep(manifestPath, email, "filterStatus", "done"),
        );
        if (!advanceResult.ok) {
          return { ok: false, error: `Failed to mark filter step done for ${email}: ${advanceResult.error}` };
        }

        const progressResult = emitProgress(onProgress, { sender: email, step: "filterStatus", status: "done" });
        if (!progressResult.ok) {
          return { ok: false, error: progressResult.error };
        }
      }
    }

    // -----------------------------------------------------------------------
    // Step b: archiveStatus
    // -----------------------------------------------------------------------
    if (sender.archiveStatus === "pending") {
      if (isKeep) {
        const advanceResult = await safeVoidCall("advanceSenderStep(archiveStatus)", () =>
          advanceSenderStep(manifestPath, email, "archiveStatus", "skipped"),
        );
        if (!advanceResult.ok) {
          return { ok: false, error: `Failed to skip archive step for ${email}: ${advanceResult.error}` };
        }

        const progressResult = emitProgress(onProgress, { sender: email, step: "archiveStatus", status: "skipped" });
        if (!progressResult.ok) {
          return { ok: false, error: progressResult.error };
        }
      } else {
        const idsResult = await safeResultCall("collectMessageIds", () => collectMessageIds(gmailClient, email));
        if (!idsResult.ok) {
          return { ok: false, error: `Failed to list messages for ${email}: ${idsResult.error}` };
        }
        const allIds = idsResult.value;
        let senderArchived = 0;

        if (allIds.length > 0) {
          for (const chunk of chunkArray(allIds, BATCH_MODIFY_CHUNK_SIZE)) {
            const modifyResult = await safeResultCall("batchModifyMessages", () =>
              gmailClient.batchModifyMessages(chunk, [noiseLabelId], ["INBOX"]),
            );
            if (!modifyResult.ok) {
              // Treat "precondition failed" as partial success — messages may already be modified
              const errLower = modifyResult.error.toLowerCase();
              if (errLower.includes("precondition")) {
                // Some messages in this chunk may have already been archived — don't count toward archived total
              } else {
                return { ok: false, error: `Failed to archive messages for ${email}: ${modifyResult.error}` };
              }
            } else {
              senderArchived += chunk.length;
            }
          }
        }

        totalMessagesArchived += senderArchived;
        currentMessagesArchived = senderArchived;

        const updateArchivedResult = await safeVoidCall("updateMessagesArchived", () =>
          updateMessagesArchived(manifestPath, email, senderArchived),
        );
        if (!updateArchivedResult.ok) {
          return { ok: false, error: `Failed to persist archive count for ${email}: ${updateArchivedResult.error}` };
        }

        const advanceResult = await safeVoidCall("advanceSenderStep(archiveStatus)", () =>
          advanceSenderStep(manifestPath, email, "archiveStatus", "done"),
        );
        if (!advanceResult.ok) {
          return { ok: false, error: `Failed to mark archive step done for ${email}: ${advanceResult.error}` };
        }

        const progressResult = emitProgress(onProgress, { sender: email, step: "archiveStatus", status: "done" });
        if (!progressResult.ok) {
          return { ok: false, error: progressResult.error };
        }
      }
    }

    // -----------------------------------------------------------------------
    // Step c: logStatus — append to decision log
    // -----------------------------------------------------------------------
    if (sender.logStatus === "pending") {
      const logResult = await safeResultCall("readDecisionLog", () => readDecisionLog(decisionLogPath));
      if (!logResult.ok) {
        return { ok: false, error: `Failed to read decision log: ${logResult.error}` };
      }

      const alreadyLogged =
        logResult.value?.decisions.some(
          (entry) =>
            entry.runId === manifest.runId &&
            entry.batchId === manifest.batchId &&
            entry.senderEmail.toLowerCase() === email.toLowerCase(),
        ) ?? false;

      const hasCorrectedType =
        sender.reviewedSenderType !== undefined && sender.reviewedSenderType !== sender.presentedSenderType;

      if (!alreadyLogged) {
        const entry: DecisionEntry = {
          runId: manifest.runId,
          senderEmail: email,
          senderName: sender.senderName,
          presentedSenderType: sender.presentedSenderType,
          reviewedSenderType: sender.reviewedSenderType,
          senderTypeFeedback: hasCorrectedType
            ? "corrected"
            : sender.reviewedSenderType !== undefined
              ? "confirmed"
              : "none",
          systemRecommendation: sender.systemRecommendation,
          userDecision: sender.userDecision,
          batchId: manifest.batchId,
          timestamp: new Date().toISOString(),
          emailCount: sender.emailCount,
          messagesArchived: currentMessagesArchived,
          actionsTaken: isKeep
            ? []
            : [...(filterApplied ? ["filter"] : []), ...(currentMessagesArchived > 0 ? ["archive"] : [])],
        };

        const appendResult = await safeVoidCall("appendDecisions", () => appendDecisions(decisionLogPath, [entry]));
        if (!appendResult.ok) {
          return { ok: false, error: `Failed to append decision log entry for ${email}: ${appendResult.error}` };
        }
      }

      const advanceResult = await safeVoidCall("advanceSenderStep(logStatus)", () =>
        advanceSenderStep(manifestPath, email, "logStatus", "done"),
      );
      if (!advanceResult.ok) {
        return { ok: false, error: `Failed to mark log step done for ${email}: ${advanceResult.error}` };
      }

      const progressResult = emitProgress(onProgress, { sender: email, step: "logStatus", status: "done" });
      if (!progressResult.ok) {
        return { ok: false, error: progressResult.error };
      }
    }

    // -----------------------------------------------------------------------
    // Step d: stateStatus — update sender-state with processedAt + type
    // -----------------------------------------------------------------------
    if (sender.stateStatus === "pending") {
      const stateResult = await safeResultCall("readSenderState", () => readSenderState(senderStatePath));
      if (!stateResult.ok) {
        return { ok: false, error: `Failed to read sender state: ${stateResult.error}` };
      }

      const now = new Date().toISOString();
      const existingFile = stateResult.value;

      if (existingFile === null) {
        return {
          ok: false,
          error: `Sender state file is required for execute-batch but was missing: ${senderStatePath}`,
        };
      }

      const lower = email.toLowerCase();
      const senderIndex = existingFile.senders.findIndex((s) => s.senderEmail.toLowerCase() === lower);
      if (senderIndex === -1) {
        return {
          ok: false,
          error: `Sender ${email} was not found in canonical sender state: ${senderStatePath}`,
        };
      }

      const updatedSenders: SenderStateEntry[] = existingFile.senders.map((stateSender, index) => {
        if (index !== senderIndex) return stateSender;

        const updated: SenderStateEntry = { ...stateSender, processedAt: now };
        if (sender.reviewedSenderType !== undefined) {
          updated.senderType = sender.reviewedSenderType;
          updated.reviewedSenderType = sender.reviewedSenderType;
          updated.reviewedAt = now;
          updated.senderTypeSource = "user";
          updated.senderTypeConfidence = undefined;
        }
        return updated;
      });

      const writeStateResult = await safeVoidCall("writeSenderState", () =>
        writeSenderState(senderStatePath, {
          ...existingFile,
          generatedAt: now,
          senders: updatedSenders,
        }),
      );
      if (!writeStateResult.ok) {
        return { ok: false, error: `Failed to update sender state for ${email}: ${writeStateResult.error}` };
      }

      const advanceResult = await safeVoidCall("advanceSenderStep(stateStatus)", () =>
        advanceSenderStep(manifestPath, email, "stateStatus", "done"),
      );
      if (!advanceResult.ok) {
        return { ok: false, error: `Failed to mark state step done for ${email}: ${advanceResult.error}` };
      }

      const progressResult = emitProgress(onProgress, { sender: email, step: "stateStatus", status: "done" });
      if (!progressResult.ok) {
        return { ok: false, error: progressResult.error };
      }
    }

    // -----------------------------------------------------------------------
    // Step e: sheetStatus — update audit sheet row (uses pre-read map)
    // -----------------------------------------------------------------------
    if (sender.sheetStatus === "pending") {
      const rowNumber = sheetRowMap.get(email.toLowerCase());
      if (rowNumber === undefined) {
        return { ok: false, error: `Could not find audit row for sender ${email} in sheet ${sheetId}` };
      }
      const existingRow = sheetRowCache.get(rowNumber);
      if (existingRow === undefined) {
        return { ok: false, error: `Cached audit row ${rowNumber} for sender ${email} is missing` };
      }

      const processedDate = new Date().toISOString().slice(0, 10);
      // NOTE: This must start from the existing sheet row, not a blank template.
      // Clearing columns A-K here erases the sender key + audit evidence and turns
      // a successful execute-batch run into a corrupt, non-resumable sheet state.
      const updatedRow = upsertAuditRow(
        existingRow,
        {
          senderType: sender.reviewedSenderType ?? sender.presentedSenderType,
          userDecision: sender.userDecision,
          processed: processedDate,
        },
      );
      sheetRowCache.set(rowNumber, [...updatedRow]);

      const writeRowResult = await safeResultCall("sheets.writeRows", () =>
        sheetsClient.writeRows(sheetId, `Sheet1!A${rowNumber}:P${rowNumber}`, [updatedRow]),
      );
      if (!writeRowResult.ok) {
        return { ok: false, error: `Failed to update audit row for ${email}: ${writeRowResult.error}` };
      }

      const advanceResult = await safeVoidCall("advanceSenderStep(sheetStatus)", () =>
        advanceSenderStep(manifestPath, email, "sheetStatus", "done"),
      );
      if (!advanceResult.ok) {
        return { ok: false, error: `Failed to mark sheet step done for ${email}: ${advanceResult.error}` };
      }

      const progressResult = emitProgress(onProgress, { sender: email, step: "sheetStatus", status: "done" });
      if (!progressResult.ok) {
        return { ok: false, error: progressResult.error };
      }
    }

    sendersProcessed++;
  }

  // -------------------------------------------------------------------------
  // 6. Refresh dashboard metrics once after all senders are processed
  // -------------------------------------------------------------------------
  if (needsSheetUpdate) {
    const logResult = await safeResultCall("readDecisionLog", () => readDecisionLog(decisionLogPath));
    if (!logResult.ok) {
      return { ok: false, error: `Failed to refresh dashboard metrics: ${logResult.error}` };
    }
    if (logResult.value === null) {
      return { ok: false, error: `Decision log is missing while refreshing dashboard metrics: ${decisionLogPath}` };
    }

    const dashboardRows = buildDashboardRows(
      sheetTotalSenders,
      logResult.value.decisions,
      manifest.runId,
      manifest.batchId,
    );
    const writeDashboardResult = await safeResultCall("sheets.writeRows", () =>
      sheetsClient.writeRows(sheetId, "Dashboard!A1:B7", dashboardRows),
    );
    if (!writeDashboardResult.ok) {
      return { ok: false, error: `Failed to refresh dashboard metrics: ${writeDashboardResult.error}` };
    }
  }

  // -------------------------------------------------------------------------
  // 7. Mark manifest completed
  // -------------------------------------------------------------------------
  const completeResult = await safeVoidCall("completeManifest", () => completeManifest(manifestPath));
  if (!completeResult.ok) {
    return { ok: false, error: `Failed to complete manifest: ${completeResult.error}` };
  }

  return {
    ok: true,
    value: {
      filtersCreated,
      messagesArchived: totalMessagesArchived,
      sendersProcessed,
    },
  };
}
