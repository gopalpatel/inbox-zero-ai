/**
 * sweep.test.ts
 *
 * Tests for the sweep module: buildSweepQueries, and sweep().
 * Also tests latestDecisionsBySender (now in decision-log-manager).
 * Mocks at the GmailClient interface level and the decision-log-manager module.
 */

import { describe, expect, it, vi } from "vitest";
import type { GmailClient } from "../../src/auth/gmail-client.js";
import type { DecisionEntry } from "../../src/schemas/decision-log.js";

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import { buildSweepQueries, sweep } from "../../src/noise/sweep.js";

// ---------------------------------------------------------------------------
// Mock decision-log-manager
// ---------------------------------------------------------------------------

vi.mock("../../src/state/decision-log-manager.js", () => ({
  readDecisionLog: vi.fn(),
  latestDecisionsBySender: vi.fn(),
  collectNoiseSenders: vi.fn(),
  NOISE_DECISIONS: new Set(["filter", "unsubscribe"]),
}));

import { collectNoiseSenders, latestDecisionsBySender } from "../../src/state/decision-log-manager.js";

const mockedCollectNoiseSenders = vi.mocked(collectNoiseSenders);
const mockedLatestDecisionsBySender = vi.mocked(latestDecisionsBySender);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal DecisionEntry for testing. */
function makeDecision(
  overrides: Partial<DecisionEntry> & Pick<DecisionEntry, "senderEmail" | "userDecision">,
): DecisionEntry {
  return {
    runId: "run-1",
    senderName: "Test Sender",
    presentedSenderType: "newsletter",
    senderTypeFeedback: "none",
    systemRecommendation: "filter",
    batchId: "batch-1",
    timestamp: "2026-03-18T00:00:00Z",
    emailCount: 10,
    messagesArchived: 0,
    actionsTaken: [],
    ...overrides,
  };
}

