// src/state/batch-manifest-manager.ts
import * as fs from "node:fs/promises";
import { type BatchManifest, BatchManifestSchema, type BatchSenderEntry } from "../schemas/batch-manifest.js";
import type { SenderType } from "../schemas/sender-type.js";
import type { Result } from "../types.js";
import { atomicWriteFile, toErrorMessage } from "../utils.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** Sender data provided at manifest creation time (steps are initialised by createManifest). */
export interface ManifestSenderInput {
  senderEmail: string;
  senderName: string;
  emailCount: number;
  unreadRatio: number;
  lastEmailDate: string;
  presentedSenderType: SenderType;
  systemRecommendation: "keep" | "filter" | "unsubscribe";
  userDecision: "keep" | "filter" | "unsubscribe";
  /** Optional — present when user corrected the sender type during review. */
  reviewedSenderType?: SenderType;
}

/** Input for createManifest. Summary is derived from `senders`. */
export interface CreateManifestInput {
  runId: string;
  batchId: string;
  batchType: SenderType;
  groupingReason: string;
  presentedRecommendation: "keep" | "filter" | "unsubscribe";
  senders: ManifestSenderInput[];
}

/** Step fields on a BatchSenderEntry that can be advanced. */
export type SenderStep = "filterStatus" | "archiveStatus" | "logStatus" | "stateStatus" | "sheetStatus";

export type SkippableSenderStep = "filterStatus" | "archiveStatus";
export type RequiredSenderStep = "logStatus" | "stateStatus" | "sheetStatus";
export type SkippableStepStatus = "pending" | "done" | "skipped";
export type RequiredStepStatus = "pending" | "done";
export type StepStatus = SkippableStepStatus | RequiredStepStatus;

type StepStatusFor<S extends SenderStep> = S extends SkippableSenderStep ? SkippableStepStatus : RequiredStepStatus;

// ---------------------------------------------------------------------------
// createManifest
// ---------------------------------------------------------------------------

/**
 * Creates a new batch manifest JSON file at `filePath` with `prepared` status.
 * All step fields are set to `pending` and `messagesArchived` is initialised to 0.
 * Uses atomic write to prevent partial-write corruption.
 */
export async function createManifest(filePath: string, input: CreateManifestInput): Promise<void> {
  const senders: BatchSenderEntry[] = input.senders.map((s) => ({
    senderEmail: s.senderEmail,
    senderName: s.senderName,
    emailCount: s.emailCount,
    unreadRatio: s.unreadRatio,
    lastEmailDate: s.lastEmailDate,
    presentedSenderType: s.presentedSenderType,
    reviewedSenderType: s.reviewedSenderType,
    systemRecommendation: s.systemRecommendation,
    userDecision: s.userDecision,
    filterApplied: false,
    filterStatus: "pending",
    archiveStatus: "pending",
    logStatus: "pending",
    stateStatus: "pending",
    sheetStatus: "pending",
    messagesArchived: 0,
  }));

  const totalEmailCount = input.senders.reduce((sum, sender) => sum + sender.emailCount, 0);
  const averageUnreadRatio =
    input.senders.length === 0
      ? 0
      : input.senders.reduce((sum, sender) => sum + sender.unreadRatio, 0) / input.senders.length;

  const manifest: BatchManifest = {
    version: 1,
    runId: input.runId,
    batchId: input.batchId,
    batchType: input.batchType,
    groupingReason: input.groupingReason,
    presentedRecommendation: input.presentedRecommendation,
    summary: {
      senderCount: input.senders.length,
      totalEmailCount,
      averageUnreadRatio,
    },
    status: "prepared",
    createdAt: new Date().toISOString(),
    senders,
  };

  const parsed = BatchManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new Error(`createManifest: manifest failed schema validation — ${parsed.error.message}`);
  }

  await atomicWriteFile(filePath, JSON.stringify(parsed.data, null, 2));
}

// ---------------------------------------------------------------------------
// readManifest
// ---------------------------------------------------------------------------

/**
 * Reads and validates a batch manifest from `filePath`.
 * Returns `{ ok: false }` when the file is missing, contains invalid JSON,
 * or fails BatchManifestSchema validation.
 */
