import { describe, expect, it } from "vitest";
import { parseGmailMessage } from "../../src/pull/message-parser.js";
import {
  rawBareAngleBracketFrom,
  rawCommaInDisplayName,
  rawEmailWithCc,
  rawMalformedFromEmail,
  rawNewsletterEmail,
  rawNoSubjectEmail,
  rawPersonalEmail,
  rawPlainEmailAddressFrom,
  rawUnreadEmail,
} from "../fixtures/sample-gmail-response.js";

// ---------------------------------------------------------------------------
// Happy path — full metadata response
// ---------------------------------------------------------------------------

describe("parseGmailMessage() — standard personal email", () => {
  it("returns ok: true for a valid message", () => {
    const result = parseGmailMessage(rawPersonalEmail);
    expect(result.ok).toBe(true);
  });

  it("extracts messageId and threadId", () => {
    const result = parseGmailMessage(rawPersonalEmail);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.messageId).toBe("msg-personal-001");
    expect(result.value.threadId).toBe("thread-personal-001");
  });

  it("extracts sender email and name from 'Name <email>' format", () => {
    const result = parseGmailMessage(rawPersonalEmail);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.sender.email).toBe("sarah.johnson@gmail.com");
    expect(result.value.sender.name).toBe("Sarah Johnson");
  });

  it("extracts To recipients", () => {
    const result = parseGmailMessage(rawPersonalEmail);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.recipients.to).toContain("gopal@example.com");
    expect(result.value.recipients.cc).toEqual([]);
  });

  it("extracts subject", () => {
    const result = parseGmailMessage(rawPersonalEmail);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.subject).toBe("Dinner plans this weekend?");
  });

  it("extracts snippet", () => {
    const result = parseGmailMessage(rawPersonalEmail);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.snippet).toBe("Hey! Are you free Saturday evening?");
  });

  it("extracts dateReceived from internalDate (epoch ms string)", () => {
    const result = parseGmailMessage(rawPersonalEmail);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.dateReceived).toBeInstanceOf(Date);
    expect(result.value.dateReceived.getFullYear()).toBe(2026);
  });

  it("sets isUnread to false when UNREAD label is absent", () => {
    const result = parseGmailMessage(rawPersonalEmail);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.isUnread).toBe(false);
  });

  it("includes all labels from labelIds", () => {
    const result = parseGmailMessage(rawPersonalEmail);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.labels).toContain("INBOX");
  });
});

// ---------------------------------------------------------------------------
// Newsletter — CATEGORY_PROMOTIONS label
// ---------------------------------------------------------------------------

describe("parseGmailMessage() — newsletter (promotions tab)", () => {
  it("maps CATEGORY_PROMOTIONS labelId to gmailCategory 'promotions'", () => {
    const result = parseGmailMessage(rawNewsletterEmail);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.gmailCategory).toBe("promotions");
  });

  it("extracts quoted display name: removes surrounding quotes from sender name", () => {
    const result = parseGmailMessage(rawNewsletterEmail);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    // Raw From: "Morning Brew" <newsletter@morning-brew.com>
    expect(result.value.sender.name).toBe("Morning Brew");
    expect(result.value.sender.email).toBe("newsletter@morning-brew.com");
  });
});

// ---------------------------------------------------------------------------
// Email with CC recipients
// ---------------------------------------------------------------------------

