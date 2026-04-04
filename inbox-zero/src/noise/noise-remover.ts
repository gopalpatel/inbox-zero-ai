/**
 * NoiseRemover — archives historical noise emails in bulk.
 *
 * For each noise sender:
 * 1. Paginates through ALL their messages via `GmailClient.listMessages("from:sender")`.
 * 2. Batch-modifies in chunks of up to 1000 IDs per call.
 * 3. Removes from INBOX, adds the `_noise` label.
 *
 * Design decisions:
 * - Up to 1000 message IDs per batchModify call (Gmail API limit).
 * - Pagination follows nextPageToken to collect ALL messages per sender.
 * - MAX_MESSAGES_PER_SENDER safety limit prevents runaway loops.
 * - Progress callback fires per sender, reporting messagesArchived.
 * - Partial failures: one failed sender does not stop the rest.
 * - `maxSenders` safety limit prevents runaway processing.
 */

import type { GmailClient } from "../auth/gmail-client.js";
import { chunkArray } from "../utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of message IDs per batchModify call.
 * Gmail API hard limit is 1000.
 */
const BATCH_MODIFY_CHUNK_SIZE = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Progress report emitted after each sender is processed. */
export interface ArchiveProgress {
  /** The sender email address that was just processed. */
  sender: string;
  /** Number of messages archived for this sender. */
  messagesArchived: number;
  /** Total number of senders in the current run. */
  totalSenders: number;
  /** Zero-based index of the current sender in the list. */
  currentSenderIndex: number;
}

export interface ArchiveNoiseSendersOptions {
  /** Called after each sender is processed (including zero-message senders). */
  onProgress?: (progress: ArchiveProgress) => void;
  /**
   * Optional limit on the number of senders to process in this run.
   */
  maxSenders?: number;
  /**
   * Optional limit on messages collected for a single sender.
   * If hit before pagination completes, the sender is marked as truncated.
   */
  maxMessagesPerSender?: number;
}

export interface ArchiveNoiseSendersResult {
  /** Total number of messages archived across all senders. */
  totalArchived: number;
  /** Per-sender failures. */
  failures: Array<{ sender: string; error: string }>;
}

// ---------------------------------------------------------------------------
// archiveNoiseSenders
// ---------------------------------------------------------------------------

/**
 * Archives all emails from noise senders by removing them from INBOX
 * and applying the `_noise` label.
 *
 * @param client - Authenticated GmailClient.
 * @param senders - List of sender email addresses to archive.
 * @param noiseLabelId - The ID of the `_noise` Gmail label.
 * @param options - Optional configuration (onProgress, maxSenders).
 * @returns Summary of archived message counts and per-sender failures.
 */
export async function archiveNoiseSenders(
  client: GmailClient,
  senders: string[],
  noiseLabelId: string,
  options: ArchiveNoiseSendersOptions = {},
): Promise<ArchiveNoiseSendersResult> {
  if (options.maxSenders !== undefined && options.maxSenders <= 0) {
    throw new RangeError(`maxSenders must be a positive integer, got ${options.maxSenders}`);
  }
  if (options.maxMessagesPerSender !== undefined && options.maxMessagesPerSender <= 0) {
    throw new RangeError(`maxMessagesPerSender must be a positive integer, got ${options.maxMessagesPerSender}`);
  }

  const failures: Array<{ sender: string; error: string }> = [];
  let totalArchived = 0;

  const activeSenders = options.maxSenders !== undefined ? senders.slice(0, options.maxSenders) : senders;
  const totalSenders = activeSenders.length;

  for (let i = 0; i < activeSenders.length; i++) {
    const sender = activeSenders[i]!;

    // ------------------------------------------------------------------
    // 1. Paginate through ALL messages from this sender.
    // ------------------------------------------------------------------
    const allMessageIds: string[] = [];
    let pageToken: string | undefined;
    let paginationFailed = false;
    let paginationError = "";

    do {
      const listResult = await client.listMessages(`from:${sender}`, pageToken);

      if (!listResult.ok) {
        paginationFailed = true;
        paginationError = listResult.error;
        break;
      }

      for (const m of listResult.value.messages) {
        if (options.maxMessagesPerSender !== undefined && allMessageIds.length >= options.maxMessagesPerSender) {
          break;
        }
        allMessageIds.push(m.id);
      }

      pageToken = listResult.value.nextPageToken;

      // Break pagination loop if cap is reached.
      if (options.maxMessagesPerSender !== undefined && allMessageIds.length >= options.maxMessagesPerSender) {
        break;
      }
    } while (pageToken);

    const senderWasTruncated =
      pageToken !== undefined &&
      options.maxMessagesPerSender !== undefined &&
      allMessageIds.length >= options.maxMessagesPerSender;

    if (paginationFailed) {
      failures.push({ sender, error: paginationError });
      options.onProgress?.({
        sender,
        messagesArchived: 0,
        totalSenders,
        currentSenderIndex: i,
      });
      continue;
    }

    if (senderWasTruncated) {
      failures.push({
        sender,
        error:
          `Stopped after ${options.maxMessagesPerSender} messages for this sender; ` +
          "increase maxMessagesPerSender to finish the retroactive archive.",
      });
    }

    if (allMessageIds.length === 0) {
      options.onProgress?.({
        sender,
        messagesArchived: 0,
        totalSenders,
        currentSenderIndex: i,
      });
      continue;
    }

    // ------------------------------------------------------------------
    // 2. Batch-modify in chunks of BATCH_MODIFY_CHUNK_SIZE.
    // ------------------------------------------------------------------
    const chunks = chunkArray(allMessageIds, BATCH_MODIFY_CHUNK_SIZE);
    let senderArchived = 0;
    let senderFailed = false;
    let senderError = "";

    for (const chunk of chunks) {
      const modifyResult = await client.batchModifyMessages(
        chunk,
        [noiseLabelId], // addLabelIds
        ["INBOX"], // removeLabelIds
      );

      if (!modifyResult.ok) {
        senderFailed = true;
        senderError = modifyResult.error;
        break;
      }

      senderArchived += chunk.length;
    }

    if (senderFailed) {
      failures.push({ sender, error: senderError });
      // Count partial success if some chunks succeeded before the failure.
      totalArchived += senderArchived;
    } else {
      totalArchived += senderArchived;
    }

    options.onProgress?.({
      sender,
      messagesArchived: senderArchived,
      totalSenders,
      currentSenderIndex: i,
    });
  }

  return { totalArchived, failures };
}
