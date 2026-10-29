# 0005: Durable local review handoffs

Local completion receipts and opening contexts live in a separate SQLite journal. Markdown remains the source of feedback, and lifecycle state remains the CLI's small managed-process record.

## Context

An in-memory completion queue loses finished reviews on restart. A path alone cannot distinguish repeated rounds or fence an old window's delayed completion. Optional overall-comment insertion also spans a Markdown write and a receipt write.

## Decision

Use Node's built-in SQLite module with transactions and one exclusive writer connection. Persist journal identity, monotonic sequence, accepted context generations, completion intents and receipts. Retain metadata without automatic expiry; reject malformed/lost required state explicitly. Keep feedback bodies in Markdown and store only summaries and digests in the journal.

Commit a completion intent before touching Markdown. Reuse its timestamp on retry and reconcile its before/after content hashes after interruption. Publish success only after the receipt commits. See the [HTTP contract](../spec/review-events.md) for requests, errors and recovery.

## Consequences

Node.js 22.13.0 or newer is required. No new native dependency or lock timeout is introduced. SQLite process locks release on process death. Storage grows with history, and unexpected file content requires explicit reconciliation rather than a guessed completion. Agent ownership, cancellation/takeover ordering and feedback handling remain integration responsibilities.
