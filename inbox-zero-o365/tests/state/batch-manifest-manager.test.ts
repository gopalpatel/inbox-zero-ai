import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BatchManifest } from "../../src/schemas/batch-manifest.js";
import { advanceSenderStep, createManifest } from "../../src/state/batch-manifest-manager.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "batch-manifest-manager-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("batch-manifest-manager", () => {
  it("re-validates the manifest before persisting sender step updates", async () => {
    const filePath = path.join(tmpDir, "manifest.json");
    await createManifest(filePath, {
      runId: "run-001",
      batchId: "batch-001",
      batchType: "automated",
      groupingReason: "test",
      presentedRecommendation: "filter",
      senders: [
        {
          senderEmail: "sender@example.com",
          senderName: "Sender",
          emailCount: 10,
          unreadRatio: 0.5,
          lastEmailDate: "2026-03-25T00:00:00.000Z",
          presentedSenderType: "automated",
          systemRecommendation: "filter",
          userDecision: "filter",
        },
      ],
    });

    await expect(
      advanceSenderStep(filePath, "sender@example.com", "logStatus", "skipped" as unknown as "pending" | "done"),
    ).rejects.toThrow(/schema validation/i);

    const manifest = JSON.parse(await fs.readFile(filePath, "utf-8")) as BatchManifest;
    expect(manifest.senders[0]?.logStatus).toBe("pending");
  });
});
