// tests/state/batch-manifest-manager.test.ts

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  advanceSenderStep,
  completeManifest,
  createManifest,
  readManifest,
  renderBrief,
} from "../../src/state/batch-manifest-manager.js";

const TMP_DIR = path.join(import.meta.dirname, "../../.test-tmp-manifest");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCreateInput() {
  return {
    runId: "run-001",
    batchId: "newsletter-batch-1",
    batchType: "newsletter" as const,
    groupingReason: "Highest-volume newsletter senders, sorted by email count descending",
    presentedRecommendation: "unsubscribe" as const,
    summary: { senderCount: 1, totalEmailCount: 2340, averageUnreadRatio: 0.94 },
    senders: [
      {
        senderEmail: "news@example.com",
        senderName: "Example News",
        emailCount: 2340,
        unreadRatio: 0.94,
        lastEmailDate: "2026-03-10T00:00:00Z",
        presentedSenderType: "newsletter" as const,
        systemRecommendation: "unsubscribe" as const,
        userDecision: "unsubscribe" as const,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
  await fs.mkdir(TMP_DIR, { recursive: true });
});

// ---------------------------------------------------------------------------
// createManifest
// ---------------------------------------------------------------------------

describe("createManifest", () => {
  it("creates a manifest with prepared status and pending steps", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0001.json");
    await createManifest(manifestPath, makeCreateInput());

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error(`Expected ok, got: ${manifest.error}`);

    expect(manifest.value.status).toBe("prepared");
    expect(manifest.value.version).toBe(1);
  });

  it("sets all step fields to pending for each sender", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0001.json");
    await createManifest(manifestPath, makeCreateInput());

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error(`Expected ok`);

    const sender = manifest.value.senders[0]!;
    expect(sender.filterStatus).toBe("pending");
    expect(sender.archiveStatus).toBe("pending");
    expect(sender.logStatus).toBe("pending");
    expect(sender.stateStatus).toBe("pending");
    expect(sender.sheetStatus).toBe("pending");
    expect(sender.filterApplied).toBe(false);
    expect(sender.messagesArchived).toBe(0);
  });

  it("stores the provided runId, batchId, batchType, groupingReason, and presentedRecommendation", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0001.json");
    await createManifest(manifestPath, makeCreateInput());

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");

    expect(manifest.value.runId).toBe("run-001");
    expect(manifest.value.batchId).toBe("newsletter-batch-1");
    expect(manifest.value.batchType).toBe("newsletter");
    expect(manifest.value.groupingReason).toBe("Highest-volume newsletter senders, sorted by email count descending");
    expect(manifest.value.presentedRecommendation).toBe("unsubscribe");
  });

  it("stores the provided summary", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0001.json");
    await createManifest(manifestPath, makeCreateInput());

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");

    expect(manifest.value.summary.senderCount).toBe(1);
    expect(manifest.value.summary.totalEmailCount).toBe(2340);
    expect(manifest.value.summary.averageUnreadRatio).toBe(0.94);
  });

  it("stores optional reviewedSenderType when provided", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0001.json");
    const input = makeCreateInput();
    input.senders = [
      {
        ...input.senders[0]!,
        // @ts-expect-error — reviewedSenderType is optional in the input union
        reviewedSenderType: "company",
      },
    ];
    await createManifest(manifestPath, input);

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");

    expect(manifest.value.senders[0]!.reviewedSenderType).toBe("company");
  });

  it("creates parent directories if they don't exist", async () => {
    const nestedPath = path.join(TMP_DIR, "nested", "deep", "batch.json");
    await createManifest(nestedPath, makeCreateInput());

    const manifest = await readManifest(nestedPath);
    expect(manifest.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readManifest
// ---------------------------------------------------------------------------

describe("readManifest", () => {
  it("returns ok: false for a missing file", async () => {
    const result = await readManifest(path.join(TMP_DIR, "missing.json"));
    expect(result.ok).toBe(false);
  });

  it("returns ok: false for invalid JSON", async () => {
    const filePath = path.join(TMP_DIR, "bad.json");
    await fs.writeFile(filePath, "{ not valid json %%%");
    const result = await readManifest(filePath);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error.length).toBeGreaterThan(0);
  });

  it("returns ok: false for JSON that fails schema validation", async () => {
    const filePath = path.join(TMP_DIR, "bad-schema.json");
    await fs.writeFile(filePath, JSON.stringify({ version: 99, status: "bogus" }));
    const result = await readManifest(filePath);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// advanceSenderStep
// ---------------------------------------------------------------------------

describe("advanceSenderStep", () => {
  it("updates a specific step for a sender", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0001.json");
    await createManifest(manifestPath, {
      runId: "run-001",
      batchId: "batch-1",
      batchType: "newsletter",
      groupingReason: "Highest-volume newsletter senders, sorted by email count descending",
      presentedRecommendation: "filter",
      summary: { senderCount: 1, totalEmailCount: 500, averageUnreadRatio: 0.8 },
      senders: [
        {
          senderEmail: "a@test.com",
          senderName: "Example A",
          emailCount: 500,
          unreadRatio: 0.8,
          lastEmailDate: "2026-03-10T00:00:00Z",
          presentedSenderType: "newsletter",
          systemRecommendation: "filter",
          userDecision: "filter",
        },
      ],
    });

    await advanceSenderStep(manifestPath, "a@test.com", "filterStatus", "done");

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");
    expect(manifest.value.senders[0]!.filterStatus).toBe("done");
  });

  it("does not modify other step fields when updating one step", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0001.json");
    await createManifest(manifestPath, makeCreateInput());

    await advanceSenderStep(manifestPath, "news@example.com", "archiveStatus", "done");

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");
    const sender = manifest.value.senders[0]!;
    expect(sender.archiveStatus).toBe("done");
    expect(sender.filterStatus).toBe("pending"); // untouched
    expect(sender.logStatus).toBe("pending"); // untouched
  });

  it("allows setting log/state/sheet steps to done", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0001.json");
    await createManifest(manifestPath, makeCreateInput());

    await advanceSenderStep(manifestPath, "news@example.com", "logStatus", "done");
    await advanceSenderStep(manifestPath, "news@example.com", "stateStatus", "done");
    await advanceSenderStep(manifestPath, "news@example.com", "sheetStatus", "done");

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");
    const sender = manifest.value.senders[0]!;
    expect(sender.logStatus).toBe("done");
    expect(sender.stateStatus).toBe("done");
    expect(sender.sheetStatus).toBe("done");
  });

  it("handles multiple senders — only updates the targeted sender", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-multi.json");
    await createManifest(manifestPath, {
      runId: "run-001",
      batchId: "batch-multi",
      batchType: "newsletter",
      groupingReason: "Multi-sender test",
      presentedRecommendation: "filter",
      summary: { senderCount: 2, totalEmailCount: 100, averageUnreadRatio: 0.5 },
      senders: [
        {
          senderEmail: "alpha@test.com",
          senderName: "Alpha",
          emailCount: 60,
          unreadRatio: 0.6,
          lastEmailDate: "2026-03-10T00:00:00Z",
          presentedSenderType: "newsletter",
          systemRecommendation: "filter",
          userDecision: "filter",
        },
        {
          senderEmail: "beta@test.com",
          senderName: "Beta",
          emailCount: 40,
          unreadRatio: 0.4,
          lastEmailDate: "2026-03-10T00:00:00Z",
          presentedSenderType: "newsletter",
          systemRecommendation: "filter",
          userDecision: "filter",
        },
      ],
    });

    await advanceSenderStep(manifestPath, "alpha@test.com", "filterStatus", "done");

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");
    const alpha = manifest.value.senders.find((s) => s.senderEmail === "alpha@test.com")!;
    const beta = manifest.value.senders.find((s) => s.senderEmail === "beta@test.com")!;
    expect(alpha.filterStatus).toBe("done");
    expect(beta.filterStatus).toBe("pending"); // untouched
  });
});

// ---------------------------------------------------------------------------
// completeManifest
// ---------------------------------------------------------------------------

describe("completeManifest", () => {
  it("sets status to completed", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0001.json");
    await createManifest(manifestPath, makeCreateInput());

    await completeManifest(manifestPath);

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");
    expect(manifest.value.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// renderBrief
// ---------------------------------------------------------------------------

describe("renderBrief", () => {
  it("produces markdown with batch summary", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0001.json");
    await createManifest(manifestPath, makeCreateInput());

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");
    const brief = renderBrief(manifest.value);

    expect(brief).toContain("newsletter-batch-1");
    expect(brief).toContain("news@example.com");
    expect(brief).toContain("2,340");
    expect(brief).toContain("94%");
    expect(brief).toContain("prepared");
  });

  it("includes runId in the brief", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0001.json");
    await createManifest(manifestPath, makeCreateInput());

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");
    const brief = renderBrief(manifest.value);

    expect(brief).toContain("run-001");
  });

  it("includes batch type and grouping reason", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0001.json");
    await createManifest(manifestPath, makeCreateInput());

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");
    const brief = renderBrief(manifest.value);

    expect(brief).toContain("newsletter");
    expect(brief).toContain("Highest-volume newsletter senders");
  });

  it("includes presented recommendation", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0001.json");
    await createManifest(manifestPath, makeCreateInput());

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");
    const brief = renderBrief(manifest.value);

    expect(brief).toContain("unsubscribe");
  });

  it("notes type corrections when reviewedSenderType differs from presentedSenderType", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-corrected.json");
    const input = makeCreateInput();
    // Override the single sender to have a type correction
    await createManifest(manifestPath, {
      ...input,
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
          // @ts-expect-error — optional field injected for this test
          reviewedSenderType: "company",
        },
      ],
    });

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");
    const brief = renderBrief(manifest.value);

    expect(brief).toContain("company");
  });

  it("includes safety note about manifest winning over brief", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0001.json");
    await createManifest(manifestPath, makeCreateInput());

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");
    const brief = renderBrief(manifest.value);

    expect(brief).toContain("manifest wins");
  });

  it("includes sender name in the brief", async () => {
    const manifestPath = path.join(TMP_DIR, "batch-0001.json");
    await createManifest(manifestPath, makeCreateInput());

    const manifest = await readManifest(manifestPath);
    if (!manifest.ok) throw new Error("Expected ok");
    const brief = renderBrief(manifest.value);

    expect(brief).toContain("Example News");
  });
});
