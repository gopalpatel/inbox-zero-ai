/**
 * Metadata Puller — resumable, checkpoint-based email metadata export from O365.
 *
 * Scans the ENTIRE mailbox via `GET /users/{email}/messages`, filters out
 * system folders (Drafts, Sent Items, Deleted Items, Junk Email, Outbox, etc.)
 * client-side, parses each message to the shared `EmailMetadata` contract, and
 * saves results in numbered batch files.
 *
 * Resume support: a checkpoint file records the `@odata.nextLink` URL so that
 * interrupted pulls can continue without re-fetching already-saved pages.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { GraphClient, GraphFolder, GraphMessage } from "../auth/graph-client.js";
import type { EmailMetadata } from "../schemas/email-metadata.js";
import type { Result } from "../types.js";
import { atomicWriteFile, toErrorMessage } from "../utils.js";
import { parseO365Message } from "./message-parser.js";
import { BATCH_FILE_SIZE, EXCLUDED_FOLDER_NAMES, MESSAGE_SELECT_FIELDS, PAGE_SIZE } from "./pull-constants.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Zod schema for runtime validation of checkpoint files on disk. */
const CheckpointBaseSchema = z.object({
  totalPulled: z.number().int().min(0),
  totalErrors: z.number().int().min(0),
  batchesSaved: z.number().int().min(0),
  lastSavedAt: z.string(),
});

const CheckpointSchema = z.discriminatedUnion("status", [
  CheckpointBaseSchema.extend({
    status: z.literal("in_progress"),
    nextLink: z.string().min(1),
  }),
  CheckpointBaseSchema.extend({
    status: z.literal("complete"),
    nextLink: z.string().optional(),
  }),
]);

/** Internal checkpoint persisted between pages for crash recovery. */
type Checkpoint = z.infer<typeof CheckpointSchema>;

/** Summary returned after a pull completes. */
export interface PullResult {
  /** Number of messages successfully parsed and saved. */
  totalPulled: number;
  /** Number of messages that failed to parse. */
  totalErrors: number;
  /** Number of batch files written to disk. */
  batchesSaved: number;
}

