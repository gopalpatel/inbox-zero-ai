/**
 * action-pass.ts
 *
 * Action-pass review workflow: builds a markdown report of triage-queue items
 * grouped by category, and finalizes review decisions (star / archive) by
 * modifying Gmail labels in bulk.
 *
 * Design decisions:
 * - `buildActionReport` reads from Gmail at call time (no cached state).
 * - If the triage queue exceeds MAX_MESSAGES_SAFETY, report generation aborts
 *   rather than silently truncating the review set.
 * - If any representative message cannot be fetched, report generation aborts
 *   rather than producing a partial review document.
 * - `finalizeReview` separates star vs. archive decisions and chunks each write
 *   to Gmail's 1000-ID `batchModifyMessages` limit.
 * - Dry-run mode is first-class: returns correct counts with zero API calls.
 * - All public functions return `Result<T>`; never throw.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { gmail_v1 } from "googleapis";
import type { GmailClient } from "../auth/gmail-client.js";
import type { Result } from "../types.js";
import { chunkArray, formatYMD, getHeader as getHeaderUtil, Semaphore, toErrorMessage } from "../utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Gmail search query that finds all messages awaiting action-pass review.
 * Exported for testing.
 */
export const TRIAGE_QUERY = "label:_triage";

/** Metadata headers to request from Gmail when building the report. */
const REPORT_HEADERS = ["Subject", "From", "Date"] as const;

/** Maximum results per listMessages page. */
const MAX_RESULTS_PER_PAGE = 500;

/** Safety limit on total messages fetched. */
const MAX_MESSAGES_SAFETY = 10_000;

/** Maximum concurrent getMessage calls. */
const MAX_CONCURRENT = 10;

/** Gmail batchModify hard limit. */
const BATCH_MODIFY_CHUNK_SIZE = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildReportResult {
  /** Absolute path to the written markdown report file. */
  reportPath: string;
  /** Number of triage threads included in the report. */
  itemCount: number;
}

export interface FinalizeResult {
  /** Number of review threads starred (STARRED label added to all messages in each thread). */
  starred: number;
  /** Number of review threads archived (INBOX removed from all messages in each thread). */
  archived: number;
}

export interface FinalizeOptions {
  /** When true, compute counts but skip all Gmail API write calls. */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface TriageItem {
  threadId: string;
  representativeMessageId: string;
  messageCount: number;
  subject: string;
  from: string;
  date: string;
  /** The non-_triage category label name (e.g. "newsletters"). */
  category: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts a named header value from a Gmail message payload.
 * Returns an empty string if the header is absent.
 */
function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return getHeaderUtil(headers, name) ?? "";
}

/**
 * Extracts the category label from a list of label IDs.
 * The category is the first label that is not "_triage" or a well-known Gmail
 * system label (all-caps, e.g. "INBOX", "STARRED").
 *
 * Falls back to "uncategorized" if no candidate is found.
 */
function extractCategory(labelIds: string[] | undefined | null, labelNameById: Map<string, string>): string {
  if (!labelIds || labelIds.length === 0) return "uncategorized";

  for (const id of labelIds) {
    const name = labelNameById.get(id) ?? id;

    // Skip _triage operational label
    if (name === "_triage") continue;
    // Skip other operational labels
    if (name.startsWith("_")) continue;
    // Skip Gmail system labels (all uppercase, e.g. INBOX, STARRED, UNREAD)
    if (name === name.toUpperCase() && /^[A-Z_]+$/.test(name)) continue;
    return name;
  }
  return "uncategorized";
}

/**
 * Returns today's date as a `YYYY-MM-DD` string (UTC).
 */
function todayDateString(): string {
  return formatYMD(new Date());
}

function buildLabelNameById(labels: gmail_v1.Schema$Label[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const label of labels) {
    if (typeof label.id === "string" && typeof label.name === "string") {
      map.set(label.id, label.name);
    }
  }
  return map;
}

async function safeClientCall<T>(label: string, fn: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await fn();
  } catch (err: unknown) {
    return { ok: false, error: `${label} threw: ${toErrorMessage(err)}` };
  }
}

