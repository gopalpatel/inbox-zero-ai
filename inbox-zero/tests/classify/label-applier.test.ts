/**
 * label-applier.test.ts
 *
 * Tests for the Gmail label creation and batch application module.
 * All GmailClient interactions are mocked at the interface level.
 */

import type { gmail_v1 } from "googleapis";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GmailClient, Result } from "../../src/auth/gmail-client.js";
import {
  applyClassifications,
  EXTRACTED_LABEL,
  ensureLabelsExist,
  TRIAGE_LABEL,
} from "../../src/classify/label-applier.js";
import type { ThreadClassification } from "../../src/schemas/classification.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Creates a mock GmailClient with vi.fn() methods. */
function createMockClient(): GmailClient {
  return {
    getProfile: vi.fn(),
    listMessages: vi.fn(),
    getMessage: vi.fn(),
    batchModifyMessages: vi.fn<() => Promise<Result<void>>>().mockResolvedValue({ ok: true, value: undefined }),
    listLabels: vi.fn<() => Promise<Result<gmail_v1.Schema$Label[]>>>().mockResolvedValue({ ok: true, value: [] }),
    listFilters: vi.fn(),
    createLabel: vi
      .fn<(name: string) => Promise<Result<gmail_v1.Schema$Label>>>()
      .mockImplementation(async (name: string) => ({ ok: true, value: { id: `label-${name}`, name } })),
    createFilter: vi.fn(),
  };
}

/** Creates a ThreadClassification. */
function makeClassification(
  threadId: string,
  category: string,
  actionable: boolean,
  overrides: Partial<ThreadClassification> = {},
): ThreadClassification {
  return {
    threadId,
    category,
    confidence: 0.9,
    actionable,
    summary: "Test thread.",
    classifiedBy: "llm",
    ...overrides,
  };
}