/** Options for `pullMetadata()`. */
export interface PullOptions {
  /** Authenticated Graph API client. */
  graph: GraphClient;
  /** Directory for batch files and checkpoint state. */
  dataDir: string;
  /** If true, estimate message count without actually pulling. */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Checkpoint helpers
// ---------------------------------------------------------------------------

/** Resolve the checkpoint file path. */
function checkpointPath(dataDir: string): string {
  return path.join(dataDir, "internal-o365", "checkpoint.json");
}

/** Load a checkpoint from disk, returning undefined if none exists. */
async function loadCheckpoint(dataDir: string): Promise<Checkpoint | undefined> {
  const filePath = checkpointPath(dataDir);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw err;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Corrupt checkpoint file (invalid JSON): ${filePath}`);
  }

  const result = CheckpointSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`Corrupt checkpoint file (invalid shape): ${filePath} — ${result.error.message}`);
  }
  return result.data;
}

/** Persist a checkpoint atomically. */
async function saveCheckpoint(dataDir: string, checkpoint: Checkpoint): Promise<void> {
  const filePath = checkpointPath(dataDir);
  await atomicWriteFile(filePath, JSON.stringify(checkpoint, null, 2));
}

/** Remove the checkpoint file (called after a successful complete pull). */
async function removeCheckpoint(dataDir: string): Promise<void> {
  const filePath = checkpointPath(dataDir);
  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // Already gone — fine.
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Batch file helpers
// ---------------------------------------------------------------------------

/** Build the batch file path with zero-padded 5-digit numbering. */
function batchFilePath(dataDir: string, batchNumber: number): string {
  const padded = String(batchNumber).padStart(5, "0");
  return path.join(dataDir, `batch-${padded}.json`);
}

/** Save a batch of parsed metadata to disk. */
async function saveBatch(dataDir: string, batchNumber: number, records: EmailMetadata[]): Promise<void> {
  const filePath = batchFilePath(dataDir, batchNumber);
  await atomicWriteFile(filePath, JSON.stringify(records, null, 2));
}

// ---------------------------------------------------------------------------
// Folder resolution
// ---------------------------------------------------------------------------

const WELL_KNOWN_EXCLUDED_FOLDERS = ["drafts", "sentitems", "deleteditems", "junkemail", "outbox"] as const;

/** Build the set of folder IDs to exclude, including descendants of excluded parents. */
async function buildExcludedFolderIds(graph: GraphClient, folders: GraphFolder[]): Promise<Set<string>> {
  const excluded = new Set<string>();
  const wellKnownResults = await Promise.all(WELL_KNOWN_EXCLUDED_FOLDERS.map((folder) => graph.getMailFolder(folder)));

  for (const result of wellKnownResults) {
    if (result.ok) {
      excluded.add(result.value.id);
    }
  }

  let changed = true;

  while (changed) {
    changed = false;

    for (const folder of folders) {
      const isDirectlyExcluded = EXCLUDED_FOLDER_NAMES.has(folder.displayName);
      const isDescendantOfExcluded =
        folder.parentFolderId !== undefined && excluded.has(folder.parentFolderId) && !excluded.has(folder.id);

      if (isDirectlyExcluded || isDescendantOfExcluded) {
        if (!excluded.has(folder.id)) {
          excluded.add(folder.id);
          changed = true;
        }
      }
    }
  }

  return excluded;
}

/**
 * Resolve the Inbox folder ID using the locale-independent well-known name API.
 * Falls back to displayName matching if the API call fails, but the well-known
 * name approach is preferred because displayName is localized (e.g. "Posteingang"
 * in German).
 */
async function resolveInboxFolderId(graph: GraphClient, folders: GraphFolder[]): Promise<string | undefined> {
  const result = await graph.getMailFolder("inbox");
  if (result.ok) {
    return result.value.id;
  }
  // Fallback: scan by displayName (locale-dependent, but better than nothing)
  for (const folder of folders) {
    if (folder.displayName === "Inbox") {
      return folder.id;
    }
  }
  return undefined;
}

/** Sum totalItemCount for non-excluded folders (used for dry-run estimates). */
function estimateMessageCount(folders: GraphFolder[], excludedFolderIds: Set<string>): number {
  let total = 0;
  for (const folder of folders) {
    if (!excludedFolderIds.has(folder.id)) {
      total += folder.totalItemCount;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Main puller
// ---------------------------------------------------------------------------

/**
 * Pull email metadata from the O365 mailbox.
 *
 * @param opts - Pull configuration (graph client, data directory, dry-run flag)
 * @returns `Result<PullResult>` — success with counts, or failure with error message
 */
export async function pullMetadata(opts: PullOptions): Promise<Result<PullResult>> {
  const { graph, dataDir, dryRun } = opts;

  // Step 1: Load checkpoint before Graph I/O on real runs.
  let existingCheckpoint: Checkpoint | undefined;
  if (dryRun !== true) {
    try {
      existingCheckpoint = await loadCheckpoint(dataDir);
    } catch (err: unknown) {
      return { ok: false, error: `Cannot resume pull: ${toErrorMessage(err)}` };
    }
    if (existingCheckpoint?.status === "complete") {
      return {
        ok: true,
        value: {
          totalPulled: existingCheckpoint.totalPulled,
          totalErrors: existingCheckpoint.totalErrors,
          batchesSaved: existingCheckpoint.batchesSaved,
        },
      };
    }
  }

  // Step 2: Resolve folders
  const foldersResult = await graph.listFolders();
  if (!foldersResult.ok) {
    return { ok: false, error: `Failed to list folders: ${foldersResult.error}` };
  }
  const folders = foldersResult.value;

  // Step 3: Build excluded folder ID set
  const excludedFolderIds = await buildExcludedFolderIds(graph, folders);

  // Step 4: Dry-run — estimate and return
  if (dryRun === true) {
    const estimate = estimateMessageCount(folders, excludedFolderIds);
    console.log(`Dry-run estimate: ~${estimate} messages in non-excluded folders`);
    return {
      ok: true,
      value: { totalPulled: estimate, totalErrors: 0, batchesSaved: 0 },
    };
  }

  // Step 5: Resolve Inbox folder ID using the well-known name API (locale-independent)
  const inboxFolderId = await resolveInboxFolderId(graph, folders);
  if (inboxFolderId === undefined) {
    return { ok: false, error: "Failed to resolve Inbox folder ID" };
  }

  let totalPulled = existingCheckpoint?.totalPulled ?? 0;
  let totalErrors = existingCheckpoint?.totalErrors ?? 0;
  let batchesSaved = existingCheckpoint?.batchesSaved ?? 0;
  let buffer: EmailMetadata[] = [];

  // Step 6: Fetch first page (or resume from checkpoint)
  let pageResult: Result<{ messages: GraphMessage[]; nextLink?: string }>;

  if (existingCheckpoint?.nextLink !== undefined) {
    // Resume from checkpoint — follow the stored nextLink
    pageResult = await graph.followNextLink(existingCheckpoint.nextLink);
  } else {
    // Fresh pull — start from the beginning
    pageResult = await graph.listMessages({
      select: MESSAGE_SELECT_FIELDS,
      top: PAGE_SIZE,
      orderby: "receivedDateTime desc",
    });
  }

  if (!pageResult.ok) {
    return { ok: false, error: pageResult.error };
  }

  // Step 7: Process pages
  /** Safety limit to prevent infinite loops from buggy API responses. */
  const MAX_PAGES = 10_000;
  let pagesProcessed = 0;

  while (pagesProcessed < MAX_PAGES) {
    const { messages, nextLink } = pageResult.value;

    // Filter out messages from excluded folders
    for (const msg of messages) {
      if (excludedFolderIds.has(msg.parentFolderId)) {
        continue;
      }

      // Parse the message
      const parsed = parseO365Message(msg as unknown as Record<string, unknown>, { inboxFolderId });
      if (!parsed.ok) {
        totalErrors++;
        continue;
      }

      buffer.push(parsed.value);
      totalPulled++;

      // When buffer reaches BATCH_FILE_SIZE, save a batch
      if (buffer.length >= BATCH_FILE_SIZE) {
        const nextBatchNumber = batchesSaved + 1;
        try {
          await saveBatch(dataDir, nextBatchNumber, buffer);
        } catch (err: unknown) {
          return { ok: false, error: `Failed to save batch ${nextBatchNumber}: ${toErrorMessage(err)}` };
        }
        batchesSaved = nextBatchNumber;
        buffer = [];
      }
    }

    pagesProcessed++;

    // Persist everything from the current page before advancing the checkpoint.
    // This keeps resume page-aligned and avoids losing the tail of a partially
    // processed page after a crash.
    if (buffer.length > 0) {
      const nextBatchNumber = batchesSaved + 1;
      try {
        await saveBatch(dataDir, nextBatchNumber, buffer);
      } catch (err: unknown) {
        return { ok: false, error: `Failed to save batch ${nextBatchNumber}: ${toErrorMessage(err)}` };
      }
      batchesSaved = nextBatchNumber;
      buffer = [];
    }

    try {
      const lastSavedAt = new Date().toISOString();
      if (nextLink === undefined) {
        await saveCheckpoint(dataDir, {
          status: "complete",
          totalPulled,
          totalErrors,
          batchesSaved,
          lastSavedAt,
        });
      } else {
        await saveCheckpoint(dataDir, {
          status: "in_progress",
          totalPulled,
          totalErrors,
          batchesSaved,
          nextLink,
          lastSavedAt,
        });
      }
    } catch (err: unknown) {
      return { ok: false, error: `Failed to save checkpoint: ${toErrorMessage(err)}` };
    }

    // Follow nextLink for next page
    if (nextLink === undefined) {
      break;
    }

    // Check the page safety cap BEFORE fetching the next page
    if (pagesProcessed >= MAX_PAGES) {
      return { ok: false, error: `Export truncated after reaching MAX_PAGES (${MAX_PAGES})` };
    }

    const nextPageResult = await graph.followNextLink(nextLink);
    if (!nextPageResult.ok) {
      return { ok: false, error: nextPageResult.error };
    }
    pageResult = nextPageResult;
  }

  // Step 8: Clean up checkpoint after successful completion
  try {
    await removeCheckpoint(dataDir);
  } catch (err: unknown) {
    return { ok: false, error: `Failed to remove checkpoint: ${toErrorMessage(err)}` };
  }

  return {
    ok: true,
    value: { totalPulled, totalErrors, batchesSaved },
  };
}
