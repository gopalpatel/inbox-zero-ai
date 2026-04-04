import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BackfillCheckpointSchema } from "../schemas/backfill-checkpoint.js";
import type { Checkpoint } from "../schemas/checkpoint.js";
import { CheckpointSchema } from "../schemas/checkpoint.js";
import type { EmailMetadata } from "../schemas/email-metadata.js";
import { EmailMetadataSchema } from "../schemas/email-metadata.js";
import type { Result } from "../types.js";
import { atomicWriteFile, toErrorMessage } from "../utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of email records written per batch file. */
export const BATCH_SIZE = 500;

/** Filename for the checkpoint state file within the data directory. */
const CHECKPOINT_FILENAME = "checkpoint.json";

/**
 * Prefix for batch data files. Files are zero-padded to 5 digits for
 * lexicographic sort order: batch-00001.json, batch-00002.json, etc.
 */
const BATCH_FILE_PREFIX = "batch-";

/** Extension for batch data files. */
const BATCH_FILE_EXT = ".json";

/** Pattern to match batch filenames for sorting. */
const BATCH_FILENAME_PATTERN = /^batch-\d{5,}\.json$/;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Format a batch index (1-based) as a zero-padded filename.
 * e.g. batchIndexToFilename(1) === "batch-00001.json"
 */
function batchIndexToFilename(index: number): string {
  const padded = String(index).padStart(5, "0");
  return `${BATCH_FILE_PREFIX}${padded}${BATCH_FILE_EXT}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a checkpoint snapshot to `{dataDir}/checkpoint.json`.
 * Uses atomic write (temp file + rename) to prevent corruption on crash.
 */
export async function saveCheckpoint(checkpoint: Checkpoint, dataDir: string): Promise<Result<void>> {
  try {
    const filePath = path.join(dataDir, CHECKPOINT_FILENAME);
    const serialized = JSON.stringify(checkpoint, null, 2);
    await atomicWriteFile(filePath, serialized);
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, error: `Failed to save checkpoint: ${toErrorMessage(err)}` };
  }
}

/**
 * Load and parse the checkpoint from `{dataDir}/checkpoint.json`.
 *
 * Returns `{ ok: false }` when:
 * - No checkpoint file exists (fresh start)
 * - File content is not valid JSON
 * - JSON does not conform to CheckpointSchema
 */
export async function loadCheckpoint(dataDir: string): Promise<Result<Checkpoint>> {
  const filePath = path.join(dataDir, CHECKPOINT_FILENAME);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    // File does not exist — fresh start
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, error: "No checkpoint file found (fresh start)" };
    }
    return { ok: false, error: `Failed to read checkpoint file: ${toErrorMessage(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `Checkpoint file contains invalid JSON: ${toErrorMessage(err)}` };
  }

  const result = CheckpointSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: `Checkpoint file failed schema validation: ${result.error.message}`,
    };
  }

  return { ok: true, value: result.data };
}

/**
 * Write a batch of EmailMetadata records to `{dataDir}/batch-NNNNN.json`.
 * The batch number is derived from the current `checkpoint.batchesSaved + 1`.
 *
 * Returns the updated Checkpoint with incremented `batchesSaved` and
 * `messagesFetched` counters. The caller is responsible for persisting the
 * updated checkpoint via `saveCheckpoint()` if desired.
 */
export async function saveBatch(
  batch: EmailMetadata[],
  checkpoint: Checkpoint,
  dataDir: string,
): Promise<Result<Checkpoint>> {
  try {
    const nextBatchIndex = checkpoint.batchesSaved + 1;
    const filename = batchIndexToFilename(nextBatchIndex);
    const filePath = path.join(dataDir, filename);

    const serialized = JSON.stringify(batch, null, 2);
    await atomicWriteFile(filePath, serialized);

    const updatedCheckpoint: Checkpoint = {
      ...checkpoint,
      batchesSaved: nextBatchIndex,
      messagesFetched: checkpoint.messagesFetched + batch.length,
      lastSavedAt: new Date(),
    };

    return { ok: true, value: updatedCheckpoint };
  } catch (err) {
    return { ok: false, error: `Failed to save batch: ${toErrorMessage(err)}` };
  }
}

