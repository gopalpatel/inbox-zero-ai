import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeSenderState, writeSenderState } from "../../src/state/sender-state-manager.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sender-state-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("writeSenderState", () => {
  it("writes valid sender state", async () => {
    const filePath = path.join(tmpDir, "sender-state.v1.json");

    await writeSenderState(filePath, {
      version: 1,
      mailbox: "mailbox@example.com",
      generatedAt: "2026-03-25T12:00:00.000Z",
      senders: [
        {
          senderEmail: "person@example.com",
          senderName: "Person",
          emailCount: 2,
          firstEmailDate: "2026-03-01T00:00:00.000Z",
          lastEmailDate: "2026-03-20T00:00:00.000Z",
          gmailCategory: "unknown",
          unreadRatio: 0,
          threadCount: 2,
          sampleSubjects: ["Hello"],
          surprisesFlag: false,
          starredCount: 0,
          importantCount: 0,
        },
      ],
    });

    const raw = await fs.readFile(filePath, "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      version: 1,
      mailbox: "mailbox@example.com",
    });
  });

  it("rejects invalid sender state before writing to disk", async () => {
    const filePath = path.join(tmpDir, "sender-state.v1.json");

    await expect(
      writeSenderState(filePath, {
        version: 1,
        mailbox: "mailbox@example.com",
        generatedAt: "2026-03-25T12:00:00.000Z",
        senders: [
          {
            senderEmail: "duplicate@example.com",
            senderName: "Duplicate One",
            emailCount: 1,
            firstEmailDate: "2026-03-01T00:00:00.000Z",
            lastEmailDate: "2026-03-20T00:00:00.000Z",
            gmailCategory: "unknown",
            unreadRatio: 0,
            threadCount: 1,
            sampleSubjects: ["Hello"],
            surprisesFlag: false,
            starredCount: 0,
            importantCount: 0,
          },
          {
            senderEmail: "DUPLICATE@example.com",
            senderName: "Duplicate Two",
            emailCount: 1,
            firstEmailDate: "2026-03-02T00:00:00.000Z",
            lastEmailDate: "2026-03-21T00:00:00.000Z",
            gmailCategory: "unknown",
            unreadRatio: 0,
            threadCount: 1,
            sampleSubjects: ["Hi"],
            surprisesFlag: false,
            starredCount: 0,
            importantCount: 0,
          },
        ],
      }),
    ).rejects.toThrow(/invalid sender state/i);

    await expect(fs.access(filePath)).rejects.toThrow();
  });
});

describe("mergeSenderState", () => {
  it("preserves persisted optional fields while refreshing deterministic stats", () => {
    const merged = mergeSenderState(
      [
        {
          senderEmail: "sender@example.com",
          senderName: "Fresh Name",
          emailCount: 12,
          firstEmailDate: "2026-03-01T00:00:00.000Z",
          lastEmailDate: "2026-03-20T00:00:00.000Z",
          gmailCategory: "unknown",
          unreadRatio: 0.25,
          threadCount: 4,
          sampleSubjects: ["Fresh subject"],
          surprisesFlag: false,
          starredCount: 1,
          importantCount: 2,
        },
      ],
      [
        {
          senderEmail: "sender@example.com",
          senderName: "Old Name",
          emailCount: 3,
          firstEmailDate: "2025-12-01T00:00:00.000Z",
          lastEmailDate: "2026-02-01T00:00:00.000Z",
          gmailCategory: "unknown",
          unreadRatio: 0,
          threadCount: 1,
          sampleSubjects: ["Old subject"],
          surprisesFlag: false,
          starredCount: 0,
          importantCount: 0,
          confidenceTier: "definitely_keep",
          recommendedAction: "keep",
          userDecision: "keep",
          senderType: "human",
          senderTypeConfidence: 1,
          senderTypeSource: "user",
          reviewedSenderType: "human",
          reviewedAt: "2026-03-10T00:00:00.000Z",
          processedAt: "2026-03-11T00:00:00.000Z",
        },
      ],
    );

    expect(merged).toEqual([
      expect.objectContaining({
        senderEmail: "sender@example.com",
        senderName: "Fresh Name",
        emailCount: 12,
        sampleSubjects: ["Fresh subject"],
        confidenceTier: "definitely_keep",
        recommendedAction: "keep",
        userDecision: "keep",
        senderType: "human",
        senderTypeConfidence: 1,
        senderTypeSource: "user",
        reviewedSenderType: "human",
        reviewedAt: "2026-03-10T00:00:00.000Z",
        processedAt: "2026-03-11T00:00:00.000Z",
      }),
    ]);
  });
});
