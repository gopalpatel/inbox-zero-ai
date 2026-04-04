# inbox-zero — Gmail Pipeline

A TypeScript CLI toolchain for cleaning up large Gmail mailboxes safely and incrementally. Pulls metadata, classifies senders with heuristics + optional LLM, presents batches for human review via Google Sheets, then executes decisions (archive, filter, unsubscribe).

Designed to be run collaboratively with a terminal-based AI agent (Claude Code, Codex, etc.) that guides you through each phase.

## How It Works

The pipeline has 5 phases. Each phase produces durable output files so you can stop and resume at any point.

```
pull → enrich → review (Google Sheets) → execute → sweep (ongoing)
```

1. **Pull** — download email metadata from Gmail (resumable, checkpointed)
2. **Enrich** — classify every sender as human/company/newsletter/automated using heuristics + optional Claude Haiku
3. **Review** — push sender data to Google Sheets for human review (keep / filter / unsubscribe per sender)
4. **Execute** — apply decisions: archive noise, create Gmail filters, update sender state
5. **Sweep** — ongoing maintenance: archive new mail from noise senders

## Prerequisites

- **Node.js** >= 20
- **npm** >= 10
- A **Google Cloud Platform** project with Gmail API and Sheets API enabled
- A **Google Workspace** account (for domain-wide delegation) — or a personal Gmail with OAuth
- (Optional) An **Anthropic API key** for LLM-powered sender classification

## Setup

### 1. Clone and install

```bash
cd inbox-zero
npm install
```

### 2. Google Cloud Platform — Service Account

This pipeline uses a GCP service account with domain-wide delegation to access Gmail on your behalf. This avoids OAuth token expiry during long-running operations.

#### Create the GCP project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (e.g. `inbox-zero-automation`)
3. Enable these APIs:
   - **Gmail API** — `gmail.googleapis.com`
   - **Google Sheets API** — `sheets.googleapis.com`
   - **People API** — `people.googleapis.com` (for contacts extraction)

#### Create the service account

1. Go to **IAM & Admin → Service Accounts**
2. Click **Create Service Account**
3. Name it (e.g. `inbox-zero-automation`)
4. Skip optional permissions
5. Click **Done**
6. Click the service account → **Keys** tab → **Add Key → Create new key → JSON**
7. Save the JSON key file as `.secrets/service-account.json` in this directory (gitignored)

#### Set up domain-wide delegation (Google Workspace only)

This step allows the service account to impersonate users in your Workspace domain.