describe("parseGmailMessage() — email with Cc header", () => {
  it("extracts Cc recipients into recipients.cc", () => {
    const result = parseGmailMessage(rawEmailWithCc);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.recipients.cc).toContain("office@sunsetapartments.com");
    expect(result.value.recipients.cc).toContain("supervisor@sunsetapartments.com");
  });

  it("extracts To and Cc independently", () => {
    const result = parseGmailMessage(rawEmailWithCc);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.recipients.to).toContain("gopal@example.com");
    expect(result.value.recipients.cc).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Unread email
// ---------------------------------------------------------------------------

describe("parseGmailMessage() — unread email", () => {
  it("sets isUnread to true when UNREAD is in labelIds", () => {
    const result = parseGmailMessage(rawUnreadEmail);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.isUnread).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No subject
// ---------------------------------------------------------------------------

describe("parseGmailMessage() — email with no Subject header", () => {
  it("defaults subject to '(no subject)' when Subject header is absent", () => {
    const result = parseGmailMessage(rawNoSubjectEmail);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.subject).toBe("(no subject)");
  });
});

// ---------------------------------------------------------------------------
// Malformed From header
// ---------------------------------------------------------------------------

describe("parseGmailMessage() — malformed From header", () => {
  it("returns ok: false for completely unparseable sender (no valid email)", () => {
    const result = parseGmailMessage(rawMalformedFromEmail);
    expect(result.ok).toBe(false);
  });

  it("does NOT throw — returns Result with ok: false", () => {
    expect(() => parseGmailMessage(rawMalformedFromEmail)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// From with plain email address only (no display name, no angle brackets)
// ---------------------------------------------------------------------------

describe("parseGmailMessage() — From with only email address", () => {
  it("uses the full value as the email when no angle-bracket format", () => {
    const result = parseGmailMessage(rawPlainEmailAddressFrom);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.sender.email).toBe("noreply@github.com");
    expect(result.value.sender.name).toBe("");
  });
});

// ---------------------------------------------------------------------------
// From with bare angle brackets: `<email>` (no display name)
// ---------------------------------------------------------------------------

describe("parseGmailMessage() — bare angle-bracket From", () => {
  it("strips angle brackets and extracts the email", () => {
    const result = parseGmailMessage(rawBareAngleBracketFrom);
    if (!result.ok) throw new Error(`Expected ok but got: ${result.error}`);

    expect(result.value.sender.email).toBe("shipping@cosyresi.com");
    expect(result.value.sender.name).toBe("");
  });

  it("strips angle brackets from To recipients", () => {
    const result = parseGmailMessage(rawBareAngleBracketFrom);
    if (!result.ok) throw new Error(`Expected ok but got: ${result.error}`);

    expect(result.value.recipients.to).toEqual(["mail@example.com"]);
  });
});

// ---------------------------------------------------------------------------
// Comma in quoted display name (issue #6)
// ---------------------------------------------------------------------------

describe("parseGmailMessage() — comma in display name", () => {
  it("parses To with comma-bearing quoted display name into 2 addresses", () => {
    const result = parseGmailMessage(rawCommaInDisplayName);
    if (!result.ok) throw new Error(`Expected ok but got: ${result.error}`);

    expect(result.value.recipients.to).toHaveLength(2);
    expect(result.value.recipients.to).toContain("john@example.com");
    expect(result.value.recipients.to).toContain("jane@example.com");
  });

  it("parses Cc with comma-bearing quoted display name into 1 address", () => {
    const result = parseGmailMessage(rawCommaInDisplayName);
    if (!result.ok) throw new Error(`Expected ok but got: ${result.error}`);

    expect(result.value.recipients.cc).toHaveLength(1);
    expect(result.value.recipients.cc).toContain("ab@corp.com");
  });

  it("still works with plain comma-separated addresses (no quotes)", () => {
    const result = parseGmailMessage(rawEmailWithCc);
    if (!result.ok) throw new Error(`Expected ok but got: ${result.error}`);

    expect(result.value.recipients.cc).toHaveLength(2);
    expect(result.value.recipients.cc).toContain("office@sunsetapartments.com");
    expect(result.value.recipients.cc).toContain("supervisor@sunsetapartments.com");
  });
});

// ---------------------------------------------------------------------------
// GmailCategory mapping
// ---------------------------------------------------------------------------

describe("parseGmailMessage() — Gmail category label mapping", () => {
  it("maps CATEGORY_SOCIAL to 'social'", () => {
    const raw = {
      ...rawPersonalEmail,
      labelIds: ["INBOX", "CATEGORY_SOCIAL"],
    };
    const result = parseGmailMessage(raw);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.gmailCategory).toBe("social");
  });

  it("maps CATEGORY_UPDATES to 'updates'", () => {
    const raw = {
      ...rawPersonalEmail,
      labelIds: ["INBOX", "CATEGORY_UPDATES"],
    };
    const result = parseGmailMessage(raw);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.gmailCategory).toBe("updates");
  });

  it("maps CATEGORY_FORUMS to 'forums'", () => {
    const raw = {
      ...rawPersonalEmail,
      labelIds: ["INBOX", "CATEGORY_FORUMS"],
    };
    const result = parseGmailMessage(raw);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.gmailCategory).toBe("forums");
  });

  it("maps CATEGORY_PERSONAL to 'primary'", () => {
    const raw = {
      ...rawPersonalEmail,
      labelIds: ["INBOX", "CATEGORY_PERSONAL"],
    };
    const result = parseGmailMessage(raw);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.gmailCategory).toBe("primary");
  });

  it("defaults gmailCategory to 'unknown' when no CATEGORY_ label is present", () => {
    const raw = {
      ...rawPersonalEmail,
      labelIds: ["INBOX"],
    };
    const result = parseGmailMessage(raw);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.gmailCategory).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Metadata-only format (payload with headers only, no body parts)
// ---------------------------------------------------------------------------

describe("parseGmailMessage() — metadata format payload", () => {
  it("parses successfully when payload has only headers (no body)", () => {
    const raw = {
      ...rawPersonalEmail,
      payload: {
        headers: rawPersonalEmail.payload?.headers ?? [],
        // No body, no parts — metadata-only response
      },
    };
    const result = parseGmailMessage(raw);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Missing/null fields defensive handling
// ---------------------------------------------------------------------------

describe("parseGmailMessage() — missing required fields", () => {
  it("returns ok: false when id is missing", () => {
    const raw = { ...rawPersonalEmail, id: undefined };
    const result = parseGmailMessage(raw);
    expect(result.ok).toBe(false);
  });

  it("returns ok: false when threadId is missing", () => {
    const raw = { ...rawPersonalEmail, threadId: undefined };
    const result = parseGmailMessage(raw);
    expect(result.ok).toBe(false);
  });

  it("returns ok: false when internalDate is missing", () => {
    const raw = { ...rawPersonalEmail, internalDate: undefined };
    const result = parseGmailMessage(raw);
    expect(result.ok).toBe(false);
  });

  it("returns ok: false when payload is missing", () => {
    const raw = { ...rawPersonalEmail, payload: undefined };
    const result = parseGmailMessage(raw);
    expect(result.ok).toBe(false);
  });
});
