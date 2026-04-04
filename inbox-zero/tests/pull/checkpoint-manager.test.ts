import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAllBatches, loadCheckpoint, saveBatch, saveCheckpoint } from "../../src/pull/checkpoint-manager.js";
import type { BackfillCheckpoint } from "../../src/schemas/backfill-checkpoint.js";
import type { Checkpoint } from "../../src/schemas/checkpoint.js";
import { CheckpointSchema } from "../../src/schemas/checkpoint.js";
import type { EmailMetadata } from "../../src/schemas/email-metadata.js";
import {
  financialNotificationEmail,
  newsletterEmail,
  personalEmail,
  sampleMessages,
} from "../fixtures/sample-messages.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal valid Checkpoint for testing. */
function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    status: "in_progress",
    query: "in:inbox",
    pageToken: null,
    messagesFetched: 0,
    batchesSaved: 0,
    lastSavedAt: new Date("2026-03-17T10:00:00.000Z"),
    errors: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-zero-test-"));
});

afterEach(async () => {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } finally {
    // Directory cleaned up
  }
});

// ---------------------------------------------------------------------------
// saveCheckpoint()
// ---------------------------------------------------------------------------

describe("saveCheckpoint()", () => {
  it("writes JSON to checkpoint.json with valid CheckpointSchema shape", async () => {
    const cp = makeCheckpoint({ messagesFetched: 42, batchesSaved: 1 });
    const result = await saveCheckpoint(cp, tmpDir);

    expect(result.ok).toBe(true);

    const filePath = path.join(tmpDir, "checkpoint.json");
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const validated = CheckpointSchema.parse(parsed);

    expect(validated.status).toBe("in_progress");
    expect(validated.messagesFetched).toBe(42);
    expect(validated.batchesSaved).toBe(1);
    expect(validated.query).toBe("in:inbox");
    expect(validated.lastSavedAt).toBeInstanceOf(Date);
  });

  it("overwrites an existing checkpoint file", async () => {
    const cp1 = makeCheckpoint({ messagesFetched: 10 });
    await saveCheckpoint(cp1, tmpDir);

    const cp2 = makeCheckpoint({ messagesFetched: 200, status: "complete" });
    const result = await saveCheckpoint(cp2, tmpDir);
    expect(result.ok).toBe(true);

    const filePath = path.join(tmpDir, "checkpoint.json");
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const validated = CheckpointSchema.parse(parsed);

    expect(validated.messagesFetched).toBe(200);
    expect(validated.status).toBe("complete");
  });

  it("uses atomic write (no .tmp file left on success)", async () => {
    const cp = makeCheckpoint();
    await saveCheckpoint(cp, tmpDir);

    const entries = await fs.readdir(tmpDir);
    const hasTmp = entries.some((e) => e.endsWith(".tmp"));
    expect(hasTmp).toBe(false);
  });

  it("serializes pageToken correctly when set", async () => {
    const cp = makeCheckpoint({ pageToken: "next-page-token-abc" });
    await saveCheckpoint(cp, tmpDir);

    const filePath = path.join(tmpDir, "checkpoint.json");
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const validated = CheckpointSchema.parse(parsed);

    expect(validated.pageToken).toBe("next-page-token-abc");
  });
});

// ---------------------------------------------------------------------------
// loadCheckpoint()
// ---------------------------------------------------------------------------

