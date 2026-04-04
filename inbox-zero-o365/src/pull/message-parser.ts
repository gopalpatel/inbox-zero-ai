/**
 * Message Parser — converts a raw Microsoft Graph API message into the
 * contract-compatible `EmailMetadata` format shared with the Gmail pipeline.
 *
 * Design decisions:
 * - Accepts `Record<string, unknown>` (not the typed `GraphMessage`) so the
 *   parser is resilient to unexpected API shapes and can surface structured
 *   errors instead of runtime type crashes.
 * - Builds synthetic Gmail-style labels (`INBOX`, `UNREAD`, `STARRED`,
 *   `IMPORTANT`) from O365 properties, then appends Outlook categories.
 * - Validates the assembled object against `EmailMetadataSchema` as the final
 *   step, catching any mapping bugs at the boundary.
 */

import type { EmailMetadata } from "../schemas/email-metadata.js";
import { EmailMetadataSchema } from "../schemas/email-metadata.js";
import type { Result } from "../types.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Contextual data needed to correctly map O365 folder semantics. */
export interface ParserContext {
  /** The immutable Graph ID of the user's Inbox folder. */
  inboxFolderId: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Safely extract a nested string from an unknown structure. */
function deepString(obj: unknown, ...keys: string[]): string | undefined {
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

/** Extract email addresses from a Graph recipients array, lowercased. */
function extractRecipients(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const result: string[] = [];
  for (const recipient of raw) {
    const addr = deepString(recipient, "emailAddress", "address");
    if (addr) {
      result.push(addr.toLowerCase());
    }
  }
  return result;
}

/** Build the synthetic labels array from O365 message properties. */
function buildLabels(msg: Record<string, unknown>, context: ParserContext): string[] {
  const labels: string[] = [];

  if (msg["parentFolderId"] === context.inboxFolderId) {
    labels.push("INBOX");
  }

  if (msg["isRead"] === false) {
    labels.push("UNREAD");
  }

  const flag = msg["flag"];
  if (flag !== null && flag !== undefined && typeof flag === "object") {
    const flagStatus = (flag as Record<string, unknown>)["flagStatus"];
    if (flagStatus === "flagged") {
      labels.push("STARRED");
    }
  }

  if (msg["importance"] === "high") {
    labels.push("IMPORTANT");
  }

  // Append O365 categories verbatim as additional labels
  const categories = msg["categories"];
  if (Array.isArray(categories)) {
    for (const cat of categories) {
      if (typeof cat === "string" && cat.length > 0) {
        labels.push(cat);
      }
    }
  }

  return labels;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a raw Microsoft Graph API message object into the contract-compatible
 * `EmailMetadata` format.
 *
 * @param graphMessage - Raw Graph API message (typed as `Record<string, unknown>` for resilience)
 * @param context - Contextual data (inbox folder ID) for label mapping
 * @returns `Result<EmailMetadata>` — success with parsed metadata, or failure with error details
 */
export function parseO365Message(graphMessage: Record<string, unknown>, context: ParserContext): Result<EmailMetadata> {
  // --- Required field: id ---
  const id = graphMessage["id"];
  if (typeof id !== "string" || id.length === 0) {
    return { ok: false, error: "Missing or empty 'id' field on Graph message" };
  }

  // --- Required field: from ---
  const from = graphMessage["from"];
  if (from === null || from === undefined || typeof from !== "object") {
    return { ok: false, error: "Missing 'from' field on Graph message" };
  }
  const senderEmail = deepString(from, "emailAddress", "address");
  if (!senderEmail) {
    return { ok: false, error: "Missing 'from.emailAddress.address' on Graph message" };
  }
  const senderName = deepString(from, "emailAddress", "name") ?? "";

  // --- Optional fields with defaults ---
  const conversationId =
    typeof graphMessage["conversationId"] === "string" && graphMessage["conversationId"].length > 0
      ? graphMessage["conversationId"]
      : id;
  const subject =
    typeof graphMessage["subject"] === "string" && graphMessage["subject"].length > 0
      ? graphMessage["subject"]
      : "(no subject)";
  const receivedDateTime = typeof graphMessage["receivedDateTime"] === "string" ? graphMessage["receivedDateTime"] : "";
  const bodyPreview = typeof graphMessage["bodyPreview"] === "string" ? graphMessage["bodyPreview"] : "";
  const isRead = graphMessage["isRead"] === true;

  // --- Build the candidate object ---
  const candidate = {
    messageId: id,
    threadId: conversationId,
    sender: {
      email: senderEmail.toLowerCase(),
      name: senderName,
    },
    recipients: {
      to: extractRecipients(graphMessage["toRecipients"]),
      cc: extractRecipients(graphMessage["ccRecipients"]),
    },
    subject,
    dateReceived: receivedDateTime,
    gmailCategory: "unknown" as const,
    labels: buildLabels(graphMessage, context),
    isUnread: !isRead,
    snippet: bodyPreview,
  };

  // --- Validate against the contract schema ---
  const parsed = EmailMetadataSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { ok: false, error: `Schema validation failed: ${issues}` };
  }

  return { ok: true, value: parsed.data };
}
