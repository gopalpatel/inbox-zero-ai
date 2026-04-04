# CLAUDE.md

Infrastructure for achieving inbox zero across Gmail and Office 365 mailboxes using AI-powered sender classification, batch review, and automated noise removal.

Plan-driven: design documents are the authority, code is the delivery mechanism.

**Always read `HANDOVER.md` first for current state, then the relevant spec/plan in `docs/` before writing or modifying code.**

## Project Structure

```
docs/                          # THE INSTRUCTIONAL LAYER — read this first
  specs/                       # Design documents (what and why)
  plans/                       # Implementation plans (how and when)
  research/                    # Findings that inform decisions
  decisions/                   # Decision log — why X over Y

inbox-zero/                    # Gmail inbox zero pipeline
inbox-zero-o365/               # Office 365 inbox zero pipeline
obsidian-pipeline/             # Email extraction → Obsidian vault (not started)
```

Each app directory has its own CLAUDE.md with platform-specific auth, CLI commands, and conventions.

## How Work Flows

1. Specs define WHAT we're building and WHY
2. Plans break specs into executable steps with approval gates
3. Code implements the plan — scripts live in their phase directory
4. Reports are generated artifacts for user review (sender lists, category breakdowns)
5. Decisions document choices made during execution (for context in future sessions)

## Shared Pipeline (Both Gmail and O365)

Both apps follow the same workflow with platform-specific internals:

1. **Pull** — retrieve email metadata from the mailbox (resumable, checkpointed)
2. **Analyze** — aggregate per-sender statistics from pulled metadata
3. **Enrich** — classify senders via heuristics + optional LLM (Claude Haiku)
4. **Review** — Google Sheets audit report for human decision-making (keep / filter / unsubscribe)
5. **Execute** — apply decisions: create filters/rules, archive noise, update state

Output files share the same Zod schemas — the O365 app's exports are contract-compatible with the Gmail app's consumers.

## Code Review & PR Workflow

- **CodeRabbit** is enabled for automated PR review
- All code changes go through feature branches + PRs (never push directly to main)
- Resolve all CodeRabbit comments before merging — fix, acknowledge, or defer each one
- Conventional commits: `feat(inbox-zero):`, `feat(inbox-zero-o365):`, `fix(scope):`, `chore:`, `docs:`
- Squash merge for clean history

## Conventions

- Plans and specs use date-prefixed filenames: `YYYY-MM-DD-<topic>.md`
- Reports go to `<app>/reports/` with timestamps
- Data artifacts (JSON dumps, CSVs) go to `<app>/data/` — don't commit raw dumps
- User approval gates are explicit — never bulk-action emails without presenting a report first
- Global engineering standards (TypeScript strict mode, Zod patterns, TDD, security, error handling) are defined in `~/.claude/CLAUDE.md` — do not duplicate here
