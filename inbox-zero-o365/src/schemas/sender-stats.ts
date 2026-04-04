import { z } from "zod";
import { SenderTypeEnum } from "./sender-type.js";

export const ConfidenceTierSchema = z
  .enum(["definitely_noise", "probably_noise", "probably_keep", "definitely_keep"])
  .describe("Confidence tier for whether sender email is noise or worth keeping");

export const RecommendedActionSchema = z
  .enum(["keep", "filter", "unsubscribe"])
  .describe("Recommended action for the sender's emails");

export const SenderStatsSchema = z.object({
  senderEmail: z.string().min(1).describe("Sender email address"),
  senderName: z.string().describe("Sender display name"),
  emailCount: z.number().int().nonnegative().describe("Total emails from this sender"),
  firstEmailDate: z.string().describe("ISO date of earliest received email"),
  lastEmailDate: z.string().describe("ISO date of most recent email"),
  gmailCategory: z.string().describe("Gmail category tab label"),
  unreadRatio: z.number().min(0).max(1).describe("Fraction of emails that are unread, between 0 and 1"),
  threadCount: z.number().int().nonnegative().describe("Number of distinct threads"),
  sampleSubjects: z.array(z.string()).max(5).describe("Sample subject lines for audit review, max 5"),
  confidenceTier: ConfidenceTierSchema.optional(),
  recommendedAction: RecommendedActionSchema.optional(),
  surprisesFlag: z
    .boolean()
    .default(false)
    .describe("True if sender has surprising patterns that override confidence tier"),
  userDecision: RecommendedActionSchema.nullable()
    .optional()
    .describe("User-supplied decision from the Google Sheets audit column"),
  senderType: SenderTypeEnum.optional().describe("Sender identity classification"),
  senderTypeConfidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Confidence score for senderType classification, between 0 and 1"),
  extractionCandidate: z.boolean().optional().describe("True if sender is a candidate for Obsidian content extraction"),
  starredCount: z.number().int().min(0).default(0).describe("Number of starred emails from this sender"),
  importantCount: z.number().int().min(0).default(0).describe("Number of emails marked important from this sender"),
});

export type SenderStats = z.infer<typeof SenderStatsSchema>;
export type ConfidenceTier = z.infer<typeof ConfidenceTierSchema>;
export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;