/**
 * Read and parse all batch files from a single directory, returning combined
 * EmailMetadata[]. Reused for both root and backfill run directories.
 */
async function loadBatchesFromDir(dir: string): Promise<Result<EmailMetadata[]>> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    return { ok: false, error: `Failed to read directory ${dir}: ${toErrorMessage(err)}` };
  }

  const batchFiles = entries.filter((name) => BATCH_FILENAME_PATTERN.test(name)).sort();

  const combined: EmailMetadata[] = [];

  for (const filename of batchFiles) {
    const filePath = path.join(dir, filename);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      return { ok: false, error: `Failed to read batch file ${filename}: ${toErrorMessage(err)}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        error: `Batch file ${filename} contains invalid JSON: ${toErrorMessage(err)}`,
      };
    }

    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        error: `Batch file ${filename} does not contain an array`,
      };
    }

    for (const item of parsed) {
      const result = EmailMetadataSchema.safeParse(item);
      if (!result.success) {
        return {
          ok: false,
          error: `Batch file ${filename} contains invalid EmailMetadata: ${result.error.message}`,
        };
      }
      combined.push(result.data);
    }
  }

  return { ok: true, value: combined };
}

/** Name of the checkpoint file within each backfill run directory. */
const BACKFILL_CHECKPOINT_FILENAME = "backfill-checkpoint.json";

/**
 * Load batch files from all completed backfill runs under `{dataDir}/backfills/`.
 *
 * Each subdirectory is a run directory containing a `backfill-checkpoint.json`
 * and zero or more `batch-*.json` files. Only runs with `status === "complete"`
 * have their batches included.
 *
 * Returns `{ ok: true, value: [] }` when no `backfills/` directory exists yet.
 */
async function loadBackfillBatches(dataDir: string): Promise<Result<EmailMetadata[]>> {
  const backfillsDir = path.join(dataDir, "backfills");

  let runDirs: string[];
  try {
    const dirEntries = await fs.readdir(backfillsDir, { withFileTypes: true });
    runDirs = dirEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: true, value: [] };
    }
    return { ok: false, error: `Failed to read backfills directory: ${toErrorMessage(err)}` };
  }

  const combined: EmailMetadata[] = [];

  for (const runDir of runDirs) {
    const runPath = path.join(backfillsDir, runDir);
    const checkpointPath = path.join(runPath, BACKFILL_CHECKPOINT_FILENAME);

    let checkpointRaw: string;
    try {
      checkpointRaw = await fs.readFile(checkpointPath, "utf-8");
    } catch (_err) {
      // No checkpoint file — skip this run directory
      continue;
    }

    let checkpointParsed: unknown;
    try {
      checkpointParsed = JSON.parse(checkpointRaw);
    } catch {
      // Invalid JSON — skip this run
      continue;
    }

    const checkpointResult = BackfillCheckpointSchema.safeParse(checkpointParsed);
    if (!checkpointResult.success) {
      // Invalid checkpoint schema — skip this run
      continue;
    }

    if (checkpointResult.data.status !== "complete") {
      continue;
    }

    const batchResult = await loadBatchesFromDir(runPath);
    if (!batchResult.ok) {
      return batchResult;
    }

    combined.push(...batchResult.value);
  }

  return { ok: true, value: combined };
}

/**
 * Read all batch files from `dataDir` in sorted order and return the combined
 * EmailMetadata array. Also includes batches from completed backfill runs
 * under `{dataDir}/backfills/`.
 *
 * Files are sorted lexicographically by filename, which is correct given the
 * zero-padded naming scheme (batch-00001.json before batch-00002.json).
 */
export async function loadAllBatches(dataDir: string): Promise<Result<EmailMetadata[]>> {
  const rootResult = await loadBatchesFromDir(dataDir);
  if (!rootResult.ok) return rootResult;

  const backfillResult = await loadBackfillBatches(dataDir);
  if (!backfillResult.ok) return backfillResult;

  const combined = [...rootResult.value, ...backfillResult.value];
  return { ok: true, value: combined };
}
