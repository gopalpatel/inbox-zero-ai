import { z } from "zod";
import { SenderTypeEnum } from "./sender-type.js";

const StepStatus = z.enum(["pending", "done", "skipped"]);
const LogStepStatus = z.enum(["pending", "done"]);

export const BatchSenderEntrySchema = z.object({
  senderEmail: z.string().min(1),
  senderName: z.string(),
  emailCount: z.number().int().min(0),
  unreadRatio: z.number().min(0).max(1),
  lastEmailDate: z.string().datetime(),
  presentedSenderType: SenderTypeEnum,
  reviewedSenderType: SenderTypeEnum.optional(),
  systemRecommendation: z.enum(["keep", "filter", "unsubscribe"]),
  userDecision: z.enum(["keep", "filter", "unsubscribe"]),
  filterApplied: z.boolean().optional(),
  filterStatus: StepStatus,
  archiveStatus: StepStatus,
  logStatus: LogStepStatus,
  stateStatus: LogStepStatus,
  sheetStatus: LogStepStatus,
  messagesArchived: z.number().int().min(0),
  lastError: z.string().optional(),
});

export type BatchSenderEntry = z.infer<typeof BatchSenderEntrySchema>;

export const BatchManifestSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().min(1),
    batchId: z.string().min(1),
    batchType: SenderTypeEnum,
    groupingReason: z.string().min(1),
    presentedRecommendation: z.enum(["keep", "filter", "unsubscribe"]),
    summary: z.object({
      senderCount: z.number().int().positive(),
      totalEmailCount: z.number().int().min(0),
      averageUnreadRatio: z.number().min(0).max(1),
    }),
    status: z.enum(["prepared", "executing", "completed", "failed"]),
    createdAt: z.string().datetime(),
    senders: z.array(BatchSenderEntrySchema),
  })
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();

    manifest.senders.forEach((sender, index) => {
      const key = sender.senderEmail.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["senders", index, "senderEmail"],
          message: `Duplicate senderEmail: ${sender.senderEmail}`,
        });
      }
      seen.add(key);
    });
  });

export type BatchManifest = z.infer<typeof BatchManifestSchema>;
