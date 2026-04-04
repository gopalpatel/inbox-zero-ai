// tests/review/execute-batch.test.ts

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_HEADER_ROW } from "../../src/analysis/sheets-reporter.js";
import { executeBatch } from "../../src/review/execute-batch.js";
import type { SenderStateEntry } from "../../src/schemas/sender-state.js";
import { createManifest, readManifest } from "../../src/state/batch-manifest-manager.js";
import { readDecisionLog } from "../../src/state/decision-log-manager.js";
import { readSenderState, writeSenderState } from "../../src/state/sender-state-manager.js";

const TMP_DIR = path.join(import.meta.dirname, "../../.test-tmp-execute");

function makeMockGmailClient() {
  return {
    listFilters: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    createFilter: vi.fn().mockResolvedValue({ ok: true, value: { id: "filter-1" } }),
    listMessages: vi.fn().mockResolvedValue({
      ok: true,
      value: { messages: [{ id: "msg-1", threadId: "t-1" }], nextPageToken: undefined },
    }),
    batchModifyMessages: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    getProfile: vi.fn().mockResolvedValue({ ok: true, value: { emailAddress: "test@test.com", messagesTotal: 100 } }),
    listLabels: vi.fn().mockResolvedValue({ ok: true, value: [{ id: "Label_noise", name: "_noise" }] }),
  };
}

function makeStateEntry(overrides: Partial<SenderStateEntry> = {}): SenderStateEntry {
  return {
    senderEmail: "test@example.com",
    senderName: "Test Sender",
    emailCount: 100,
    firstEmailDate: "2025-01-01T00:00:00Z",
    lastEmailDate: "2026-03-10T00:00:00Z",
    gmailCategory: "promotions",
    unreadRatio: 0.5,
    threadCount: 10,
    sampleSubjects: ["Weekly digest"],
    surprisesFlag: false,
    starredCount: 0,
    importantCount: 0,
    ...overrides,
  };
}

async function seedSenderState(statePath: string, entries: SenderStateEntry[]): Promise<void> {
  await writeSenderState(statePath, {
    version: 1,
    mailbox: "test@test.com",
    generatedAt: "2026-03-18T10:00:00Z",
    senders: entries,
  });
}

function makeAuditRow(overrides: {
  senderEmail: string;
  senderName: string;
  senderType?: string;
  yourDecision?: string;
  processed?: string;
}): unknown[] {
  const row = new Array(AUDIT_HEADER_ROW.length).fill("");
  row[0] = overrides.senderEmail;
  row[1] = overrides.senderName;
  row[2] = 100;
  row[3] = "2025-01-01T00:00:00Z";
  row[4] = "2026-03-10T00:00:00Z";
  row[5] = "promotions";
  row[6] = "50%";
  row[7] = 10;
  row[8] = "Weekly digest";
  row[9] = "probably_noise";
  row[10] = "filter";
  row[11] = "No";
  row[12] = overrides.yourDecision ?? "";
  row[13] = overrides.senderType ?? "newsletter";
  row[14] = "No";
  row[15] = overrides.processed ?? "";
  return row;
}

function makeMockSheetsClient(initialRows: unknown[][] = []) {
  const sheetRows = [Array.from(AUDIT_HEADER_ROW), ...initialRows.map((row) => [...row])];
  let dashboardRows: unknown[][] = [];

  return {
    writeRows: vi.fn().mockImplementation(async (_sheetId: string, range: string, values: unknown[][]) => {
      if (range === "Dashboard!A1:B7") {
        dashboardRows = values.map((row) => [...row]);
        return { ok: true, value: undefined };
      }

      const rowMatch = range.match(/^Sheet1!A(\d+)(?::P\d+)?$/u);
      if (rowMatch) {
        const rowIndex = Number.parseInt(rowMatch[1]!, 10) - 1;
        sheetRows[rowIndex] = [...values[0]!];
        return { ok: true, value: undefined };
      }

      return { ok: true, value: undefined };
    }),
    readRows: vi.fn().mockImplementation(async (_sheetId: string, range: string) => {
      if (range === "Dashboard!A1:B7") {
        return { ok: true, value: dashboardRows.map((row) => [...row]) };
      }
      return { ok: true, value: sheetRows.map((row) => [...row]) };
    }),
    createSpreadsheet: vi.fn().mockResolvedValue({ ok: true, value: { spreadsheetId: "s1", spreadsheetUrl: "..." } }),
    formatSheet: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    __getSheetRows() {
      return sheetRows.map((row) => [...row]);
    },
    __getDashboardRows() {
      return dashboardRows.map((row) => [...row]);
    },
  };
}

