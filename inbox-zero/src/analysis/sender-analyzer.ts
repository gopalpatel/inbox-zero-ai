import type { EmailMetadata } from "../schemas/email-metadata.js";
import type { SenderStats } from "../schemas/sender-stats.js";

// ---------------------------------------------------------------------------
// Internal accumulator types
// ---------------------------------------------------------------------------

/**
 * Accumulator for building SenderStats from raw EmailMetadata.
 * Keyed by lowercase sender email in the outer Map.
 */
interface SenderAccumulator {
  /** Lowercase normalized email address (the Map key) */
  senderEmail: string;

  /** Most-recently-seen display name for this sender */
  senderName: string;

  /** Date of the most recent email (used to pick up-to-date display name) */
  latestNameDate: Date;

  /** Total email count */
  emailCount: number;

  /** Count of emails where isUnread === true */
  unreadCount: number;

  /** Count of emails with the STARRED label */
  starredCount: number;

  /** Count of emails with the IMPORTANT label */
  importantCount: number;

  /** Distinct threadIds */
  threadIds: Set<string>;

  /**
   * All subject+date pairs seen so far, deduplicated by subject text.
   * Map key: subject string — value: the most-recent date seen for that subject.
   */
  subjectDates: Map<string, Date>;

  /** Category frequency counter */
  categoryCounts: Map<string, number>;

  /** Earliest email date */
  firstDate: Date;

  /** Most recent email date */
  lastDate: Date;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Aggregate raw email metadata into per-sender statistics.
 *
 * @param emails - Flat array of EmailMetadata loaded from all checkpoint batches.
 * @returns SenderStats array sorted by emailCount descending.
 *          Does NOT populate confidenceTier, recommendedAction, or userDecision —
 *          those are filled in by the confidence scorer (Task 9).
 */
export function analyzeSenders(emails: EmailMetadata[]): SenderStats[] {
  if (emails.length === 0) {
    return [];
  }

  // ---- Accumulation phase -------------------------------------------------
  const accMap = new Map<string, SenderAccumulator>();

  for (const email of emails) {
    const key = email.sender.email.toLowerCase();

    let acc = accMap.get(key);
    if (acc === undefined) {
      acc = {
        senderEmail: key,
        senderName: email.sender.name,
        latestNameDate: email.dateReceived,
        emailCount: 0,
        unreadCount: 0,
        starredCount: 0,
        importantCount: 0,
        threadIds: new Set<string>(),
        subjectDates: new Map<string, Date>(),
        categoryCounts: new Map<string, number>(),
        firstDate: email.dateReceived,
        lastDate: email.dateReceived,
      };
      accMap.set(key, acc);
    }

    // email count
    acc.emailCount += 1;

    // unread count
    if (email.isUnread) {
      acc.unreadCount += 1;
    }

    // starred / important counts
    if (email.labels.includes("STARRED")) {
      acc.starredCount += 1;
    }
    if (email.labels.includes("IMPORTANT")) {
      acc.importantCount += 1;
    }

    // thread tracking
    acc.threadIds.add(email.threadId);

    // subject deduplication: keep the most recent date per subject
    const existingDate = acc.subjectDates.get(email.subject);
    if (existingDate === undefined || email.dateReceived > existingDate) {
      acc.subjectDates.set(email.subject, email.dateReceived);
    }

    // category frequency
    const catCount = acc.categoryCounts.get(email.gmailCategory) ?? 0;
    acc.categoryCounts.set(email.gmailCategory, catCount + 1);

    // date range
    if (email.dateReceived < acc.firstDate) {
      acc.firstDate = email.dateReceived;
    }
    if (email.dateReceived > acc.lastDate) {
      acc.lastDate = email.dateReceived;
    }

    // display name: track name from the most recent email
    if (email.dateReceived >= acc.latestNameDate && email.sender.name !== "") {
      acc.senderName = email.sender.name;
      acc.latestNameDate = email.dateReceived;
    }
  }

  // ---- Conversion phase ---------------------------------------------------
  const stats: SenderStats[] = [];

  for (const acc of accMap.values()) {
    // Guard against division by zero (impossible here since emailCount >= 1,
    // but kept explicit for safety)
    const unreadRatio = acc.emailCount > 0 ? acc.unreadCount / acc.emailCount : 0;

    // Most common category
    let gmailCategory = "unknown";
    let maxCatCount = 0;
    for (const [category, count] of acc.categoryCounts.entries()) {
      if (count > maxCatCount) {
        maxCatCount = count;
        gmailCategory = category;
      }
    }

    // sampleSubjects: up to 5 most-recent distinct subjects
    // Sort subject entries by date descending, take top 5
    const sortedSubjects = Array.from(acc.subjectDates.entries())
      .sort((a, b) => b[1].getTime() - a[1].getTime())
      .slice(0, 5)
      .map(([subject]) => subject);

    stats.push({
      senderEmail: acc.senderEmail,
      senderName: acc.senderName,
      emailCount: acc.emailCount,
      firstEmailDate: acc.firstDate.toISOString(),
      lastEmailDate: acc.lastDate.toISOString(),
      gmailCategory,
      unreadRatio,
      threadCount: acc.threadIds.size,
      starredCount: acc.starredCount,
      importantCount: acc.importantCount,
      sampleSubjects: sortedSubjects,
      surprisesFlag: false,
    });
  }

  // ---- Sort by emailCount descending --------------------------------------
  stats.sort((a, b) => b.emailCount - a.emailCount);

  return stats;
}
