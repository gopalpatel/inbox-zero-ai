import { describe, expect, it } from "vitest";
import { EmailMetadataSchema, GmailCategorySchema } from "../../src/schemas/email-metadata.js";

const validFull = {
  messageId: "msg-abc123",
  threadId: "thread-xyz789",
  sender: {
    email: "alice@example.com",
    name: "Alice Smith",
  },
  recipients: {
    to: ["bob@example.com"],
    cc: ["carol@example.com"],
  },
  subject: "Meeting tomorrow",
  dateReceived: "2024-03-15T10:30:00.000Z",
  gmailCategory: "primary" as const,
  labels: ["INBOX", "UNREAD"],
  isUnread: true,
  snippet: "Hi Bob, can we meet tomorrow at 10am?",
};

describe("GmailCategorySchema", () => {
  it("accepts all valid enum values", () => {
    const validValues = ["primary", "social", "promotions", "updates", "forums", "unknown"] as const;
    for (const value of validValues) {
      expect(GmailCategorySchema.parse(value)).toBe(value);
    }
  });

  it("rejects invalid enum values", () => {
    expect(() => GmailCategorySchema.parse("spam")).toThrow();
    expect(() => GmailCategorySchema.parse("inbox")).toThrow();
    expect(() => GmailCategorySchema.parse("")).toThrow();
  });
});

describe("EmailMetadataSchema — valid inputs", () => {
  it("parses a fully-populated metadata object", () => {
    const result = EmailMetadataSchema.parse(validFull);
    expect(result.messageId).toBe("msg-abc123");
    expect(result.threadId).toBe("thread-xyz789");
    expect(result.sender.email).toBe("alice@example.com");
    expect(result.sender.name).toBe("Alice Smith");
    expect(result.recipients.to).toEqual(["bob@example.com"]);
    expect(result.recipients.cc).toEqual(["carol@example.com"]);
    expect(result.subject).toBe("Meeting tomorrow");
    expect(result.dateReceived).toBeInstanceOf(Date);
    expect(result.gmailCategory).toBe("primary");
    expect(result.labels).toEqual(["INBOX", "UNREAD"]);
    expect(result.isUnread).toBe(true);
    expect(result.snippet).toBe("Hi Bob, can we meet tomorrow at 10am?");
  });

  it("parses minimal metadata — optional fields use defaults", () => {
    const minimal = {
      messageId: "msg-min1",
      threadId: "thread-min1",
      sender: { email: "sender@example.com" },
      dateReceived: new Date("2024-01-01"),
      isUnread: false,
    };
    const result = EmailMetadataSchema.parse(minimal);
    expect(result.sender.name).toBe("");
    expect(result.recipients.to).toEqual([]);
    expect(result.recipients.cc).toEqual([]);
    expect(result.subject).toBe("(no subject)");
    expect(result.gmailCategory).toBe("unknown");
    expect(result.labels).toEqual([]);
    expect(result.snippet).toBe("");
  });

  it("coerces dateReceived from ISO string to Date", () => {
    const input = { ...validFull, dateReceived: "2024-06-20T08:00:00.000Z" };
    const result = EmailMetadataSchema.parse(input);
    expect(result.dateReceived).toBeInstanceOf(Date);
    expect(result.dateReceived.getFullYear()).toBe(2024);
  });

  it("accepts Date instance for dateReceived", () => {
    const input = { ...validFull, dateReceived: new Date("2024-09-01") };
    const result = EmailMetadataSchema.parse(input);
    expect(result.dateReceived).toBeInstanceOf(Date);
  });

  it("defaults gmailCategory to 'unknown' when omitted", () => {
    const input = { ...validFull };
    const withoutCategory = Object.fromEntries(Object.entries(input).filter(([k]) => k !== "gmailCategory"));
    const result = EmailMetadataSchema.parse(withoutCategory);
    expect(result.gmailCategory).toBe("unknown");
  });

  it("accepts RFC 5322 atext characters in email addresses", () => {
    const rfcEmails = [
      "user=bounce@service.com",
      "user/dept@example.com",
      "user!important@example.com",
      "user#tag@example.com",
      "user%x@example.com",
      "bounced-123-user=example.com@bounce.service.com",
    ];
    for (const email of rfcEmails) {
      const senderInput = { ...validFull, sender: { email, name: "Test" } };
      const senderResult = EmailMetadataSchema.safeParse(senderInput);
      expect(senderResult.success, `Expected sender ${email} to be accepted`).toBe(true);

      const recipientsInput = {
        ...validFull,
        recipients: { to: [email], cc: [email] },
      };
      const recipientsResult = EmailMetadataSchema.safeParse(recipientsInput);
      expect(recipientsResult.success, `Expected recipient ${email} to be accepted`).toBe(true);
    }
  });
});

