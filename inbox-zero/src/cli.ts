#!/usr/bin/env node

/**
 * cli.ts
 *
 * Commander-based CLI entry point for the inbox-zero toolchain.
 *
 * Each subcommand:
 * - Loads config from environment variables (process.env)
 * - Validates required env vars before doing any work
 * - Calls the appropriate pipeline module
 * - Reports progress to stdout
 * - Exits 0 on success, 1 on failure
 *
 * Design decisions:
 * - This file is intentionally a thin orchestration layer — no business logic.
 * - Never logs API keys or credentials.
 * - All subcommand handlers are async; unhandled rejections are caught and
 *   converted to process.exit(1) calls.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Command } from "commander";
import { toErrorMessage } from "./utils.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/** Default data directory relative to the project root. */
const DEFAULT_DATA_DIR = "./data";

/** Default reports directory relative to the project root. */
const DEFAULT_REPORTS_DIR = "./reports";

/** Default rules config path. */
const DEFAULT_RULES_PATH = "./data/classification-rules.json";

/** Default taxonomy proposal artifact path, relative to DATA_DIR. */
const PROPOSED_TAXONOMY_FILENAME = "proposed-taxonomy.json";

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
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    console.error(`Error: required environment variable ${name} is not set.`);
    process.exit(1);
  }
  return value;
}

/**
 * Returns the value of an optional environment variable, or undefined.
 */
function optionalEnv(name: string): string | undefined {
  return process.env[name] ?? undefined;
}

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

/**
 * Wraps a subcommand handler to catch unexpected rejections and exit cleanly.
 */
