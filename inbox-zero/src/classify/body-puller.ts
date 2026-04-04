/**
 * body-puller.ts
 *
 * Fetches full message bodies for a set of message IDs with bounded
 * concurrency and checkpointing.
 *
 * Design decisions:
 * - Uses a Semaphore (same pattern as metadata-puller) for bounded concurrency.
 * - Saves progress to a SEPARATE checkpoint file (`body-checkpoint.json`) so
 *   it does not conflict with the metadata puller's `checkpoint.json`.
 * - Prefers `text/plain` MIME part; falls back to `text/html` with basic tag
 *   stripping if no plain-text part exists.
 * - Failed getMessage calls yield an empty string (never throws).
 * - HTML tag stripping uses a bounded regex to satisfy the ReDoS-prevention
 *   security standard.
 * - Cache/checkpoint persistence failures are fatal so resume state cannot
 *   silently drift behind fetched content.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { gmail_v1 } from "googleapis";
import type { GmailClient } from "../auth/gmail-client.js";
import type { Result } from "../types.js";
import { Semaphore } from "../utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Filename for the body-pull checkpoint (distinct from metadata checkpoint). */
const BODY_CHECKPOINT_FILENAME = "body-checkpoint.json";

/** Filename for the persisted body-text cache used for true resume support. */
const BODY_CACHE_FILENAME = "body-cache.json";

/** Default number of messages fetched per batch before checkpointing. */
const DEFAULT_BATCH_SIZE = 50;

/** Maximum concurrent getMessage calls. */
const MAX_CONCURRENT = 10;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface BodyCheckpoint {
  /** Set of messageIds whose bodies have been successfully fetched. */
  completedIds: string[];
  savedAt: string;
}

interface BodyCache {
  bodies: Record<string, string>;
  savedAt: string;
}

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface PullBodiesOptions {
  /** Authenticated Gmail client. */
  client: GmailClient;
  /** Message IDs to fetch bodies for. */
  messageIds: string[];
  /** Directory where the body checkpoint file will be written. */
  dataDir: string;
  /**
   * Number of messages processed before saving a checkpoint.
   * Defaults to DEFAULT_BATCH_SIZE.
   */
  batchSize?: number;
}

// ---------------------------------------------------------------------------
// HTML tag stripping
// ---------------------------------------------------------------------------

/**
 * Strips HTML tags from a string using a bounded regex.
 * All quantifiers are bounded to prevent ReDoS.
 */
function stripHtmlTags(html: string): string {
  // Replace HTML tags with a space; quantifier bounded to prevent ReDoS.
  return html
    .replace(/<[^>]{0,2000}>/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// MIME body extraction
// ---------------------------------------------------------------------------

/**
 * Decodes a base64url-encoded Gmail body data string.
 */
function decodeBodyData(data: string): string {
  // Gmail uses base64url encoding (- and _ instead of + and /).
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

/**
 * Recursively walks a Gmail message payload to find the best body text.
 *
 * Priority:
 * 1. `text/plain` part (preferred)
 * 2. `text/html` part (fallback — tags will be stripped by caller)
 *
 * Returns `{ text, mimeType }` for the best match, or `null` if nothing found.
 */
function extractBodyFromPayload(
  payload: gmail_v1.Schema$MessagePart | undefined,
): { text: string; mimeType: "text/plain" | "text/html" } | null {
  if (payload === undefined) return null;

  // Safety limit on recursion depth to guard against pathological payloads.
  return walkPart(payload, 0);
}

function walkPart(
  part: gmail_v1.Schema$MessagePart,
  depth: number,
): { text: string; mimeType: "text/plain" | "text/html" } | null {
  // Guard against excessively deep MIME trees.
  const MAX_DEPTH = 10;
  if (depth > MAX_DEPTH) return null;

  const mimeType = part.mimeType ?? "";

  // Direct text/plain
  if (mimeType === "text/plain") {
    const data = part.body?.data;
    if (data !== undefined && data !== null && data.length > 0) {
      return { text: decodeBodyData(data), mimeType: "text/plain" };
    }
    return { text: "", mimeType: "text/plain" };
  }

  // Direct text/html
  if (mimeType === "text/html") {
    const data = part.body?.data;
    if (data !== undefined && data !== null && data.length > 0) {
      return { text: decodeBodyData(data), mimeType: "text/html" };
    }
    return { text: "", mimeType: "text/html" };
  }

  // Multipart — recurse into sub-parts, preferring text/plain
  if (mimeType.startsWith("multipart/") && Array.isArray(part.parts)) {
    let htmlResult: { text: string; mimeType: "text/html" } | null = null;

    for (const subPart of part.parts) {
      const result = walkPart(subPart, depth + 1);
      if (result === null) continue;

      if (result.mimeType === "text/plain") {
        // Plain text wins immediately
        return result;
      }
      if (result.mimeType === "text/html" && htmlResult === null) {
        htmlResult = result as { text: string; mimeType: "text/html" };
      }
    }

    return htmlResult;
  }

  return null;
}

/**
 * Extracts the best available body text from a Gmail message.
 *
 * @returns Plain text body. HTML bodies have tags stripped.
 *          Returns empty string when no body is available.
 */
function extractBodyText(message: gmail_v1.Schema$Message): string {
  const result = extractBodyFromPayload(message.payload);

  if (result === null) return "";

  if (result.mimeType === "text/plain") {
    return result.text;
  }

  // HTML fallback — strip tags
  return stripHtmlTags(result.text);
}

// ---------------------------------------------------------------------------
// Checkpoint helpers
// ---------------------------------------------------------------------------

async function loadBodyCheckpoint(dataDir: string): Promise<Set<string>> {
  const filePath = path.join(dataDir, BODY_CHECKPOINT_FILENAME);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return new Set();
    // Non-ENOENT error — log warning and return empty set (fresh start).
    console.warn(`body-puller: unexpected error reading checkpoint (${code ?? "unknown"}), starting fresh`);
    return new Set();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }

  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "completedIds" in parsed &&
    Array.isArray((parsed as BodyCheckpoint).completedIds)
  ) {
    return new Set((parsed as BodyCheckpoint).completedIds);
  }

  return new Set();
}

async function loadBodyCache(dataDir: string): Promise<Map<string, string>> {
  const filePath = path.join(dataDir, BODY_CACHE_FILENAME);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return new Map();
    console.warn(`body-puller: unexpected error reading cache (${code ?? "unknown"}), starting fresh`);
    return new Map();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }

  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "bodies" in parsed &&
    typeof (parsed as BodyCache).bodies === "object" &&
    (parsed as BodyCache).bodies !== null
  ) {
    return new Map(
      Object.entries((parsed as BodyCache).bodies).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }

  return new Map();
}