describe("EmailMetadataSchema — invalid inputs", () => {
  it("rejects missing messageId", () => {
    const input = { ...validFull };
    const withoutId = Object.fromEntries(Object.entries(input).filter(([k]) => k !== "messageId"));
    expect(() => EmailMetadataSchema.parse(withoutId)).toThrow();
  });

  it("rejects missing threadId", () => {
    const input = { ...validFull };
    const withoutThread = Object.fromEntries(Object.entries(input).filter(([k]) => k !== "threadId"));
    expect(() => EmailMetadataSchema.parse(withoutThread)).toThrow();
  });

  it("rejects missing sender", () => {
    const input = { ...validFull };
    const withoutSender = Object.fromEntries(Object.entries(input).filter(([k]) => k !== "sender"));
    expect(() => EmailMetadataSchema.parse(withoutSender)).toThrow();
  });

  it("rejects missing dateReceived", () => {
    const input = { ...validFull };
    const withoutDate = Object.fromEntries(Object.entries(input).filter(([k]) => k !== "dateReceived"));
    expect(() => EmailMetadataSchema.parse(withoutDate)).toThrow();
  });

  it("rejects missing isUnread", () => {
    const input = { ...validFull };
    const withoutUnread = Object.fromEntries(Object.entries(input).filter(([k]) => k !== "isUnread"));
    expect(() => EmailMetadataSchema.parse(withoutUnread)).toThrow();
  });

  it("rejects invalid sender email", () => {
    const input = { ...validFull, sender: { email: "not-an-email", name: "Bad" } };
    expect(() => EmailMetadataSchema.parse(input)).toThrow();
  });

  it("rejects invalid email in recipients.to", () => {
    const input = { ...validFull, recipients: { to: ["not-an-email"], cc: [] } };
    expect(() => EmailMetadataSchema.parse(input)).toThrow();
  });

  it("rejects malformed email patterns that html5Email would accept", () => {
    const malformed = ["user@example", "user@localhost", "user..name@example.com", "user.@example.com"];
    for (const email of malformed) {
      const senderInput = { ...validFull, sender: { email, name: "Test" } };
      const senderResult = EmailMetadataSchema.safeParse(senderInput);
      expect(senderResult.success, `Expected sender ${email} to be rejected`).toBe(false);

      const recipientsInput = {
        ...validFull,
        recipients: { to: [email], cc: [email] },
      };
      const recipientsResult = EmailMetadataSchema.safeParse(recipientsInput);
      expect(recipientsResult.success, `Expected recipient ${email} to be rejected`).toBe(false);
    }
  });

  it("rejects empty string messageId", () => {
    const input = { ...validFull, messageId: "" };
    expect(() => EmailMetadataSchema.parse(input)).toThrow();
  });

  it("rejects empty string threadId", () => {
    const input = { ...validFull, threadId: "" };
    expect(() => EmailMetadataSchema.parse(input)).toThrow();
  });

  it("rejects non-boolean isUnread", () => {
    const input = { ...validFull, isUnread: "yes" };
    expect(() => EmailMetadataSchema.parse(input)).toThrow();
  });

  it("rejects invalid gmailCategory", () => {
    const input = { ...validFull, gmailCategory: "junk" };
    expect(() => EmailMetadataSchema.parse(input)).toThrow();
  });
});
