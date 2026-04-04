import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DecisionEntry, DecisionLog } from "../../src/schemas/decision-log.js";
import { appendDecisions, extractFewShotContext, readDecisionLog } from "../../src/state/decision-log-manager.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "decision-log-manager-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function buildDecisionEntry(overrides: Partial<DecisionEntry> = {}): DecisionEntry {
  return {
    runId: "run-001",
    senderEmail: "sender@example.com",
    senderName: "Sender",
    presentedSenderType: "automated",
    senderTypeFeedback: "confirmed",
    systemRecommendation: "filter",
    userDecision: "filter",
    batchId: "batch-001",
    timestamp: "2026-03-24T18:00:00.000Z",
    emailCount: 5,
    messagesArchived: 5,
    actionsTaken: ["filter", "archive"],
    ...overrides,
  };
}

async function writeDecisionLog(filePath: string, log: DecisionLog): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(log, null, 2));
}

describe("decision-log-manager", () => {
  it("validates the merged decision log before writing", async () => {
    const filePath = path.join(tmpDir, "decision-log.json");
    const existingLog: DecisionLog = {
      version: 1,
      decisions: [buildDecisionEntry()],
    };
    await writeDecisionLog(filePath, existingLog);
    const originalContents = await fs.readFile(filePath, "utf-8");

    const invalidCorrectedEntry = {
      ...buildDecisionEntry({
        runId: "run-002",
        batchId: "batch-002",
        senderTypeFeedback: "corrected",
      }),
      reviewedSenderType: undefined,
    } as unknown as DecisionEntry;

    await expect(appendDecisions(filePath, [invalidCorrectedEntry])).rejects.toThrow(
      "Cannot append invalid decision log",
    );
    await expect(fs.readFile(filePath, "utf-8")).resolves.toBe(originalContents);
  });

  it("upserts repeated entries by runId, batchId, and senderEmail", async () => {
    const filePath = path.join(tmpDir, "decision-log.json");
    const originalEntry = buildDecisionEntry();
    await writeDecisionLog(filePath, { version: 1, decisions: [originalEntry] });

    await appendDecisions(filePath, [
      buildDecisionEntry({
        messagesArchived: 3,
        actionsTaken: ["filter"],
      }),
    ]);

    const logResult = await readDecisionLog(filePath);
    expect(logResult.ok).toBe(true);
    if (!logResult.ok) throw new Error("Expected ok");
    expect(logResult.value).not.toBeNull();
    expect(logResult.value?.decisions).toHaveLength(1);
    expect(logResult.value?.decisions[0]?.messagesArchived).toBe(3);
    expect(logResult.value?.decisions[0]?.actionsTaken).toEqual(["filter"]);
  });

  it("skips malformed corrected entries when extracting few-shot examples", () => {
    const malformedCorrectedEntry = {
      ...buildDecisionEntry({
        senderEmail: "broken@example.com",
        senderTypeFeedback: "corrected",
      }),
      reviewedSenderType: undefined,
    } as unknown as DecisionEntry;

    const examples = extractFewShotContext(
      [
        malformedCorrectedEntry,
        buildDecisionEntry({
          senderEmail: "valid-corrected@example.com",
          senderTypeFeedback: "corrected",
          reviewedSenderType: "newsletter",
        }),
        buildDecisionEntry({
          senderEmail: "confirmed@example.com",
          senderTypeFeedback: "confirmed",
          presentedSenderType: "human",
        }),
      ],
      3,
    );

    expect(examples).toEqual([
      {
        email: "valid-corrected@example.com",
        senderType: "newsletter",
        context: "corrected",
      },
      {
        email: "confirmed@example.com",
        senderType: "human",
        context: "confirmed",
      },
    ]);
  });

  it("throws RangeError when maxExamples is not positive", () => {
    const entry = buildDecisionEntry();

    expect(() => extractFewShotContext([entry], 0)).toThrow(RangeError);
    expect(() => extractFewShotContext([entry], -1)).toThrow(RangeError);
  });
});
