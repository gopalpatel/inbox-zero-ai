/**
 * execute-batch.ts — O365-native batch execution pipeline.
 *
 * Processes a batch manifest of sender decisions: creates inbox rules,
 * categorises messages with `_noise`, moves them to Archive, and updates
 * the decision log, sender state, and audit spreadsheet.
 *
 * Key differences from the Gmail version:
 * - Inbox rules instead of Gmail filters
 * - Archive folder move instead of label-based archive
 * - `_noise` Outlook category instead of `_noise` Gmail label
 */

import type { GraphClient, GraphMutationFailure, GraphRule } from "../auth/graph-client.js";
import type { SheetsClient } from "../auth/sheets-client.js";
import type { DecisionEntry } from "../schemas/decision-log.js";
import type { SenderStateEntry } from "../schemas/sender-state.js";
import { advanceSenderStep, completeManifest, readManifest } from "../state/batch-manifest-manager.js";
import { appendDecisions } from "../state/decision-log-manager.js";
import { readSenderState, writeSenderState } from "../state/sender-state-manager.js";
import type { Result } from "../types.js";
import { atomicWriteFile, formatYMD, toErrorMessage } from "../utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Safety cap on pages of messages to fetch per sender. */
const MAX_PAGES_PER_SENDER = 200;
const AUDIT_SENDER_EMAIL_HEADER = "Sender email";
const AUDIT_PROCESSED_HEADER = "Processed";

/** Decisions that require mailbox mutations (rule + archive). */
const NOISE_DECISIONS: ReadonlySet<string> = new Set(["filter", "unsubscribe"]);

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Options for executeBatch. */
export interface ExecuteBatchOptions {
  manifestPath: string;
  sheetId: string;
  graph: GraphClient;
  sheetsClient: SheetsClient;
  senderStatePath: string;
  decisionLogPath: string;
  onProgress?: (info: { sender: string; step: string; status: string }) => void;
  /** When true, validate inputs only and perform no mailbox or state mutations. */
  dryRun?: boolean;
}

/** Result returned by executeBatch on success. */
export interface ExecuteBatchResult {
  rulesCreated: number;
  messagesArchived: number;
  sendersProcessed: number;
}

// ---------------------------------------------------------------------------
// Helper: collectInboxMessageIds
// ---------------------------------------------------------------------------

/**
 * Collects all message IDs from the Inbox folder matching the given sender.
 * Paginates up to MAX_PAGES_PER_SENDER pages.
 */
async function collectInboxMessageIds(
  graph: GraphClient,
  senderEmail: string,
  inboxFolderId: string,
): Promise<Result<string[]>> {
  const allIds: string[] = [];
  let nextLink: string | undefined;
  let pageCount = 0;
  const escapedSenderEmail = escapeODataStringLiteral(senderEmail);
  const escapedInboxFolderId = escapeODataStringLiteral(inboxFolderId);

  // First page: filter by sender + inbox folder
  const firstResult = await graph.listMessages({
    filter: `from/emailAddress/address eq '${escapedSenderEmail}' ` + `and parentFolderId eq '${escapedInboxFolderId}'`,
    select: ["id"],
    top: 500,
  });
  if (!firstResult.ok) return firstResult;
  for (const m of firstResult.value.messages) allIds.push(m.id);
  nextLink = firstResult.value.nextLink;
  pageCount++;

  // Follow pagination
  while (nextLink && pageCount < MAX_PAGES_PER_SENDER) {
    const pageResult = await graph.followNextLink(nextLink);
    if (!pageResult.ok) return pageResult;
    for (const m of pageResult.value.messages) allIds.push(m.id);
    nextLink = pageResult.value.nextLink;
    pageCount++;
  }

  if (nextLink) {
    return {
      ok: false,
      error: `Exceeded MAX_PAGES (${MAX_PAGES_PER_SENDER}) for ${senderEmail}`,
    };
  }

  return { ok: true, value: allIds };
}

// ---------------------------------------------------------------------------
// Helper: hasExistingRule
// ---------------------------------------------------------------------------

/**
 * Checks whether an inbox rule already exists for the given sender email.
 * Matches case-insensitively against enabled rules that move to Archive and
 * assign the `_noise` category.
 */
