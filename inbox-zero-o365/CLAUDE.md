# inbox-zero-o365 — Office 365 Pipeline

Office 365 inbox zero toolchain using the Microsoft Graph API. Standalone sibling to `inbox-zero/` with zero shared runtime code.

## Architecture

- **Contract-first:** all 6 Zod schemas copied unchanged from the Gmail app. Output files (sender-state, decision-log, batch manifests) validate against the same schemas.
- **O365-native internals:** inbox rules (not Gmail filters), Archive folder move (not label-based), `_noise` Outlook category (not Gmail label)
- **Gmail-compatible exports:** any consumer of the Gmail app's data files can read O365 output unchanged
- **Immutable IDs:** every Graph request uses `Prefer: IdType="ImmutableId"` so exported message IDs survive folder moves

## Auth Setup

1. Register an app in Azure Entra ID (single-tenant, no redirect URI)
2. Add API permissions: `Mail.Read` + `Mail.ReadWrite` (Application)
3. Grant admin consent for the tenant
4. Create a client secret
5. Copy `.env.example` to `.env` and fill in:
   - `O365_TENANT_ID`, `O365_CLIENT_ID`, `O365_CLIENT_SECRET`
   - `O365_USER_EMAIL=<your-o365-address>`
   - `GOOGLE_SERVICE_ACCOUNT_KEY` + `GOOGLE_IMPERSONATE_USER` (for Sheets audit reports)
   - `ANTHROPIC_API_KEY` (for LLM enrichment)

## CLI Commands

```bash
npm run cli -- smoke-test                 # Verify Graph API connection
npm run cli -- pull [--dry-run]           # Metadata pull (resumable, checkpointed)
npm run cli -- analyze                    # Generate sender stats from batch files
npm run cli -- enrich [--skip-llm] [--sheet-title <title>]
npm run cli -- execute-batch --manifest <path> --sheet-id <id> [--dry-run]
```

## Key Differences from Gmail App

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