1. In GCP Console, go to your service account → **Details** tab
2. Note the **Client ID** (numeric, e.g. `111853275712394185142`)
3. In [Google Workspace Admin Console](https://admin.google.com/) → **Security → Access and data control → API controls → Domain-wide delegation**
4. Click **Add new**
5. Enter the Client ID and these scopes:
   ```
   https://www.googleapis.com/auth/gmail.modify,
   https://www.googleapis.com/auth/gmail.settings.basic,
   https://www.googleapis.com/auth/spreadsheets,
   https://www.googleapis.com/auth/contacts.readonly
   ```
6. Click **Authorize**

#### For personal Gmail (no Workspace)

If you don't have a Google Workspace domain, you can use OAuth2 instead of a service account:

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/gmail.settings.basic,https://www.googleapis.com/auth/spreadsheets
```

Set `GOOGLE_CLOUD_PROJECT=your-project-id` in `.env` and omit the service account key.

### 3. Anthropic API key (optional)

The LLM enrichment step uses Claude Haiku to classify ambiguous senders. This is optional — heuristic classification works well for most senders.

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Create an account and add billing
3. Go to **API Keys** → **Create Key**
4. Copy the key (starts with `sk-ant-`)

### 4. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Path to your GCP service account key (downloaded in step 2)
GOOGLE_SERVICE_ACCOUNT_KEY=.secrets/service-account.json

# The Gmail address you want to process
GMAIL_USER=you@example.com

# Google Sheets spreadsheet ID (created automatically by the enrich command)
AUDIT_SHEET_ID=

# Anthropic API key for LLM classification (optional — omit for heuristic-only)
ANTHROPIC_API_KEY=sk-ant-...

# Data directory (defaults to ./data)
DATA_DIR=./data
```

### 5. Verify setup

```bash
npm run cli -- pull --dry-run
```

If auth is configured correctly, this will print the mailbox summary without downloading anything.

## Usage

### Phase 1: Pull metadata

```bash
npm run cli -- pull
```

Downloads message metadata (sender, subject, date, labels) for every message. Resumable — if interrupted, rerun to continue from the last checkpoint.

**Output:** `data/batch-*.json` files (500 messages each)

### Phase 2: Enrich senders

```bash
npm run cli -- enrich              # heuristic + LLM
npm run cli -- enrich --skip-llm   # heuristic only
```

Classifies every sender and pushes results to a Google Sheets audit spreadsheet.

**Output:** `data/sender-state.v1.json`, Google Sheets audit report

### Phase 3: Review in Google Sheets

Open the audit spreadsheet (URL printed by enrich command). For each sender batch:

- **keep** — sender is valuable, leave emails in inbox
- **filter** — archive old emails, create filter for ongoing management
- **unsubscribe** — archive everything, suppress future emails

### Phase 4: Execute decisions

```bash
npm run cli -- execute-batch --manifest data/manifests/batch-xxx.json --sheet-id <SHEET_ID>
npm run cli -- execute-batch --manifest data/manifests/batch-xxx.json --sheet-id <SHEET_ID> --dry-run  # preview first
```

Reads decisions from the manifest, archives messages, creates filters.

### Phase 5: Ongoing sweep

```bash
npm run cli -- sweep              # archive new noise from inbox
npm run cli -- sweep --dry-run    # preview what would be archived
```

### Multiple mailboxes

Process a different mailbox by overriding env vars:

```bash
DATA_DIR=./data-other GMAIL_USER=other@example.com npm run cli -- pull
```

### Extract Google Contacts

```bash
npm run cli -- extract-contacts
```

**Output:** `data/contacts.json`

## Working with an AI Agent

This tool is designed to be used collaboratively with a terminal-based AI agent. The recommended workflow:

1. **Tell the agent** to read `CLAUDE.md` and `DATA-HANDOVER.template.md` for context
2. **Run pull together** — the agent can monitor progress and handle errors
3. **Review enrichment** — the agent can explain sender classifications and suggest review priorities
4. **Execute in batches** — the agent helps build manifests and runs execute-batch with dry-run first
5. **Extract to Obsidian** — the agent uses sender-state and contacts to generate People notes and knowledge notes

The `CLAUDE.md` file contains agent-specific instructions (CLI commands, data schemas, patterns to follow).

## Testing

```bash
npm run test              # vitest run
npm run typecheck         # tsc --noEmit (if configured)
npm run lint              # biome check src/ tests/
```

## Project Structure

```
src/
  cli.ts                  # CLI entry point (commander)
  pull/                   # Gmail metadata download
  enrich/                 # Sender classification (heuristic + LLM)
  execute/                # Decision execution (archive, filter)
  sweep/                  # Ongoing noise management
  sheets/                 # Google Sheets integration
  schemas/                # Zod schemas (single source of truth)
  utils/                  # Shared utilities (atomic writes, rate limiting)
tests/                    # Test files mirroring src/ structure
data/                     # Generated data (gitignored)
.secrets/                 # Credentials (gitignored)
```

## Gmail-Specific Notes

- `_noise` Gmail label is applied to archived noise senders
- Per-sender Gmail filters can be consolidated via `migrate-filters` command
- `from:sender in:inbox` queries target only inbox messages
- Pipe-character emails (`|`) break Gmail `from:` queries — skipped automatically
- Google Sheets quota: ~60 writes/min on large batches; manifests are resumable

## License

ISC
