/**
 * Realistic raw Gmail API metadata response objects.
 *
 * These match the shape of `gmail_v1.Schema$Message` as returned by
 * `messages.get` with `format=metadata`. Only `payload.headers[]` is present —
 * no body parts, no raw MIME. The `internalDate` field is epoch-milliseconds
 * as a string, matching the real API.
 */

import type { gmail_v1 } from "googleapis";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeHeaders(entries: Array<{ name: string; value: string }>): gmail_v1.Schema$MessagePartHeader[] {
  return entries;
}

// ---------------------------------------------------------------------------
// Standard personal email — "Name <email>" From format
// ---------------------------------------------------------------------------

/**
 * Personal email from a friend. No category label → gmailCategory will be
 * 'unknown'. No UNREAD label → isUnread: false.
 */
export const rawPersonalEmail: gmail_v1.Schema$Message = {
  id: "msg-personal-001",
  threadId: "thread-personal-001",
  labelIds: ["INBOX"],
  snippet: "Hey! Are you free Saturday evening?",
  historyId: "12345",
  internalDate: String(new Date("2026-03-16T19:45:00.000Z").getTime()),
  payload: {
    mimeType: "text/plain",
    headers: makeHeaders([
      { name: "From", value: "Sarah Johnson <sarah.johnson@gmail.com>" },
      { name: "To", value: "gopal@example.com" },
      { name: "Subject", value: "Dinner plans this weekend?" },
      { name: "Date", value: "Mon, 16 Mar 2026 19:45:00 +0000" },
    ]),
  },
};

// ---------------------------------------------------------------------------
// Newsletter — CATEGORY_PROMOTIONS + UNREAD + quoted display name
// ---------------------------------------------------------------------------

/**
 * Newsletter from Morning Brew. Has CATEGORY_PROMOTIONS and UNREAD labels.
 * From header uses quoted display name: "Morning Brew" <email>.
 */
export const rawNewsletterEmail: gmail_v1.Schema$Message = {
  id: "msg-promo-001",
  threadId: "thread-promo-001",
  labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
  snippet: "Good morning! Here's what you need to know today.",
  historyId: "12346",
  internalDate: String(new Date("2026-03-17T06:00:00.000Z").getTime()),
  payload: {
    mimeType: "text/html",
    headers: makeHeaders([
      { name: "From", value: '"Morning Brew" <newsletter@morning-brew.com>' },
      { name: "To", value: "gopal@example.com" },
      { name: "Subject", value: "\u2600\uFE0F Your Morning Brew: March 17, 2026" },
      { name: "Date", value: "Mon, 17 Mar 2026 06:00:00 +0000" },
    ]),
  },
};

// ---------------------------------------------------------------------------
// Email with Cc recipients
// ---------------------------------------------------------------------------

/**
 * Property management email with multiple Cc recipients.
 */
export const rawEmailWithCc: gmail_v1.Schema$Message = {
  id: "msg-property-006",
  threadId: "thread-property-001",
  labelIds: ["INBOX", "UNREAD"],
  snippet: "Hi Gopal, our technician will arrive between 10am-12pm.",
  historyId: "12347",
  internalDate: String(new Date("2026-03-16T11:15:00.000Z").getTime()),
  payload: {
    mimeType: "text/plain",
    headers: makeHeaders([
      {
        name: "From",
        value: "Sunset Apartments Maintenance <maintenance@sunsetapartments.com>",
      },
      { name: "To", value: "gopal@example.com" },
      {
        name: "Cc",
        value: "office@sunsetapartments.com, supervisor@sunsetapartments.com",
      },
      { name: "Subject", value: "Re: HVAC service scheduled for March 20" },
      { name: "Date", value: "Mon, 16 Mar 2026 11:15:00 +0000" },
    ]),
  },
};

// ---------------------------------------------------------------------------
// Unread email — UNREAD label present
// ---------------------------------------------------------------------------

/**
 * LinkedIn social notification. Has CATEGORY_SOCIAL and UNREAD labels.
 */
export const rawUnreadEmail: gmail_v1.Schema$Message = {
  id: "msg-social-004",
  threadId: "thread-social-004",
  labelIds: ["INBOX", "UNREAD", "CATEGORY_SOCIAL"],
  snippet: "Recruiters and hiring managers are looking at your profile.",
  historyId: "12348",
  internalDate: String(new Date("2026-03-17T09:00:00.000Z").getTime()),
  payload: {
    mimeType: "text/html",
    headers: makeHeaders([
      {
        name: "From",
        value: "LinkedIn <notifications-noreply@linkedin.com>",
      },
      { name: "To", value: "gopal@example.com" },
      { name: "Subject", value: "You appeared in 12 searches this week" },
      { name: "Date", value: "Mon, 17 Mar 2026 09:00:00 +0000" },
    ]),
  },
};

// ---------------------------------------------------------------------------
// Email with no Subject header
// ---------------------------------------------------------------------------

