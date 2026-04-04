/**
 * metadata-puller.test.ts
 *
 * Tests for MetadataPuller.pull(). Mocks at the GmailClient interface level
 * (not the raw API level). Mocks checkpoint-manager and message-parser modules
 * to isolate puller logic.
 */

import type { gmail_v1 } from "googleapis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GmailClient, Result as GmailResult } from "../../src/auth/gmail-client.js";
import type { Checkpoint } from "../../src/schemas/checkpoint.js";
import type { EmailMetadata } from "../../src/schemas/email-metadata.js";

// ---------------------------------------------------------------------------
// Module mocks (hoisted so they intercept before imports in the module under test)
// ---------------------------------------------------------------------------

vi.mock("../../src/pull/checkpoint-manager.js", () => ({
  BATCH_SIZE: 3, // small value so tests can exercise batching without 500 messages
  saveCheckpoint: vi.fn(),
  loadCheckpoint: vi.fn(),
  saveBatch: vi.fn(),
  loadAllBatches: vi.fn(),
}));

vi.mock("../../src/pull/message-parser.js", () => ({
  parseGmailMessage: vi.fn(),
}));

// Import mocked modules after vi.mock declarations
import * as checkpointModule from "../../src/pull/checkpoint-manager.js";
import * as parserModule from "../../src/pull/message-parser.js";
import { pull } from "../../src/pull/metadata-puller.js";

// ---------------------------------------------------------------------------
// Types for casting mocks
// ---------------------------------------------------------------------------

type MockedFn<T extends (...args: unknown[]) => unknown> = ReturnType<typeof vi.fn> & T;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid EmailMetadata for test assertions. */
function makeEmailMetadata(id: string): EmailMetadata {
  return {
    messageId: id,
    threadId: `thread-${id}`,
    sender: { email: "sender@example.com", name: "Sender" },
    recipients: { to: ["me@example.com"], cc: [] },
    subject: `Subject for ${id}`,
    dateReceived: new Date("2026-01-01T00:00:00.000Z"),
    gmailCategory: "primary",
    labels: ["INBOX"],
    isUnread: false,
    snippet: "snippet text",
  };
}

/** Minimal valid raw Gmail message (metadata format). */
function makeRawMessage(id: string): gmail_v1.Schema$Message {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: "1704067200000",
    labelIds: ["INBOX"],
    snippet: "snippet text",
    payload: {
      headers: [
        { name: "From", value: "Sender <sender@example.com>" },
        { name: "To", value: "me@example.com" },
        { name: "Cc", value: "" },
        { name: "Subject", value: `Subject for ${id}` },
      ],
    },
  };
}

/** Minimal valid Checkpoint for test use. */
function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    status: "in_progress",
    query: "in:anywhere -in:spam -in:trash -in:drafts -in:sent",
    pageToken: null,
    messagesFetched: 0,
    batchesSaved: 0,
    lastSavedAt: new Date("2026-03-17T00:00:00.000Z"),
    errors: [],
    ...overrides,
  };
}

/**
 * Creates a mock GmailClient that supports configurable paginated responses.
 *
 * `pages` is an array of page responses. Each element is:
 *   - `messages`: array of `{id, threadId}` for that page
 *   - `nextPageToken`: token to resume (undefined on last page)
 *   - `resultSizeEstimate`: total estimate returned by the API
 *
 * `getMessage` returns a raw message based on the id, or a fixed result if
 * `getMessageResult` is provided.
 */
