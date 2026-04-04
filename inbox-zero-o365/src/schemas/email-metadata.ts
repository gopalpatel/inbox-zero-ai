import { z } from "zod";

/** Use the RFC 5322 email regex instead of Zod's strict default, which rejects
 *  valid characters like = / ! # $ % & * found in real-world bounce addresses,
 *  VERP encodings, and legacy corporate email. Unlike html5Email, rfc5322Email
 *  still rejects malformed patterns (user@localhost, consecutive dots, etc.). */
const rfc5322Email = { pattern: z.regexes.rfc5322Email };

export const GmailCategorySchema = z
  .enum(["primary", "social", "promotions", "updates", "forums", "unknown"])
  .describe("Gmail tab category");

export const EmailMetadataSchema = z.object({
  messageId: z.string().min(1).describe("Gmail message ID"),
  threadId: z.string().min(1).describe("Gmail thread ID"),
  sender: z.object({
    email: z.string().email(rfc5322Email).describe("Sender email address"),
    name: z.string().default("").describe("Sender display name"),
  }),
  recipients: z
    .object({
      to: z.array(z.string().email(rfc5322Email)).default([]),
      cc: z.array(z.string().email(rfc5322Email)).default([]),
    })
    .default({ to: [], cc: [] }),
  subject: z.string().default("(no subject)"),
  dateReceived: z.coerce.date().describe("Date email was received"),
  gmailCategory: GmailCategorySchema.default("unknown"),
  labels: z.array(z.string()).default([]),
  isUnread: z.boolean().describe("Whether the email is unread"),
  snippet: z.string().default("").describe("First ~100 chars of body"),
});

export type EmailMetadata = z.infer<typeof EmailMetadataSchema>;
export type GmailCategory = z.infer<typeof GmailCategorySchema>;
