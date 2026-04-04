/**
 * Auth smoke test — verifies gcloud ADC credentials work and the Gmail API
 * client can reach the real Gmail endpoint and settings API.
 *
 * Run with: npx tsx src/auth/smoke-test.ts
 * Optional: set AUDIT_SHEET_ID to also verify Google Sheets read access.
 */

import { createGmailClient } from "./gmail-client.js";
import { createSheetsClient } from "./sheets-client.js";

const client = await createGmailClient();
const [profileResult, labelsResult, filtersResult] = await Promise.all([
  client.getProfile(),
  client.listLabels(),
  client.listFilters(),
]);

if (!profileResult.ok) {
  console.error("Auth smoke test FAILED:", profileResult.error);
  process.exit(1);
}

console.log(
  `Authenticated as: ${profileResult.value.emailAddress}, Total messages: ${profileResult.value.messagesTotal}`,
);

if (!labelsResult.ok) {
  console.error("Label access FAILED:", labelsResult.error);
  process.exit(1);
}

if (!filtersResult.ok) {
  console.error("Settings access FAILED:", filtersResult.error);
  process.exit(1);
}

console.log(`Labels/settings OK. Labels: ${labelsResult.value.length}, Filters: ${filtersResult.value.length}`);

const sheetId = process.env["AUDIT_SHEET_ID"];
if (typeof sheetId === "string" && sheetId.trim() !== "") {
  const sheetsClient = await createSheetsClient();
  const sheetResult = await sheetsClient.readRows(sheetId, "Sheet1!A1:A1");
  if (!sheetResult.ok) {
    console.error("Sheets access FAILED:", sheetResult.error);
    process.exit(1);
  }

  console.log(`Sheets OK. Read access verified for spreadsheet ${sheetId}.`);
}