function createMockClient(
  pages: Array<{
    messages: Array<{ id: string; threadId: string }>;
    nextPageToken?: string;
    resultSizeEstimate?: number;
  }>,
  opts: {
    getMessageResult?: (id: string) => GmailResult<gmail_v1.Schema$Message>;
    profileTotal?: number;
  } = {},
): GmailClient {
  let pageIndex = 0;

  const listMessages = vi.fn().mockImplementation(
    async (
      _query: string,
      _pageToken?: string,
    ): Promise<
      GmailResult<{
        messages: Array<{ id: string; threadId: string }>;
        nextPageToken?: string;
        resultSizeEstimate?: number;
      }>
    > => {
      if (pageIndex >= pages.length) {
        return { ok: true, value: { messages: [], nextPageToken: undefined } };
      }
      const page = pages[pageIndex++]!;
      return {
        ok: true,
        value: {
          messages: page.messages,
          nextPageToken: page.nextPageToken,
          resultSizeEstimate: page.resultSizeEstimate ?? page.messages.length,
        },
      };
    },
  );

  const getMessage = vi.fn().mockImplementation(async (id: string): Promise<GmailResult<gmail_v1.Schema$Message>> => {
    if (opts.getMessageResult) return opts.getMessageResult(id);
    return { ok: true, value: makeRawMessage(id) };
  });

  return {
    listMessages,
    getMessage,
    getProfile: vi.fn().mockResolvedValue({
      ok: true,
      value: { emailAddress: "me@example.com", messagesTotal: opts.profileTotal ?? 100 },
    }),
    batchModifyMessages: vi.fn(),
    listLabels: vi.fn(),
    listFilters: vi.fn(),
    createLabel: vi.fn(),
    createFilter: vi.fn(),
  } as GmailClient;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const DATA_DIR = "/tmp/inbox-zero-test-data";

const PULL_QUERY = "in:anywhere -in:spam -in:trash -in:drafts -in:sent";

beforeEach(() => {
  vi.clearAllMocks();

  // Default: no existing checkpoint (fresh start)
  (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
    ok: false,
    error: "No checkpoint file found (fresh start)",
  });

  // Default: saveCheckpoint succeeds
  (checkpointModule.saveCheckpoint as MockedFn<typeof checkpointModule.saveCheckpoint>).mockResolvedValue({
    ok: true,
    value: undefined,
  });

  // Default: saveBatch returns an updated checkpoint
  (checkpointModule.saveBatch as MockedFn<typeof checkpointModule.saveBatch>).mockImplementation(
    async (batch: EmailMetadata[], checkpoint: Checkpoint) => {
      const updated: Checkpoint = {
        ...checkpoint,
        batchesSaved: checkpoint.batchesSaved + 1,
        messagesFetched: checkpoint.messagesFetched + batch.length,
        lastSavedAt: new Date(),
      };
      return { ok: true, value: updated };
    },
  );

  // Default: parseGmailMessage converts raw message to EmailMetadata
  (parserModule.parseGmailMessage as MockedFn<typeof parserModule.parseGmailMessage>).mockImplementation(
    (raw: gmail_v1.Schema$Message) => {
      if (!raw.id) return { ok: false, error: "Missing id" };
      return { ok: true, value: makeEmailMetadata(raw.id) };
    },
  );
});

// ---------------------------------------------------------------------------
// Tests: query
// ---------------------------------------------------------------------------

describe("pull() — query", () => {
  it("fetches messages using the correct query string", async () => {
    const client = createMockClient([{ messages: [{ id: "msg-1", threadId: "t-1" }], nextPageToken: undefined }]);

    await pull({ client, dataDir: DATA_DIR });

    expect(client.listMessages).toHaveBeenCalledWith(PULL_QUERY, undefined, expect.any(Number));
  });
});

// ---------------------------------------------------------------------------
// Tests: pagination
// ---------------------------------------------------------------------------