function hasExistingRule(rules: GraphRule[], senderEmail: string, archiveFolderId: string): boolean {
  const lower = senderEmail.toLowerCase();
  return rules.some((r) => {
    const conditions = r.conditions ?? {};
    const actions = r.actions ?? {};
    const senderContains = conditions["senderContains"];
    const moveToFolder = actions["moveToFolder"];
    const assignCategories = actions["assignCategories"];
    if (
      r.isEnabled !== true ||
      moveToFolder !== archiveFolderId ||
      Object.entries(conditions).some(
        ([key, value]) => key !== "senderContains" && hasActiveRuleConditionValue(value),
      ) ||
      !Array.isArray(senderContains) ||
      !Array.isArray(assignCategories) ||
      !assignCategories.some((category: unknown) => category === "_noise")
    ) {
      return false;
    }
    return senderContains.some((s: unknown) => typeof s === "string" && s.toLowerCase() === lower);
  });
}

function hasActiveRuleConditionValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return true;
}

function escapeODataStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function isLikelyNotFoundError(error: string): boolean {
  return error.toLowerCase().includes("not found");
}

function formatMutationFailures(failures: GraphMutationFailure[]): string {
  return failures.map((failure) => `${failure.messageId}: ${failure.error}`).join("; ");
}

function reportProgress(
  onProgress: ExecuteBatchOptions["onProgress"],
  info: { sender: string; step: string; status: string },
): void {
  if (!onProgress) return;
  try {
    onProgress(info);
  } catch {
    // Progress reporting is best-effort only and must not change execution outcome.
  }
}

// ---------------------------------------------------------------------------
// Helper: ensureNoiseCategory
// ---------------------------------------------------------------------------

/**
 * Ensures the `_noise` Outlook category exists. Creates it if missing.
 */
async function ensureNoiseCategory(graph: GraphClient): Promise<Result<void>> {
  const cats = await graph.listCategories();
  if (!cats.ok) return cats;

  const exists = cats.value.some((c) => c.displayName === "_noise");
  if (exists) return { ok: true, value: undefined };

  const created = await graph.createCategory("_noise", "preset8");
  if (!created.ok) return created;
  return { ok: true, value: undefined };
}

async function applyNoiseCategory(
  graph: GraphClient,
  senderEmail: string,
  messageIds: string[],
): Promise<Result<{ idsReadyToArchive: string[]; skippedNotFound: number }>> {
  const idsReadyToArchive: string[] = [];
  let skippedNotFound = 0;

  for (const messageId of messageIds) {
    const messageResult = await graph.getMessage(messageId);
    if (!messageResult.ok) {
      if (isLikelyNotFoundError(messageResult.error)) {
        skippedNotFound++;
        continue;
      }
      return {
        ok: false,
        error: `Failed to read existing categories for ${senderEmail} (${messageId}): ${messageResult.error}`,
      };
    }

    const existingCategories = Array.isArray(messageResult.value.categories)
      ? messageResult.value.categories.filter((category): category is string => typeof category === "string")
      : [];
    const mergedCategories = [...new Set([...existingCategories, "_noise"])];
    const patchResult = await graph.patchMessages([messageId], {
      categories: mergedCategories,
    });
    if (!patchResult.ok) {
      return {
        ok: false,
        error: `Failed to patch messages for ${senderEmail}: ${patchResult.error}`,
      };
    }
    const hardFailures = patchResult.value.failures.filter((failure) => failure.kind !== "not_found");
    if (hardFailures.length > 0) {
      return {
        ok: false,
        error: `Failed to patch messages for ${senderEmail}: ${formatMutationFailures(hardFailures)}`,
      };
    }

    if (patchResult.value.patched > 0) {
      idsReadyToArchive.push(messageId);
    }
    skippedNotFound += patchResult.value.failures.length;
  }

  return { ok: true, value: { idsReadyToArchive, skippedNotFound } };
}

// ---------------------------------------------------------------------------
// Helper: resolveFolderIds
// ---------------------------------------------------------------------------

interface FolderIds {
  inboxFolderId: string;
  archiveFolderId: string;
}

interface AuditColumns {
  senderEmailCol: number;
  processedCol: number;
}

/**
 * Resolves Inbox and Archive folder IDs from locale-independent well-known names.
 */