/** Builds a thread→messageIds map for testing. */
function makeThreadMap(entries: Array<[threadId: string, messageIds: string[]]>): Map<string, string[]> {
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// ensureLabelsExist
// ---------------------------------------------------------------------------

describe("ensureLabelsExist", () => {
  let client: GmailClient;

  beforeEach(() => {
    client = createMockClient();
  });

  it("creates labels for all categories when none exist", async () => {
    const categories = ["newsletter", "transactional", "personal"];

    const result = await ensureLabelsExist(categories, client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    const labelMap = result.value;
    expect(labelMap.has("newsletter")).toBe(true);
    expect(labelMap.has("transactional")).toBe(true);
    expect(labelMap.has("personal")).toBe(true);
    // Operational labels also created
    expect(labelMap.has(TRIAGE_LABEL)).toBe(true);
    expect(labelMap.has(EXTRACTED_LABEL)).toBe(true);
  });

  it("returns label IDs from createLabel for newly created labels", async () => {
    const categories = ["newsletter"];
    const createLabelMock = client.createLabel as ReturnType<typeof vi.fn>;
    createLabelMock.mockResolvedValueOnce({ ok: true, value: { id: "lbl-newsletter-id", name: "newsletter" } });

    const result = await ensureLabelsExist(categories, client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.get("newsletter")).toBe("lbl-newsletter-id");
  });

  it("skips labels that already exist in Gmail", async () => {
    const listLabelsMock = client.listLabels as ReturnType<typeof vi.fn>;
    listLabelsMock.mockResolvedValue({
      ok: true,
      value: [
        { id: "existing-newsletter", name: "newsletter" },
        { id: "existing-triage", name: TRIAGE_LABEL },
      ],
    });

    const categories = ["newsletter", "transactional"];

    const result = await ensureLabelsExist(categories, client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    const labelMap = result.value;
    // newsletter was already there — no create call for it
    expect(labelMap.get("newsletter")).toBe("existing-newsletter");
    // transactional did not exist — create was called
    const createLabelMock = client.createLabel as ReturnType<typeof vi.fn>;
    expect(createLabelMock).toHaveBeenCalledWith("transactional");
    expect(createLabelMock).not.toHaveBeenCalledWith("newsletter");
    // TRIAGE_LABEL was already there — no create call
    expect(labelMap.get(TRIAGE_LABEL)).toBe("existing-triage");
    expect(createLabelMock).not.toHaveBeenCalledWith(TRIAGE_LABEL);
  });

  it("always ensures _triage and _extracted operational labels", async () => {
    const categories: string[] = [];

    const result = await ensureLabelsExist(categories, client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    const createLabelMock = client.createLabel as ReturnType<typeof vi.fn>;
    expect(createLabelMock).toHaveBeenCalledWith(TRIAGE_LABEL);
    expect(createLabelMock).toHaveBeenCalledWith(EXTRACTED_LABEL);
    expect(result.value.has(TRIAGE_LABEL)).toBe(true);
    expect(result.value.has(EXTRACTED_LABEL)).toBe(true);
  });

  it("returns error when listLabels fails", async () => {
    const listLabelsMock = client.listLabels as ReturnType<typeof vi.fn>;
    listLabelsMock.mockResolvedValue({ ok: false, error: "API unavailable" });

    const result = await ensureLabelsExist(["newsletter"], client);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toMatch(/API unavailable/);
  });

  it("returns error when createLabel fails", async () => {
    const createLabelMock = client.createLabel as ReturnType<typeof vi.fn>;
    createLabelMock.mockResolvedValue({ ok: false, error: "quota exceeded" });

    const result = await ensureLabelsExist(["newsletter"], client);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toMatch(/quota exceeded/);
  });

  it("deduplicates categories before creating", async () => {
    const categories = ["newsletter", "newsletter", "transactional"];

    const result = await ensureLabelsExist(categories, client);

    expect(result.ok).toBe(true);
    const createLabelMock = client.createLabel as ReturnType<typeof vi.fn>;
    // newsletter should only be created once
    const newsletterCalls = createLabelMock.mock.calls.filter((call: unknown[]) => call[0] === "newsletter");
    expect(newsletterCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// applyClassifications
// ---------------------------------------------------------------------------

describe("applyClassifications", () => {
  let client: GmailClient;
  let labelMap: Map<string, string>;
  let threads: Map<string, string[]>;

  beforeEach(() => {
    client = createMockClient();
    labelMap = new Map([
      ["newsletter", "lbl-newsletter"],
      ["transactional", "lbl-transactional"],
      [TRIAGE_LABEL, "lbl-triage"],
      [EXTRACTED_LABEL, "lbl-extracted"],
    ]);
    threads = makeThreadMap([
      ["thread-1", ["msg-1a", "msg-1b"]],
      ["thread-2", ["msg-2a"]],
      ["thread-3", ["msg-3a", "msg-3b", "msg-3c"]],
    ]);
  });

  it("archives non-actionable messages: adds category label, removes INBOX", async () => {
    const classifications: ThreadClassification[] = [makeClassification("thread-1", "newsletter", false)];

    const result = await applyClassifications(classifications, threads, labelMap, client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    const batchModifyMock = client.batchModifyMessages as ReturnType<typeof vi.fn>;
    expect(batchModifyMock).toHaveBeenCalled();

    // Check that a call was made with the newsletter label added and INBOX removed
    const calls: Array<[string[], string[] | undefined, string[] | undefined]> = batchModifyMock.mock.calls;
    const archiveCall = calls.find((c) => {
      const [, addLabels, removeLabels] = c;
      return addLabels?.includes("lbl-newsletter") === true && removeLabels?.includes("INBOX") === true;
    });
    expect(archiveCall).toBeDefined();
    if (!archiveCall) throw new Error("Expected archive call");
    const [ids] = archiveCall;
    expect(ids).toContain("msg-1a");
    expect(ids).toContain("msg-1b");
  });

  it("triages actionable messages: adds category label + _triage, keeps INBOX", async () => {
    const classifications: ThreadClassification[] = [makeClassification("thread-2", "newsletter", true)];

    const result = await applyClassifications(classifications, threads, labelMap, client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    const batchModifyMock = client.batchModifyMessages as ReturnType<typeof vi.fn>;
    const calls: Array<[string[], string[] | undefined, string[] | undefined]> = batchModifyMock.mock.calls;

    // Should have a call that adds newsletter label AND triage label, without removing INBOX
    const triageCall = calls.find((c) => {
      const [, addLabels, removeLabels] = c;
      return (
        addLabels?.includes("lbl-newsletter") === true &&
        addLabels?.includes("lbl-triage") === true &&
        (removeLabels === undefined || !removeLabels.includes("INBOX"))
      );
    });
    expect(triageCall).toBeDefined();
    if (!triageCall) throw new Error("Expected triage call");
    expect(triageCall[0]).toContain("msg-2a");
  });

  it("returns summary with totalApplied, totalArchived, totalTriaged", async () => {
    const classifications: ThreadClassification[] = [
      makeClassification("thread-1", "newsletter", false),
      makeClassification("thread-2", "transactional", true),
      makeClassification("thread-3", "newsletter", false),
    ];

    const result = await applyClassifications(classifications, threads, labelMap, client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    const summary = result.value;
    // thread-1 + thread-3 archived (5 messages), thread-2 triaged (1 message)
    expect(summary.totalArchived).toBe(5);
    expect(summary.totalTriaged).toBe(1);
    expect(summary.totalApplied).toBe(6);
    expect(summary.failures).toHaveLength(0);
  });

  it("chunks large batches — calls batchModifyMessages in chunks of 1000", async () => {
    // Build 2500 messages in one thread to force 3 batches
    const messageIds = Array.from({ length: 2500 }, (_, i) => `msg-${i}`);
    const bigThreads = makeThreadMap([["big-thread", messageIds]]);
    const classifications: ThreadClassification[] = [makeClassification("big-thread", "newsletter", false)];

    const result = await applyClassifications(classifications, bigThreads, labelMap, client);

    expect(result.ok).toBe(true);
    const batchModifyMock = client.batchModifyMessages as ReturnType<typeof vi.fn>;
    // 2500 messages / 1000 per batch = 3 calls
    expect(batchModifyMock).toHaveBeenCalledTimes(3);
  });

  it("dry-run mode logs and returns summary without calling API", async () => {
    const classifications: ThreadClassification[] = [
      makeClassification("thread-1", "newsletter", false),
      makeClassification("thread-2", "transactional", true),
    ];

    const result = await applyClassifications(classifications, threads, labelMap, client, {
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    // No API calls made
    const batchModifyMock = client.batchModifyMessages as ReturnType<typeof vi.fn>;
    expect(batchModifyMock).not.toHaveBeenCalled();

    // Still returns a valid summary
    const summary = result.value;
    expect(summary.totalApplied).toBe(3); // thread-1 has 2 msgs, thread-2 has 1
    expect(summary.totalArchived).toBe(2);
    expect(summary.totalTriaged).toBe(1);
  });

  it("calls onProgress callback with applied and total counts", async () => {
    const classifications: ThreadClassification[] = [
      makeClassification("thread-1", "newsletter", false),
      makeClassification("thread-2", "transactional", true),
      makeClassification("thread-3", "newsletter", false),
    ];

    const progressCalls: Array<{ applied: number; total: number }> = [];
    const onProgress = (progress: { applied: number; total: number }): void => {
      progressCalls.push({ ...progress });
    };

    const result = await applyClassifications(classifications, threads, labelMap, client, {
      onProgress,
    });

    expect(result.ok).toBe(true);
    expect(progressCalls.length).toBeGreaterThan(0);
    // Final call should have applied === total
    const last = progressCalls[progressCalls.length - 1];
    if (!last) throw new Error("Expected at least one progress call");
    expect(last.applied).toBe(last.total);
  });

  it("returns error when any batch fails, after attempting remaining batches", async () => {
    // Make thread-1 fail but thread-2 and thread-3 succeed
    const batchModifyMock = client.batchModifyMessages as ReturnType<typeof vi.fn>;
    let callCount = 0;
    batchModifyMock.mockImplementation(async (ids: string[]) => {
      callCount++;
      if (ids.includes("msg-1a")) {
        return { ok: false, error: "network error on batch 1" };
      }
      return { ok: true, value: undefined };
    });

    const classifications: ThreadClassification[] = [
      makeClassification("thread-1", "newsletter", false),
      makeClassification("thread-2", "transactional", true),
      makeClassification("thread-3", "newsletter", false),
    ];

    const result = await applyClassifications(classifications, threads, labelMap, client);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toMatch(/Failed to apply classifications/);
    expect(result.error).toMatch(/network error on batch 1/);
    // The implementation still processes remaining batches before returning the error.
    expect(callCount).toBeGreaterThan(1);
  });

  it("returns error when a classified thread is missing from the threads map", async () => {
    const classifications: ThreadClassification[] = [makeClassification("unknown-thread", "newsletter", false)];

    const result = await applyClassifications(classifications, threads, labelMap, client);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toMatch(/No message IDs found for thread "unknown-thread"/);
    const batchModifyMock = client.batchModifyMessages as ReturnType<typeof vi.fn>;
    expect(batchModifyMock).not.toHaveBeenCalled();
  });

  it("returns error when a category is missing from the label map", async () => {
    const classifications: ThreadClassification[] = [makeClassification("thread-1", "unknown-category", false)];

    const result = await applyClassifications(classifications, threads, labelMap, client);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toMatch(/No label ID found for category "unknown-category"/);
    const batchModifyMock = client.batchModifyMessages as ReturnType<typeof vi.fn>;
    expect(batchModifyMock).not.toHaveBeenCalled();
  });

  it("handles empty classifications list", async () => {
    const result = await applyClassifications([], threads, labelMap, client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    const summary = result.value;
    expect(summary.totalApplied).toBe(0);
    expect(summary.totalArchived).toBe(0);
    expect(summary.totalTriaged).toBe(0);
    expect(summary.failures).toHaveLength(0);
  });
});
