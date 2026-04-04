import { z } from "zod";
import { SenderTypeEnum } from "./sender-type.js";

export const SenderTypeFeedbackEnum = z.enum(["none", "confirmed", "corrected"]);

export const DecisionEntrySchema = z
  .object({
    runId: z.string().min(1),
    senderEmail: z.string().min(1),
    senderName: z.string(),
    presentedSenderType: SenderTypeEnum,
    reviewedSenderType: SenderTypeEnum.optional(),
    senderTypeFeedback: SenderTypeFeedbackEnum,
    systemRecommendation: z.enum(["keep", "filter", "unsubscribe"]),
    userDecision: z.enum(["keep", "filter", "unsubscribe"]),
    batchId: z.string().min(1),
    timestamp: z.string().datetime(),
    emailCount: z.number().int().min(0),
    messagesArchived: z.number().int().min(0),
    actionsTaken: z.array(z.string()),
  })
  .superRefine((entry, ctx) => {
    if (entry.senderTypeFeedback === "corrected" && entry.reviewedSenderType === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewedSenderType"],
        message: "reviewedSenderType is required when senderTypeFeedback is 'corrected'",
      });
    }
  });

export type DecisionEntry = z.infer<typeof DecisionEntrySchema>;

export const DecisionLogSchema = z.object({
  version: z.literal(1),
  decisions: z.array(DecisionEntrySchema),
});

export type DecisionLog = z.infer<typeof DecisionLogSchema>;
