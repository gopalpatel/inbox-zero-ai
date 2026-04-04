/**
 * Shared utility classes and functions used across the inbox-zero-o365 codebase.
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
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tmpPath = path.join(
    directory,
    `${basename}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  try {
    await fs.writeFile(tmpPath, content, "utf-8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Semaphore — bounded concurrency
// ---------------------------------------------------------------------------

/**
 * Simple counting semaphore that limits the number of concurrent async tasks.
 */
export class Semaphore {
  private readonly maxConcurrent: number;
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new RangeError("Semaphore: maxConcurrent must be a positive integer");
    }
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
    // Permit was transferred directly by release() — no increment needed.
  }

  release(): void {
    if (this.running === 0) {
      throw new Error("Semaphore: release called without a matching acquire");
    }
    const next = this.queue.shift();
    if (next !== undefined) {
      // Transfer the permit directly to the queued waiter without decrementing.
      // This prevents a concurrent acquire() from slipping in between decrement
      // and the waiter's resume, which would exceed maxConcurrent.
      next();
      return;
    }
    this.running--;
  }
}

// ---------------------------------------------------------------------------
// chunkArray — splits an array into fixed-size chunks
// ---------------------------------------------------------------------------

/**
 * Splits an array into chunks of at most `size` elements.
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
 */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// GRAPH_BATCH_CHUNK_SIZE — O365 batch API limit
// ---------------------------------------------------------------------------

/** O365 Graph batch API hard limit: max requests per $batch call. */
export const GRAPH_BATCH_CHUNK_SIZE = 20;

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
