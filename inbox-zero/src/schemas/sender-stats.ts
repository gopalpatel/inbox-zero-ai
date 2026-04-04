import { z } from "zod";
import { SenderTypeEnum } from "./sender-type.js";

/**
 * Confidence tier assigned by the confidence scorer (Task 9).
 * Indicates how confident the system is that the sender is noise vs. worth keeping.
 */
export const ConfidenceTierSchema = z
  .enum(["definitely_noise", "probably_noise", "probably_keep", "definitely_keep"])
  .describe("Confidence tier for whether sender email is noise or worth keeping");

/**
 * Recommended action for the sender, assigned by the confidence scorer (Task 9).
 */
export const RecommendedActionSchema = z
  .enum(["keep", "filter", "unsubscribe"])
  .describe("Recommended action for the sender's emails");

/**
 * Sender stats schema mapping directly to Google Sheets audit report columns.
 * Populated during initial sender analysis; confidence tier, recommended action,
 * and user decision are filled in later.
 */
export const SenderStatsSchema = z.object({
  /** Sender's email address — primary key for the audit row */
  senderEmail: z.string().min(1).describe("Sender email address"),

  /** Display name extracted from email headers */
  senderName: z.string().describe("Sender display name"),

  /** Total number of emails received from this sender */
  emailCount: z.number().int().nonnegative().describe("Total emails from this sender"),

  /** ISO date string of the earliest email from this sender */
  firstEmailDate: z.string().describe("ISO date of earliest received email"),

  /** ISO date string of the most recent email from this sender */
  lastEmailDate: z.string().describe("ISO date of most recent email"),

  /** Gmail category tab (e.g., primary, promotions, social, updates, forums) */
  gmailCategory: z.string().describe("Gmail category tab label"),

  /** Fraction of emails from this sender that are unread (0–1) */
  unreadRatio: z.number().min(0).max(1).describe("Fraction of emails that are unread, between 0 and 1"),

  /** Number of distinct threads involving this sender */
  threadCount: z.number().int().nonnegative().describe("Number of distinct threads"),

  /** Up to 5 sample subject lines for human review */
  sampleSubjects: z.array(z.string()).max(5).describe("Sample subject lines for audit review, max 5"),

  /**
   * Confidence tier assigned by the confidence scorer (Task 9).
   * Optional — absent until the scorer runs.
   */
  confidenceTier: ConfidenceTierSchema.optional(),

  /**
   * Recommended action assigned by the confidence scorer (Task 9).
   * Optional — absent until the scorer runs.
   */
  recommendedAction: RecommendedActionSchema.optional(),

  /**
   * Whether the sender has unusual patterns that don't fit the model's expectation.
   * Defaults to false; flagged by the confidence scorer.
   */
  surprisesFlag: z
    .boolean()
    .default(false)
    .describe("True if sender has surprising patterns that override confidence tier"),

  /**
   * User's decision from the Google Sheets audit.
   * Nullable — null means the user has not yet filled in their decision.
   * Optional — absent when the row hasn't been reviewed yet.
   */
  userDecision: RecommendedActionSchema
    .nullable()
    .optional()
    .describe("User-supplied decision from the Google Sheets audit column"),

  /**
   * Sender identity classification (heuristic or LLM-assigned).
   * Optional — absent until the enrichment pipeline runs.
   */
  senderType: SenderTypeEnum.optional().describe("Sender identity classification"),

  /**
   * Confidence score for senderType (0–1).
   * Optional — absent until the enrichment pipeline runs.
   */
  senderTypeConfidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Confidence score for senderType classification, between 0 and 1"),

  /**
   * Whether this sender is a candidate for Obsidian content extraction.
   * Optional — absent until the extraction scorer runs.
   */
  extractionCandidate: z.boolean().optional().describe("True if sender is a candidate for Obsidian content extraction"),

  /**
   * Number of starred emails from this sender.
   * Defaults to 0; populated during enriched sender analysis.
   */
  starredCount: z.number().int().min(0).default(0).describe("Number of starred emails from this sender"),

  /**
   * Number of emails marked important from this sender.
   * Defaults to 0; populated during enriched sender analysis.
   */
  importantCount: z.number().int().min(0).default(0).describe("Number of emails marked important from this sender"),
});

export type SenderStats = z.infer<typeof SenderStatsSchema>;
export type ConfidenceTier = z.infer<typeof ConfidenceTierSchema>;
export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;
