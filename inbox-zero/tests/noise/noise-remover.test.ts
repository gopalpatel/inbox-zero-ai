/**
 * noise-remover.test.ts
 *
 * Tests for archiveNoiseSenders(). Mocks at the GmailClient interface level.
 */

import { describe, expect, it, vi } from "vitest";
import type { GmailClient } from "../../src/auth/gmail-client.js";

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import { type ArchiveProgress, archiveNoiseSenders } from "../../src/noise/noise-remover.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a list of message stubs with sequential IDs. */
function makeMessages(count: number, prefix = "msg"): Array<{ id: string; threadId: string }> {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i + 1}`,
    threadId: `thread-${prefix}-${i + 1}`,
  }));
}

/**
 * Creates a mock GmailClient for noise-remover tests.
 * Supports per-sender message lists and per-call batchModify results.
 */
function makeMockGmailClient(
  options: {
    /** Map from sender email → array of messages to return from listMessages. */
    senderMessages?: Map<string, Array<{ id: string; threadId: string }>>;
    /** If true, listMessages returns { ok: false } for all calls. */
    listMessagesError?: string;
    /** If true, batchModifyMessages returns { ok: false } for all calls. */
    batchModifyError?: string;
    noiseLabelId?: string;
  } = {},
): GmailClient {
  const senderMessages = options.senderMessages ?? new Map();
  const noiseLabelId = options.noiseLabelId ?? "label-noise-001";

  return {
    getProfile: vi.fn(),
    listMessages: vi.fn().mockImplementation((query: string, _pageToken?: string) => {
      if (options.listMessagesError) {
        return Promise.resolve({ ok: false, error: options.listMessagesError });
      }
      // Extract sender from "from:sender@example.com" query
      const match = query.match(/^from:(.{1,200})$/);
      const sender = match?.[1] ?? "";
      const messages = senderMessages.get(sender) ?? [];
      // No pagination in basic mock — return all messages on first page
      return Promise.resolve({ ok: true, value: { messages, nextPageToken: undefined } });
    }),
    getMessage: vi.fn(),
    batchModifyMessages: vi.fn().mockImplementation(() => {
      if (options.batchModifyError) {
        return Promise.resolve({ ok: false, error: options.batchModifyError });
      }
      return Promise.resolve({ ok: true, value: undefined });
    }),
    listLabels: vi.fn().mockResolvedValue({
      ok: true,
      value: [{ id: noiseLabelId, name: "_noise" }],
    }),
    listFilters: vi.fn(),
    createLabel: vi.fn(),
    createFilter: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// archiveNoiseSenders — basic behavior
// ---------------------------------------------------------------------------

describe("archiveNoiseSenders() — basic behavior", () => {
  it("returns totalArchived = 0 and no failures for empty senders list", async () => {
    const client = makeMockGmailClient();

    const result = await archiveNoiseSenders(client, [], "label-noise-001");

    expect(result.totalArchived).toBe(0);
    expect(result.failures).toHaveLength(0);
  });

  it("searches for messages using 'from:sender@example.com' query", async () => {
    const client = makeMockGmailClient({
      senderMessages: new Map([["newsletter@example.com", makeMessages(3)]]),
    });

    await archiveNoiseSenders(client, ["newsletter@example.com"], "label-noise-001");

    expect(client.listMessages).toHaveBeenCalledWith("from:newsletter@example.com", undefined);
  });

  it("calls batchModifyMessages with correct add/remove labels", async () => {
    const messages = makeMessages(3);
    const client = makeMockGmailClient({
      senderMessages: new Map([["a@example.com", messages]]),
    });

    await archiveNoiseSenders(client, ["a@example.com"], "label-noise-001");

    const ids = messages.map((m) => m.id);
    expect(client.batchModifyMessages).toHaveBeenCalledWith(
      ids,
      ["label-noise-001"], // addLabelIds
      ["INBOX"], // removeLabelIds
    );
  });

  it("returns totalArchived equal to number of messages processed", async () => {
    const client = makeMockGmailClient({
      senderMessages: new Map([
        ["a@example.com", makeMessages(5, "a")],
        ["b@example.com", makeMessages(3, "b")],
      ]),
    });

    const result = await archiveNoiseSenders(client, ["a@example.com", "b@example.com"], "label-noise-001");

    expect(result.totalArchived).toBe(8);
    expect(result.failures).toHaveLength(0);
  });

  it("skips senders with zero messages (no batchModify call for them)", async () => {
    const client = makeMockGmailClient({
      senderMessages: new Map([
        ["a@example.com", []],
        ["b@example.com", makeMessages(2, "b")],
      ]),
    });

    await archiveNoiseSenders(client, ["a@example.com", "b@example.com"], "label-noise-001");

    // batchModify should only be called for b@example.com
    expect(client.batchModifyMessages).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// archiveNoiseSenders — pagination
// ---------------------------------------------------------------------------

describe("archiveNoiseSenders() — pagination", () => {
  it("follows nextPageToken to collect all messages from a sender", async () => {
    const page1Messages = makeMessages(3, "page1");
    const page2Messages = makeMessages(2, "page2");

    const listMessagesMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { messages: page1Messages, nextPageToken: "token-page-2" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { messages: page2Messages, nextPageToken: undefined },
      });

    const client: GmailClient = {
      getProfile: vi.fn(),
      listMessages: listMessagesMock,
      getMessage: vi.fn(),
      batchModifyMessages: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      listLabels: vi.fn(),
      listFilters: vi.fn(),
      createLabel: vi.fn(),
      createFilter: vi.fn(),
    };

    const result = await archiveNoiseSenders(client, ["multi-page@example.com"], "label-noise-001");

    // Should have called listMessages twice (once per page)
    expect(listMessagesMock).toHaveBeenCalledTimes(2);
    expect(listMessagesMock).toHaveBeenCalledWith("from:multi-page@example.com", undefined);
    expect(listMessagesMock).toHaveBeenCalledWith("from:multi-page@example.com", "token-page-2");

    // Total archived = 3 + 2 = 5
    expect(result.totalArchived).toBe(5);
    expect(result.failures).toHaveLength(0);
  });

  it("stops pagination if a page request fails and records failure", async () => {
    const page1Messages = makeMessages(3, "page1");

    const listMessagesMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { messages: page1Messages, nextPageToken: "token-page-2" },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: "Rate limited during pagination",
      });

    const client: GmailClient = {
      getProfile: vi.fn(),
      listMessages: listMessagesMock,
      getMessage: vi.fn(),
      batchModifyMessages: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      listLabels: vi.fn(),
      listFilters: vi.fn(),
      createLabel: vi.fn(),
      createFilter: vi.fn(),
    };

    const result = await archiveNoiseSenders(client, ["pagefail@example.com"], "label-noise-001");

    // Should have called listMessages twice (first succeeded, second failed)
    expect(listMessagesMock).toHaveBeenCalledTimes(2);

    // Failure recorded, no messages archived (because pagination error aborts)
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.sender).toBe("pagefail@example.com");
    expect(result.failures[0]!.error).toContain("Rate limited during pagination");
    expect(result.totalArchived).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// archiveNoiseSenders — chunked batchModify (1000 IDs per call)
// ---------------------------------------------------------------------------

describe("archiveNoiseSenders() — chunked batchModify", () => {
  it("splits > 1000 messages into multiple batchModify calls", async () => {
    const messages = makeMessages(2500, "big");
    const client = makeMockGmailClient({
      senderMessages: new Map([["big@example.com", messages]]),
    });

    await archiveNoiseSenders(client, ["big@example.com"], "label-noise-001");

    // 2500 messages → 3 calls: 1000, 1000, 500
    expect(client.batchModifyMessages).toHaveBeenCalledTimes(3);

    const calls = (client.batchModifyMessages as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toHaveLength(1000);
    expect(calls[1]![0]).toHaveLength(1000);
    expect(calls[2]![0]).toHaveLength(500);
  });

  it("handles exactly 1000 messages in a single batchModify call", async () => {
    const messages = makeMessages(1000, "exact");
    const client = makeMockGmailClient({
      senderMessages: new Map([["exact@example.com", messages]]),
    });

    await archiveNoiseSenders(client, ["exact@example.com"], "label-noise-001");

    expect(client.batchModifyMessages).toHaveBeenCalledTimes(1);
    const callArgs = (client.batchModifyMessages as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(callArgs[0]).toHaveLength(1000);
  });
});

// ---------------------------------------------------------------------------
// archiveNoiseSenders — progress callback
// ---------------------------------------------------------------------------

describe("archiveNoiseSenders() — progress callback", () => {
  it("calls progress callback for each sender processed", async () => {
    const client = makeMockGmailClient({
      senderMessages: new Map([
        ["a@example.com", makeMessages(5, "a")],
        ["b@example.com", makeMessages(3, "b")],
      ]),
    });

    const progressCalls: ArchiveProgress[] = [];

    await archiveNoiseSenders(client, ["a@example.com", "b@example.com"], "label-noise-001", {
      onProgress: (p) => progressCalls.push(p),
    });

    expect(progressCalls).toHaveLength(2);
  });

  it("progress callback receives correct fields", async () => {
    const client = makeMockGmailClient({
      senderMessages: new Map([
        ["a@example.com", makeMessages(5, "a")],
        ["b@example.com", makeMessages(3, "b")],
      ]),
    });

    const progressCalls: ArchiveProgress[] = [];

    await archiveNoiseSenders(client, ["a@example.com", "b@example.com"], "label-noise-001", {
      onProgress: (p) => progressCalls.push(p),
    });

    const first = progressCalls[0]!;
    expect(first.sender).toBe("a@example.com");
    expect(first.messagesArchived).toBe(5);
    expect(first.totalSenders).toBe(2);
    expect(first.currentSenderIndex).toBe(0);

    const second = progressCalls[1]!;
    expect(second.sender).toBe("b@example.com");
    expect(second.messagesArchived).toBe(3);
    expect(second.totalSenders).toBe(2);
    expect(second.currentSenderIndex).toBe(1);
  });

  it("calls progress callback even when a sender has zero messages", async () => {
    const client = makeMockGmailClient({
      senderMessages: new Map([["empty@example.com", []]]),
    });

    const progressCalls: ArchiveProgress[] = [];

    await archiveNoiseSenders(client, ["empty@example.com"], "label-noise-001", {
      onProgress: (p) => progressCalls.push(p),
    });

    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0]!.messagesArchived).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// archiveNoiseSenders — partial failures
// ---------------------------------------------------------------------------

describe("archiveNoiseSenders() — partial failures", () => {
  it("records failure for sender when listMessages fails, continues with others", async () => {
    const listMessagesMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "Rate limit" })
      .mockResolvedValue({
        ok: true,
        value: { messages: makeMessages(3, "b"), nextPageToken: undefined },
      });

    const client: GmailClient = {
      getProfile: vi.fn(),
      listMessages: listMessagesMock,
      getMessage: vi.fn(),
      batchModifyMessages: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      listLabels: vi.fn(),
      listFilters: vi.fn(),
      createLabel: vi.fn(),
      createFilter: vi.fn(),
    };

    const result = await archiveNoiseSenders(client, ["a@example.com", "b@example.com"], "label-noise-001");

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.sender).toBe("a@example.com");
    expect(result.failures[0]!.error).toContain("Rate limit");
    expect(result.totalArchived).toBe(3);
  });

  it("records failure when batchModifyMessages fails for a sender", async () => {
    const batchModifyMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "Batch modify failed" })
      .mockResolvedValue({ ok: true, value: undefined });

    const client: GmailClient = {
      getProfile: vi.fn(),
      listMessages: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          value: { messages: makeMessages(2, "a"), nextPageToken: undefined },
        })
        .mockResolvedValueOnce({
          ok: true,
          value: { messages: makeMessages(2, "b"), nextPageToken: undefined },
        }),
      getMessage: vi.fn(),
      batchModifyMessages: batchModifyMock,
      listLabels: vi.fn(),
      listFilters: vi.fn(),
      createLabel: vi.fn(),
      createFilter: vi.fn(),
    };

    const result = await archiveNoiseSenders(client, ["a@example.com", "b@example.com"], "label-noise-001");

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.sender).toBe("a@example.com");
    expect(result.totalArchived).toBe(2);
  });

  it("returns summary with totalArchived = 0 and all failures when all senders fail", async () => {
    const client = makeMockGmailClient({
      listMessagesError: "Network error",
    });

    const result = await archiveNoiseSenders(
      client,
      ["a@example.com", "b@example.com", "c@example.com"],
      "label-noise-001",
    );

    expect(result.totalArchived).toBe(0);
    expect(result.failures).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// archiveNoiseSenders — safety limit
// ---------------------------------------------------------------------------

describe("archiveNoiseSenders() — safety limit", () => {
  it("respects maxSenders option and stops after the limit", async () => {
    const senderMessages = new Map<string, Array<{ id: string; threadId: string }>>();
    for (let i = 0; i < 10; i++) {
      senderMessages.set(`sender${i}@example.com`, makeMessages(1, `s${i}`));
    }

    const client = makeMockGmailClient({ senderMessages });

    const senders = Array.from(senderMessages.keys());

    const result = await archiveNoiseSenders(client, senders, "label-noise-001", {
      maxSenders: 5,
    });

    // Only 5 senders should be processed
    expect(client.listMessages).toHaveBeenCalledTimes(5);
    expect(result.totalArchived).toBe(5);
  });

  it("throws RangeError when maxSenders is zero", async () => {
    const client = makeMockGmailClient();
    await expect(
      archiveNoiseSenders(client, ["a@example.com"], "label-noise-001", {
        maxSenders: 0,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("throws RangeError when maxSenders is negative", async () => {
    const client = makeMockGmailClient();
    await expect(
      archiveNoiseSenders(client, ["a@example.com"], "label-noise-001", {
        maxSenders: -1,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("throws RangeError when maxMessagesPerSender is zero", async () => {
    const client = makeMockGmailClient();
    await expect(
      archiveNoiseSenders(client, ["a@example.com"], "label-noise-001", {
        maxMessagesPerSender: 0,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("throws RangeError when maxMessagesPerSender is negative", async () => {
    const client = makeMockGmailClient();
    await expect(
      archiveNoiseSenders(client, ["a@example.com"], "label-noise-001", {
        maxMessagesPerSender: -5,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("records a failure when maxMessagesPerSender truncates a sender", async () => {
    const listMessagesMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { messages: makeMessages(3, "page1"), nextPageToken: "page-2" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { messages: makeMessages(2, "page2"), nextPageToken: undefined },
      });

    const client: GmailClient = {
      getProfile: vi.fn(),
      listMessages: listMessagesMock,
      getMessage: vi.fn(),
      batchModifyMessages: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      listLabels: vi.fn(),
      listFilters: vi.fn(),
      createLabel: vi.fn(),
      createFilter: vi.fn(),
    };

    const result = await archiveNoiseSenders(client, ["truncated@example.com"], "label-noise-001", {
      maxMessagesPerSender: 3,
    });

    expect(result.totalArchived).toBe(3);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.error).toContain("increase maxMessagesPerSender");
  });
});

// ---------------------------------------------------------------------------
// ArchiveProgress type
// ---------------------------------------------------------------------------

describe("ArchiveProgress type", () => {
  it("has the expected fields", () => {
    const progress: ArchiveProgress = {
      sender: "test@example.com",
      messagesArchived: 10,
      totalSenders: 5,
      currentSenderIndex: 2,
    };
    expect(progress.sender).toBe("test@example.com");
    expect(progress.messagesArchived).toBe(10);
    expect(progress.totalSenders).toBe(5);
    expect(progress.currentSenderIndex).toBe(2);
  });
});
