#!/usr/bin/env node

/**
 * cli.ts
 *
 * Commander-based CLI entry point for the inbox-zero-o365 toolchain.
 * Thin orchestration layer — no business logic.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { toErrorMessage } from "./utils.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/** Default data directory relative to the project root. */
export const DEFAULT_DATA_DIR = "./data";

let envLoaded = false;

async function loadDotEnv(): Promise<void> {
  if (envLoaded) return;
  envLoaded = true;

  const envPath = path.resolve(".env");

  let raw: string;
  try {
    raw = await fs.readFile(envPath, "utf8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw err;
  }

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Env-var helpers
// ---------------------------------------------------------------------------

/**
 * Returns the value of an environment variable.
 * Exits with code 1 and a helpful error message if the variable is unset.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    console.error(`Error: required environment variable ${name} is not set.`);
    process.exit(1);
  }
  return value;
}

/**
 * Returns the resolved data directory from DATA_DIR env var or the default.
 */
export function resolveDataDir(): string {
  const value = process.env["DATA_DIR"]?.trim();
  return value !== undefined && value.length > 0 ? value : DEFAULT_DATA_DIR;
}

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

export function wrapAction(fn: (...args: unknown[]) => Promise<void>) {
  return async (...args: unknown[]) => {
    try {
      await loadDotEnv();
      await fn(...args);
    } catch (err: unknown) {
      console.error(`Fatal: ${toErrorMessage(err)}`);
      process.exit(1);
    }
  };
}

// ---------------------------------------------------------------------------
// CLI program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("inbox-zero-o365")
  .description("O365 inbox zero toolchain — metadata pull, sender audit, noise removal")
  .version("1.0.0");

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

program
  .command("smoke-test")
  .description("Verify Graph API connection to O365 tenant")
  .action(
    wrapAction(async () => {
      const { runSmokeTest } = await import("./auth/smoke-test.js");
      await runSmokeTest();
    }),
  );

program
  .command("pull")
  .description("Pull email metadata from O365 mailbox")
  .option("--dry-run", "Estimate message count without pulling")
  .action(
    wrapAction(async (opts: unknown) => {
      const { dryRun } = opts as { dryRun?: boolean };
      const { createGraphClient } = await import("./auth/graph-client.js");
      const { pullMetadata } = await import("./pull/metadata-puller.js");
      const graph = await createGraphClient();
      const dataDir = resolveDataDir();
      const result = await pullMetadata({ graph, dataDir, dryRun });
      if (!result.ok) {
        console.error("Pull failed:", result.error);
        process.exit(1);
      }
      console.log(
        `Pull complete: ${result.value.totalPulled} messages, ${result.value.batchesSaved} batches, ${result.value.totalErrors} errors`,
      );
    }),
  );

program
  .command("get-message")
  .description("Fetch a full O365 message by exported immutable message ID")
  .requiredOption("--id <id>", "Immutable Graph message ID")
  .action(
    wrapAction(async (opts: unknown) => {
      const { id } = opts as { id: string };
      const { createGraphClient } = await import("./auth/graph-client.js");
      const graph = await createGraphClient();
      const result = await graph.getMessage(id);
      if (!result.ok) {
        console.error("Get message failed:", result.error);
        process.exit(1);
      }
      console.log(JSON.stringify(result.value, null, 2));
    }),
  );

program
  .command("analyze")
  .description("Analyze pulled metadata to generate sender statistics")
  .action(
    wrapAction(async () => {
      const { analyzeSenders } = await import("./analysis/sender-analyzer.js");
      const { scoreAll } = await import("./analysis/confidence-scorer.js");
      const { readSenderState, writeSenderState, mergeSenderState } = await import("./state/sender-state-manager.js");
      const { EmailMetadataSchema } = await import("./schemas/email-metadata.js");

      const dataDir = resolveDataDir();
      const statePath = path.join(dataDir, "sender-state.v1.json");
      const mailbox = requireEnv("O365_USER_EMAIL");

      // Load batch files
      const entries = await fs.readdir(dataDir);
      const batchFiles = entries.filter((e) => e.startsWith("batch-") && e.endsWith(".json")).sort();
      if (batchFiles.length === 0) {
        console.error("No batch files found in", dataDir);
        process.exit(1);
      }

      console.log(`Loading ${batchFiles.length} batch files...`);
      const emails = [];
      for (const file of batchFiles) {
        const raw = await fs.readFile(path.join(dataDir, file), "utf-8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          throw new Error(`Batch file ${file} must contain a JSON array`);
        }

        for (const [index, item] of parsed.entries()) {
          const result = EmailMetadataSchema.safeParse(item);
          if (!result.success) {
            const itemRecord = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : null;
            const itemId = typeof itemRecord?.["messageId"] === "string" ? itemRecord["messageId"] : undefined;
            const firstIssue = result.error.issues[0];
            const pathSuffix =
              firstIssue !== undefined && firstIssue.path.length > 0 ? ` at ${firstIssue.path.join(".")}` : "";
            const idSuffix = itemId !== undefined ? ` (${itemId})` : "";
            throw new Error(
              `Invalid EmailMetadata in ${file}[${index}]${idSuffix}${pathSuffix}: ${firstIssue?.message ?? result.error.message}`,
            );
          }

          emails.push(result.data);
        }
      }
      console.log(`Loaded ${emails.length} emails from ${batchFiles.length} batches`);

      // Analyze
      const freshStats = analyzeSenders(emails);
      console.log(`Analyzed ${freshStats.length} unique senders`);

      // Score confidence
      const scored = scoreAll(freshStats);

      // Merge with existing state
      const existing = await readSenderState(statePath);
      if (!existing.ok) {
        console.error("Failed to read sender state:", existing.error);
        process.exit(1);
      }
      const existingSenders = existing.value ? existing.value.senders : [];
      const merged = mergeSenderState(scored, existingSenders);

      // Write state
      const state = {
        version: 1 as const,
        mailbox,
        generatedAt: new Date().toISOString(),
        senders: merged,
      };
      await writeSenderState(statePath, state);
      console.log(`Wrote sender state: ${merged.length} senders → ${statePath}`);
    }),
  );

program
  .command("enrich")
  .description("Enrich sender state with heuristic + LLM classification")
  .option("--skip-llm", "Skip LLM classification (heuristic only)")
  .option("--sheet-title <title>", "Google Sheets audit report title")
  .action(
    wrapAction(async (opts: unknown) => {
      const { skipLlm, sheetTitle } = opts as { skipLlm?: boolean; sheetTitle?: string };
      const { readSenderState, writeSenderState } = await import("./state/sender-state-manager.js");
      const { enrichSenders } = await import("./enrichment/enrich-senders.js");
      const { createLlmSenderProvider } = await import("./enrichment/llm-sender-classifier.js");
      const { readDecisionLog, extractFewShotContext } = await import("./state/decision-log-manager.js");
      const { createAuditReport } = await import("./analysis/sheets-reporter.js");
      const { createSheetsClient } = await import("./auth/sheets-client.js");

      const dataDir = resolveDataDir();
      const statePath = path.join(dataDir, "sender-state.v1.json");
      const decisionLogPath = path.join(dataDir, "decision-log.json");
      const mailbox = requireEnv("O365_USER_EMAIL");

      // Read sender state
      const stateResult = await readSenderState(statePath);
      if (!stateResult.ok) {
        console.error("Failed to read sender state:", stateResult.error);
        process.exit(1);
      }
      if (!stateResult.value) {
        console.error("No sender state found. Run 'analyze' first.");
        process.exit(1);
      }

      const senders = stateResult.value.senders;
      console.log(`Enriching ${senders.length} senders...`);

      // Build few-shot examples from decision log
      const logResult = await readDecisionLog(decisionLogPath);
      if (!logResult.ok) {
        console.error("Failed to read decision log:", logResult.error);
        process.exit(1);
      }
      const fewShotExamples = logResult.value ? extractFewShotContext(logResult.value.decisions, 20) : [];

      // Create LLM provider if not skipped
      const llmProvider = skipLlm ? undefined : createLlmSenderProvider(requireEnv("ANTHROPIC_API_KEY"));

      // Run enrichment
      const enriched = await enrichSenders(senders, {
        llmProvider,
        fewShotExamples,
        onProgress: (info) => console.log(`  ${info.phase}: ${info.processed}/${info.total}`),
      });

      // Write enriched state
      const state = {
        version: 1 as const,
        mailbox,
        generatedAt: new Date().toISOString(),
        senders: enriched,
      };
      await writeSenderState(statePath, state);
      console.log(`Wrote enriched state: ${enriched.length} senders`);

      // Create Sheets report if title provided or by default
      if (sheetTitle !== undefined || !skipLlm) {
        try {
          const sheetsClient = await createSheetsClient();
          const title = sheetTitle ?? `O365 Audit — ${mailbox}`;
          const reportResult = await createAuditReport(enriched, sheetsClient, title);
          if (reportResult.ok) {
            console.log(`Audit report: ${reportResult.value.spreadsheetUrl}`);
          } else {
            console.error("Failed to create Sheets report:", reportResult.error);
          }
        } catch (err) {
          console.error(
            "Sheets report skipped (auth not configured):",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }),
  );

program
  .command("execute-batch")
  .description("Execute a batch manifest against O365 mailbox")
  .requiredOption("--manifest <path>", "Path to batch manifest JSON file")
  .requiredOption("--sheet-id <id>", "Google Sheets spreadsheet ID for audit updates")
  .option("--dry-run", "Validate inputs only; do not mutate mailbox, manifests, logs, state, or sheets")
  .action(
    wrapAction(async (opts: unknown) => {
      const { manifest, sheetId, dryRun } = opts as { manifest: string; sheetId: string; dryRun?: boolean };
      const { createGraphClient } = await import("./auth/graph-client.js");
      const { createSheetsClient } = await import("./auth/sheets-client.js");
      const { executeBatch } = await import("./review/execute-batch.js");

      const dataDir = resolveDataDir();
      const graph = await createGraphClient();
      const sheetsClient = await createSheetsClient();

      const result = await executeBatch({
        manifestPath: manifest,
        sheetId,
        graph,
        sheetsClient,
        senderStatePath: path.join(dataDir, "sender-state.v1.json"),
        decisionLogPath: path.join(dataDir, "decision-log.json"),
        dryRun,
        onProgress: (info) => console.log(`  ${info.sender}: ${info.step} → ${info.status}`),
      });

      if (!result.ok) {
        console.error("Execute batch failed:", result.error);
        process.exit(1);
      }

      console.log(
        `Done: ${result.value.sendersProcessed} senders, ${result.value.messagesArchived} archived, ${result.value.rulesCreated} rules created`,
      );
    }),
  );

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  program.parse();
}
