import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_HEADER_ROW } from "../../src/analysis/sheets-reporter.js";
import type { GraphClient, GraphFolder, GraphMessage, GraphRule } from "../../src/auth/graph-client.js";
import type { SheetsClient } from "../../src/auth/sheets-client.js";
import { executeBatch } from "../../src/review/execute-batch.js";
import type { BatchManifest } from "../../src/schemas/batch-manifest.js";
import type { DecisionLog } from "../../src/schemas/decision-log.js";
import type { SenderStateFile } from "../../src/schemas/sender-state.js";
import type { Result } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SENDER_EMAIL_COL = AUDIT_HEADER_ROW.indexOf("Sender email");
const YOUR_DECISION_COL = AUDIT_HEADER_ROW.indexOf("Your decision");
const PROCESSED_COL = AUDIT_HEADER_ROW.indexOf("Processed");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exec-batch-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function buildAuditSheetRows(
  headerRow: string[],
  senderEmail = "noreply@spam.com",
  decision = "unsubscribe",
): unknown[][] {
  const senderEmailCol = headerRow.indexOf("Sender email");
  const yourDecisionCol = headerRow.indexOf("Your decision");
  const processedCol = headerRow.indexOf("Processed");
  const dataRow: unknown[] = new Array(headerRow.length).fill("");

  if (senderEmailCol !== -1) dataRow[senderEmailCol] = senderEmail;
  if (yourDecisionCol !== -1) dataRow[yourDecisionCol] = decision;
  if (processedCol !== -1) dataRow[processedCol] = "";

  return [headerRow, dataRow];
}

/** Creates a mock GraphClient with sensible defaults for tests. */
function createMockGraph(overrides: Partial<Record<keyof GraphClient, unknown>> = {}): GraphClient {
  const inboxFolder: GraphFolder = {
    id: "inbox-folder-id",
    displayName: "Inbox",
    totalItemCount: 100,
    unreadItemCount: 50,
  };
  const archiveFolder: GraphFolder = {
    id: "archive-folder-id",
    displayName: "Archive",
    totalItemCount: 200,
    unreadItemCount: 0,
  };

  return {
    getProfile: vi.fn<() => Promise<Result<{ emailAddress: string; displayName: string }>>>().mockResolvedValue({
      ok: true,
      value: {
        emailAddress: "mailbox@example.com",
        displayName: "Mailbox User",
      },
    }),
    listFolders: vi.fn<() => Promise<Result<GraphFolder[]>>>().mockResolvedValue({
      ok: true,
      value: [inboxFolder, archiveFolder],
    }),
    getMailFolder: vi
      .fn<(folderIdOrWellKnownName: string) => Promise<Result<GraphFolder>>>()
      .mockImplementation(async (folderIdOrWellKnownName: string) => {
        if (folderIdOrWellKnownName === "inbox") {
          return { ok: true, value: inboxFolder };
        }
        if (folderIdOrWellKnownName === "archive") {
          return { ok: true, value: archiveFolder };
        }
        return {
          ok: false,
          error: `Unknown folder ${folderIdOrWellKnownName}`,
        };
      }),
    listMessages: vi
      .fn<(opts: unknown) => Promise<Result<{ messages: GraphMessage[]; nextLink?: string }>>>()
      .mockResolvedValue({
        ok: true,
        value: {
          messages: [{ id: "msg-1" } as GraphMessage, { id: "msg-2" } as GraphMessage, { id: "msg-3" } as GraphMessage],
          nextLink: undefined,
        },
      }),
    followNextLink: vi.fn().mockResolvedValue({
      ok: true,
      value: { messages: [], nextLink: undefined },
    }),
    moveMessages: vi
      .fn<(ids: string[], dest: string) => Promise<Result<{ moved: number; errors: number; failures: unknown[] }>>>()
      .mockResolvedValue({
        ok: true,
        value: { moved: 3, errors: 0, failures: [] },
      }),
    patchMessages: vi
      .fn<
        (
          ids: string[],
          patch: Record<string, unknown>,
        ) => Promise<Result<{ patched: number; errors: number; failures: unknown[] }>>
      >()
      .mockResolvedValue({
        ok: true,
        value: { patched: 3, errors: 0, failures: [] },
      }),
    listCategories: vi.fn<() => Promise<Result<Array<{ displayName: string; color: string }>>>>().mockResolvedValue({
      ok: true,
      value: [{ displayName: "_noise", color: "preset8" }],
    }),
    createCategory: vi
      .fn<(name: string, color: string) => Promise<Result<{ displayName: string }>>>()
      .mockResolvedValue({
        ok: true,
        value: { displayName: "_noise" },
      }),
    listRules: vi.fn<() => Promise<Result<GraphRule[]>>>().mockResolvedValue({
      ok: true,
      value: [],
    }),
    createRule: vi.fn<(rule: unknown) => Promise<Result<GraphRule>>>().mockResolvedValue({
      ok: true,
      value: {
        id: "rule-1",
        displayName: "Noise: noreply@spam.com",
        conditions: { senderContains: ["noreply@spam.com"] },
        actions: { moveToFolder: "archive-folder-id" },
        isEnabled: true,
      },
    }),
    deleteRule: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    getMessage: vi.fn().mockResolvedValue({
      ok: true,
      value: { id: "msg", categories: [] } as unknown as GraphMessage,
    }),
    ...overrides,
  } as unknown as GraphClient;
}

