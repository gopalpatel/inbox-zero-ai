import { describe, expect, it } from "vitest";
import { BatchManifestSchema } from "../../src/schemas/batch-manifest.js";

describe("BatchManifestSchema", () => {
  const validManifest = {
    version: 1,
    runId: "run-001",
    batchId: "newsletter-batch-1",
    batchType: "newsletter",
    groupingReason: "Highest-volume newsletter senders, sorted by email count descending",
    presentedRecommendation: "unsubscribe",
    summary: {
      senderCount: 1,
      totalEmailCount: 2340,
      averageUnreadRatio: 0.94,
    },
    status: "prepared",
    createdAt: "2026-03-18T14:00:00Z",
    senders: [
      {
        senderEmail: "news@example.com",
        senderName: "Example News",
        emailCount: 2340,
        unreadRatio: 0.94,
        lastEmailDate: "2026-03-10T00:00:00Z",
        presentedSenderType: "newsletter",
        systemRecommendation: "unsubscribe",
        userDecision: "unsubscribe",
        filterApplied: false,
        filterStatus: "pending",
        archiveStatus: "pending",
        logStatus: "pending",
        stateStatus: "pending",
        sheetStatus: "pending",
        messagesArchived: 0,
      },
    ],
  };

  it("accepts a valid prepared manifest", () => {
    expect(BatchManifestSchema.safeParse(validManifest).success).toBe(true);
  });

  it("accepts manifest with reviewedSenderType", () => {
    const m = {
      ...validManifest,
      senders: [{ ...validManifest.senders[0]!, reviewedSenderType: "company" }],
    };
    expect(BatchManifestSchema.safeParse(m).success).toBe(true);
  });

  it("accepts manifest without filterApplied for backward compatibility", () => {
    const sender = { ...validManifest.senders[0]! };
    delete (sender as { filterApplied?: boolean }).filterApplied;
    const m = {
      ...validManifest,
      senders: [sender],
    };
    expect(BatchManifestSchema.safeParse(m).success).toBe(true);
  });

  it("rejects invalid status", () => {
    expect(BatchManifestSchema.safeParse({ ...validManifest, status: "running" }).success).toBe(false);
  });

  it("rejects duplicate senderEmail entries", () => {
    const duplicateManifest = {
      ...validManifest,
      senders: [validManifest.senders[0], { ...validManifest.senders[0]! }],
    };

    expect(BatchManifestSchema.safeParse(duplicateManifest).success).toBe(false);
  });

  for (const status of ["prepared", "executing", "completed", "failed"]) {
    it(`accepts status "${status}"`, () => {
      expect(BatchManifestSchema.safeParse({ ...validManifest, status }).success).toBe(true);
    });
  }
});