function runCommand(fn: () => Promise<void>): void {
  (async () => {
    await loadDotEnv();
    await fn();
  })().catch((err: unknown) => {
    console.error("Fatal error:", toErrorMessage(err));
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// CLI program
// ---------------------------------------------------------------------------

const program = new Command();

program.name("inbox-zero").description("Gmail inbox-zero toolchain").version("1.0.0");

// ---------------------------------------------------------------------------
// pull — fetch Gmail metadata
// ---------------------------------------------------------------------------

program
  .command("pull")
  .description("Fetch Gmail message metadata and save to disk")
  .option("--dry-run", "Estimate total without saving data")
  .action((opts: { dryRun?: boolean }) => {
    runCommand(async () => {
      const { createGmailClient } = await import("./auth/gmail-client.js");
      const { pull } = await import("./pull/metadata-puller.js");

      const dataDir = optionalEnv("DATA_DIR") ?? DEFAULT_DATA_DIR;

      console.log(`Pulling Gmail metadata → ${dataDir}${opts.dryRun === true ? " (dry-run)" : ""}`);

      const client = await createGmailClient();

      const result = await pull({
        client,
        dataDir,
        dryRun: opts.dryRun === true,
        onProgress({ fetched, batchesSaved }) {
          console.log(`  Fetched ${fetched} messages, ${batchesSaved} batches saved`);
        },
      });

      if (!result.ok) {
        console.error("pull failed:", result.error);
        process.exit(1);
      }

      const { messagesFetched, batchesSaved, errors, resultSizeEstimate } = result.value;

      if (opts.dryRun === true) {
        console.log(`Estimated total messages: ${resultSizeEstimate ?? "unknown"}`);
      } else {
        console.log(`Done. Fetched ${messagesFetched} messages in ${batchesSaved} batches.`);
        if (errors.length > 0) {
          console.warn(`  Errors recorded: ${errors.length}`);
        }
      }
    });
  });

// ---------------------------------------------------------------------------
// backfill — recover failed message-level metadata pulls
// ---------------------------------------------------------------------------

program
  .command("backfill")
  .description("Recover failed message-level metadata pulls from a completed checkpoint")
  .option("--restart", "Discard any in-progress backfill run and start from current checkpoint errors")
  .action((opts: { restart?: boolean }) => {
    runCommand(async () => {
      const { createGmailClient } = await import("./auth/gmail-client.js");
      const { backfill } = await import("./pull/backfill.js");

      const dataDir = optionalEnv("DATA_DIR") ?? DEFAULT_DATA_DIR;

      console.log(`Backfilling failed messages from ${dataDir}…`);

      const client = await createGmailClient();

      const result = await backfill({
        client,
        dataDir,
        restart: opts.restart === true,
        onProgress({ processed, total, recovered, stillFailing, phase }) {
          console.log(
            `  Backfill [${phase}]: ${processed}/${total} processed, ${recovered} recovered, ${stillFailing} still failing`,
          );
        },
      });

      if (!result.ok) {
        console.error("Backfill failed:", result.error);
        process.exit(1);
      }

      const { runId, totalIds, recovered, stillFailing, shardsWritten, reportPath } = result.value;
      console.log(
        `Done. Backfill run ${runId}: ${recovered}/${totalIds} recovered, ${stillFailing} still failing, ${shardsWritten} shards written.`,
      );
      if (stillFailing > 0) {
        console.log(`Report: ${reportPath}`);
      }
    });
  });

// ---------------------------------------------------------------------------
// Shared enrichment pipeline — used by both `analyze` and `enrich` commands
// ---------------------------------------------------------------------------

async function runEnrichmentPipeline(options: {
  dataDir: string;
  skipLlm: boolean;
  sheetTitle: string;
}): Promise<void> {
  const { loadAllBatches } = await import("./pull/checkpoint-manager.js");
  const { analyzeSenders } = await import("./analysis/sender-analyzer.js");
  const { enrichSenders } = await import("./enrichment/enrich-senders.js");
  const { scoreAll } = await import("./analysis/confidence-scorer.js");
  const { createAuditReport } = await import("./analysis/sheets-reporter.js");
  const { createGmailClient } = await import("./auth/gmail-client.js");
  const { createSheetsClient } = await import("./auth/sheets-client.js");
  const { readSenderState, writeSenderState, mergeSenderState } = await import("./state/sender-state-manager.js");
  const { readDecisionLog, extractFewShotContext } = await import("./state/decision-log-manager.js");
  const { createLlmSenderProvider } = await import("./enrichment/llm-sender-classifier.js");

  const { dataDir, skipLlm, sheetTitle } = options;
  const senderStatePath = `${dataDir}/sender-state.v1.json`;
  const decisionLogPath = `${dataDir}/decision-log.json`;

  // 1. Load and analyze
  console.log(`Loading batches from ${dataDir}…`);
  const loadResult = await loadAllBatches(dataDir);
  if (!loadResult.ok) {
    console.error("Failed to load batches:", loadResult.error);
    process.exit(1);
  }

  const emails = loadResult.value;
  console.log(`Loaded ${emails.length} emails. Analyzing senders…`);

  const freshStats = analyzeSenders(emails);
  console.log(`Found ${freshStats.length} unique senders.`);

  // 2. Merge with existing state
  const existingState = await readSenderState(senderStatePath);
  if (!existingState.ok) {
    console.error(`Failed to read sender state: ${existingState.error}`);
    process.exit(1);
  }
  const merged = existingState.value ? mergeSenderState(freshStats, existingState.value.senders) : freshStats;
  console.log(`${merged.length} senders (${existingState.value ? "merged with existing state" : "fresh"}).`);

  // 3. Enrich
  const llmProvider = !skipLlm ? createLlmSenderProvider(requireEnv("ANTHROPIC_API_KEY")) : undefined;

  const logResult = await readDecisionLog(decisionLogPath);
  if (!logResult.ok) {
    console.error(`Failed to read decision log: ${logResult.error}`);
    process.exit(1);
  }
  const fewShotExamples = logResult.value ? extractFewShotContext(logResult.value.decisions, 50) : [];

  const mailbox =
    existingState.value?.mailbox ??
    (await (async () => {
      const gmailClient = await createGmailClient();
      const profile = await gmailClient.getProfile();
      if (!profile.ok) {
        console.error(`Failed to read Gmail profile: ${profile.error}`);
        process.exit(1);
      }
      return profile.value.emailAddress;
    })());

  console.log(`Enriching senders${skipLlm ? " (heuristics only)" : ""}…`);
  const enriched = await enrichSenders(merged, {
    llmProvider,
    fewShotExamples,
    onProgress({ phase, processed, total }) {
      console.log(`  [${phase}] ${processed}/${total}`);
    },
  });

  // 4. Score
  console.log("Scoring…");
  const scored = scoreAll(enriched);

  // 5. Persist sender state
  await writeSenderState(senderStatePath, {
    version: 1,
    mailbox,
    generatedAt: new Date().toISOString(),
    senders: scored,
  });
  console.log(`Sender state saved to ${senderStatePath}`);

  // 6. Write audit sheet
  console.log(`Creating audit sheet "${sheetTitle}"…`);
  const sheetsClient = await createSheetsClient();
  const reportResult = await createAuditReport(scored, sheetsClient, sheetTitle);

  if (!reportResult.ok) {
    console.error("Failed to create audit report:", reportResult.error);
    process.exit(1);
  }

  console.log(`Done. Spreadsheet: ${reportResult.value.spreadsheetUrl}`);

  // 7. Summary
  const types = { human: 0, company: 0, newsletter: 0, automated: 0, unknown: 0 };
  for (const s of scored) {
    const t = s.senderType ?? "unknown";
    if (t in types) types[t as keyof typeof types]++;
  }
  console.log("Sender type breakdown:");
  for (const [type, count] of Object.entries(types)) {
    console.log(`  ${type}: ${count}`);
  }
}

// ---------------------------------------------------------------------------
// analyze — build sender stats + enrichment + audit sheet
// ---------------------------------------------------------------------------

program
  .command("analyze")
  .description("Analyze senders, enrich with type classification, and write Google Sheets audit report")
  .option("--skip-llm", "Skip LLM classification, use heuristics only")
  .option("--sheet-title <title>", "Title for the audit spreadsheet")
  .action((opts: { skipLlm?: boolean; sheetTitle?: string }) => {
    runCommand(async () => {
      await runEnrichmentPipeline({
        dataDir: optionalEnv("DATA_DIR") ?? DEFAULT_DATA_DIR,
        skipLlm: opts.skipLlm === true,
        sheetTitle: opts.sheetTitle ?? `Gmail Audit — ${new Date().toISOString().slice(0, 10)}`,
      });
    });
  });

// ---------------------------------------------------------------------------
// enrich — enrich senders with type classification + regenerate audit sheet
// ---------------------------------------------------------------------------

program
  .command("enrich")
  .description("Enrich senders with type classification and regenerate audit sheet")
  .option("--skip-llm", "Skip LLM classification, use heuristics only")
  .option("--sheet-title <title>", "Title for the audit spreadsheet")
  .action((opts: { skipLlm?: boolean; sheetTitle?: string }) => {
    runCommand(async () => {
      await runEnrichmentPipeline({
        dataDir: optionalEnv("DATA_DIR") ?? DEFAULT_DATA_DIR,
        skipLlm: opts.skipLlm === true,
        sheetTitle: opts.sheetTitle ?? `Gmail Audit — ${new Date().toISOString().slice(0, 10)}`,
      });
    });
  });

// ---------------------------------------------------------------------------
// execute-batch — execute a frozen batch manifest
// ---------------------------------------------------------------------------

program
  .command("execute-batch")
  .description("Execute a frozen batch manifest (filter + archive approved senders)")
  .requiredOption("--manifest <path>", "Path to batch manifest JSON")
  .requiredOption("--sheet-id <id>", "Audit spreadsheet ID for updates")
  .action((opts: { manifest: string; sheetId: string }) => {
    runCommand(async () => {
      const { createGmailClient } = await import("./auth/gmail-client.js");
      const { createSheetsClient } = await import("./auth/sheets-client.js");
      const { executeBatch } = await import("./review/execute-batch.js");

      const dataDir = optionalEnv("DATA_DIR") ?? DEFAULT_DATA_DIR;

      console.log(`Executing batch manifest: ${opts.manifest}`);
      const gmailClient = await createGmailClient();
      const sheetsClient = await createSheetsClient();

      const result = await executeBatch({
        manifestPath: opts.manifest,
        sheetId: opts.sheetId,
        gmailClient,
        sheetsClient,
        senderStatePath: `${dataDir}/sender-state.v1.json`,
        decisionLogPath: `${dataDir}/decision-log.json`,
        onProgress({ sender, step, status }) {
          console.log(`  ${sender}: ${step} → ${status}`);
        },
      });

      if (!result.ok) {
        console.error("Batch execution failed:", result.error);
        process.exit(1);
      }
      console.log(`Done. Filters: ${result.value.filtersCreated}, Archived: ${result.value.messagesArchived}`);
    });
  });

// ---------------------------------------------------------------------------
// clean — archive noise senders from Sheets decisions
// ---------------------------------------------------------------------------

program
  .command("clean")
  .description("Archive noise senders based on Sheets decisions")
  .requiredOption("--sheet-id <id>", "Google Sheets spreadsheet ID with decisions")
  .option("--dry-run", "Report changes without archiving")
  .action((opts: { sheetId: string; dryRun?: boolean }) => {
    runCommand(async () => {
      const { createGmailClient } = await import("./auth/gmail-client.js");
      const { createSheetsClient } = await import("./auth/sheets-client.js");
      const { readDecisions } = await import("./noise/sheets-reader.js");
      const { batchCreateFilters } = await import("./noise/filter-creator.js");
      const { archiveNoiseSenders } = await import("./noise/noise-remover.js");

      console.log(`Cleaning noise senders from sheet ${opts.sheetId}${opts.dryRun === true ? " (dry-run)" : ""}…`);

      const gmailClient = await createGmailClient();
      const sheetsClient = await createSheetsClient();

      // readDecisions(client, spreadsheetId) — note: client first, then sheetId
      const decisionsResult = await readDecisions(sheetsClient, opts.sheetId);
      if (!decisionsResult.ok) {
        console.error("Failed to read decisions:", decisionsResult.error);
        process.exit(1);
      }

      const decisions = decisionsResult.value;
      // Build a Map<sender, "filter" | "unsubscribe"> for batchCreateFilters
      const filterSendersMap = new Map<string, "filter" | "unsubscribe">();
      const unsubscribeSenders: string[] = [];
      const allNoiseSenders: string[] = [];

      for (const [sender, decision] of decisions) {
        if (decision === "filter") {
          filterSendersMap.set(sender, "filter");
          allNoiseSenders.push(sender);
        } else if (decision === "unsubscribe") {
          filterSendersMap.set(sender, "unsubscribe");
          unsubscribeSenders.push(sender);
          allNoiseSenders.push(sender);
        }
      }

      console.log(`  ${allNoiseSenders.length} senders to filter/archive`);

      if (opts.dryRun === true) {
        console.log("Dry-run: no changes applied.");
        return;
      }

      // batchCreateFilters(client, senders: Map<string, "filter" | "unsubscribe">, options?)
      // It handles ensureNoiseLabel internally. Returns BatchCreateFiltersResult directly (not Result).
      if (filterSendersMap.size > 0) {
        console.log("Creating Gmail filters…");
        const filtersResult = await batchCreateFilters(gmailClient, filterSendersMap);
        console.log(`  Created ${filtersResult.created} filters`);
        if (filtersResult.failures.length > 0) {
          console.warn(`  Filter creation failures: ${filtersResult.failures.length}`);
        }
      }

      // Archive historical messages — need noise label ID for archiveNoiseSenders
      const { ensureNoiseLabel } = await import("./noise/filter-creator.js");
      const noiseLabelResult = await ensureNoiseLabel(gmailClient);
      if (!noiseLabelResult.ok) {
        console.error("Failed to ensure noise label:", noiseLabelResult.error);
        process.exit(1);
      }

      const noiseLabelId = noiseLabelResult.value;

      console.log("Archiving historical messages…");
      const archiveResult = await archiveNoiseSenders(gmailClient, allNoiseSenders, noiseLabelId, {
        onProgress({ sender, messagesArchived, currentSenderIndex, totalSenders }) {
          console.log(`  [${currentSenderIndex + 1}/${totalSenders}] ${sender}: ${messagesArchived} archived`);
        },
      });

      console.log(`Done. Total archived: ${archiveResult.totalArchived}`);
      if (archiveResult.failures.length > 0) {
        console.warn(`  Failures: ${archiveResult.failures.length}`);
      }
    });
  });

// ---------------------------------------------------------------------------
// sweep — archive noise emails from inbox using decision log
// ---------------------------------------------------------------------------

program
  .command("sweep")
  .description("Archive noise emails from inbox using decision log")
  .option("--dry-run", "Show what would be swept without making changes")
  .option("--max-senders-per-query <n>", "Max senders per Gmail query", "25")
  .option("--max-query-chars <n>", "Max chars per Gmail query", "1200")
  .action((opts: { dryRun?: boolean; maxSendersPerQuery?: string; maxQueryChars?: string }) => {
    runCommand(async () => {
      const { createGmailClient } = await import("./auth/gmail-client.js");
      const { ensureNoiseLabel } = await import("./noise/filter-creator.js");
      const { sweep } = await import("./noise/sweep.js");

      const dataDir = optionalEnv("DATA_DIR") ?? DEFAULT_DATA_DIR;
      const decisionLogPath = `${dataDir}/decision-log.json`;
      const dryRun = opts.dryRun === true;
      const maxSendersPerQuery = parseInt(opts.maxSendersPerQuery ?? "25", 10);
      const maxQueryChars = parseInt(opts.maxQueryChars ?? "1200", 10);

      if (Number.isNaN(maxSendersPerQuery) || maxSendersPerQuery <= 0) {
        console.error("--max-senders-per-query must be a positive number");
        process.exit(1);
      }
      if (Number.isNaN(maxQueryChars) || maxQueryChars <= 0) {
        console.error("--max-query-chars must be a positive number");
        process.exit(1);
      }

      console.log(`Sweeping noise from inbox${dryRun ? " (dry-run)" : ""}…`);

      const gmailClient = await createGmailClient();

      // Skip label creation in dry-run mode to avoid mutating Gmail state
      let noiseLabelId = "placeholder-dry-run";
      if (!dryRun) {
        const noiseLabelResult = await ensureNoiseLabel(gmailClient);
        if (!noiseLabelResult.ok) {
          console.error("Failed to ensure noise label:", noiseLabelResult.error);
          process.exit(1);
        }
        noiseLabelId = noiseLabelResult.value;
      }

      const result = await sweep({
        gmailClient,
        decisionLogPath,
        noiseLabelId,
        maxSendersPerQuery,
        maxQueryChars,
        dryRun,
        onProgress({ queriesSent, messagesSwept }) {
          console.log(`  Queries: ${queriesSent}, Messages swept: ${messagesSwept}`);
        },
      });

      if (!result.ok) {
        console.error("Sweep failed:", result.error);
        process.exit(1);
      }

      const { queriesSent, messagesFound, messagesSwept, errors } = result.value;

      if (dryRun) {
        console.log(`Dry run: found ${messagesFound} messages from noise senders in ${queriesSent} queries.`);
      } else {
        console.log(`Swept ${messagesSwept} messages from noise senders in ${queriesSent} queries.`);
      }

      if (errors.length > 0) {
        console.warn(`  Errors: ${errors.length}`);
        for (const err of errors) {
          console.warn(`    ${err}`);
        }
      }
    });
  });

// ---------------------------------------------------------------------------
// migrate-filters — consolidate per-sender noise filters into batched queries
// ---------------------------------------------------------------------------

program
  .command("migrate-filters")
  .description("Consolidate per-sender noise filters into batched query-based filters")
  .option("--dry-run", "Report what would change without making changes")
  .option("--execute", "Actually create/delete filters (required to mutate)")
  .option("--delete-first", "Delete per-sender filters before creating consolidated replacements")
  .action((opts: { dryRun?: boolean; execute?: boolean; deleteFirst?: boolean }) => {
    runCommand(async () => {
      const { createGmailClient } = await import("./auth/gmail-client.js");
      const { ensureNoiseLabel, findNoiseLabelId } = await import("./noise/filter-creator.js");
      const { migrateFilters, getDeleteFirstPlanPath, readDeleteFirstPlan } = await import(
        "./noise/filter-consolidator.js"
      );

      const dataDir = optionalEnv("DATA_DIR") ?? DEFAULT_DATA_DIR;
      const decisionLogPath = `${dataDir}/decision-log.json`;
      const dryRun = opts.dryRun === true;
      const execute = opts.execute === true;
      const deleteFirst = opts.deleteFirst === true;

      if (dryRun && execute) {
        console.error("Cannot use --dry-run and --execute together.");
        process.exit(1);
      }

      const filterMode: "dry-run" | "execute" = execute ? "execute" : "dry-run";
      let deleteFirstSnapshotNoiseLabelId: string | undefined;

      if (deleteFirst) {
        const snapshotPath = getDeleteFirstPlanPath(decisionLogPath);
        const existingPlan = await readDeleteFirstPlan(snapshotPath);
        if (existingPlan.ok && existingPlan.value !== null) {
          deleteFirstSnapshotNoiseLabelId = existingPlan.value.noiseLabelId;
          console.log(`Resuming existing delete-first migration from snapshot: ${snapshotPath}`);
        } else if (existingPlan.ok) {
          console.log(`Starting new delete-first migration (${filterMode})…`);
        } else {
          console.error(`Corrupt delete-first snapshot at ${snapshotPath}: ${existingPlan.error}`);
          console.error("Inspect or remove the snapshot file manually, then retry.");
          process.exit(1);
        }
      } else {
        console.log(`Migrating noise filters (${filterMode})…`);
      }

      const gmailClient = await createGmailClient();

      let noiseLabelId: string;
      if (deleteFirstSnapshotNoiseLabelId !== undefined) {
        noiseLabelId = deleteFirstSnapshotNoiseLabelId;
      } else if (execute) {
        const noiseLabelResult = await ensureNoiseLabel(gmailClient);
        if (!noiseLabelResult.ok) {
          console.error("Failed to ensure noise label:", noiseLabelResult.error);
          process.exit(1);
        }
        noiseLabelId = noiseLabelResult.value;
      } else {
        // Regression fix: dry-run still needs the real _noise label id so
        // migrate-filters can match existing filters accurately. Only label
        // creation is skipped in dry-run mode.
        const noiseLabelResult = await findNoiseLabelId(gmailClient);
        if (!noiseLabelResult.ok) {
          console.error("Failed to look up existing noise label:", noiseLabelResult.error);
          process.exit(1);
        }
        if (noiseLabelResult.value === null) {
          console.log("Dry run: _noise label not found, so there are no existing pipeline-managed filters to migrate.");
          return;
        }
        noiseLabelId = noiseLabelResult.value;
      }

      const result = await migrateFilters(gmailClient, decisionLogPath, noiseLabelId, {
        mode: filterMode,
        deleteFirst,
      });

      if (!result.ok) {
        console.error("Migration failed:", result.error);
        if (deleteFirst) {
          const snapshotPath = getDeleteFirstPlanPath(decisionLogPath);
          console.error(`Snapshot preserved at ${snapshotPath} — rerun the same command to resume.`);
        }
        process.exit(1);
      }

      const { filtersCreated, filtersDeleted, slotsFreed, errors } = result.value;

      if (!execute) {
        console.log(
          `Dry run: would create ${filtersCreated} consolidated filters, delete ${filtersDeleted} per-sender filters, freeing ${slotsFreed} slots.`,
        );
      } else {
        console.log(`Created ${filtersCreated} consolidated filters, deleted ${filtersDeleted} per-sender filters.`);
        console.log(`Net slots freed: ${slotsFreed}`);
      }

      if (errors.length > 0) {
        console.warn(`  Errors: ${errors.length}`);
        for (const err of errors) {
          console.warn(`    ${err}`);
        }
      }
    });
  });

// ---------------------------------------------------------------------------
// classify — run rule engine + LLM classifier
// ---------------------------------------------------------------------------

program
  .command("classify")
  .description("Classify email threads with rule engine and/or LLM")
  .option("--dry-run", "Classify but skip label application")
  .option("--rules-only", "Skip LLM, use rule engine only")
  .option("--propose-taxonomy", "Use LLM to propose a category taxonomy")
  .action((opts: { dryRun?: boolean; rulesOnly?: boolean; proposeTaxonomy?: boolean }) => {
    runCommand(async () => {
      const { createGmailClient } = await import("./auth/gmail-client.js");
      const { loadAllBatches } = await import("./pull/checkpoint-manager.js");
      const { pullBodies } = await import("./classify/body-puller.js");
      const { collapseThreads } = await import("./classify/thread-collapser.js");
      const { loadRules, classify } = await import("./classify/rule-engine.js");
      const { AnthropicProvider, proposeTaxonomy } = await import("./classify/llm-classifier.js");
      const { runClassification } = await import("./classify/run-classification.js");
      const { ensureLabelsExist, applyClassifications } = await import("./classify/label-applier.js");

      const dataDir = optionalEnv("DATA_DIR") ?? DEFAULT_DATA_DIR;
      const rulesPath = optionalEnv("RULES_PATH") ?? DEFAULT_RULES_PATH;
      const apiKey = opts.rulesOnly !== true || opts.proposeTaxonomy === true ? requireEnv("ANTHROPIC_API_KEY") : "";

      console.log(
        `Classifying threads${opts.dryRun === true ? " (dry-run)" : ""}${opts.rulesOnly === true ? " (rules-only)" : ""}…`,
      );

      const gmailClient = await createGmailClient();

      // 1. Load metadata batches
      const loadResult = await loadAllBatches(dataDir);
      if (!loadResult.ok) {
        console.error("Failed to load batches:", loadResult.error);
        process.exit(1);
      }

      const emails = loadResult.value;
      console.log(`Loaded ${emails.length} emails.`);

      const rulesResult = loadRules(rulesPath);

      if (opts.rulesOnly === true && !rulesResult.ok) {
        console.error("--rules-only requires a valid rules config, but loadRules failed:", rulesResult.error);
        process.exit(1);
      }

      // Build thread -> messageId map once so both proposal mode and full
      // classification can work from the same metadata set.
      const threadMsgMap = new Map<string, string[]>();
      for (const email of emails) {
        const existing = threadMsgMap.get(email.threadId) ?? [];
        existing.push(email.messageId);
        threadMsgMap.set(email.threadId, existing);
      }

      if (opts.proposeTaxonomy === true) {
        console.log("Proposing taxonomy from a representative thread sample…");

        const metadataOnlyThreads = collapseThreads(emails, new Map());
        const candidateThreads = rulesResult.ok
          ? metadataOnlyThreads.filter((thread) => classify(thread, rulesResult.value) === null)
          : metadataOnlyThreads;
        const sampleThreads = candidateThreads.slice(0, 1000);
        const proposedTaxonomyPath = path.join(dataDir, PROPOSED_TAXONOMY_FILENAME);

        if (sampleThreads.length === 0) {
          await fs.mkdir(dataDir, { recursive: true });
          await fs.writeFile(proposedTaxonomyPath, JSON.stringify([], null, 2), "utf8");
          console.warn("No unmatched threads available for taxonomy proposal.");
          console.log(`Saved empty taxonomy proposal to ${proposedTaxonomyPath}`);
          return;
        }

        const sampleThreadIds = new Set(sampleThreads.map((thread) => thread.threadId));
        const sampleMessageIds = sampleThreads.flatMap((thread) => threadMsgMap.get(thread.threadId) ?? []);

        const sampleBodiesResult = await pullBodies({
          messageIds: sampleMessageIds,
          client: gmailClient,
          dataDir: path.join(dataDir, "taxonomy-sample"),
        });

        if (!sampleBodiesResult.ok) {
          console.error("Failed to pull sample bodies:", sampleBodiesResult.error);
          process.exit(1);
        }

        const sampleEmails = emails.filter((email) => sampleThreadIds.has(email.threadId));
        const sampledThreadsWithBodies = collapseThreads(sampleEmails, sampleBodiesResult.value);

        const provider = new AnthropicProvider({ apiKey });
        const taxonomy = await proposeTaxonomy(sampledThreadsWithBodies, provider);

        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(proposedTaxonomyPath, JSON.stringify(taxonomy, null, 2), "utf8");

        console.log(`Saved proposed taxonomy to ${proposedTaxonomyPath}`);
        if (taxonomy.length > 0) {
          console.log("Proposed categories:");
          for (const cat of taxonomy) {
            console.log(`  - ${cat}`);
          }
        } else {
          console.warn("Taxonomy proposal returned no categories.");
        }
        return;
      }

      const provider = opts.rulesOnly === true ? undefined : new AnthropicProvider({ apiKey });

      const pipelineResult = await runClassification({
        client: gmailClient,
        emails,
        dataDir,
        rulesConfig: rulesResult.ok ? rulesResult.value : undefined,
        provider,
      });

      if (!pipelineResult.ok) {
        console.error("Failed to classify threads:", pipelineResult.error);
        process.exit(1);
      }

      const {
        allClassifications,
        threadToMessageIds,
        threadCount,
        ruleClassifiedCount,
        llmClassifiedCount,
        unmatchedCount,
        pulledBodyCount,
      } = pipelineResult.value;

      console.log(`Collapsed to ${threadCount} threads (metadata only).`);
      console.log(`Rule engine: ${ruleClassifiedCount} classified, ${unmatchedCount} unmatched.`);
      if (opts.rulesOnly !== true && unmatchedCount > 0) {
        console.log(`Pulled ${pulledBodyCount} message bodies for ${unmatchedCount} unmatched threads.`);
      }
      if (opts.rulesOnly === true && unmatchedCount > 0) {
        console.warn(`Rules-only mode left ${unmatchedCount} thread(s) unmatched and unlabeled.`);
      }
      if (llmClassifiedCount > 0) {
        console.log(`LLM classified ${llmClassifiedCount} unmatched threads.`);
      }

      console.log(`Total classified: ${allClassifications.length} threads.`);

      if (opts.dryRun === true) {
        console.log("Dry-run: skipping label application.");
        return;
      }

      // 7. Apply labels
      const categories = [...new Set(allClassifications.map((c) => c.category))];
      console.log(`Ensuring ${categories.length} category labels exist…`);

      const labelResult = await ensureLabelsExist(categories, gmailClient);
      if (!labelResult.ok) {
        console.error("Failed to ensure labels:", labelResult.error);
        process.exit(1);
      }

      const labelMap = labelResult.value;

      const applyResult = await applyClassifications(allClassifications, threadToMessageIds, labelMap, gmailClient, {
        onProgress({ applied, total }) {
          if (applied % 100 === 0 || applied === total) {
            console.log(`  Applied: ${applied}/${total}`);
          }
        },
      });

      if (!applyResult.ok) {
        console.error("Failed to apply classifications:", applyResult.error);
        process.exit(1);
      }

      const summary = applyResult.value;
      if (summary.failures.length > 0) {
        console.error(`Failed to apply classifications: ${summary.failures.join("; ")}`);
        process.exit(1);
      }
      console.log(`Done. Archived: ${summary.totalArchived}, Triaged: ${summary.totalTriaged}`);
    });
  });

// ---------------------------------------------------------------------------
// review — build action-pass report and/or apply decisions
// ---------------------------------------------------------------------------

program
  .command("review")
  .description("Build action-pass review report or apply star/archive decisions")
  .option("--report-only", "Only build the report, do not apply decisions")
  .option("--decisions <file>", "Path to a JSON file mapping thread/message IDs to 'star' | 'archive'")
  .action((opts: { reportOnly?: boolean; decisions?: string }) => {
    runCommand(async () => {
      const { createGmailClient } = await import("./auth/gmail-client.js");
      const { buildActionReport, finalizeReview } = await import("./review/action-pass.js");
      const { TRIAGE_LABEL } = await import("./classify/label-applier.js");

      const reportsDir = optionalEnv("REPORTS_DIR") ?? DEFAULT_REPORTS_DIR;

      console.log("Building action-pass report…");

      const gmailClient = await createGmailClient();

      const reportResult = await buildActionReport(gmailClient, reportsDir);
      if (!reportResult.ok) {
        console.error("Failed to build report:", reportResult.error);
        process.exit(1);
      }

      const { reportPath, itemCount } = reportResult.value;
      console.log(`Report written to ${reportPath} (${itemCount} items)`);

      if (opts.reportOnly === true || opts.decisions === undefined) {
        return;
      }

      // Load decisions file
      let decisionsRaw: string;
      try {
        decisionsRaw = await fs.readFile(opts.decisions, "utf8");
      } catch (err: unknown) {
        console.error("Failed to read decisions file:", toErrorMessage(err));
        process.exit(1);
      }

      let decisionsObj: Record<string, unknown>;
      try {
        decisionsObj = JSON.parse(decisionsRaw) as Record<string, unknown>;
      } catch {
        console.error("Decisions file is not valid JSON");
        process.exit(1);
      }

      const decisions = new Map<string, "star" | "archive">();
      for (const [reviewId, decision] of Object.entries(decisionsObj)) {
        if (decision !== "star" && decision !== "archive") {
          console.error(`Invalid decision "${String(decision)}" for item ${reviewId}. Must be "star" or "archive".`);
          process.exit(1);
        }
        decisions.set(reviewId, decision);
      }

      // Resolve triage label ID
      const labelsResult = await gmailClient.listLabels();
      if (!labelsResult.ok) {
        console.error("Failed to list labels:", labelsResult.error);
        process.exit(1);
      }

      const triageLabel = labelsResult.value.find((l) => l.name === TRIAGE_LABEL);
      if (triageLabel === undefined || triageLabel.id === undefined || triageLabel.id === null) {
        console.error(`Could not find Gmail label "${TRIAGE_LABEL}". Run 'classify' first.`);
        process.exit(1);
      }

      console.log(`Finalizing ${decisions.size} decisions…`);

      const finalizeResult = await finalizeReview(decisions, triageLabel.id, gmailClient);
      if (!finalizeResult.ok) {
        console.error("Failed to finalize review:", finalizeResult.error);
        process.exit(1);
      }

      const { starred, archived } = finalizeResult.value;
      console.log(`Done. Starred: ${starred}, Archived: ${archived}`);
    });
  });

// ---------------------------------------------------------------------------
// digest — generate a daily email digest
// ---------------------------------------------------------------------------

program
  .command("digest")
  .description("Generate a daily digest of actionable emails")
  .option("--since <date>", "Include emails since this date (YYYY-MM-DD)")
  .action((opts: { since?: string }) => {
    runCommand(async () => {
      const { createGmailClient } = await import("./auth/gmail-client.js");
      const { AnthropicProvider } = await import("./classify/llm-classifier.js");
      const { loadRules } = await import("./classify/rule-engine.js");
      const { runDigest } = await import("./digest/daily-digest.js");

      const dataDir = optionalEnv("DATA_DIR") ?? DEFAULT_DATA_DIR;
      const reportsDir = optionalEnv("REPORTS_DIR") ?? DEFAULT_REPORTS_DIR;
      const rulesPath = optionalEnv("RULES_PATH") ?? DEFAULT_RULES_PATH;
      const apiKey = requireEnv("ANTHROPIC_API_KEY");

      console.log(`Generating daily digest${opts.since !== undefined ? ` (since ${opts.since})` : ""}…`);

      const gmailClient = await createGmailClient();
      const provider = new AnthropicProvider({ apiKey });

      // Load rules config: empty config is OK when file doesn't exist (fresh
      // start), but any other error (corrupt file, schema violation) must abort
      // so classification is not silently disabled.
      const rulesResult = loadRules(rulesPath);
      if (!rulesResult.ok && !rulesResult.error.includes("not found")) {
        console.error(`Error loading rules: ${rulesResult.error}`);
        process.exit(1);
      }
      const rulesConfig = rulesResult.ok ? rulesResult.value : { domainRules: {}, senderRules: {} };

      // Compute "since" date: use CLI arg or default to yesterday
      const sinceDate = opts.since !== undefined ? new Date(opts.since) : new Date(Date.now() - 24 * 60 * 60 * 1000);

      // runDigest(since, client, provider, rulesConfig, reportsDir)
      const digestResult = await runDigest(sinceDate, gmailClient, provider, rulesConfig, reportsDir, dataDir);

      console.log(
        `Digest complete. New: ${digestResult.totalNew}, Categorized: ${digestResult.categorized}, Actionable: ${digestResult.actionable}`,
      );
      console.log(`Report: ${digestResult.reportPath}`);
    });
  });

// ---------------------------------------------------------------------------
// smoke-test — verify auth credentials
// ---------------------------------------------------------------------------

program
  .command("smoke-test")
  .description("Verify Gmail settings access and optional Sheets access")
  .option("--sheet-id <id>", "Existing spreadsheet ID to verify Google Sheets read access")
  .action((opts: { sheetId?: string }) => {
    runCommand(async () => {
      const { createGmailClient } = await import("./auth/gmail-client.js");
      const { createSheetsClient } = await import("./auth/sheets-client.js");

      console.log("Running auth smoke test…");

      const client = await createGmailClient();
      const [profileResult, labelsResult, filtersResult] = await Promise.all([
        client.getProfile(),
        client.listLabels(),
        client.listFilters(),
      ]);

      if (!profileResult.ok) {
        console.error("Auth smoke test FAILED:", profileResult.error);
        process.exit(1);
      }

      console.log(
        `Gmail OK. Authenticated as: ${profileResult.value.emailAddress}, Total messages: ${profileResult.value.messagesTotal}`,
      );

      if (!labelsResult.ok) {
        console.error("Label access FAILED:", labelsResult.error);
        process.exit(1);
      }

      if (!filtersResult.ok) {
        console.error("Settings access FAILED:", filtersResult.error);
        process.exit(1);
      }

      console.log(
        `Gmail labels/settings OK. Labels: ${labelsResult.value.length}, Filters: ${filtersResult.value.length}`,
      );

      const sheetId = opts.sheetId ?? optionalEnv("AUDIT_SHEET_ID");
      if (sheetId === undefined || sheetId.trim() === "") {
        console.log("Sheets check skipped. Provide --sheet-id or AUDIT_SHEET_ID to verify Sheets read access.");
        return;
      }

      const sheetsClient = await createSheetsClient();
      const sheetResult = await sheetsClient.readRows(sheetId, "Sheet1!A1:A1");
      if (!sheetResult.ok) {
        console.error("Sheets access FAILED:", sheetResult.error);
        process.exit(1);
      }

      console.log(`Sheets OK. Read access verified for spreadsheet ${sheetId}.`);
    });
  });

// ---------------------------------------------------------------------------
// Parse and execute
// ---------------------------------------------------------------------------

program.parse(process.argv);
