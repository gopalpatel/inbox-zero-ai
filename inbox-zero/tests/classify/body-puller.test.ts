/**
 * body-puller.test.ts
 *
 * Tests for the checkpointed body puller.
 */

import type { gmail_v1 } from "googleapis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GmailClient, Result as GmailResult } from "../../src/auth/gmail-client.js";

// ---------------------------------------------------------------------------
// Module mocks (hoisted)
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import * as fs from "node:fs/promises";
import { pullBodies } from "../../src/classify/body-puller.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MockedFn<T extends (...args: unknown[]) => unknown> = ReturnType<typeof vi.fn> & T;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Gmail message with a text/plain body part. */
function makeMessageWithPlainText(id: string, text: string): gmail_v1.Schema$Message {
  const encoded = Buffer.from(text).toString("base64url");
  return {
    id,
    threadId: `thread-${id}`,
    payload: {
      mimeType: "text/plain",
      body: { data: encoded, size: text.length },
    },
  };
}

/** Build a Gmail message with a multipart/alternative structure. */
function makeMultipartMessage(id: string, plainText: string, htmlText: string): gmail_v1.Schema$Message {
  return {
    id,
    threadId: `thread-${id}`,
    payload: {
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from(plainText).toString("base64url"), size: plainText.length },
        },
        {
          mimeType: "text/html",
          body: { data: Buffer.from(htmlText).toString("base64url"), size: htmlText.length },
        },
      ],
    },
  };
}

/** Build a Gmail message with only an HTML part. */
function makeHtmlOnlyMessage(id: string, html: string): gmail_v1.Schema$Message {
  const encoded = Buffer.from(html).toString("base64url");
  return {
    id,
    threadId: `thread-${id}`,
    payload: {
      mimeType: "text/html",
      body: { data: encoded, size: html.length },
    },
  };
}

/** Build a Gmail message with no body. */
function makeEmptyMessage(id: string): gmail_v1.Schema$Message {
  return {
    id,
    threadId: `thread-${id}`,
    payload: {
      mimeType: "text/plain",
      body: { size: 0 },
    },
  };
}

