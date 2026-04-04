/**
 * backfill.ts — Resumable backfill engine for recovering failed messages.
 *
 * After a metadata pull completes, some individual getMessage or parse calls
 * may have failed and been recorded as errors in the main checkpoint. The
 * backfill engine retries those specific message IDs, stages recovered
 * metadata in a JSONL append-log for crash safety, then promotes successes
 * into run-scoped batch files and rewrites the main checkpoint to reflect
 * the recovered messages.
 *
 * Design decisions:
 * - JSONL append-log (`recovered.jsonl`) for crash-safe staging: each
 *   successful fetch is immediately appended so no work is lost on crash.
 * - Fingerprint-based run matching ensures a backfill run targets the exact
 *   same error set it was created for.
 * - `promoting` means the run-scoped batch shards/report are durable and the
 *   main checkpoint rewrite is the only remaining step, so retries can safely
 *   resume/finalise the same run without duplicating data.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { GmailClient } from "../auth/gmail-client.js";
import type { BackfillCheckpoint, BackfillResidualError } from "../schemas/backfill-checkpoint.js";
import { BackfillCheckpointSchema } from "../schemas/backfill-checkpoint.js";
import type { Checkpoint, CheckpointError } from "../schemas/checkpoint.js";
import type { EmailMetadata } from "../schemas/email-metadata.js";
import { EmailMetadataSchema } from "../schemas/email-metadata.js";
import type { Result } from "../types.js";
import { atomicWriteFile, Semaphore, toErrorMessage } from "../utils.js";
import { BATCH_SIZE, loadCheckpoint, saveCheckpoint } from "./checkpoint-manager.js";
import { parseGmailMessage } from "./message-parser.js";
import { MAX_CONCURRENT, METADATA_HEADERS } from "./pull-constants.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BACKFILL_DIR = "backfills";
const BACKFILL_CHECKPOINT_FILENAME = "backfill-checkpoint.json";
const RECOVERED_FILENAME = "recovered.jsonl";
const REPORT_FILENAME = "report.json";

/**
 * Regex to extract a message ID from legacy error messages in the format
 * `Message <id>: <details>`. IDs may contain any non-colon characters
 * (not limited to hex).
 */
const LEGACY_MESSAGE_ID_RE = /^Message ([^:]{1,200}):/;

/** Save the backfill checkpoint every this many messages during fetch phase. */
const CHECKPOINT_INTERVAL = 100;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BackfillOptions {
  client: GmailClient;
  dataDir: string;
  restart?: boolean;
  onProgress?: (progress: BackfillProgress) => void;
}

export interface BackfillProgress {
  processed: number;
  total: number;
  recovered: number;
  stillFailing: number;
  phase: "fetching" | "promoting";
}

export interface BackfillResult {
  runId: string;
  totalIds: number;
  recovered: number;
  stillFailing: number;
  shardsWritten: number;
  residualErrors: BackfillResidualError[];
  reportPath: string;
}

interface ActiveRun {
  runDir: string;
  checkpoint: BackfillCheckpoint;
}

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * Extracts deduplicated, sorted message IDs from checkpoint errors.
 *
 * For each error:
 * - Prefers the structured `messageId` field if present
 * - Falls back to regex `^Message <id>:` on the error message
 * - Ignores errors that match neither pattern (system errors)
 */
export function extractMessageIds(errors: CheckpointError[]): string[] {
  const ids = new Set<string>();

  for (const error of errors) {
    if (error.messageId !== undefined && error.messageId.length > 0) {
      ids.add(error.messageId);
      continue;
    }

    const match = LEGACY_MESSAGE_ID_RE.exec(error.message);
    if (match !== null) {
      const id = match[1];
      if (id !== undefined && id.length > 0) {
        ids.add(id);
      }
    }
  }

  return [...ids].sort();
}

/**
 * Creates a deterministic fingerprint (SHA-256 hex digest) for a set of
 * message IDs. Input order does not matter — IDs are sorted before hashing.
 */
