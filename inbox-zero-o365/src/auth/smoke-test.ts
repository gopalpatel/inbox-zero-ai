/**
 * smoke-test.ts — Verify Graph API connection to O365 tenant.
 *
 * Calls getProfile() and listFolders() to confirm auth works and
 * prints a summary of the mailbox to stdout.
 */

import { createGraphClient } from "./graph-client.js";

/**
 * Connects to Microsoft Graph, fetches mailbox profile and folders,
 * and prints results to stdout. Throws on any failure so the CLI boundary
 * (wrapAction) can own the exit code.
 */
export async function runSmokeTest(): Promise<void> {
  let graph: Awaited<ReturnType<typeof createGraphClient>>;
  try {
    console.log("Connecting to Microsoft Graph...");
    graph = await createGraphClient();
  } catch (err: unknown) {
    throw new Error(`Graph client setup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Profile ---
  const profile = await graph.getProfile();
  if (!profile.ok) {
    throw new Error(`getProfile failed: ${profile.error}`);
  }
  console.log(`Mailbox: ${profile.value.emailAddress} (${profile.value.displayName})`);

  // --- Folders ---
  const folders = await graph.listFolders();
  if (!folders.ok) {
    throw new Error(`listFolders failed: ${folders.error}`);
  }

  console.log(`\nFolders (${folders.value.length}):`);
  for (const f of folders.value) {
    console.log(`  ${f.displayName}: ${f.totalItemCount} items (${f.unreadItemCount} unread)`);
  }

  console.log("\nSmoke test passed.");
}