/** Create a mock GmailClient. */
function createMockClient(responses: Map<string, GmailResult<gmail_v1.Schema$Message>>): GmailClient {
  return {
    getMessage: vi.fn().mockImplementation(async (id: string) => {
      const response = responses.get(id);
      if (response !== undefined) return response;
      return { ok: false, error: `Message ${id} not found` };
    }),
    listMessages: vi.fn(),
    getProfile: vi.fn(),
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

const DATA_DIR = "/tmp/inbox-zero-test-bodies";

beforeEach(() => {
  vi.clearAllMocks();

  // Default: no existing checkpoint (fresh start)
  (fs.readFile as MockedFn<typeof fs.readFile>).mockRejectedValue(
    Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
  );
  (fs.writeFile as MockedFn<typeof fs.writeFile>).mockResolvedValue(undefined);
  (fs.rename as MockedFn<typeof fs.rename>).mockResolvedValue(undefined);
  (fs.mkdir as MockedFn<typeof fs.mkdir>).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests: basic fetch
// ---------------------------------------------------------------------------

describe("pullBodies() — basic fetch", () => {
  it("fetches full message content for given message IDs", async () => {
    const msgIds = ["msg-1", "msg-2", "msg-3"];
    const responses = new Map<string, GmailResult<gmail_v1.Schema$Message>>([
      ["msg-1", { ok: true, value: makeMessageWithPlainText("msg-1", "Hello from msg-1") }],
      ["msg-2", { ok: true, value: makeMessageWithPlainText("msg-2", "Hello from msg-2") }],
      ["msg-3", { ok: true, value: makeMessageWithPlainText("msg-3", "Hello from msg-3") }],
    ]);
    const client = createMockClient(responses);

    const result = await pullBodies({ client, messageIds: msgIds, dataDir: DATA_DIR });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.size).toBe(3);
    expect(result.value.get("msg-1")).toBe("Hello from msg-1");
    expect(result.value.get("msg-2")).toBe("Hello from msg-2");
    expect(result.value.get("msg-3")).toBe("Hello from msg-3");
  });

  it("calls getMessage with format 'full' for each ID", async () => {
    const responses = new Map<string, GmailResult<gmail_v1.Schema$Message>>([
      ["msg-1", { ok: true, value: makeMessageWithPlainText("msg-1", "Body text") }],
    ]);
    const client = createMockClient(responses);

    await pullBodies({ client, messageIds: ["msg-1"], dataDir: DATA_DIR });

    expect(client.getMessage).toHaveBeenCalledWith("msg-1", "full");
  });

  it("returns empty Map for empty messageIds input", async () => {
    const client = createMockClient(new Map());

    const result = await pullBodies({ client, messageIds: [], dataDir: DATA_DIR });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: MIME parsing
// ---------------------------------------------------------------------------

describe("pullBodies() — MIME parsing", () => {
  it("extracts plain text from text/plain MIME part", async () => {
    const responses = new Map<string, GmailResult<gmail_v1.Schema$Message>>([
      ["msg-1", { ok: true, value: makeMessageWithPlainText("msg-1", "Plain text body") }],
    ]);
    const client = createMockClient(responses);

    const result = await pullBodies({ client, messageIds: ["msg-1"], dataDir: DATA_DIR });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.get("msg-1")).toBe("Plain text body");
  });

  it("prefers text/plain over text/html in multipart messages", async () => {
    const responses = new Map<string, GmailResult<gmail_v1.Schema$Message>>([
      [
        "msg-1",
        {
          ok: true,
          value: makeMultipartMessage("msg-1", "Plain text version", "<p>HTML version</p>"),
        },
      ],
    ]);
    const client = createMockClient(responses);

    const result = await pullBodies({ client, messageIds: ["msg-1"], dataDir: DATA_DIR });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.get("msg-1")).toBe("Plain text version");
  });

  it("falls back to text/html with basic HTML tag stripping when no text/plain", async () => {
    const responses = new Map<string, GmailResult<gmail_v1.Schema$Message>>([
      [
        "msg-1",
        {
          ok: true,
          value: makeHtmlOnlyMessage("msg-1", "<p>Hello <b>world</b></p>"),
        },
      ],
    ]);
    const client = createMockClient(responses);

    const result = await pullBodies({ client, messageIds: ["msg-1"], dataDir: DATA_DIR });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    const body = result.value.get("msg-1");
    expect(body).toBeDefined();
    expect(body!).not.toContain("<p>");
    expect(body!).not.toContain("<b>");
    expect(body!).toContain("Hello");
    expect(body!).toContain("world");
  });

  it("returns empty string for messages with no body", async () => {
    const responses = new Map<string, GmailResult<gmail_v1.Schema$Message>>([
      ["msg-1", { ok: true, value: makeEmptyMessage("msg-1") }],
    ]);
    const client = createMockClient(responses);

    const result = await pullBodies({ client, messageIds: ["msg-1"], dataDir: DATA_DIR });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.get("msg-1")).toBe("");
  });

  it("returns empty string when getMessage fails for a message", async () => {
    const responses = new Map<string, GmailResult<gmail_v1.Schema$Message>>([
      ["msg-1", { ok: false, error: "Network error" }],
    ]);
    const client = createMockClient(responses);

    const result = await pullBodies({ client, messageIds: ["msg-1"], dataDir: DATA_DIR });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    // Failed messages map to empty string
    expect(result.value.get("msg-1")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Tests: checkpointing
// ---------------------------------------------------------------------------

describe("pullBodies() — checkpointing", () => {
  it("saves checkpoint progress after each batch", async () => {
    const msgIds = ["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"];
    const responses = new Map(
      msgIds.map((id) => [id, { ok: true, value: makeMessageWithPlainText(id, `Body of ${id}`) }] as const),
    );
    const client = createMockClient(responses);

    await pullBodies({ client, messageIds: msgIds, dataDir: DATA_DIR, batchSize: 2 });

    // writeFile called at least once for checkpointing
    expect(fs.writeFile).toHaveBeenCalled();
  });

  it("resumes from checkpoint, skipping already-fetched message IDs", async () => {
    const existingCheckpoint = JSON.stringify({
      completedIds: ["msg-1", "msg-2"],
      savedAt: new Date().toISOString(),
    });
    const existingCache = JSON.stringify({
      bodies: {
        "msg-1": "Body of msg-1",
        "msg-2": "Body of msg-2",
      },
      savedAt: new Date().toISOString(),
    });

    (fs.readFile as MockedFn<typeof fs.readFile>).mockResolvedValueOnce(existingCheckpoint as unknown as Buffer);
    (fs.readFile as MockedFn<typeof fs.readFile>).mockResolvedValueOnce(existingCache as unknown as Buffer);

    const msgIds = ["msg-1", "msg-2", "msg-3"];
    const responses = new Map<string, GmailResult<gmail_v1.Schema$Message>>([
      ["msg-3", { ok: true, value: makeMessageWithPlainText("msg-3", "Body of msg-3") }],
    ]);
    const client = createMockClient(responses);

    const result = await pullBodies({ client, messageIds: msgIds, dataDir: DATA_DIR });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    // getMessage should only be called for msg-3 (msg-1, msg-2 were checkpointed)
    expect(client.getMessage).toHaveBeenCalledTimes(1);
    expect(client.getMessage).toHaveBeenCalledWith("msg-3", "full");
    expect(result.value.get("msg-1")).toBe("Body of msg-1");
    expect(result.value.get("msg-2")).toBe("Body of msg-2");
    expect(result.value.get("msg-3")).toBe("Body of msg-3");
  });

  it("uses a separate checkpoint file path from metadata puller", async () => {
    const msgIds = ["msg-1"];
    const responses = new Map<string, GmailResult<gmail_v1.Schema$Message>>([
      ["msg-1", { ok: true, value: makeMessageWithPlainText("msg-1", "Hello") }],
    ]);
    const client = createMockClient(responses);

    await pullBodies({ client, messageIds: msgIds, dataDir: DATA_DIR });

    // readFile attempts should use body-checkpoint.json, NOT checkpoint.json
    const readFileCalls = (fs.readFile as MockedFn<typeof fs.readFile>).mock.calls;
    const filePaths = readFileCalls.map((call) => call[0] as string);
    // At least one read attempt uses body-checkpoint.json
    const usesBodyCheckpoint = filePaths.some((p) => p.includes("body-checkpoint"));
    const usesMetadataCheckpoint = filePaths.some(
      (p) => typeof p === "string" && p.includes("checkpoint.json") && !p.includes("body-checkpoint"),
    );
    expect(usesBodyCheckpoint).toBe(true);
    expect(usesMetadataCheckpoint).toBe(false);
  });

  it("returns error when cache/checkpoint persistence fails", async () => {
    const responses = new Map<string, GmailResult<gmail_v1.Schema$Message>>([
      ["msg-1", { ok: true, value: makeMessageWithPlainText("msg-1", "Hello") }],
    ]);
    const client = createMockClient(responses);

    (fs.writeFile as MockedFn<typeof fs.writeFile>).mockRejectedValueOnce(new Error("disk full"));

    const result = await pullBodies({ client, messageIds: ["msg-1"], dataDir: DATA_DIR });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toMatch(/Failed to persist body pull progress/);
    expect(result.error).toMatch(/disk full/);
  });
});

// ---------------------------------------------------------------------------
// Tests: concurrency / large inputs
// ---------------------------------------------------------------------------

describe("pullBodies() — concurrency", () => {
  it("handles 20 messages without throwing", async () => {
    const msgIds = Array.from({ length: 20 }, (_, i) => `msg-${i + 1}`);
    const responses = new Map(
      msgIds.map((id) => [id, { ok: true, value: makeMessageWithPlainText(id, `Body ${id}`) }] as const),
    );
    const client = createMockClient(responses);

    const result = await pullBodies({ client, messageIds: msgIds, dataDir: DATA_DIR });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.size).toBe(20);
  });
});
