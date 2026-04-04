import { z } from "zod";

export const SenderTypeEnum = z
  .enum(["human", "company", "newsletter", "automated", "unknown"])
  .describe("Classification of the sender's identity type");
export type SenderType = z.infer<typeof SenderTypeEnum>;

export const SenderTypeSourceEnum = z
  .enum(["heuristic", "llm", "user"])
  .describe("Origin of the senderType classification");
export type SenderTypeSource = z.infer<typeof SenderTypeSourceEnum>;
