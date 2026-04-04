# house-keeping

Operational automation for achieving inbox zero across Gmail and Office 365 mailboxes, then extracting high-value email content into an Obsidian-based second brain.

Two standalone CLI toolchains — one for Gmail, one for O365 — that share identical output schemas. Each uses AI-powered sender classification, batch human review via Google Sheets, and safe resumable execution to clean up even very large mailboxes (200k+ messages).

**Designed for agent-assisted workflows.** These tools work best when run collaboratively with a terminal-based AI agent (Claude Code, Codex, etc.) that guides you through each phase, explains classifications, and helps you make decisions.

## What It Does

```
  Gmail                    O365
    │                        │
    ▼                        ▼
  pull ──────────────── pull
    │                        │
  enrich ────────────── enrich
    │                        │
  review (Google Sheets) ─── review (Google Sheets)
    │                        │
  execute ───────────── execute
    │                        │
    ▼                        ▼
  sender-state.v1.json ─── sender-state.v1.json
  decision-log.json ────── decision-log.json
  contacts.json             batch-*.json
    │                        │
    └────────┬───────────────┘
             │
      identity graph
             │
      Obsidian vault
       (People notes,
        knowledge notes)
```

For each mailbox, the pipeline:

1. **Pulls** all message metadata locally (resumable, checkpointed)
2. **Classifies** every sender as human / company / newsletter / automated
3. **Presents** senders in Google Sheets for human review (keep / filter / unsubscribe)
4. **Executes** decisions: archives noise, creates filters/rules, preserves signal
5. **Produces** structured JSON that downstream tools (Obsidian agents, identity graphs) can consume

## Quick Start

```bash
# Gmail pipeline
cd inbox-zero
npm install
cp .env.example .env       # configure credentials (see README.md inside)
npm run cli -- pull --dry-run

# O365 pipeline
cd inbox-zero-o365
npm install
cp .env.example .env       # configure credentials (see README.md inside)
npm run cli -- smoke-test
```

Each pipeline has its own detailed README with step-by-step auth setup:

- **Gmail:** [`inbox-zero/README.md`](inbox-zero/README.md) — GCP service account, domain-wide delegation, Gmail API
- **O365:** [`inbox-zero-o365/README.md`](inbox-zero-o365/README.md) — Azure Entra ID app registration, Microsoft Graph API

## What You Need

| Credential | Used By | How to Get |
|------------|---------|------------|
| **GCP service account** | Gmail pipeline + Google Sheets | [GCP Console](https://console.cloud.google.com/) → Service Accounts → Create key |
| **Domain-wide delegation** | Gmail pipeline (Workspace only) | [Admin Console](https://admin.google.com/) → API controls → Domain-wide delegation |
| **Azure Entra ID app** | O365 pipeline | [Azure Portal](https://portal.azure.com/) → Entra ID → App registrations |
| **Anthropic API key** | LLM classification (optional) | [console.anthropic.com](https://console.anthropic.com/) → API Keys |

See each pipeline's README for detailed setup instructions.

## Agent Collaboration Model

These tools are built to be used with an AI coding agent in the terminal. The recommended workflow:

### Getting started with an agent

1. **Point the agent at the docs.** Tell it to read the pipeline's `CLAUDE.md` (agent instructions) and `DATA-HANDOVER.template.md` (data schema reference).

2. **Run the pipeline together.** The agent monitors progress, handles errors, and explains what each step does. The pull phase can take time on large mailboxes — the agent will track checkpoint progress.

3. **Review collaboratively.** The agent can explain sender classifications, suggest which senders to keep vs. filter, and help you build review batches. Decisions happen in Google Sheets where you have full visibility.

4. **Execute safely.** The agent runs `--dry-run` first, shows you what will happen, then executes only after your approval. Every action is logged to the decision log.

5. **Extract to Obsidian.** After cleanup, the agent uses sender-state and contacts data to generate People notes and knowledge notes for your Obsidian vault.

### What the agent reads

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Agent instructions — CLI commands, data schemas, patterns |
| `DATA-HANDOVER.template.md` | Schema reference — what data exists, how to query it |
| `data/sender-state.v1.json` | Canonical sender database |
| `data/decision-log.json` | All review decisions |
| `data/contacts.json` | Google Contacts export (Gmail only) |

## Obsidian Integration Strategy

The pipeline output is designed to seed an Obsidian vault with structured knowledge from your email. This is a separate initiative — the inbox-zero tools produce the clean data, and a downstream process converts it to Obsidian notes.

### What feeds into Obsidian

- **People notes** — generated from contacts + sender-state + relationship context
- **Knowledge notes** — extracted from high-value email threads (flagged as `extractionCandidate` during enrichment)
- **Meeting index** — cross-referenced with meeting transcripts already in your vault
- **Identity graph** — links people across email, phone, WhatsApp, meetings

### Recommended vault structure

```
vault/
  00-Inbox/               # Raw imports land here for triage
  01-Notes/               # Processed notes (flat, found by metadata not folders)
  02-Templates/           # Note templates (People, Knowledge, Meeting, etc.)
  03-Assets/              # Attachments, images
  04-Archive/             # Completed/retired notes
```

Notes use YAML frontmatter for queryable metadata:

```yaml
---
type: person
name: Jane Doe
emails: [jane@example.com, jane@company.com]
phones: ["+447912345678"]
organization: Acme Corp
relationship: client
source: inbox-zero
last_email: 2026-03-10
email_count: 150
---
```

### Building the identity graph

1. **Match** contacts.json emails against sender-state senders
2. **Enrich** with relationship notes captured during review
3. **Generate** People notes with frontmatter linking to business entities
4. **Bridge** to messaging (phone numbers → WhatsApp identity)
5. **Cross-reference** with meeting transcripts for interaction history

The pipeline's `DATA-HANDOVER.template.md` has detailed instructions for each step.

## Repository Layout

```
inbox-zero/                # Gmail pipeline — TypeScript CLI
inbox-zero-o365/           # O365 pipeline — standalone sibling
docs/
  specs/                   # Design documents (what and why)
  plans/                   # Implementation plans (how and when)
  research/                # Research findings
  decisions/               # Decision log (why X over Y)
HANDOVER.md                # Latest execution context (gitignored for public)
```

## Design Principles

- **Safety over cleverness.** Every destructive action requires a manifest on disk and supports `--dry-run`. Atomic writes prevent data corruption.
- **Resumable everything.** Long-running operations checkpoint progress and continue from where they left off.
- **Human in the loop.** No bulk actions without a Google Sheets review step. The pipeline presents, you decide.
- **Durable state.** Canonical data lives in local JSON files, not in the cloud. Google Sheets are projections, not sources of truth.
- **Agent-friendly.** CLAUDE.md files, structured schemas, and deterministic CLI commands make it easy for AI agents to reason about and operate the pipeline.

## Testing

Both pipelines have comprehensive test suites:

```bash
cd inbox-zero && npm test       # 785+ tests
cd inbox-zero-o365 && npm test
```

TypeScript strict mode, Zod schema validation, Biome linting.

## License

ISC
