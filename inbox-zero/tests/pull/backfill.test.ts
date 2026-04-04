/**
 * backfill.test.ts
 *
 * Tests for the backfill engine. Mocks checkpoint-manager, message-parser,
 * and filesystem operations to isolate backfill logic.
 *
 * Follows the same mocking patterns as metadata-puller.test.ts.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { gmail_v1 } from "googleapis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GmailClient, Result as GmailResult } from "../../src/auth/gmail-client.js";
import type { Checkpoint, CheckpointError } from "../../src/schemas/checkpoint.js";
import type { EmailMetadata } from "../../src/schemas/email-metadata.js";

// ---------------------------------------------------------------------------
// Module mocks (hoisted before imports)
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

import { backfill, extractMessageIds, fingerprintTargetIds } from "../../src/pull/backfill.js";
// Import mocked modules after vi.mock declarations
import * as checkpointModule from "../../src/pull/checkpoint-manager.js";
import * as parserModule from "../../src/pull/message-parser.js";

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

/** Creates a complete checkpoint for test use. */
function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    status: "complete",
    query: "in:anywhere -in:spam -in:trash -in:drafts -in:sent",
    pageToken: null,
    messagesFetched: 100,
    batchesSaved: 5,
    lastSavedAt: new Date("2026-03-17T00:00:00.000Z"),
    errors: [],
    ...overrides,
  };
}

/** Creates a mock GmailClient for backfill tests. */
function createMockClient(
  opts: { getMessageResult?: (id: string) => GmailResult<gmail_v1.Schema$Message> } = {},
): GmailClient {
  const getMessage = vi.fn().mockImplementation(async (id: string): Promise<GmailResult<gmail_v1.Schema$Message>> => {
    if (opts.getMessageResult) return opts.getMessageResult(id);
    return { ok: true, value: makeRawMessage(id) };
  });

  return {
    listMessages: vi.fn(),
    getMessage,
    getProfile: vi.fn(),
    batchModifyMessages: vi.fn(),
    listLabels: vi.fn(),
    listFilters: vi.fn(),
    createLabel: vi.fn(),
    createFilter: vi.fn(),
  } as GmailClient;
}

/** Creates a message-level checkpoint error with structured messageId. */
function makeMessageError(messageId: string, msg?: string): CheckpointError {
  return {
    timestamp: new Date("2026-03-17T00:00:00.000Z"),
    message: msg ?? `Message ${messageId}: fetch failed`,
    pageToken: null,
    messageId,
    kind: "message" as const,
  };
}

/** Creates a legacy-format message error (no messageId field). */
function makeLegacyMessageError(messageId: string, detail?: string): CheckpointError {
  return {
    timestamp: new Date("2026-03-17T00:00:00.000Z"),
    message: `Message ${messageId}: ${detail ?? "fetch failed"}`,
    pageToken: null,
  };
}

/** Creates a system error (no messageId, no Message prefix). */
function makeSystemError(msg: string): CheckpointError {
  return {
    timestamp: new Date("2026-03-17T00:00:00.000Z"),
    message: msg,
    pageToken: null,
  };
}

// ---------------------------------------------------------------------------
// Temp directory management for real FS tests
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backfill-test-"));

  // Default: loadCheckpoint returns a complete checkpoint with no errors
  (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
    ok: true,
    value: makeCheckpoint(),
  });

  // Default: saveCheckpoint succeeds
  (checkpointModule.saveCheckpoint as MockedFn<typeof checkpointModule.saveCheckpoint>).mockResolvedValue({
    ok: true,
    value: undefined,
  });

  // Default: parseGmailMessage converts raw message to EmailMetadata
  (parserModule.parseGmailMessage as MockedFn<typeof parserModule.parseGmailMessage>).mockImplementation(
    (raw: gmail_v1.Schema$Message) => {
      if (!raw.id) return { ok: false, error: "Missing id" };
      return { ok: true, value: makeEmailMetadata(raw.id) };
    },
  );
});

