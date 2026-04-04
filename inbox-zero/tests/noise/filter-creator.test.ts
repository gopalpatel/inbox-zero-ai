/**
 * filter-creator.test.ts
 *
 * Tests for createFilter(), ensureNoiseLabel(), and batchCreateFilters().
 * Mocks at the GmailClient interface level.
 */

import type { gmail_v1 } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import type { GmailClient } from "../../src/auth/gmail-client.js";

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import {
  batchCreateFilters,
  createNoiseFilter,
  ensureNoiseLabel,
  findNoiseLabelId,
  NOISE_LABEL_NAME,
} from "../../src/noise/filter-creator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal mock GmailClient with configurable return values.
 */
function makeMockGmailClient(
  overrides: {
    listLabels?: gmail_v1.Schema$Label[];
    createLabel?: gmail_v1.Schema$Label;
    createFilter?: gmail_v1.Schema$Filter;
    listLabelsError?: string;
    createLabelError?: string;
    createFilterError?: string;
  } = {},
): GmailClient {
  const listLabelsResult = overrides.listLabelsError
    ? { ok: false as const, error: overrides.listLabelsError }
    : { ok: true as const, value: overrides.listLabels ?? [] };

  const createLabelResult = overrides.createLabelError
    ? { ok: false as const, error: overrides.createLabelError }
    : {
        ok: true as const,
        value: overrides.createLabel ?? { id: "label-noise-001", name: NOISE_LABEL_NAME },
      };

  const createFilterResult = overrides.createFilterError
    ? { ok: false as const, error: overrides.createFilterError }
    : {
        ok: true as const,
        value: overrides.createFilter ?? { id: "filter-001", criteria: {}, action: {} },
      };

  return {
    getProfile: vi.fn(),
    listMessages: vi.fn(),
    getMessage: vi.fn(),
    batchModifyMessages: vi.fn(),
    listLabels: vi.fn().mockResolvedValue(listLabelsResult),
    listFilters: vi.fn(),
    createLabel: vi.fn().mockResolvedValue(createLabelResult),
    createFilter: vi.fn().mockResolvedValue(createFilterResult),
  };
}

// ---------------------------------------------------------------------------
// findNoiseLabelId
// ---------------------------------------------------------------------------

describe("findNoiseLabelId()", () => {
  it("returns the existing _noise label id without creating anything", async () => {
    const client = makeMockGmailClient({
      listLabels: [
        { id: "label-existing-001", name: NOISE_LABEL_NAME },
        { id: "label-other", name: "other" },
      ],
    });

    const result = await findNoiseLabelId(client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value).toBe("label-existing-001");
    expect(client.createLabel).not.toHaveBeenCalled();
  });

  it("returns null when the _noise label does not exist", async () => {
    const client = makeMockGmailClient({
      listLabels: [{ id: "label-other", name: "other" }],
    });

    const result = await findNoiseLabelId(client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value).toBeNull();
  });

  it("propagates listLabels failures", async () => {
    const client = makeMockGmailClient({
      listLabelsError: "API quota exceeded",
    });

    const result = await findNoiseLabelId(client);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");
    expect(result.error).toContain("API quota exceeded");
  });
});

// ---------------------------------------------------------------------------
// ensureNoiseLabel
// ---------------------------------------------------------------------------