async function resolveFolderIds(graph: GraphClient): Promise<Result<FolderIds>> {
  const [inboxResult, archiveResult] = await Promise.all([
    graph.getMailFolder("inbox"),
    graph.getMailFolder("archive"),
  ]);
  if (!inboxResult.ok) {
    return {
      ok: false,
      error: `Could not resolve Inbox folder: ${inboxResult.error}`,
    };
  }
  if (!archiveResult.ok) {
    return {
      ok: false,
      error: `Could not resolve Archive folder: ${archiveResult.error}`,
    };
  }

  return {
    ok: true,
    value: {
      inboxFolderId: inboxResult.value.id,
      archiveFolderId: archiveResult.value.id,
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: buildSheetRowIndex
// ---------------------------------------------------------------------------

/**
 * Builds a Map from sender email (lowercase) to 1-based row index in the sheet.
 * Row 1 is the header, so data rows start at index 2.
 */
function resolveAuditColumns(sheetRows: unknown[][]): Result<AuditColumns> {
  const header = sheetRows[0];
  if (!Array.isArray(header)) {
    return { ok: false, error: "Sheet1 is missing its header row" };
  }

  const senderEmailCol = header.indexOf(AUDIT_SENDER_EMAIL_HEADER);
  const processedCol = header.indexOf(AUDIT_PROCESSED_HEADER);
  if (senderEmailCol === -1 || processedCol === -1) {
    return {
      ok: false,
      error: `Sheet1 must contain "${AUDIT_SENDER_EMAIL_HEADER}" and "${AUDIT_PROCESSED_HEADER}" columns`,
    };
  }

  return { ok: true, value: { senderEmailCol, processedCol } };
}

function buildSheetRowIndex(sheetRows: unknown[][], senderEmailCol: number): Map<string, number> {
  const index = new Map<string, number>();
  // Skip header row (index 0)
  for (let i = 1; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    if (!row) continue;
    const email = row[senderEmailCol];
    if (typeof email === "string" && email.length > 0) {
      index.set(email.toLowerCase(), i + 1); // +1 because Sheets is 1-based
    }
  }
  return index;
}

async function updateManifestSenderFields(
  manifestPath: string,
  senderEmail: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const manifestResult = await readManifest(manifestPath);
  if (!manifestResult.ok) {
    throw new Error(`updateManifestSenderFields: failed to read manifest — ${manifestResult.error}`);
  }

  const lower = senderEmail.toLowerCase();
  const updatedSenders = manifestResult.value.senders.map((sender) => {
    if (sender.senderEmail.toLowerCase() !== lower) {
      return sender;
    }

    return {
      ...sender,
      ...fields,
    };
  });

  await atomicWriteFile(manifestPath, JSON.stringify({ ...manifestResult.value, senders: updatedSenders }, null, 2));
}

// ---------------------------------------------------------------------------
// Main: executeBatch
// ---------------------------------------------------------------------------

/**
 * Executes a batch manifest against the O365 mailbox.
 *
 * For each sender in the manifest:
 * 1. **filterStatus**: Create inbox rule (noise) or skip (keep)
 * 2. **archiveStatus**: Patch _noise category + move to Archive (noise) or skip
 * 3. **logStatus**: Append to decision log
 * 4. **stateStatus**: Update sender state with processedAt
 * 5. **sheetStatus**: Update audit sheet Processed column + Dashboard
 *
 * Resumable: skips steps already marked "done" or "skipped" in the manifest.
 * Dry-run: validates prerequisites only and writes nothing.
 */
export async function executeBatch(options: ExecuteBatchOptions): Promise<Result<ExecuteBatchResult>> {
  const { manifestPath, sheetId, graph, sheetsClient, senderStatePath, decisionLogPath, onProgress, dryRun } = options;

  try {
    // -----------------------------------------------------------------------
    // Step 1: Read manifest
    // -----------------------------------------------------------------------
    const manifestResult = await readManifest(manifestPath);
    if (!manifestResult.ok) return manifestResult;
    const manifest = manifestResult.value;

    // -----------------------------------------------------------------------
    // Step 2: Pre-read sender state and sheet for validation / mutation
    // -----------------------------------------------------------------------
    const senderStateResult = await readSenderState(senderStatePath);
    if (!senderStateResult.ok) {
      return {
        ok: false,
        error: `Failed to read sender state: ${senderStateResult.error}`,
      };
    }
    if (senderStateResult.value === null) {
      return {
        ok: false,
        error: `Sender state file is required for execute-batch but was missing: ${senderStatePath}`,
      };
    }
    let senderStateFile = senderStateResult.value;

    const sheetRowsResult = await sheetsClient.readRows(sheetId, "Sheet1");
    if (!sheetRowsResult.ok) return sheetRowsResult;
    const auditColumnsResult = resolveAuditColumns(sheetRowsResult.value);
    if (!auditColumnsResult.ok) return auditColumnsResult;
    const { senderEmailCol, processedCol } = auditColumnsResult.value;
    const rowIndex = buildSheetRowIndex(sheetRowsResult.value, senderEmailCol);

    if (dryRun === true) {
      for (const sender of manifest.senders) {
        const lower = sender.senderEmail.toLowerCase();
        const hasStateEntry = senderStateFile.senders.some((s) => s.senderEmail.toLowerCase() === lower);
        if (!hasStateEntry) {
          return {
            ok: false,
            error: `Sender ${sender.senderEmail} was not found in canonical sender state: ${senderStatePath}`,
          };
        }
        if (!rowIndex.has(lower)) {
          return {
            ok: false,
            error: `Could not find audit row for sender ${sender.senderEmail} in sheet ${sheetId}`,
          };
        }
        reportProgress(onProgress, {
          sender: sender.senderEmail,
          step: "dryRun",
          status: "validated",
        });
      }

      return {
        ok: true,
        value: { rulesCreated: 0, messagesArchived: 0, sendersProcessed: 0 },
      };
    }

    // -----------------------------------------------------------------------
    // Step 3: Resolve folder IDs
    // -----------------------------------------------------------------------
    const folderResult = await resolveFolderIds(graph);
    if (!folderResult.ok) return folderResult;
    const { inboxFolderId, archiveFolderId } = folderResult.value;

    // -----------------------------------------------------------------------
    // Step 4: Ensure _noise category
    // -----------------------------------------------------------------------
    const catResult = await ensureNoiseCategory(graph);
    if (!catResult.ok) return catResult;

    // -----------------------------------------------------------------------
    // Step 5: List existing rules for idempotency
    // -----------------------------------------------------------------------
    const rulesResult = await graph.listRules();
    if (!rulesResult.ok) return rulesResult;
    const existingRules = rulesResult.value;

    // -----------------------------------------------------------------------
    // Step 6: Process each sender
    // -----------------------------------------------------------------------
    let rulesCreated = 0;
    let messagesArchived = 0;
    let sendersProcessed = 0;

    for (const sender of manifest.senders) {
      const isNoise = NOISE_DECISIONS.has(sender.userDecision);
      const senderLower = sender.senderEmail.toLowerCase();
      let senderMessagesArchived = sender.messagesArchived;
      let senderFilterApplied = sender.filterApplied ?? sender.filterStatus === "done";

      // --- filterStatus ---
      if (sender.filterStatus === "pending") {
        if (!isNoise) {
          await advanceSenderStep(manifestPath, sender.senderEmail, "filterStatus", "skipped");
          reportProgress(onProgress, {
            sender: sender.senderEmail,
            step: "filterStatus",
            status: "skipped",
          });
        } else {
          // Check idempotency
          if (hasExistingRule(existingRules, sender.senderEmail, archiveFolderId)) {
            senderFilterApplied = true;
            await updateManifestSenderFields(manifestPath, sender.senderEmail, {
              filterApplied: true,
            });
            await advanceSenderStep(manifestPath, sender.senderEmail, "filterStatus", "done");
            reportProgress(onProgress, {
              sender: sender.senderEmail,
              step: "filterStatus",
              status: "done (existing)",
            });
          } else if (sender.senderEmail.length > 255) {
            // O365 inbox rules have a 255-character limit on senderContains values
            senderFilterApplied = false;
            await advanceSenderStep(manifestPath, sender.senderEmail, "filterStatus", "skipped");
            reportProgress(onProgress, {
              sender: sender.senderEmail,
              step: "filterStatus",
              status: "skipped (email too long)",
            });
          } else {
            const ruleResult = await graph.createRule({
              displayName: `Noise: ${sender.senderEmail}`.slice(0, 256),
              sequence: 10,
              conditions: { senderContains: [sender.senderEmail] },
              actions: {
                assignCategories: ["_noise"],
                moveToFolder: archiveFolderId,
              },
              isEnabled: true,
            });

            if (!ruleResult.ok) {
              return {
                ok: false,
                error: `Failed to create rule for ${sender.senderEmail}: ${ruleResult.error}`,
              };
            }

            rulesCreated++;
            senderFilterApplied = true;
            existingRules.push(ruleResult.value);
            await updateManifestSenderFields(manifestPath, sender.senderEmail, {
              filterApplied: true,
            });
            await advanceSenderStep(manifestPath, sender.senderEmail, "filterStatus", "done");
            reportProgress(onProgress, {
              sender: sender.senderEmail,
              step: "filterStatus",
              status: "done",
            });
          }
        }
      } else {
        reportProgress(onProgress, {
          sender: sender.senderEmail,
          step: "filterStatus",
          status: `already ${sender.filterStatus}`,
        });
      }

      // --- archiveStatus ---
      if (sender.archiveStatus === "pending") {
        if (!isNoise) {
          await advanceSenderStep(manifestPath, sender.senderEmail, "archiveStatus", "skipped");
          reportProgress(onProgress, {
            sender: sender.senderEmail,
            step: "archiveStatus",
            status: "skipped",
          });
        } else {
          // Collect inbox messages for this sender
          const idsResult = await collectInboxMessageIds(graph, sender.senderEmail, inboxFolderId);
          if (!idsResult.ok) {
            return {
              ok: false,
              error: `Failed to collect messages for ${sender.senderEmail}: ${idsResult.error}`,
            };
          }

          const messageIds = idsResult.value;

          if (messageIds.length > 0) {
            const patchResult = await applyNoiseCategory(graph, sender.senderEmail, messageIds);
            if (!patchResult.ok) return patchResult;
            let benignNotFoundCount = patchResult.value.skippedNotFound;

            // Move to Archive
            if (patchResult.value.idsReadyToArchive.length > 0) {
              const moveResult = await graph.moveMessages(patchResult.value.idsReadyToArchive, archiveFolderId);
              if (!moveResult.ok) {
                return {
                  ok: false,
                  error: `Failed to move messages for ${sender.senderEmail}: ${moveResult.error}`,
                };
              }

              const hardFailures = moveResult.value.failures.filter((failure) => failure.kind !== "not_found");
              if (hardFailures.length > 0) {
                return {
                  ok: false,
                  error: `Failed to move messages for ${sender.senderEmail}: ${formatMutationFailures(hardFailures)}`,
                };
              }

              if (moveResult.value.moved > 0) {
                senderMessagesArchived += moveResult.value.moved;
                await updateManifestSenderFields(manifestPath, sender.senderEmail, {
                  messagesArchived: senderMessagesArchived,
                });
              }

              benignNotFoundCount += moveResult.value.failures.length;
            }

            if (benignNotFoundCount > 0) {
              reportProgress(onProgress, {
                sender: sender.senderEmail,
                step: "archiveStatus",
                status: `warning: ${benignNotFoundCount} messages disappeared before mutation`,
              });
            }
          }

          await advanceSenderStep(manifestPath, sender.senderEmail, "archiveStatus", "done");
          reportProgress(onProgress, {
            sender: sender.senderEmail,
            step: "archiveStatus",
            status: `done (${senderMessagesArchived} messages)`,
          });
        }
      } else {
        reportProgress(onProgress, {
          sender: sender.senderEmail,
          step: "archiveStatus",
          status: `already ${sender.archiveStatus}`,
        });
      }

      // --- logStatus ---
      if (sender.logStatus === "pending") {
        const actionsTaken = !isNoise
          ? []
          : [...(senderFilterApplied ? ["filter"] : []), ...(senderMessagesArchived > 0 ? ["archive"] : [])];

        const entry: DecisionEntry = {
          runId: manifest.runId,
          senderEmail: sender.senderEmail,
          senderName: sender.senderName,
          presentedSenderType: sender.presentedSenderType,
          reviewedSenderType: sender.reviewedSenderType,
          senderTypeFeedback:
            sender.reviewedSenderType !== undefined && sender.reviewedSenderType !== sender.presentedSenderType
              ? "corrected"
              : sender.reviewedSenderType !== undefined
                ? "confirmed"
                : "none",
          systemRecommendation: sender.systemRecommendation,
          userDecision: sender.userDecision,
          batchId: manifest.batchId,
          timestamp: new Date().toISOString(),
          emailCount: sender.emailCount,
          messagesArchived: senderMessagesArchived,
          actionsTaken,
        };

        await appendDecisions(decisionLogPath, [entry]);
        await advanceSenderStep(manifestPath, sender.senderEmail, "logStatus", "done");
        reportProgress(onProgress, {
          sender: sender.senderEmail,
          step: "logStatus",
          status: "done",
        });
      } else {
        reportProgress(onProgress, {
          sender: sender.senderEmail,
          step: "logStatus",
          status: `already ${sender.logStatus}`,
        });
      }

      // --- stateStatus ---
      if (sender.stateStatus === "pending") {
        const now = new Date().toISOString();
        const senderIndex = senderStateFile.senders.findIndex((s) => s.senderEmail.toLowerCase() === senderLower);
        if (senderIndex === -1) {
          return {
            ok: false,
            error: `Sender ${sender.senderEmail} was not found in canonical sender state: ${senderStatePath}`,
          };
        }

        const updatedSenders: SenderStateEntry[] = senderStateFile.senders.map((stateSender, index) => {
          if (index !== senderIndex) {
            return stateSender;
          }

          const updated: SenderStateEntry = {
            ...stateSender,
            processedAt: now,
          };
          if (sender.reviewedSenderType !== undefined) {
            updated.senderType = sender.reviewedSenderType;
            updated.reviewedSenderType = sender.reviewedSenderType;
            updated.reviewedAt = now;
            updated.senderTypeSource = "user";
            updated.senderTypeConfidence = undefined;
          }
          return updated;
        });

        senderStateFile = {
          ...senderStateFile,
          generatedAt: now,
          senders: updatedSenders,
        };
        await writeSenderState(senderStatePath, senderStateFile);

        await advanceSenderStep(manifestPath, sender.senderEmail, "stateStatus", "done");
        reportProgress(onProgress, {
          sender: sender.senderEmail,
          step: "stateStatus",
          status: "done",
        });
      } else {
        reportProgress(onProgress, {
          sender: sender.senderEmail,
          step: "stateStatus",
          status: `already ${sender.stateStatus}`,
        });
      }

      // --- sheetStatus ---
      if (sender.sheetStatus === "pending") {
        const sheetRow = rowIndex.get(sender.senderEmail.toLowerCase());
        if (sheetRow === undefined) {
          return {
            ok: false,
            error: `Could not find audit row for sender ${sender.senderEmail} in sheet ${sheetId}`,
          };
        }

        // Update the Processed column for this sender's row
        const processedCell = `Sheet1!${colLetter(processedCol)}${sheetRow}`;
        const writeResult = await sheetsClient.writeRows(sheetId, processedCell, [[formatYMD(new Date())]]);
        if (!writeResult.ok) {
          return {
            ok: false,
            error: `Failed to update audit row for ${sender.senderEmail}: ${writeResult.error}`,
          };
        }

        await advanceSenderStep(manifestPath, sender.senderEmail, "sheetStatus", "done");
        reportProgress(onProgress, {
          sender: sender.senderEmail,
          step: "sheetStatus",
          status: "done",
        });
      } else {
        reportProgress(onProgress, {
          sender: sender.senderEmail,
          step: "sheetStatus",
          status: `already ${sender.sheetStatus}`,
        });
      }

      messagesArchived += senderMessagesArchived;
      sendersProcessed++;
    }

    // -----------------------------------------------------------------------
    // Step 7: Refresh dashboard metrics
    // -----------------------------------------------------------------------
    try {
      const dashboardRows: unknown[][] = [
        ["Total senders", manifest.senders.length],
        ["Processed", sendersProcessed],
        ["Emails cleared", messagesArchived],
        ["Unsubscribed", manifest.senders.filter((s) => s.userDecision === "unsubscribe").length],
        ["Filters created", rulesCreated],
        ["Remaining", manifest.senders.length - sendersProcessed],
        ["Current section", manifest.batchType],
      ];
      const dashboardResult = await sheetsClient.writeRows(sheetId, "Dashboard!A1:B7", dashboardRows);
      if (!dashboardResult.ok) {
        throw new Error(dashboardResult.error);
      }
    } catch {
      // Non-fatal — dashboard update is best-effort
    }

    // -----------------------------------------------------------------------
    // Step 8: Mark manifest completed
    // -----------------------------------------------------------------------
    await completeManifest(manifestPath);

    return {
      ok: true,
      value: { rulesCreated, messagesArchived, sendersProcessed },
    };
  } catch (err: unknown) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

// ---------------------------------------------------------------------------
// Utility: colLetter
// ---------------------------------------------------------------------------

/**
 * Converts a 0-based column index to a Sheets column letter (A, B, ..., Z, AA, ...).
 */
function colLetter(index: number): string {
  let result = "";
  let remaining = index;
  while (remaining >= 0) {
    result = String.fromCharCode((remaining % 26) + 65) + result;
    remaining = Math.floor(remaining / 26) - 1;
  }
  return result;
}