afterEach(async () => {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Tests: extractMessageIds()
// ---------------------------------------------------------------------------

describe("extractMessageIds()", () => {
  it("extracts IDs from structured messageId field", () => {
    const errors: CheckpointError[] = [makeMessageError("abc123"), makeMessageError("def456")];

    const ids = extractMessageIds(errors);

    expect(ids).toEqual(["abc123", "def456"]);
  });

  it("falls back to Message <id>: format for legacy errors", () => {
    const errors: CheckpointError[] = [makeLegacyMessageError("msg-aaa"), makeLegacyMessageError("msg-bbb")];

    const ids = extractMessageIds(errors);

    expect(ids).toEqual(["msg-aaa", "msg-bbb"]);
  });

  it("deduplicates repeated IDs", () => {
    const errors: CheckpointError[] = [
      makeMessageError("same-id"),
      makeLegacyMessageError("same-id"),
      makeMessageError("same-id"),
    ];

    const ids = extractMessageIds(errors);

    expect(ids).toEqual(["same-id"]);
  });

  it("returns empty for empty input", () => {
    const ids = extractMessageIds([]);

    expect(ids).toEqual([]);
  });

  it("ignores system errors without messageId or matching pattern", () => {
    const errors: CheckpointError[] = [
      makeSystemError("listMessages failed: network timeout"),
      makeSystemError("saveBatch failed: disk full"),
    ];

    const ids = extractMessageIds(errors);

    expect(ids).toEqual([]);
  });

  it("handles mixed structured + legacy errors", () => {
    const errors: CheckpointError[] = [
      makeMessageError("id-structured"),
      makeLegacyMessageError("id-legacy"),
      makeSystemError("system error"),
      makeMessageError("id-another"),
    ];

    const ids = extractMessageIds(errors);

    expect(ids).toEqual(["id-another", "id-legacy", "id-structured"]);
  });
});

// ---------------------------------------------------------------------------
// Tests: fingerprintTargetIds()
// ---------------------------------------------------------------------------

describe("fingerprintTargetIds()", () => {
  it("returns consistent hash for same IDs regardless of input order", () => {
    const hash1 = fingerprintTargetIds(["c", "a", "b"]);
    const hash2 = fingerprintTargetIds(["a", "b", "c"]);
    const hash3 = fingerprintTargetIds(["b", "c", "a"]);

    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });

  it("returns different hash for different ID sets", () => {
    const hash1 = fingerprintTargetIds(["a", "b"]);
    const hash2 = fingerprintTargetIds(["a", "c"]);

    expect(hash1).not.toBe(hash2);
  });

  it("returns deterministic hash for empty array", () => {
    const hash1 = fingerprintTargetIds([]);
    const hash2 = fingerprintTargetIds([]);

    expect(hash1).toBe(hash2);
    // SHA-256 of empty string is a known value
    expect(hash1).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// Tests: backfill() guards
// ---------------------------------------------------------------------------

describe("backfill() — guards", () => {
  it("refuses when checkpoint status is in_progress", async () => {
    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ status: "in_progress" }),
    });

    const client = createMockClient();
    const result = await backfill({ client, dataDir: tmpDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toContain("in_progress");
  });

  it("refuses when checkpoint status is failed", async () => {
    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ status: "failed" }),
    });

    const client = createMockClient();
    const result = await backfill({ client, dataDir: tmpDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toContain("failed");
  });

  it("returns early with zero counts when no message-level errors exist", async () => {
    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({
        errors: [makeSystemError("listMessages failed: timeout")],
      }),
    });

    const client = createMockClient();
    const result = await backfill({ client, dataDir: tmpDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected success");
    expect(result.value.totalIds).toBe(0);
    expect(result.value.recovered).toBe(0);
    expect(result.value.stillFailing).toBe(0);
    // getMessage should not have been called
    expect(client.getMessage).not.toHaveBeenCalled();
  });

  it("returns error when loadCheckpoint fails", async () => {
    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: false,
      error: "Checkpoint file corrupted",
    });

    const client = createMockClient();
    const result = await backfill({ client, dataDir: tmpDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toContain("Checkpoint file corrupted");
  });
});

// ---------------------------------------------------------------------------
// Tests: backfill() fetch phase
// ---------------------------------------------------------------------------

describe("backfill() — fetch phase", () => {
  it("fetches each remaining ID via getMessage with correct params", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1"), makeMessageError("id-2"), makeMessageError("id-3")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    const client = createMockClient();
    await backfill({ client, dataDir: tmpDir });

    expect(client.getMessage).toHaveBeenCalledTimes(3);
    expect(client.getMessage).toHaveBeenCalledWith("id-1", "metadata", ["From", "To", "Cc", "Subject"]);
    expect(client.getMessage).toHaveBeenCalledWith("id-2", "metadata", ["From", "To", "Cc", "Subject"]);
    expect(client.getMessage).toHaveBeenCalledWith("id-3", "metadata", ["From", "To", "Cc", "Subject"]);
  });

  it("parses with parseGmailMessage", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    const client = createMockClient();
    await backfill({ client, dataDir: tmpDir });

    expect(parserModule.parseGmailMessage).toHaveBeenCalledTimes(1);
    expect(parserModule.parseGmailMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "id-1" }));
  });

  it("continues when getMessage fails for some IDs", async () => {
    const errors: CheckpointError[] = [
      makeMessageError("id-ok"),
      makeMessageError("id-fail"),
      makeMessageError("id-ok2"),
    ];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    const client = createMockClient({
      getMessageResult: (id: string) => {
        if (id === "id-fail") {
          return { ok: false, error: "Not found" };
        }
        return { ok: true, value: makeRawMessage(id) };
      },
    });

    const result = await backfill({ client, dataDir: tmpDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected success");
    expect(result.value.recovered).toBe(2);
    expect(result.value.stillFailing).toBe(1);
    expect(client.getMessage).toHaveBeenCalledTimes(3);
  });

  it("continues when parseGmailMessage fails for some IDs", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-ok"), makeMessageError("id-parse-fail")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    (parserModule.parseGmailMessage as MockedFn<typeof parserModule.parseGmailMessage>).mockImplementation(
      (raw: gmail_v1.Schema$Message) => {
        if (raw.id === "id-parse-fail") {
          return { ok: false, error: "Missing From header" };
        }
        if (!raw.id) return { ok: false, error: "Missing id" };
        return { ok: true, value: makeEmailMetadata(raw.id) };
      },
    );

    const client = createMockClient();
    const result = await backfill({ client, dataDir: tmpDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected success");
    expect(result.value.recovered).toBe(1);
    expect(result.value.stillFailing).toBe(1);
  });

  it("skips already-recovered IDs on resume", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1"), makeMessageError("id-2"), makeMessageError("id-3")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    // Pre-stage some recoveries in a run directory
    const fingerprint = fingerprintTargetIds(["id-1", "id-2", "id-3"]);
    const runId = "test-resume-run";
    const runDir = path.join(tmpDir, "backfills", runId);
    await fs.mkdir(runDir, { recursive: true });

    // Write backfill checkpoint so it gets found
    const backfillCp = {
      runId,
      status: "fetching",
      sourceCheckpointLastSavedAt: new Date().toISOString(),
      sourceErrorFingerprint: fingerprint,
      targetIds: ["id-1", "id-2", "id-3"],
      recoveredCount: 1,
      residualErrors: [],
      shardsWritten: 0,
      lastSavedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(runDir, "backfill-checkpoint.json"), JSON.stringify(backfillCp));

    // Pre-write id-1 as already recovered
    const existingRecovery = makeEmailMetadata("id-1");
    await fs.writeFile(path.join(runDir, "recovered.jsonl"), `${JSON.stringify(existingRecovery)}\n`);

    const client = createMockClient();
    await backfill({ client, dataDir: tmpDir });

    // Should only fetch id-2 and id-3, not id-1
    expect(client.getMessage).toHaveBeenCalledTimes(2);
    const calledIds = (client.getMessage as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) => call[0]);
    expect(calledIds).toContain("id-2");
    expect(calledIds).toContain("id-3");
    expect(calledIds).not.toContain("id-1");
  });

  it("writes successes to recovered.jsonl with valid JSONL lines", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-r1"), makeMessageError("id-r2"), makeMessageError("id-r3")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    const client = createMockClient();
    const result = await backfill({ client, dataDir: tmpDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected success");

    // Read recovered.jsonl from the run directory
    const runDir = path.join(tmpDir, "backfills", result.value.runId);
    const raw = await fs.readFile(path.join(runDir, "recovered.jsonl"), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    expect(lines).toHaveLength(3);

    // Each line should be valid JSON with a matching messageId
    const recoveredIds = lines.map((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return parsed["messageId"];
    });

    expect(recoveredIds).toContain("id-r1");
    expect(recoveredIds).toContain("id-r2");
    expect(recoveredIds).toContain("id-r3");
  });
});