describe("pull() — pagination", () => {
  it("paginates through all pages using nextPageToken", async () => {
    const client = createMockClient([
      {
        messages: [{ id: "msg-1", threadId: "t-1" }],
        nextPageToken: "token-page-2",
      },
      {
        messages: [{ id: "msg-2", threadId: "t-2" }],
        nextPageToken: "token-page-3",
      },
      {
        messages: [{ id: "msg-3", threadId: "t-3" }],
        nextPageToken: undefined,
      },
    ]);

    const result = await pull({ client, dataDir: DATA_DIR });

    expect(result.ok).toBe(true);
    // listMessages called once per page
    expect(client.listMessages).toHaveBeenCalledTimes(3);
    // Second call should use the first page's token
    expect(client.listMessages).toHaveBeenNthCalledWith(2, PULL_QUERY, "token-page-2", expect.any(Number));
    // Third call should use the second page's token
    expect(client.listMessages).toHaveBeenNthCalledWith(3, PULL_QUERY, "token-page-3", expect.any(Number));
  });

  it("fetches getMessage for every message ID across all pages", async () => {
    const client = createMockClient([
      {
        messages: [
          { id: "msg-1", threadId: "t-1" },
          { id: "msg-2", threadId: "t-2" },
        ],
        nextPageToken: "token-2",
      },
      {
        messages: [{ id: "msg-3", threadId: "t-3" }],
        nextPageToken: undefined,
      },
    ]);

    await pull({ client, dataDir: DATA_DIR });

    expect(client.getMessage).toHaveBeenCalledTimes(3);
    expect(client.getMessage).toHaveBeenCalledWith("msg-1", "metadata", ["From", "To", "Cc", "Subject"]);
    expect(client.getMessage).toHaveBeenCalledWith("msg-2", "metadata", ["From", "To", "Cc", "Subject"]);
    expect(client.getMessage).toHaveBeenCalledWith("msg-3", "metadata", ["From", "To", "Cc", "Subject"]);
  });
});

// ---------------------------------------------------------------------------
// Tests: batching and checkpoint saving
// ---------------------------------------------------------------------------

describe("pull() — batching", () => {
  it("saves a checkpoint every BATCH_SIZE messages", async () => {
    // BATCH_SIZE is mocked to 3 in this test file.
    // Page 1: 3 messages → exactly 1 batch saved at end of page
    // Page 2: 3 more messages → another batch
    const client = createMockClient([
      {
        messages: [
          { id: "msg-1", threadId: "t-1" },
          { id: "msg-2", threadId: "t-2" },
          { id: "msg-3", threadId: "t-3" },
        ],
        nextPageToken: "next",
      },
      {
        messages: [
          { id: "msg-4", threadId: "t-4" },
          { id: "msg-5", threadId: "t-5" },
          { id: "msg-6", threadId: "t-6" },
        ],
        nextPageToken: undefined,
      },
    ]);

    await pull({ client, dataDir: DATA_DIR });

    // saveBatch called twice: once per BATCH_SIZE boundary
    expect(checkpointModule.saveBatch).toHaveBeenCalledTimes(2);
    // saveCheckpoint called at least once (after each batch save + final)
    expect(checkpointModule.saveCheckpoint).toHaveBeenCalled();
  });

  it("passes correct batch contents to saveBatch", async () => {
    // 3 messages = exactly 1 batch (BATCH_SIZE = 3)
    const client = createMockClient([
      {
        messages: [
          { id: "msg-1", threadId: "t-1" },
          { id: "msg-2", threadId: "t-2" },
          { id: "msg-3", threadId: "t-3" },
        ],
        nextPageToken: undefined,
      },
    ]);

    await pull({ client, dataDir: DATA_DIR });

    const saveBatchCalls = (checkpointModule.saveBatch as MockedFn<typeof checkpointModule.saveBatch>).mock.calls;
    expect(saveBatchCalls.length).toBeGreaterThanOrEqual(1);
    const firstBatch = saveBatchCalls[0]![0] as EmailMetadata[];
    expect(firstBatch).toHaveLength(3);
    const ids = firstBatch.map((m) => m.messageId);
    expect(ids).toContain("msg-1");
    expect(ids).toContain("msg-2");
    expect(ids).toContain("msg-3");
  });
});

// ---------------------------------------------------------------------------
// Tests: checkpoint resume
// ---------------------------------------------------------------------------

