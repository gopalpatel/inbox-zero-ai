import type { EmailMetadata } from "../../src/schemas/email-metadata.js";

/**
 * Newsletter from a marketing sender (promotions tab, unread, noreply).
 */
export const newsletterEmail: EmailMetadata = {
  messageId: "msg-promo-001",
  threadId: "thread-promo-001",
  sender: {
    email: "newsletter@morning-brew.com",
    name: "Morning Brew",
  },
  recipients: {
    to: ["gopal@example.com"],
    cc: [],
  },
  subject: "☀️ Your Morning Brew: March 17, 2026",
  dateReceived: new Date("2026-03-17T06:00:00.000Z"),
  gmailCategory: "promotions",
  labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
  isUnread: true,
  snippet: "Good morning! Here's what you need to know today: markets open flat, AI regulation...",
};

/**
 * Personal email from a colleague (primary tab, already read, human sender).
 */
export const personalEmail: EmailMetadata = {
  messageId: "msg-personal-002",
  threadId: "thread-personal-002",
  sender: {
    email: "sarah.johnson@gmail.com",
    name: "Sarah Johnson",
  },
  recipients: {
    to: ["gopal@example.com"],
    cc: [],
  },
  subject: "Dinner plans this weekend?",
  dateReceived: new Date("2026-03-16T19:45:00.000Z"),
  gmailCategory: "primary",
  labels: ["INBOX"],
  isUnread: false,
  snippet: "Hey! Are you free Saturday evening? We were thinking of trying that new Italian place...",
};

/**
 * Financial notification from a bank (updates tab, recent, system sender).
 */
export const financialNotificationEmail: EmailMetadata = {
  messageId: "msg-finance-003",
  threadId: "thread-finance-003",
  sender: {
    email: "alerts@notifications.chase.com",
    name: "Chase Bank",
  },
  recipients: {
    to: ["gopal@example.com"],
    cc: [],
  },
  subject: "Your Chase statement is ready",
  dateReceived: new Date("2026-03-15T08:00:00.000Z"),
  gmailCategory: "updates",
  labels: ["INBOX", "CATEGORY_UPDATES"],
  isUnread: false,
  snippet: "Your March 2026 statement for account ending in 4521 is now available. Log in to view...",
};

/**
 * Social notification from LinkedIn (social tab, unread).
 */
export const socialNotificationEmail: EmailMetadata = {
  messageId: "msg-social-004",
  threadId: "thread-social-004",
  sender: {
    email: "notifications-noreply@linkedin.com",
    name: "LinkedIn",
  },
  recipients: {
    to: ["gopal@example.com"],
    cc: [],
  },
  subject: "You appeared in 12 searches this week",
  dateReceived: new Date("2026-03-17T09:00:00.000Z"),
  gmailCategory: "social",
  labels: ["INBOX", "UNREAD", "CATEGORY_SOCIAL"],
  isUnread: true,
  snippet: "Recruiters and hiring managers are looking at your profile. Stand out by updating...",
};

/**
 * Tax-related email from the IRS (primary tab, important).
 */
export const taxEmail: EmailMetadata = {
  messageId: "msg-tax-005",
  threadId: "thread-tax-005",
  sender: {
    email: "do-not-reply@irs.gov",
    name: "Internal Revenue Service",
  },
  recipients: {
    to: ["gopal@example.com"],
    cc: [],
  },
  subject: "IRS: Your 2025 tax return has been received",
  dateReceived: new Date("2026-03-10T14:30:00.000Z"),
  gmailCategory: "primary",
  labels: ["INBOX", "IMPORTANT"],
  isUnread: false,
  snippet: "We have received your 2025 federal income tax return. Your confirmation number is...",
};

/**
 * Property management email with multiple recipients (primary tab, multi-thread history).
 */
export const propertyManagementEmail: EmailMetadata = {
  messageId: "msg-property-006",
  threadId: "thread-property-001",
  sender: {
    email: "maintenance@sunsetapartments.com",
    name: "Sunset Apartments Maintenance",
  },
  recipients: {
    to: ["gopal@example.com"],
    cc: ["office@sunsetapartments.com", "supervisor@sunsetapartments.com"],
  },
  subject: "Re: Re: Re: Unit 4B — HVAC service scheduled for March 20",
  dateReceived: new Date("2026-03-16T11:15:00.000Z"),
  gmailCategory: "primary",
  labels: ["INBOX"],
  isUnread: true,
  snippet: "Hi Gopal, our technician will arrive between 10am-12pm on Thursday March 20th. Please...",
};

/**
 * Forum digest from a developer mailing list (forums tab, read).
 */
export const forumDigestEmail: EmailMetadata = {
  messageId: "msg-forum-007",
  threadId: "thread-forum-007",
  sender: {
    email: "typescript-weekly@lists.typestrong.org",
    name: "TypeScript Weekly Digest",
  },
  recipients: {
    to: ["gopal@example.com"],
    cc: [],
  },
  subject: "[TypeScript Weekly] Issue #312 — satisfies operator deep dive",
  dateReceived: new Date("2026-03-14T16:00:00.000Z"),
  gmailCategory: "forums",
  labels: ["INBOX", "CATEGORY_FORUMS"],
  isUnread: false,
  snippet: "This week we explore the satisfies operator, why it differs from as, and when to use...",
};

/** All sample messages as a flat array for iteration in tests. */
export const sampleMessages: readonly EmailMetadata[] = [
  newsletterEmail,
  personalEmail,
  financialNotificationEmail,
  socialNotificationEmail,
  taxEmail,
  propertyManagementEmail,
  forumDigestEmail,
];
