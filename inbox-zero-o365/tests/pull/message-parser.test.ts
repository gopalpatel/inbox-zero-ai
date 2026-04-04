import { describe, expect, it } from "vitest";
import { parseO365Message } from "../../src/pull/message-parser.js";

describe("parseO365Message", () => {
  const INBOX_FOLDER_ID = "inbox-folder-id";
  const ctx = { inboxFolderId: INBOX_FOLDER_ID };

  // -------------------------------------------------------------------------
  // Happy-path: basic message
  // -------------------------------------------------------------------------

  it("parses a basic Graph message to EmailMetadata", () => {
    const graphMessage = {
      id: "AAMkADAwATZi-immutable",
      conversationId: "AAQkADAwATZi-conv",
      from: { emailAddress: { address: "sender@example.com", name: "Sender" } },
      toRecipients: [{ emailAddress: { address: "mailbox@example.com", name: "Mailbox User" } }],
      ccRecipients: [],
      subject: "Test subject",
      receivedDateTime: "2026-03-23T10:30:00Z",
      categories: [],
      isRead: false,
      parentFolderId: INBOX_FOLDER_ID,
      bodyPreview: "This is the preview",
      flag: { flagStatus: "notFlagged" },
      importance: "normal",
    };

    const result = parseO365Message(graphMessage, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.messageId).toBe("AAMkADAwATZi-immutable");
    expect(result.value.threadId).toBe("AAQkADAwATZi-conv");
    expect(result.value.sender.email).toBe("sender@example.com");
    expect(result.value.sender.name).toBe("Sender");
    expect(result.value.recipients.to).toEqual(["mailbox@example.com"]);
    expect(result.value.recipients.cc).toEqual([]);
    expect(result.value.subject).toBe("Test subject");
    expect(result.value.gmailCategory).toBe("unknown");
    expect(result.value.labels).toContain("INBOX");
    expect(result.value.labels).toContain("UNREAD");
    expect(result.value.isUnread).toBe(true);
    expect(result.value.snippet).toBe("This is the preview");
    expect(result.value.dateReceived).toEqual(new Date("2026-03-23T10:30:00Z"));
  });

  // -------------------------------------------------------------------------
  // Error cases: missing required fields
  // -------------------------------------------------------------------------

  it("returns error when 'from' field is missing", () => {
    const graphMessage = {
      id: "AAMkADAwATZi",
      conversationId: "AAQkADAwATZi",
      toRecipients: [],
      ccRecipients: [],
      subject: "No sender",
      receivedDateTime: "2026-03-23T10:30:00Z",
      categories: [],
      isRead: false,
      parentFolderId: INBOX_FOLDER_ID,
      bodyPreview: "",
      flag: { flagStatus: "notFlagged" },
      importance: "normal",
    };

    const result = parseO365Message(graphMessage, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/from/i);
  });

  it("returns error when 'id' field is missing", () => {
    const graphMessage = {
      conversationId: "AAQkADAwATZi",
      from: { emailAddress: { address: "test@example.com", name: "Test" } },
      toRecipients: [],
      ccRecipients: [],
      subject: "No ID",
      receivedDateTime: "2026-03-23T10:30:00Z",
      categories: [],
      isRead: false,
      parentFolderId: INBOX_FOLDER_ID,
      bodyPreview: "",
      flag: { flagStatus: "notFlagged" },
      importance: "normal",
    };

    const result = parseO365Message(graphMessage, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/id/i);
  });

  // -------------------------------------------------------------------------
  // Synthetic labels
  // -------------------------------------------------------------------------

  it("includes STARRED label when flagged", () => {
    const graphMessage = makeGraphMessage({
      flag: { flagStatus: "flagged" },
    });

    const result = parseO365Message(graphMessage, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.labels).toContain("STARRED");
  });

  it("includes IMPORTANT label when importance is high", () => {
    const graphMessage = makeGraphMessage({
      importance: "high",
    });

    const result = parseO365Message(graphMessage, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.labels).toContain("IMPORTANT");
  });

  it("appends O365 categories to labels", () => {
    const graphMessage = makeGraphMessage({
      categories: ["Red category", "Blue category"],
    });

    const result = parseO365Message(graphMessage, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.labels).toContain("Red category");
    expect(result.value.labels).toContain("Blue category");
  });

  it("does NOT include INBOX label when message is in a different folder", () => {
    const graphMessage = makeGraphMessage({
      parentFolderId: "some-other-folder-id",
    });

    const result = parseO365Message(graphMessage, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.labels).not.toContain("INBOX");
  });

  it("does NOT include UNREAD label when message is read", () => {
    const graphMessage = makeGraphMessage({
      isRead: true,
    });

    const result = parseO365Message(graphMessage, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.labels).not.toContain("UNREAD");
    expect(result.value.isUnread).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Default/fallback values for optional fields
  // -------------------------------------------------------------------------

  it("defaults subject to '(no subject)' when empty", () => {
    const graphMessage = makeGraphMessage({ subject: "" });

    const result = parseO365Message(graphMessage, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.subject).toBe("(no subject)");
  });

  it("defaults subject to '(no subject)' when missing", () => {
    const graphMessage = makeGraphMessage();
    delete (graphMessage as Record<string, unknown>)["subject"];

    const result = parseO365Message(graphMessage, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.subject).toBe("(no subject)");
  });

  it("defaults bodyPreview/snippet to empty string when missing", () => {
    const graphMessage = makeGraphMessage();
    delete (graphMessage as Record<string, unknown>)["bodyPreview"];

    const result = parseO365Message(graphMessage, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.snippet).toBe("");
  });

  it("falls back threadId to messageId when conversationId is missing or empty", () => {
    const missingConversationIdMessage = makeGraphMessage();
    delete (missingConversationIdMessage as Record<string, unknown>)["conversationId"];

    const missingResult = parseO365Message(missingConversationIdMessage, ctx);
    expect(missingResult.ok).toBe(true);
    if (!missingResult.ok) return;
    expect(missingResult.value.threadId).toBe("AAMkADAwATZi-test");

    const emptyConversationIdMessage = makeGraphMessage({ conversationId: "" });
    const emptyResult = parseO365Message(emptyConversationIdMessage, ctx);
    expect(emptyResult.ok).toBe(true);
    if (!emptyResult.ok) return;
    expect(emptyResult.value.threadId).toBe("AAMkADAwATZi-test");
  });

  it("defaults toRecipients and ccRecipients to empty arrays when missing", () => {
    const graphMessage = makeGraphMessage();
    delete (graphMessage as Record<string, unknown>)["toRecipients"];
    delete (graphMessage as Record<string, unknown>)["ccRecipients"];

    const result = parseO365Message(graphMessage, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients.to).toEqual([]);
    expect(result.value.recipients.cc).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Sender email lowercasing
  // -------------------------------------------------------------------------

  it("lowercases sender email address", () => {
    const graphMessage = makeGraphMessage({
      from: { emailAddress: { address: "SENDER@EXAMPLE.COM", name: "Sender" } },
    });

    const result = parseO365Message(graphMessage, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sender.email).toBe("sender@example.com");
  });

  it("lowercases recipient email addresses", () => {
    const graphMessage = makeGraphMessage({
      toRecipients: [{ emailAddress: { address: "TO@EXAMPLE.COM", name: "To" } }],
      ccRecipients: [{ emailAddress: { address: "CC@EXAMPLE.COM", name: "Cc" } }],
    });

    const result = parseO365Message(graphMessage, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients.to).toEqual(["to@example.com"]);
    expect(result.value.recipients.cc).toEqual(["cc@example.com"]);
  });

  // -------------------------------------------------------------------------
  // Sender name defaults
  // -------------------------------------------------------------------------

  it("defaults sender name to empty string when missing", () => {
    const graphMessage = makeGraphMessage({
      from: { emailAddress: { address: "test@example.com" } },
    });

    const result = parseO365Message(graphMessage, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sender.name).toBe("");
  });

  // -------------------------------------------------------------------------
  // Schema validation failures
  // -------------------------------------------------------------------------

  it("returns error when receivedDateTime is not a valid date", () => {
    const graphMessage = makeGraphMessage({
      receivedDateTime: "not-a-date",
    });

    const result = parseO365Message(graphMessage, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/date|receivedDateTime|schema validation/i);
  });
});

// ---------------------------------------------------------------------------
// Test helper: minimal valid GraphMessage-like object
// ---------------------------------------------------------------------------

function makeGraphMessage(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "AAMkADAwATZi-test",
    conversationId: "AAQkADAwATZi-conv",
    from: { emailAddress: { address: "test@example.com", name: "Test Sender" } },
    toRecipients: [{ emailAddress: { address: "mailbox@example.com", name: "Mailbox User" } }],
    ccRecipients: [],
    subject: "Test subject",
    receivedDateTime: "2026-03-23T10:30:00Z",
    categories: [],
    isRead: false,
    parentFolderId: "inbox-folder-id",
    bodyPreview: "Preview text",
    flag: { flagStatus: "notFlagged" },
    importance: "normal",
    ...overrides,
  };
}
