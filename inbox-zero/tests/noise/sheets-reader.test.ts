/**
 * sheets-reader.test.ts
 *
 * Tests for readDecisions(). Mocks at the SheetsClient interface level.
 */

import { describe, expect, it, vi } from "vitest";
import type { SheetsClient } from "../../src/auth/sheets-client.js";

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import { readDecisions, type UserDecision } from "../../src/noise/sheets-reader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal mock SheetsClient with a configurable readRows response.
 */
function makeMockSheetsClient(rows: unknown[][]): SheetsClient {
  return {
    readRows: vi.fn().mockResolvedValue({ ok: true, value: rows }),
    createSpreadsheet: vi.fn(),
    writeRows: vi.fn(),
    formatSheet: vi.fn(),
  };
}

/**
 * Creates a mock SheetsClient that returns an error from readRows.
 */
function makeMockSheetsClientError(error: string): SheetsClient {
  return {
    readRows: vi.fn().mockResolvedValue({ ok: false, error }),
    createSpreadsheet: vi.fn(),
    writeRows: vi.fn(),
    formatSheet: vi.fn(),
  };
}

/** Minimal header row matching the audit sheet spec (13 columns). */
const HEADER_ROW = [
  "Sender email",
  "Sender name",
  "Email count",
  "First email date",
  "Last email date",
  "Gmail category",
  "Unread ratio",
  "Thread count",
  "Sample subjects",
  "Confidence tier",
  "Recommended action",
  "Surprises flag",
  "Your decision",
];

// ---------------------------------------------------------------------------
// readDecisions — basic parsing
// ---------------------------------------------------------------------------

describe("readDecisions() — basic parsing", () => {
  it("returns a Map with sender → decision for filled rows", async () => {
    const client = makeMockSheetsClient([
      HEADER_ROW,
      ["newsletter@example.com", "", "", "", "", "", "", "", "", "", "", "", "keep"],
      ["promo@example.com", "", "", "", "", "", "", "", "", "", "", "", "filter"],
      ["spam@example.com", "", "", "", "", "", "", "", "", "", "", "", "unsubscribe"],
    ]);

    const result = await readDecisions(client, "spreadsheet-001");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value.size).toBe(3);
    expect(result.value.get("newsletter@example.com")).toBe("keep");
    expect(result.value.get("promo@example.com")).toBe("filter");
    expect(result.value.get("spam@example.com")).toBe("unsubscribe");
  });

  it("skips rows where decision column is empty string", async () => {
    const client = makeMockSheetsClient([
      HEADER_ROW,
      ["newsletter@example.com", "", "", "", "", "", "", "", "", "", "", "", "keep"],
      ["nodecision@example.com", "", "", "", "", "", "", "", "", "", "", "", ""],
    ]);

    const result = await readDecisions(client, "spreadsheet-001");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value.size).toBe(1);
    expect(result.value.has("nodecision@example.com")).toBe(false);
  });

  it("skips rows where decision column is missing (short row)", async () => {
    const client = makeMockSheetsClient([
      HEADER_ROW,
      ["newsletter@example.com", "", "", "", "", "", "", "", "", "", "", "", "keep"],
      ["short@example.com"], // row too short to have column 12
    ]);

    const result = await readDecisions(client, "spreadsheet-001");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value.size).toBe(1);
    expect(result.value.has("short@example.com")).toBe(false);
  });

  it("skips the header row (row 0)", async () => {
    const client = makeMockSheetsClient([
      HEADER_ROW,
      ["sender@example.com", "", "", "", "", "", "", "", "", "", "", "", "keep"],
    ]);

    const result = await readDecisions(client, "spreadsheet-001");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    // Only the data row should be in the map, not the header
    expect(result.value.has("Sender email")).toBe(false);
    expect(result.value.has("sender@example.com")).toBe(true);
  });

  it("returns an empty Map when only header row exists", async () => {
    const client = makeMockSheetsClient([HEADER_ROW]);

    const result = await readDecisions(client, "spreadsheet-001");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value.size).toBe(0);
  });

  it("returns an empty Map when sheet is completely empty", async () => {
    const client = makeMockSheetsClient([]);

    const result = await readDecisions(client, "spreadsheet-001");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// readDecisions — case-insensitive parsing
// ---------------------------------------------------------------------------

describe("readDecisions() — case-insensitive parsing", () => {
  it("parses 'Keep' (title case) as 'keep'", async () => {
    const client = makeMockSheetsClient([
      HEADER_ROW,
      ["a@example.com", "", "", "", "", "", "", "", "", "", "", "", "Keep"],
    ]);

    const result = await readDecisions(client, "spreadsheet-001");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value.get("a@example.com")).toBe("keep");
  });

  it("parses 'KEEP' (upper case) as 'keep'", async () => {
    const client = makeMockSheetsClient([
      HEADER_ROW,
      ["a@example.com", "", "", "", "", "", "", "", "", "", "", "", "KEEP"],
    ]);

    const result = await readDecisions(client, "spreadsheet-001");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value.get("a@example.com")).toBe("keep");
  });

  it("parses 'FILTER' (upper case) as 'filter'", async () => {
    const client = makeMockSheetsClient([
      HEADER_ROW,
      ["b@example.com", "", "", "", "", "", "", "", "", "", "", "", "FILTER"],
    ]);

    const result = await readDecisions(client, "spreadsheet-001");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value.get("b@example.com")).toBe("filter");
  });

  it("parses 'Unsubscribe' (mixed case) as 'unsubscribe'", async () => {
    const client = makeMockSheetsClient([
      HEADER_ROW,
      ["c@example.com", "", "", "", "", "", "", "", "", "", "", "", "Unsubscribe"],
    ]);

    const result = await readDecisions(client, "spreadsheet-001");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value.get("c@example.com")).toBe("unsubscribe");
  });
});