export function fingerprintTargetIds(ids: string[]): string {
  const sorted = [...ids].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Loads previously staged recoveries from the JSONL append-log.
 * Keeps only the latest entry per messageId for crash-safety dedup.
 */
async function loadRecoveredMap(runDir: string): Promise<Map<string, EmailMetadata>> {
  const filePath = path.join(runDir, RECOVERED_FILENAME);
  const map = new Map<string, EmailMetadata>();

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return map;
    throw err;
  }

  const lines = raw.split("\n").filter((line) => line.trim().length > 0);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Skip malformed lines (crash mid-write)
      continue;
    }

    const result = EmailMetadataSchema.safeParse(parsed);
    if (result.success) {
      map.set(result.data.messageId, result.data);
    }
  }

  return map;
}

/**
 * Loads and validates a backfill checkpoint from disk.
 */
async function loadBackfillCheckpoint(filePath: string): Promise<BackfillCheckpoint | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = BackfillCheckpointSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Saves a backfill checkpoint atomically.
 */
async function saveBackfillCheckpoint(checkpoint: BackfillCheckpoint, filePath: string): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(checkpoint, null, 2));
}

/**
 * Returns all active backfill runs (fetching/promoting), newest first.
 */
async function findActiveRuns(backfillsDir: string): Promise<ActiveRun[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(backfillsDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }

  const runs: ActiveRun[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const runDir = path.join(backfillsDir, entry.name);
    const cpPath = path.join(runDir, BACKFILL_CHECKPOINT_FILENAME);
    const cp = await loadBackfillCheckpoint(cpPath);
    if (cp === null) continue;
    if (cp.status === "complete" || cp.status === "failed") continue;

    runs.push({ runDir, checkpoint: cp });
  }

  runs.sort((a, b) => b.checkpoint.lastSavedAt.getTime() - a.checkpoint.lastSavedAt.getTime());
  return runs;
}

/**
 * Best-effort helper to retire stale active runs during `--restart`.
 */
async function markRunsFailed(runs: ActiveRun[]): Promise<void> {
  for (const run of runs) {
    const filePath = path.join(run.runDir, BACKFILL_CHECKPOINT_FILENAME);
    try {
      await saveBackfillCheckpoint(
        {
          ...run.checkpoint,
          status: "failed" as const,
          lastSavedAt: new Date(),
        },
        filePath,
      );
    } catch {
      // Best-effort only; caller will continue creating/resuming the chosen run.
    }
  }
}

/**
 * Classifies a checkpoint error as message-level or system-level.
 * Message-level errors have a messageId field or match `^Message <id>:`.
 */
function isMessageLevelError(error: CheckpointError): boolean {
  if (error.kind === "message") return true;
  if (error.kind === "system") return false;
  if (error.messageId !== undefined && error.messageId.length > 0) return true;
  return LEGACY_MESSAGE_ID_RE.test(error.message);
}

/**
 * Rebuilds the residual-error map from durable state, ignoring IDs that are no
 * longer targets or have already been recovered.
 */
function buildResidualErrorMap(
  residualErrors: BackfillResidualError[],
  targetIds: string[],
  recoveredMap: ReadonlyMap<string, EmailMetadata>,
): Map<string, BackfillResidualError> {
  const targetSet = new Set(targetIds);
  const map = new Map<string, BackfillResidualError>();

  for (const error of residualErrors) {
    if (!targetSet.has(error.messageId)) continue;
    if (recoveredMap.has(error.messageId)) continue;
    map.set(error.messageId, error);
  }

  return map;
}

/**
 * Materialises residual errors in stable target-id order and excludes messages
 * that have already recovered.
 */
function materializeResidualErrors(
  residualErrorMap: ReadonlyMap<string, BackfillResidualError>,
  targetIds: string[],
  recoveredMap: ReadonlyMap<string, EmailMetadata>,
): BackfillResidualError[] {
  const residualErrors: BackfillResidualError[] = [];

  for (const id of targetIds) {
    if (recoveredMap.has(id)) continue;
    const error = residualErrorMap.get(id);
    if (error !== undefined) {
      residualErrors.push(error);
    }
  }

  return residualErrors;
}

/**
 * Writes/rewrites the durable report for a run and returns its path.
 */