// ---------------------------------------------------------------------------
// Tests: backfill() promote phase
// ---------------------------------------------------------------------------

describe("backfill() — promote phase", () => {
  it("writes run-scoped batch shard files", async () => {
    // BATCH_SIZE is mocked to 3; provide 4 errors to get 2 shard files
    const errors: CheckpointError[] = [
      makeMessageError("id-1"),
      makeMessageError("id-2"),
      makeMessageError("id-3"),
      makeMessageError("id-4"),
    ];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    const client = createMockClient();
    const result = await backfill({ client, dataDir: tmpDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected success");
    expect(result.value.shardsWritten).toBe(2);

    // Verify shard files exist
    const runDir = path.join(tmpDir, "backfills", result.value.runId);
    const shard1 = await fs.readFile(path.join(runDir, "batch-00001.json"), "utf-8");
    const shard2 = await fs.readFile(path.join(runDir, "batch-00002.json"), "utf-8");

    const parsed1 = JSON.parse(shard1) as unknown[];
    const parsed2 = JSON.parse(shard2) as unknown[];
    expect(parsed1).toHaveLength(3);
    expect(parsed2).toHaveLength(1);
  });

  it("writes report.json", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1"), makeMessageError("id-2")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    const client = createMockClient();
    const result = await backfill({ client, dataDir: tmpDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected success");

    const reportRaw = await fs.readFile(result.value.reportPath, "utf-8");
    const report = JSON.parse(reportRaw) as Record<string, unknown>;
    expect(report["runId"]).toBe(result.value.runId);
    expect(report["totalIds"]).toBe(2);
    expect(report["recovered"]).toBe(2);
    expect(report["stillFailing"]).toBe(0);
  });

  it("marks backfill checkpoint as complete", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    const client = createMockClient();
    const result = await backfill({ client, dataDir: tmpDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected success");

    const cpPath = path.join(tmpDir, "backfills", result.value.runId, "backfill-checkpoint.json");
    const cpRaw = await fs.readFile(cpPath, "utf-8");
    const cp = JSON.parse(cpRaw) as Record<string, unknown>;
    expect(cp["status"]).toBe("complete");
  });

  it("dedupes staged recoveries by messageId", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1"), makeMessageError("id-2")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    // Pre-create a run directory with duplicate entries in recovered.jsonl
    const fingerprint = fingerprintTargetIds(["id-1", "id-2"]);
    const runId = "test-dedup-run";
    const runDir = path.join(tmpDir, "backfills", runId);
    await fs.mkdir(runDir, { recursive: true });

    const backfillCp = {
      runId,
      status: "fetching",
      sourceCheckpointLastSavedAt: new Date().toISOString(),
      sourceErrorFingerprint: fingerprint,
      targetIds: ["id-1", "id-2"],
      recoveredCount: 2,
      residualErrors: [],
      shardsWritten: 0,
      lastSavedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(runDir, "backfill-checkpoint.json"), JSON.stringify(backfillCp));

    // Write duplicate entries — id-1 appears twice with different subjects
    const entry1a = { ...makeEmailMetadata("id-1"), subject: "Old subject" };
    const entry1b = { ...makeEmailMetadata("id-1"), subject: "New subject" };
    const entry2 = makeEmailMetadata("id-2");

    await fs.writeFile(
      path.join(runDir, "recovered.jsonl"),
      `${[JSON.stringify(entry1a), JSON.stringify(entry2), JSON.stringify(entry1b)].join("\n")}\n`,
    );

    const client = createMockClient();
    const result = await backfill({ client, dataDir: tmpDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected success");
    // Should have exactly 2 recovered (not 3 from the raw lines)
    expect(result.value.recovered).toBe(2);
    // No getMessage calls needed — all were already staged
    expect(client.getMessage).not.toHaveBeenCalled();
  });

  it("produces identical shard files on repeated promote (idempotent)", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1"), makeMessageError("id-2")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    const client = createMockClient();

    // First backfill run
    const result1 = await backfill({ client, dataDir: tmpDir });
    expect(result1.ok).toBe(true);
    if (!result1.ok) throw new Error("Expected success");

    const runDir = path.join(tmpDir, "backfills", result1.value.runId);
    const shard1Before = await fs.readFile(path.join(runDir, "batch-00001.json"), "utf-8");

    // Reset the backfill checkpoint to "fetching" so a second run re-promotes
    // (all recoveries are already in recovered.jsonl)
    const backfillCpPath = path.join(runDir, "backfill-checkpoint.json");
    const cpRaw = await fs.readFile(backfillCpPath, "utf-8");
    const cp = JSON.parse(cpRaw) as Record<string, unknown>;
    cp["status"] = "fetching";
    cp["shardsWritten"] = 0;
    await fs.writeFile(backfillCpPath, JSON.stringify(cp), "utf-8");

    // Re-run backfill — it should detect existing recoveries and re-promote
    vi.clearAllMocks();
    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });
    (checkpointModule.saveCheckpoint as MockedFn<typeof checkpointModule.saveCheckpoint>).mockResolvedValue({
      ok: true,
      value: undefined,
    });
    (parserModule.parseGmailMessage as MockedFn<typeof parserModule.parseGmailMessage>).mockImplementation(
      (raw: gmail_v1.Schema$Message) => {
        if (!raw.id) return { ok: false, error: "Missing id" };
        return { ok: true, value: makeEmailMetadata(raw.id) };
      },
    );

    const result2 = await backfill({ client, dataDir: tmpDir });
    expect(result2.ok).toBe(true);
    if (!result2.ok) throw new Error("Expected success");

    const shard1After = await fs.readFile(path.join(runDir, "batch-00001.json"), "utf-8");

    // Shard content should be identical
    expect(JSON.parse(shard1After)).toEqual(JSON.parse(shard1Before));
  });
});

// ---------------------------------------------------------------------------
// Tests: backfill() main checkpoint rewrite
// ---------------------------------------------------------------------------

describe("backfill() — main checkpoint rewrite", () => {
  it("removes recovered message-level errors from checkpoint", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1"), makeMessageError("id-2")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    const client = createMockClient();
    await backfill({ client, dataDir: tmpDir });

    const saveCheckpointCalls = (checkpointModule.saveCheckpoint as MockedFn<typeof checkpointModule.saveCheckpoint>)
      .mock.calls;
    expect(saveCheckpointCalls.length).toBeGreaterThanOrEqual(1);
    const lastCall = saveCheckpointCalls[saveCheckpointCalls.length - 1]!;
    const savedCheckpoint = lastCall[0] as Checkpoint;
    // Both errors should have been removed (recovered)
    expect(savedCheckpoint.errors).toHaveLength(0);
  });

  it("keeps residual message-level errors", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-ok"), makeMessageError("id-fail")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    // id-fail stays broken
    const client = createMockClient({
      getMessageResult: (id: string) => {
        if (id === "id-fail") {
          return { ok: false, error: "Permanently deleted" };
        }
        return { ok: true, value: makeRawMessage(id) };
      },
    });

    const result = await backfill({ client, dataDir: tmpDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected success");

    const saveCheckpointCalls = (checkpointModule.saveCheckpoint as MockedFn<typeof checkpointModule.saveCheckpoint>)
      .mock.calls;
    const lastCall = saveCheckpointCalls[saveCheckpointCalls.length - 1]!;
    const savedCheckpoint = lastCall[0] as Checkpoint;

    // id-ok was recovered and removed; id-fail remains
    const remainingMessages = savedCheckpoint.errors.map((e) => e.message);
    const hasIdFail = remainingMessages.some((m) => m.includes("id-fail"));
    expect(hasIdFail).toBe(true);
    const hasIdOk = remainingMessages.some((m) => m.includes("id-ok"));
    expect(hasIdOk).toBe(false);
  });

  it("preserves system errors untouched", async () => {
    const sysError = makeSystemError("listMessages failed: network timeout");
    const errors: CheckpointError[] = [makeMessageError("id-1"), sysError];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    const client = createMockClient();
    await backfill({ client, dataDir: tmpDir });

    const saveCheckpointCalls = (checkpointModule.saveCheckpoint as MockedFn<typeof checkpointModule.saveCheckpoint>)
      .mock.calls;
    const lastCall = saveCheckpointCalls[saveCheckpointCalls.length - 1]!;
    const savedCheckpoint = lastCall[0] as Checkpoint;

    // System error preserved, message error removed
    expect(savedCheckpoint.errors).toHaveLength(1);
    expect(savedCheckpoint.errors[0]!.message).toBe("listMessages failed: network timeout");
  });

  it("increments messagesFetched by recovered count", async () => {
    const initialFetched = 100;
    const errors: CheckpointError[] = [makeMessageError("id-1"), makeMessageError("id-2"), makeMessageError("id-3")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ messagesFetched: initialFetched, errors }),
    });

    const client = createMockClient();
    await backfill({ client, dataDir: tmpDir });

    const saveCheckpointCalls = (checkpointModule.saveCheckpoint as MockedFn<typeof checkpointModule.saveCheckpoint>)
      .mock.calls;
    const lastCall = saveCheckpointCalls[saveCheckpointCalls.length - 1]!;
    const savedCheckpoint = lastCall[0] as Checkpoint;

    expect(savedCheckpoint.messagesFetched).toBe(initialFetched + 3);
  });

  it("does not increment batchesSaved on the main checkpoint", async () => {
    const initialBatchesSaved = 5;
    const errors: CheckpointError[] = [makeMessageError("id-1"), makeMessageError("id-2")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ batchesSaved: initialBatchesSaved, errors }),
    });

    const client = createMockClient();
    await backfill({ client, dataDir: tmpDir });

    const saveCheckpointCalls = (checkpointModule.saveCheckpoint as MockedFn<typeof checkpointModule.saveCheckpoint>)
      .mock.calls;
    const lastCall = saveCheckpointCalls[saveCheckpointCalls.length - 1]!;
    const savedCheckpoint = lastCall[0] as Checkpoint;

    // Backfill writes run-scoped shards, NOT main batch files.
    // batchesSaved on the main checkpoint must remain unchanged.
    expect(savedCheckpoint.batchesSaved).toBe(initialBatchesSaved);
  });

  it("resumes the same run after checkpoint rewrite failure instead of creating a duplicate run", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    const saveCheckpointMock = checkpointModule.saveCheckpoint as MockedFn<typeof checkpointModule.saveCheckpoint>;
    saveCheckpointMock.mockResolvedValueOnce({ ok: false, error: "Disk full" });

    const client = createMockClient();

    const first = await backfill({ client, dataDir: tmpDir });
    expect(first.ok).toBe(false);

    const runsAfterFirst = await fs.readdir(path.join(tmpDir, "backfills"));
    expect(runsAfterFirst).toHaveLength(1);
    const runId = runsAfterFirst[0]!;
    const runDir = path.join(tmpDir, "backfills", runId);

    const firstCp = JSON.parse(await fs.readFile(path.join(runDir, "backfill-checkpoint.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(firstCp["status"]).toBe("promoting");

    saveCheckpointMock.mockResolvedValue({ ok: true, value: undefined });

    const second = await backfill({ client, dataDir: tmpDir });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("Expected success");

    expect(second.value.runId).toBe(runId);
    expect(client.getMessage).toHaveBeenCalledTimes(1);

    const runsAfterSecond = await fs.readdir(path.join(tmpDir, "backfills"));
    expect(runsAfterSecond).toEqual([runId]);

    const finalCp = JSON.parse(await fs.readFile(path.join(runDir, "backfill-checkpoint.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(finalCp["status"]).toBe("complete");
  });

  it("finalises a promoting run when the main checkpoint is already clean", async () => {
    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors: [] }),
    });

    const runId = "promoting-run";
    const runDir = path.join(tmpDir, "backfills", runId);
    await fs.mkdir(runDir, { recursive: true });

    await fs.writeFile(
      path.join(runDir, "backfill-checkpoint.json"),
      JSON.stringify(
        {
          runId,
          status: "promoting",
          sourceCheckpointLastSavedAt: new Date("2026-03-17T00:00:00.000Z").toISOString(),
          sourceErrorFingerprint: fingerprintTargetIds(["id-1"]),
          targetIds: ["id-1"],
          recoveredCount: 1,
          residualErrors: [],
          shardsWritten: 1,
          lastSavedAt: new Date("2026-03-17T00:10:00.000Z").toISOString(),
        },
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(path.join(runDir, "recovered.jsonl"), `${JSON.stringify(makeEmailMetadata("id-1"))}\n`, "utf-8");
    await fs.writeFile(
      path.join(runDir, "batch-00001.json"),
      JSON.stringify([makeEmailMetadata("id-1")], null, 2),
      "utf-8",
    );

    const client = createMockClient();
    const result = await backfill({ client, dataDir: tmpDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected success");

    expect(result.value.runId).toBe(runId);
    expect(result.value.recovered).toBe(1);
    expect(result.value.stillFailing).toBe(0);
    expect(client.getMessage).not.toHaveBeenCalled();
    expect(checkpointModule.saveCheckpoint).not.toHaveBeenCalled();

    const finalCp = JSON.parse(await fs.readFile(path.join(runDir, "backfill-checkpoint.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(finalCp["status"]).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
// Tests: backfill() — drift detection
// ---------------------------------------------------------------------------

describe("backfill() — drift detection", () => {
  it("refuses resume when fingerprint differs", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1"), makeMessageError("id-2")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    // Pre-create a run directory with a DIFFERENT fingerprint
    const wrongFingerprint = fingerprintTargetIds(["id-X", "id-Y"]);
    const runId = "stale-run";
    const runDir = path.join(tmpDir, "backfills", runId);
    await fs.mkdir(runDir, { recursive: true });

    const backfillCp = {
      runId,
      status: "fetching",
      sourceCheckpointLastSavedAt: new Date().toISOString(),
      sourceErrorFingerprint: wrongFingerprint,
      targetIds: ["id-X", "id-Y"],
      recoveredCount: 0,
      residualErrors: [],
      shardsWritten: 0,
      lastSavedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(runDir, "backfill-checkpoint.json"), JSON.stringify(backfillCp));

    const client = createMockClient();
    const result = await backfill({ client, dataDir: tmpDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toContain("fingerprint");
  });

  it("allows --restart on changed fingerprint and creates a new run", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1"), makeMessageError("id-2")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    // Pre-create a run directory with a DIFFERENT fingerprint
    const wrongFingerprint = fingerprintTargetIds(["id-X", "id-Y"]);
    const staleRunId = "stale-run";
    const staleRunDir = path.join(tmpDir, "backfills", staleRunId);
    await fs.mkdir(staleRunDir, { recursive: true });

    const staleCp = {
      runId: staleRunId,
      status: "fetching",
      sourceCheckpointLastSavedAt: new Date().toISOString(),
      sourceErrorFingerprint: wrongFingerprint,
      targetIds: ["id-X", "id-Y"],
      recoveredCount: 0,
      residualErrors: [],
      shardsWritten: 0,
      lastSavedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(staleRunDir, "backfill-checkpoint.json"), JSON.stringify(staleCp));

    const client = createMockClient();
    const result = await backfill({ client, dataDir: tmpDir, restart: true });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected success");
    // A new run should have been created (different runId)
    expect(result.value.runId).not.toBe(staleRunId);
    expect(result.value.recovered).toBe(2);

    // The old run should be marked as failed
    const oldCpRaw = await fs.readFile(path.join(staleRunDir, "backfill-checkpoint.json"), "utf-8");
    const oldCp = JSON.parse(oldCpRaw) as Record<string, unknown>;
    expect(oldCp["status"]).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Tests: resumed residual cleanup
// ---------------------------------------------------------------------------

describe("backfill() — resumed residual cleanup", () => {
  it("clears stale residual errors when a previously failing message recovers", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    const runId = "resume-run";
    const runDir = path.join(tmpDir, "backfills", runId);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, "backfill-checkpoint.json"),
      JSON.stringify(
        {
          runId,
          status: "fetching",
          sourceCheckpointLastSavedAt: new Date("2026-03-17T00:00:00.000Z").toISOString(),
          sourceErrorFingerprint: fingerprintTargetIds(["id-1"]),
          targetIds: ["id-1"],
          recoveredCount: 0,
          residualErrors: [
            {
              messageId: "id-1",
              error: "Temporary 500",
              timestamp: new Date("2026-03-17T00:10:00.000Z").toISOString(),
            },
          ],
          shardsWritten: 0,
          lastSavedAt: new Date("2026-03-17T00:10:00.000Z").toISOString(),
        },
        null,
        2,
      ),
      "utf-8",
    );

    const client = createMockClient();
    const result = await backfill({ client, dataDir: tmpDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected success");

    expect(result.value.runId).toBe(runId);
    expect(result.value.recovered).toBe(1);
    expect(result.value.stillFailing).toBe(0);
    expect(result.value.residualErrors).toEqual([]);

    const report = JSON.parse(await fs.readFile(path.join(runDir, "report.json"), "utf-8")) as Record<string, unknown>;
    expect(report["stillFailing"]).toBe(0);
    expect(report["residualErrors"]).toEqual([]);

    const finalCp = JSON.parse(await fs.readFile(path.join(runDir, "backfill-checkpoint.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(finalCp["residualErrors"]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: error handling
// ---------------------------------------------------------------------------

describe("backfill() — error handling", () => {
  it("captures thrown getMessage errors as residual failures", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    const client = createMockClient({
      getMessageResult: () => {
        throw new Error("socket hang up");
      },
    });

    const result = await backfill({ client, dataDir: tmpDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected success");

    expect(result.value.recovered).toBe(0);
    expect(result.value.stillFailing).toBe(1);
    expect(result.value.residualErrors).toHaveLength(1);
    expect(result.value.residualErrors[0]!.error).toContain("getMessage threw");
    expect(result.value.residualErrors[0]!.error).toContain("socket hang up");
  });

  it("captures thrown parseGmailMessage errors as residual failures", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    (parserModule.parseGmailMessage as MockedFn<typeof parserModule.parseGmailMessage>).mockImplementation(() => {
      throw new Error("parser exploded");
    });

    const client = createMockClient();
    const result = await backfill({ client, dataDir: tmpDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected success");

    expect(result.value.recovered).toBe(0);
    expect(result.value.stillFailing).toBe(1);
    expect(result.value.residualErrors).toHaveLength(1);
    expect(result.value.residualErrors[0]!.error).toContain("parseGmailMessage threw");
    expect(result.value.residualErrors[0]!.error).toContain("parser exploded");
  });

  it("treats recovered.jsonl append failures as residual message failures", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1234567890);
    const runId = Date.now().toString(36);
    const runDir = path.join(tmpDir, "backfills", runId);
    const recoveredPath = path.join(runDir, "recovered.jsonl");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(recoveredPath, "", "utf-8");
    await fs.chmod(recoveredPath, 0o444);

    try {
      const client = createMockClient();
      const result = await backfill({ client, dataDir: tmpDir });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected success");

      expect(result.value.recovered).toBe(0);
      expect(result.value.stillFailing).toBe(1);
      expect(result.value.residualErrors).toHaveLength(1);
      expect(result.value.residualErrors[0]!.error).toContain("Failed to stage recovery");
    } finally {
      await fs.chmod(recoveredPath, 0o644);
      nowSpy.mockRestore();
    }
  });

  it("swallows thrown onProgress callbacks during both fetching and promoting", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    const progressPhases: string[] = [];
    const client = createMockClient();
    const result = await backfill({
      client,
      dataDir: tmpDir,
      onProgress(progress) {
        progressPhases.push(progress.phase);
        throw new Error(`progress blew up during ${progress.phase}`);
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected success");

    expect(result.value.recovered).toBe(1);
    expect(result.value.stillFailing).toBe(0);
    expect(progressPhases).toContain("fetching");
    expect(progressPhases).toContain("promoting");
  });

  it("returns error when backfill checkpoint save fails", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    // Use a dataDir path where a file blocks directory creation.
    // Create a file at the exact path where backfills/<runId> needs to be a dir.
    const backfillsDir = path.join(tmpDir, "backfills");
    await fs.mkdir(backfillsDir, { recursive: true });
    // Place a file named as a blocker — fs.mkdir will fail with ENOTDIR or EEXIST
    // when the backfill engine tries to create a subdirectory under this file.
    const blocker = path.join(backfillsDir, "blocker-file");
    await fs.writeFile(blocker, "block");

    // Point dataDir to the file itself so mkdir(backfills/<runId>) fails
    const badDataDir = blocker;

    const client = createMockClient();
    const result = await backfill({ client, dataDir: badDataDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toBeTruthy();
  });

  it("returns error when promote shard write fails", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    const client = createMockClient();

    // Run backfill once to get a run directory with recovered.jsonl populated
    const result1 = await backfill({ client, dataDir: tmpDir });
    expect(result1.ok).toBe(true);
    if (!result1.ok) throw new Error("Expected success on first run");

    const runDir = path.join(tmpDir, "backfills", result1.value.runId);

    // Reset backfill checkpoint so it re-enters promote phase
    const backfillCpPath = path.join(runDir, "backfill-checkpoint.json");
    const cpRaw = await fs.readFile(backfillCpPath, "utf-8");
    const cp = JSON.parse(cpRaw) as Record<string, unknown>;
    cp["status"] = "fetching";
    cp["shardsWritten"] = 0;
    await fs.writeFile(backfillCpPath, JSON.stringify(cp), "utf-8");

    // Make the run directory non-writable (read + execute) so shard writes fail
    await fs.chmod(runDir, 0o555);

    vi.clearAllMocks();
    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });
    (checkpointModule.saveCheckpoint as MockedFn<typeof checkpointModule.saveCheckpoint>).mockResolvedValue({
      ok: true,
      value: undefined,
    });
    (parserModule.parseGmailMessage as MockedFn<typeof parserModule.parseGmailMessage>).mockImplementation(
      (raw: gmail_v1.Schema$Message) => {
        if (!raw.id) return { ok: false, error: "Missing id" };
        return { ok: true, value: makeEmailMetadata(raw.id) };
      },
    );

    try {
      const result2 = await backfill({ client, dataDir: tmpDir });

      expect(result2.ok).toBe(false);
      if (result2.ok) throw new Error("Expected error");
      // Error should mention batch/shard write failure
      expect(result2.error).toBeTruthy();
    } finally {
      // Restore permissions so cleanup works
      await fs.chmod(runDir, 0o755);
    }
  });

  it("returns error when main checkpoint rewrite fails", async () => {
    const errors: CheckpointError[] = [makeMessageError("id-1")];

    (checkpointModule.loadCheckpoint as MockedFn<typeof checkpointModule.loadCheckpoint>).mockResolvedValue({
      ok: true,
      value: makeCheckpoint({ errors }),
    });

    // Make saveCheckpoint fail on the main checkpoint rewrite
    (checkpointModule.saveCheckpoint as MockedFn<typeof checkpointModule.saveCheckpoint>).mockResolvedValue({
      ok: false,
      error: "Disk full",
    });

    const client = createMockClient();
    const result = await backfill({ client, dataDir: tmpDir });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toContain("rewrite main checkpoint");
  });
});
