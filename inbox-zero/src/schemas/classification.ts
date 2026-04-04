import { z } from "zod";

/**
 * Classification result for a single Gmail thread.
 * Produced by either the rule engine or the LLM classifier.
 */
export const ThreadClassificationSchema = z.object({
  /** Gmail thread ID — required to associate classification with a thread */
  threadId: z.string().min(1).describe("Gmail thread ID"),

  /**
   * Data-driven category label — not a pre-defined enum.
   * Examples: "newsletter", "transactional", "github-notification", "personal".
   */
  category: z.string().min(1).describe("Data-driven category — not pre-defined"),

  /** Classification confidence score between 0 and 1 */
  confidence: z.number().min(0).max(1).describe("Confidence score between 0 (low) and 1 (high)"),

  /**
   * Whether this thread is actionable.
   * True if the thread is within a 12-month window and needs a response.
   */
  actionable: z.boolean().describe("Within 12-month window and needs response"),

  /** 1-2 sentence human-readable summary of the thread */
  summary: z.string().max(500).describe("1-2 sentence summary"),

  /** Whether the rule engine, LLM, or fallback produced this classification */
  classifiedBy: z.enum(["rule", "llm", "fallback"]).describe("Whether rule engine, LLM, or fallback classified this"),

  /**
   * Name of the rule that matched, if classifiedBy is "rule".
   * Absent for LLM classifications.
   */
  ruleName: z.string().optional().describe("Name of rule if classified by rule engine"),
});

export type ThreadClassification = z.infer<typeof ThreadClassificationSchema>;