export async function readManifest(filePath: string): Promise<Result<BatchManifest>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, error: `Manifest file not found: ${filePath}` };
    }
    return { ok: false, error: `Failed to read manifest file: ${toErrorMessage(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `Manifest file contains invalid JSON: ${toErrorMessage(err)}` };
  }

  const result = BatchManifestSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: `Manifest file failed schema validation: ${result.error.message}`,
    };
  }

  return { ok: true, value: result.data };
}

// ---------------------------------------------------------------------------
// advanceSenderStep
// ---------------------------------------------------------------------------

/**
 * Atomically reads the manifest, updates a single step field for the given
 * sender, re-validates the manifest, and writes it back.
 *
 * Throws if the sender email is not found in the manifest.
 */
export async function advanceSenderStep(
  filePath: string,
  senderEmail: string,
  step: SkippableSenderStep,
  status: SkippableStepStatus,
): Promise<void>;
export async function advanceSenderStep(
  filePath: string,
  senderEmail: string,
  step: RequiredSenderStep,
  status: RequiredStepStatus,
): Promise<void>;
export async function advanceSenderStep<S extends SenderStep>(
  filePath: string,
  senderEmail: string,
  step: S,
  status: StepStatusFor<S>,
): Promise<void> {
  const readResult = await readManifest(filePath);
  if (!readResult.ok) {
    throw new Error(`advanceSenderStep: failed to read manifest — ${readResult.error}`);
  }

  const manifest = readResult.value;
  const lowerEmail = senderEmail.toLowerCase();
  const senderIndex = manifest.senders.findIndex((s) => s.senderEmail.toLowerCase() === lowerEmail);

  if (senderIndex === -1) {
    throw new Error(`advanceSenderStep: sender "${senderEmail}" not found in manifest ${filePath}`);
  }

  const updatedSenders = manifest.senders.map((sender, idx) => {
    if (idx !== senderIndex) return sender;
    return { ...sender, [step]: status };
  });

  const updated: BatchManifest = { ...manifest, senders: updatedSenders };
  const parsed = BatchManifestSchema.safeParse(updated);
  if (!parsed.success) {
    throw new Error(`advanceSenderStep: manifest failed schema validation — ${parsed.error.message}`);
  }
  await atomicWriteFile(filePath, JSON.stringify(parsed.data, null, 2));
}

// ---------------------------------------------------------------------------
// completeManifest
// ---------------------------------------------------------------------------

/**
 * Sets the manifest status to `completed`. Reads the manifest, updates the
 * status field, and writes atomically.
 */
export async function completeManifest(filePath: string): Promise<void> {
  const readResult = await readManifest(filePath);
  if (!readResult.ok) {
    throw new Error(`completeManifest: failed to read manifest — ${readResult.error}`);
  }

  const updated: BatchManifest = { ...readResult.value, status: "completed" };
  await atomicWriteFile(filePath, JSON.stringify(updated, null, 2));
}

// ---------------------------------------------------------------------------
// renderBrief
// ---------------------------------------------------------------------------

/** Number formatter for counts with thousands separators. */
const COUNT_FMT = new Intl.NumberFormat("en-US");

/**
 * Formats a ratio (0–1) as a percentage string with no decimal places.
 * e.g. 0.94 → "94%"
 */
function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/**
 * Generates a human-readable Markdown brief from a frozen BatchManifest.
 *
 * The brief is a companion document for human review. It summarises the batch,
 * lists each sender with their decision, and notes any type corrections.
 *
 * IMPORTANT: If this brief conflicts with the JSON manifest, the manifest wins.
 */
export function renderBrief(manifest: BatchManifest): string {
  const lines: string[] = [];

  lines.push(`# Batch Brief: ${manifest.batchId}`);
  lines.push("");
  lines.push(`**Run ID:** ${manifest.runId}`);
  lines.push(`**Batch ID:** ${manifest.batchId}`);
  lines.push(`**Status:** ${manifest.status}`);
  lines.push(`**Created:** ${manifest.createdAt}`);
  lines.push("");
  lines.push("## Batch Info");
  lines.push("");
  lines.push(`**Batch type:** ${manifest.batchType}`);
  lines.push(`**Grouping reason:** ${manifest.groupingReason}`);
  lines.push(`**Presented recommendation:** ${manifest.presentedRecommendation}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Sender count:** ${COUNT_FMT.format(manifest.summary.senderCount)}`);
  lines.push(`- **Total emails:** ${COUNT_FMT.format(manifest.summary.totalEmailCount)}`);
  lines.push(`- **Average unread ratio:** ${formatPct(manifest.summary.averageUnreadRatio)}`);
  lines.push("");
  lines.push("## Senders");
  lines.push("");

  const corrections: Array<{ email: string; from: string; to: string }> = [];

  for (let i = 0; i < manifest.senders.length; i++) {
    const sender = manifest.senders[i]!;
    lines.push(
      `${i + 1}. **${sender.senderEmail}** (${sender.senderName}) — ` +
        `${COUNT_FMT.format(sender.emailCount)} emails, ` +
        `${formatPct(sender.unreadRatio)} unread — ` +
        `decision: **${sender.userDecision}**`,
    );

    if (sender.reviewedSenderType !== undefined && sender.reviewedSenderType !== sender.presentedSenderType) {
      corrections.push({
        email: sender.senderEmail,
        from: sender.presentedSenderType,
        to: sender.reviewedSenderType,
      });
    }
  }

  if (corrections.length > 0) {
    lines.push("");
    lines.push("## Type Corrections");
    lines.push("");
    for (const correction of corrections) {
      lines.push(`- **${correction.email}**: ${correction.from} → ${correction.to}`);
    }
  }

  lines.push("");
  lines.push("> **Safety note:** If this brief conflicts with the JSON manifest, the manifest wins.");
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// writeBrief
// ---------------------------------------------------------------------------

/**
 * Persists the companion Markdown brief atomically alongside the manifest.
 */
export async function writeBrief(briefPath: string, manifest: BatchManifest): Promise<void> {
  const content = renderBrief(manifest);
  await atomicWriteFile(briefPath, content);
}
