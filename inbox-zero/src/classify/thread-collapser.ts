/**
 * thread-collapser.ts
 *
 * Groups EmailMetadata records by threadId and extracts unique content by
 * stripping quoted reply sections from message bodies.
 *
 * Design decisions:
 * - All regex quantifiers are bounded to prevent ReDoS (security standard).
 * - Bodies are truncated to 50 000 chars before regex processing.
 * - Quoted-reply detection covers Gmail, Apple Mail, and Outlook patterns.
 */

import type { EmailMetadata } from "../schemas/email-metadata.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum body length fed into regex processing (ReDoS guard). */
const MAX_BODY_LENGTH = 50_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ThreadSummary {
  /** Gmail thread ID. */
  threadId: string;
  /** Sender email of the first (chronologically earliest) message. */
  senderEmail: string;
  /** Subject from the first message. */
  subject: string;
  /** All unique sender emails across the thread. */
  participants: string[];
  /** Date range spanning all messages in the thread. */
  dateRange: { first: Date; last: Date };
  /** Concatenation of unique content extracted from all messages. */
  content: string;
  /** Total number of messages in the thread. */
  messageCount: number;
}

// ---------------------------------------------------------------------------
// Quoted-reply patterns  (all quantifiers bounded)
// ---------------------------------------------------------------------------

/**
 * Matches a line that is a Gmail-style attribution line, e.g.:
 *   On Mon, Jan 1, 2026 at 10:00 AM Alice Smith <alice@example.com> wrote:
 *
 * We match from "On " to the end of the line that ends with "wrote:".
 * The pattern is intentionally permissive across a single line.
 */
const GMAIL_ATTRIBUTION_RE = /^On .{1,200} wrote:\s*$/m;

/**
 * Matches an Apple Mail attribution line, e.g.:
 *   On Jan 1, 2026, at 10:00, Alice Smith <alice@example.com> wrote:
 */
const APPLE_MAIL_ATTRIBUTION_RE = /^On .{1,200}, at .{1,50} wrote:\s*$/m;

/**
 * Matches an Outlook-style "From:" header line that begins a forwarded/reply
 * block (the "From:" word must be at the start of a line to avoid false
 * positives in email signatures).
 */
const OUTLOOK_FROM_RE = /^From: .{0,300}$/m;

/**
 * Matches Outlook header lines that follow the "From:" line:
 * Sent:, To:, Cc:, Subject:.
 */
const OUTLOOK_HEADER_RE = /^(Sent|To|Cc|Subject): .{0,300}$/m;

/**
 * Matches a line that starts with one or more ">" characters (quoted content).
 */
const QUOTED_LINE_RE = /^>{1,10} .{0,500}$/m;

/**
 * Matches separator lines: six or more dashes (with optional surrounding text).
 * e.g. "---------- Forwarded message ----------"
 */
const SEPARATOR_RE = /^-{6,100}.{0,100}$/m;

// ---------------------------------------------------------------------------
// extractUniqueContent
// ---------------------------------------------------------------------------

/**
 * Strips common quoted-reply patterns from an email body and returns the
 * "new" content written by the author of this message.
 *
 * Patterns removed (all quantifiers are bounded):
 * - Lines starting with `>`
 * - Gmail `On ... wrote:` attribution lines
 * - Apple Mail `On ..., at ..., wrote:` attribution lines
 * - Outlook `From: / Sent: / To: / Subject:` header blocks
 * - Dashed separator lines (`------...`)
 *
 * Security:
 * - Input is truncated to MAX_BODY_LENGTH characters before any regex runs.
 */
