/**
 * Sweep module — periodic noise archival driven by the decision log.
 *
 * Reads the persisted decision log, identifies senders whose latest decision
 * is "filter" or "unsubscribe", queries Gmail for their messages still in
 * inbox, and archives them (remove INBOX label, add noise label).
 *
 * Design decisions:
 * - Batches senders into OR-based Gmail queries bounded by BOTH a sender
 *   count cap and a character-length cap (Gmail has ~1500 char query limits).
 * - Paginates each query with a safety cap of 100 pages to prevent runaway loops.
 * - Dry-run mode queries but does not modify.
 * - Uses Result pattern throughout — never throws on expected failures.
 */

import type { GmailClient } from "../auth/gmail-client.js";
import { collectNoiseSenders } from "../state/decision-log-manager.js";
import type { Result } from "../types.js";
import { BATCH_MODIFY_CHUNK_SIZE, chunkArray, toErrorMessage } from "../utils.js";
import { buildOrQueries } from "./query-builder.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max senders per OR-based Gmail query. */
const DEFAULT_MAX_SENDERS_PER_QUERY = 25;

/** Safety cap on pagination pages per query to prevent runaway loops. */
const MAX_PAGES_PER_QUERY = 100;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options controlling which senders are swept and how Gmail is queried. */
export interface SweepOptions {
  gmailClient: GmailClient;
  decisionLogPath: string;
  noiseLabelId: string;
  /** Secondary cap on senders per query batch. Default 25. */
  maxSendersPerQuery?: number;
  /** Primary cap on query string length. Default 1200. */
  maxQueryChars?: number;
  /** When true, queries Gmail but does not modify messages. */
  dryRun?: boolean;
  /** Progress callback fired after each query batch is processed. */
  onProgress?: (info: { queriesSent: number; messagesSwept: number }) => void;
}

/** Aggregate statistics returned after a sweep run completes. */
export interface SweepResult {
  queriesSent: number;
  messagesFound: number;
  messagesSwept: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// buildSweepQueries — thin wrapper over shared buildOrQueries
// ---------------------------------------------------------------------------

/**
 * Build Gmail OR-based `from:` queries, respecting both a sender-count cap
 * and a character-length cap.
 *
 * Each returned string is a complete Gmail query like:
 *   `in:inbox (from:a@x.com OR from:b@y.com)`
 *
 * At least one sender is always included per batch, even if that single
 * sender's query exceeds `maxQueryChars`.
 */
export function buildSweepQueries(
  senderEmails: string[],
  maxSendersPerQuery: number,
  maxQueryChars: number,
): string[] {
  return buildOrQueries(senderEmails, {
    maxChars: maxQueryChars,
    maxSendersPerBatch: maxSendersPerQuery,
    wrapQuery: (inner) => `in:inbox (${inner})`,
  });
}

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

/**
 * Main sweep function — reads the decision log, identifies noise senders,
 * queries Gmail for their messages still in inbox, and archives them.
 *
 * @returns Result containing sweep statistics or an error string.
 */
export async function sweep(options: SweepOptions): Promise<Result<SweepResult>> {
  const {
    gmailClient,
    decisionLogPath,
    noiseLabelId,
    maxSendersPerQuery = DEFAULT_MAX_SENDERS_PER_QUERY,
    maxQueryChars,
    dryRun = false,
    onProgress,
  } = options;

  if (maxSendersPerQuery <= 0) {
    return { ok: false, error: "maxSendersPerQuery must be positive" };
  }
  if (maxQueryChars !== undefined && maxQueryChars <= 0) {
    return { ok: false, error: "maxQueryChars must be positive" };
  }

  // 1. Collect noise senders from the decision log
  const noiseResult = await collectNoiseSenders(decisionLogPath);
  if (!noiseResult.ok) {
    return { ok: false, error: noiseResult.error };
  }

  if (noiseResult.value === null || noiseResult.value.allNoiseSenders.length === 0) {
    return {
      ok: true,
      value: { queriesSent: 0, messagesFound: 0, messagesSwept: 0, errors: [] },
    };
  }

  const { allNoiseSenders } = noiseResult.value;

  // 2. Build batched Gmail queries
  const queryOptions: Parameters<typeof buildOrQueries>[1] = {
    maxSendersPerBatch: maxSendersPerQuery,
    wrapQuery: (inner) => `in:inbox (${inner})`,
  };
  if (maxQueryChars !== undefined) {
    queryOptions.maxChars = maxQueryChars;
  }
  const queries = buildOrQueries(allNoiseSenders, queryOptions);

  // 3. Execute queries and collect message IDs
  let queriesSent = 0;
  let totalMessagesFound = 0;
  let totalMessagesSwept = 0;
  const errors: string[] = [];

  for (const query of queries) {
    queriesSent++;

    try {
      // Paginate through all results for this query batch
      const batchMessageIds: string[] = [];
      let pageToken: string | undefined;
      let pageCount = 0;
      let paginationFailed = false;

      do {
        const listResult = await gmailClient.listMessages(query, pageToken);

        if (!listResult.ok) {
          errors.push(`listMessages failed for query batch ${queriesSent}: ${listResult.error}`);
          paginationFailed = true;
          break;
        }

        for (const m of listResult.value.messages) {
          batchMessageIds.push(m.id);
        }

        pageToken = listResult.value.nextPageToken;
        pageCount++;
      } while (pageToken !== undefined && pageCount < MAX_PAGES_PER_QUERY);

      // Fix 8: Pagination cap warning
      if (!paginationFailed && pageToken !== undefined) {
        errors.push(`Pagination capped at ${MAX_PAGES_PER_QUERY} pages for query batch ${queriesSent}; some messages may not have been swept.`);
      }

      if (paginationFailed) {
        try { onProgress?.({ queriesSent, messagesSwept: totalMessagesSwept }); } catch { /* non-fatal */ }
        continue;
      }

      totalMessagesFound += batchMessageIds.length;

      // 4. Archive messages (unless dry run)
      if (!dryRun && batchMessageIds.length > 0) {
        const chunks = chunkArray(batchMessageIds, BATCH_MODIFY_CHUNK_SIZE);
        for (const chunk of chunks) {
          try {
            const modifyResult = await gmailClient.batchModifyMessages(
              chunk,
              [noiseLabelId],
              ["INBOX"],
            );

            if (!modifyResult.ok) {
              errors.push(`batchModify failed for query batch ${queriesSent}: ${modifyResult.error}`);
              break;
            }

            totalMessagesSwept += chunk.length;
          } catch (err: unknown) {
            errors.push(`batchModify threw for query batch ${queriesSent}: ${toErrorMessage(err)}`);
            break;
          }
        }
      }

      try { onProgress?.({ queriesSent, messagesSwept: totalMessagesSwept }); } catch { /* non-fatal */ }
    } catch (err: unknown) {
      errors.push(`Query batch ${queriesSent} threw: ${toErrorMessage(err)}`);
    }
  }

  return {
    ok: true,
    value: {
      queriesSent,
      messagesFound: totalMessagesFound,
      messagesSwept: totalMessagesSwept,
      errors,
    },
  };
}