/**
 * Message with no Subject header at all. Parser should default to '(no subject)'.
 */
export const rawNoSubjectEmail: gmail_v1.Schema$Message = {
  id: "msg-nosubj-008",
  threadId: "thread-nosubj-008",
  labelIds: ["INBOX"],
  snippet: "Quick note...",
  historyId: "12349",
  internalDate: String(new Date("2026-03-15T10:00:00.000Z").getTime()),
  payload: {
    mimeType: "text/plain",
    headers: makeHeaders([
      { name: "From", value: "friend@example.com" },
      { name: "To", value: "gopal@example.com" },
      // No Subject header
      { name: "Date", value: "Sun, 15 Mar 2026 10:00:00 +0000" },
    ]),
  },
};

// ---------------------------------------------------------------------------
// Email with malformed From header (no valid email address)
// ---------------------------------------------------------------------------

/**
 * From header that doesn't contain any recognisable email address.
 * Parser should return ok: false rather than throw.
 */
export const rawMalformedFromEmail: gmail_v1.Schema$Message = {
  id: "msg-malformed-009",
  threadId: "thread-malformed-009",
  labelIds: ["INBOX"],
  snippet: "Something weird...",
  historyId: "12350",
  internalDate: String(new Date("2026-03-14T08:00:00.000Z").getTime()),
  payload: {
    mimeType: "text/plain",
    headers: makeHeaders([
      { name: "From", value: "!!!not-an-email-address!!!" },
      { name: "To", value: "gopal@example.com" },
      { name: "Subject", value: "Weird message" },
      { name: "Date", value: "Sat, 14 Mar 2026 08:00:00 +0000" },
    ]),
  },
};

// ---------------------------------------------------------------------------
// Email with bare angle-bracket From: `<email>` (no display name)
// ---------------------------------------------------------------------------

/**
 * From header uses bare angle brackets with no display name: `<email>`.
 * This format is common in automated/transactional mail and was previously
 * mishandled — the angle brackets were passed through as part of the email.
 */
export const rawBareAngleBracketFrom: gmail_v1.Schema$Message = {
  id: "msg-bare-bracket-011",
  threadId: "thread-bare-bracket-011",
  labelIds: ["INBOX"],
  snippet: "Your order has shipped.",
  historyId: "12352",
  internalDate: String(new Date("2026-03-12T16:00:00.000Z").getTime()),
  payload: {
    mimeType: "text/plain",
    headers: makeHeaders([
      { name: "From", value: "<shipping@cosyresi.com>" },
      { name: "To", value: "<mail@example.com>" },
      { name: "Subject", value: "Order shipped" },
      { name: "Date", value: "Thu, 12 Mar 2026 16:00:00 +0000" },
    ]),
  },
};

// ---------------------------------------------------------------------------
// Email with comma inside quoted display name in To/Cc
// ---------------------------------------------------------------------------

/**
 * To header contains a quoted display name with a comma: `"Smith, John" <email>`.
 * Cc header also contains a quoted display name with a comma.
 * The naive `.split(",")` breaks on the comma inside the quotes.
 */
export const rawCommaInDisplayName: gmail_v1.Schema$Message = {
  id: "msg-comma-display-012",
  threadId: "thread-comma-display-012",
  labelIds: ["INBOX"],
  snippet: "Meeting notes attached.",
  historyId: "12353",
  internalDate: String(new Date("2026-03-18T10:00:00.000Z").getTime()),
  payload: {
    mimeType: "text/plain",
    headers: makeHeaders([
      { name: "From", value: "Sarah Johnson <sarah@gmail.com>" },
      {
        name: "To",
        value: '"Smith, John" <john@example.com>, jane@example.com',
      },
      { name: "Cc", value: '"A, B Corp" <ab@corp.com>' },
      { name: "Subject", value: "Meeting notes" },
      { name: "Date", value: "Wed, 18 Mar 2026 10:00:00 +0000" },
    ]),
  },
};

// ---------------------------------------------------------------------------
// Email with only an email address in From (no display name, no angle brackets)
// ---------------------------------------------------------------------------

/**
 * From header contains only a bare email address — no display name, no
 * angle brackets. Parser should treat the whole value as the email.
 */
export const rawPlainEmailAddressFrom: gmail_v1.Schema$Message = {
  id: "msg-plain-from-010",
  threadId: "thread-plain-from-010",
  labelIds: ["INBOX"],
  snippet: "Your pull request was merged.",
  historyId: "12351",
  internalDate: String(new Date("2026-03-13T14:30:00.000Z").getTime()),
  payload: {
    mimeType: "text/plain",
    headers: makeHeaders([
      { name: "From", value: "noreply@github.com" },
      { name: "To", value: "gopal@example.com" },
      { name: "Subject", value: "Pull request merged" },
      { name: "Date", value: "Fri, 13 Mar 2026 14:30:00 +0000" },
    ]),
  },
};
