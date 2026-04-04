import { z } from "zod";

export const CheckpointStatusSchema = z
  .enum(["in_progress", "complete", "failed"])
  .describe("Current state of the inbox pull operation");

export const CheckpointErrorSchema = z.object({
  timestamp: z.coerce.date(),
  message: z.string(),
  pageToken: z.string().nullable(),
  kind: z.enum(["message", "system"]).optional(),
  messageId: z.string().optional(),
});

export type CheckpointError = z.infer<typeof CheckpointErrorSchema>;

export const CheckpointSchema = z.object({
  status: CheckpointStatusSchema,
  query: z.string().describe("Gmail query used for this pull"),
  pageToken: z.string().nullable().default(null).describe("Next page token for resume"),
  messagesFetched: z.number().int().nonnegative().describe("Total messages fetched so far"),
  batchesSaved: z.number().int().nonnegative().describe("Number of checkpoint batches written"),
  lastSavedAt: z.coerce.date().describe("Timestamp of last checkpoint save"),
  errors: z.array(CheckpointErrorSchema).default([]).describe("Errors encountered during pull"),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;