export function extractUniqueContent(body: string): string {
  if (body.length === 0) return "";

  // Truncate before regex processing (ReDoS guard).
  const safe = body.length > MAX_BODY_LENGTH ? body.slice(0, MAX_BODY_LENGTH) : body;

  const lines = safe.split("\n");
  const result: string[] = [];

  // Track whether we have entered a quoted block (attribution line seen).
  // Once we detect an attribution or Outlook header block, everything after
  // is considered quoted and is discarded.
  let inQuotedBlock = false;
  // Track Outlook header block state: once we see "From:" at line start we
  // consider subsequent Sent/To/Cc/Subject lines as part of the same header.
  let outlookHeaderSeen = false;

  for (const line of lines) {
    // Truncate individual lines before testing (additional ReDoS guard).
    const safeLine = line.length > 600 ? line.slice(0, 600) : line;

    // --- Check for quoted-block entry markers first ---

    // Gmail or Apple Mail attribution line: "On ... wrote:"
    if (GMAIL_ATTRIBUTION_RE.test(safeLine) || APPLE_MAIL_ATTRIBUTION_RE.test(safeLine)) {
      inQuotedBlock = true;
      continue;
    }

    // Outlook "From:" header line
    if (OUTLOOK_FROM_RE.test(safeLine)) {
      inQuotedBlock = true;
      outlookHeaderSeen = true;
      continue;
    }

    // If we are inside an Outlook header block, skip Sent/To/Cc/Subject lines
    if (outlookHeaderSeen && OUTLOOK_HEADER_RE.test(safeLine)) {
      continue;
    } else if (outlookHeaderSeen) {
      // Once we see a non-header line after an Outlook From: block, the
      // body that follows is the original quoted body — still skip it.
      outlookHeaderSeen = false;
    }

    if (inQuotedBlock) continue;

    // Quoted lines (start with ">")
    if (QUOTED_LINE_RE.test(safeLine)) continue;

    // Separator lines
    if (SEPARATOR_RE.test(safeLine)) {
      inQuotedBlock = true;
      continue;
    }

    result.push(line);
  }

  return result.join("\n");
}

// ---------------------------------------------------------------------------
// collapseThreads
// ---------------------------------------------------------------------------

/**
 * Groups `messages` by `threadId`, sorts messages within each thread by
 * `dateReceived` ascending, and produces a `ThreadSummary` per thread.
 *
 * @param messages  Array of EmailMetadata records to group.
 * @param bodyMap   Map from messageId → full body text (may be partial).
 *                  Messages absent from the map use an empty string for content.
 * @returns Array of ThreadSummary, one per unique threadId.
 */
export function collapseThreads(messages: EmailMetadata[], bodyMap: Map<string, string>): ThreadSummary[] {
  if (messages.length === 0) return [];

  // Group messages by threadId using a Map for O(1) lookups.
  const threadMap = new Map<string, EmailMetadata[]>();

  for (const msg of messages) {
    const group = threadMap.get(msg.threadId);
    if (group !== undefined) {
      group.push(msg);
    } else {
      threadMap.set(msg.threadId, [msg]);
    }
  }

  const summaries: ThreadSummary[] = [];

  for (const [threadId, threadMessages] of threadMap) {
    // Sort chronologically ascending.
    const sorted = [...threadMessages].sort((a, b) => a.dateReceived.getTime() - b.dateReceived.getTime());

    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;

    // Collect unique participants via a Set.
    const participantSet = new Set<string>();
    for (const msg of sorted) {
      participantSet.add(msg.sender.email);
    }

    // Build content by extracting unique content from each message's body.
    const contentParts: string[] = [];
    for (const msg of sorted) {
      const rawBody = bodyMap.get(msg.messageId) ?? "";
      const unique = extractUniqueContent(rawBody);
      const trimmed = unique.trim();
      if (trimmed.length > 0) {
        contentParts.push(trimmed);
      }
    }

    summaries.push({
      threadId,
      senderEmail: first.sender.email,
      subject: first.subject,
      participants: Array.from(participantSet),
      dateRange: {
        first: first.dateReceived,
        last: last.dateReceived,
      },
      content: contentParts.join("\n\n"),
      messageCount: sorted.length,
    });
  }

  return summaries;
}
