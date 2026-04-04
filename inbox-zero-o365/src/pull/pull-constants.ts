/**
 * Constants for the metadata puller — page sizes, field selections, and folder exclusions.
 */

/** Number of messages per Graph API page request. */
export const PAGE_SIZE = 500;

/** Number of messages per saved batch file. */
export const BATCH_FILE_SIZE = 500;

/** Select fields for the Graph API message query. */
export const MESSAGE_SELECT_FIELDS = [
  "id",
  "conversationId",
  "from",
  "toRecipients",
  "ccRecipients",
  "subject",
  "receivedDateTime",
  "categories",
  "isRead",
  "parentFolderId",
  "bodyPreview",
  "flag",
  "importance",
];

/** System folder display names to exclude from export. */
export const EXCLUDED_FOLDER_NAMES = new Set([
  "Drafts",
  "Sent Items",
  "Deleted Items",
  "Junk Email",
  "Outbox",
  "Conversation History",
  "Sync Issues",
]);