describe("loadCheckpoint()", () => {
  it("reads and parses an existing checkpoint, returns Result<Checkpoint>", async () => {
    const cp = makeCheckpoint({
      status: "in_progress",
      messagesFetched: 150,
      batchesSaved: 3,
      pageToken: "tok-abc",
    });
    await saveCheckpoint(cp, tmpDir);

    const result = await loadCheckpoint(tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.status).toBe("in_progress");
    expect(result.value.messagesFetched).toBe(150);
    expect(result.value.batchesSaved).toBe(3);
    expect(result.value.pageToken).toBe("tok-abc");
    expect(result.value.lastSavedAt).toBeInstanceOf(Date);
  });

  it("returns { ok: false } when no checkpoint file exists (fresh start)", async () => {
    const result = await loadCheckpoint(tmpDir);

    expect(result.ok).toBe(false);
  });

  it("returns { ok: false } with descriptive error for a corrupt checkpoint file", async () => {
    const filePath = path.join(tmpDir, "checkpoint.json");
    await fs.writeFile(filePath, "{ this is not valid json %%%", "utf-8");

    const result = await loadCheckpoint(tmpDir);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected result.ok to be false");

    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
  });

  it("returns { ok: false } for JSON that does not match CheckpointSchema", async () => {
    const filePath = path.join(tmpDir, "checkpoint.json");
    await fs.writeFile(filePath, JSON.stringify({ status: "invalid-status", query: "in:inbox" }), "utf-8");

    const result = await loadCheckpoint(tmpDir);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected result.ok to be false");

    expect(typeof result.error).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// saveBatch()
// ---------------------------------------------------------------------------

describe("saveBatch()", () => {
  it("writes a batch of EmailMetadata[] to batch-NNNNN.json", async () => {
    const cp = makeCheckpoint({ batchesSaved: 0 });
    const batch = [newsletterEmail, personalEmail];

    const result = await saveBatch(batch, cp, tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    // First batch: batchesSaved was 0 before, so file is batch-00001.json
    const batchFile = path.join(tmpDir, "batch-00001.json");
    const raw = await fs.readFile(batchFile, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    expect(Array.isArray(parsed)).toBe(true);
    const arr = parsed as unknown[];
    expect(arr).toHaveLength(2);
  });

  it("increments batchesSaved and messagesFetched in checkpoint", async () => {
    const cp = makeCheckpoint({ batchesSaved: 2, messagesFetched: 1000 });
    const batch = [newsletterEmail, personalEmail, financialNotificationEmail];

    const result = await saveBatch(batch, cp, tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value.batchesSaved).toBe(3);
    expect(result.value.messagesFetched).toBe(1003);
  });

  it("uses zero-padded filename (batch-NNNNN.json format)", async () => {
    const cp = makeCheckpoint({ batchesSaved: 0 });
    await saveBatch([newsletterEmail], cp, tmpDir);

    const entries = await fs.readdir(tmpDir);
    const batchFiles = entries.filter((e) => e.startsWith("batch-"));

    expect(batchFiles).toHaveLength(1);
    expect(batchFiles[0]).toBe("batch-00001.json");
  });

  it("writes sequential batches with correct zero-padded filenames", async () => {
    let cp = makeCheckpoint({ batchesSaved: 0, messagesFetched: 0 });

    const result1 = await saveBatch([newsletterEmail], cp, tmpDir);
    if (!result1.ok) throw new Error("saveBatch 1 failed");
    cp = result1.value;

    const result2 = await saveBatch([personalEmail], cp, tmpDir);
    if (!result2.ok) throw new Error("saveBatch 2 failed");
    cp = result2.value;

    expect(cp.batchesSaved).toBe(2);

    const entries = await fs.readdir(tmpDir);
    const batchFiles = entries.filter((e) => e.startsWith("batch-")).sort();
    expect(batchFiles).toContain("batch-00001.json");
    expect(batchFiles).toContain("batch-00002.json");
  });

  it("uses atomic write (no .tmp file left on success)", async () => {
    const cp = makeCheckpoint({ batchesSaved: 0 });
    await saveBatch([newsletterEmail], cp, tmpDir);

    const entries = await fs.readdir(tmpDir);
    const hasTmp = entries.some((e) => e.endsWith(".tmp"));
    expect(hasTmp).toBe(false);
  });

  it("persists valid EmailMetadata fields in batch file", async () => {
    const cp = makeCheckpoint({ batchesSaved: 0 });
    await saveBatch([newsletterEmail], cp, tmpDir);

    const batchFile = path.join(tmpDir, "batch-00001.json");
    const raw = await fs.readFile(batchFile, "utf-8");
    const arr = JSON.parse(raw) as unknown[];

    const first = arr[0] as Record<string, unknown>;
    expect(first["messageId"]).toBe("msg-promo-001");
    expect(first["threadId"]).toBe("thread-promo-001");
    expect((first["sender"] as Record<string, unknown>)["email"]).toBe("newsletter@morning-brew.com");
  });
});

// ---------------------------------------------------------------------------
// loadAllBatches()
// ---------------------------------------------------------------------------

describe("loadAllBatches()", () => {
  it("returns empty array when no batch files exist", async () => {
    const result = await loadAllBatches(tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value).toHaveLength(0);
  });

  it("reads all batch files and returns combined EmailMetadata[]", async () => {
    let cp = makeCheckpoint({ batchesSaved: 0, messagesFetched: 0 });

    const batch1 = [newsletterEmail, personalEmail];
    const batch2 = [financialNotificationEmail];

    const r1 = await saveBatch(batch1, cp, tmpDir);
    if (!r1.ok) throw new Error("saveBatch 1 failed");
    cp = r1.value;

    const r2 = await saveBatch(batch2, cp, tmpDir);
    if (!r2.ok) throw new Error("saveBatch 2 failed");

    const result = await loadAllBatches(tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value).toHaveLength(3);
    const ids = result.value.map((m) => m.messageId);
    expect(ids).toContain("msg-promo-001");
    expect(ids).toContain("msg-personal-002");
    expect(ids).toContain("msg-finance-003");
  });

  it("loads batches in sorted order (batch-00001 before batch-00002)", async () => {
    let cp = makeCheckpoint({ batchesSaved: 0, messagesFetched: 0 });

    // Batch 1: newsletter first
    const r1 = await saveBatch([newsletterEmail], cp, tmpDir);
    if (!r1.ok) throw new Error("saveBatch 1 failed");
    cp = r1.value;

    // Batch 2: personal second
    const r2 = await saveBatch([personalEmail], cp, tmpDir);
    if (!r2.ok) throw new Error("saveBatch 2 failed");

    const result = await loadAllBatches(tmpDir);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value[0]!.messageId).toBe("msg-promo-001");
    expect(result.value[1]!.messageId).toBe("msg-personal-002");
  });

  it("loads all sample messages across multiple batches", async () => {
    let cp = makeCheckpoint({ batchesSaved: 0, messagesFetched: 0 });

    for (const msg of sampleMessages) {
      const r = await saveBatch([msg], cp, tmpDir);
      if (!r.ok) throw new Error(`saveBatch failed for ${msg.messageId}`);
      cp = r.value;
    }

    const result = await loadAllBatches(tmpDir);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value).toHaveLength(sampleMessages.length);
  });

  it("returns { ok: false } if a batch file is corrupt", async () => {
    // Write a valid batch file
    const cp = makeCheckpoint({ batchesSaved: 0, messagesFetched: 0 });
    const r = await saveBatch([newsletterEmail], cp, tmpDir);
    if (!r.ok) throw new Error("saveBatch failed");

    // Corrupt the batch file
    const corruptFile = path.join(tmpDir, "batch-00001.json");
    await fs.writeFile(corruptFile, "not json !!!", "utf-8");

    const result = await loadAllBatches(tmpDir);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected result.ok to be false");

    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// loadAllBatches() — backfill run integration
// ---------------------------------------------------------------------------

describe("loadAllBatches() — backfill run integration", () => {
  /** Create a minimal valid BackfillCheckpoint for testing. */
  function makeBackfillCheckpoint(overrides: Partial<BackfillCheckpoint> = {}): BackfillCheckpoint {
    return {
      runId: "run-test-1",
      status: "complete",
      sourceCheckpointLastSavedAt: new Date("2026-03-17T08:00:00.000Z"),
      sourceErrorFingerprint: "abc123",
      targetIds: ["msg-001"],
      recoveredCount: 0,
      residualErrors: [],
      shardsWritten: 0,
      lastSavedAt: new Date("2026-03-17T09:00:00.000Z"),
      ...overrides,
    };
  }

  /** Create a minimal EmailMetadata for backfill tests with a unique ID. */
  function makeBackfillEmail(id: string): EmailMetadata {
    return {
      messageId: id,
      threadId: `thread-${id}`,
      sender: { email: "test@example.com", name: "Test Sender" },
      recipients: { to: ["gopal@example.com"], cc: [] },
      subject: `Backfill test email ${id}`,
      dateReceived: new Date("2023-06-15T12:00:00.000Z"),
      gmailCategory: "primary",
      labels: ["INBOX"],
      isUnread: false,
      snippet: "Backfill test snippet",
    };
  }

  /** Write a backfill run directory with checkpoint and optional batch files. */
  async function writeBackfillRun(
    dataDir: string,
    runId: string,
    checkpoint: BackfillCheckpoint,
    batches: EmailMetadata[][] = [],
  ): Promise<void> {
    const runDir = path.join(dataDir, "backfills", runId);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "backfill-checkpoint.json"), JSON.stringify(checkpoint, null, 2), "utf-8");
    for (let i = 0; i < batches.length; i++) {
      const padded = String(i + 1).padStart(5, "0");
      await fs.writeFile(path.join(runDir, `batch-${padded}.json`), JSON.stringify(batches[i], null, 2), "utf-8");
    }
  }

  it("includes batches from completed backfill runs", async () => {
    const backfillEmail = makeBackfillEmail("bf-msg-001");
    const checkpoint = makeBackfillCheckpoint({
      runId: "run-1",
      status: "complete",
      recoveredCount: 1,
      shardsWritten: 1,
    });

    await writeBackfillRun(tmpDir, "run-1", checkpoint, [[backfillEmail]]);

    const result = await loadAllBatches(tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.messageId).toBe("bf-msg-001");
  });

  it("ignores incomplete backfill runs", async () => {
    const backfillEmail = makeBackfillEmail("bf-msg-skip");
    const checkpoint = makeBackfillCheckpoint({
      runId: "run-fetching",
      status: "fetching",
      recoveredCount: 1,
      shardsWritten: 1,
    });

    await writeBackfillRun(tmpDir, "run-fetching", checkpoint, [[backfillEmail]]);

    const result = await loadAllBatches(tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value).toHaveLength(0);
  });

  it("ignores failed backfill runs", async () => {
    const backfillEmail = makeBackfillEmail("bf-msg-failed");
    const checkpoint = makeBackfillCheckpoint({
      runId: "run-failed",
      status: "failed",
      recoveredCount: 1,
      shardsWritten: 1,
    });

    await writeBackfillRun(tmpDir, "run-failed", checkpoint, [[backfillEmail]]);

    const result = await loadAllBatches(tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value).toHaveLength(0);
  });

  it("works when no backfills directory exists", async () => {
    // Write a root batch file but no backfills directory
    const cp = makeCheckpoint({ batchesSaved: 0, messagesFetched: 0 });
    const r = await saveBatch([newsletterEmail], cp, tmpDir);
    if (!r.ok) throw new Error("saveBatch failed");

    const result = await loadAllBatches(tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.messageId).toBe("msg-promo-001");
  });

  it("combines root batches and completed backfill batches", async () => {
    // Write two root batch files
    let cp = makeCheckpoint({ batchesSaved: 0, messagesFetched: 0 });
    const r1 = await saveBatch([newsletterEmail, personalEmail], cp, tmpDir);
    if (!r1.ok) throw new Error("saveBatch 1 failed");
    cp = r1.value;

    const r2 = await saveBatch([financialNotificationEmail], cp, tmpDir);
    if (!r2.ok) throw new Error("saveBatch 2 failed");

    // Write a completed backfill run with 2 emails across 2 batches
    const bf1 = makeBackfillEmail("bf-combined-001");
    const bf2 = makeBackfillEmail("bf-combined-002");
    const checkpoint = makeBackfillCheckpoint({
      runId: "run-combined",
      status: "complete",
      recoveredCount: 2,
      shardsWritten: 2,
    });

    await writeBackfillRun(tmpDir, "run-combined", checkpoint, [[bf1], [bf2]]);

    // Also write an incomplete run that should be ignored
    const bfSkipped = makeBackfillEmail("bf-skipped");
    const incompleteCheckpoint = makeBackfillCheckpoint({
      runId: "run-incomplete",
      status: "fetching",
      recoveredCount: 1,
      shardsWritten: 1,
    });

    await writeBackfillRun(tmpDir, "run-incomplete", incompleteCheckpoint, [[bfSkipped]]);

    const result = await loadAllBatches(tmpDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected result.ok to be true");

    // 3 root + 2 backfill (incomplete run excluded) = 5
    expect(result.value).toHaveLength(5);

    const ids = result.value.map((m) => m.messageId);
    // Root batches
    expect(ids).toContain("msg-promo-001");
    expect(ids).toContain("msg-personal-002");
    expect(ids).toContain("msg-finance-003");
    // Completed backfill batches
    expect(ids).toContain("bf-combined-001");
    expect(ids).toContain("bf-combined-002");
    // Incomplete run should NOT be included
    expect(ids).not.toContain("bf-skipped");
  });
});
