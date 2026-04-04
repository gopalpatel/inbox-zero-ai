# Data Handover: O365 Pipeline Output

Advisory note for downstream consumers (Obsidian vault agents, identity graph builders). This describes the structured data produced by the inbox-zero-o365 pipeline and how to use it.

**Contacts are processed from the Gmail pipeline.** This handover covers O365 email data only.

## What the Pipeline Produces

After running the full pipeline (pull → analyze → enrich → review → execute), you will have:

- **Sender database** — every sender classified and reviewed
- **Decision log** — append-only record of every review action
- **Batch metadata** — raw message metadata across all batch files
- **Inbox rules** — auto-archive rules for noise senders
- **Audit spreadsheet** — Google Sheets projection for human review

## Data Files & Locations

All paths relative to `inbox-zero-o365/`.

| File | Description |
|------|-------------|
| `data/sender-state.v1.json` | **Canonical sender database.** Same schema as the Gmail app. Only difference: `gmailCategory` is always `"unknown"` since O365 has no Gmail-style tab categories. |
| `data/decision-log.json` | **All decisions.** Every sender review action with decision, timestamp, messages archived. |
| `data/batch-00001.json` through `data/batch-NNNNN.json` | **Raw metadata.** ~285 messages per file. Contains messageId, conversationId, sender, recipients, subject, date, labels, snippet. |
| `data/manifests/batch-o365-*.json` | Frozen batch manifests — operational record of what was executed. |

## Schema

The `sender-state.v1.json` and all batch files use the exact same Zod schemas as the Gmail pipeline. See `inbox-zero/DATA-HANDOVER.template.md` for full schema documentation.

### O365 batch format differences

O365 batch files use a slightly different structure from Gmail:

```json
[
  {
    "messageId": "AAkALgAA...",
    "conversationId": "AAQkAGdw...",
    "sender": {
      "name": "Jane Doe",
      "email": "jane@example.com"
    },
    "recipients": ["you@example.com"],
    "subject": "Re: Project update",
    "dateReceived": "2026-03-10T14:30:00.000Z",
    "labels": ["inbox"],
    "snippet": "First 200 chars of email body..."
  }
]
```

Key differences from Gmail batch format:
- `sender.email` (nested object) instead of `from` (flat string)
- `messageId` instead of `id`
- `conversationId` instead of `threadId`
- `dateReceived` instead of `date`
- All message IDs are Graph **immutable IDs** (survive folder moves)

## How to Retrieve Full Email Content

The batch files contain metadata only — NOT full body content. To extract bodies, use the Microsoft Graph API.

### Auth

The O365 app uses client credentials auth. Configure in `.env`:
- `O365_TENANT_ID`, `O365_CLIENT_ID`, `O365_CLIENT_SECRET`
- `O365_USER_EMAIL=mailbox@example.com`

### Retrieving a message by ID

Every `messageId` in the batch files is a Graph immutable ID:

```
GET https://graph.microsoft.com/v1.0/users/{email}/messages/{messageId}
Header: Prefer: IdType="ImmutableId"
```

### Finding message IDs for a sender

```bash
node -e "
const fs = require('fs');
const target = 'person@example.com'.toLowerCase();
const ids = [];
for (const f of fs.readdirSync('data').filter(f => f.startsWith('batch-') && f.endsWith('.json'))) {
  const batch = JSON.parse(fs.readFileSync('data/' + f, 'utf8'));
  for (const msg of batch) {
    if (msg.sender?.email?.toLowerCase() === target) {
      ids.push({ id: msg.messageId, subject: msg.subject, date: msg.dateReceived });
    }
  }
}
console.log(JSON.stringify(ids, null, 2));
"
```

### Bulk retrieval with the Graph SDK

```javascript
const { ClientSecretCredential } = require("@azure/identity");
const { Client } = require("@microsoft/microsoft-graph-client");
const { TokenCredentialAuthenticationProvider } = require(
  "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials"
);

const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
const authProvider = new TokenCredentialAuthenticationProvider(credential, {
  scopes: ["https://graph.microsoft.com/.default"],
});
const client = Client.initWithMiddleware({ authProvider });

const message = await client
  .api(`/users/${userEmail}/messages/${messageId}`)
  .header("Prefer", 'IdType="ImmutableId"')
  .select(["subject", "body", "from", "toRecipients", "receivedDateTime"])
  .get();

// message.body.content contains the HTML body
// message.body.contentType is "html" or "text"
```

## Cross-Reference with Gmail Pipeline

The O365 sender-state uses identical schemas to the Gmail pipeline. To build a unified view:

1. Load `inbox-zero/data/sender-state.v1.json` (Gmail senders)
2. Load `inbox-zero-o365/data/sender-state.v1.json` (O365 senders)
3. Match by `senderEmail` (lowercase) — some senders appear in both mailboxes
4. For People notes, combine email counts and dates from both sources

The Gmail pipeline's `contacts.json` provides phone numbers and organizations that the O365 pipeline doesn't have. Use contacts as the person-level anchor, with sender-state from both mailboxes providing email activity context.

## Using This Data with an AI Agent

When working with a terminal-based AI agent (e.g. Claude Code), the agent can:

1. **Read sender-state** to understand your email landscape and prioritize extraction
2. **Query batch files** to find specific messages by sender, date, or subject
3. **Use the Graph API** to retrieve full message bodies for high-value senders
4. **Generate Obsidian notes** from extracted content with proper YAML frontmatter
5. **Cross-reference** with Gmail pipeline data for a unified identity graph

Point the agent at this file first — it contains everything needed to work with the pipeline output.

## Key Invariants

- **Canonical state is sender-state.v1.json** — Google Sheets are projections, not sources of truth
- **Decision log is append-only** — rules and archive reads from it
- **Batch manifests are frozen before execution** — no mutations without a manifest on disk
- **All JSON writes are atomic** — tmp + rename via `atomicWriteFile`
- **O365 uses immutable IDs** — `Prefer: IdType="ImmutableId"` on every Graph request