describe("executeBatch", () => {
  beforeEach(async () => {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
    await fs.mkdir(TMP_DIR, { recursive: true });
  });

  it("creates filter and archives for 'filter' decisions", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0001.json");
    const logPath = path.join(TMP_DIR, "decision-log.json");
    const statePath = path.join(TMP_DIR, "sender-state.v1.json");

    await createManifest(manifestPath, {
      runId: "run-001",
      batchId: "batch-1",
      batchType: "newsletter",
      groupingReason: "Highest-volume newsletter senders, sorted by email count descending",
      presentedRecommendation: "filter",
      summary: { senderCount: 1, totalEmailCount: 1200, averageUnreadRatio: 0.92 },
      senders: [
        {
          senderEmail: "spam@co.com",
          senderName: "Spam Co",
          emailCount: 1200,
          unreadRatio: 0.92,
          lastEmailDate: "2026-03-10T00:00:00Z",
          presentedSenderType: "newsletter",
          systemRecommendation: "filter",
          userDecision: "filter",
        },
      ],
    });

    const gmail = makeMockGmailClient();
    await seedSenderState(statePath, [
      makeStateEntry({
        senderEmail: "spam@co.com",
        senderName: "Spam Co",
        emailCount: 1200,
        lastEmailDate: "2026-03-10T00:00:00Z",
        unreadRatio: 0.92,
      }),
    ]);
    const sheets = makeMockSheetsClient([makeAuditRow({ senderEmail: "spam@co.com", senderName: "Spam Co" })]);

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-1",
      // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
      gmailClient: gmail as any,
      // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
      sheetsClient: sheets as any,
      senderStatePath: statePath,
      decisionLogPath: logPath,
      skipFilterCreation: false,
    });

    expect(result.ok).toBe(true);
    expect(gmail.createFilter).toHaveBeenCalledTimes(1);
    expect(gmail.batchModifyMessages).toHaveBeenCalled();

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");
    expect(manifest.value.status).toBe("completed");
    expect(manifest.value.senders[0]!.filterStatus).toBe("done");
    expect(manifest.value.senders[0]!.archiveStatus).toBe("done");
    const updatedSheetRow = (sheets as typeof sheets & { __getSheetRows: () => unknown[][] }).__getSheetRows()[1]!;
    expect(updatedSheetRow[0]).toBe("spam@co.com");
    expect(updatedSheetRow[1]).toBe("Spam Co");
    expect(updatedSheetRow[2]).toBe(100);
    expect(updatedSheetRow[10]).toBe("filter");
    expect(updatedSheetRow[12]).toBe("filter");
    expect(updatedSheetRow[15]).toBeTruthy();
    expect(
      (sheets as typeof sheets & { writeRows: ReturnType<typeof vi.fn> }).writeRows.mock.calls.some(
        (call) => call[1] === "Sheet1!A1",
      ),
    ).toBe(false);
    expect((sheets as typeof sheets & { __getDashboardRows: () => unknown[][] }).__getDashboardRows()[1]?.[1]).toBe(1);
    expect((sheets as typeof sheets & { __getDashboardRows: () => unknown[][] }).__getDashboardRows()[2]?.[1]).toBe(1);
  });

  it("skips filter/archive for 'keep' decisions", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0002.json");
    const logPath = path.join(TMP_DIR, "decision-log.json");
    const statePath = path.join(TMP_DIR, "sender-state.v1.json");

    await createManifest(manifestPath, {
      runId: "run-001",
      batchId: "batch-2",
      batchType: "human",
      groupingReason: "Human senders preserved for review",
      presentedRecommendation: "keep",
      summary: { senderCount: 1, totalEmailCount: 48, averageUnreadRatio: 0.02 },
      senders: [
        {
          senderEmail: "friend@gmail.com",
          senderName: "Friend",
          emailCount: 48,
          unreadRatio: 0.02,
          lastEmailDate: "2026-03-17T00:00:00Z",
          presentedSenderType: "human",
          systemRecommendation: "keep",
          userDecision: "keep",
        },
      ],
    });

    const gmail = makeMockGmailClient();
    await seedSenderState(statePath, [
      makeStateEntry({
        senderEmail: "friend@gmail.com",
        senderName: "Friend",
        emailCount: 48,
        lastEmailDate: "2026-03-17T00:00:00Z",
        unreadRatio: 0.02,
      }),
    ]);
    const sheets = makeMockSheetsClient([makeAuditRow({ senderEmail: "friend@gmail.com", senderName: "Friend" })]);

    await executeBatch({
      manifestPath,
      sheetId: "sheet-1",
      // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
      gmailClient: gmail as any,
      // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
      sheetsClient: sheets as any,
      senderStatePath: statePath,
      decisionLogPath: logPath,
    });

    expect(gmail.createFilter).not.toHaveBeenCalled();
    expect(gmail.batchModifyMessages).not.toHaveBeenCalled();

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");
    expect(manifest.value.senders[0]!.filterStatus).toBe("skipped");
    expect(manifest.value.senders[0]!.archiveStatus).toBe("skipped");
  });

  it("marks manifest completed after all senders are done", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0003.json");
    const logPath = path.join(TMP_DIR, "decision-log.json");
    const statePath = path.join(TMP_DIR, "sender-state.v1.json");

    await createManifest(manifestPath, {
      runId: "run-001",
      batchId: "batch-3",
      batchType: "newsletter",
      groupingReason: "Highest-volume newsletter senders, sorted by email count descending",
      presentedRecommendation: "filter",
      summary: { senderCount: 2, totalEmailCount: 1800, averageUnreadRatio: 0.9 },
      senders: [
        {
          senderEmail: "a@co.com",
          senderName: "A Co",
          emailCount: 1000,
          unreadRatio: 0.92,
          lastEmailDate: "2026-03-10T00:00:00Z",
          presentedSenderType: "newsletter",
          systemRecommendation: "filter",
          userDecision: "filter",
        },
        {
          senderEmail: "b@co.com",
          senderName: "B Co",
          emailCount: 800,
          unreadRatio: 0.88,
          lastEmailDate: "2026-03-12T00:00:00Z",
          presentedSenderType: "automated",
          systemRecommendation: "filter",
          userDecision: "filter",
        },
      ],
    });

    const gmail = makeMockGmailClient();
    await seedSenderState(statePath, [
      makeStateEntry({
        senderEmail: "a@co.com",
        senderName: "A Co",
        emailCount: 1000,
        lastEmailDate: "2026-03-10T00:00:00Z",
        unreadRatio: 0.92,
      }),
      makeStateEntry({
        senderEmail: "b@co.com",
        senderName: "B Co",
        emailCount: 800,
        lastEmailDate: "2026-03-12T00:00:00Z",
        unreadRatio: 0.88,
      }),
    ]);
    const sheets = makeMockSheetsClient([
      makeAuditRow({ senderEmail: "a@co.com", senderName: "A Co" }),
      makeAuditRow({ senderEmail: "b@co.com", senderName: "B Co", senderType: "automated" }),
    ]);

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-1",
      // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
      gmailClient: gmail as any,
      // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
      sheetsClient: sheets as any,
      senderStatePath: statePath,
      decisionLogPath: logPath,
      skipFilterCreation: false,
    });

    expect(result.ok).toBe(true);
    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");
    expect(manifest.value.status).toBe("completed");
    for (const s of manifest.value.senders) {
      expect(s.filterStatus).toBe("done");
      expect(s.logStatus).toBe("done");
    }
  });

  it("persists reviewed sender type into sender-state as user-owned canonical state", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0004.json");
    const logPath = path.join(TMP_DIR, "decision-log.json");
    const statePath = path.join(TMP_DIR, "sender-state.v1.json");

    await createManifest(manifestPath, {
      runId: "run-001",
      batchId: "batch-4",
      batchType: "newsletter",
      groupingReason: "Test batch for type correction",
      presentedRecommendation: "filter",
      summary: { senderCount: 1, totalEmailCount: 500, averageUnreadRatio: 0.8 },
      senders: [
        {
          senderEmail: "corp@example.com",
          senderName: "Corp Example",
          emailCount: 500,
          unreadRatio: 0.8,
          lastEmailDate: "2026-03-10T00:00:00Z",
          presentedSenderType: "newsletter",
          reviewedSenderType: "company",
          systemRecommendation: "filter",
          userDecision: "filter",
        },
      ],
    });

    const gmail = makeMockGmailClient();
    await seedSenderState(statePath, [
      makeStateEntry({
        senderEmail: "corp@example.com",
        senderName: "Corp Example",
        emailCount: 500,
        lastEmailDate: "2026-03-10T00:00:00Z",
        unreadRatio: 0.8,
        senderType: "newsletter",
        senderTypeConfidence: 0.85,
        senderTypeSource: "llm",
      }),
    ]);
    const sheets = makeMockSheetsClient([makeAuditRow({ senderEmail: "corp@example.com", senderName: "Corp Example" })]);

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-1",
      // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
      gmailClient: gmail as any,
      // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
      sheetsClient: sheets as any,
      senderStatePath: statePath,
      decisionLogPath: logPath,
    });

    expect(result.ok).toBe(true);

    const stateResult = await readSenderState(statePath);
    if (!stateResult.ok) throw new Error("Expected ok reading sender state");
    const senderEntry = stateResult.value?.senders.find((s) => s.senderEmail === "corp@example.com");
    if (senderEntry === undefined) throw new Error("Expected sender entry to exist in sender-state");
    expect(senderEntry.senderType).toBe("company");
    expect(senderEntry.reviewedSenderType).toBe("company");
    expect(senderEntry.senderTypeSource).toBe("user");
    expect(senderEntry.reviewedAt).toBeDefined();
    expect(senderEntry.processedAt).toBeDefined();
  });

  it("does not create a duplicate filter when rerun against an equivalent existing Gmail filter", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0005.json");
    const logPath = path.join(TMP_DIR, "decision-log.json");
    const statePath = path.join(TMP_DIR, "sender-state.v1.json");

    await createManifest(manifestPath, {
      runId: "run-001",
      batchId: "batch-5",
      batchType: "newsletter",
      groupingReason: "Idempotency test",
      presentedRecommendation: "filter",
      summary: { senderCount: 1, totalEmailCount: 300, averageUnreadRatio: 0.7 },
      senders: [
        {
          senderEmail: "existing@example.com",
          senderName: "Existing Filter Sender",
          emailCount: 300,
          unreadRatio: 0.7,
          lastEmailDate: "2026-03-10T00:00:00Z",
          presentedSenderType: "newsletter",
          systemRecommendation: "filter",
          userDecision: "filter",
        },
      ],
    });

    const gmail = makeMockGmailClient();
    // Seed listFilters with an existing filter that matches from:existing@example.com
    gmail.listFilters.mockResolvedValue({
      ok: true,
      value: [
        {
          id: "existing-filter-id",
          criteria: { from: "existing@example.com" },
          action: { addLabelIds: ["Label_noise"], removeLabelIds: ["INBOX"] },
        },
      ],
    });

    await seedSenderState(statePath, [
      makeStateEntry({
        senderEmail: "existing@example.com",
        senderName: "Existing Filter Sender",
        emailCount: 300,
        lastEmailDate: "2026-03-10T00:00:00Z",
        unreadRatio: 0.7,
      }),
    ]);
    const sheets = makeMockSheetsClient([
      makeAuditRow({ senderEmail: "existing@example.com", senderName: "Existing Filter Sender" }),
    ]);

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-1",
      // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
      gmailClient: gmail as any,
      // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
      sheetsClient: sheets as any,
      senderStatePath: statePath,
      decisionLogPath: logPath,
      skipFilterCreation: false,
    });

    expect(result.ok).toBe(true);
    // createFilter should NOT be called since an equivalent filter already exists
    expect(gmail.createFilter).not.toHaveBeenCalled();

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");
    expect(manifest.value.senders[0]!.filterStatus).toBe("done");
  });

  it("appends decision log entries for processed senders", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0006.json");
    const logPath = path.join(TMP_DIR, "decision-log.json");
    const statePath = path.join(TMP_DIR, "sender-state.v1.json");

    await createManifest(manifestPath, {
      runId: "run-002",
      batchId: "batch-6",
      batchType: "automated",
      groupingReason: "Automated sender batch",
      presentedRecommendation: "filter",
      summary: { senderCount: 1, totalEmailCount: 200, averageUnreadRatio: 0.6 },
      senders: [
        {
          senderEmail: "auto@sender.com",
          senderName: "Auto Sender",
          emailCount: 200,
          unreadRatio: 0.6,
          lastEmailDate: "2026-03-15T00:00:00Z",
          presentedSenderType: "automated",
          systemRecommendation: "filter",
          userDecision: "filter",
        },
      ],
    });

    const gmail = makeMockGmailClient();
    await seedSenderState(statePath, [
      makeStateEntry({
        senderEmail: "auto@sender.com",
        senderName: "Auto Sender",
        emailCount: 200,
        lastEmailDate: "2026-03-15T00:00:00Z",
        unreadRatio: 0.6,
        senderType: "automated",
      }),
    ]);
    const sheets = makeMockSheetsClient([makeAuditRow({ senderEmail: "auto@sender.com", senderName: "Auto Sender", senderType: "automated" })]);

    await executeBatch({
      manifestPath,
      sheetId: "sheet-1",
      // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
      gmailClient: gmail as any,
      // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
      sheetsClient: sheets as any,
      senderStatePath: statePath,
      decisionLogPath: logPath,
    });

    const logResult = await readDecisionLog(logPath);
    if (!logResult.ok) throw new Error("Expected ok reading decision log");
    const log = logResult.value;
    if (log === null) throw new Error("Expected decision log to exist");
    expect(log.decisions).toHaveLength(1);
    expect(log.decisions[0]!.senderEmail).toBe("auto@sender.com");
    expect(log.decisions[0]!.userDecision).toBe("filter");
    expect(log.decisions[0]!.batchId).toBe("batch-6");
  });

  it("calls onProgress callback for each sender step", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0007.json");
    const logPath = path.join(TMP_DIR, "decision-log.json");
    const statePath = path.join(TMP_DIR, "sender-state.v1.json");

    await createManifest(manifestPath, {
      runId: "run-001",
      batchId: "batch-7",
      batchType: "newsletter",
      groupingReason: "Progress callback test",
      presentedRecommendation: "filter",
      summary: { senderCount: 1, totalEmailCount: 100, averageUnreadRatio: 0.5 },
      senders: [
        {
          senderEmail: "progress@test.com",
          senderName: "Progress Test",
          emailCount: 100,
          unreadRatio: 0.5,
          lastEmailDate: "2026-03-10T00:00:00Z",
          presentedSenderType: "newsletter",
          systemRecommendation: "filter",
          userDecision: "filter",
        },
      ],
    });

    const gmail = makeMockGmailClient();
    await seedSenderState(statePath, [
      makeStateEntry({
        senderEmail: "progress@test.com",
        senderName: "Progress Test",
        emailCount: 100,
        lastEmailDate: "2026-03-10T00:00:00Z",
        unreadRatio: 0.5,
      }),
    ]);
    const sheets = makeMockSheetsClient([makeAuditRow({ senderEmail: "progress@test.com", senderName: "Progress Test" })]);
    const progressEvents: Array<{ sender: string; step: string; status: string }> = [];

    await executeBatch({
      manifestPath,
      sheetId: "sheet-1",
      // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
      gmailClient: gmail as any,
      // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
      sheetsClient: sheets as any,
      senderStatePath: statePath,
      decisionLogPath: logPath,
      onProgress(info) {
        progressEvents.push(info);
      },
    });

    // Should have fired progress for at least filterStatus and archiveStatus steps
    const senderEvents = progressEvents.filter((e) => e.sender === "progress@test.com");
    expect(senderEvents.length).toBeGreaterThan(0);
  });

  it("fails when canonical sender state is missing instead of inventing placeholder state", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0008.json");
    const logPath = path.join(TMP_DIR, "decision-log.json");
    const statePath = path.join(TMP_DIR, "sender-state.v1.json");

    await createManifest(manifestPath, {
      runId: "run-001",
      batchId: "batch-8",
      batchType: "newsletter",
      groupingReason: "Missing state test",
      presentedRecommendation: "filter",
      summary: { senderCount: 1, totalEmailCount: 100, averageUnreadRatio: 0.5 },
      senders: [
        {
          senderEmail: "missing@test.com",
          senderName: "Missing State",
          emailCount: 100,
          unreadRatio: 0.5,
          lastEmailDate: "2026-03-10T00:00:00Z",
          presentedSenderType: "newsletter",
          systemRecommendation: "filter",
          userDecision: "filter",
        },
      ],
    });

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-1",
      gmailClient: makeMockGmailClient() as any,
      sheetsClient: makeMockSheetsClient([makeAuditRow({ senderEmail: "missing@test.com", senderName: "Missing State" })]) as any,
      senderStatePath: statePath,
      decisionLogPath: logPath,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toMatch(/sender state file is required/i);
  });

  it("does not append a duplicate decision log entry when rerun after log append succeeded", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0009.json");
    const logPath = path.join(TMP_DIR, "decision-log.json");
    const statePath = path.join(TMP_DIR, "sender-state.v1.json");

    await createManifest(manifestPath, {
      runId: "run-009",
      batchId: "batch-9",
      batchType: "newsletter",
      groupingReason: "Log dedupe test",
      presentedRecommendation: "filter",
      summary: { senderCount: 1, totalEmailCount: 100, averageUnreadRatio: 0.5 },
      senders: [
        {
          senderEmail: "resume@test.com",
          senderName: "Resume Test",
          emailCount: 100,
          unreadRatio: 0.5,
          lastEmailDate: "2026-03-10T00:00:00Z",
          presentedSenderType: "newsletter",
          systemRecommendation: "filter",
          userDecision: "filter",
        },
      ],
    });

    await seedSenderState(statePath, [
      makeStateEntry({
        senderEmail: "resume@test.com",
        senderName: "Resume Test",
      }),
    ]);

    await fs.writeFile(
      logPath,
      JSON.stringify(
        {
          version: 1,
          decisions: [
            {
              runId: "run-009",
              senderEmail: "resume@test.com",
              senderName: "Resume Test",
              presentedSenderType: "newsletter",
              senderTypeFeedback: "none",
              systemRecommendation: "filter",
              userDecision: "filter",
              batchId: "batch-9",
              timestamp: "2026-03-18T12:00:00Z",
              emailCount: 100,
              messagesArchived: 1,
              actionsTaken: ["filter", "archive"],
            },
          ],
        },
        null,
        2,
      ),
    );

    const gmail = makeMockGmailClient();
    const sheets = makeMockSheetsClient([makeAuditRow({ senderEmail: "resume@test.com", senderName: "Resume Test" })]);

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-1",
      gmailClient: gmail as any,
      sheetsClient: sheets as any,
      senderStatePath: statePath,
      decisionLogPath: logPath,
    });

    expect(result.ok).toBe(true);
    const logResult = await readDecisionLog(logPath);
    if (!logResult.ok || !logResult.value) throw new Error("Expected log");
    expect(logResult.value.decisions).toHaveLength(1);
  });

  it("returns an error result when onProgress throws", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0010.json");
    const logPath = path.join(TMP_DIR, "decision-log.json");
    const statePath = path.join(TMP_DIR, "sender-state.v1.json");

    await createManifest(manifestPath, {
      runId: "run-010",
      batchId: "batch-10",
      batchType: "newsletter",
      groupingReason: "Progress failure test",
      presentedRecommendation: "filter",
      summary: { senderCount: 1, totalEmailCount: 100, averageUnreadRatio: 0.5 },
      senders: [
        {
          senderEmail: "boom@test.com",
          senderName: "Boom Test",
          emailCount: 100,
          unreadRatio: 0.5,
          lastEmailDate: "2026-03-10T00:00:00Z",
          presentedSenderType: "newsletter",
          systemRecommendation: "filter",
          userDecision: "filter",
        },
      ],
    });

    await seedSenderState(statePath, [
      makeStateEntry({
        senderEmail: "boom@test.com",
        senderName: "Boom Test",
      }),
    ]);

    const result = await executeBatch({
      manifestPath,
      sheetId: "sheet-1",
      gmailClient: makeMockGmailClient() as any,
      sheetsClient: makeMockSheetsClient([makeAuditRow({ senderEmail: "boom@test.com", senderName: "Boom Test" })]) as any,
      senderStatePath: statePath,
      decisionLogPath: logPath,
      onProgress() {
        throw new Error("progress exploded");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error).toMatch(/onProgress threw/i);
  });

  describe("skipFilterCreation option", () => {
    it("does not call createFilter when skipFilterCreation is true", async () => {
      const manifestPath = path.join(TMP_DIR, "batch-skip-filter-1.json");
      const logPath = path.join(TMP_DIR, "decision-log.json");
      const statePath = path.join(TMP_DIR, "sender-state.v1.json");

      await createManifest(manifestPath, {
        runId: "run-skip-1",
        batchId: "batch-skip-1",
        batchType: "newsletter",
        groupingReason: "Skip filter creation test",
        presentedRecommendation: "filter",
        summary: { senderCount: 1, totalEmailCount: 500, averageUnreadRatio: 0.9 },
        senders: [
          {
            senderEmail: "nofilter@example.com",
            senderName: "No Filter Sender",
            emailCount: 500,
            unreadRatio: 0.9,
            lastEmailDate: "2026-03-10T00:00:00Z",
            presentedSenderType: "newsletter",
            systemRecommendation: "filter",
            userDecision: "filter",
          },
        ],
      });

      const gmail = makeMockGmailClient();
      await seedSenderState(statePath, [
        makeStateEntry({
          senderEmail: "nofilter@example.com",
          senderName: "No Filter Sender",
          emailCount: 500,
          lastEmailDate: "2026-03-10T00:00:00Z",
          unreadRatio: 0.9,
        }),
      ]);
      const sheets = makeMockSheetsClient([
        makeAuditRow({ senderEmail: "nofilter@example.com", senderName: "No Filter Sender" }),
      ]);

      const result = await executeBatch({
        manifestPath,
        sheetId: "sheet-1",
        // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
        gmailClient: gmail as any,
        // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
        sheetsClient: sheets as any,
        senderStatePath: statePath,
        decisionLogPath: logPath,
        skipFilterCreation: true,
      });

      expect(result.ok).toBe(true);
      expect(gmail.createFilter).not.toHaveBeenCalled();

      const manifest = await readManifest(manifestPath);
      if (!manifest.ok) throw new Error("Expected ok");
      expect(manifest.value.senders[0]!.filterStatus).toBe("skipped");
      expect(manifest.value.status).toBe("completed");
    });

    it("still archives messages when skipFilterCreation is true", async () => {
      const manifestPath = path.join(TMP_DIR, "batch-skip-filter-2.json");
      const logPath = path.join(TMP_DIR, "decision-log.json");
      const statePath = path.join(TMP_DIR, "sender-state.v1.json");

      await createManifest(manifestPath, {
        runId: "run-skip-2",
        batchId: "batch-skip-2",
        batchType: "newsletter",
        groupingReason: "Skip filter but archive test",
        presentedRecommendation: "filter",
        summary: { senderCount: 1, totalEmailCount: 300, averageUnreadRatio: 0.8 },
        senders: [
          {
            senderEmail: "archive-me@example.com",
            senderName: "Archive Me",
            emailCount: 300,
            unreadRatio: 0.8,
            lastEmailDate: "2026-03-10T00:00:00Z",
            presentedSenderType: "newsletter",
            systemRecommendation: "filter",
            userDecision: "filter",
          },
        ],
      });

      const gmail = makeMockGmailClient();
      await seedSenderState(statePath, [
        makeStateEntry({
          senderEmail: "archive-me@example.com",
          senderName: "Archive Me",
          emailCount: 300,
          lastEmailDate: "2026-03-10T00:00:00Z",
          unreadRatio: 0.8,
        }),
      ]);
      const sheets = makeMockSheetsClient([
        makeAuditRow({ senderEmail: "archive-me@example.com", senderName: "Archive Me" }),
      ]);

      const result = await executeBatch({
        manifestPath,
        sheetId: "sheet-1",
        // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
        gmailClient: gmail as any,
        // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
        sheetsClient: sheets as any,
        senderStatePath: statePath,
        decisionLogPath: logPath,
        skipFilterCreation: true,
      });

      expect(result.ok).toBe(true);
      expect(gmail.createFilter).not.toHaveBeenCalled();
      expect(gmail.batchModifyMessages).toHaveBeenCalled();

      const manifest = await readManifest(manifestPath);
      if (!manifest.ok) throw new Error("Expected ok");
      expect(manifest.value.senders[0]!.filterStatus).toBe("skipped");
      expect(manifest.value.senders[0]!.archiveStatus).toBe("done");
    });

    it("excludes 'filter' from actionsTaken in decision log when skipFilterCreation is true", async () => {
      const manifestPath = path.join(TMP_DIR, "batch-skip-filter-3.json");
      const logPath = path.join(TMP_DIR, "decision-log.json");
      const statePath = path.join(TMP_DIR, "sender-state.v1.json");

      await createManifest(manifestPath, {
        runId: "run-skip-3",
        batchId: "batch-skip-3",
        batchType: "newsletter",
        groupingReason: "Decision log actionsTaken test",
        presentedRecommendation: "filter",
        summary: { senderCount: 1, totalEmailCount: 400, averageUnreadRatio: 0.7 },
        senders: [
          {
            senderEmail: "logtest@example.com",
            senderName: "Log Test",
            emailCount: 400,
            unreadRatio: 0.7,
            lastEmailDate: "2026-03-10T00:00:00Z",
            presentedSenderType: "newsletter",
            systemRecommendation: "filter",
            userDecision: "filter",
          },
        ],
      });

      const gmail = makeMockGmailClient();
      await seedSenderState(statePath, [
        makeStateEntry({
          senderEmail: "logtest@example.com",
          senderName: "Log Test",
          emailCount: 400,
          lastEmailDate: "2026-03-10T00:00:00Z",
          unreadRatio: 0.7,
        }),
      ]);
      const sheets = makeMockSheetsClient([
        makeAuditRow({ senderEmail: "logtest@example.com", senderName: "Log Test" }),
      ]);

      await executeBatch({
        manifestPath,
        sheetId: "sheet-1",
        // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
        gmailClient: gmail as any,
        // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
        sheetsClient: sheets as any,
        senderStatePath: statePath,
        decisionLogPath: logPath,
        skipFilterCreation: true,
      });

      const logResult = await readDecisionLog(logPath);
      if (!logResult.ok) throw new Error("Expected ok reading decision log");
      const log = logResult.value;
      if (log === null) throw new Error("Expected decision log to exist");
      expect(log.decisions).toHaveLength(1);
      expect(log.decisions[0]!.actionsTaken).toEqual(["archive"]);
      expect(log.decisions[0]!.actionsTaken).not.toContain("filter");
    });

    it("creates filters and includes 'filter' in actionsTaken when skipFilterCreation is false", async () => {
      const manifestPath = path.join(TMP_DIR, "batch-skip-filter-4.json");
      const logPath = path.join(TMP_DIR, "decision-log.json");
      const statePath = path.join(TMP_DIR, "sender-state.v1.json");

      await createManifest(manifestPath, {
        runId: "run-skip-4",
        batchId: "batch-skip-4",
        batchType: "newsletter",
        groupingReason: "Explicit skipFilterCreation=false test",
        presentedRecommendation: "filter",
        summary: { senderCount: 1, totalEmailCount: 600, averageUnreadRatio: 0.85 },
        senders: [
          {
            senderEmail: "withfilter@example.com",
            senderName: "With Filter",
            emailCount: 600,
            unreadRatio: 0.85,
            lastEmailDate: "2026-03-10T00:00:00Z",
            presentedSenderType: "newsletter",
            systemRecommendation: "filter",
            userDecision: "filter",
          },
        ],
      });

      const gmail = makeMockGmailClient();
      await seedSenderState(statePath, [
        makeStateEntry({
          senderEmail: "withfilter@example.com",
          senderName: "With Filter",
          emailCount: 600,
          lastEmailDate: "2026-03-10T00:00:00Z",
          unreadRatio: 0.85,
        }),
      ]);
      const sheets = makeMockSheetsClient([
        makeAuditRow({ senderEmail: "withfilter@example.com", senderName: "With Filter" }),
      ]);

      const result = await executeBatch({
        manifestPath,
        sheetId: "sheet-1",
        // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
        gmailClient: gmail as any,
        // biome-ignore lint/suspicious/noExplicitAny: mock client for testing
        sheetsClient: sheets as any,
        senderStatePath: statePath,
        decisionLogPath: logPath,
        skipFilterCreation: false,
      });

      expect(result.ok).toBe(true);
      expect(gmail.createFilter).toHaveBeenCalledTimes(1);

      const logResult = await readDecisionLog(logPath);
      if (!logResult.ok) throw new Error("Expected ok reading decision log");
      const log = logResult.value;
      if (log === null) throw new Error("Expected decision log to exist");
      expect(log.decisions).toHaveLength(1);
      expect(log.decisions[0]!.actionsTaken).toContain("filter");
      expect(log.decisions[0]!.actionsTaken).toContain("archive");
    });

    it("preserves filter action on resume when the filter step already completed in a prior run", async () => {
      const manifestPath = path.join(TMP_DIR, "batch-skip-filter-5.json");
      const logPath = path.join(TMP_DIR, "decision-log.json");
      const statePath = path.join(TMP_DIR, "sender-state.v1.json");

      await createManifest(manifestPath, {
        runId: "run-skip-5",
        batchId: "batch-skip-5",
        batchType: "newsletter",
        groupingReason: "Resume after filter step succeeded",
        presentedRecommendation: "filter",
        summary: { senderCount: 1, totalEmailCount: 250, averageUnreadRatio: 0.8 },
        senders: [
          {
            senderEmail: "resume-filter@example.com",
            senderName: "Resume Filter",
            emailCount: 250,
            unreadRatio: 0.8,
            lastEmailDate: "2026-03-10T00:00:00Z",
            presentedSenderType: "newsletter",
            systemRecommendation: "filter",
            userDecision: "filter",
          },
        ],
      });

      const manifest = await readManifest(manifestPath);
      if (!manifest.ok) throw new Error("Expected manifest");
      manifest.value.senders[0] = {
        ...manifest.value.senders[0]!,
        filterApplied: true,
        filterStatus: "done",
        archiveStatus: "done",
        messagesArchived: 7,
      };
      await fs.writeFile(manifestPath, JSON.stringify(manifest.value, null, 2));

      const gmail = makeMockGmailClient();
      await seedSenderState(statePath, [
        makeStateEntry({
          senderEmail: "resume-filter@example.com",
          senderName: "Resume Filter",
          emailCount: 250,
          lastEmailDate: "2026-03-10T00:00:00Z",
          unreadRatio: 0.8,
        }),
      ]);
      const sheets = makeMockSheetsClient([
        makeAuditRow({ senderEmail: "resume-filter@example.com", senderName: "Resume Filter" }),
      ]);

      const result = await executeBatch({
        manifestPath,
        sheetId: "sheet-1",
        gmailClient: gmail as any,
        sheetsClient: sheets as any,
        senderStatePath: statePath,
        decisionLogPath: logPath,
      });

      expect(result.ok).toBe(true);
      expect(gmail.createFilter).not.toHaveBeenCalled();

      const logResult = await readDecisionLog(logPath);
      if (!logResult.ok || logResult.value === null) throw new Error("Expected decision log");
      expect(logResult.value.decisions[0]!.actionsTaken).toEqual(["filter", "archive"]);
    });
  });
});
