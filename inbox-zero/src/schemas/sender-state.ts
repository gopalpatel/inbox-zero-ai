import { z } from "zod";
import { SenderStatsSchema } from "./sender-stats.js";
import { SenderTypeEnum, SenderTypeSourceEnum } from "./sender-type.js";

export const SenderStateEntrySchema = SenderStatsSchema.extend({
  senderTypeSource: SenderTypeSourceEnum.optional(),
  reviewedSenderType: SenderTypeEnum.optional(),
  reviewedAt: z.string().datetime().optional(),
  processedAt: z.string().datetime().optional(),
});

export type SenderStateEntry = z.infer<typeof SenderStateEntrySchema>;

export const SenderStateFileSchema = z
  .object({
    version: z.literal(1),
    mailbox: z.string().min(1),
    generatedAt: z.string().datetime(),
    senders: z.array(SenderStateEntrySchema),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();

    file.senders.forEach((sender, index) => {
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

export type SenderStateFile = z.infer<typeof SenderStateFileSchema>;
