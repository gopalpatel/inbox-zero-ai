/**
 * filter-consolidator.test.ts
 *
 * Tests for buildConsolidatedQueries() and migrateFilters().
 * Mocks at the GmailClient interface level and the decision-log-manager module.
 */

import type { gmail_v1 } from "googleapis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GmailClient } from "../../src/auth/gmail-client.js";
import type { DecisionEntry } from "../../src/schemas/decision-log.js";
import type { DeleteFirstPlan } from "../../src/noise/filter-consolidator.js";

// ---------------------------------------------------------------------------
// Mock node:fs/promises (for delete-first snapshot I/O)
// ---------------------------------------------------------------------------

const fsMocks = {
  /** Content keyed by file path. Set a path to simulate an existing snapshot. */
  files: new Map<string, string>(),
  /** Track unlink calls. */
  unlinkCalls: [] as string[],
};

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(async (filePath: string) => {
      const content = fsMocks.files.get(filePath);
      if (content === undefined) {
        const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return content;
    }),
    mkdir: vi.fn(async () => undefined),
    unlink: vi.fn(async (filePath: string) => {
      fsMocks.unlinkCalls.push(filePath);
      fsMocks.files.delete(filePath);
    }),
  },
}));

vi.mock("../../src/utils.js", () => ({
  atomicWriteFile: vi.fn(async (filePath: string, content: string) => {
    fsMocks.files.set(filePath, content);
  }),
}));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import {
  buildConsolidatedQueries,
  getDeleteFirstPlanPath,
  migrateFilters,
} from "../../src/noise/filter-consolidator.js";

// ---------------------------------------------------------------------------
// Mock decision-log-manager
// ---------------------------------------------------------------------------

vi.mock("../../src/state/decision-log-manager.js", () => ({
  readDecisionLog: vi.fn(),
  latestDecisionsBySender: vi.fn(),
  collectNoiseSenders: vi.fn(),
  NOISE_DECISIONS: new Set(["filter", "unsubscribe"]),
}));

import { collectNoiseSenders, readDecisionLog, latestDecisionsBySender } from "../../src/state/decision-log-manager.js";

const mockedCollectNoiseSenders = vi.mocked(collectNoiseSenders);
const mockedReadDecisionLog = vi.mocked(readDecisionLog);
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

/** Creates a mock GmailClient for migration tests. */
function makeMockGmailClient(
  overrides: {
    listFiltersResult?: { ok: true; value: gmail_v1.Schema$Filter[] } | { ok: false; error: string };
    createFilterResult?: { ok: true; value: gmail_v1.Schema$Filter } | { ok: false; error: string };
    deleteFilterResult?: { ok: true; value: undefined } | { ok: false; error: string };
  } = {},
): GmailClient {
  const listFiltersMock = vi.fn().mockResolvedValue(
    overrides.listFiltersResult ?? { ok: true, value: [] },
  );

  let createFilterCallCount = 0;
  const createFilterMock = vi.fn().mockImplementation(() => {
    createFilterCallCount++;
    if (overrides.createFilterResult !== undefined) {
      return Promise.resolve(overrides.createFilterResult);
    }
    return Promise.resolve({
      ok: true,
      value: { id: `filter-new-${createFilterCallCount}`, criteria: {}, action: {} },
    });
  });

  const deleteFilterMock = vi.fn().mockResolvedValue(
    overrides.deleteFilterResult ?? { ok: true, value: undefined },
  );

  return {
    getProfile: vi.fn(),
    listMessages: vi.fn(),
    getMessage: vi.fn(),
    batchModifyMessages: vi.fn(),
    listLabels: vi.fn(),
    listFilters: listFiltersMock,
    createLabel: vi.fn(),
    createFilter: createFilterMock,
    deleteFilter: deleteFilterMock,
  };
}

/** Build a Gmail filter stub matching a single per-sender noise filter. */
function makePerSenderFilter(
  id: string,
  senderEmail: string,
  noiseLabelId: string,
  extra?: { removeLabelIds?: string[] },
): gmail_v1.Schema$Filter {
  return {
    id,
    criteria: { from: senderEmail },
    action: {
      addLabelIds: [noiseLabelId],
      removeLabelIds: extra?.removeLabelIds ?? ["INBOX"],
    },
  };
}

function makeConsolidatedFilter(
  id: string,
  query: string,
  noiseLabelId: string,
  removeLabelIds: string[],
): gmail_v1.Schema$Filter {
  return {
    id,
    criteria: { query },
    action: {
      addLabelIds: [noiseLabelId],
      removeLabelIds,
    },
  };
}

// ===========================================================================
// buildConsolidatedQueries
// ===========================================================================

