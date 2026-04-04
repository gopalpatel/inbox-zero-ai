/**
 * parseGmailMessage — converts a raw `gmail_v1.Schema$Message` metadata
 * response into a typed `EmailMetadata` value.
 *
 * Security notes:
 * - All header values are truncated to MAX_HEADER_LENGTH before regex processing.
 * - All regex quantifiers are bounded (ReDoS prevention).
 * - Errors are never swallowed; the caller receives `Result<EmailMetadata>`.
 */

import type { gmail_v1 } from "googleapis";
import { type EmailMetadata, EmailMetadataSchema, type GmailCategory } from "../schemas/email-metadata.js";
import type { Result } from "../types.js";
import { getHeader as getHeaderUtil, toErrorMessage } from "../utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Truncate header values to this length before regex processing (ReDoS prevention). */
const MAX_HEADER_LENGTH = 2000;

/**
 * Regex to parse `Name <email>` and bare `<email>` formats.
 * The name group allows 0 characters to handle `<email>` without a display name.
 * Bounded quantifiers prevent ReDoS.
 */
const FROM_ANGLE_BRACKET_RE = /^(.{0,200}?)\s*<(.{1,200}?)>$/;

/**
 * Map from Gmail CATEGORY_* labelId suffixes to GmailCategory values.
 * Using a Map avoids repeated array scans.
 */
const CATEGORY_LABEL_MAP = new Map<string, GmailCategory>([
  ["CATEGORY_PERSONAL", "primary"],
  ["CATEGORY_SOCIAL", "social"],
  ["CATEGORY_PROMOTIONS", "promotions"],
  ["CATEGORY_UPDATES", "updates"],
  ["CATEGORY_FORUMS", "forums"],
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts a header value by name from a `payload.headers` array.
 * Delegates to the shared `getHeader` utility.
 */
function getHeader(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string | undefined {
  return getHeaderUtil(headers, name);
}

/**
 * Truncates a string to at most `maxLength` characters.
 * Protects downstream regex from catastrophic backtracking.
 */
function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/**
 * Strips surrounding double-quotes from a display name.
 * `"John Smith"` → `John Smith`
 */
function stripQuotes(name: string): string {
  const trimmed = name.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parses a `From` header value into `{ email, name }`.
 *
 * Handles three formats:
 * 1. `Name <email>` → name extracted, email from angle brackets
 * 2. `"Quoted Name" <email>` → quotes stripped from name
 * 3. `email@example.com` (plain) → name is empty string
 *
 * Returns `null` when no valid email can be extracted.
 */
function parseFromHeader(raw: string): { email: string; name: string } | null {
  const value = truncate(raw.trim(), MAX_HEADER_LENGTH);

  const match = FROM_ANGLE_BRACKET_RE.exec(value);

  if (match !== null) {
    const rawName = match[1] ?? "";
    const email = (match[2] ?? "").trim();
    const name = stripQuotes(rawName);
    return { email, name };
  }

  // No angle-bracket format — treat the whole value as a plain email.
  const plainEmail = value.trim();
  return { email: plainEmail, name: "" };
}

/**
 * Splits a header value on commas that are outside double-quoted strings.
 * Handles display names like `"Smith, John" <email>` without breaking on
 * the comma inside quotes. Bounded by MAX_HEADER_LENGTH truncation upstream.
 */
function splitAddresses(value: string): string[] {
  const results: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;

    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      results.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  results.push(current);
  return results;
}

/**
 * Parses a comma-separated list of email addresses from a header value.
 * Extracts only the email portion (strips display names if present).
 * Invalid or empty entries are filtered out.
 * Uses quote-aware splitting to handle commas inside display names.
 */
function parseAddressList(raw: string): string[] {
  const value = truncate(raw.trim(), MAX_HEADER_LENGTH);

  return splitAddresses(value)
    .map((entry) => {
      const trimmed = entry.trim();
      const match = FROM_ANGLE_BRACKET_RE.exec(trimmed);
      if (match !== null) {
        return (match[2] ?? "").trim();
      }
      return trimmed;
    })
    .filter((addr) => addr.length > 0);
}

/**
 * Infers the `GmailCategory` from a list of Gmail labelIds.
 * Returns `'unknown'` when no matching CATEGORY_* label is present.
 */
function inferCategory(labelIds: string[]): GmailCategory {
  for (const label of labelIds) {
    const category = CATEGORY_LABEL_MAP.get(label);
    if (category !== undefined) return category;
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses a raw `gmail_v1.Schema$Message` metadata response into `EmailMetadata`.
 *
 * Returns `{ ok: false, error }` for any of the following:
 * - Missing `id`, `threadId`, `internalDate`, or `payload`
 * - `From` header is absent or contains no parseable email address
 * - Zod validation of the assembled object fails
 *
 * Never throws — all errors are captured in the `Result` return value.
 */
export function parseGmailMessage(raw: gmail_v1.Schema$Message): Result<EmailMetadata> {
  try {
    // --- Required top-level fields -------------------------------------------

    const messageId = raw.id;
    if (!messageId) {
      return { ok: false, error: "Missing message id" };
    }

    const threadId = raw.threadId;
    if (!threadId) {
      return { ok: false, error: "Missing threadId" };
    }

    const internalDate = raw.internalDate;
    if (!internalDate) {
      return { ok: false, error: "Missing internalDate" };
    }

    const payload = raw.payload;
    if (!payload) {
      return { ok: false, error: "Missing payload" };
    }

    // --- Parse dateReceived from epoch-ms string -----------------------------

    const dateReceived = new Date(Number(internalDate));

    // --- Extract headers -----------------------------------------------------

    const headers = payload.headers ?? [];

    const fromRaw = getHeader(headers, "From");
    if (fromRaw === undefined) {
      return { ok: false, error: "Missing From header" };
    }

    const parsed = parseFromHeader(fromRaw);
    if (parsed === null) {
      return { ok: false, error: "Unable to parse From header" };
    }

    const { email: senderEmail, name: senderName } = parsed;

    const toRaw = getHeader(headers, "To");
    const ccRaw = getHeader(headers, "Cc");

    const toAddresses = toRaw ? parseAddressList(toRaw) : [];
    const ccAddresses = ccRaw ? parseAddressList(ccRaw) : [];

    const subjectRaw = getHeader(headers, "Subject");
    const subject = subjectRaw !== undefined ? truncate(subjectRaw, MAX_HEADER_LENGTH) : "(no subject)";

    // --- Labels and flags ----------------------------------------------------

    const labelIds = raw.labelIds ?? [];
    const isUnread = labelIds.includes("UNREAD");
    const gmailCategory = inferCategory(labelIds);

    // --- Snippet -------------------------------------------------------------

    const snippet = raw.snippet ?? "";

    // --- Assemble and validate via Zod ---------------------------------------

    const parseResult = EmailMetadataSchema.safeParse({
      messageId,
      threadId,
      sender: {
        email: senderEmail,
        name: senderName,
      },
      recipients: {
        to: toAddresses,
        cc: ccAddresses,
      },
      subject,
      dateReceived,
      gmailCategory,
      labels: labelIds,
      isUnread,
      snippet,
    });

    if (!parseResult.success) {
      return {
        ok: false,
        error: `Schema validation failed: ${parseResult.error.message}`,
      };
    }

    return { ok: true, value: parseResult.data };
  } catch (err: unknown) {
    return { ok: false, error: `Unexpected error: ${toErrorMessage(err)}` };
  }
}