describe("ensureNoiseLabel()", () => {
  it("creates _noise label if it does not exist and returns its ID", async () => {
    const client = makeMockGmailClient({
      listLabels: [],
      createLabel: { id: "label-new-001", name: NOISE_LABEL_NAME },
    });

    const result = await ensureNoiseLabel(client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value).toBe("label-new-001");
    expect(client.createLabel).toHaveBeenCalledWith(NOISE_LABEL_NAME);
  });

  it("returns existing label ID without creating if _noise already exists", async () => {
    const client = makeMockGmailClient({
      listLabels: [
        { id: "label-existing-001", name: NOISE_LABEL_NAME },
        { id: "label-other", name: "other" },
      ],
    });

    const result = await ensureNoiseLabel(client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value).toBe("label-existing-001");
    expect(client.createLabel).not.toHaveBeenCalled();
  });

  it("is case-sensitive for label name matching", async () => {
    const client = makeMockGmailClient({
      listLabels: [{ id: "label-wrong-case", name: "_NOISE" }],
      createLabel: { id: "label-new-002", name: NOISE_LABEL_NAME },
    });

    const result = await ensureNoiseLabel(client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    // Should create a new one since "_NOISE" !== "_noise"
    expect(client.createLabel).toHaveBeenCalledWith(NOISE_LABEL_NAME);
  });

  it("propagates { ok: false } when listLabels fails", async () => {
    const client = makeMockGmailClient({
      listLabelsError: "API quota exceeded",
    });

    const result = await ensureNoiseLabel(client);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");
    expect(result.error).toContain("API quota exceeded");
  });

  it("propagates { ok: false } when createLabel fails", async () => {
    const client = makeMockGmailClient({
      listLabels: [],
      createLabelError: "Insufficient permissions",
    });

    const result = await ensureNoiseLabel(client);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");
    expect(result.error).toContain("Insufficient permissions");
  });

  it("handles labels with missing id by skipping them", async () => {
    const client = makeMockGmailClient({
      listLabels: [
        { id: undefined, name: NOISE_LABEL_NAME }, // id is missing
      ],
      createLabel: { id: "label-new-003", name: NOISE_LABEL_NAME },
    });

    const result = await ensureNoiseLabel(client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    // Should create since existing label has no id
    expect(client.createLabel).toHaveBeenCalled();
  });

  it("returns empty string labelId when createLabel returns a label without id", async () => {
    const client = makeMockGmailClient({
      listLabels: [],
      createLabel: { name: NOISE_LABEL_NAME }, // id missing from API response
    });

    const result = await ensureNoiseLabel(client);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    // Empty string from the ?? "" fallback
    expect(result.value).toBe("");
  });
});

// ---------------------------------------------------------------------------
// batchCreateFilters with missing label ID
// ---------------------------------------------------------------------------

describe("batchCreateFilters() — missing label ID from ensureNoiseLabel", () => {
  it("passes empty labelId to createFilter when ensureNoiseLabel returns label without id", async () => {
    // Simulate ensureNoiseLabel returning empty string via createLabel returning no id
    const client = makeMockGmailClient({
      listLabels: [],
      createLabel: { name: NOISE_LABEL_NAME }, // no id field
    });

    const senders = new Map<string, "filter" | "unsubscribe">([["a@example.com", "filter"]]);

    const result = await batchCreateFilters(client, senders);

    // createFilter is still called — the empty labelId is passed through.
    // This means the filter is created with an empty label ID, which
    // would be an invalid Gmail filter. The test documents this behavior.
    expect(client.createFilter).toHaveBeenCalledTimes(1);
    const callArgs = (client.createFilter as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const action = callArgs[1] as { addLabelIds?: string[] };
    // The empty string labelId gets passed through
    expect(action.addLabelIds).toContain("");
    expect(result.created).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createNoiseFilter
// ---------------------------------------------------------------------------

describe("createNoiseFilter()", () => {
  it("calls Gmail API with from: criteria for the given sender", async () => {
    const client = makeMockGmailClient({
      createFilter: { id: "filter-001" },
    });

    await createNoiseFilter(client, "newsletter@example.com", "filter", "label-noise-001");

    expect(client.createFilter).toHaveBeenCalledWith({ from: "newsletter@example.com" }, expect.any(Object));
  });

  it("filter action: skips inbox and applies _noise label (no mark-as-read)", async () => {
    const client = makeMockGmailClient({
      createFilter: { id: "filter-001" },
    });

    await createNoiseFilter(client, "promo@example.com", "filter", "label-noise-001");

    const callArgs = (client.createFilter as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const action = callArgs[1] as { addLabelIds?: string[]; removeLabelIds?: string[] };

    expect(action.addLabelIds).toContain("label-noise-001");
    expect(action.removeLabelIds).toContain("INBOX");
    // Should NOT mark as read for 'filter' decision
    expect(action.removeLabelIds).not.toContain("UNREAD");
  });

  it("unsubscribe action: skips inbox, applies _noise label, AND marks as read", async () => {
    const client = makeMockGmailClient({
      createFilter: { id: "filter-001" },
    });

    await createNoiseFilter(client, "spam@example.com", "unsubscribe", "label-noise-001");

    const callArgs = (client.createFilter as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const action = callArgs[1] as { addLabelIds?: string[]; removeLabelIds?: string[] };

    expect(action.addLabelIds).toContain("label-noise-001");
    expect(action.removeLabelIds).toContain("INBOX");
    expect(action.removeLabelIds).toContain("UNREAD");
  });

  it("returns { ok: true, value: filter } on success", async () => {
    const client = makeMockGmailClient({
      createFilter: { id: "filter-999", criteria: { from: "a@example.com" }, action: {} },
    });

    const result = await createNoiseFilter(client, "a@example.com", "filter", "label-noise-001");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value.id).toBe("filter-999");
  });

  it("propagates { ok: false } when createFilter fails", async () => {
    const client = makeMockGmailClient({
      createFilterError: "Filter limit reached",
    });

    const result = await createNoiseFilter(client, "a@example.com", "filter", "label-noise-001");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");
    expect(result.error).toContain("Filter limit reached");
  });
});

// ---------------------------------------------------------------------------
// batchCreateFilters
// ---------------------------------------------------------------------------

describe("batchCreateFilters()", () => {
  it("returns { created: N, failures: [] } when all succeed", async () => {
    const client = makeMockGmailClient({
      listLabels: [{ id: "label-noise-001", name: NOISE_LABEL_NAME }],
    });

    const senders = new Map<string, "filter" | "unsubscribe">([
      ["a@example.com", "filter"],
      ["b@example.com", "unsubscribe"],
      ["c@example.com", "filter"],
    ]);

    const result = await batchCreateFilters(client, senders);

    expect(result.created).toBe(3);
    expect(result.failures).toHaveLength(0);
    expect(client.createFilter).toHaveBeenCalledTimes(3);
  });

  it("handles partial failures: counts created and records failures", async () => {
    const client = makeMockGmailClient({
      listLabels: [{ id: "label-noise-001", name: NOISE_LABEL_NAME }],
    });

    // Make createFilter fail for the second call
    const createFilterMock = client.createFilter as ReturnType<typeof vi.fn>;
    createFilterMock
      .mockResolvedValueOnce({ ok: true, value: { id: "filter-001" } })
      .mockResolvedValueOnce({ ok: false, error: "Rate limited" })
      .mockResolvedValueOnce({ ok: true, value: { id: "filter-003" } });

    const senders = new Map<string, "filter" | "unsubscribe">([
      ["a@example.com", "filter"],
      ["b@example.com", "filter"],
      ["c@example.com", "filter"],
    ]);

    const result = await batchCreateFilters(client, senders);

    expect(result.created).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.sender).toBe("b@example.com");
    expect(result.failures[0]!.error).toContain("Rate limited");
  });

  it("returns created: 0 and records failure for each sender when ensureNoiseLabel fails", async () => {
    const client = makeMockGmailClient({
      listLabelsError: "Cannot list labels",
    });

    const senders = new Map<string, "filter" | "unsubscribe">([["a@example.com", "filter"]]);

    const result = await batchCreateFilters(client, senders);

    expect(result.created).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.sender).toBe("a@example.com");
    expect(result.failures[0]!.error).toContain("Cannot list labels");
  });

  it("returns { created: 0, failures: [] } for empty senders map", async () => {
    const client = makeMockGmailClient({
      listLabels: [{ id: "label-noise-001", name: NOISE_LABEL_NAME }],
    });

    const result = await batchCreateFilters(client, new Map());

    expect(result.created).toBe(0);
    expect(result.failures).toHaveLength(0);
    expect(client.createFilter).not.toHaveBeenCalled();
  });

  it("dry-run mode: does not call createFilter but logs", async () => {
    const client = makeMockGmailClient({
      listLabels: [{ id: "label-noise-001", name: NOISE_LABEL_NAME }],
    });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const senders = new Map<string, "filter" | "unsubscribe">([
        ["a@example.com", "filter"],
        ["b@example.com", "unsubscribe"],
      ]);

      const result = await batchCreateFilters(client, senders, { dryRun: true });

      expect(result.created).toBe(0);
      expect(result.failures).toHaveLength(0);
      expect(client.createFilter).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("only processes senders with 'filter' or 'unsubscribe' decisions (not 'keep')", async () => {
    const client = makeMockGmailClient({
      listLabels: [{ id: "label-noise-001", name: NOISE_LABEL_NAME }],
    });

    // The Map type constrains to filter | unsubscribe, so this test validates
    // the function only processes those types (Map<string, "filter" | "unsubscribe">)
    const senders = new Map<string, "filter" | "unsubscribe">([
      ["a@example.com", "filter"],
      ["b@example.com", "unsubscribe"],
    ]);

    const result = await batchCreateFilters(client, senders);

    expect(result.created).toBe(2);
    expect(client.createFilter).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("NOISE_LABEL_NAME constant", () => {
  it("is '_noise'", () => {
    expect(NOISE_LABEL_NAME).toBe("_noise");
  });
});