/** Creates a mock SheetsClient. */
function createMockSheets(): SheetsClient {
  const headerRow = Array.from(AUDIT_HEADER_ROW);

  return {
    createSpreadsheet: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        spreadsheetId: "sheet-1",
        spreadsheetUrl: "https://sheets.example.com",
      },
    }),
    writeRows: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    readRows: vi.fn().mockResolvedValue({
      ok: true,
      value: buildAuditSheetRows(headerRow),
    }),
    formatSheet: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
}

/** Writes a minimal valid manifest for testing. */
async function writeManifest(
  filePath: string,
  overrides: Partial<BatchManifest> = {},
  senderOverrides: Partial<BatchManifest["senders"][number]> = {},
): Promise<BatchManifest> {
  const manifest: BatchManifest = {
    version: 1,
    runId: "run-test-001",
    batchId: "batch-test-01",
    batchType: "automated",
    groupingReason: "Test batch",
    presentedRecommendation: "unsubscribe",
    summary: {
      senderCount: 1,
      totalEmailCount: 50,
      averageUnreadRatio: 0.8,
    },
    status: "prepared",
    createdAt: "2026-03-24T00:00:00.000Z",
    senders: [
      {
        senderEmail: "noreply@spam.com",
        senderName: "Spam Sender",
        emailCount: 50,
        unreadRatio: 0.8,
        lastEmailDate: "2026-03-23T00:00:00.000Z",
        presentedSenderType: "automated",
        systemRecommendation: "unsubscribe",
        userDecision: "unsubscribe",
        filterStatus: "pending",
        archiveStatus: "pending",
        logStatus: "pending",
        stateStatus: "pending",
        sheetStatus: "pending",
        messagesArchived: 0,
        ...senderOverrides,
      },
    ],
    ...overrides,
  };

  await fs.writeFile(filePath, JSON.stringify(manifest, null, 2), "utf-8");
  return manifest;
}

