// tests/state/sender-state-manager.test.ts

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { SenderStateEntry, SenderStateFile } from "../../src/schemas/sender-state.js";
import { mergeSenderState, readSenderState, writeSenderState } from "../../src/state/sender-state-manager.js";

const TMP_DIR = path.join(import.meta.dirname, "../../.test-tmp-state");

function makeEntry(overrides: Partial<SenderStateEntry> = {}): SenderStateEntry {
  return {
    senderEmail: "test@example.com",
    senderName: "Test",
    emailCount: 10,
    firstEmailDate: "2025-01-01T00:00:00.000Z",
    lastEmailDate: "2026-03-01T00:00:00.000Z",
    gmailCategory: "primary",
    unreadRatio: 0.2,
    threadCount: 5,
    sampleSubjects: ["Hello"],
    surprisesFlag: false,
    starredCount: 0,
    importantCount: 0,
    ...overrides,
  };
}

describe("sender-state-manager", () => {
  beforeEach(async () => {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
    await fs.mkdir(TMP_DIR, { recursive: true });
  });

  describe("writeSenderState + readSenderState", () => {
    it("returns ok + null when the state file does not exist", async () => {
      const loaded = await readSenderState(path.join(TMP_DIR, "missing.json"));
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) throw new Error("Expected ok");
      expect(loaded.value).toBeNull();
    });

    it("round-trips a valid state file", async () => {
      const state: SenderStateFile = {
        version: 1,
        mailbox: "mailbox@example.com",
        generatedAt: new Date().toISOString(),
        senders: [makeEntry()],
      };
      const filePath = path.join(TMP_DIR, "sender-state.v1.json");
      await writeSenderState(filePath, state);
      const loaded = await readSenderState(filePath);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) throw new Error("Expected ok");
      if (!loaded.value) throw new Error("Expected state");
      expect(loaded.value.senders).toHaveLength(1);
      expect(loaded.value.senders[0]!.senderEmail).toBe("test@example.com");
    });

    it("returns error for corrupt state file", async () => {
      const filePath = path.join(TMP_DIR, "sender-state.v1.json");
      await fs.writeFile(filePath, "{not valid json");
      const loaded = await readSenderState(filePath);
      expect(loaded.ok).toBe(false);
    });
  });

  describe("mergeSenderState", () => {
    it("carries forward enrichment fields from existing state", () => {
      const existing = [
        makeEntry({
          senderEmail: "a@test.com",
          senderType: "newsletter",
          senderTypeConfidence: 0.9,
          senderTypeSource: "heuristic",
          processedAt: "2026-03-18T12:00:00Z",
        }),
      ];
      const fresh = [
        makeEntry({
          senderEmail: "a@test.com",
          emailCount: 15, // updated count
        }),
      ];
      const merged = mergeSenderState(fresh, existing);
      expect(merged).toHaveLength(1);
      expect(merged[0]!.emailCount).toBe(15); // refreshed
      expect(merged[0]!.senderType).toBe("newsletter"); // carried forward
      expect(merged[0]!.processedAt).toBe("2026-03-18T12:00:00Z"); // carried forward
    });

    it("drops senders that disappeared from fresh pull", () => {
      const existing = [makeEntry({ senderEmail: "gone@test.com" })];
      const fresh: SenderStateEntry[] = [];
      const merged = mergeSenderState(fresh, existing);
      expect(merged).toHaveLength(0);
    });

    it("adds new senders from fresh pull", () => {
      const existing: SenderStateEntry[] = [];
      const fresh = [makeEntry({ senderEmail: "new@test.com" })];
      const merged = mergeSenderState(fresh, existing);
      expect(merged).toHaveLength(1);
      expect(merged[0]!.senderEmail).toBe("new@test.com");
    });

    it("user-reviewed senderType is never overwritten", () => {
      const existing = [
        makeEntry({
          senderEmail: "a@test.com",
          senderType: "company",
          senderTypeSource: "user",
          reviewedSenderType: "company",
        }),
      ];
      const fresh = [makeEntry({ senderEmail: "a@test.com" })];
      const merged = mergeSenderState(fresh, existing);
      expect(merged[0]!.senderType).toBe("company");
      expect(merged[0]!.senderTypeSource).toBe("user");
    });

    it("LLM result with higher confidence does not overwrite user-corrected type", () => {
      const existing = [
        makeEntry({
          senderEmail: "a@test.com",
          senderType: "company",
          senderTypeSource: "user",
          reviewedSenderType: "company",
          reviewedAt: "2026-03-18T10:00:00Z",
        }),
      ];
      const fresh = [
        makeEntry({
          senderEmail: "a@test.com",
          senderType: "newsletter",
          senderTypeConfidence: 0.95,
          senderTypeSource: "llm",
        }),
      ];

      const merged = mergeSenderState(fresh, existing);
      expect(merged[0]!.senderType).toBe("company");
      expect(merged[0]!.senderTypeSource).toBe("user");
      expect(merged[0]!.reviewedSenderType).toBe("company");
      expect(merged[0]!.reviewedAt).toBe("2026-03-18T10:00:00Z");
      expect(merged[0]!.senderTypeConfidence).not.toBe(0.95);
    });

    it("keeps the higher-confidence LLM classification when both sources are llm", () => {
      const existing = [
        makeEntry({
          senderEmail: "a@test.com",
          senderType: "company",
          senderTypeConfidence: 0.9,
          senderTypeSource: "llm",
        }),
      ];
      const fresh = [
        makeEntry({
          senderEmail: "a@test.com",
          senderType: "newsletter",
          senderTypeConfidence: 0.7,
          senderTypeSource: "llm",
        }),
      ];

      const merged = mergeSenderState(fresh, existing);
      expect(merged[0]!.senderType).toBe("company");
      expect(merged[0]!.senderTypeConfidence).toBe(0.9);
      expect(merged[0]!.senderTypeSource).toBe("llm");
    });

    it("accepts a fresher higher-confidence LLM classification", () => {
      const existing = [
        makeEntry({
          senderEmail: "a@test.com",
          senderType: "company",
          senderTypeConfidence: 0.6,
          senderTypeSource: "llm",
        }),
      ];
      const fresh = [
        makeEntry({
          senderEmail: "a@test.com",
          senderType: "newsletter",
          senderTypeConfidence: 0.8,
          senderTypeSource: "llm",
        }),
      ];

      const merged = mergeSenderState(fresh, existing);
      expect(merged[0]!.senderType).toBe("newsletter");
      expect(merged[0]!.senderTypeConfidence).toBe(0.8);
      expect(merged[0]!.senderTypeSource).toBe("llm");
    });
  });
});