async function listAllTriageStubs(client: GmailClient): Promise<Result<Array<{ id: string; threadId: string }>>> {
  const allStubs: Array<{ id: string; threadId: string }> = [];
  let pageToken: string | undefined;
  const maxPages = Math.ceil(MAX_MESSAGES_SAFETY / MAX_RESULTS_PER_PAGE) + 1;
  let iterations = 0;

  while (iterations < maxPages) {
    iterations++;
    const listResult = await safeClientCall("listMessages", () =>
      client.listMessages(TRIAGE_QUERY, pageToken, MAX_RESULTS_PER_PAGE),
    );
    if (!listResult.ok) {
      return { ok: false, error: listResult.error };
    }

    const { messages, nextPageToken } = listResult.value;
    for (const message of messages) {
      if (allStubs.length >= MAX_MESSAGES_SAFETY) break;
      allStubs.push(message);
    }

    if (nextPageToken === undefined) {
      return { ok: true, value: allStubs };
    }

    if (allStubs.length >= MAX_MESSAGES_SAFETY) {
      return {
        ok: false,
        error:
          `Triage queue exceeds safety limit of ${MAX_MESSAGES_SAFETY} messages. ` +
          "Review aborted to avoid a partial action pass.",
      };
    }

    pageToken = nextPageToken;
  }

  return {
    ok: false,
    error:
      `Triage pagination exceeded safety limit of ${maxPages} pages. ` +
      "Review aborted to avoid a partial action pass.",
  };
}

// ---------------------------------------------------------------------------
// buildActionReport
// ---------------------------------------------------------------------------

/**
 * Queries Gmail for all messages with the `_triage` label, fetches metadata
 * for each, groups them by category, and writes a markdown report to
 * `reportsDir/action-pass-YYYY-MM-DD.md`.
 *
 * @param client     Authenticated GmailClient.
 * @param reportsDir Directory where the report file will be written.
 * @returns `{ reportPath, itemCount }` on success.
 */
