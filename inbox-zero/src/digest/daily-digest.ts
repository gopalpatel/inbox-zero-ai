/**
 * daily-digest.ts
 *
 * Orchestrates the daily inbox-zero digest pipeline:
 * 1. List new messages since a given date via Gmail API.
 * 2. Fetch metadata for each message and parse it.
 * 3. Group by thread; try rule engine first.
 * 4. For unmatched threads: pull full bodies, collapse threads, classify via LLM.
 * 5. Apply Gmail labels (category + triage/archive).
 * 6. Write a markdown summary report.
 *
 * Design decisions:
 * - `runDigest` is the single public export — it orchestrates the full pipeline.
 * - Accepts `ClassificationProvider` for the LLM step (easily mockable in tests).
 * - Accepts `RulesConfig` (pre-loaded by caller — no file I/O in this module).
 * - Report is written to `{reportsDir}/digest-{YYYY-MM-DD}.md`.
 * - Non-actionable threads are archived; actionable ones get `_triage`.
 * - All JSON.parse calls are wrapped in try/catch (applied via imported helpers).
 * - Input collections are processed with bounded safety limits.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GmailClient } from "../auth/gmail-client.js";
import { pullBodies } from "../classify/body-puller.js";
import { applyClassifications, ensureLabelsExist } from "../classify/label-applier.js";
import type { ClassificationProvider } from "../classify/llm-classifier.js";
import { classifyBatch } from "../classify/llm-classifier.js";
import type { RulesConfig } from "../classify/rule-engine.js";
import { classify } from "../classify/rule-engine.js";
import { collapseThreads } from "../classify/thread-collapser.js";
import { parseGmailMessage } from "../pull/message-parser.js";
import type { ThreadClassification } from "../schemas/classification.js";
import type { EmailMetadata } from "../schemas/email-metadata.js";
import type { Result } from "../types.js";
import { formatYMD, Semaphore } from "../utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum messages fetched from Gmail in a single listMessages call. */
const MAX_RESULTS_PER_PAGE = 500;

