import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_HEADER_ROW, createAuditReport } from "../../src/analysis/sheets-reporter.js";
import type { SheetsClient } from "../../src/auth/sheets-client.js";
import type { SenderStats } from "../../src/schemas/sender-stats.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a fully-populated SenderStats object for testing. */
function makeSenderStats(overrides: Partial<SenderStats> = {}): SenderStats {
  return {
    senderEmail: "newsletter@example.com",
    senderName: "Example Newsletter",
    emailCount: 42,
    firstEmailDate: "2023-01-15",
    lastEmailDate: "2024-06-20",
    gmailCategory: "promotions",
    unreadRatio: 0.85,
    threadCount: 10,
    sampleSubjects: ["Big Sale", "Weekly Digest", "Exclusive Offer"],
    confidenceTier: "probably_noise",
    recommendedAction: "filter",
    surprisesFlag: false,
    userDecision: null,
    ...overrides,
  };
}

/** Creates a mock SheetsClient that records all calls for assertions. */
function makeMockSheetsClient(
  opts: { spreadsheetId?: string; createError?: string; writeRowsError?: string; formatError?: string } = {},
): SheetsClient {
  const spreadsheetId = opts.spreadsheetId ?? "test-sheet-id-001";
  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  return {
    createSpreadsheet: vi.fn().mockImplementation(() => {
      if (opts.createError) {
        return Promise.resolve({ ok: false, error: opts.createError });
      }
      return Promise.resolve({ ok: true, value: { spreadsheetId, spreadsheetUrl } });
    }),
    writeRows: vi.fn().mockImplementation(() => {
      if (opts.writeRowsError) {
        return Promise.resolve({ ok: false, error: opts.writeRowsError });
      }
      return Promise.resolve({ ok: true, value: undefined });
    }),
    readRows: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    formatSheet: vi.fn().mockImplementation(() => {
      if (opts.formatError) {
        return Promise.resolve({ ok: false, error: opts.formatError });
      }
      return Promise.resolve({ ok: true, value: undefined });
    }),
  };
}

// ---------------------------------------------------------------------------
// AUDIT_HEADER_ROW — exported constant tests
// ---------------------------------------------------------------------------

describe("AUDIT_HEADER_ROW", () => {
  it("has exactly 16 columns", () => {
    expect(AUDIT_HEADER_ROW).toHaveLength(16);
  });

  it("matches the spec columns in exact order", () => {
    expect(AUDIT_HEADER_ROW).toEqual([
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
      "Sender type",
      "Extraction candidate",
      "Processed",
    ]);
  });

  it("columns 14-16 are Sender type, Extraction candidate, Processed", () => {
    expect(AUDIT_HEADER_ROW[13]).toBe("Sender type");
    expect(AUDIT_HEADER_ROW[14]).toBe("Extraction candidate");
    expect(AUDIT_HEADER_ROW[15]).toBe("Processed");
  });
});

// ---------------------------------------------------------------------------
// createAuditReport — spreadsheet creation
// ---------------------------------------------------------------------------