async function saveBodyCheckpoint(dataDir: string, completedIds: Set<string>): Promise<void> {
  const checkpoint: BodyCheckpoint = {
    completedIds: Array.from(completedIds),
    savedAt: new Date().toISOString(),
  };

  const filePath = path.join(dataDir, BODY_CHECKPOINT_FILENAME);
  const tmpPath = `${filePath}.tmp`;
  const serialized = JSON.stringify(checkpoint, null, 2);

  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(tmpPath, serialized, "utf-8");
  await fs.rename(tmpPath, filePath);
}

async function saveBodyCache(dataDir: string, cache: Map<string, string>): Promise<void> {
  const filePath = path.join(dataDir, BODY_CACHE_FILENAME);
  const tmpPath = `${filePath}.tmp`;
  const serialized = JSON.stringify(
    {
      bodies: Object.fromEntries(cache),
      savedAt: new Date().toISOString(),
    } satisfies BodyCache,
    null,
    2,
  );

  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(tmpPath, serialized, "utf-8");
  await fs.rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Main pullBodies function
// ---------------------------------------------------------------------------

/**
 * Fetches full message body text for all given messageIds.
 *
 * - Uses `getMessage(id, "full")` for each message.
 * - Extracts `text/plain` preferentially; falls back to HTML with tag stripping.
 * - Saves a checkpoint every `batchSize` messages so pulls can resume.
 * - Returns a `Map<messageId, bodyText>`. Failed fetches map to empty string.
 * - Gmail fetch failures map to empty strings; persistence failures return an
 *   error so callers do not continue with stale resume state.
 */
export async function pullBodies(options: PullBodiesOptions): Promise<Result<Map<string, string>>> {
  const { client, messageIds, dataDir, batchSize = DEFAULT_BATCH_SIZE } = options;

  if (messageIds.length === 0) {
    return { ok: true, value: new Map() };
  }

  // Load existing checkpoint plus persisted bodies for true resume support.
  const completedIds = await loadBodyCheckpoint(dataDir);
  const cachedBodies = await loadBodyCache(dataDir);

  // Filter out only IDs that are both checkpointed and present in the cache.
  const pending = messageIds.filter((id) => !(completedIds.has(id) && cachedBodies.has(id)));

  const bodyMap = new Map<string, string>();
  for (const id of messageIds) {
    const cachedBody = cachedBodies.get(id);
    if (cachedBody !== undefined) {
      bodyMap.set(id, cachedBody);
    }
  }

  const semaphore = new Semaphore(MAX_CONCURRENT);

  // Process pending IDs in batches for checkpointing.
  let batchBuffer: Array<{ id: string; body: string }> = [];

  const processBatch = async (batch: string[]): Promise<void> => {
    const tasks = batch.map((id) => async (): Promise<{ id: string; body: string }> => {
      await semaphore.acquire();
      try {
        const result = await client.getMessage(id, "full");
        if (!result.ok) {
          return { id, body: "" };
        }
        const body = extractBodyText(result.value);
        return { id, body };
      } finally {
        semaphore.release();
      }
    });

    const results = await Promise.all(tasks.map((t) => t()));
    for (const { id, body } of results) {
      batchBuffer.push({ id, body });
    }
  };

  // Process in batches for checkpointing.
  let i = 0;
  // Safety limit: cap iterations to avoid infinite loop if batchSize is 0.
  const safeBatchSize = batchSize > 0 ? batchSize : DEFAULT_BATCH_SIZE;
  const maxIterations = Math.ceil(pending.length / safeBatchSize) + 1;
  let iterations = 0;

  while (i < pending.length && iterations < maxIterations) {
    iterations++;
    const chunk = pending.slice(i, i + safeBatchSize);
    i += chunk.length;

    await processBatch(chunk);

    // Flush buffer into bodyMap and update completedIds.
    for (const { id, body } of batchBuffer) {
      bodyMap.set(id, body);
      cachedBodies.set(id, body);
      completedIds.add(id);
    }

    // Save cache + checkpoint after each batch.
    try {
      await saveBodyCache(dataDir, cachedBodies);
      await saveBodyCheckpoint(dataDir, completedIds);
    } catch (err: unknown) {
      return {
        ok: false,
        error: `Failed to persist body pull progress: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    batchBuffer = [];
  }

  return { ok: true, value: bodyMap };
}
