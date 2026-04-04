import { describe, expect, it } from "vitest";
import { analyzeSenders } from "../../src/analysis/sender-analyzer.js";
import type { EmailMetadata } from "../../src/schemas/email-metadata.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an EmailMetadata object with sensible defaults, overridable per-test. */
function makeEmail(
  overrides: Partial<EmailMetadata> & {
    messageId: string;
    threadId: string;
    senderEmail: string;
    dateReceived: Date;
    isUnread: boolean;
  },
): EmailMetadata {
  const { senderEmail, ...rest } = overrides;
  return {
    messageId: overrides.messageId,
    threadId: overrides.threadId,
    sender: { email: senderEmail, name: overrides.sender?.name ?? "" },
    recipients: overrides.recipients ?? { to: [], cc: [] },
    subject: overrides.subject ?? "(no subject)",
    dateReceived: overrides.dateReceived,
    gmailCategory: overrides.gmailCategory ?? "unknown",
    labels: overrides.labels ?? [],
    isUnread: overrides.isUnread,
    snippet: overrides.snippet ?? "",
    ...rest,
  };
}

/**
 * Build a set of emails from 10 senders, 10 emails each = 100 total.
 * Each sender gets a distinct threadId per email so threadCount == emailCount.
 */
function make100Emails(): EmailMetadata[] {
  const senders = [
    "alpha@example.com",
    "beta@example.com",
    "gamma@example.com",
    "delta@example.com",
    "epsilon@example.com",
    "zeta@example.com",
    "eta@example.com",
    "theta@example.com",
    "iota@example.com",
    "kappa@example.com",
  ] as const;

  const emails: EmailMetadata[] = [];
  for (let i = 0; i < senders.length; i++) {
    const senderEmail = senders[i]!;
    for (let j = 0; j < 10; j++) {
      emails.push(
        makeEmail({
          messageId: `msg-${i}-${j}`,
          threadId: `thread-${i}-${j}`,
          senderEmail,
          dateReceived: new Date(`2026-01-${String(j + 1).padStart(2, "0")}T12:00:00.000Z`),
          isUnread: j % 2 === 0, // 5 out of 10 are unread per sender
          subject: `Subject ${j} from sender ${i}`,
          gmailCategory: "promotions",
        }),
      );
    }
  }
  return emails;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("analyzeSenders", () => {
  describe("empty input", () => {
    it("returns an empty array for empty input", () => {
      const result = analyzeSenders([]);
      expect(result).toEqual([]);
    });
  });

  describe("aggregation correctness — 100 emails from 10 senders", () => {
    it("produces exactly 10 SenderStats objects", () => {
      const result = analyzeSenders(make100Emails());
      expect(result).toHaveLength(10);
    });

    it("emailCount sums correctly to 10 per sender", () => {
      const result = analyzeSenders(make100Emails());
      for (const stats of result) {
        expect(stats.emailCount).toBe(10);
      }
    });

    it("firstEmailDate is the earliest date for each sender (Jan 1)", () => {
      const result = analyzeSenders(make100Emails());
      for (const stats of result) {
        expect(stats.firstEmailDate).toBe("2026-01-01T12:00:00.000Z");
      }
    });

    it("lastEmailDate is the most recent date for each sender (Jan 10)", () => {
      const result = analyzeSenders(make100Emails());
      for (const stats of result) {
        expect(stats.lastEmailDate).toBe("2026-01-10T12:00:00.000Z");
      }
    });

    it("unreadRatio is 0.5 when half the emails are unread", () => {
      const result = analyzeSenders(make100Emails());
      for (const stats of result) {
        expect(stats.unreadRatio).toBe(0.5);
      }
    });

    it("threadCount equals 10 when each email is in a distinct thread", () => {
      const result = analyzeSenders(make100Emails());
      for (const stats of result) {
        expect(stats.threadCount).toBe(10);
      }
    });

    it("sampleSubjects contains at most 5 subjects", () => {
      const result = analyzeSenders(make100Emails());
      for (const stats of result) {
        expect(stats.sampleSubjects.length).toBeLessThanOrEqual(5);
      }
    });

    it("gmailCategory reflects the most common category for the sender", () => {
      const result = analyzeSenders(make100Emails());
      for (const stats of result) {
        expect(stats.gmailCategory).toBe("promotions");
      }
    });
  });

  describe("sampleSubjects — up to 5 most-recent distinct subjects", () => {
    it("picks the 5 most recent subjects when sender has more than 5", () => {
      const emails: EmailMetadata[] = [];
      for (let i = 0; i < 8; i++) {
        emails.push(
          makeEmail({
            messageId: `msg-sub-${i}`,
            threadId: `thread-sub-${i}`,
            senderEmail: "multi@example.com",
            dateReceived: new Date(`2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
            isUnread: false,
            subject: `Distinct Subject ${i}`,
          }),
        );
      }
      const result = analyzeSenders(emails);
      expect(result).toHaveLength(1);
      const stats = result[0]!;
      expect(stats.sampleSubjects).toHaveLength(5);
      // The 5 most recent are subjects 3–7 (indices 3 through 7, days Jan 4–8)
      expect(stats.sampleSubjects).toContain("Distinct Subject 7");
      expect(stats.sampleSubjects).toContain("Distinct Subject 6");
      expect(stats.sampleSubjects).toContain("Distinct Subject 5");
      expect(stats.sampleSubjects).not.toContain("Distinct Subject 0");
      expect(stats.sampleSubjects).not.toContain("Distinct Subject 1");
      expect(stats.sampleSubjects).not.toContain("Distinct Subject 2");
    });

    it("deduplicates repeated subjects and still limits to 5", () => {
      // 10 emails alternating between 2 subjects — should have only 2 distinct subjects
      const emails: EmailMetadata[] = [];
      for (let i = 0; i < 10; i++) {
        emails.push(
          makeEmail({
            messageId: `msg-dup-${i}`,
            threadId: `thread-dup-${i}`,
            senderEmail: "dup@example.com",
            dateReceived: new Date(`2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
            isUnread: false,
            subject: i % 2 === 0 ? "Subject A" : "Subject B",
          }),
        );
      }
      const result = analyzeSenders(emails);
      expect(result).toHaveLength(1);
      const stats = result[0]!;
      expect(stats.sampleSubjects).toHaveLength(2);
      expect(stats.sampleSubjects).toContain("Subject A");
      expect(stats.sampleSubjects).toContain("Subject B");
    });

    it("returns all subjects when sender has fewer than 5 distinct ones", () => {
      const emails: EmailMetadata[] = [];
      for (let i = 0; i < 3; i++) {
        emails.push(
          makeEmail({
            messageId: `msg-few-${i}`,
            threadId: `thread-few-${i}`,
            senderEmail: "few@example.com",
            dateReceived: new Date(`2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
            isUnread: false,
            subject: `Only ${i}`,
          }),
        );
      }
      const result = analyzeSenders(emails);
      expect(result).toHaveLength(1);
      expect(result[0]!.sampleSubjects).toHaveLength(3);
    });
  });

  describe("threadCount — counts distinct threadIds", () => {
    it("counts 1 thread when all emails share the same threadId", () => {
      const emails: EmailMetadata[] = [];
      for (let i = 0; i < 5; i++) {
        emails.push(
          makeEmail({
            messageId: `msg-thread-${i}`,
            threadId: "shared-thread",
            senderEmail: "threader@example.com",
            dateReceived: new Date("2026-01-01T00:00:00.000Z"),
            isUnread: false,
          }),
        );
      }
      const result = analyzeSenders(emails);
      expect(result[0]!.threadCount).toBe(1);
    });

    it("counts each unique threadId separately", () => {
      const emails: EmailMetadata[] = [];
      for (let i = 0; i < 5; i++) {
        emails.push(
          makeEmail({
            messageId: `msg-multi-${i}`,
            threadId: `thread-multi-${i}`,
            senderEmail: "multithreader@example.com",
            dateReceived: new Date("2026-01-01T00:00:00.000Z"),
            isUnread: false,
          }),
        );
      }
      const result = analyzeSenders(emails);
      expect(result[0]!.threadCount).toBe(5);
    });
  });

  describe("unreadRatio — guarded against division by zero", () => {
    it("returns 0 unreadRatio when all emails are read", () => {
      const email = makeEmail({
        messageId: "msg-read-1",
        threadId: "thread-read-1",
        senderEmail: "read@example.com",
        dateReceived: new Date("2026-01-01T00:00:00.000Z"),
        isUnread: false,
      });
      const result = analyzeSenders([email]);
      expect(result[0]!.unreadRatio).toBe(0);
    });

    it("returns 1 unreadRatio when all emails are unread", () => {
      const email = makeEmail({
        messageId: "msg-unread-1",
        threadId: "thread-unread-1",
        senderEmail: "unread@example.com",
        dateReceived: new Date("2026-01-01T00:00:00.000Z"),
        isUnread: true,
      });
      const result = analyzeSenders([email]);
      expect(result[0]!.unreadRatio).toBe(1);
    });
  });

  describe("gmailCategory — uses most common category", () => {
    it("picks promotions when it appears more often than updates", () => {
      const emails: EmailMetadata[] = [
        makeEmail({
          messageId: "msg-cat-1",
          threadId: "thread-cat-1",
          senderEmail: "cat@example.com",
          dateReceived: new Date("2026-01-01T00:00:00.000Z"),
          isUnread: false,
          gmailCategory: "promotions",
        }),
        makeEmail({
          messageId: "msg-cat-2",
          threadId: "thread-cat-2",
          senderEmail: "cat@example.com",
          dateReceived: new Date("2026-01-02T00:00:00.000Z"),
          isUnread: false,
          gmailCategory: "promotions",
        }),
        makeEmail({
          messageId: "msg-cat-3",
          threadId: "thread-cat-3",
          senderEmail: "cat@example.com",
          dateReceived: new Date("2026-01-03T00:00:00.000Z"),
          isUnread: false,
          gmailCategory: "updates",
        }),
      ];
      const result = analyzeSenders(emails);
      expect(result[0]!.gmailCategory).toBe("promotions");
    });
  });

  describe("sender email normalization", () => {
    it("normalizes senders with same email but different display names into one entry", () => {
      const emails: EmailMetadata[] = [
        makeEmail({
          messageId: "msg-norm-1",
          threadId: "thread-norm-1",
          senderEmail: "INFO@Example.COM",
          sender: { email: "INFO@Example.COM", name: "Info Bot" },
          dateReceived: new Date("2026-01-01T00:00:00.000Z"),
          isUnread: false,
        }),
        makeEmail({
          messageId: "msg-norm-2",
          threadId: "thread-norm-2",
          senderEmail: "info@example.com",
          sender: { email: "info@example.com", name: "The Info Bot" },
          dateReceived: new Date("2026-01-02T00:00:00.000Z"),
          isUnread: false,
        }),
      ];
      const result = analyzeSenders(emails);
      expect(result).toHaveLength(1);
      expect(result[0]!.emailCount).toBe(2);
      // senderEmail should be the normalized lowercase form
      expect(result[0]!.senderEmail).toBe("info@example.com");
    });
  });

  describe("output ordering", () => {
    it("sorts results by emailCount descending", () => {
      const emails: EmailMetadata[] = [];
      // 3 emails from "many", 1 from "few", 2 from "mid"
      for (let i = 0; i < 3; i++) {
        emails.push(
          makeEmail({
            messageId: `msg-many-${i}`,
            threadId: `thread-many-${i}`,
            senderEmail: "many@example.com",
            dateReceived: new Date("2026-01-01T00:00:00.000Z"),
            isUnread: false,
          }),
        );
      }
      emails.push(
        makeEmail({
          messageId: "msg-few-1",
          threadId: "thread-few-1",
          senderEmail: "few@example.com",
          dateReceived: new Date("2026-01-01T00:00:00.000Z"),
          isUnread: false,
        }),
      );
      for (let i = 0; i < 2; i++) {
        emails.push(
          makeEmail({
            messageId: `msg-mid-${i}`,
            threadId: `thread-mid-${i}`,
            senderEmail: "mid@example.com",
            dateReceived: new Date("2026-01-01T00:00:00.000Z"),
            isUnread: false,
          }),
        );
      }
      const result = analyzeSenders(emails);
      expect(result).toHaveLength(3);
      expect(result[0]!.senderEmail).toBe("many@example.com");
      expect(result[0]!.emailCount).toBe(3);
      expect(result[1]!.senderEmail).toBe("mid@example.com");
      expect(result[1]!.emailCount).toBe(2);
      expect(result[2]!.senderEmail).toBe("few@example.com");
      expect(result[2]!.emailCount).toBe(1);
    });
  });

  describe("senderName", () => {
    it("uses the display name from the most recent email", () => {
      const emails: EmailMetadata[] = [
        makeEmail({
          messageId: "msg-name-1",
          threadId: "thread-name-1",
          senderEmail: "brand@example.com",
          sender: { email: "brand@example.com", name: "Old Brand Name" },
          dateReceived: new Date("2026-01-01T00:00:00.000Z"),
          isUnread: false,
        }),
        makeEmail({
          messageId: "msg-name-2",
          threadId: "thread-name-2",
          senderEmail: "brand@example.com",
          sender: { email: "brand@example.com", name: "New Brand Name" },
          dateReceived: new Date("2026-03-01T00:00:00.000Z"),
          isUnread: false,
        }),
      ];
      const result = analyzeSenders(emails);
      expect(result[0]!.senderName).toBe("New Brand Name");
    });
  });

  describe("analyzeSenders — starredCount and importantCount", () => {
    it("counts STARRED labels per sender", () => {
      const base = { threadId: "t1", dateReceived: new Date("2026-01-01"), isUnread: false };
      const emails = [
        makeEmail({ ...base, messageId: "m1", senderEmail: "a@test.com", labels: ["STARRED", "INBOX"] }),
        makeEmail({ ...base, messageId: "m2", senderEmail: "a@test.com", labels: ["INBOX"] }),
        makeEmail({ ...base, messageId: "m3", senderEmail: "a@test.com", labels: ["STARRED"] }),
      ];
      const stats = analyzeSenders(emails);
      expect(stats).toHaveLength(1);
      expect(stats[0]!.starredCount).toBe(2);
    });

    it("counts IMPORTANT labels per sender", () => {
      const base = { threadId: "t1", dateReceived: new Date("2026-01-01"), isUnread: false };
      const emails = [
        makeEmail({ ...base, messageId: "m1", senderEmail: "a@test.com", labels: ["IMPORTANT"] }),
        makeEmail({ ...base, messageId: "m2", senderEmail: "a@test.com", labels: [] }),
      ];
      const stats = analyzeSenders(emails);
      expect(stats[0]!.importantCount).toBe(1);
    });

    it("defaults to 0 when no STARRED/IMPORTANT labels", () => {
      const emails = [
        makeEmail({
          messageId: "m1",
          threadId: "t1",
          senderEmail: "a@test.com",
          dateReceived: new Date("2026-01-01"),
          isUnread: false,
          labels: ["INBOX"],
        }),
      ];
      const stats = analyzeSenders(emails);
      expect(stats[0]!.starredCount).toBe(0);
      expect(stats[0]!.importantCount).toBe(0);
    });
  });

  describe("output does not include confidenceTier or recommendedAction", () => {
    it("returns SenderStats objects without confidenceTier set", () => {
      const email = makeEmail({
        messageId: "msg-tier-1",
        threadId: "thread-tier-1",
        senderEmail: "tier@example.com",
        dateReceived: new Date("2026-01-01T00:00:00.000Z"),
        isUnread: false,
      });
      const result = analyzeSenders([email]);
      expect(result[0]!.confidenceTier).toBeUndefined();
      expect(result[0]!.recommendedAction).toBeUndefined();
    });
  });
});