describe("pull() — checkpoint resume", () => {
  it("resumes from an existing checkpoint using saved pageToken", async () => {
    const existingCheckpoint = makeCheckpoint({
      pageToken: "resume-token",
      messagesFetched: 100,
      batchesSaved: 2,
    });

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: existingCheckpoint,
    });

    const client = createMockClient([
      {
        messages: [{ id: "msg-101", threadId: "t-101" }],
        nextPageToken: undefined,
      },
    ]);

    await pull({ client, dataDir: DATA_DIR });

    // First listMessages call must use the saved pageToken
    expect(client.listMessages).toHaveBeenCalledWith(PULL_QUERY, "resume-token", expect.any(Number));
  });

  it("starts fresh (pageToken=undefined) when no checkpoint exists", async () => {
    // loadCheckpoint already returns { ok: false } by default in beforeEach
    const client = createMockClient([
      {
        messages: [{ id: "msg-1", threadId: "t-1" }],
        nextPageToken: undefined,
      },
    ]);

    await pull({ client, dataDir: DATA_DIR });

    expect(client.listMessages).toHaveBeenCalledWith(PULL_QUERY, undefined, expect.any(Number));
  });
});

// ---------------------------------------------------------------------------
// Tests: rate limit handling
// ---------------------------------------------------------------------------

