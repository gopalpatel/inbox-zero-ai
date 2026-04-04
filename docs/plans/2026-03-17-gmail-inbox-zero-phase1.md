# Gmail Inbox Zero — Phase 1 Design

> Archived draft. Superseded by `docs/specs/2026-03-17-gmail-inbox-zero-design.md`. Repo naming and local path references in this document may be stale.

## Context
The mailbox under review has 100k+ unread emails with no meaningful labels or filters. This is the first project in building a personal AI chief of staff system. User has ~2 weeks off starting 2026-03-17. Phase 1 focuses on inbox cleanup; Phase 2 (Obsidian second brain extraction) follows once Phase 1 is solid.

## Approach: Hybrid — Noise Floor First, Then Smart Triage

### Section 1: Tooling & Access (approved)
- **Gmail MCP** — for interactive triage sessions (needs re-auth with Gmail scopes)
- **Gmail API via gcloud + Node.js scripts** — for bulk operations (metadata pull, batch labeling, filter creation). Configure local auth against your GCP project before running.
- **Project location:** `inbox-zero/`
- **Open source tools to leverage:**
  - `gmail-unsubscribe` (Google Apps Script) for unsubscribe execution
  - `gmail-cleaner` for local privacy-first bulk operations
  - Gmail native Manage Subscriptions (July 2025 feature)

### Section 2: Triage Workflow (approved)

**Step 1: Metadata Pull** (~1-2 hours, automated)
- Gmail API pulls metadata for all inbox messages: sender, subject, date, category, has_attachment, thread_id
- Output: local JSON/CSV file. No message bodies yet.

**Step 2: Sender Frequency Analysis** (minutes, automated)
- Top 200 senders by volume with counts and sample subjects
- Category breakdown (Primary/Social/Promotions/Updates/Forums)
- Time distribution (emails per month)
- Notification/noreply senders grouped separately
- Output: MD report for user review — first approval gate (mark each as keep/filter/unsubscribe)

**Step 3: Noise Removal** (~30 min, automated after approval)
- Create Gmail filters: skip inbox + apply `_noise` label (nothing deleted)
- Trigger unsubscribe via Apps Script for permanently unwanted senders
- Batch archive historical emails from noise senders
- Expected: 60-80% of inbox cleared

**Step 4: LLM-Assisted Categorization** (~1-2 days, semi-automated)
- Pull message bodies in batches for remaining ~20-40k emails
- Claude classifies into: actionable, tax, rental, financial, personal, work, reference, archive
- Apply Gmail labels matching buckets
- Output: category report — second approval gate

**Step 5: Action Pass** (interactive)
- Review each non-archive bucket together
- Star what needs response, archive the rest
- Project buckets (tax, rental) become extraction source for Phase 2
- Inbox zero achieved when every message is labeled and either starred or archived

### Section 3: Gmail as Staging, Obsidian as System of Record (approved)

**The Model:**
- Gmail = flat filing cabinet, temporary staging area (content source #1)
- Obsidian = knowledge graph, system of record (the Content Commons)
- Future content sources (calendar, docs, slack) follow the same ingest pattern

**Gmail Label Strategy — Data-Driven:**
- NO pre-defined content labels. Step 2 sender analysis proposes a taxonomy based on what's actually in the inbox.
- User reviews and approves the taxonomy before any labels are created.
- Only pre-defined operational labels:
  - `_noise` — filtered junk (with auto-discovered subcategories)
  - `_triage` — temporary, removed after cleanup
  - `_extracted` — marks emails pulled into Obsidian (sync tracking)

**Sync Model: Gmail ↔ Obsidian:**
- `_extracted` label on Gmail marks what's been pulled into Obsidian
- `source-id` frontmatter on Obsidian side stores Gmail message/thread ID
- Two-way reference: Obsidian note → original email, Gmail → extraction status
- Pattern extends to future content sources

**Extraction-Aware Categorization:**
- Step 4 LLM classification captures not just "what bucket" but also people mentioned and topics/entities
- Enriched metadata stored locally alongside email data for Phase 2 consumption
- Labels are data-driven, not pre-assumed categories

### Section 4: Timeline & Milestones (approved)

| Day | Milestone |
|-----|-----------|
| 1 | Tooling setup — Gmail MCP auth, enable Gmail API, scaffold project, write metadata pull script |
| 2 | Metadata pull complete — bulk pull 100k+ message metadata |
| 2-3 | Sender audit report — leaderboard + category breakdown for review |
| 3-4 | **Approval gate 1** — review sender list, mark keep/filter/unsubscribe |
| 4-5 | Noise removal executed — filters, unsubscribes, historical archive. 60-80% cleared. |
| 5-8 | LLM categorization — classify remaining emails, apply data-driven labels, enrich metadata |
| 8-9 | **Approval gate 2** — review categorization report, adjust buckets |
| 9-10 | Action pass — interactive triage, inbox zero achieved |
| 11-14 | Phase 2 kickoff — Obsidian vault setup + extraction pipeline |

Timeline is upper bounds — milestones pull forward if we're ahead of schedule.
Key risk: Gmail API rate limits on 100k+ messages may extend metadata pull.

### Section 5: Success Criteria (approved)

**Phase 1 is done when:**
1. Inbox zero — every email archived with label, starred for action, or filtered
2. Noise permanently handled — filters block future junk, unsubscribes executed
3. Data-driven labels applied — categories from actual data, not pre-assumed
4. Enriched metadata stored locally — sender, subject, date, category, people, topics for every categorized email
5. `_extracted` sync model ready — Gmail ↔ Obsidian bridge defined
6. Ongoing maintenance path clear — filters + automation prevent backlog rebuild

**Phase 1 is NOT:**
- Building the Obsidian vault (Phase 2)
- Extracting content into markdown (Phase 2)
- Responding to every email — just categorizing and clearing

## Phase 2 Context: Obsidian Second Brain (for reference, not in Phase 1 scope)

**Framework:** ACE (Nick Milo) as vault skeleton — Atlas/Calendar/Efforts replaces PARA.
**Templates:** Dann Berg's people/meeting/daily note templates as starting point.
**Multi-source capture:** Nicole van der Hoeven's automated pipeline patterns for email → vault ingestion.
**Official CLI:** Obsidian CLI v1.12.4+ (Feb 2026) for scripted note creation.
**Bootstrap principle:** Don't over-build structure upfront. Let Phase 1 data (categorized emails, extracted people/entities) inform the vault's shape.

Key resources:
- ACE framework: https://blog.linkingyourthinking.com/notes/ace-folder-framework
- Dann Berg templates: https://dannb.org/blog/2022/obsidian-people-note-template/
- Nicole van der Hoeven live vault: https://notes.nicolevanderhoeven.com/Fork+My+Brain
- Obsidian CLI docs: https://help.obsidian.md/cli

## Verification
- Run metadata pull script and confirm 100k+ messages captured
- Generate sender report and verify top senders match reality (spot-check against Gmail UI)
- After noise removal, verify inbox count dropped 60-80%
- After LLM categorization, spot-check 50 random emails for correct classification
- Confirm all emails have at least one label and are out of inbox
- Confirm `_extracted` label exists and sync metadata schema is documented