describe("buildConsolidatedQueries()", () => {
  it("returns empty array for empty input", () => {
    const result = buildConsolidatedQueries([]);
    expect(result).toEqual([]);
  });

  it("returns a single query for one sender", () => {
    const result = buildConsolidatedQueries(["a@example.com"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("from:a@example.com");
  });

  it("combines multiple senders under the char limit with OR", () => {
    const result = buildConsolidatedQueries(["a@x.com", "b@x.com", "c@x.com"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("from:a@x.com OR from:b@x.com OR from:c@x.com");
  });

  it("splits into multiple queries when char limit is exceeded", () => {
    // "from:aaa@example.com" is 20 chars
    // "from:aaa@example.com OR from:bbb@example.com" is 45 chars
    // Set limit to 40 so the second sender triggers a new batch
    const result = buildConsolidatedQueries(
      ["aaa@example.com", "bbb@example.com", "ccc@example.com"],
      40,
    );
    // Each query should contain exactly 1 sender
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("from:aaa@example.com");
    expect(result[1]).toBe("from:bbb@example.com");
    expect(result[2]).toBe("from:ccc@example.com");
  });

  it("guarantees at least one sender per batch even if it exceeds maxChars", () => {
    const longEmail = "a".repeat(50) + "@example.com";
    const result = buildConsolidatedQueries([longEmail], 10);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(`from:${longEmail}`);
  });

  it("uses default maxChars of 1200 when not specified", () => {
    // Generate enough senders to exceed 1200 chars
    // "from:senderXX@example.com" is ~25 chars, with " OR " separator = ~29
    // 1200 / 29 ≈ 41 senders per batch
    const senders = Array.from({ length: 80 }, (_, i) => `sender${String(i).padStart(2, "0")}@example.com`);
    const result = buildConsolidatedQueries(senders);
    expect(result.length).toBeGreaterThan(1);
    // Verify no query exceeds 1200 chars (except the "at least one" guarantee)
    for (const q of result) {
      // Each query should be at or below 1200 chars
      // (the first sender in a batch may exceed if the sender itself is very long,
      //  but normal senders should fit)
      const fromCount = (q.match(/from:/g) ?? []).length;
      if (fromCount > 1) {
        expect(q.length).toBeLessThanOrEqual(1200);
      }
    }
  });

  it("handles a batch that fits exactly at the limit", () => {
    // "from:a@x.com" is 12 chars
    // "from:a@x.com OR from:b@x.com" is 29 chars
    const result = buildConsolidatedQueries(["a@x.com", "b@x.com"], 29);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("from:a@x.com OR from:b@x.com");
  });

  it("multiple senders beyond limit produce correct batches", () => {
    const senders = ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"];
    // "from:a@x.com" = 12, " OR from:b@x.com" = 17, total 29
    // Set limit to 29 so each batch gets exactly 2 senders
    const result = buildConsolidatedQueries(senders, 29);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("from:a@x.com OR from:b@x.com");
    expect(result[1]).toBe("from:c@x.com OR from:d@x.com");
    expect(result[2]).toBe("from:e@x.com");
  });
});

// ===========================================================================
// migrateFilters
// ===========================================================================

describe("migrateFilters()", () => {
  const NOISE_LABEL_ID = "label-noise-001";

  // Default mocks for the re-kept senders detection path.
  // migrateFilters calls readDecisionLog + latestDecisionsBySender to find
  // stale filters for senders whose latest decision changed back to "keep".
  // By default, return empty decisions so no stale filters are detected.
  beforeEach(() => {
    mockedCollectNoiseSenders.mockReset();
    mockedCollectNoiseSenders.mockResolvedValue({ ok: true, value: null });
    mockedReadDecisionLog.mockResolvedValue({ ok: true, value: { version: 1, decisions: [] } });
    mockedLatestDecisionsBySender.mockReturnValue(new Map());
    fsMocks.files.clear();
    fsMocks.unlinkCalls = [];
  });

  afterEach(() => {
    mockedCollectNoiseSenders.mockReset();
    mockedReadDecisionLog.mockReset();
    mockedLatestDecisionsBySender.mockReset();
  });

  it("returns ok with zero counts when decision log does not exist", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({ ok: true, value: null });
    const client = makeMockGmailClient();

    const result = await migrateFilters(client, "/tmp/decisions.json", NOISE_LABEL_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filtersCreated).toBe(0);
    expect(result.value.filtersDeleted).toBe(0);
    expect(result.value.slotsFreed).toBe(0);
    expect(result.value.errors).toHaveLength(0);
  });

  it("returns ok with zero counts when decision log is empty", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: null,
    });
    const client = makeMockGmailClient();

    const result = await migrateFilters(client, "/tmp/decisions.json", NOISE_LABEL_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filtersCreated).toBe(0);
    expect(result.value.filtersDeleted).toBe(0);
  });

  it("returns error when decision log read fails", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: false,
      error: "JSON parse error: Unexpected token",
    });
    const client = makeMockGmailClient();

    const result = await migrateFilters(client, "/tmp/corrupt.json", NOISE_LABEL_ID);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("JSON parse error");
  });

  it("returns ok with zero counts when all decisions are 'keep'", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: { filterSenders: [], unsubscribeSenders: [], allNoiseSenders: [] },
    });
    const client = makeMockGmailClient();

    const result = await migrateFilters(client, "/tmp/decisions.json", NOISE_LABEL_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filtersCreated).toBe(0);
    expect(result.value.filtersDeleted).toBe(0);
  });

  it("deletes stale keep-filters even when there are no active noise senders", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: { filterSenders: [], unsubscribeSenders: [], allNoiseSenders: [] },
    });
    mockedReadDecisionLog.mockResolvedValueOnce({
      ok: true,
      value: {
        version: 1,
        decisions: [makeDecision({ senderEmail: "keep@example.com", userDecision: "keep" })],
      },
    });
    mockedLatestDecisionsBySender.mockReturnValueOnce(
      new Map([
        ["keep@example.com", makeDecision({ senderEmail: "keep@example.com", userDecision: "keep" })],
      ]),
    );

    const client = makeMockGmailClient({
      listFiltersResult: {
        ok: true,
        value: [makePerSenderFilter("f-keep", "keep@example.com", NOISE_LABEL_ID)],
      },
    });

    const result = await migrateFilters(client, "/tmp/decisions.json", NOISE_LABEL_ID, {
      mode: "execute",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filtersCreated).toBe(0);
    expect(result.value.filtersDeleted).toBe(1);
    expect(client.deleteFilter).toHaveBeenCalledWith("f-keep");
  });

  it("dry-run reports counts but does not call createFilter or deleteFilter", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: ["noise@example.com"],
        unsubscribeSenders: [],
        allNoiseSenders: ["noise@example.com"],
      },
    });

    const existingFilters: gmail_v1.Schema$Filter[] = [
      makePerSenderFilter("f1", "noise@example.com", NOISE_LABEL_ID),
      // Unrelated filter — should not be touched
      {
        id: "f-other",
        criteria: { from: "other@example.com" },
        action: { addLabelIds: ["some-label"] },
      },
    ];

    const client = makeMockGmailClient({
      listFiltersResult: { ok: true, value: existingFilters },
    });

    const result = await migrateFilters(client, "/tmp/decisions.json", NOISE_LABEL_ID, {
      mode: "dry-run",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should report what would happen
    expect(result.value.filtersCreated).toBeGreaterThanOrEqual(0);
    // Should NOT have called createFilter or deleteFilter
    expect(client.createFilter).not.toHaveBeenCalled();
    expect(client.deleteFilter).not.toHaveBeenCalled();
  });

  it("without options, does not call createFilter or deleteFilter (dry-run by default)", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: ["noise@example.com"],
        unsubscribeSenders: [],
        allNoiseSenders: ["noise@example.com"],
      },
    });

    const existingFilters: gmail_v1.Schema$Filter[] = [
      makePerSenderFilter("f1", "noise@example.com", NOISE_LABEL_ID),
    ];

    const client = makeMockGmailClient({
      listFiltersResult: { ok: true, value: existingFilters },
    });

    // No options at all — default should be dry-run behavior
    const result = await migrateFilters(client, "/tmp/decisions.json", NOISE_LABEL_ID);

    expect(result.ok).toBe(true);
    expect(client.createFilter).not.toHaveBeenCalled();
    expect(client.deleteFilter).not.toHaveBeenCalled();
  });

  it("with mode: execute, creates consolidated filters and deletes per-sender filters", async () => {
    const senders = ["a@example.com", "b@example.com", "c@example.com"];

    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: senders,
        unsubscribeSenders: [],
        allNoiseSenders: senders,
      },
    });

    const existingFilters: gmail_v1.Schema$Filter[] = [
      makePerSenderFilter("f1", "a@example.com", NOISE_LABEL_ID),
      makePerSenderFilter("f2", "b@example.com", NOISE_LABEL_ID),
      makePerSenderFilter("f3", "c@example.com", NOISE_LABEL_ID),
      // An unrelated filter
      {
        id: "f-unrelated",
        criteria: { from: "boss@work.com" },
        action: { addLabelIds: ["important"] },
      },
    ];

    const client = makeMockGmailClient({
      listFiltersResult: { ok: true, value: existingFilters },
    });

    const result = await migrateFilters(client, "/tmp/decisions.json", NOISE_LABEL_ID, {
      mode: "execute",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should have created at least 1 consolidated filter
    expect(result.value.filtersCreated).toBeGreaterThanOrEqual(1);

    // Should have deleted the 3 per-sender filters
    expect(result.value.filtersDeleted).toBe(3);

    // slotsFreed = deleted - created
    expect(result.value.slotsFreed).toBe(3 - result.value.filtersCreated);

    // Verify createFilter was called (with query-based criteria)
    expect(client.createFilter).toHaveBeenCalled();

    // Verify deleteFilter was called for the 3 per-sender filters
    expect(client.deleteFilter).toHaveBeenCalledTimes(3);
    expect(client.deleteFilter).toHaveBeenCalledWith("f1");
    expect(client.deleteFilter).toHaveBeenCalledWith("f2");
    expect(client.deleteFilter).toHaveBeenCalledWith("f3");

    // The unrelated filter should NOT have been deleted
    expect(client.deleteFilter).not.toHaveBeenCalledWith("f-unrelated");
  });

  it("partitions filter vs unsubscribe actions correctly (different removeLabelIds)", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: ["filter-me@example.com"],
        unsubscribeSenders: ["unsub-me@example.com"],
        allNoiseSenders: ["filter-me@example.com", "unsub-me@example.com"],
      },
    });

    const existingFilters: gmail_v1.Schema$Filter[] = [
      makePerSenderFilter("f1", "filter-me@example.com", NOISE_LABEL_ID, {
        removeLabelIds: ["INBOX"],
      }),
      makePerSenderFilter("f2", "unsub-me@example.com", NOISE_LABEL_ID, {
        removeLabelIds: ["INBOX", "UNREAD"],
      }),
    ];

    const client = makeMockGmailClient({
      listFiltersResult: { ok: true, value: existingFilters },
    });

    const result = await migrateFilters(client, "/tmp/decisions.json", NOISE_LABEL_ID, {
      mode: "execute",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should have created 2 consolidated filters (one for filter group, one for unsubscribe group)
    expect(result.value.filtersCreated).toBe(2);

    // Verify the createFilter calls had different removeLabelIds
    const createCalls = vi.mocked(client.createFilter).mock.calls;
    expect(createCalls).toHaveLength(2);

    // One call should have removeLabelIds: ["INBOX"]
    // The other should have removeLabelIds: ["INBOX", "UNREAD"]
    const removeLabels = createCalls.map((call) => call[1].removeLabelIds);
    const hasFilterAction = removeLabels.some(
      (labels) => labels !== undefined && labels.length === 1 && labels[0] === "INBOX",
    );
    const hasUnsubAction = removeLabels.some(
      (labels) => labels !== undefined && labels.length === 2 && labels.includes("INBOX") && labels.includes("UNREAD"),
    );
    expect(hasFilterAction).toBe(true);
    expect(hasUnsubAction).toBe(true);
  });

  it("handles no matching existing filters (nothing to migrate)", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: ["noise@example.com"],
        unsubscribeSenders: [],
        allNoiseSenders: ["noise@example.com"],
      },
    });

    // No existing per-sender noise filters — nothing to consolidate
    const client = makeMockGmailClient({
      listFiltersResult: { ok: true, value: [] },
    });

    const result = await migrateFilters(client, "/tmp/decisions.json", NOISE_LABEL_ID, {
      mode: "execute",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // No legacy filters to consolidate → no creates, no deletes
    expect(result.value.filtersCreated).toBe(0);
    expect(result.value.filtersDeleted).toBe(0);
    expect(result.value.slotsFreed).toBe(0);
    expect(client.createFilter).not.toHaveBeenCalled();
    expect(client.deleteFilter).not.toHaveBeenCalled();
  });

  it("returns error when listFilters fails", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: ["noise@example.com"],
        unsubscribeSenders: [],
        allNoiseSenders: ["noise@example.com"],
      },
    });

    const client = makeMockGmailClient({
      listFiltersResult: { ok: false, error: "Settings API error" },
    });

    const result = await migrateFilters(client, "/tmp/decisions.json", NOISE_LABEL_ID, {
      mode: "execute",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Settings API error");
  });

  it("captures createFilter errors in the errors array without aborting", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: ["a@example.com"],
        unsubscribeSenders: [],
        allNoiseSenders: ["a@example.com"],
      },
    });

    const existingFilters = [
      makePerSenderFilter("f1", "a@example.com", NOISE_LABEL_ID),
    ];

    const client = makeMockGmailClient({
      listFiltersResult: { ok: true, value: existingFilters },
      createFilterResult: { ok: false, error: "Filter creation failed" },
    });

    const result = await migrateFilters(client, "/tmp/decisions.json", NOISE_LABEL_ID, {
      mode: "execute",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.errors.length).toBeGreaterThan(0);
    expect(result.value.errors[0]).toContain("Filter creation failed");
    // Per-sender filters should NOT be deleted if the consolidated replacement failed
    expect(result.value.filtersDeleted).toBe(0);
  });

  it("captures deleteFilter errors in the errors array without aborting", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: ["a@example.com"],
        unsubscribeSenders: [],
        allNoiseSenders: ["a@example.com"],
      },
    });

    const existingFilters = [
      makePerSenderFilter("f1", "a@example.com", NOISE_LABEL_ID),
    ];

    const client = makeMockGmailClient({
      listFiltersResult: { ok: true, value: existingFilters },
      deleteFilterResult: { ok: false, error: "Delete failed" },
    });

    const result = await migrateFilters(client, "/tmp/decisions.json", NOISE_LABEL_ID, {
      mode: "execute",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Consolidated filter should have been created
    expect(result.value.filtersCreated).toBe(1);
    // Delete failed but was attempted
    expect(result.value.errors.length).toBeGreaterThan(0);
    expect(result.value.errors[0]).toContain("Delete failed");
  });

  it("uses latest decision per sender — re-kept sender is excluded", async () => {
    // collectNoiseSenders already handles the latest-decision logic
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: { filterSenders: [], unsubscribeSenders: [], allNoiseSenders: [] },
    });

    const client = makeMockGmailClient({
      listFiltersResult: { ok: true, value: [] },
    });

    const result = await migrateFilters(client, "/tmp/decisions.json", NOISE_LABEL_ID, {
      mode: "execute",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No noise senders → nothing to migrate
    expect(result.value.filtersCreated).toBe(0);
    expect(result.value.filtersDeleted).toBe(0);
    expect(client.createFilter).not.toHaveBeenCalled();
  });

  it("matches existing per-sender filters case-insensitively", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: ["Noise@Example.COM"],
        unsubscribeSenders: [],
        allNoiseSenders: ["Noise@Example.COM"],
      },
    });

    const existingFilters = [
      makePerSenderFilter("f1", "noise@example.com", NOISE_LABEL_ID),
    ];

    const client = makeMockGmailClient({
      listFiltersResult: { ok: true, value: existingFilters },
    });

    const result = await migrateFilters(client, "/tmp/decisions.json", NOISE_LABEL_ID, {
      mode: "execute",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should have matched the existing filter despite case difference
    expect(result.value.filtersDeleted).toBe(1);
  });

  it("does not recreate an equivalent consolidated filter on rerun", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: ["b@example.com", "a@example.com"],
        unsubscribeSenders: [],
        allNoiseSenders: ["b@example.com", "a@example.com"],
      },
    });

    const existingFilters = [
      makePerSenderFilter("f1", "a@example.com", NOISE_LABEL_ID),
      makePerSenderFilter("f2", "b@example.com", NOISE_LABEL_ID),
      makeConsolidatedFilter(
        "f-consolidated",
        "from:a@example.com OR from:b@example.com",
        NOISE_LABEL_ID,
        ["INBOX"],
      ),
    ];

    const client = makeMockGmailClient({
      listFiltersResult: { ok: true, value: existingFilters },
    });

    const result = await migrateFilters(client, "/tmp/decisions.json", NOISE_LABEL_ID, {
      mode: "execute",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filtersCreated).toBe(0);
    expect(result.value.filtersDeleted).toBe(2);
    expect(client.createFilter).not.toHaveBeenCalled();
  });

  it("fails fast when there is not enough filter headroom for create-before-delete migration", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: ["noise@example.com"],
        unsubscribeSenders: [],
        allNoiseSenders: ["noise@example.com"],
      },
    });

    const existingFilters: gmail_v1.Schema$Filter[] = Array.from({ length: 1000 }, (_, index) =>
      index === 0
        ? makePerSenderFilter("f-noise", "noise@example.com", NOISE_LABEL_ID)
        : {
            id: `f-${index}`,
            criteria: { from: `other${index}@example.com` },
            action: { addLabelIds: ["label-other"] },
          },
    );

    const client = makeMockGmailClient({
      listFiltersResult: { ok: true, value: existingFilters },
    });

    const result = await migrateFilters(client, "/tmp/decisions.json", NOISE_LABEL_ID, {
      mode: "execute",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Not enough Gmail filter headroom");
    expect(client.createFilter).not.toHaveBeenCalled();
    expect(client.deleteFilter).not.toHaveBeenCalled();
  });

  it("uses stale keep-filter deletions to free headroom before creating consolidated filters", async () => {
    mockedCollectNoiseSenders.mockResolvedValueOnce({
      ok: true,
      value: {
        filterSenders: ["noise@example.com"],
        unsubscribeSenders: [],
        allNoiseSenders: ["noise@example.com"],
      },
    });
    mockedReadDecisionLog.mockResolvedValueOnce({
      ok: true,
      value: {
        version: 1,
        decisions: [makeDecision({ senderEmail: "keep@example.com", userDecision: "keep" })],
      },
    });
    mockedLatestDecisionsBySender.mockReturnValueOnce(
      new Map([
        ["keep@example.com", makeDecision({ senderEmail: "keep@example.com", userDecision: "keep" })],
      ]),
    );

    const existingFilters: gmail_v1.Schema$Filter[] = Array.from({ length: 1000 }, (_, index) => {
      if (index === 0) {
        return makePerSenderFilter("f-noise", "noise@example.com", NOISE_LABEL_ID);
      }
      if (index === 1) {
        return makePerSenderFilter("f-keep", "keep@example.com", NOISE_LABEL_ID);
      }
      return {
        id: `f-${index}`,
        criteria: { from: `other${index}@example.com` },
        action: { addLabelIds: ["label-other"] },
      };
    });

    const client = makeMockGmailClient({
      listFiltersResult: { ok: true, value: existingFilters },
    });

    const result = await migrateFilters(client, "/tmp/decisions.json", NOISE_LABEL_ID, {
      mode: "execute",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filtersDeleted).toBe(2);
    expect(result.value.filtersCreated).toBe(1);
    expect(client.deleteFilter).toHaveBeenCalledWith("f-keep");
    expect(client.createFilter).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // deleteFirst mode
  // =========================================================================

  describe("deleteFirst mode", () => {
    /** Helper: set up standard noise mocks for a set of filter senders. */
    function setupNoiseMocks(senders: string[]): void {
      mockedCollectNoiseSenders.mockResolvedValueOnce({
        ok: true,
        value: {
          filterSenders: senders,
          unsubscribeSenders: [],
          allNoiseSenders: senders,
        },
      });
    }

    /** Helper: resolve the snapshot path for the test decision log path. */
    const DECISION_LOG_PATH = "/tmp/decisions.json";
    const snapshotPath = getDeleteFirstPlanPath(DECISION_LOG_PATH);

    // Test 1: Execute mode at 1000 filters succeeds — deletes happen before creates
    it("deletes per-sender filters before creating consolidated ones at the 1000-filter limit", async () => {
      const senders = ["a@example.com", "b@example.com", "c@example.com"];
      setupNoiseMocks(senders);

      // Fill to 1000 filters (would fail headroom check in default mode)
      const existingFilters: gmail_v1.Schema$Filter[] = [
        makePerSenderFilter("f1", "a@example.com", NOISE_LABEL_ID),
        makePerSenderFilter("f2", "b@example.com", NOISE_LABEL_ID),
        makePerSenderFilter("f3", "c@example.com", NOISE_LABEL_ID),
        ...Array.from({ length: 997 }, (_, i) => ({
          id: `f-other-${i}`,
          criteria: { from: `other${i}@example.com` },
          action: { addLabelIds: ["label-other"] },
        })),
      ];

      // Track call order to verify deletes happen before creates
      const callOrder: string[] = [];
      const client = makeMockGmailClient({
        listFiltersResult: { ok: true, value: existingFilters },
      });
      vi.mocked(client.deleteFilter).mockImplementation(async () => {
        callOrder.push("delete");
        return { ok: true, value: undefined };
      });
      vi.mocked(client.createFilter).mockImplementation(async () => {
        callOrder.push("create");
        return { ok: true, value: { id: "filter-new", criteria: {}, action: {} } };
      });
      const filtersAfterDeletes = existingFilters.filter((f) => !["f1", "f2", "f3"].includes(f.id!));
      const filtersAfterCreates = [
        ...filtersAfterDeletes,
        {
          id: "filter-new",
          criteria: { query: "from:a@example.com OR from:b@example.com OR from:c@example.com" },
          action: { addLabelIds: [NOISE_LABEL_ID], removeLabelIds: ["INBOX"] },
        },
      ];
      // Call 1: initial (1000 filters). Call 2: post-delete refresh (997). Call 3: verification (997 + consolidated).
      vi.mocked(client.listFilters)
        .mockResolvedValueOnce({ ok: true, value: existingFilters })
        .mockResolvedValueOnce({ ok: true, value: filtersAfterDeletes })
        .mockResolvedValueOnce({ ok: true, value: filtersAfterCreates });

      const result = await migrateFilters(client, DECISION_LOG_PATH, NOISE_LABEL_ID, {
        mode: "execute",
        deleteFirst: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.filtersDeleted).toBe(3);
      expect(result.value.filtersCreated).toBeGreaterThanOrEqual(1);

      // Verify all deletes happen before any create
      const firstCreateIndex = callOrder.indexOf("create");
      const lastDeleteIndex = callOrder.lastIndexOf("delete");
      expect(lastDeleteIndex).toBeLessThan(firstCreateIndex);

      // Snapshot should be cleaned up on success
      expect(fsMocks.unlinkCalls).toContain(snapshotPath);
    });

    // Test 2: Dry-run suppresses create-before-delete headroom error but checks projected headroom
    it("dry-run reports projected post-delete headroom without create-before-delete error", async () => {
      setupNoiseMocks(["noise@example.com"]);

      const existingFilters: gmail_v1.Schema$Filter[] = Array.from({ length: 1000 }, (_, index) =>
        index === 0
          ? makePerSenderFilter("f-noise", "noise@example.com", NOISE_LABEL_ID)
          : {
              id: `f-${index}`,
              criteria: { from: `other${index}@example.com` },
              action: { addLabelIds: ["label-other"] },
            },
      );

      const client = makeMockGmailClient({
        listFiltersResult: { ok: true, value: existingFilters },
      });

      const result = await migrateFilters(client, DECISION_LOG_PATH, NOISE_LABEL_ID, {
        mode: "dry-run",
        deleteFirst: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Should NOT have the create-before-delete headroom error
      expect(result.value.errors).toHaveLength(0);
      expect(result.value.filtersCreated).toBe(1);
      expect(result.value.filtersDeleted).toBe(1);
      // Dry-run should not call Gmail APIs or write snapshots
      expect(client.createFilter).not.toHaveBeenCalled();
      expect(client.deleteFilter).not.toHaveBeenCalled();
    });

    // Test 2b: Dry-run reuses snapshot remaining work instead of current decision log
    it("dry-run reuses an existing snapshot even when the decision log is unavailable", async () => {
      mockedCollectNoiseSenders.mockResolvedValueOnce({ ok: false, error: "decision log unavailable" });
      mockedReadDecisionLog.mockResolvedValueOnce({ ok: false, error: "corrupt log" });

      const frozenPlan: DeleteFirstPlan = {
        version: 1,
        strategy: "delete-first",
        createdAt: "2026-03-20T00:00:00Z",
        noiseLabelId: NOISE_LABEL_ID,
        deleteTargets: [
          { filterId: "f1", senderEmail: "a@example.com", kind: "legacy-noise" },
        ],
        createTargets: [
          {
            query: "from:a@example.com",
            senders: ["a@example.com"],
            removeLabelIds: ["INBOX"],
          },
        ],
      };
      fsMocks.files.set(snapshotPath, JSON.stringify(frozenPlan));

      const existingFilters: gmail_v1.Schema$Filter[] = [];
      const client = makeMockGmailClient({
        listFiltersResult: { ok: true, value: existingFilters },
      });

      const result = await migrateFilters(client, DECISION_LOG_PATH, NOISE_LABEL_ID, {
        mode: "dry-run",
        deleteFirst: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.filtersCreated).toBe(1);
      expect(result.value.filtersDeleted).toBe(0);
      expect(result.value.errors).toHaveLength(0);
      expect(mockedCollectNoiseSenders).not.toHaveBeenCalled();
      expect(mockedReadDecisionLog).not.toHaveBeenCalled();
    });

    it("dry-run uses the snapshot noise label id when checking remaining creates", async () => {
      const snapshotNoiseLabelId = "label-noise-snapshot";
      const currentNoiseLabelId = "label-noise-current";

      const frozenPlan: DeleteFirstPlan = {
        version: 1,
        strategy: "delete-first",
        createdAt: "2026-03-20T00:00:00Z",
        noiseLabelId: snapshotNoiseLabelId,
        deleteTargets: [],
        createTargets: [
          {
            query: "from:a@example.com",
            senders: ["a@example.com"],
            removeLabelIds: ["INBOX"],
          },
        ],
      };
      fsMocks.files.set(snapshotPath, JSON.stringify(frozenPlan));

      const existingFilters: gmail_v1.Schema$Filter[] = [
        {
          id: "f-existing-consolidated",
          criteria: { query: "from:a@example.com" },
          action: { addLabelIds: [snapshotNoiseLabelId], removeLabelIds: ["INBOX"] },
        },
      ];

      const client = makeMockGmailClient({
        listFiltersResult: { ok: true, value: existingFilters },
      });

      const result = await migrateFilters(client, DECISION_LOG_PATH, currentNoiseLabelId, {
        mode: "dry-run",
        deleteFirst: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.filtersCreated).toBe(0);
      expect(result.value.filtersDeleted).toBe(0);
      expect(result.value.errors).toHaveLength(0);
    });

    // Test 3: Resume after all deletes but before creates — rerun loads snapshot
    it("resumes from snapshot when legacy per-sender filters are already deleted even if the decision log is unavailable", async () => {
      mockedCollectNoiseSenders.mockResolvedValueOnce({ ok: false, error: "decision log unavailable" });
      mockedReadDecisionLog.mockResolvedValueOnce({ ok: false, error: "corrupt log" });

      // Pre-seed a snapshot (as if previous run deleted filters but crashed before creates)
      const frozenPlan: DeleteFirstPlan = {
        version: 1,
        strategy: "delete-first",
        createdAt: "2026-03-20T00:00:00Z",
        noiseLabelId: NOISE_LABEL_ID,
        deleteTargets: [
          { filterId: "f1", senderEmail: "a@example.com", kind: "legacy-noise" },
          { filterId: "f2", senderEmail: "b@example.com", kind: "legacy-noise" },
        ],
        createTargets: [
          {
            query: "from:a@example.com OR from:b@example.com",
            senders: ["a@example.com", "b@example.com"],
            removeLabelIds: ["INBOX"],
          },
        ],
      };
      fsMocks.files.set(snapshotPath, JSON.stringify(frozenPlan));

      // Current Gmail state: per-sender filters already gone, no consolidated yet
      const remainingFilters: gmail_v1.Schema$Filter[] = Array.from({ length: 50 }, (_, i) => ({
        id: `f-unrelated-${i}`,
        criteria: { from: `other${i}@example.com` },
        action: { addLabelIds: ["label-other"] },
      }));

      const client = makeMockGmailClient({
        listFiltersResult: { ok: true, value: remainingFilters },
      });
      // Second listFilters call (post-delete refresh) returns same since no deletes needed
      // Third listFilters call (verification) returns filters + the new consolidated
      vi.mocked(client.listFilters)
        .mockResolvedValueOnce({ ok: true, value: remainingFilters })
        .mockResolvedValueOnce({ ok: true, value: remainingFilters })
        .mockResolvedValueOnce({
          ok: true,
          value: [
            ...remainingFilters,
            {
              id: "filter-new-1",
              criteria: { query: "from:a@example.com OR from:b@example.com" },
              action: { addLabelIds: [NOISE_LABEL_ID], removeLabelIds: ["INBOX"] },
            },
          ],
        });

      const result = await migrateFilters(client, DECISION_LOG_PATH, NOISE_LABEL_ID, {
        mode: "execute",
        deleteFirst: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Should have created the consolidated filter from the frozen plan
      expect(result.value.filtersCreated).toBe(1);
      // No filters to delete (already gone)
      expect(result.value.filtersDeleted).toBe(0);
      expect(mockedCollectNoiseSenders).not.toHaveBeenCalled();
      expect(mockedReadDecisionLog).not.toHaveBeenCalled();
      // Snapshot should be cleaned up
      expect(fsMocks.unlinkCalls).toContain(snapshotPath);
    });

    // Test 4: Resume after partial creates — skips already-existing, creates missing
    it("on resume, uses the snapshot noise label id to skip already-existing consolidated filters and create only missing ones", async () => {
      setupNoiseMocks(["a@example.com", "b@example.com", "c@example.com"]);
      const snapshotNoiseLabelId = "label-noise-snapshot";
      const currentNoiseLabelId = "label-noise-current";

      // Snapshot with 2 create targets, one already satisfied
      const frozenPlan: DeleteFirstPlan = {
        version: 1,
        strategy: "delete-first",
        createdAt: "2026-03-20T00:00:00Z",
        noiseLabelId: snapshotNoiseLabelId,
        deleteTargets: [
          { filterId: "f1", senderEmail: "a@example.com", kind: "legacy-noise" },
          { filterId: "f2", senderEmail: "b@example.com", kind: "legacy-noise" },
          { filterId: "f3", senderEmail: "c@example.com", kind: "legacy-noise" },
        ],
        createTargets: [
          {
            query: "from:a@example.com OR from:b@example.com",
            senders: ["a@example.com", "b@example.com"],
            removeLabelIds: ["INBOX"],
          },
          {
            query: "from:c@example.com",
            senders: ["c@example.com"],
            removeLabelIds: ["INBOX"],
          },
        ],
      };
      fsMocks.files.set(snapshotPath, JSON.stringify(frozenPlan));

      // Gmail state: first consolidated already exists, per-sender already gone
      const existingConsolidated = {
        id: "f-existing-consolidated",
        criteria: { query: "from:a@example.com OR from:b@example.com" },
        action: { addLabelIds: [snapshotNoiseLabelId], removeLabelIds: ["INBOX"] },
      };
      const filtersAfterCreate = [
        existingConsolidated,
        {
          id: "filter-new-1",
          criteria: { query: "from:c@example.com" },
          action: { addLabelIds: [snapshotNoiseLabelId], removeLabelIds: ["INBOX"] },
        },
      ];

      const client = makeMockGmailClient({
        listFiltersResult: { ok: true, value: [existingConsolidated] },
      });
      vi.mocked(client.listFilters)
        .mockResolvedValueOnce({ ok: true, value: [existingConsolidated] })
        .mockResolvedValueOnce({ ok: true, value: [existingConsolidated] })
        .mockResolvedValueOnce({ ok: true, value: filtersAfterCreate });

      const result = await migrateFilters(client, DECISION_LOG_PATH, currentNoiseLabelId, {
        mode: "execute",
        deleteFirst: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Only 1 new filter created (the other already existed)
      expect(result.value.filtersCreated).toBe(1);
      expect(client.createFilter).toHaveBeenCalledTimes(1);
      expect(client.createFilter).toHaveBeenCalledWith(
        { query: "from:c@example.com" },
        { addLabelIds: [snapshotNoiseLabelId], removeLabelIds: ["INBOX"] },
      );
      // Snapshot cleaned up
      expect(fsMocks.unlinkCalls).toContain(snapshotPath);
    });

    // Test 5: Already-missing delete target is treated as resolved on rerun
    it("treats already-missing delete targets as resolved without error", async () => {
      setupNoiseMocks(["a@example.com"]);

      const frozenPlan: DeleteFirstPlan = {
        version: 1,
        strategy: "delete-first",
        createdAt: "2026-03-20T00:00:00Z",
        noiseLabelId: NOISE_LABEL_ID,
        deleteTargets: [
          { filterId: "f-already-gone", senderEmail: "a@example.com", kind: "legacy-noise" },
        ],
        createTargets: [
          {
            query: "from:a@example.com",
            senders: ["a@example.com"],
            removeLabelIds: ["INBOX"],
          },
        ],
      };
      fsMocks.files.set(snapshotPath, JSON.stringify(frozenPlan));

      // Gmail: the filter is already gone
      const filtersWithConsolidated = [
        {
          id: "filter-new-1",
          criteria: { query: "from:a@example.com" },
          action: { addLabelIds: [NOISE_LABEL_ID], removeLabelIds: ["INBOX"] },
        },
      ];
      const client = makeMockGmailClient({
        listFiltersResult: { ok: true, value: [] },
      });
      vi.mocked(client.listFilters)
        .mockResolvedValueOnce({ ok: true, value: [] })
        .mockResolvedValueOnce({ ok: true, value: [] })
        .mockResolvedValueOnce({ ok: true, value: filtersWithConsolidated });

      const result = await migrateFilters(client, DECISION_LOG_PATH, NOISE_LABEL_ID, {
        mode: "execute",
        deleteFirst: true,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // No deletes attempted (target not in current filters)
      expect(client.deleteFilter).not.toHaveBeenCalled();
      // Consolidated filter created
      expect(result.value.filtersCreated).toBe(1);
      expect(result.value.errors).toHaveLength(0);
    });

    // Test 6: Create failure after delete returns ok: false and leaves snapshot
    it("returns ok: false when create fails after deletes, keeping snapshot for retry", async () => {
      setupNoiseMocks(["a@example.com"]);

      const existingFilters = [
        makePerSenderFilter("f1", "a@example.com", NOISE_LABEL_ID),
      ];

      const client = makeMockGmailClient({
        listFiltersResult: { ok: true, value: existingFilters },
        createFilterResult: { ok: false, error: "API quota exceeded" },
      });
      // After deletes, no per-sender filters remain
      vi.mocked(client.listFilters)
        .mockResolvedValueOnce({ ok: true, value: existingFilters })
        .mockResolvedValueOnce({ ok: true, value: [] })
        .mockResolvedValueOnce({ ok: true, value: [] });

      const result = await migrateFilters(client, DECISION_LOG_PATH, NOISE_LABEL_ID, {
        mode: "execute",
        deleteFirst: true,
      });

      // Should fail because create failed — coverage gap
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("API quota exceeded");
      // Snapshot should NOT be deleted — needed for resume
      expect(fsMocks.unlinkCalls).not.toContain(snapshotPath);
      // Snapshot should exist on disk
      expect(fsMocks.files.has(snapshotPath)).toBe(true);
    });

    // Test 7: Snapshot is removed only after all targets are satisfied
    it("keeps snapshot when verification shows unsatisfied create targets", async () => {
      setupNoiseMocks(["a@example.com"]);

      const existingFilters = [
        makePerSenderFilter("f1", "a@example.com", NOISE_LABEL_ID),
      ];

      const client = makeMockGmailClient({
        listFiltersResult: { ok: true, value: existingFilters },
      });
      // After deletes, per-sender gone. After creates, verification shows
      // the consolidated filter somehow isn't there (eventual consistency edge case)
      vi.mocked(client.listFilters)
        .mockResolvedValueOnce({ ok: true, value: existingFilters })
        .mockResolvedValueOnce({ ok: true, value: [] })
        .mockResolvedValueOnce({ ok: true, value: [] }); // verification: empty!

      const result = await migrateFilters(client, DECISION_LOG_PATH, NOISE_LABEL_ID, {
        mode: "execute",
        deleteFirst: true,
      });

      // Should fail — verification found unsatisfied target
      expect(result.ok).toBe(false);
      // Snapshot preserved for retry
      expect(fsMocks.unlinkCalls).not.toContain(snapshotPath);
    });

    // Test 8: Corrupt snapshot is fatal
    it("returns fatal error for corrupt snapshot", async () => {
      setupNoiseMocks(["a@example.com"]);

      // Write invalid JSON to the snapshot path
      fsMocks.files.set(snapshotPath, "{ not valid json !!!");

      const client = makeMockGmailClient({
        listFiltersResult: { ok: true, value: [] },
      });

      const result = await migrateFilters(client, DECISION_LOG_PATH, NOISE_LABEL_ID, {
        mode: "execute",
        deleteFirst: true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("snapshot");
      // No Gmail mutations should have been attempted
      expect(client.createFilter).not.toHaveBeenCalled();
      expect(client.deleteFilter).not.toHaveBeenCalled();
    });

    // Test 9: Parseable but malformed snapshot is also fatal
    it("returns fatal error for a parseable but malformed snapshot", async () => {
      fsMocks.files.set(
        snapshotPath,
        JSON.stringify({
          version: 1,
          strategy: "delete-first",
          createdAt: "2026-03-20T00:00:00Z",
          noiseLabelId: NOISE_LABEL_ID,
          deleteTargets: [{}],
          createTargets: [{}],
        }),
      );

      const client = makeMockGmailClient({
        listFiltersResult: { ok: true, value: [] },
      });

      const result = await migrateFilters(client, DECISION_LOG_PATH, NOISE_LABEL_ID, {
        mode: "execute",
        deleteFirst: true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("invalid structure");
      expect(client.createFilter).not.toHaveBeenCalled();
      expect(client.deleteFilter).not.toHaveBeenCalled();
    });
  });
});