// ---------------------------------------------------------------------------
// readDecisions — invalid decision values
// ---------------------------------------------------------------------------

describe("readDecisions() — invalid decision values", () => {
  it("returns { ok: false, error } for an unrecognized decision value", async () => {
    const client = makeMockSheetsClient([
      HEADER_ROW,
      ["a@example.com", "", "", "", "", "", "", "", "", "", "", "", "delete"],
    ]);

    const result = await readDecisions(client, "spreadsheet-001");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");
    expect(result.error).toContain("delete");
    expect(result.error).toContain("a@example.com");
  });

  it("includes row number in error message for invalid decision", async () => {
    const client = makeMockSheetsClient([
      HEADER_ROW,
      ["valid@example.com", "", "", "", "", "", "", "", "", "", "", "", "keep"],
      ["bad@example.com", "", "", "", "", "", "", "", "", "", "", "", "archive"],
    ]);

    const result = await readDecisions(client, "spreadsheet-001");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");
    expect(result.error).toContain("archive");
    expect(result.error).toContain("bad@example.com");
  });
});

// ---------------------------------------------------------------------------
// readDecisions — SheetsClient errors
// ---------------------------------------------------------------------------

describe("readDecisions() — SheetsClient errors", () => {
  it("propagates { ok: false } from SheetsClient.readRows()", async () => {
    const client = makeMockSheetsClientError("Permission denied");

    const result = await readDecisions(client, "spreadsheet-001");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");
    expect(result.error).toContain("Permission denied");
  });

  it("passes the spreadsheetId to readRows", async () => {
    const client = makeMockSheetsClient([HEADER_ROW]);

    await readDecisions(client, "my-spreadsheet-id-123");

    expect(client.readRows).toHaveBeenCalledWith("my-spreadsheet-id-123", expect.any(String));
  });
});

// ---------------------------------------------------------------------------
// Type guard — UserDecision
// ---------------------------------------------------------------------------

describe("UserDecision type", () => {
  it("covers keep, filter, and unsubscribe values", () => {
    const decisions: UserDecision[] = ["keep", "filter", "unsubscribe"];
    expect(decisions).toHaveLength(3);
  });
});
