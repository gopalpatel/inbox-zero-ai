import { z } from "zod";

/** Status of a backfill run. */
export const BackfillStatusSchema = z.enum(["fetching", "promoting", "complete", "failed"]);

/** Schema for a residual error — a message that still failed after backfill. */
export const BackfillResidualErrorSchema = z.object({
  messageId: z.string().min(1),
  error: z.string(),
  timestamp: z.coerce.date(),
});

/** Durable state for a single backfill run, stored at data/backfills/<runId>/backfill-checkpoint.json. */
export const BackfillCheckpointSchema = z.object({
  runId: z.string().min(1).describe("Unique identifier for this backfill run"),
  status: BackfillStatusSchema,
  sourceCheckpointLastSavedAt: z.coerce
    .date()
    .describe("lastSavedAt from the main checkpoint when this run was created"),
  sourceErrorFingerprint: z.string().describe("Hash of sorted target message IDs for drift detection"),
  targetIds: z.array(z.string().min(1)).describe("Snapshot of message IDs to retry"),
  recoveredCount: z.number().int().nonnegative().default(0),
  residualErrors: z.array(BackfillResidualErrorSchema).default([]),
  shardsWritten: z.number().int().nonnegative().default(0),
  lastSavedAt: z.coerce.date(),
});

export type BackfillStatus = z.infer<typeof BackfillStatusSchema>;
export type BackfillResidualError = z.infer<typeof BackfillResidualErrorSchema>;
export type BackfillCheckpoint = z.infer<typeof BackfillCheckpointSchema>;
