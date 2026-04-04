import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BatchManifestSchema } from "../../src/schemas/batch-manifest.js";
import { DecisionLogSchema } from "../../src/schemas/decision-log.js";
import { EmailMetadataSchema } from "../../src/schemas/email-metadata.js";
import { SenderStateFileSchema } from "../../src/schemas/sender-state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(`Invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function globJsonFiles(dir: string, prefix: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((e) => e.startsWith(prefix) && e.endsWith(".json")).map((e) => path.join(dir, e));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

describe("contract: generated output validates Gmail schemas", () => {
  it("batch-*.json files validate against EmailMetadataSchema", async () => {
    const batchFiles = await globJsonFiles(DATA_DIR, "batch-");
    if (batchFiles.length === 0) {
      console.log("  (skipped — no batch files generated yet)");
      return;
    }

    for (const file of batchFiles) {
      const data = await readJsonFile(file);
      expect(Array.isArray(data)).toBe(true);
      for (const item of data as unknown[]) {
        const result = EmailMetadataSchema.safeParse(item);
        expect(
          result.success,
          `${path.basename(file)}: ${JSON.stringify(result.success ? {} : result.error.issues[0])}`,
        ).toBe(true);
      }
    }
  });

  it("sender-state.v1.json validates against SenderStateFileSchema", async () => {
    const stateFile = path.join(DATA_DIR, "sender-state.v1.json");
    if (!(await fileExists(stateFile))) {
      console.log("  (skipped — sender-state.v1.json not generated yet)");
      return;
    }

    const data = await readJsonFile(stateFile);
    const result = SenderStateFileSchema.safeParse(data);
    expect(result.success, JSON.stringify(result.success ? {} : result.error.issues[0])).toBe(true);
  });

  it("decision-log.json validates against DecisionLogSchema", async () => {
    const logFile = path.join(DATA_DIR, "decision-log.json");
    if (!(await fileExists(logFile))) {
      console.log("  (skipped — decision-log.json not generated yet)");
      return;
    }

    const data = await readJsonFile(logFile);
    const result = DecisionLogSchema.safeParse(data);
    expect(result.success, JSON.stringify(result.success ? {} : result.error.issues[0])).toBe(true);
  });

  it("manifests/*.json validate against BatchManifestSchema", async () => {
    const manifestDir = path.join(DATA_DIR, "manifests");
    const manifestFiles = await globJsonFiles(manifestDir, "batch-");
    if (manifestFiles.length === 0) {
      console.log("  (skipped — no manifest files generated yet)");
      return;
    }

    for (const file of manifestFiles) {
      const data = await readJsonFile(file);
      const result = BatchManifestSchema.safeParse(data);
      expect(
        result.success,
        `${path.basename(file)}: ${JSON.stringify(result.success ? {} : result.error.issues[0])}`,
      ).toBe(true);
    }
  });
});