describe("pull() — rate limit handling", () => {
  it("does not fail when getMessage returns a 429-style error (client already retried)", async () => {
    // The GmailClient handles retries internally and returns { ok: false } only
    // when retries are exhausted. We test that pull() records the error and
    // continues fetching the remaining messages.
    const client = createMockClient(
      [
        {
          messages: [
            { id: "msg-ok", threadId: "t-ok" },
            { id: "msg-fail", threadId: "t-fail" },
            { id: "msg-ok2", threadId: "t-ok2" },
          ],
          nextPageToken: undefined,
        },
      ],
      {
        getMessageResult: (id: string) => {
          if (id === "msg-fail") {
            return { ok: false, error: "Rate limit exceeded after retries" };
          }
          return { ok: true, value: makeRawMessage(id) };
        },
      },
    );

    const result = await pull({ client, dataDir: DATA_DIR });

    expect(result.ok).toBe(true);
    // Error should be recorded in checkpoint errors
    const saveCheckpointCalls = (checkpointModule.saveCheckpoint as MockedFn<typeof checkpointModule.saveCheckpoint>)
      .mock.calls;
    const lastCall = saveCheckpointCalls[saveCheckpointCalls.length - 1];
    const finalCheckpoint = lastCall?.[0] as Checkpoint | undefined;
    expect(finalCheckpoint?.errors.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: error recording and continuation
// ---------------------------------------------------------------------------

describe("pull() — error handling", () => {
  it("records parse errors in checkpoint and continues processing", async () => {
    // msg-2 will fail to parse; msg-1 and msg-3 should still be processed
    (parserModule.parseGmailMessage as MockedFn<typeof parserModule.parseGmailMessage>).mockImplementation(
      (raw: gmail_v1.Schema$Message) => {
        if (raw.id === "msg-2") {
          return { ok: false, error: "Missing From header" };
        }
        if (!raw.id) return { ok: false, error: "Missing id" };
        return { ok: true, value: makeEmailMetadata(raw.id) };
      },
    );

    const client = createMockClient([
      {
        messages: [
          { id: "msg-1", threadId: "t-1" },
          { id: "msg-2", threadId: "t-2" },
          { id: "msg-3", threadId: "t-3" },
        ],
        nextPageToken: undefined,
      },
    ]);

    const result = await pull({ client, dataDir: DATA_DIR });

    expect(result.ok).toBe(true);

    // The 2 successful messages should still be processed (saveBatch or held in buffer)
    // Check that error was recorded
    const saveCheckpointCalls = (checkpointModule.saveCheckpoint as MockedFn<typeof checkpointModule.saveCheckpoint>)
      .mock.calls;
    const lastCall = saveCheckpointCalls[saveCheckpointCalls.length - 1];
    const finalCheckpoint = lastCall?.[0] as Checkpoint | undefined;
    expect(finalCheckpoint?.errors.length).toBeGreaterThanOrEqual(1);
    expect(finalCheckpoint?.errors[0]?.message).toContain("Missing From header");
  });

  it("returns ok: false when listMessages fails mid-pagination", async () => {
    const client = createMockClient([
      {
        messages: [{ id: "msg-1", threadId: "t-1" }],
        nextPageToken: "next-page",
      },
      {
        messages: [],
        nextPageToken: undefined,
      },
    ]);

    const listMessagesMock = client.listMessages as ReturnType<typeof vi.fn>;
    listMessagesMock
      .mockResolvedValueOnce({
        ok: true,
        value: { messages: [{ id: "msg-1", threadId: "t-1" }], nextPageToken: "next-page" },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: "Pagination failed",
      });

    const result = await pull({ client, dataDir: DATA_DIR });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toContain("Pagination failed");

    const saveCheckpointCalls = (checkpointModule.saveCheckpoint as MockedFn<typeof checkpointModule.saveCheckpoint>)
      .mock.calls;
    const lastCall = saveCheckpointCalls[saveCheckpointCalls.length - 1];
    const finalCheckpoint = lastCall?.[0] as Checkpoint | undefined;
    expect(finalCheckpoint?.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Tests: completion
// ---------------------------------------------------------------------------

describe("pull() — completion", () => {
  it("sets checkpoint status to complete when no more pages", async () => {
    const client = createMockClient([
      {
        messages: [{ id: "msg-1", threadId: "t-1" }],
        nextPageToken: undefined,
      },
    ]);

    await pull({ client, dataDir: DATA_DIR });

    const saveCheckpointCalls = (checkpointModule.saveCheckpoint as MockedFn<typeof checkpointModule.saveCheckpoint>)
      .mock.calls;
    const lastCall = saveCheckpointCalls[saveCheckpointCalls.length - 1];
    const finalCheckpoint = lastCall?.[0] as Checkpoint | undefined;
    expect(finalCheckpoint?.status).toBe("complete");
  });

  it("saves remaining messages (less than BATCH_SIZE) on completion", async () => {
    // 2 messages < BATCH_SIZE (3) — should still be saved at end
    const client = createMockClient([
      {
        messages: [
          { id: "msg-1", threadId: "t-1" },
          { id: "msg-2", threadId: "t-2" },
        ],
        nextPageToken: undefined,
      },
    ]);

    await pull({ client, dataDir: DATA_DIR });

    // saveBatch should be called even for partial batches at completion
    expect(checkpointModule.saveBatch).toHaveBeenCalledTimes(1);
    const batchArg = (checkpointModule.saveBatch as MockedFn<typeof checkpointModule.saveBatch>).mock
      .calls[0]![0] as EmailMetadata[];
    expect(batchArg).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: dry-run mode
// ---------------------------------------------------------------------------

describe("pull() — dry-run mode", () => {
  it("fetches only the first page in dry-run mode", async () => {
    const client = createMockClient([
      {
        messages: [
          { id: "msg-1", threadId: "t-1" },
          { id: "msg-2", threadId: "t-2" },
        ],
        nextPageToken: "token-page-2",
        resultSizeEstimate: 671000,
      },
      {
        messages: [{ id: "msg-3", threadId: "t-3" }],
        nextPageToken: undefined,
      },
    ]);

    const result = await pull({ client, dataDir: DATA_DIR, dryRun: true });

    expect(result.ok).toBe(true);
    // Only one listMessages call in dry-run
    expect(client.listMessages).toHaveBeenCalledTimes(1);
  });

  it("does not save any data in dry-run mode", async () => {
    const client = createMockClient([
      {
        messages: [{ id: "msg-1", threadId: "t-1" }],
        nextPageToken: "more",
        resultSizeEstimate: 5000,
      },
    ]);

    await pull({ client, dataDir: DATA_DIR, dryRun: true });

    expect(checkpointModule.saveBatch).not.toHaveBeenCalled();
    expect(checkpointModule.saveCheckpoint).not.toHaveBeenCalled();
  });

  it("returns resultSizeEstimate in dry-run result", async () => {
    const client = createMockClient([
      {
        messages: [{ id: "msg-1", threadId: "t-1" }],
        nextPageToken: undefined,
        resultSizeEstimate: 671234,
      },
    ]);

    const result = await pull({ client, dataDir: DATA_DIR, dryRun: true });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");
    expect(result.value.resultSizeEstimate).toBe(671234);
  });

  it("fetches a fresh Gmail estimate even when a completed checkpoint exists", async () => {
    // Set up a completed checkpoint — without the fix, dryRun would return
    // stale checkpoint counts instead of hitting Gmail.
    const completedCheckpoint = makeCheckpoint({
      status: "complete",
      messagesFetched: 999,
      batchesSaved: 10,
    });

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: completedCheckpoint,
    });

    const client = createMockClient([
      {
        messages: [{ id: "msg-1", threadId: "t-1" }],
        nextPageToken: undefined,
        resultSizeEstimate: 12345,
      },
    ]);

    const result = await pull({ client, dataDir: DATA_DIR, dryRun: true });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");
    // Should return Gmail's fresh estimate, not the stale checkpoint count.
    expect(result.value.resultSizeEstimate).toBe(12345);
    // listMessages must have been called (dry-run hit Gmail).
    expect(client.listMessages).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: saveCheckpoint failure is fatal during mid-pull flush
// ---------------------------------------------------------------------------

describe("pull() — saveCheckpoint failure handling", () => {
  it("returns ok: false and stops pulling when saveCheckpoint fails mid-pull", async () => {
    // BATCH_SIZE is mocked to 3. Provide enough messages to trigger a batch
    // flush, then make saveCheckpoint fail on that flush.
    const client = createMockClient([
      {
        messages: [
          { id: "msg-1", threadId: "t-1" },
          { id: "msg-2", threadId: "t-2" },
          { id: "msg-3", threadId: "t-3" },
        ],
        nextPageToken: "next-page",
      },
      {
        messages: [{ id: "msg-4", threadId: "t-4" }],
        nextPageToken: undefined,
      },
    ]);

    (checkpointModule.saveCheckpoint as MockedFn<typeof checkpointModule.saveCheckpoint>).mockResolvedValue({
      ok: false,
      error: "Disk full",
    });

    const result = await pull({ client, dataDir: DATA_DIR });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected result.ok to be false");
    expect(result.error).toContain("saveCheckpoint failed");

    // Pull must have stopped — should NOT have requested the second page.
    expect(client.listMessages).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: progress callback
// ---------------------------------------------------------------------------

describe("pull() — onProgress callback", () => {
  it("fires onProgress with { fetched, total, batchesSaved } after each batch", async () => {
    const progressEvents: Array<{ fetched: number; total: number; batchesSaved: number }> = [];

    // 6 messages, 2 pages, BATCH_SIZE=3 → 2 batches → 2 progress events
    const client = createMockClient([
      {
        messages: [
          { id: "msg-1", threadId: "t-1" },
          { id: "msg-2", threadId: "t-2" },
          { id: "msg-3", threadId: "t-3" },
        ],
        nextPageToken: "next",
      },
      {
        messages: [
          { id: "msg-4", threadId: "t-4" },
          { id: "msg-5", threadId: "t-5" },
          { id: "msg-6", threadId: "t-6" },
        ],
        nextPageToken: undefined,
      },
    ]);

    await pull({
      client,
      dataDir: DATA_DIR,
      onProgress: (progress) => {
        progressEvents.push({ ...progress });
      },
    });

    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    // Every progress event should have numeric values
    for (const event of progressEvents) {
      expect(typeof event.fetched).toBe("number");
      expect(typeof event.total).toBe("number");
      expect(typeof event.batchesSaved).toBe("number");
    }
    // Final progress should reflect all messages fetched
    const last = progressEvents[progressEvents.length - 1]!;
    expect(last.fetched).toBe(6);
    expect(last.batchesSaved).toBe(2);
  });

  it("does not throw when no onProgress callback is provided", async () => {
    const client = createMockClient([
      {
        messages: [{ id: "msg-1", threadId: "t-1" }],
        nextPageToken: undefined,
      },
    ]);

    const result = await pull({ client, dataDir: DATA_DIR });
    expect(result.ok).toBe(true);
  });
});
