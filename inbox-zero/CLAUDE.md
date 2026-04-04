# inbox-zero — Gmail Pipeline

Gmail inbox zero toolchain using the Gmail API via Google service account with domain-wide delegation.

## Auth Setup

1. Create a GCP project with Gmail API enabled
2. Create a service account with domain-wide delegation
3. Delegate scopes: `gmail.modify`, `gmail.settings.basic`, `spreadsheets`
4. Save the key file to `.secrets/service-account.json` (gitignored)
5. Copy `.env.example` to `.env` and fill in:
   - `GOOGLE_SERVICE_ACCOUNT_KEY=.secrets/service-account.json`
   - `GMAIL_USER=<your-gmail-address>`
   - `ANTHROPIC_API_KEY=<key>` (for LLM enrichment)

## CLI Commands

```bash
npm run cli -- pull [--dry-run]           # Metadata pull (resumable, checkpointed)
npm run cli -- enrich [--skip-llm]        # Heuristic + LLM sender classification
npm run cli -- execute-batch --manifest <path> --sheet-id <id> [--dry-run]
npm run cli -- sweep [--dry-run]          # Archive noise from inbox
npm run cli -- migrate-filters [--dry-run] [--execute] [--delete-first]
```

Use `DATA_DIR=./data-other GMAIL_USER=other@domain.com` prefix to target a different mailbox.

## Key Data Files

- `data/sender-state.v1.json` — canonical sender state (source of truth, not the Sheet)
- `data/decision-log.json` — every user review action (append-only)
- `data/manifests/batch-*.json` — frozen batch manifests for execute-batch
- Google Sheets audit spreadsheet for human review (projection of sender-state)

## Gmail-Specific Patterns

- `_noise` Gmail label applied to archived noise senders
- Per-sender Gmail filters consolidated into query-based filters via `migrate-filters`
- `from:sender in:inbox` queries target only inbox messages (not all mail)
- `execute-batch` skips filter creation by default (`skipFilterCreation: true`); `sweep` handles ongoing noise
- Pipe-character emails (`|`) break Gmail `from:` queries — skipped in manifests
- Google Sheets quota: `execute-batch` hits ~60 writes/min on large batches; manifests are resumable

## Testing

```bash
npm run test              # vitest run
npm run typecheck         # tsc --noEmit
npm run lint              # biome check src/ tests/
```