/** Writes a minimal sender-state file. */
async function writeSenderState(filePath: string): Promise<void> {
  const state: SenderStateFile = {
    version: 1,
    mailbox: "mailbox@example.com",
    generatedAt: "2026-03-24T00:00:00.000Z",
    senders: [
      {
        senderEmail: "noreply@spam.com",
        senderName: "Spam Sender",
        emailCount: 50,
        firstEmailDate: "2025-01-01T00:00:00Z",
        lastEmailDate: "2026-03-23T00:00:00Z",
        gmailCategory: "unknown",
        unreadRatio: 0.8,
        threadCount: 25,
        sampleSubjects: ["Buy now"],
        surprisesFlag: false,
        starredCount: 0,
        importantCount: 0,
      },
    ],
  };
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

/** Writes a minimal decision-log file. */
async function writeDecisionLog(filePath: string): Promise<void> {
  const log: DecisionLog = { version: 1, decisions: [] };
  await fs.writeFile(filePath, JSON.stringify(log, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeBatch", () => {
  it("processes a single sender with unsubscribe decision — rule created, messages archived", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(manifestPath);
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    const graph = createMockGraph();
    const sheets = createMockSheets();

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    // Verify counts
    expect(result.value.sendersProcessed).toBe(1);
    expect(result.value.rulesCreated).toBe(1);
    expect(result.value.messagesArchived).toBe(3);

    // Rule was created
    expect(graph.createRule).toHaveBeenCalledTimes(1);
    const ruleArg = (graph.createRule as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(ruleArg["conditions"]).toEqual({
      senderContains: ["noreply@spam.com"],
    });
    expect(ruleArg["actions"]).toEqual({
      assignCategories: ["_noise"],
      moveToFolder: "archive-folder-id",
    });

    // Messages were patched with _noise category then moved
    expect(graph.patchMessages).toHaveBeenCalledTimes(3);
    expect(graph.moveMessages).toHaveBeenCalledTimes(1);

    // Decision log was updated
    const logRaw = await fs.readFile(decisionLogPath, "utf-8");
    const log = JSON.parse(logRaw) as DecisionLog;
    expect(log.decisions.length).toBe(1);
    expect(log.decisions[0]!.senderEmail).toBe("noreply@spam.com");
    expect(log.decisions[0]!.userDecision).toBe("unsubscribe");
    expect(log.decisions[0]!.messagesArchived).toBe(3);
    expect(log.decisions[0]!.actionsTaken).toEqual(["filter", "archive"]);

    // Sender state was updated with processedAt
    const stateRaw = await fs.readFile(senderStatePath, "utf-8");
    const state = JSON.parse(stateRaw) as SenderStateFile;
    const sender = state.senders.find((s) => s.senderEmail === "noreply@spam.com");
    expect(sender).toBeDefined();
    expect(sender!.processedAt).toBeDefined();

    // Sheet was updated — writeRows called for the Processed column update + Dashboard
    expect(sheets.writeRows).toHaveBeenCalled();

    // Manifest was marked as completed
    const manifestRaw = await fs.readFile(manifestPath, "utf-8");
    const finalManifest = JSON.parse(manifestRaw) as BatchManifest;
    expect(finalManifest.status).toBe("completed");
    expect(finalManifest.senders[0]!.filterStatus).toBe("done");
    expect(finalManifest.senders[0]!.archiveStatus).toBe("done");
    expect(finalManifest.senders[0]!.logStatus).toBe("done");
    expect(finalManifest.senders[0]!.stateStatus).toBe("done");
    expect(finalManifest.senders[0]!.sheetStatus).toBe("done");
    expect(finalManifest.senders[0]!.filterApplied).toBe(true);
    expect(finalManifest.senders[0]!.messagesArchived).toBe(3);
  });

  it("preserves existing message categories when adding _noise", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(manifestPath);
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    const graph = createMockGraph({
      listMessages: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          messages: [{ id: "msg-1" } as GraphMessage, { id: "msg-2" } as GraphMessage],
          nextLink: undefined,
        },
      }),
      getMessage: vi.fn<(id: string) => Promise<Result<GraphMessage>>>().mockImplementation(async (id: string) => ({
        ok: true,
        value:
          id === "msg-1"
            ? ({ id, categories: ["existing-tag"] } as GraphMessage)
            : ({ id, categories: ["_noise", "project-x"] } as GraphMessage),
      })),
      moveMessages: vi
        .fn<(ids: string[], dest: string) => Promise<Result<{ moved: number; errors: number; failures: unknown[] }>>>()
        .mockImplementation(async (ids: string[]) => ({
          ok: true,
          value: { moved: ids.length, errors: 0, failures: [] },
        })),
    });
    const sheets = createMockSheets();

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(graph.patchMessages).toHaveBeenNthCalledWith(1, ["msg-1"], {
      categories: ["existing-tag", "_noise"],
    });
    expect(graph.patchMessages).toHaveBeenNthCalledWith(2, ["msg-2"], {
      categories: ["_noise", "project-x"],
    });
  });

  it("uses the live Sheet1 header order when locating sender rows and writing Processed", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(manifestPath);
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    const reorderedHeader = [
      "Processed",
      "Sender email",
      ...AUDIT_HEADER_ROW.filter((header) => header !== "Processed" && header !== "Sender email"),
    ];

    const graph = createMockGraph();
    const sheets = createMockSheets();
    (sheets.readRows as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: buildAuditSheetRows(reorderedHeader),
    });

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(sheets.writeRows).toHaveBeenCalledWith("sheet-abc", "Sheet1!A2", [expect.any(Array)]);
  });

  it("fails fast when Sheet1 is missing required audit columns", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(manifestPath);
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    const graph = createMockGraph();
    const sheets = createMockSheets();
    const headerWithoutProcessed = AUDIT_HEADER_ROW.filter((header) => header !== "Processed");
    (sheets.readRows as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: buildAuditSheetRows(headerWithoutProcessed),
    });

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toBe('Sheet1 must contain "Sender email" and "Processed" columns');
    expect(sheets.writeRows).not.toHaveBeenCalled();
  });

  it("skips filter and archive for keep decisions", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(manifestPath, {}, { userDecision: "keep" });
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    const graph = createMockGraph();
    const sheets = createMockSheets();

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    // No rule created, no messages moved
    expect(graph.createRule).not.toHaveBeenCalled();
    expect(graph.moveMessages).not.toHaveBeenCalled();
    expect(graph.patchMessages).not.toHaveBeenCalled();
    expect(result.value.rulesCreated).toBe(0);
    expect(result.value.messagesArchived).toBe(0);

    // But log, state, and sheet were updated
    const logRaw = await fs.readFile(decisionLogPath, "utf-8");
    const log = JSON.parse(logRaw) as DecisionLog;
    expect(log.decisions.length).toBe(1);
    expect(log.decisions[0]!.userDecision).toBe("keep");

    // Manifest steps: filter + archive skipped, log/state/sheet done
    const manifestRaw = await fs.readFile(manifestPath, "utf-8");
    const finalManifest = JSON.parse(manifestRaw) as BatchManifest;
    expect(finalManifest.senders[0]!.filterStatus).toBe("skipped");
    expect(finalManifest.senders[0]!.archiveStatus).toBe("skipped");
    expect(finalManifest.senders[0]!.logStatus).toBe("done");
    expect(finalManifest.senders[0]!.stateStatus).toBe("done");
    expect(finalManifest.senders[0]!.sheetStatus).toBe("done");
  });

  it("dry-run validates inputs but does not mutate mailbox or local state", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(manifestPath);
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    const graph = createMockGraph();
    const sheets = createMockSheets();

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    // No mailbox mutations
    expect(graph.createRule).not.toHaveBeenCalled();
    expect(graph.moveMessages).not.toHaveBeenCalled();
    expect(graph.patchMessages).not.toHaveBeenCalled();
    expect(graph.createCategory).not.toHaveBeenCalled();
    expect(result.value.rulesCreated).toBe(0);
    expect(result.value.messagesArchived).toBe(0);
    expect(result.value.sendersProcessed).toBe(0);

    // Log, state, sheet, and manifest are untouched
    const logRaw = await fs.readFile(decisionLogPath, "utf-8");
    const log = JSON.parse(logRaw) as DecisionLog;
    expect(log.decisions.length).toBe(0);

    const stateRaw = await fs.readFile(senderStatePath, "utf-8");
    const state = JSON.parse(stateRaw) as SenderStateFile;
    const sender = state.senders.find((s) => s.senderEmail === "noreply@spam.com");
    expect(sender).toBeDefined();
    expect(sender!.processedAt).toBeUndefined();

    const manifestRaw = await fs.readFile(manifestPath, "utf-8");
    const finalManifest = JSON.parse(manifestRaw) as BatchManifest;
    expect(finalManifest.status).toBe("prepared");
    expect(finalManifest.senders[0]!.filterStatus).toBe("pending");
    expect(finalManifest.senders[0]!.archiveStatus).toBe("pending");
    expect(finalManifest.senders[0]!.logStatus).toBe("pending");
    expect(finalManifest.senders[0]!.stateStatus).toBe("pending");
    expect(finalManifest.senders[0]!.sheetStatus).toBe("pending");
    expect(sheets.writeRows).not.toHaveBeenCalled();
  });

  it("resumes from partially completed sender — skips done steps", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    // Sender already has filterStatus done, archiveStatus pending
    await writeManifest(
      manifestPath,
      {},
      {
        filterStatus: "done",
        archiveStatus: "pending",
        logStatus: "pending",
        stateStatus: "pending",
        sheetStatus: "pending",
      },
    );
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    const graph = createMockGraph();
    const sheets = createMockSheets();

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    // Rule was NOT created (filterStatus was already done)
    expect(graph.createRule).not.toHaveBeenCalled();
    expect(result.value.rulesCreated).toBe(0);

    // But archive WAS executed
    expect(graph.patchMessages).toHaveBeenCalledTimes(3);
    expect(graph.moveMessages).toHaveBeenCalledTimes(1);
    expect(result.value.messagesArchived).toBe(3);
  });

  it("escapes apostrophes in sender email when collecting inbox messages", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");
    const senderEmail = "o'brien@example.com";

    await writeManifest(manifestPath, {}, { senderEmail, senderName: "O'Brien" });
    const state: SenderStateFile = {
      version: 1,
      mailbox: "mailbox@example.com",
      generatedAt: "2026-03-24T00:00:00.000Z",
      senders: [
        {
          senderEmail,
          senderName: "O'Brien",
          emailCount: 50,
          firstEmailDate: "2025-01-01T00:00:00Z",
          lastEmailDate: "2026-03-23T00:00:00Z",
          gmailCategory: "unknown",
          unreadRatio: 0.8,
          threadCount: 25,
          sampleSubjects: ["Buy now"],
          surprisesFlag: false,
          starredCount: 0,
          importantCount: 0,
        },
      ],
    };
    await fs.writeFile(senderStatePath, JSON.stringify(state, null, 2), "utf-8");
    await writeDecisionLog(decisionLogPath);

    const sheets = createMockSheets();
    const headerRow = Array.from(AUDIT_HEADER_ROW);
    const row: unknown[] = new Array(AUDIT_HEADER_ROW.length).fill("");
    row[SENDER_EMAIL_COL] = senderEmail;
    row[YOUR_DECISION_COL] = "unsubscribe";
    row[PROCESSED_COL] = "";
    (sheets.readRows as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: [headerRow, row],
    });

    const graph = createMockGraph();

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    const listMessagesArgs = (graph.listMessages as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      filter: string;
    };
    expect(listMessagesArgs.filter).toContain("from/emailAddress/address eq 'o''brien@example.com'");
  });

  it("does not create duplicate rules when rule already exists", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(manifestPath);
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    // listRules returns an existing rule for this sender
    const graph = createMockGraph({
      listRules: vi.fn().mockResolvedValue({
        ok: true,
        value: [
          {
            id: "existing-rule-1",
            displayName: "Noise: noreply@spam.com",
            conditions: { senderContains: ["noreply@spam.com"] },
            actions: {
              assignCategories: ["_noise"],
              moveToFolder: "archive-folder-id",
            },
            isEnabled: true,
          },
        ],
      }),
    });
    const sheets = createMockSheets();

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    // No new rule created (idempotent)
    expect(graph.createRule).not.toHaveBeenCalled();
    expect(result.value.rulesCreated).toBe(0);

    // Archive still happened
    expect(result.value.messagesArchived).toBe(3);
  });

  it("does not reuse disabled, wrong-folder, move-only, or extra-condition rules", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(manifestPath);
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    const graph = createMockGraph({
      listRules: vi.fn().mockResolvedValue({
        ok: true,
        value: [
          {
            id: "disabled-rule",
            displayName: "Noise: noreply@spam.com",
            conditions: { senderContains: ["noreply@spam.com"] },
            actions: { moveToFolder: "archive-folder-id" },
            isEnabled: false,
          },
          {
            id: "wrong-folder-rule",
            displayName: "Noise: noreply@spam.com",
            conditions: { senderContains: ["noreply@spam.com"] },
            actions: { moveToFolder: "some-other-folder" },
            isEnabled: true,
          },
          {
            id: "move-only-rule",
            displayName: "Noise: noreply@spam.com",
            conditions: { senderContains: ["noreply@spam.com"] },
            actions: { moveToFolder: "archive-folder-id" },
            isEnabled: true,
          },
          {
            id: "extra-condition-rule",
            displayName: "Noise: noreply@spam.com",
            conditions: {
              senderContains: ["noreply@spam.com"],
              subjectContains: ["invoice"],
            },
            actions: {
              assignCategories: ["_noise"],
              moveToFolder: "archive-folder-id",
            },
            isEnabled: true,
          },
        ],
      }),
    });
    const sheets = createMockSheets();

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(graph.createRule).toHaveBeenCalledTimes(1);
    expect(result.value.rulesCreated).toBe(1);
  });

  it("does not duplicate a decision-log entry when the same sender/run/batch is reprocessed", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(manifestPath);
    await writeSenderState(senderStatePath);

    const existingLog: DecisionLog = {
      version: 1,
      decisions: [
        {
          runId: "run-test-001",
          senderEmail: "noreply@spam.com",
          senderName: "Spam Sender",
          presentedSenderType: "automated",
          senderTypeFeedback: "none",
          systemRecommendation: "unsubscribe",
          userDecision: "unsubscribe",
          batchId: "batch-test-01",
          timestamp: "2026-03-24T00:00:00.000Z",
          emailCount: 50,
          messagesArchived: 1,
          actionsTaken: ["filter"],
        },
      ],
    };
    await fs.writeFile(decisionLogPath, JSON.stringify(existingLog, null, 2), "utf-8");

    const graph = createMockGraph();
    const sheets = createMockSheets();

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    const logRaw = await fs.readFile(decisionLogPath, "utf-8");
    const log = JSON.parse(logRaw) as DecisionLog;
    expect(log.decisions).toHaveLength(1);
    expect(log.decisions[0]!.messagesArchived).toBe(3);
    expect(log.decisions[0]!.actionsTaken).toEqual(["filter", "archive"]);
  });

  it("includes persisted archived counts when resuming after archive already completed", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(
      manifestPath,
      {},
      {
        filterStatus: "done",
        archiveStatus: "done",
        logStatus: "pending",
        stateStatus: "pending",
        sheetStatus: "pending",
        filterApplied: true,
        messagesArchived: 3,
      },
    );
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    const graph = createMockGraph();
    const sheets = createMockSheets();

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(graph.patchMessages).not.toHaveBeenCalled();
    expect(graph.moveMessages).not.toHaveBeenCalled();
    expect(result.value.messagesArchived).toBe(3);
  });

  it("processes multiple senders in one batch", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    const manifest: BatchManifest = {
      version: 1,
      runId: "run-test-001",
      batchId: "batch-test-01",
      batchType: "automated",
      groupingReason: "Test batch",
      presentedRecommendation: "unsubscribe",
      summary: {
        senderCount: 3,
        totalEmailCount: 150,
        averageUnreadRatio: 0.7,
      },
      status: "prepared",
      createdAt: "2026-03-24T00:00:00.000Z",
      senders: [
        {
          senderEmail: "alpha@example.com",
          senderName: "Alpha",
          emailCount: 50,
          unreadRatio: 0.8,
          lastEmailDate: "2026-03-23T00:00:00.000Z",
          presentedSenderType: "automated",
          systemRecommendation: "unsubscribe",
          userDecision: "unsubscribe",
          filterStatus: "pending",
          archiveStatus: "pending",
          logStatus: "pending",
          stateStatus: "pending",
          sheetStatus: "pending",
          messagesArchived: 0,
        },
        {
          senderEmail: "beta@example.com",
          senderName: "Beta",
          emailCount: 50,
          unreadRatio: 0.6,
          lastEmailDate: "2026-03-22T00:00:00.000Z",
          presentedSenderType: "newsletter",
          systemRecommendation: "filter",
          userDecision: "filter",
          filterStatus: "pending",
          archiveStatus: "pending",
          logStatus: "pending",
          stateStatus: "pending",
          sheetStatus: "pending",
          messagesArchived: 0,
        },
        {
          senderEmail: "gamma@example.com",
          senderName: "Gamma",
          emailCount: 50,
          unreadRatio: 0.7,
          lastEmailDate: "2026-03-21T00:00:00.000Z",
          presentedSenderType: "human",
          systemRecommendation: "keep",
          userDecision: "keep",
          filterStatus: "pending",
          archiveStatus: "pending",
          logStatus: "pending",
          stateStatus: "pending",
          sheetStatus: "pending",
          messagesArchived: 0,
        },
      ],
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    // Sender state with all 3 senders
    const state: SenderStateFile = {
      version: 1,
      mailbox: "mailbox@example.com",
      generatedAt: "2026-03-24T00:00:00.000Z",
      senders: [
        {
          senderEmail: "alpha@example.com",
          senderName: "Alpha",
          emailCount: 50,
          firstEmailDate: "2025-01-01T00:00:00Z",
          lastEmailDate: "2026-03-23T00:00:00Z",
          gmailCategory: "unknown",
          unreadRatio: 0.8,
          threadCount: 25,
          sampleSubjects: ["Alpha mail"],
          surprisesFlag: false,
          starredCount: 0,
          importantCount: 0,
        },
        {
          senderEmail: "beta@example.com",
          senderName: "Beta",
          emailCount: 50,
          firstEmailDate: "2025-06-01T00:00:00Z",
          lastEmailDate: "2026-03-22T00:00:00Z",
          gmailCategory: "unknown",
          unreadRatio: 0.6,
          threadCount: 30,
          sampleSubjects: ["Beta mail"],
          surprisesFlag: false,
          starredCount: 0,
          importantCount: 0,
        },
        {
          senderEmail: "gamma@example.com",
          senderName: "Gamma",
          emailCount: 50,
          firstEmailDate: "2025-09-01T00:00:00Z",
          lastEmailDate: "2026-03-21T00:00:00Z",
          gmailCategory: "unknown",
          unreadRatio: 0.7,
          threadCount: 20,
          sampleSubjects: ["Gamma mail"],
          surprisesFlag: false,
          starredCount: 0,
          importantCount: 0,
        },
      ],
    };
    await fs.writeFile(senderStatePath, JSON.stringify(state, null, 2), "utf-8");
    await writeDecisionLog(decisionLogPath);

    // Mock sheets with rows for all 3 senders
    const headerRow = Array.from(AUDIT_HEADER_ROW);
    const rows: unknown[][] = [headerRow];
    for (const email of ["alpha@example.com", "beta@example.com", "gamma@example.com"]) {
      const row: unknown[] = new Array(AUDIT_HEADER_ROW.length).fill("");
      row[SENDER_EMAIL_COL] = email;
      rows.push(row);
    }

    const sheets = createMockSheets();
    (sheets.readRows as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: rows,
    });

    const graph = createMockGraph();

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value.sendersProcessed).toBe(3);
    // Only alpha and beta get rules (gamma is "keep")
    expect(result.value.rulesCreated).toBe(2);
    // Only alpha and beta get archive (gamma is "keep")
    expect(result.value.messagesArchived).toBe(6); // 3 messages * 2 senders

    // Decision log has 3 entries
    const logRaw = await fs.readFile(decisionLogPath, "utf-8");
    const log = JSON.parse(logRaw) as DecisionLog;
    expect(log.decisions.length).toBe(3);
    expect(log.decisions.map((entry) => entry.messagesArchived)).toEqual([3, 3, 0]);
    expect(log.decisions.map((entry) => entry.actionsTaken)).toEqual([
      ["filter", "archive"],
      ["filter", "archive"],
      [],
    ]);

    // Final manifest completed
    const manifestRaw = await fs.readFile(manifestPath, "utf-8");
    const finalManifest = JSON.parse(manifestRaw) as BatchManifest;
    expect(finalManifest.status).toBe("completed");
  });

  it("tolerates not-found move failures and continues processing", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(manifestPath);
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    const graph = createMockGraph({
      moveMessages: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          moved: 2,
          errors: 1,
          failures: [
            {
              messageId: "msg-3",
              error: "Not Found",
              statusCode: 404,
              kind: "not_found",
            },
          ],
        },
      }),
    });
    const sheets = createMockSheets();

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    // Partial move failures are tolerated — pipeline continues
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected success");

    const manifestRaw = await fs.readFile(manifestPath, "utf-8");
    const finalManifest = JSON.parse(manifestRaw) as BatchManifest;
    expect(finalManifest.status).toBe("completed");
    expect(finalManifest.senders[0]!.archiveStatus).toBe("done");
    expect(finalManifest.senders[0]!.messagesArchived).toBe(2);
  });

  it("fails when a partial move includes non-not-found errors", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(manifestPath);
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    const graph = createMockGraph({
      moveMessages: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          moved: 2,
          errors: 1,
          failures: [
            {
              messageId: "msg-3",
              error: "Service unavailable",
              statusCode: 503,
              kind: "other",
            },
          ],
        },
      }),
    });
    const sheets = createMockSheets();

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toMatch(/failed to move messages/i);

    const manifestRaw = await fs.readFile(manifestPath, "utf-8");
    const finalManifest = JSON.parse(manifestRaw) as BatchManifest;
    expect(finalManifest.status).toBe("prepared");
    expect(finalManifest.senders[0]!.archiveStatus).toBe("pending");
  });

  it("skips moving messages whose category patch hit only not-found races", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(manifestPath);
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    const patchMessages = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          patched: 0,
          errors: 1,
          failures: [
            {
              messageId: "msg-1",
              error: "Not Found",
              statusCode: 404,
              kind: "not_found",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { patched: 1, errors: 0, failures: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { patched: 1, errors: 0, failures: [] },
      });

    const moveMessages = vi.fn().mockResolvedValue({
      ok: true,
      value: { moved: 2, errors: 0, failures: [] },
    });

    const graph = createMockGraph({ patchMessages, moveMessages });
    const sheets = createMockSheets();

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected success");
    expect(moveMessages).toHaveBeenCalledWith(["msg-2", "msg-3"], "archive-folder-id");
  });

  it("fails when category patching has non-not-found partial failures", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(manifestPath);
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    const graph = createMockGraph({
      patchMessages: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          patched: 0,
          errors: 1,
          failures: [
            {
              messageId: "msg-1",
              error: "Bad Request",
              statusCode: 400,
              kind: "other",
            },
          ],
        },
      }),
    });
    const sheets = createMockSheets();

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toMatch(/failed to patch messages/i);
    expect(graph.moveMessages).not.toHaveBeenCalled();
  });

  it("resolves Inbox and Archive via well-known folder names", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(manifestPath);
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    const graph = createMockGraph();
    const sheets = createMockSheets();

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(graph.getMailFolder).toHaveBeenNthCalledWith(1, "inbox");
    expect(graph.getMailFolder).toHaveBeenNthCalledWith(2, "archive");
  });

  it("ensures _noise category is created when it does not exist", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(manifestPath);
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    // listCategories returns no _noise category
    const graph = createMockGraph({
      listCategories: vi.fn().mockResolvedValue({
        ok: true,
        value: [{ displayName: "Red category", color: "preset0" }],
      }),
    });
    const sheets = createMockSheets();

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    expect(result.ok).toBe(true);
    // _noise category should have been created
    expect(graph.createCategory).toHaveBeenCalledWith("_noise", "preset8");
  });

  it("does not create _noise category when it already exists", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(manifestPath);
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    const graph = createMockGraph();
    const sheets = createMockSheets();

    await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
    });

    // _noise already existed in mock — createCategory should NOT be called
    expect(graph.createCategory).not.toHaveBeenCalled();
  });

  it("reports progress via onProgress callback", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(manifestPath);
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    const graph = createMockGraph();
    const sheets = createMockSheets();
    const progress: Array<{ sender: string; step: string; status: string }> = [];

    await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
      onProgress: (info) => progress.push(info),
    });

    // Should have progress entries for each step
    expect(progress.length).toBeGreaterThanOrEqual(5);
    const senders = progress.map((p) => p.sender);
    expect(senders.every((s) => s === "noreply@spam.com")).toBe(true);
    const steps = progress.map((p) => p.step);
    expect(steps).toContain("filterStatus");
    expect(steps).toContain("archiveStatus");
    expect(steps).toContain("logStatus");
    expect(steps).toContain("stateStatus");
    expect(steps).toContain("sheetStatus");
  });

  it("ignores throwing onProgress callbacks", async () => {
    const manifestPath = path.join(tmpDir, "manifest.json");
    const senderStatePath = path.join(tmpDir, "sender-state.v1.json");
    const decisionLogPath = path.join(tmpDir, "decision-log.json");

    await writeManifest(manifestPath);
    await writeSenderState(senderStatePath);
    await writeDecisionLog(decisionLogPath);

    const graph = createMockGraph();
    const sheets = createMockSheets();

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-abc",
      graph,
      sheetsClient: sheets,
      senderStatePath,
      decisionLogPath,
      onProgress: () => {
        throw new Error("boom");
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
  });
});
