// tests/state/decision-log-manager.test.ts

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { DecisionEntry } from "../../src/schemas/decision-log.js";
import {
  appendDecisions,
  collectNoiseSenders,
  extractFewShotContext,
  latestDecisionsBySender,
  readDecisionLog,
} from "../../src/state/decision-log-manager.js";

const TMP_DIR = path.join(import.meta.dirname, "../../.test-tmp-log");

function makeDecision(overrides: Partial<DecisionEntry> = {}): DecisionEntry {
  return {
    runId: "run-001",
    senderEmail: "test@example.com",
    senderName: "Test",
    presentedSenderType: "newsletter",
    senderTypeFeedback: "none",
    systemRecommendation: "filter",
    userDecision: "filter",
    batchId: "batch-1",
    timestamp: new Date().toISOString(),
    emailCount: 100,
    messagesArchived: 0,
    actionsTaken: ["filter_created"],
    ...overrides,
  };
}

describe("decision-log-manager", () => {
  beforeEach(async () => {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
    await fs.mkdir(TMP_DIR, { recursive: true });
  });

  it("returns ok + null when the log file does not exist", async () => {
    const log = await readDecisionLog(path.join(TMP_DIR, "missing.json"));
    expect(log.ok).toBe(true);
    if (!log.ok) throw new Error("Expected ok");
    expect(log.value).toBeNull();
  });

  it("creates log file if it does not exist", async () => {
    const logPath = path.join(TMP_DIR, "decision-log.json");
    await appendDecisions(logPath, [makeDecision()]);
    const log = await readDecisionLog(logPath);
    expect(log.ok).toBe(true);
    if (!log.ok) throw new Error("Expected ok");
    if (!log.value) throw new Error("Expected log");
    expect(log.value.decisions).toHaveLength(1);
  });

  it("appends to existing log", async () => {
    const logPath = path.join(TMP_DIR, "decision-log.json");
    await appendDecisions(logPath, [makeDecision({ senderEmail: "a@test.com" })]);
    await appendDecisions(logPath, [makeDecision({ senderEmail: "b@test.com" })]);
    const log = await readDecisionLog(logPath);
    if (!log.ok) throw new Error("Expected ok");
    if (!log.value) throw new Error("Expected log");
    expect(log.value.decisions).toHaveLength(2);
  });

  it("returns error for corrupt log file", async () => {
    const logPath = path.join(TMP_DIR, "decision-log.json");
    await fs.writeFile(logPath, "{not valid json");
    const log = await readDecisionLog(logPath);
    expect(log.ok).toBe(false);
  });

  describe("extractFewShotContext", () => {
    it("returns only entries with senderTypeFeedback !== 'none'", () => {
      const decisions = [
        makeDecision({ senderTypeFeedback: "none" }),
        makeDecision({ senderTypeFeedback: "confirmed", senderEmail: "a@test.com" }),
        makeDecision({ senderTypeFeedback: "corrected", senderEmail: "b@test.com", reviewedSenderType: "human" }),
      ];
      const examples = extractFewShotContext(decisions, 50);
      expect(examples).toHaveLength(2);
    });

    it("prioritizes corrected over confirmed", () => {
      const decisions = Array.from({ length: 60 }, (_, i) =>
        makeDecision({
          senderEmail: `s${i}@test.com`,
          senderTypeFeedback: i < 30 ? "corrected" : "confirmed",
        }),
      );
      const examples = extractFewShotContext(decisions, 50);
      const correctedCount = examples.filter((e) => e.context.includes("corrected")).length;
      expect(correctedCount).toBe(30); // all corrected included
    });

    it("limits to maxExamples", () => {
      const decisions = Array.from({ length: 100 }, (_, i) =>
        makeDecision({ senderEmail: `s${i}@test.com`, senderTypeFeedback: "confirmed" }),
      );
      const examples = extractFewShotContext(decisions, 50);
      expect(examples).toHaveLength(50);
    });

    it("throws for non-positive maxExamples", () => {
      expect(() => extractFewShotContext([makeDecision()], 0)).toThrow(/maxExamples/i);
      expect(() => extractFewShotContext([makeDecision()], -1)).toThrow(/maxExamples/i);
    });
  });

  describe("latestDecisionsBySender", () => {
    it("treats sender emails case-insensitively", () => {
      const older = makeDecision({
        senderEmail: "News@Example.com",
        userDecision: "filter",
        timestamp: "2026-03-18T00:00:00Z",
      });
      const newer = makeDecision({
        senderEmail: "news@example.com",
        userDecision: "keep",
        timestamp: "2026-03-19T00:00:00Z",
      });

      const latest = latestDecisionsBySender([older, newer]);
      expect(latest.size).toBe(1);
      expect(latest.get("news@example.com")?.userDecision).toBe("keep");
    });
  });

  describe("collectNoiseSenders", () => {
    it("returns lowercased, sorted latest noise senders only", async () => {
      const logPath = path.join(TMP_DIR, "decision-log.json");
      await appendDecisions(logPath, [
        makeDecision({
          senderEmail: "B@Example.com",
          userDecision: "filter",
          timestamp: "2026-03-18T00:00:00Z",
        }),
        makeDecision({
          senderEmail: "a@example.com",
          userDecision: "unsubscribe",
          timestamp: "2026-03-18T00:00:00Z",
        }),
        makeDecision({
          senderEmail: "b@example.com",
          userDecision: "keep",
          timestamp: "2026-03-19T00:00:00Z",
        }),
      ]);

      const result = await collectNoiseSenders(logPath);
      expect(result.ok).toBe(true);
      if (!result.ok || result.value === null) {
        throw new Error("Expected noise senders");
      }

      expect(result.value.filterSenders).toEqual([]);
      expect(result.value.unsubscribeSenders).toEqual(["a@example.com"]);
      expect(result.value.allNoiseSenders).toEqual(["a@example.com"]);
    });
  });
});
