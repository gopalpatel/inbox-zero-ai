/**
 * thread-collapser.test.ts
 *
 * Tests for thread grouping and quoted-reply stripping.
 */

import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "../../src/classify/thread-collapser.js";
import { collapseThreads, extractUniqueContent } from "../../src/classify/thread-collapser.js";
import type { EmailMetadata } from "../../src/schemas/email-metadata.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMessage(
  id: string,
  threadId: string,
  senderEmail: string,
  subject: string,
  date: Date,
  overrides: Partial<EmailMetadata> = {},
): EmailMetadata {
  return {
    messageId: id,
    threadId,
    sender: { email: senderEmail, name: senderEmail.split("@")[0] ?? "" },
    recipients: { to: ["me@example.com"], cc: [] },
    subject,
    dateReceived: date,
    gmailCategory: "primary",
    labels: ["INBOX"],
    isUnread: false,
    snippet: "",
    ...overrides,
  };
}

function findThread(summaries: ThreadSummary[], threadId: string): ThreadSummary {
  const t = summaries.find((s) => s.threadId === threadId);
  if (t === undefined) throw new Error(`Thread ${threadId} not found in summaries`);
  return t;
}

// ---------------------------------------------------------------------------
// Tests: collapseThreads grouping
// ---------------------------------------------------------------------------

