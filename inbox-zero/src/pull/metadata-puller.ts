/**
 * metadata-puller.ts
 *
 * Fetches all Gmail message metadata for an account and saves it to disk in
 * checkpoint-safe batches.
 *
 * Design decisions:
 * - Bounded concurrency (MAX_CONCURRENT) for getMessage calls prevents
 *   flooding the Gmail API when processing large accounts (671k+ messages).
 * - Every BATCH_SIZE messages the in-memory buffer is flushed to disk and a
 *   checkpoint is saved, making the pull resumable after any crash.
 * - Dry-run mode fetches only the first page, reports the estimated total, and
 *   exits without writing any data.
 * - Errors from individual getMessage or parse failures are recorded in the
 *   checkpoint and processing continues (never swallowed silently).
 */

import type { GmailClient } from "../auth/gmail-client.js";
import type { Checkpoint } from "../schemas/checkpoint.js";
import type { EmailMetadata } from "../schemas/email-metadata.js";
import type { Result } from "../types.js";
import { Semaphore } from "../utils.js";
import { BATCH_SIZE, loadCheckpoint, saveBatch, saveCheckpoint } from "./checkpoint-manager.js";
import { parseGmailMessage } from "./message-parser.js";
import { MAX_CONCURRENT, METADATA_HEADERS } from "./pull-constants.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Gmail query that covers all messages except spam, trash, drafts, and sent. */
const PULL_QUERY = "in:anywhere -in:spam -in:trash -in:drafts -in:sent";

/**
 * Maximum number of results per listMessages call.
 * Gmail API allows up to 500; we request the full allowed amount per page.
 */
const LIST_PAGE_SIZE = 500;

/**
 * Safety cap on the number of pagination iterations.
 * At 500 results/page and 671k messages this is ~1400 pages.
 * Cap at 2000 to protect against runaway loops from buggy token cycling.
 */
const MAX_PAGES = 2000;

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface PullOptions {
  /** Authenticated Gmail client. */
  client: GmailClient;
  /** Directory where checkpoint and batch files will be written. */
  dataDir: string;
  /**
   * When true, fetches only the first page, logs the estimated total, and
   * exits without saving any data.
   */
  dryRun?: boolean;
  /**
   * Optional progress callback invoked after each batch is saved.
   * `fetched` is the total messages successfully parsed so far.
   * `total` is the current messagesFetched counter from the checkpoint.
   * `batchesSaved` is the number of batches written.
   */
  onProgress?: (progress: { fetched: number; total: number; batchesSaved: number }) => void;
}

export interface PullResult {
  /** Total messages successfully parsed and saved. */
  messagesFetched: number;
  /** Number of batch files written. */
  batchesSaved: number;
  /** Errors recorded during the pull (parse failures, getMessage errors). */
  errors: Checkpoint["errors"];
  /**
   * Estimated total from Gmail's `resultSizeEstimate`.
   * Only populated in dry-run mode.
   */
  resultSizeEstimate?: number;
}

// ---------------------------------------------------------------------------
// Main pull function
// ---------------------------------------------------------------------------

/**
 * Fetches all Gmail message metadata matching `PULL_QUERY` and saves them to
 * `dataDir` in BATCH_SIZE batches with periodic checkpointing.
 *
 * Resumes from an existing checkpoint when one is present in `dataDir`.
 *
 * Never throws — all errors are returned in the `Result` value.
 */