/** Build a list of message stubs with sequential IDs. */
function makeMessages(count: number, prefix = "msg"): Array<{ id: string; threadId: string }> {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i + 1}`,
    threadId: `thread-${prefix}-${i + 1}`,
  }));
}

/** Creates a mock GmailClient for sweep tests. */
function makeMockGmailClient(
  options: {
    listMessagesResponses?: Array<{
      ok: true;
      value: {
        messages: Array<{ id: string; threadId: string }>;
        nextPageToken?: string;
      };
    } | { ok: false; error: string }>;
    batchModifyResult?: { ok: true; value: undefined } | { ok: false; error: string };
  } = {},
): GmailClient {
  const listMock = vi.fn();
  const responses = options.listMessagesResponses ?? [];
  for (const resp of responses) {
    listMock.mockResolvedValueOnce(resp);
  }
  // Default: return empty messages for any unspecified calls
  listMock.mockResolvedValue({ ok: true, value: { messages: [], nextPageToken: undefined } });

  return {
    getProfile: vi.fn(),
    listMessages: listMock,
    getMessage: vi.fn(),
    batchModifyMessages: vi.fn().mockResolvedValue(
      options.batchModifyResult ?? { ok: true, value: undefined },
    ),
    listLabels: vi.fn(),
    listFilters: vi.fn(),
    createLabel: vi.fn(),
    createFilter: vi.fn(),
    deleteFilter: vi.fn().mockResolvedValue({ ok: true }),
  };
}

// ===========================================================================
// buildSweepQueries
// ===========================================================================

describe("buildSweepQueries()", () => {
  it("returns empty array for empty input", () => {
    const result = buildSweepQueries([], 25, 1200);
    expect(result).toEqual([]);
  });

  it("returns a single query for one sender", () => {
    const result = buildSweepQueries(["a@example.com"], 25, 1200);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("in:inbox (from:a@example.com)");
  });

  it("combines multiple senders with OR", () => {
    const result = buildSweepQueries(["a@x.com", "b@x.com", "c@x.com"], 25, 1200);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("in:inbox (from:a@x.com OR from:b@x.com OR from:c@x.com)");
  });

  it("respects maxSendersPerQuery cap", () => {
    const senders = ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"];
    const result = buildSweepQueries(senders, 2, 5000);
    // 5 senders / 2 per query = 3 queries
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("in:inbox (from:a@x.com OR from:b@x.com)");
    expect(result[1]).toBe("in:inbox (from:c@x.com OR from:d@x.com)");
    expect(result[2]).toBe("in:inbox (from:e@x.com)");
  });

  it("respects maxQueryChars cap — splits when query would exceed limit", () => {
    // Each "from:longname@longdomain.example.com" is ~40 chars
    // The prefix "in:inbox (" is 10 chars, closing ")" is 1 char
    // With " OR " separators, 3 senders would be ~140 chars
    // Set a low char limit to force splitting
    const senders = [
      "aaa@example.com",
      "bbb@example.com",
      "ccc@example.com",
    ];
    // "in:inbox (from:aaa@example.com)" is 31 chars
    // Adding " OR from:bbb@example.com" would bring it to ~56 + ")" = 57
    // Set maxQueryChars to 55 so the second sender triggers a new batch
    const result = buildSweepQueries(senders, 100, 55);
    // Each query should contain at most 1 sender with this tight limit
    expect(result.length).toBeGreaterThanOrEqual(2);
    // Verify no query exceeds the char limit
    for (const q of result) {
      expect(q.length).toBeLessThanOrEqual(55);
    }
  });

  it("always puts at least one sender per batch even if it exceeds maxQueryChars", () => {
    // A very long email that alone exceeds the char limit
    const longEmail = "a".repeat(50) + "@example.com";
    const result = buildSweepQueries([longEmail], 25, 10);
    // Must still produce one query despite exceeding the char limit
    expect(result).toHaveLength(1);
    expect(result[0]).toContain(longEmail);
  });

  it("both caps interact correctly — whichever is hit first triggers a split", () => {
    // Short emails but sender cap of 1
    const senders = ["a@x.com", "b@x.com"];
    const result = buildSweepQueries(senders, 1, 5000);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("in:inbox (from:a@x.com)");
    expect(result[1]).toBe("in:inbox (from:b@x.com)");
  });

  it("handles large number of senders correctly", () => {
    const senders = Array.from({ length: 50 }, (_, i) => `sender${i}@example.com`);
    const result = buildSweepQueries(senders, 10, 5000);
    expect(result).toHaveLength(5);
    // Each query should have 10 senders
    for (const q of result) {
      const fromCount = q.match(/from:/g);
      expect(fromCount).not.toBeNull();
      expect(fromCount!.length).toBeLessThanOrEqual(10);
    }
  });
});

// ===========================================================================
// latestDecisionsBySender (now in decision-log-manager, tested via import)
// ===========================================================================

// Use the real implementation for these unit tests
const { latestDecisionsBySender: realLatestDecisions } = await vi.importActual<
  typeof import("../../src/state/decision-log-manager.js")
>("../../src/state/decision-log-manager.js");

describe("latestDecisionsBySender()", () => {
  it("returns empty map for empty input", () => {
    const result = realLatestDecisions([]);
    expect(result.size).toBe(0);
  });

  it("returns single entry for single decision", () => {
    const decision = makeDecision({
      senderEmail: "a@example.com",
      userDecision: "filter",
    });
    const result = realLatestDecisions([decision]);
    expect(result.size).toBe(1);
    expect(result.get("a@example.com")).toBe(decision);
  });

  it("keeps the latest timestamp when same sender appears multiple times", () => {
    const older = makeDecision({
      senderEmail: "a@example.com",
      userDecision: "filter",
      timestamp: "2026-03-17T00:00:00Z",
    });
    const newer = makeDecision({
      senderEmail: "a@example.com",
      userDecision: "keep",
      timestamp: "2026-03-18T00:00:00Z",
    });
    const result = realLatestDecisions([older, newer]);
    expect(result.size).toBe(1);
    expect(result.get("a@example.com")).toBe(newer);
    expect(result.get("a@example.com")!.userDecision).toBe("keep");
  });

  it("handles multiple senders with interleaved timestamps", () => {
    const a1 = makeDecision({
      senderEmail: "a@example.com",
      userDecision: "filter",
      timestamp: "2026-03-17T00:00:00Z",
    });
    const b1 = makeDecision({
      senderEmail: "b@example.com",
      userDecision: "keep",
      timestamp: "2026-03-18T00:00:00Z",
    });
    const a2 = makeDecision({
      senderEmail: "a@example.com",
      userDecision: "unsubscribe",
      timestamp: "2026-03-19T00:00:00Z",
    });
    const result = realLatestDecisions([a1, b1, a2]);
    expect(result.size).toBe(2);
    expect(result.get("a@example.com")!.userDecision).toBe("unsubscribe");
    expect(result.get("b@example.com")!.userDecision).toBe("keep");
  });

  it("keep decisions are present in map but excluded from noise set", () => {
    const keep = makeDecision({
      senderEmail: "important@example.com",
      userDecision: "keep",
      timestamp: "2026-03-18T00:00:00Z",
    });
    const filter = makeDecision({
      senderEmail: "noise@example.com",
      userDecision: "filter",
      timestamp: "2026-03-18T00:00:00Z",
    });
    const result = realLatestDecisions([keep, filter]);
    expect(result.size).toBe(2);
    // Both are in the map, but only "filter" is noise
    expect(result.get("important@example.com")!.userDecision).toBe("keep");
    expect(result.get("noise@example.com")!.userDecision).toBe("filter");
  });
});

// ===========================================================================
// sweep() — integration with mocked GmailClient and decision log
// ===========================================================================

describe("sweep()", () => {
  it("returns ok with zero queries/messages when decision log file does not exist", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({ ok: true, value: null });
    const client = makeMockGmailClient();

    const result = await sweep({
      gmailClient: client,
      decisionLogPath: "/tmp/nonexistent.json",
      noiseLabelId: "label-noise-001",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.queriesSent).toBe(0);
    expect(result.value.messagesFound).toBe(0);
    expect(result.value.messagesSwept).toBe(0);
    expect(result.value.errors).toHaveLength(0);
  });

  it("returns ok with zero queries when decision log has only keep decisions", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: { filterSenders: [], unsubscribeSenders: [], allNoiseSenders: [] },
    });
    const client = makeMockGmailClient();

    const result = await sweep({
      gmailClient: client,
      decisionLogPath: "/tmp/decisions.json",
      noiseLabelId: "label-noise-001",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.queriesSent).toBe(0);
    expect(result.value.messagesFound).toBe(0);
    expect(client.listMessages).not.toHaveBeenCalled();
  });

  it("returns error when decision log is corrupt", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: false,
      error: "JSON parse error: Unexpected token",
    });
    const client = makeMockGmailClient();

    const result = await sweep({
      gmailClient: client,
      decisionLogPath: "/tmp/corrupt.json",
      noiseLabelId: "label-noise-001",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("JSON parse error");
  });

  it("queries Gmail for noise senders (filter + unsubscribe) and archives messages", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: ["spam@example.com"],
        unsubscribeSenders: ["unsub@example.com"],
        allNoiseSenders: ["spam@example.com", "unsub@example.com"],
      },
    });

    const messages = makeMessages(5, "sweep");
    const client = makeMockGmailClient({
      listMessagesResponses: [
        { ok: true, value: { messages, nextPageToken: undefined } },
      ],
    });

    const result = await sweep({
      gmailClient: client,
      decisionLogPath: "/tmp/decisions.json",
      noiseLabelId: "label-noise-001",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.queriesSent).toBe(1);
    expect(result.value.messagesFound).toBe(5);
    expect(result.value.messagesSwept).toBe(5);
    expect(result.value.errors).toHaveLength(0);

    // Verify batchModify was called with the right args
    expect(client.batchModifyMessages).toHaveBeenCalledWith(
      messages.map((m) => m.id),
      ["label-noise-001"],
      ["INBOX"],
    );
  });

  it("handles dry-run mode — queries but does not modify", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: ["noise@example.com"],
        unsubscribeSenders: [],
        allNoiseSenders: ["noise@example.com"],
      },
    });

    const messages = makeMessages(3, "dry");
    const client = makeMockGmailClient({
      listMessagesResponses: [
        { ok: true, value: { messages, nextPageToken: undefined } },
      ],
    });

    const result = await sweep({
      gmailClient: client,
      decisionLogPath: "/tmp/decisions.json",
      noiseLabelId: "label-noise-001",
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.messagesFound).toBe(3);
    expect(result.value.messagesSwept).toBe(0);
    expect(client.batchModifyMessages).not.toHaveBeenCalled();
  });

  it("paginates through all messages with safety cap", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: ["noise@example.com"],
        unsubscribeSenders: [],
        allNoiseSenders: ["noise@example.com"],
      },
    });

    const page1 = makeMessages(3, "p1");
    const page2 = makeMessages(2, "p2");
    const client = makeMockGmailClient({
      listMessagesResponses: [
        { ok: true, value: { messages: page1, nextPageToken: "token-2" } },
        { ok: true, value: { messages: page2, nextPageToken: undefined } },
      ],
    });

    const result = await sweep({
      gmailClient: client,
      decisionLogPath: "/tmp/decisions.json",
      noiseLabelId: "label-noise-001",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.messagesFound).toBe(5);
    expect(result.value.messagesSwept).toBe(5);
    expect(client.listMessages).toHaveBeenCalledTimes(2);
  });

  it("records error when listMessages fails for a query batch", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: ["noise@example.com"],
        unsubscribeSenders: [],
        allNoiseSenders: ["noise@example.com"],
      },
    });

    const client = makeMockGmailClient({
      listMessagesResponses: [
        { ok: false, error: "Rate limited" },
      ],
    });

    const result = await sweep({
      gmailClient: client,
      decisionLogPath: "/tmp/decisions.json",
      noiseLabelId: "label-noise-001",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.errors).toHaveLength(1);
    expect(result.value.errors[0]).toContain("Rate limited");
    expect(result.value.messagesSwept).toBe(0);
  });

  it("records error when batchModifyMessages fails", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: ["noise@example.com"],
        unsubscribeSenders: [],
        allNoiseSenders: ["noise@example.com"],
      },
    });

    const messages = makeMessages(3, "fail");
    const client = makeMockGmailClient({
      listMessagesResponses: [
        { ok: true, value: { messages, nextPageToken: undefined } },
      ],
      batchModifyResult: { ok: false, error: "Batch modify failed" },
    });

    const result = await sweep({
      gmailClient: client,
      decisionLogPath: "/tmp/decisions.json",
      noiseLabelId: "label-noise-001",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.errors).toHaveLength(1);
    expect(result.value.errors[0]).toContain("Batch modify failed");
    expect(result.value.messagesSwept).toBe(0);
  });

  it("uses latest decision per sender — a re-kept sender is not swept", async () => {
    // collectNoiseSenders would return empty when the latest decision is "keep"
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: { filterSenders: [], unsubscribeSenders: [], allNoiseSenders: [] },
    });

    const client = makeMockGmailClient();

    const result = await sweep({
      gmailClient: client,
      decisionLogPath: "/tmp/decisions.json",
      noiseLabelId: "label-noise-001",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Sender was re-kept, so no queries should be sent
    expect(result.value.queriesSent).toBe(0);
    expect(client.listMessages).not.toHaveBeenCalled();
  });

  it("calls onProgress with cumulative counts", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: ["a@example.com", "b@example.com"],
        unsubscribeSenders: [],
        allNoiseSenders: ["a@example.com", "b@example.com"],
      },
    });

    const messages = makeMessages(4, "prog");
    const client = makeMockGmailClient({
      listMessagesResponses: [
        { ok: true, value: { messages, nextPageToken: undefined } },
      ],
    });

    const progressCalls: Array<{ queriesSent: number; messagesSwept: number }> = [];

    const result = await sweep({
      gmailClient: client,
      decisionLogPath: "/tmp/decisions.json",
      noiseLabelId: "label-noise-001",
      onProgress: (info) => progressCalls.push({ ...info }),
    });

    expect(result.ok).toBe(true);
    // onProgress should have been called at least once
    expect(progressCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("splits large noise sender lists into multiple query batches", async () => {
    // Create 30 noise senders — with default maxSendersPerQuery=25, should create 2 batches
    const senders = Array.from({ length: 30 }, (_, i) => `sender${i}@example.com`);

    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: senders,
        unsubscribeSenders: [],
        allNoiseSenders: senders,
      },
    });

    const client = makeMockGmailClient();

    const result = await sweep({
      gmailClient: client,
      decisionLogPath: "/tmp/decisions.json",
      noiseLabelId: "label-noise-001",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.queriesSent).toBe(2);
  });

  it("respects maxSendersPerQuery option", async () => {
    const senders = Array.from({ length: 10 }, (_, i) => `sender${i}@x.com`);

    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: senders,
        unsubscribeSenders: [],
        allNoiseSenders: senders,
      },
    });

    const client = makeMockGmailClient();

    const result = await sweep({
      gmailClient: client,
      decisionLogPath: "/tmp/decisions.json",
      noiseLabelId: "label-noise-001",
      maxSendersPerQuery: 3,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 10 senders / 3 per query = 4 queries (3, 3, 3, 1)
    expect(result.value.queriesSent).toBe(4);
  });

  it("empty decision log (no decisions array items) produces zero queries", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: null,
    });
    const client = makeMockGmailClient();

    const result = await sweep({
      gmailClient: client,
      decisionLogPath: "/tmp/decisions.json",
      noiseLabelId: "label-noise-001",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.queriesSent).toBe(0);
    expect(client.listMessages).not.toHaveBeenCalled();
  });
});