describe("createAuditReport() — spreadsheet creation", () => {
  let mockClient: SheetsClient;

  beforeEach(() => {
    mockClient = makeMockSheetsClient({ spreadsheetId: "test-sheet-id-001" });
  });

  it("calls createSpreadsheet with a title in 'Gmail Audit — YYYY-MM-DD' format", async () => {
    await createAuditReport([], mockClient);
    expect(mockClient.createSpreadsheet).toHaveBeenCalledTimes(1);
    const title = (mockClient.createSpreadsheet as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(title).toMatch(/^Gmail Audit — \d{4}-\d{2}-\d{2}$/);
  });

  it("uses a custom title when provided", async () => {
    await createAuditReport([], mockClient, "My Custom Title");
    const title = (mockClient.createSpreadsheet as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(title).toBe("My Custom Title");
  });

  it("returns { spreadsheetId, spreadsheetUrl } on success", async () => {
    const result = await createAuditReport([], mockClient);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value.spreadsheetId).toBe("test-sheet-id-001");
    expect(result.value.spreadsheetUrl).toContain("test-sheet-id-001");
    expect(result.value.spreadsheetUrl).toContain("docs.google.com");
  });
});

// ---------------------------------------------------------------------------
// createAuditReport — header row
// ---------------------------------------------------------------------------

describe("createAuditReport() — header row", () => {
  let mockClient: SheetsClient;

  beforeEach(() => {
    mockClient = makeMockSheetsClient({ spreadsheetId: "header-test-id" });
  });

  it("writes the header row as the first writeRows call", async () => {
    await createAuditReport([], mockClient);
    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    expect(writeRowsCalls.length).toBeGreaterThanOrEqual(1);
    const firstCall = writeRowsCalls[0]!;
    // writeRows(spreadsheetId, range, values)
    const values = firstCall[2] as unknown[][];
    expect(values[0]).toEqual(Array.from(AUDIT_HEADER_ROW));
  });
});

// ---------------------------------------------------------------------------
// createAuditReport — data row formatting
// ---------------------------------------------------------------------------

describe("createAuditReport() — data row formatting", () => {
  let mockClient: SheetsClient;

  beforeEach(() => {
    mockClient = makeMockSheetsClient({ spreadsheetId: "data-test-id" });
  });

  it("writes data rows with correct column order matching header spec", async () => {
    const stats = makeSenderStats();
    await createAuditReport([stats], mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    // Find the data rows call (the call to Sheet1!A2)
    const dataCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Sheet1!A2");
    expect(dataCall).toBeDefined();
    const dataRow = (dataCall![2] as unknown[][])[0]!;

    expect(dataRow[0]).toBe("newsletter@example.com"); // Sender email
    expect(dataRow[1]).toBe("Example Newsletter"); // Sender name
    expect(dataRow[2]).toBe(42); // Email count
    expect(dataRow[3]).toBe("2023-01-15"); // First email date
    expect(dataRow[4]).toBe("2024-06-20"); // Last email date
    expect(dataRow[5]).toBe("promotions"); // Gmail category
    expect(dataRow[6]).toBe("85%"); // Unread ratio → percentage
    expect(dataRow[7]).toBe(10); // Thread count
    expect(dataRow[8]).toBe("Big Sale | Weekly Digest | Exclusive Offer"); // Subjects joined
    expect(dataRow[9]).toBe("probably_noise"); // Confidence tier
    expect(dataRow[10]).toBe("filter"); // Recommended action
    expect(dataRow[11]).toBe("No"); // Surprises flag → No
    expect(dataRow[12]).toBe(""); // Your decision (null → empty)
  });

  it("formats surprisesFlag=true as 'Yes'", async () => {
    const stats = makeSenderStats({ surprisesFlag: true });
    await createAuditReport([stats], mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dataCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Sheet1!A2");
    expect(dataCall).toBeDefined();
    const dataRow = (dataCall![2] as unknown[][])[0]!;
    expect(dataRow[11]).toBe("Yes");
  });

  it("formats unreadRatio as integer percentage string (e.g., 0.85 → '85%')", async () => {
    const stats = makeSenderStats({ unreadRatio: 0.33 });
    await createAuditReport([stats], mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dataCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Sheet1!A2");
    expect(dataCall).toBeDefined();
    const dataRow = (dataCall![2] as unknown[][])[0]!;
    expect(dataRow[6]).toBe("33%");
  });

  it("joins sampleSubjects with ' | ' separator", async () => {
    const stats = makeSenderStats({
      sampleSubjects: ["Subject A", "Subject B", "Subject C"],
    });
    await createAuditReport([stats], mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dataCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Sheet1!A2");
    expect(dataCall).toBeDefined();
    const dataRow = (dataCall![2] as unknown[][])[0]!;
    expect(dataRow[8]).toBe("Subject A | Subject B | Subject C");
  });

  it("formats empty sampleSubjects as empty string", async () => {
    const stats = makeSenderStats({ sampleSubjects: [] });
    await createAuditReport([stats], mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dataCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Sheet1!A2");
    expect(dataCall).toBeDefined();
    const dataRow = (dataCall![2] as unknown[][])[0]!;
    expect(dataRow[8]).toBe("");
  });

  it("formats userDecision=null as empty string", async () => {
    const stats = makeSenderStats({ userDecision: null });
    await createAuditReport([stats], mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dataCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Sheet1!A2");
    expect(dataCall).toBeDefined();
    const dataRow = (dataCall![2] as unknown[][])[0]!;
    expect(dataRow[12]).toBe("");
  });

  it("formats userDecision with a value as that value", async () => {
    const stats = makeSenderStats({ userDecision: "keep" });
    await createAuditReport([stats], mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dataCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Sheet1!A2");
    expect(dataCall).toBeDefined();
    const dataRow = (dataCall![2] as unknown[][])[0]!;
    expect(dataRow[12]).toBe("keep");
  });

  it("formats absent confidenceTier and recommendedAction as empty strings", async () => {
    const stats = makeSenderStats({
      confidenceTier: undefined,
      recommendedAction: undefined,
    });
    await createAuditReport([stats], mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dataCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Sheet1!A2");
    expect(dataCall).toBeDefined();
    const dataRow = (dataCall![2] as unknown[][])[0]!;
    expect(dataRow[9]).toBe("");
    expect(dataRow[10]).toBe("");
  });

  it("writes multiple stats as multiple data rows", async () => {
    const stats1 = makeSenderStats({ senderEmail: "a@example.com" });
    const stats2 = makeSenderStats({ senderEmail: "b@example.com" });
    await createAuditReport([stats1, stats2], mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dataCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Sheet1!A2");
    expect(dataCall).toBeDefined();
    const rows = dataCall![2] as unknown[][];
    expect(rows).toHaveLength(2);
    expect(rows[0]![0]).toBe("a@example.com");
    expect(rows[1]![0]).toBe("b@example.com");
  });
});

// ---------------------------------------------------------------------------
// createAuditReport — enrichment columns (14-16)
// ---------------------------------------------------------------------------

describe("createAuditReport() — enrichment columns", () => {
  let mockClient: SheetsClient;

  beforeEach(() => {
    mockClient = makeMockSheetsClient({ spreadsheetId: "enrich-test-id" });
  });

  it("emits 16-element data rows", async () => {
    const stats = makeSenderStats();
    await createAuditReport([stats], mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dataCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Sheet1!A2");
    expect(dataCall).toBeDefined();
    const dataRow = (dataCall![2] as unknown[][])[0]!;
    expect(dataRow).toHaveLength(16);
  });

  it("formats senderType in column 14 (index 13)", async () => {
    const stats = makeSenderStats({ senderType: "newsletter" });
    await createAuditReport([stats], mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dataCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Sheet1!A2");
    expect(dataCall).toBeDefined();
    const dataRow = (dataCall![2] as unknown[][])[0]!;
    expect(dataRow[13]).toBe("newsletter");
  });

  it("formats absent senderType as empty string in column 14", async () => {
    const stats = makeSenderStats({ senderType: undefined });
    await createAuditReport([stats], mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dataCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Sheet1!A2");
    expect(dataCall).toBeDefined();
    const dataRow = (dataCall![2] as unknown[][])[0]!;
    expect(dataRow[13]).toBe("");
  });

  it("formats extractionCandidate=true as 'Yes' in column 15 (index 14)", async () => {
    const stats = makeSenderStats({ extractionCandidate: true });
    await createAuditReport([stats], mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dataCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Sheet1!A2");
    expect(dataCall).toBeDefined();
    const dataRow = (dataCall![2] as unknown[][])[0]!;
    expect(dataRow[14]).toBe("Yes");
  });

  it("formats extractionCandidate=false as 'No' in column 15", async () => {
    const stats = makeSenderStats({ extractionCandidate: false });
    await createAuditReport([stats], mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dataCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Sheet1!A2");
    expect(dataCall).toBeDefined();
    const dataRow = (dataCall![2] as unknown[][])[0]!;
    expect(dataRow[14]).toBe("No");
  });

  it("formats absent extractionCandidate as empty string in column 15", async () => {
    const stats = makeSenderStats({ extractionCandidate: undefined });
    await createAuditReport([stats], mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dataCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Sheet1!A2");
    expect(dataCall).toBeDefined();
    const dataRow = (dataCall![2] as unknown[][])[0]!;
    expect(dataRow[14]).toBe("");
  });

  it("emits empty string for Processed column 16 (index 15)", async () => {
    const stats = makeSenderStats();
    await createAuditReport([stats], mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dataCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Sheet1!A2");
    expect(dataCall).toBeDefined();
    const dataRow = (dataCall![2] as unknown[][])[0]!;
    expect(dataRow[15]).toBe("");
  });
});

// ---------------------------------------------------------------------------
// createAuditReport — Dashboard tab
// ---------------------------------------------------------------------------

describe("createAuditReport() — Dashboard tab", () => {
  let mockClient: SheetsClient;

  beforeEach(() => {
    mockClient = makeMockSheetsClient({ spreadsheetId: "dashboard-test-id" });
  });

  it("writes Dashboard metrics to Dashboard!A1:B7", async () => {
    const stats = [makeSenderStats({ senderEmail: "a@x.com" }), makeSenderStats({ senderEmail: "b@x.com" })];
    await createAuditReport(stats, mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dashCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Dashboard!A1:B7");
    expect(dashCall).toBeDefined();
    const rows = dashCall![2] as unknown[][];
    expect(rows).toHaveLength(7);
  });

  it("sets Total senders to the length of the stats array", async () => {
    const stats = [makeSenderStats({ senderEmail: "a@x.com" }), makeSenderStats({ senderEmail: "b@x.com" })];
    await createAuditReport(stats, mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dashCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Dashboard!A1:B7");
    expect(dashCall).toBeDefined();
    const rows = dashCall![2] as unknown[][];
    const totalSendersRow = rows[0]!;
    expect(totalSendersRow[0]).toBe("Total senders");
    expect(totalSendersRow[1]).toBe(2);
  });

  it("initialises Processed, Emails cleared, Unsubscribed, Filters created as 0", async () => {
    await createAuditReport([], mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dashCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Dashboard!A1:B7");
    expect(dashCall).toBeDefined();
    const rows = dashCall![2] as unknown[][];
    expect(rows[1]![0]).toBe("Processed");
    expect(rows[1]![1]).toBe(0);
    expect(rows[2]![0]).toBe("Emails cleared");
    expect(rows[2]![1]).toBe(0);
    expect(rows[3]![0]).toBe("Unsubscribed");
    expect(rows[3]![1]).toBe(0);
    expect(rows[4]![0]).toBe("Filters created");
    expect(rows[4]![1]).toBe(0);
  });

  it("sets Remaining equal to Total senders initially", async () => {
    const stats = [makeSenderStats(), makeSenderStats({ senderEmail: "b@x.com" })];
    await createAuditReport(stats, mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dashCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Dashboard!A1:B7");
    expect(dashCall).toBeDefined();
    const rows = dashCall![2] as unknown[][];
    expect(rows[5]![0]).toBe("Remaining");
    expect(rows[5]![1]).toBe(2);
  });

  it("sets Current section to '—'", async () => {
    await createAuditReport([], mockClient);

    const writeRowsCalls = (mockClient.writeRows as ReturnType<typeof vi.fn>).mock.calls;
    const dashCall = writeRowsCalls.find((call: unknown[]) => call[1] === "Dashboard!A1:B7");
    expect(dashCall).toBeDefined();
    const rows = dashCall![2] as unknown[][];
    expect(rows[6]![0]).toBe("Current section");
    expect(rows[6]![1]).toBe("—");
  });

  it("includes an addSheet request for the Dashboard tab in formatSheet", async () => {
    await createAuditReport([], mockClient);

    const formatCall = (mockClient.formatSheet as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const requests = formatCall[1] as Array<Record<string, unknown>>;
    const addSheetRequest = requests.find((r) => "addSheet" in r);
    expect(addSheetRequest).toBeDefined();
    const addSheet = addSheetRequest!["addSheet"] as { properties: { title: string; sheetId: number } };
    expect(addSheet.properties.title).toBe("Dashboard");
    expect(addSheet.properties.sheetId).toBe(1);
  });

  it("includes a repeatCell request to bold the Dashboard labels column", async () => {
    await createAuditReport([], mockClient);

    const formatCall = (mockClient.formatSheet as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const requests = formatCall[1] as Array<Record<string, unknown>>;
    const dashboardRepeat = requests.find((request) => {
      if (!("repeatCell" in request)) return false;
      const repeatCell = request["repeatCell"] as { range?: { sheetId?: number; startColumnIndex?: number; endColumnIndex?: number } };
      return repeatCell.range?.sheetId === 1 && repeatCell.range.startColumnIndex === 0 && repeatCell.range.endColumnIndex === 1;
    });

    expect(dashboardRepeat).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// createAuditReport — sheet formatting
// ---------------------------------------------------------------------------

describe("createAuditReport() — sheet formatting", () => {
  let mockClient: SheetsClient;

  beforeEach(() => {
    mockClient = makeMockSheetsClient({ spreadsheetId: "format-test-id" });
  });

  it("calls formatSheet for formatting", async () => {
    await createAuditReport([makeSenderStats()], mockClient);
    expect(mockClient.formatSheet).toHaveBeenCalledTimes(1);
  });

  it("includes a repeatCell request to bold the header row", async () => {
    await createAuditReport([makeSenderStats()], mockClient);
    const formatCall = (mockClient.formatSheet as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const requests = formatCall[1] as Array<Record<string, unknown>>;
    const boldRequest = requests.find((r) => "repeatCell" in r);
    expect(boldRequest).toBeDefined();
    const repeatCell = boldRequest!["repeatCell"] as Record<string, unknown>;
    const cellFormat = repeatCell["cell"] as { userEnteredFormat: { textFormat: { bold: boolean } } };
    expect(cellFormat.userEnteredFormat.textFormat.bold).toBe(true);
  });

  it("includes an updateSheetProperties request to freeze row 1", async () => {
    await createAuditReport([makeSenderStats()], mockClient);
    const formatCall = (mockClient.formatSheet as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const requests = formatCall[1] as Array<Record<string, unknown>>;
    const freezeRequest = requests.find((r) => "updateSheetProperties" in r);
    expect(freezeRequest).toBeDefined();
    const sheetProps = freezeRequest!["updateSheetProperties"] as {
      properties: { gridProperties: { frozenRowCount: number } };
    };
    expect(sheetProps.properties.gridProperties.frozenRowCount).toBe(1);
  });

  it("includes a setBasicFilter request to enable auto-filter", async () => {
    await createAuditReport([makeSenderStats()], mockClient);
    const formatCall = (mockClient.formatSheet as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const requests = formatCall[1] as Array<Record<string, unknown>>;
    const filterRequest = requests.find((r) => "setBasicFilter" in r);
    expect(filterRequest).toBeDefined();
  });

  it("includes a setDataValidation request for the 'Your decision' column", async () => {
    await createAuditReport([makeSenderStats()], mockClient);
    const formatCall = (mockClient.formatSheet as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const requests = formatCall[1] as Array<Record<string, unknown>>;
    const validationRequest = requests.find((r) => "setDataValidation" in r);
    expect(validationRequest).toBeDefined();
    const validation = validationRequest!["setDataValidation"] as {
      rule: { condition: { type: string; values: Array<{ userEnteredValue: string }> } };
    };
    expect(validation.rule.condition.type).toBe("ONE_OF_LIST");
    const allowedValues = validation.rule.condition.values.map((v) => v.userEnteredValue);
    expect(allowedValues).toContain("keep");
    expect(allowedValues).toContain("filter");
    expect(allowedValues).toContain("unsubscribe");
  });
});

// ---------------------------------------------------------------------------
// createAuditReport — error handling
// ---------------------------------------------------------------------------

describe("createAuditReport() — error handling", () => {
  it("returns { ok: false, error } when createSpreadsheet fails", async () => {
    const mockClient = makeMockSheetsClient({ createError: "API quota exceeded" });

    const result = await createAuditReport([], mockClient);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");
    expect(result.error).toContain("API quota exceeded");
  });

  it("returns { ok: false, error } when writeRows fails", async () => {
    const mockClient = makeMockSheetsClient({
      spreadsheetId: "err-sheet-id",
      writeRowsError: "Write permission denied",
    });

    const result = await createAuditReport([makeSenderStats()], mockClient);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");
    expect(result.error).toContain("Write permission denied");
  });
});