export async function buildActionReport(client: GmailClient, reportsDir: string): Promise<Result<BuildReportResult>> {
  const labelsResult = await safeClientCall("listLabels", () => client.listLabels());
  if (!labelsResult.ok) {
    return { ok: false, error: labelsResult.error };
  }
  const labelNameById = buildLabelNameById(labelsResult.value);

  // -------------------------------------------------------------------------
  // 1. List all triage messages (paginated)
  // -------------------------------------------------------------------------

  const stubsResult = await listAllTriageStubs(client);
  if (!stubsResult.ok) {
    return stubsResult;
  }
  const allStubs = stubsResult.value;

  // -------------------------------------------------------------------------
  // 2. Collapse to one review item per thread.
  // -------------------------------------------------------------------------

  const triageThreads = new Map<string, { representativeMessageId: string; messageCount: number }>();
  for (const stub of allStubs) {
    const existing = triageThreads.get(stub.threadId);
    if (existing === undefined) {
      triageThreads.set(stub.threadId, {
        representativeMessageId: stub.id,
        messageCount: 1,
      });
      continue;
    }
    existing.messageCount += 1;
  }

  // -------------------------------------------------------------------------
  // 3. Fetch metadata for each review thread (bounded concurrency)
  // -------------------------------------------------------------------------

  const items: TriageItem[] = [];
  const failedMessageIds: string[] = [];
  const semaphore = new Semaphore(MAX_CONCURRENT);

  const fetchTasks = Array.from(triageThreads.entries()).map(([threadId, info]) =>
    (async (): Promise<void> => {
      await semaphore.acquire();
      try {
        const msgResult = await safeClientCall("getMessage", () =>
          client.getMessage(info.representativeMessageId, "metadata", [...REPORT_HEADERS]),
        );
        if (!msgResult.ok) {
          failedMessageIds.push(`${info.representativeMessageId} (${msgResult.error})`);
          return;
        }

        const msg = msgResult.value;
        const headers = msg.payload?.headers;

        const subject = getHeader(headers, "Subject");
        const from = getHeader(headers, "From");
        const date = getHeader(headers, "Date");
        const category = extractCategory(msg.labelIds, labelNameById);

        items.push({
          threadId,
          representativeMessageId: info.representativeMessageId,
          messageCount: info.messageCount,
          subject,
          from,
          date,
          category,
        });
      } finally {
        semaphore.release();
      }
    })(),
  );

  await Promise.all(fetchTasks);

  if (failedMessageIds.length > 0) {
    return {
      ok: false,
      error:
        `Failed to fetch metadata for ${failedMessageIds.length} triage thread(s). ` +
        `First failure: ${failedMessageIds[0]}`,
    };
  }

  // -------------------------------------------------------------------------
  // 4. Build markdown report
  // -------------------------------------------------------------------------

  items.sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      a.from.localeCompare(b.from) ||
      a.subject.localeCompare(b.subject) ||
      a.threadId.localeCompare(b.threadId),
  );
  const markdown = renderMarkdownReport(items);

  // -------------------------------------------------------------------------
  // 5. Write report to disk
  // -------------------------------------------------------------------------

  const reportFilename = `action-pass-${todayDateString()}.md`;
  const reportPath = path.join(reportsDir, reportFilename);

  try {
    await fs.mkdir(reportsDir, { recursive: true });
    await fs.writeFile(reportPath, markdown, "utf8");
  } catch (err: unknown) {
    return { ok: false, error: `Failed to write report: ${toErrorMessage(err)}` };
  }

  return {
    ok: true,
    value: {
      reportPath,
      itemCount: items.length,
    },
  };
}

// ---------------------------------------------------------------------------
// renderMarkdownReport (pure function — testable in isolation)
// ---------------------------------------------------------------------------

/**
 * Renders an array of triage-thread items into a markdown string.
 * Items are grouped by category.
 */