export async function pull(options: PullOptions): Promise<Result<PullResult>> {
  const { client, dataDir, dryRun = false, onProgress } = options;

  // -------------------------------------------------------------------------
  // Load or initialise checkpoint
  // -------------------------------------------------------------------------

  const checkpointLoadResult = await loadCheckpoint(dataDir);

  let checkpoint: Checkpoint;

  if (checkpointLoadResult.ok) {
    checkpoint = checkpointLoadResult.value;
  } else if (checkpointLoadResult.error.includes("fresh start")) {
    // No checkpoint file found — this is a fresh start, create a new one.
    checkpoint = {
      status: "in_progress",
      query: PULL_QUERY,
      pageToken: null,
      messagesFetched: 0,
      batchesSaved: 0,
      lastSavedAt: new Date(),
      errors: [],
    };
  } else {
    // Checkpoint file exists but is corrupt or unreadable — do not silently
    // start fresh as that could lead to duplicate data.
    return {
      ok: false,
      error: `Cannot resume: ${checkpointLoadResult.error}`,
    };
  }

  // -------------------------------------------------------------------------
  // Dry-run: always fetch a fresh estimate from Gmail, even if a completed
  // checkpoint exists (stale counts would be misleading).
  // -------------------------------------------------------------------------

  if (dryRun) {
    const listResult = await client.listMessages(PULL_QUERY, undefined, LIST_PAGE_SIZE);

    if (!listResult.ok) {
      return { ok: false, error: `listMessages failed: ${listResult.error}` };
    }

    const estimate = listResult.value.resultSizeEstimate ?? 0;

    return {
      ok: true,
      value: {
        messagesFetched: 0,
        batchesSaved: 0,
        errors: [],
        resultSizeEstimate: estimate,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Guard: if checkpoint is already complete, return immediately
  // -------------------------------------------------------------------------

  if (checkpoint.status === "complete") {
    return {
      ok: true,
      value: {
        messagesFetched: checkpoint.messagesFetched,
        batchesSaved: checkpoint.batchesSaved,
        errors: checkpoint.errors,
      },
    };
  }

  // Guard: if checkpoint previously failed, log warning and resume
  if (checkpoint.status === "failed") {
    console.warn("metadata-puller: resuming from a previously failed checkpoint");
    // Reset status to in_progress so the pull continues
    checkpoint = { ...checkpoint, status: "in_progress" };
  }

  // -------------------------------------------------------------------------
  // Full pull loop
  // -------------------------------------------------------------------------

  let pageToken: string | undefined = checkpoint.pageToken ?? undefined;

  // In-memory buffer of parsed messages not yet written to disk.
  const buffer: EmailMetadata[] = [];

  // Mutable errors array — avoids quadratic [...checkpoint.errors, newError] copies.
  const errors = [...checkpoint.errors];

  const semaphore = new Semaphore(MAX_CONCURRENT);

  let pagesProcessed = 0;

  while (pagesProcessed < MAX_PAGES) {
    // -- List a page of message IDs ----------------------------------------

    const listResult = await client.listMessages(PULL_QUERY, pageToken, LIST_PAGE_SIZE);

    if (!listResult.ok) {
      // Record page-level error and stop pagination
      errors.push({
        timestamp: new Date(),
        message: `listMessages failed: ${listResult.error}`,
        pageToken: pageToken ?? null,
      });
      checkpoint = {
        ...checkpoint,
        status: "failed",
        pageToken: pageToken ?? null,
        errors,
      };
      await saveCheckpoint(checkpoint, dataDir);
      return { ok: false, error: `listMessages failed: ${listResult.error}` };
    }

    const { messages: messageStubs, nextPageToken } = listResult.value;
    pagesProcessed++;

    // -- Fetch full metadata for each message ID (bounded concurrency) ------

    const fetchTasks = messageStubs.map((stub) => async (): Promise<{ id: string; result: Result<EmailMetadata> }> => {
      await semaphore.acquire();
      try {
        const msgResult = await client.getMessage(stub.id, "metadata", [...METADATA_HEADERS]);

        if (!msgResult.ok) {
          return {
            id: stub.id,
            result: { ok: false, error: msgResult.error },
          };
        }

        const parsed = parseGmailMessage(msgResult.value);
        return { id: stub.id, result: parsed };
      } finally {
        semaphore.release();
      }
    });

    // Execute all tasks for this page concurrently (semaphore caps at MAX_CONCURRENT)
    const pageResults = await Promise.all(fetchTasks.map((task) => task()));

    // -- Process results: accumulate successes, record errors ---------------

    for (const { id, result } of pageResults) {
      if (!result.ok) {
        errors.push({
          timestamp: new Date(),
          message: `Message ${id}: ${result.error}`,
          pageToken: pageToken ?? null,
        });
        checkpoint = { ...checkpoint, errors };
      } else {
        buffer.push(result.value);
      }
    }

    // -- Flush buffer when it reaches BATCH_SIZE ----------------------------

    while (buffer.length >= BATCH_SIZE) {
      const batch = buffer.splice(0, BATCH_SIZE);
      const batchResult = await saveBatch(batch, checkpoint, dataDir);

      if (!batchResult.ok) {
        errors.push({
          timestamp: new Date(),
          message: `saveBatch failed: ${batchResult.error}`,
          pageToken: nextPageToken ?? null,
        });
        checkpoint = {
          ...checkpoint,
          status: "failed",
          errors,
        };
        await saveCheckpoint(checkpoint, dataDir);
        return {
          ok: false,
          error: `saveBatch failed: ${batchResult.error}`,
        };
      }

      checkpoint = {
        ...batchResult.value,
        pageToken: nextPageToken ?? null,
        errors,
      };

      const saveResult = await saveCheckpoint(checkpoint, dataDir);
      if (!saveResult.ok) {
        // Fatal: a failed mid-pull checkpoint means resume state lags behind
        // persisted batch data. Continuing would cause page replay on restart.
        errors.push({
          timestamp: new Date(),
          message: `saveCheckpoint failed: ${saveResult.error}`,
          pageToken: nextPageToken ?? null,
        });
        checkpoint = { ...checkpoint, status: "failed", errors };
        await saveCheckpoint(checkpoint, dataDir);
        return {
          ok: false,
          error: `saveCheckpoint failed: ${saveResult.error}`,
        };
      }

      // Fire progress callback
      if (onProgress !== undefined) {
        onProgress({
          fetched: checkpoint.messagesFetched,
          total: checkpoint.messagesFetched,
          batchesSaved: checkpoint.batchesSaved,
        });
      }
    }

    // -- Advance page token or finish ---------------------------------------

    if (!nextPageToken) {
      // No more pages — flush remaining buffer
      if (buffer.length > 0) {
        const remainingBatch = buffer.splice(0, buffer.length);
        const batchResult = await saveBatch(remainingBatch, checkpoint, dataDir);

        if (batchResult.ok) {
          checkpoint = {
            ...batchResult.value,
            pageToken: null,
          };

          // Fire progress after final batch
          if (onProgress !== undefined) {
            onProgress({
              fetched: checkpoint.messagesFetched,
              total: checkpoint.messagesFetched,
              batchesSaved: checkpoint.batchesSaved,
            });
          }
        } else {
          errors.push({
            timestamp: new Date(),
            message: `saveBatch (final) failed: ${batchResult.error}`,
            pageToken: null,
          });
          checkpoint = {
            ...checkpoint,
            status: "failed",
            pageToken: null,
            errors,
          };
          await saveCheckpoint(checkpoint, dataDir);
          return {
            ok: false,
            error: `saveBatch (final) failed: ${batchResult.error}`,
          };
        }
      }

      // Mark complete
      checkpoint = {
        ...checkpoint,
        status: "complete",
        pageToken: null,
      };

      const finalSaveResult = await saveCheckpoint(checkpoint, dataDir);
      if (!finalSaveResult.ok) {
        return {
          ok: false,
          error: `Final saveCheckpoint failed: ${finalSaveResult.error}`,
        };
      }
      break;
    }

    pageToken = nextPageToken;
    checkpoint = {
      ...checkpoint,
      pageToken,
    };
  }

  return {
    ok: true,
    value: {
      messagesFetched: checkpoint.messagesFetched,
      batchesSaved: checkpoint.batchesSaved,
      errors: checkpoint.errors,
    },
  };
}
