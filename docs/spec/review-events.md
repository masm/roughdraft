# Local review handoff HTTP contract

Local review receipts and accepted opening contexts survive server restarts in a private SQLite journal. Callers bind to its identity and use a review ID for each round; stale requests cannot replace a newer context. Markdown owns feedback text. This server contract supports UI/CLI integration but does not itself prove that a browser launched or loaded a document.

## Journal and runtime

Node.js 22.13.0 or newer is required for unflagged `node:sqlite`. No external SQLite package is used. `server.json` still describes the managed process, port and URL. The separate `review-events.sqlite` file holds schema version 1, a journal UUID, next sequence, context history, per-path heads, pending completion intents and receipts.

The journal lives beside `ROUGHDRAFT_STATE_FILE`, or under `ROUGHDRAFT_STATE_DIR`, defaulting to `~/.roughdraft`. Embedded `createApp` callers set `reviewStateDir` explicitly, or supply an isolated `homeDir`. They must call the returned `close()` before removing state or creating another writer.

SQLite retains an exclusive connection lock: another live writer receives HTTP 503 `writer_busy`. Closing the app or process death releases the OS lock; there is no age-based lock stealing. Existing malformed, empty, inconsistent or unsupported state is preserved and refused with 503 `recovery_unavailable`. Removing or replacing the backing file under a live writer is also refused.

An absent journal creates a new identity. It never reuses the caller's old identity: a request bound to a missing/replaced journal receives `recovery_unavailable`, not an ordinary empty wait. Receipts and contexts have no automatic expiry. Their storage can grow until the owner explicitly removes state.

`GET /api/status` includes:

```json
{
  "capabilities": { "durableReviewEvents": 1, "reviewContext": 1 },
  "reviewEvents": {
    "journalId": "persistent-journal-uuid",
    "startId": "new-per-app-start-uuid",
    "earliestSequence": 0,
    "latestSequence": 0,
    "nextSequence": 1
  }
}
```

The first retained sequence is zero for an empty journal, otherwise one. `nextSequence` is the next unallocated value, not the last consumed event cursor. Persist the last consumed event's `sequence`.

## Accepted opening context

A scoped operation carries `journalId` and `reviewContext`:

```json
{
  "storeId": "integration-store-uuid",
  "generation": 1,
  "reviewId": "review-uuid",
  "operationId": "opening-operation-uuid"
}
```

Identifiers are nonempty alphanumeric strings with optional `.`, `_`, `:`, or `-`, at most 256 characters. Generation is a positive safe integer. Existing local paths resolve symlink aliases to one canonical document identity.

- `POST /api/open-request` takes absolute `path`, browser `url`, journal binding and context. It persists `opening` before writing a request to a matching SSE window. The response includes `context` and `delivered`; delivery is not a browser load acknowledgment. A lower generation is stale. Equal generation is a retry only for the identical tuple. Another store identity requires explicit recovery. Retired contexts cannot reopen; a completed retry returns its context without sending another open request.
- `GET /api/open-request?path=…&journalId=…` returns the current accepted `context`, or null.
- `POST /api/open-request/ack` takes `path`, binding, context and loaded `version`. It verifies the current file version, then persists `loaded`. Stale operations cannot acknowledge a newer round.
- `POST /api/open-request/retire` takes `path`, binding and context. Repeating retirement is harmless; an old retirement cannot affect a newer context. Retirement is receiver fencing, not agent ownership arbitration.
- `PUT /api/markdown-file?projectPath=…&path=…` accepts `content`, `expectedVersion`, binding and context. A scoped save requires the current loaded tuple and expected version. Stale scoped saves and unscoped saves during an active scoped review are refused. Ordinary unscoped editing remains available when no active scoped context exists.

Unscoped open requests preserve any active context on a reused window. Browser code must validate the accepted tuple before applying an open request and after asynchronous loading, then acknowledge the actual loaded path/version. The receiver does not infer a round for an old unscoped client.

## Completion and crash recovery

`POST /api/review-events` takes the existing `projectPath`, relative Markdown `path`, optional `overallComment`, and for scoped completion the binding, context and `expectedVersion`. Completion requires the current loaded tuple and the saved version. Unscoped completion remains supported when no active scoped round owns the path.

The first success returns HTTP 201 with `{ delivered, event, ...journalSnapshot }`. A repeated scoped completion returns HTTP 200 and the original receipt, even after the Markdown has been deleted. `delivered` means a matching transport waiter existed, not that an agent consumed the receipt.

A receipt contains `type: "review.completed"`, stable `eventId`, journal ID, sequence, timestamp, canonical document/project paths for scoped requests, relative path, saved version, feedback counts, and optional review ID/context and overall-comment digest. Feedback bodies stay in Markdown. The original overall comment may be present in transient responses from the same process for legacy compatibility; it is not persisted and is absent after restart.

The server first commits an intent containing the input version, before/after content hashes, stable event identity, timestamp, feedback summary and optional comment digest. It then writes and syncs the optional overall comment, verifies a consistent file snapshot, and commits the receipt/sequence/context transition together before returning success or notifying waiters.

The intent's original timestamp makes a same-input retry deterministic if the process failed before writing Markdown. If disk already matches the intended after-hash, restart/request recovery commits one receipt without appending another comment. If it still matches the before-hash, retry with the same version and comment can finish the write. A changed/missing file is preserved and cannot silently become completion; uncertain contents require explicit reconciliation. A failed receipt commit leaves feedback on disk and reports unfinished. This is a recoverable two-write protocol, not an atomic transaction spanning Markdown and SQLite.

Receipt versions derive from the bytes and stats of one verified open-file snapshot. A mutation during that read is refused; a later external change remains for the integration to reconcile against the saved receipt.

## Catch-up and transport

`POST /api/review-events/watch` accepts `journalId`, `reviewId`, `fromNow: false`, `afterSequence` and optional `timeoutSeconds`/`batchWindowSeconds`. UUID lookup does not require the Markdown to exist. Unknown reviews, changed journal identity, or a cursor outside `0..latestSequence` return `recovery_unavailable`. Retired and superseded reviews return `context_retired` and `stale_context`, respectively.

Scoped watches default to a 240-second hold; explicit holds clamp to 300 seconds. Legacy path-based watches remain available and keep their indefinite default. `fromNow` defaults to true for compatibility; callers recovering a round must explicitly send false. Responses contain events strictly after the cursor, `timedOut`, and the journal snapshot. Timeout means pending, not cancellation. HTTP disconnect immediately removes that waiter and its timers; it does not retire the review or erase receipts.

Context/protocol failures return JSON `{ code, error }`: `invalid_request` (400), `stale_context`, `context_retired`, `save_conflict` or caller-binding `recovery_unavailable` (409), and storage `recovery_unavailable`, `writer_busy`, or `receipt_unavailable` (503). Existing local-file validation and save-conflict response shapes remain supported.