/** Safety limit on total messages processed per digest run. */
const MAX_MESSAGES_SAFETY = 10_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DigestResult {
  /** Total new messages found. */
  totalNew: number;
  /** Total threads classified (both rule and LLM). */
  categorized: number;
  /** Number of actionable threads needing human attention. */
  actionable: number;
  /** Absolute path to the written markdown report. */
  reportPath: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Formats a Date as `YYYY/MM/DD` for the Gmail query string.
 * Example: new Date("2026-03-16") → "2026/03/16"
 */
function formatDateForQuery(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

/**
 * Formats a Date as `YYYY-MM-DD` for the report filename.
 * Delegates to the shared `formatYMD` utility (UTC).
 */
function formatDateForFilename(date: Date): string {
  return formatYMD(date);
}

/**
 * Collects all message stubs from Gmail, paginating through nextPageToken.
 * Returns the complete result set or a failure if pagination would be truncated.
 */
async function listAllMessages(
  query: string,
  client: GmailClient,
): Promise<Result<Array<{ id: string; threadId: string }>>> {
  const all: Array<{ id: string; threadId: string }> = [];
  let pageToken: string | undefined;

  // Safety limit on iterations.
  const maxPages = Math.ceil(MAX_MESSAGES_SAFETY / MAX_RESULTS_PER_PAGE) + 1;
  let iterations = 0;

  while (iterations < maxPages) {
    iterations++;
    const result = await client.listMessages(query, pageToken, MAX_RESULTS_PER_PAGE);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    const { messages, nextPageToken } = result.value;
    for (const m of messages) {
      if (all.length >= MAX_MESSAGES_SAFETY) break;
      all.push(m);
    }

    if (nextPageToken === undefined) {
      return { ok: true, value: all };
    }

    if (all.length >= MAX_MESSAGES_SAFETY) {
      return {
        ok: false,
        error:
          `Digest result set exceeds safety limit of ${MAX_MESSAGES_SAFETY} messages. ` +
          "Narrow the date window or increase the limit before retrying.",
      };
    }

    pageToken = nextPageToken;
  }

  return {
    ok: false,
    error: `Digest pagination exceeded safety limit of ${maxPages} pages. Run aborted to avoid a partial digest.`,
  };
}

/**
 * Generates a markdown summary report for the digest run.
 *
 * Format:
 * ```
 * # Daily Digest — YYYY-MM-DD
 *
 * **Total new messages:** N
 * **Auto-categorized threads:** N
 * **Actionable threads:** N
 *
 * ## Categories
 * - category: N threads
 *
 * ## Actionable Items
 * - **sender** — Subject
 * ```
 */
function generateReport(opts: {
  date: string;
  totalNew: number;
  classifications: ThreadClassification[];
  metadataByThread: Map<string, EmailMetadata>;
}): string {
  const { date, totalNew, classifications, metadataByThread } = opts;

  if (totalNew === 0) {
    return `# Daily Digest — ${date}\n\nNo new mail\n`;
  }

  const actionable = classifications.filter((c) => c.actionable);
  const categorized = classifications.length;

  // Count by category
  const categoryCount = new Map<string, number>();
  for (const c of classifications) {
    const prev = categoryCount.get(c.category) ?? 0;
    categoryCount.set(c.category, prev + 1);
  }

  const lines: string[] = [
    `# Daily Digest — ${date}`,
    "",
    `**Total new messages:** ${totalNew}`,
    `**Auto-categorized threads:** ${categorized}`,
    `**Actionable threads:** ${actionable.length}`,
    "",
    "## Categories",
  ];

  for (const [cat, count] of categoryCount) {
    lines.push(`- ${cat}: ${count} thread${count === 1 ? "" : "s"}`);
  }

  lines.push("");
  lines.push("## Actionable Items");

  if (actionable.length === 0) {
    lines.push("*(none)*");
  } else {
    for (const c of actionable) {
      const meta = metadataByThread.get(c.threadId);
      const sender = meta?.sender.email ?? "(unknown sender)";
      const subject = meta?.subject ?? "(no subject)";
      lines.push(`- **${sender}** — ${subject}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// runDigest — main export
// ---------------------------------------------------------------------------

/**
 * Runs the full daily digest pipeline.
 *
 * Steps:
 * 1. Build Gmail query: `after:YYYY/MM/DD in:anywhere -in:spam -in:trash -in:drafts -in:sent`
 * 2. List all new messages (paginated).
 * 3. Fetch full metadata for each message via `getMessage`.
 * 4. Parse metadata using `parseGmailMessage`.
 * 5. Group by thread. For each thread, try rule engine classification.
 * 6. For unmatched threads: pull full bodies → collapse → LLM classify.
 * 7. `ensureLabelsExist` → `applyClassifications`.
 * 8. Generate and write markdown report.
 *
 * @param since       Date after which to look for new messages.
 * @param client      Authenticated GmailClient.
 * @param provider    LLM ClassificationProvider.
 * @param rulesConfig Pre-loaded rules configuration.
 * @param reportsDir  Directory where the digest report will be written.
 * @param dataDir     Directory where digest body-pull checkpoints/cache should live.
 * @returns DigestResult with counts and reportPath.
 */
export async function runDigest(
  since: Date,
  client: GmailClient,
  provider: ClassificationProvider,
  rulesConfig: RulesConfig,
  reportsDir: string,
  dataDir = reportsDir,
): Promise<DigestResult> {
  const today = new Date();
  const dateLabel = formatDateForFilename(today);
  const reportPath = path.join(reportsDir, `digest-${dateLabel}.md`);

  // Ensure the reports directory exists.
  await fs.mkdir(reportsDir, { recursive: true });

  // ---------------------------------------------------------------------------
  // Step 1: List new messages
  // ---------------------------------------------------------------------------

  const dateQuery = formatDateForQuery(since);
  const query = `after:${dateQuery} in:anywhere -in:spam -in:trash -in:drafts -in:sent`;

  const stubsResult = await listAllMessages(query, client);

  if (!stubsResult.ok) {
    // API failure on first page — surface the error instead of writing
    // a misleading "No new mail" report.
    throw new Error(`Failed to list messages: ${stubsResult.error}`);
  }

  const stubs = stubsResult.value;

  if (stubs.length === 0) {
    const report = `# Daily Digest — ${dateLabel}\n\nNo new mail\n`;
    await fs.writeFile(reportPath, report, "utf-8");
    return { totalNew: 0, categorized: 0, actionable: 0, reportPath };
  }

  // ---------------------------------------------------------------------------
  // Step 2: Fetch full metadata for each message (bounded concurrency)
  // ---------------------------------------------------------------------------

  const allMetadata: EmailMetadata[] = [];
  // Map threadId → first EmailMetadata (for report display)
  const metadataByThread = new Map<string, EmailMetadata>();
  // Map threadId → list of messageIds (for applyClassifications)
  const threadToMessageIds = new Map<string, string[]>();

  const semaphore = new Semaphore(10);
  let metadataFetchFailures = 0;

  const fetchTasks = stubs.map((stub) =>
    (async (): Promise<void> => {
      await semaphore.acquire();
      try {
        const msgResult = await client.getMessage(stub.id, "metadata", ["From", "Subject", "To", "Cc"]);
        if (!msgResult.ok) {
          metadataFetchFailures++;
          return;
        }

        const parseResult = parseGmailMessage(msgResult.value);
        if (!parseResult.ok) {
          metadataFetchFailures++;
          return;
        }

        const meta = parseResult.value;
        allMetadata.push(meta);

        // Track first metadata for each thread (for report)
        if (!metadataByThread.has(meta.threadId)) {
          metadataByThread.set(meta.threadId, meta);
        }

        // Track message IDs per thread
        const existing = threadToMessageIds.get(meta.threadId) ?? [];
        existing.push(meta.messageId);
        threadToMessageIds.set(meta.threadId, existing);
      } finally {
        semaphore.release();
      }
    })(),
  );

  await Promise.all(fetchTasks);

  const totalNew = allMetadata.length;

  if (metadataFetchFailures > 0) {
    throw new Error(
      `Failed to fetch metadata for ${metadataFetchFailures}/${stubs.length} new messages. ` +
        "Digest aborted to avoid a partial run.",
    );
  }

  if (totalNew === 0) {
    const report = `# Daily Digest — ${dateLabel}\n\nNo new mail\n`;
    await fs.writeFile(reportPath, report, "utf-8");
    return { totalNew: 0, categorized: 0, actionable: 0, reportPath };
  }

  // ---------------------------------------------------------------------------
  // Step 3: Group by thread, run rule engine for each unique thread
  // ---------------------------------------------------------------------------

  // Collapse threads into summaries (empty body map — rule engine only uses senderEmail).
  const threadSummaries = collapseThreads(allMetadata, new Map());

  const ruleClassifications: ThreadClassification[] = [];
  const unmatchedThreadIds = new Set<string>();

  for (const summary of threadSummaries) {
    const ruleResult = classify(summary, rulesConfig);
    if (ruleResult !== null) {
      ruleClassifications.push(ruleResult);
    } else {
      unmatchedThreadIds.add(summary.threadId);
    }
  }

  // ---------------------------------------------------------------------------
  // Step 4: For unmatched threads — pull bodies, collapse, classify via LLM
  // ---------------------------------------------------------------------------

  let llmClassifications: ThreadClassification[] = [];

  if (unmatchedThreadIds.size > 0) {
    // Collect all message IDs that belong to unmatched threads.
    const unmatchedMessageIds: string[] = [];
    for (const threadId of unmatchedThreadIds.values()) {
      const ids = threadToMessageIds.get(threadId) ?? [];
      for (const id of ids) {
        unmatchedMessageIds.push(id);
      }
    }

    // Pull full bodies for unmatched messages.
    const bodyResult = await pullBodies({
      client,
      messageIds: unmatchedMessageIds,
      dataDir: path.join(dataDir, "digest"),
    });

    if (!bodyResult.ok) {
      throw new Error(`Body pull failed: ${bodyResult.error}. Cannot classify unmatched threads.`);
    }

    const bodyMap = bodyResult.value;

    // Only include metadata for unmatched threads.
    const unmatchedMetadata = allMetadata.filter((m) => unmatchedThreadIds.has(m.threadId));

    // Collapse threads into summaries with body content.
    const threadSummaries = collapseThreads(unmatchedMetadata, bodyMap);

    // Gather categories already known from rule classifications.
    const existingCategories = [...new Set(ruleClassifications.map((c) => c.category))];

    // Classify via LLM.
    llmClassifications = await classifyBatch(threadSummaries, provider, existingCategories);
  }

  // ---------------------------------------------------------------------------
  // Step 5: Combine all classifications
  // ---------------------------------------------------------------------------

  const allClassifications = [...ruleClassifications, ...llmClassifications];
  const categorized = allClassifications.length;
  const actionableCount = allClassifications.filter((c) => c.actionable).length;

  // ---------------------------------------------------------------------------
  // Step 6: Apply labels — ensure they exist, then batch-apply
  // ---------------------------------------------------------------------------

  const categories = [...new Set(allClassifications.map((c) => c.category))];

  const labelResult = await ensureLabelsExist(categories, client);
  if (!labelResult.ok) {
    throw new Error(`Failed to create labels: ${labelResult.error}`);
  }

  const applyResult = await applyClassifications(allClassifications, threadToMessageIds, labelResult.value, client);
  if (!applyResult.ok) {
    throw new Error(`Failed to apply labels: ${applyResult.error}`);
  }
  if (applyResult.value.failures.length > 0) {
    throw new Error(`Failed to apply labels: ${applyResult.value.failures.join("; ")}`);
  }

  // ---------------------------------------------------------------------------
  // Step 7: Generate and write the markdown report
  // ---------------------------------------------------------------------------

  const report = generateReport({
    date: dateLabel,
    totalNew,
    classifications: allClassifications,
    metadataByThread,
  });

  await fs.writeFile(reportPath, report, "utf-8");

  return {
    totalNew,
    categorized,
    actionable: actionableCount,
    reportPath,
  };
}
