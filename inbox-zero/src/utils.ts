/**
 * Shared utility classes and functions used across the inbox-zero codebase.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// atomicWriteFile — crash-safe file writes with auto-mkdir
// ---------------------------------------------------------------------------

/**
 * Atomically write content to a file using a temp file + rename strategy.
 * Prevents partial writes from corrupting existing data on crash.
 * Creates parent directories if they do not exist.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Semaphore — bounded concurrency
// ---------------------------------------------------------------------------

/**
 * Simple counting semaphore that limits the number of concurrent async tasks.
 *
 * Usage:
 *   const sem = new Semaphore(5);
 *   await sem.acquire();
 *   try { ... } finally { sem.release(); }
 */
export class Semaphore {
  private readonly maxConcurrent: number;
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
    this.running++;
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next !== undefined) {
      next();
    }
  }
}

// ---------------------------------------------------------------------------
// chunkArray — splits an array into fixed-size chunks
// ---------------------------------------------------------------------------

/**
 * Splits an array into chunks of at most `size` elements.
 *
 * @param arr  The input array.
 * @param size Maximum number of elements per chunk.
 * @returns Array of sub-arrays, each with at most `size` elements.
 */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new RangeError("chunkArray: size must be positive");
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// toErrorMessage — safe error stringification
// ---------------------------------------------------------------------------

/**
 * Extracts a human-readable message from an unknown caught value.
 * Replaces inline `err instanceof Error ? err.message : String(err)` ternaries.
 */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// getHeader — extract a header from Gmail API headers
// ---------------------------------------------------------------------------

/**
 * Extracts a named header value from a Gmail API `payload.headers` array.
 * Matching is case-insensitive per RFC 5321.
 * Returns `undefined` when the header is absent.
 */
export function getHeader(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (
      h.name !== undefined &&
      h.name !== null &&
      h.name.toLowerCase() === lower &&
      h.value !== undefined &&
      h.value !== null
    ) {
      return h.value;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// BATCH_MODIFY_CHUNK_SIZE — Gmail batchModify hard limit
// ---------------------------------------------------------------------------

/** Gmail batchModify hard limit: max message IDs per call. */
export const BATCH_MODIFY_CHUNK_SIZE = 1_000;

// ---------------------------------------------------------------------------
// TWELVE_MONTHS_MS — shared time constant
// ---------------------------------------------------------------------------

/** 12 months in milliseconds — used to decide whether a thread is actionable. */
export const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// formatYMD — YYYY-MM-DD date formatter (UTC)
// ---------------------------------------------------------------------------

/**
 * Formats a Date as `YYYY-MM-DD` using UTC components.
 */
export function formatYMD(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// emailDomain — extract domain from email address
// ---------------------------------------------------------------------------

/**
 * Returns the lowercase domain of an email address (after `@`).
 * Returns an empty string for malformed addresses without `@`.
 */
export function emailDomain(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) return "";
  return email.slice(atIndex + 1).toLowerCase();
}