async function writeBackfillReport(runDir: string, report: Omit<BackfillResult, "reportPath">): Promise<string> {
  const reportPath = path.join(runDir, REPORT_FILENAME);
  await atomicWriteFile(
    reportPath,
    JSON.stringify(
      {
        ...report,
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  return reportPath;
}

/**
 * Finalises a `promoting` run after the main checkpoint has already been
 * reconciled. This covers the narrow window where rewriting `checkpoint.json`
 * succeeded but saving the final backfill checkpoint did not.
 */
async function finalizePromotingRun(runDir: string, checkpoint: BackfillCheckpoint): Promise<Result<BackfillResult>> {
  let recoveredMap: Map<string, EmailMetadata>;
  try {
    recoveredMap = await loadRecoveredMap(runDir);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to load recovered.jsonl while finalising promoting run: ${toErrorMessage(err)}`,
    };
  }

  const residualErrorMap = buildResidualErrorMap(checkpoint.residualErrors, checkpoint.targetIds, recoveredMap);
  const residualErrors = materializeResidualErrors(residualErrorMap, checkpoint.targetIds, recoveredMap);

  let reportPath: string;
  try {
    reportPath = await writeBackfillReport(runDir, {
      runId: checkpoint.runId,
      totalIds: checkpoint.targetIds.length,
      recovered: recoveredMap.size,
      stillFailing: residualErrors.length,
      shardsWritten: checkpoint.shardsWritten,
      residualErrors,
    });
  } catch (err) {
    return {
      ok: false,
      error: `Failed to write report while finalising promoting run: ${toErrorMessage(err)}`,
    };
  }

  const finalCheckpoint: BackfillCheckpoint = {
    ...checkpoint,
    status: "complete",
    recoveredCount: recoveredMap.size,
    residualErrors,
    lastSavedAt: new Date(),
  };

  try {
    await saveBackfillCheckpoint(finalCheckpoint, path.join(runDir, BACKFILL_CHECKPOINT_FILENAME));
  } catch (err) {
    return {
      ok: false,
      error: `Failed to save final backfill checkpoint: ${toErrorMessage(err)}`,
    };
  }

  return {
    ok: true,
    value: {
      runId: checkpoint.runId,
      totalIds: checkpoint.targetIds.length,
      recovered: recoveredMap.size,
      stillFailing: residualErrors.length,
      shardsWritten: checkpoint.shardsWritten,
      residualErrors,
      reportPath,
    },
  };
}

// ---------------------------------------------------------------------------
// Main backfill function
// ---------------------------------------------------------------------------

/**
 * Retries failed message fetches from a completed pull, stages recoveries in
 * a crash-safe JSONL log, promotes successes to batch files, and rewrites
 * the main checkpoint to reflect recovered messages.
 *
 * Never throws — all errors are returned in the `Result` value.
 */
export async function backfill(options: BackfillOptions): Promise<Result<BackfillResult>> {
  const { client, dataDir, restart = false, onProgress } = options;

  // -------------------------------------------------------------------------
  // 1. Load main checkpoint
  // -------------------------------------------------------------------------

  const cpResult = await loadCheckpoint(dataDir);
  if (!cpResult.ok) {
    return { ok: false, error: `Failed to load checkpoint: ${cpResult.error}` };
  }

  const mainCheckpoint = cpResult.value;

  // -------------------------------------------------------------------------
  // 2. Guard: must be complete
  // -------------------------------------------------------------------------

  if (mainCheckpoint.status !== "complete") {
    return {
      ok: false,
      error: `Cannot backfill: checkpoint status is "${mainCheckpoint.status}" (expected "complete")`,
    };
  }

  // -------------------------------------------------------------------------
  // 3. Split errors into message-level and system-level
  // -------------------------------------------------------------------------

  const messageLevelErrors: CheckpointError[] = [];
  const systemErrors: CheckpointError[] = [];

  for (const error of mainCheckpoint.errors) {
    if (isMessageLevelError(error)) {
      messageLevelErrors.push(error);
    } else {
      systemErrors.push(error);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Extract + dedupe target IDs
  // -------------------------------------------------------------------------

  const targetIds = extractMessageIds(messageLevelErrors);

  const backfillsDir = path.join(dataDir, BACKFILL_DIR);
  let activeRuns: ActiveRun[];
  try {
    activeRuns = await findActiveRuns(backfillsDir);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to inspect existing backfill runs: ${toErrorMessage(err)}`,
    };
  }

  // -------------------------------------------------------------------------
  // 5. Early return if no IDs to recover
  // -------------------------------------------------------------------------

  if (targetIds.length === 0) {
    if (activeRuns.length === 0) {
      return {
        ok: true,
        value: {
          runId: "",
          totalIds: 0,
          recovered: 0,
          stillFailing: 0,
          shardsWritten: 0,
          residualErrors: [],
          reportPath: "",
        },
      };
    }

    const promotingRuns = activeRuns.filter((run) => run.checkpoint.status === "promoting");

    if (activeRuns.length === 1 && promotingRuns.length === 1) {
      return await finalizePromotingRun(promotingRuns[0]!.runDir, promotingRuns[0]!.checkpoint);
    }

    return {
      ok: false,
      error:
        "Main checkpoint has no message-level errors, but an active backfill run is still pending. " +
        "Pass restart: true to discard stale runs and start fresh if needed.",
    };
  }

  // -------------------------------------------------------------------------
  // 6. Compute fingerprint
  // -------------------------------------------------------------------------

  const fingerprint = fingerprintTargetIds(targetIds);

  // -------------------------------------------------------------------------
  // 7. Find or create run directory
  // -------------------------------------------------------------------------

  let runId: string;
  let runDir: string;
  let backfillCp: BackfillCheckpoint;

  const matchingRuns = activeRuns.filter((run) => run.checkpoint.sourceErrorFingerprint === fingerprint);
  const conflictingRuns = activeRuns.filter((run) => run.checkpoint.sourceErrorFingerprint !== fingerprint);

  if (matchingRuns.length > 1 && !restart) {
    return {
      ok: false,
      error:
        "Multiple active backfill runs match the current fingerprint. " +
        "Pass restart: true to discard stale runs and resume the latest one.",
    };
  }

  if (matchingRuns.length > 0) {
    if (restart && matchingRuns.length > 1) {
      await markRunsFailed(matchingRuns.slice(1));
    }

    if (conflictingRuns.length > 0) {
      if (!restart) {
        return {
          ok: false,
          error:
            "Existing backfill run has a different fingerprint. " + "Pass restart: true to discard it and start fresh.",
        };
      }
      await markRunsFailed(conflictingRuns);
    }

    runId = matchingRuns[0]!.checkpoint.runId;
    runDir = matchingRuns[0]!.runDir;
    backfillCp = matchingRuns[0]!.checkpoint;
  } else if (activeRuns.length > 0) {
    if (!restart) {
      return {
        ok: false,
        error:
          "Existing backfill run has a different fingerprint. " + "Pass restart: true to discard it and start fresh.",
      };
    }

    await markRunsFailed(activeRuns);

    // Create new run
    runId = Date.now().toString(36);
    runDir = path.join(backfillsDir, runId);
    try {
      await fs.mkdir(runDir, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        error: `Failed to create run directory: ${toErrorMessage(err)}`,
      };
    }
    backfillCp = {
      runId,
      status: "fetching" as const,
      sourceCheckpointLastSavedAt: mainCheckpoint.lastSavedAt,
      sourceErrorFingerprint: fingerprint,
      targetIds,
      recoveredCount: 0,
      residualErrors: [],
      shardsWritten: 0,
      lastSavedAt: new Date(),
    };
  } else {
    // Create new run
    runId = Date.now().toString(36);
    runDir = path.join(backfillsDir, runId);
    try {
      await fs.mkdir(runDir, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        error: `Failed to create run directory: ${toErrorMessage(err)}`,
      };
    }
    backfillCp = {
      runId,
      status: "fetching" as const,
      sourceCheckpointLastSavedAt: mainCheckpoint.lastSavedAt,
      sourceErrorFingerprint: fingerprint,
      targetIds,
      recoveredCount: 0,
      residualErrors: [],
      shardsWritten: 0,
      lastSavedAt: new Date(),
    };
  }

  const backfillCpPath = path.join(runDir, BACKFILL_CHECKPOINT_FILENAME);

  // Save initial backfill checkpoint
  try {
    await saveBackfillCheckpoint(backfillCp, backfillCpPath);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to save backfill checkpoint: ${toErrorMessage(err)}`,
    };
  }

  // -------------------------------------------------------------------------
  // 8. Load staged recoveries
  // -------------------------------------------------------------------------

  let recoveredMap: Map<string, EmailMetadata>;
  try {
    recoveredMap = await loadRecoveredMap(runDir);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to load recovered.jsonl: ${toErrorMessage(err)}`,
    };
  }

  // -------------------------------------------------------------------------
  // 9. Compute remaining IDs
  // -------------------------------------------------------------------------

  const remainingIds = targetIds.filter((id) => !recoveredMap.has(id));

  // -------------------------------------------------------------------------
  // 10. Fetch phase
  // -------------------------------------------------------------------------

  const residualErrorMap = buildResidualErrorMap(backfillCp.residualErrors, targetIds, recoveredMap);
  const recoveredPath = path.join(runDir, RECOVERED_FILENAME);
  const semaphore = new Semaphore(MAX_CONCURRENT);
  let processedCount = 0;

  const fetchTasks = remainingIds.map((id) => async (): Promise<void> => {
    await semaphore.acquire();
    try {
      let msgResult: Awaited<ReturnType<typeof client.getMessage>>;
      try {
        msgResult = await client.getMessage(id, "metadata", [...METADATA_HEADERS]);
      } catch (err) {
        residualErrorMap.set(id, {
          messageId: id,
          error: `getMessage threw: ${toErrorMessage(err)}`,
          timestamp: new Date(),
        });
        return;
      }

      if (!msgResult.ok) {
        residualErrorMap.set(id, {
          messageId: id,
          error: msgResult.error,
          timestamp: new Date(),
        });
        return;
      }

      let parseResult: ReturnType<typeof parseGmailMessage>;
      try {
        parseResult = parseGmailMessage(msgResult.value);
      } catch (err) {
        residualErrorMap.set(id, {
          messageId: id,
          error: `parseGmailMessage threw: ${toErrorMessage(err)}`,
          timestamp: new Date(),
        });
        return;
      }

      if (!parseResult.ok) {
        residualErrorMap.set(id, {
          messageId: id,
          error: parseResult.error,
          timestamp: new Date(),
        });
        return;
      }

      // Append to JSONL (crash-safe staging)
      const line = `${JSON.stringify(parseResult.value)}\n`;
      try {
        await fs.appendFile(recoveredPath, line, "utf-8");
      } catch (appendErr) {
        residualErrorMap.set(id, {
          messageId: id,
          error: `Failed to stage recovery: ${toErrorMessage(appendErr)}`,
          timestamp: new Date(),
        });
        return;
      }
      recoveredMap.set(id, parseResult.value);
      residualErrorMap.delete(id);
    } finally {
      semaphore.release();
      processedCount++;

      // Update backfill checkpoint periodically
      if (processedCount % CHECKPOINT_INTERVAL === 0) {
        backfillCp = {
          ...backfillCp,
          recoveredCount: recoveredMap.size,
          residualErrors: materializeResidualErrors(residualErrorMap, targetIds, recoveredMap),
          lastSavedAt: new Date(),
        };
        try {
          await saveBackfillCheckpoint(backfillCp, backfillCpPath);
        } catch (saveErr) {
          console.warn(`backfill: periodic checkpoint save failed: ${toErrorMessage(saveErr)}`);
        }
      }

      // Fire progress callback
      if (onProgress !== undefined) {
        try {
          onProgress({
            processed: processedCount,
            total: remainingIds.length,
            recovered: recoveredMap.size,
            stillFailing: residualErrorMap.size,
            phase: "fetching",
          });
        } catch {
          // Non-fatal: progress callback failure must not crash the run
        }
      }
    }
  });

  // Execute all fetch tasks with bounded concurrency
  await Promise.all(fetchTasks.map((task) => task()));

  // Save backfill checkpoint after fetch phase
  backfillCp = {
    ...backfillCp,
    recoveredCount: recoveredMap.size,
    residualErrors: materializeResidualErrors(residualErrorMap, targetIds, recoveredMap),
    lastSavedAt: new Date(),
  };

  try {
    await saveBackfillCheckpoint(backfillCp, backfillCpPath);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to save backfill checkpoint after fetch: ${toErrorMessage(err)}`,
    };
  }

  // -------------------------------------------------------------------------
  // 11. Promote phase
  // -------------------------------------------------------------------------

  if (onProgress !== undefined) {
    try {
      onProgress({
        processed: processedCount,
        total: remainingIds.length,
        recovered: recoveredMap.size,
        stillFailing: backfillCp.residualErrors.length,
        phase: "promoting",
      });
    } catch {
      // Non-fatal: progress callback failure must not crash the run
    }
  }

  // Re-read and dedupe all staged recoveries
  let finalRecoveredMap: Map<string, EmailMetadata>;
  try {
    finalRecoveredMap = await loadRecoveredMap(runDir);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to reload recovered.jsonl for promotion: ${toErrorMessage(err)}`,
    };
  }

  const recoveredEntries = [...finalRecoveredMap.values()];
  const finalResidualErrorMap = buildResidualErrorMap(backfillCp.residualErrors, targetIds, finalRecoveredMap);
  const finalResidualErrors = materializeResidualErrors(finalResidualErrorMap, targetIds, finalRecoveredMap);

  // Write run-scoped batch shard files
  let shardsWritten = 0;

  for (let i = 0; i < recoveredEntries.length; i += BATCH_SIZE) {
    const chunk = recoveredEntries.slice(i, i + BATCH_SIZE);
    shardsWritten++;
    const padded = String(shardsWritten).padStart(5, "0");
    const shardPath = path.join(runDir, `batch-${padded}.json`);

    try {
      await atomicWriteFile(shardPath, JSON.stringify(chunk, null, 2));
    } catch (err) {
      return {
        ok: false,
        error: `Failed to write batch shard: ${toErrorMessage(err)}`,
      };
    }
  }

  let reportPath: string;
  try {
    reportPath = await writeBackfillReport(runDir, {
      runId,
      totalIds: targetIds.length,
      recovered: finalRecoveredMap.size,
      stillFailing: finalResidualErrors.length,
      shardsWritten,
      residualErrors: finalResidualErrors,
    });
  } catch (err) {
    return {
      ok: false,
      error: `Failed to write report: ${toErrorMessage(err)}`,
    };
  }

  // Mark backfill checkpoint as promoting. At this point run-scoped artifacts
  // are durable and only the main checkpoint rewrite remains.
  backfillCp = {
    ...backfillCp,
    status: "promoting" as const,
    recoveredCount: finalRecoveredMap.size,
    residualErrors: finalResidualErrors,
    shardsWritten,
    lastSavedAt: new Date(),
  };

  try {
    await saveBackfillCheckpoint(backfillCp, backfillCpPath);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to save promoting backfill checkpoint: ${toErrorMessage(err)}`,
    };
  }

  // -------------------------------------------------------------------------
  // 12. Rewrite main checkpoint
  // -------------------------------------------------------------------------

  const recoveredIds = new Set(finalRecoveredMap.keys());

  // Build new errors: keep system errors + residual message errors
  const newErrors: CheckpointError[] = [
    ...systemErrors,
    // Keep message-level errors whose IDs were NOT recovered
    ...messageLevelErrors.filter((err) => {
      const id = err.messageId ?? LEGACY_MESSAGE_ID_RE.exec(err.message)?.[1];
      return id === undefined || !recoveredIds.has(id);
    }),
  ];

  const updatedCheckpoint: Checkpoint = {
    ...mainCheckpoint,
    messagesFetched: mainCheckpoint.messagesFetched + finalRecoveredMap.size,
    errors: newErrors,
    lastSavedAt: new Date(),
  };

  const saveResult = await saveCheckpoint(updatedCheckpoint, dataDir);
  if (!saveResult.ok) {
    return {
      ok: false,
      error: `Failed to rewrite main checkpoint: ${saveResult.error}`,
    };
  }

  backfillCp = {
    ...backfillCp,
    status: "complete" as const,
    lastSavedAt: new Date(),
  };

  try {
    await saveBackfillCheckpoint(backfillCp, backfillCpPath);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to save final backfill checkpoint: ${toErrorMessage(err)}`,
    };
  }

  // -------------------------------------------------------------------------
  // 13. Return result
  // -------------------------------------------------------------------------

  return {
    ok: true,
    value: {
      runId,
      totalIds: targetIds.length,
      recovered: finalRecoveredMap.size,
      stillFailing: finalResidualErrors.length,
      shardsWritten,
      residualErrors: finalResidualErrors,
      reportPath,
    },
  };
}
