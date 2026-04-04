# inbox-zero-o365 — Office 365 Pipeline

A TypeScript CLI toolchain for cleaning up Office 365 / Exchange Online mailboxes. Pulls metadata via Microsoft Graph API, classifies senders, presents batches for human review via Google Sheets, then executes decisions (archive, create inbox rules, unsubscribe).

Standalone sibling to [`inbox-zero`](../inbox-zero/) with zero shared runtime code but identical output schemas — any consumer of Gmail pipeline data can read O365 output unchanged.

## How It Works

```
pull → analyze → enrich → review (Google Sheets) → execute
```

1. **Pull** — download email metadata via Microsoft Graph (resumable, checkpointed)
2. **Analyze** — aggregate per-sender statistics from pulled metadata
3. **Enrich** — classify senders with heuristics + optional Claude Haiku, push to Google Sheets
4. **Review** — human review in Google Sheets (keep / filter / unsubscribe per sender)
5. **Execute** — apply decisions: move to Archive folder, create inbox rules, add `_noise` category

## Prerequisites

- **Node.js** >= 20
- **npm** >= 10
- An **Azure Entra ID** (formerly Azure AD) tenant with admin access
- A **Google Cloud Platform** project with Sheets API enabled (for audit reports)
- (Optional) An **Anthropic API key** for LLM-powered sender classification

## Setup

### 1. Clone and install

```bash
cd inbox-zero-o365
npm install
```

### 2. Azure Entra ID — App Registration

This pipeline uses client credentials (app-only) auth to access a mailbox via Microsoft Graph. No user sign-in required — runs unattended.

#### Register the application

1. Go to [Azure Portal → Entra ID → App registrations](https://portal.azure.com/#view/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/RegisteredApps)
2. Click **New registration**
3. Name it (e.g. `inbox-zero-o365`)
4. Set **Supported account types** to **Accounts in this organizational directory only** (single tenant)
5. Leave **Redirect URI** blank
6. Click **Register**

#### Note your IDs

From the app's **Overview** page, copy:
- **Application (client) ID** → this is your `O365_CLIENT_ID`
- **Directory (tenant) ID** → this is your `O365_TENANT_ID`

#### Add API permissions

1. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions**
2. Add these permissions:
   - `Mail.Read` — read all mailbox messages
   - `Mail.ReadWrite` — archive messages and manage categories
   - `MailboxSettings.ReadWrite` — create inbox rules
   - `User.Read.All` — resolve mailbox user (optional)
3. Click **Grant admin consent for [your tenant]**

#### Create a client secret

1. Go to **Certificates & secrets** → **Client secrets** → **New client secret**
2. Set a description (e.g. `inbox-zero`) and expiry
3. Copy the **Value** immediately (shown only once) → this is your `O365_CLIENT_SECRET`

### 3. Google Sheets — Service Account (for audit reports)

The audit spreadsheet uses Google Sheets via a service account. Follow the same GCP setup as the Gmail pipeline:

1. Create a GCP project with **Google Sheets API** enabled
2. Create a service account and download the JSON key to `.secrets/service-account.json`
3. If using Google Workspace, set up domain-wide delegation for the `spreadsheets` scope

See the [Gmail pipeline README](../inbox-zero/README.md#2-google-cloud-platform--service-account) for detailed steps.

**Alternative:** If you already set up the Gmail pipeline, reuse the same service account key.

### 4. Anthropic API key (optional)

Same as the Gmail pipeline — see [instructions](../inbox-zero/README.md#3-anthropic-api-key-optional).

### 5. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Azure Entra ID app registration (from step 2)
O365_TENANT_ID=your-tenant-id-here
O365_CLIENT_ID=your-client-id-here
O365_CLIENT_SECRET=your-client-secret-here

# The O365 mailbox to process
O365_USER_EMAIL=you@yourdomain.com

# Google Sheets service account (for audit reports)
GOOGLE_SERVICE_ACCOUNT_KEY=.secrets/service-account.json
GOOGLE_IMPERSONATE_USER=sheets-user@yourdomain.com

# Anthropic API key for LLM classification (optional)
ANTHROPIC_API_KEY=sk-ant-...
```

### 6. Verify setup

```bash
npm run cli -- smoke-test
```

If auth is configured correctly, this will print mailbox info and confirm Graph API access.

## Usage

### Phase 1: Pull metadata

```bash
npm run cli -- pull
npm run cli -- pull --dry-run    # preview without downloading
```

Downloads message metadata via Microsoft Graph. Resumable — rerun to continue from last checkpoint.

**Output:** `data/batch-*.json` files (~285 messages each)

### Phase 2: Analyze senders

```bash
npm run cli -- analyze
```

Aggregates per-sender statistics from the batch files.

### Phase 3: Enrich and classify

```bash
npm run cli -- enrich              # heuristic + LLM
npm run cli -- enrich --skip-llm   # heuristic only
npm run cli -- enrich --sheet-title "My O365 Review"  # custom sheet tab name
```

**Output:** `data/sender-state.v1.json`, Google Sheets audit report

### Phase 4: Review in Google Sheets

Open the audit spreadsheet. For each sender, decide: keep / filter / unsubscribe.

### Phase 5: Execute decisions

```bash
npm run cli -- execute-batch --manifest data/manifests/batch-o365-xxx.json --sheet-id <SHEET_ID> --dry-run
npm run cli -- execute-batch --manifest data/manifests/batch-o365-xxx.json --sheet-id <SHEET_ID>
```

## Working with an AI Agent

Same workflow as the Gmail pipeline — see the [Gmail README](../inbox-zero/README.md#working-with-an-ai-agent). The agent reads `CLAUDE.md` and `DATA-HANDOVER.template.md` for context.

## Key Differences from Gmail Pipeline

| Concern | Gmail (`inbox-zero/`) | O365 (`inbox-zero-o365/`) |
|---------|----------------------|--------------------------|
| Filter | Gmail filter (`from:` criteria) | Inbox rule (`senderContains`) |
| Archive | Remove INBOX label + add `_noise` label | Move to Archive folder + add `_noise` category |
| Category | Gmail tabs (primary/social/promotions) | Always `"unknown"` — O365 has no equivalent |
| Message ID | Gmail message ID | Graph immutable ID |
| Mutation retry | Retries on 429/503 | Reads retry; mutations do NOT (prevents duplicates) |
| Rule idempotency | Check existing `from:` filters | Check existing rules by `senderContains` + actions |

## Testing

```bash
npm run test              # vitest run
npm run typecheck         # tsc --noEmit
npm run lint              # biome check src/ tests/
```

## Project Structure

```
src/
  cli.ts                  # CLI entry point (commander)
  pull/                   # Graph API metadata download
  analyze/                # Sender statistics aggregation
  enrich/                 # Sender classification (heuristic + LLM)
  execute/                # Decision execution (archive, inbox rules)
  sheets/                 # Google Sheets integration
  schemas/                # Zod schemas (identical to Gmail app)
  utils/                  # Shared utilities (atomic writes, rate limiting)
tests/                    # Test files mirroring src/ structure
data/                     # Generated data (gitignored)
.secrets/                 # Credentials (gitignored)
```

## License

ISC