describe("collapseThreads() — grouping", () => {
  it("groups 10 messages with 3 unique threadIds into 3 thread groups", () => {
    const messages: EmailMetadata[] = [
      makeMessage("m1", "t1", "alice@example.com", "Subject A", new Date("2026-01-01T10:00:00Z")),
      makeMessage("m2", "t1", "bob@example.com", "Subject A", new Date("2026-01-01T11:00:00Z")),
      makeMessage("m3", "t1", "alice@example.com", "Subject A", new Date("2026-01-01T12:00:00Z")),
      makeMessage("m4", "t2", "carol@example.com", "Subject B", new Date("2026-01-02T09:00:00Z")),
      makeMessage("m5", "t2", "dave@example.com", "Subject B", new Date("2026-01-02T10:00:00Z")),
      makeMessage("m6", "t2", "carol@example.com", "Subject B", new Date("2026-01-02T11:00:00Z")),
      makeMessage("m7", "t2", "dave@example.com", "Subject B", new Date("2026-01-02T12:00:00Z")),
      makeMessage("m8", "t3", "eve@example.com", "Subject C", new Date("2026-01-03T08:00:00Z")),
      makeMessage("m9", "t3", "frank@example.com", "Subject C", new Date("2026-01-03T09:00:00Z")),
      makeMessage("m10", "t3", "eve@example.com", "Subject C", new Date("2026-01-03T10:00:00Z")),
    ];

    const summaries = collapseThreads(messages, new Map());

    expect(summaries).toHaveLength(3);
    const threadIds = summaries.map((s) => s.threadId).sort();
    expect(threadIds).toEqual(["t1", "t2", "t3"]);
  });

  it("each thread group messageCount reflects the number of messages", () => {
    const messages: EmailMetadata[] = [
      makeMessage("m1", "t1", "alice@example.com", "A", new Date("2026-01-01T10:00:00Z")),
      makeMessage("m2", "t1", "bob@example.com", "A", new Date("2026-01-01T11:00:00Z")),
      makeMessage("m3", "t1", "alice@example.com", "A", new Date("2026-01-01T12:00:00Z")),
      makeMessage("m4", "t2", "carol@example.com", "B", new Date("2026-01-02T09:00:00Z")),
    ];

    const summaries = collapseThreads(messages, new Map());
    const t1 = findThread(summaries, "t1");
    const t2 = findThread(summaries, "t2");
    expect(t1.messageCount).toBe(3);
    expect(t2.messageCount).toBe(1);
  });

  it("senderEmail is the sender of the first message (chronologically)", () => {
    const messages: EmailMetadata[] = [
      makeMessage("m2", "t1", "bob@example.com", "A", new Date("2026-01-01T11:00:00Z")),
      makeMessage("m1", "t1", "alice@example.com", "A", new Date("2026-01-01T10:00:00Z")),
    ];

    const summaries = collapseThreads(messages, new Map());
    const t1 = findThread(summaries, "t1");
    // alice sent m1 which has earlier date
    expect(t1.senderEmail).toBe("alice@example.com");
  });

  it("participants contains all unique sender emails in the thread", () => {
    const messages: EmailMetadata[] = [
      makeMessage("m1", "t1", "alice@example.com", "A", new Date("2026-01-01T10:00:00Z")),
      makeMessage("m2", "t1", "bob@example.com", "A", new Date("2026-01-01T11:00:00Z")),
      makeMessage("m3", "t1", "alice@example.com", "A", new Date("2026-01-01T12:00:00Z")),
    ];

    const summaries = collapseThreads(messages, new Map());
    const t1 = findThread(summaries, "t1");
    const sortedParticipants = [...t1.participants].sort();
    expect(sortedParticipants).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("dateRange.first and dateRange.last span the thread's messages", () => {
    const first = new Date("2026-01-01T10:00:00Z");
    const last = new Date("2026-01-03T15:00:00Z");
    const messages: EmailMetadata[] = [
      makeMessage("m1", "t1", "alice@example.com", "A", new Date("2026-01-02T12:00:00Z")),
      makeMessage("m2", "t1", "bob@example.com", "A", first),
      makeMessage("m3", "t1", "carol@example.com", "A", last),
    ];

    const summaries = collapseThreads(messages, new Map());
    const t1 = findThread(summaries, "t1");
    expect(t1.dateRange.first.getTime()).toBe(first.getTime());
    expect(t1.dateRange.last.getTime()).toBe(last.getTime());
  });

  it("subject comes from the first message (chronologically)", () => {
    const messages: EmailMetadata[] = [
      makeMessage("m2", "t1", "bob@example.com", "Re: First Subject", new Date("2026-01-01T11:00:00Z")),
      makeMessage("m1", "t1", "alice@example.com", "First Subject", new Date("2026-01-01T10:00:00Z")),
    ];

    const summaries = collapseThreads(messages, new Map());
    const t1 = findThread(summaries, "t1");
    expect(t1.subject).toBe("First Subject");
  });

  it("handles single-message threads", () => {
    const messages: EmailMetadata[] = [
      makeMessage("m1", "t1", "alice@example.com", "Solo", new Date("2026-01-01T10:00:00Z")),
    ];

    const summaries = collapseThreads(messages, new Map());
    expect(summaries).toHaveLength(1);
    const t1 = summaries[0]!;
    expect(t1.messageCount).toBe(1);
    expect(t1.participants).toHaveLength(1);
    expect(t1.participants[0]).toBe("alice@example.com");
    expect(t1.dateRange.first.getTime()).toBe(t1.dateRange.last.getTime());
  });

  it("returns empty array for empty input", () => {
    const summaries = collapseThreads([], new Map());
    expect(summaries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: body content concatenation
// ---------------------------------------------------------------------------

describe("collapseThreads() — content assembly", () => {
  it("concatenates unique content from all thread messages", () => {
    const bodyMap = new Map<string, string>([
      ["m1", "Hello from Alice."],
      ["m2", "Hello from Bob."],
    ]);
    const messages: EmailMetadata[] = [
      makeMessage("m1", "t1", "alice@example.com", "A", new Date("2026-01-01T10:00:00Z")),
      makeMessage("m2", "t1", "bob@example.com", "A", new Date("2026-01-01T11:00:00Z")),
    ];

    const summaries = collapseThreads(messages, bodyMap);
    const t1 = findThread(summaries, "t1");
    expect(t1.content).toContain("Hello from Alice");
    expect(t1.content).toContain("Hello from Bob");
  });

  it("uses empty string for messages missing from bodyMap", () => {
    const bodyMap = new Map<string, string>([["m1", "Only this message has a body."]]);
    const messages: EmailMetadata[] = [
      makeMessage("m1", "t1", "alice@example.com", "A", new Date("2026-01-01T10:00:00Z")),
      makeMessage("m2", "t1", "bob@example.com", "A", new Date("2026-01-01T11:00:00Z")),
    ];

    // Should not throw
    const summaries = collapseThreads(messages, bodyMap);
    const t1 = findThread(summaries, "t1");
    expect(t1.content).toContain("Only this message has a body");
  });
});

// ---------------------------------------------------------------------------
// Tests: extractUniqueContent
// ---------------------------------------------------------------------------

describe("extractUniqueContent() — Gmail quoted reply pattern", () => {
  it("strips lines starting with >", () => {
    const body = "Hello there.\n> This is a quoted line.\n> Another quoted line.\nSee you soon.";
    const result = extractUniqueContent(body);
    expect(result).toContain("Hello there.");
    expect(result).toContain("See you soon.");
    expect(result).not.toContain("> This is a quoted line.");
    expect(result).not.toContain("> Another quoted line.");
  });

  it("strips Gmail 'On ... wrote:' line", () => {
    const body =
      "My reply here.\n\nOn Mon, Jan 1, 2026 at 10:00 AM Alice Smith <alice@example.com> wrote:\n> Original message.";
    const result = extractUniqueContent(body);
    expect(result).toContain("My reply here.");
    expect(result).not.toContain("On Mon, Jan 1, 2026 at 10:00 AM Alice Smith");
  });

  it("strips Apple Mail 'On ... at ..., ... wrote:' line", () => {
    const body = "My reply.\n\nOn Jan 1, 2026, at 10:00, Alice Smith <alice@example.com> wrote:\n> Original.";
    const result = extractUniqueContent(body);
    expect(result).toContain("My reply.");
    expect(result).not.toContain("On Jan 1, 2026, at 10:00");
  });

  it("strips Outlook-style From:/Sent:/To:/Subject: header block", () => {
    const body =
      "My reply.\n\nFrom: Alice Smith <alice@example.com>\nSent: Monday, January 1, 2026 10:00 AM\nTo: Bob <bob@example.com>\nSubject: Test Subject\n\nOriginal body.";
    const result = extractUniqueContent(body);
    expect(result).toContain("My reply.");
    expect(result).not.toContain("From: Alice Smith");
    expect(result).not.toContain("Sent: Monday");
    expect(result).not.toContain("To: Bob");
  });

  it("strips dashed separator lines (------...)", () => {
    const body = "New content.\n---------- Forwarded message ----------\nOld content.";
    const result = extractUniqueContent(body);
    expect(result).toContain("New content.");
    expect(result).not.toContain("---------- Forwarded message ----------");
  });

  it("preserves content that does not match any quoted reply pattern", () => {
    const body = "This is just plain text.\nWith multiple lines.\nNothing quoted here.";
    const result = extractUniqueContent(body);
    expect(result).toContain("This is just plain text.");
    expect(result).toContain("With multiple lines.");
    expect(result).toContain("Nothing quoted here.");
  });

  it("returns empty string for empty input", () => {
    expect(extractUniqueContent("")).toBe("");
  });

  it("handles single-message body with no quoting (no stripping needed)", () => {
    const body = "This is the full original message with no quoting at all.";
    const result = extractUniqueContent(body);
    expect(result.trim()).toBe(body);
  });

  it("truncates body to 50000 chars before processing (security standard)", () => {
    // Create a body that's 60000 chars — result should be based on 50000 char truncation
    const longBody = "A".repeat(60000);
    // Should not throw and should return within expected length
    const result = extractUniqueContent(longBody);
    expect(result.length).toBeLessThanOrEqual(50000);
  });

  it("handles complex real-world Gmail reply chain", () => {
    const body = `Thanks for the update!

On Tue, Jan 2, 2026 at 3:45 PM Bob Jones <bob@company.com> wrote:

> Here's the latest status.
>
> On Mon, Jan 1, 2026 at 9:00 AM Alice <alice@company.com> wrote:
>
>> Can you share an update?`;

    const result = extractUniqueContent(body);
    expect(result).toContain("Thanks for the update!");
    expect(result).not.toContain("On Tue, Jan 2, 2026 at 3:45 PM Bob Jones");
    expect(result).not.toContain("> Here's the latest status.");
  });
});

// ---------------------------------------------------------------------------
// Tests: TypeScript types
// ---------------------------------------------------------------------------

describe("ThreadSummary type", () => {
  it("satisfies the ThreadSummary interface shape", () => {
    const messages: EmailMetadata[] = [
      makeMessage("m1", "t1", "alice@example.com", "Test", new Date("2026-01-01T10:00:00Z")),
    ];
    const summaries = collapseThreads(messages, new Map([["m1", "Hello!"]]));
    const summary: ThreadSummary = summaries[0]!;

    expect(typeof summary.threadId).toBe("string");
    expect(typeof summary.senderEmail).toBe("string");
    expect(typeof summary.subject).toBe("string");
    expect(Array.isArray(summary.participants)).toBe(true);
    expect(summary.dateRange).toHaveProperty("first");
    expect(summary.dateRange).toHaveProperty("last");
    expect(typeof summary.content).toBe("string");
    expect(typeof summary.messageCount).toBe("number");
  });
});