function renderMarkdownReport(items: TriageItem[]): string {
  if (items.length === 0) {
    return `# Action Pass Report — ${todayDateString()}\n\nNo actionable items to review.\n`;
  }

  // Group by category
  const groups = new Map<string, TriageItem[]>();
  for (const item of items) {
    const existing = groups.get(item.category) ?? [];
    existing.push(item);
    groups.set(item.category, existing);
  }

  const lines: string[] = [`# Action Pass Report — ${todayDateString()}`, ""];

  for (const [category, categoryItems] of groups) {
    lines.push(`## ${category}`);
    lines.push("");
    for (const item of categoryItems) {
      lines.push(`- **From:** ${item.from}`);
      lines.push(`  **Subject:** ${item.subject}`);
      lines.push(`  **Date:** ${item.date}`);
      lines.push(`  **Thread ID:** ${item.threadId}`);
      lines.push(`  **Messages:** ${item.messageCount}`);
      lines.push(`  **Representative Message ID:** ${item.representativeMessageId}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// finalizeReview
// ---------------------------------------------------------------------------

/**
 * Applies star / archive decisions to triage review items.
 *
 * Decisions may be keyed by either thread ID (preferred) or a representative
 * message ID from the thread report. The action is applied to every message in
 * the triage thread.
 *
 * - `star` decisions: adds `STARRED`, removes the `_triage` label.
 * - `archive` decisions: removes `INBOX` and the `_triage` label.
 *
 * @param decisions     Map of threadId/messageId → "star" | "archive".
 * @param triageLabelId The Gmail label ID for the `_triage` label.
 * @param client        Authenticated GmailClient.
 * @param options       Optional `dryRun` flag.
 * @returns `{ starred, archived }` counts.
 */
export async function finalizeReview(
  decisions: Map<string, "star" | "archive">,
  triageLabelId: string,
  client: GmailClient,
  options: FinalizeOptions = {},
): Promise<Result<FinalizeResult>> {
  const { dryRun = false } = options;

  const stubsResult = await listAllTriageStubs(client);
  if (!stubsResult.ok) {
    return stubsResult;
  }
  const triageStubs = stubsResult.value;

  // -------------------------------------------------------------------------
  // Normalize decisions to thread IDs, allowing either thread IDs or message IDs.
  // -------------------------------------------------------------------------

  const threadToMessageIds = new Map<string, string[]>();
  const messageToThreadId = new Map<string, string>();
  for (const stub of triageStubs) {
    const existing = threadToMessageIds.get(stub.threadId) ?? [];
    existing.push(stub.id);
    threadToMessageIds.set(stub.threadId, existing);
    messageToThreadId.set(stub.id, stub.threadId);
  }

  const normalizedDecisions = new Map<string, "star" | "archive">();

  for (const [reviewId, decision] of decisions) {
    const threadMatch = threadToMessageIds.has(reviewId) ? reviewId : undefined;
    const messageMatch = messageToThreadId.get(reviewId);

    if (threadMatch !== undefined && messageMatch !== undefined && threadMatch !== messageMatch) {
      return {
        ok: false,
        error: `Ambiguous review ID "${reviewId}": matches both threadId "${threadMatch}" and messageId mapping to thread "${messageMatch}"`,
      };
    }

    const threadId = threadMatch ?? messageMatch;

    if (threadId === undefined) {
      return {
        ok: false,
        error: `Decision references unknown triage item: ${reviewId}`,
      };
    }

    const existing = normalizedDecisions.get(threadId);
    if (existing !== undefined && existing !== decision) {
      return {
        ok: false,
        error: `Conflicting decisions provided for thread ${threadId}`,
      };
    }

    normalizedDecisions.set(threadId, decision);
  }

  const starIds: string[] = [];
  const archiveIds: string[] = [];

  for (const [threadId, decision] of normalizedDecisions) {
    const messageIds = threadToMessageIds.get(threadId) ?? [];
    if (decision === "star") {
      starIds.push(...messageIds);
    } else {
      archiveIds.push(...messageIds);
    }
  }

  const starred = Array.from(normalizedDecisions.values()).filter((decision) => decision === "star").length;
  const archived = Array.from(normalizedDecisions.values()).filter((decision) => decision === "archive").length;

  // -------------------------------------------------------------------------
  // Dry-run: return counts without API calls
  // -------------------------------------------------------------------------

  if (dryRun) {
    return { ok: true, value: { starred, archived } };
  }

  // -------------------------------------------------------------------------
  // No decisions — skip API calls
  // -------------------------------------------------------------------------

  if (starred === 0 && archived === 0) {
    return { ok: true, value: { starred: 0, archived: 0 } };
  }

  // -------------------------------------------------------------------------
  // Apply star decisions
  // -------------------------------------------------------------------------

  if (starIds.length > 0) {
    for (const chunk of chunkArray(starIds, BATCH_MODIFY_CHUNK_SIZE)) {
      const result = await safeClientCall("batchModifyMessages", () =>
        client.batchModifyMessages(
          chunk,
          ["STARRED"], // addLabelIds
          [triageLabelId], // removeLabelIds
        ),
      );
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Apply archive decisions
  // -------------------------------------------------------------------------

  if (archiveIds.length > 0) {
    for (const chunk of chunkArray(archiveIds, BATCH_MODIFY_CHUNK_SIZE)) {
      const result = await safeClientCall("batchModifyMessages", () =>
        client.batchModifyMessages(
          chunk,
          [], // addLabelIds (none)
          ["INBOX", triageLabelId], // removeLabelIds
        ),
      );
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
    }
  }

  return { ok: true, value: { starred, archived } };
}
