# Data Handover: Gmail Pipeline Output

This document describes the structured data produced by the inbox-zero pipeline, where it lives, and how to use it for downstream work (Obsidian People notes, identity graph, content extraction).

## What the Pipeline Produces

After running the full pipeline (pull → enrich → review → execute), you will have:

- **Sender database** — every sender classified by type and reviewed with a keep/filter/unsubscribe decision
- **Decision log** — append-only record of every review action with timestamps
- **Batch metadata** — raw message metadata (sender, subject, date, labels) in 500-message batches
- **Google Contacts export** — all contacts with emails, phones, organizations (optional step)
- **Audit spreadsheet** — Google Sheets projection for human review

## Data Files & Locations

All paths relative to `inbox-zero/`.

| File | Description |
|------|-------------|
| `data/sender-state.v1.json` | **Canonical sender database.** Every sender with: email, name, email count, sender type, confidence tier, recommended action, sample subjects, dates, starred/important counts. |
| `data/decision-log.json` | **All decisions.** Every review action with: sender email, presented type, user decision, run ID, batch ID, timestamp, messages archived. |
| `data/contacts.json` | **Google Contacts export.** Contacts with: name, emails (with type), phones (with type), organizations, addresses, birthdays. |
| `data/manifests/*.json` | Frozen batch manifests — the operational record of what was executed. |
| `data/batch-*.json` | Raw metadata batches — up to 500 messages each. |

## Key Data Schemas

### sender-state.v1.json

```json
{
  "version": 1,
  "mailbox": "you@example.com",
  "generatedAt": "2026-03-21T13:37:37.353Z",
  "senders": [
    {
      "senderEmail": "person@example.com",
      "senderName": "Jane Doe",
      "emailCount": 150,
      "firstEmailDate": "2018-01-15T00:00:00Z",
      "lastEmailDate": "2026-03-10T00:00:00Z",
      "gmailCategory": "primary",
      "unreadRatio": 0.25,
      "threadCount": 80,
      "sampleSubjects": ["Re: Project update", "Lunch Thursday?"],
      "senderType": "human",
      "senderTypeConfidence": 0.95,
      "senderTypeSource": "heuristic",
      "confidenceTier": "probably_keep",
      "recommendedAction": "keep",
      "extractionCandidate": true,
      "starredCount": 5,
      "importantCount": 30,
      "surprisesFlag": false
    }
  ]
}
```

**Key fields for downstream use:**
- `senderType` — human | company | newsletter | automated | unknown
- `senderTypeSource` — "user" means a human reviewed and confirmed/corrected it
- `confidenceTier` — definitely_noise | probably_noise | probably_keep | definitely_keep
- `extractionCandidate` — flagged during enrichment as worth extracting content from
- `emailCount` + `lastEmailDate` — indicates relationship weight and recency

### contacts.json

```json
{
  "extractedAt": "2026-03-23T...",
  "totalContacts": 3187,
  "contacts": [
    {
      "name": "Jane Doe",
      "givenName": "Jane",
      "familyName": "Doe",
      "emails": [{"value": "jane@example.com", "type": "work"}],
      "phones": [{"value": "+447912345678", "type": "mobile"}],
      "organizations": [{"name": "Acme Corp", "title": "CEO", "department": null}],
      "addresses": [{"formattedValue": "123 Main St, London", "type": "home"}],
      "birthday": {"year": 1985, "month": 3, "day": 15}
    }
  ]
}
```

### decision-log.json

```json
{
  "version": 1,
  "decisions": [
    {
      "runId": "run-2026-03-22-human",
      "senderEmail": "person@example.com",
      "senderName": "Jane Doe",
      "presentedSenderType": "human",
      "senderTypeFeedback": "none",
      "systemRecommendation": "filter",
      "userDecision": "filter",
      "batchId": "batch-human-high-01-archive",
      "timestamp": "2026-03-22T...",
      "emailCount": 150,
      "messagesArchived": 148,
      "actionsTaken": []
    }
  ]
}
```

**Decision meanings:**
- `"keep"` — sender is valuable, emails stay in inbox
- `"filter"` — archive historical emails, create filter for ongoing noise management
- `"unsubscribe"` — archive + suppress future emails

### batch-*.json (message metadata)

```json
[
  {
    "id": "18e3a1b2c3d4e5f6",
    "threadId": "18e3a1b2c3d4e5f6",
    "from": "person@example.com",
    "to": "you@example.com",
    "subject": "Re: Project update",
    "date": "2026-03-10T14:30:00.000Z",
    "labels": ["INBOX", "IMPORTANT"]
  }
]
```

## How to Build an Identity Graph

The identity graph links people across channels (email, phone/WhatsApp, meetings).

### Step 1: Match contacts to senders

Cross-reference `contacts.json` emails against `sender-state.v1.json` sender emails. This links contact records (with phone numbers) to email activity (with volume, recency, type).

### Step 2: Enrich with relationship context

For matched contacts, add any relationship data you have. This includes: role, business context, relationship type, action items. You can build a `key-relationships.md` file during the review process to capture this context.

### Step 3: Generate People notes

For each person with enough signal, generate an Obsidian People note with:
- YAML frontmatter: name, emails, phones, organization, relationship type
- Body: relationship context, email volume/recency summary, action items
- Links: to relevant business entities, projects, other people

### Step 4: WhatsApp / phone matching

Use phone numbers from `contacts.json` to match against WhatsApp message exports or call logs. The phone number bridges email identity to messaging identity.

## How to Extract Email Content

The sender-state flags `extractionCandidate: true` for senders whose emails are worth pulling full body content from.

The batch files contain message IDs and metadata but NOT body content. To extract bodies:

1. Use the Gmail API `getMessage` with `format: "full"` for specific message IDs
2. Target messages from high-value senders (human type, extraction candidates)
3. Focus on threads with meaningful subject lines

### Finding message IDs for a sender

```bash
node -e "
const fs = require('fs');
const target = 'person@example.com'.toLowerCase();
const ids = [];
for (const f of fs.readdirSync('data').filter(f => f.startsWith('batch-') && f.endsWith('.json'))) {
  const batch = JSON.parse(fs.readFileSync('data/' + f, 'utf8'));
  for (const msg of batch) {
    if (msg.from && msg.from.toLowerCase().includes(target)) {
      ids.push({ id: msg.id, subject: msg.subject, date: msg.date });
    }
  }
}
console.log(JSON.stringify(ids, null, 2));
"
```

### Retrieving full messages

Use the Gmail API via the service account:

```bash
npm run cli -- get-message --id <MESSAGE_ID>
```

Or via `gws` CLI:

```bash
gws gmail users messages get --params '{"userId":"you@example.com","id":"MESSAGE_ID","format":"full"}'
```

## Using This Data with an AI Agent

When working with a terminal-based AI agent (e.g. Claude Code), the agent can:

1. **Read sender-state** to understand your email landscape and prioritize extraction
2. **Query batch files** to find specific messages by sender, date, or subject
3. **Use the CLI** to retrieve full message bodies for high-value senders
4. **Generate Obsidian notes** from extracted content with proper YAML frontmatter
5. **Build the identity graph** by cross-referencing contacts with sender activity

Point the agent at this file first — it contains everything needed to work with the pipeline output.

## Key Invariants

- **Canonical state is sender-state.v1.json** — Google Sheets are projections, not sources of truth
- **Decision log is append-only** — sweep and filters read from it
- **Batch manifests are frozen before execution** — no mutations without a manifest on disk
- **All JSON writes are atomic** — tmp + rename via `atomicWriteFile`
