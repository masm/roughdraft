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
- `PUT /api/markdown-file?projectPath=…&path=…` accepts `content`, `expectedVersion`, binding and context. A scoped save requires the current loaded tuple and equality with the current saved version, including rejecting an empty version. Stale scoped saves and unscoped saves during an active scoped review are refused. Ordinary unscoped editing remains available when no active scoped context exists.

Unscoped open requests preserve any active context on a reused window. Browser code must validate the accepted tuple before applying an open request and after asynchronous loading, then acknowledge the actual loaded path/version. The receiver does not infer a round for an old unscoped client.

## Completion and crash recovery

`POST /api/review-events` takes the existing `projectPath`, relative Markdown `path`, optional `overallComment`, and for scoped completion the binding, context and `expectedVersion`. Completion requires the current loaded tuple and the saved version. Unscoped completion remains supported when no active scoped round owns the path.

The first success returns HTTP 201 with `{ delivered, event, ...journalSnapshot }`. A repeated scoped completion returns HTTP 200 and the original receipt, even after the Markdown has been deleted. `delivered` reports whether this request published a new or newly recovered receipt to a matching transport waiter, not that an agent consumed it. Repeating an already recovered receipt does not publish it again.

A receipt contains `type: "review.completed"`, stable `eventId`, journal ID, sequence, timestamp, canonical document/project paths for scoped requests, relative path, saved version, feedback counts, and optional review ID/context and overall-comment digest. Feedback bodies stay in Markdown. The original overall comment may be present in transient responses from the same process for legacy compatibility; it is not persisted and is absent after restart.

The server first commits an intent containing the input version, before/after content hashes, stable event identity, timestamp, feedback summary and optional comment digest. It then prepares any optional overall comment in an exclusively created temporary sibling, fully writes and syncs it, validates the source version/inode and requested path, and atomically replaces the canonical target. It verifies a consistent saved snapshot and commits the receipt/sequence/context transition together before returning success or notifying waiters. Newly recovered receipts also notify already registered matching waiters, including path watchers opened through a symlink alias.

The replacement opens the original target for read/write permission and ACL admission before creating its sibling; a writable directory cannot bypass a read-only target. It preserves the target mode and follows a symlink to replace its target while keeping the symlink itself. A document with multiple hard links is refused with `save_conflict` for overall-comment replacement: atomic rename would otherwise split the aliases into different contents. Ordinary no-comment completion does not replace the file.

A partial temporary write, failed temporary sync or pre-replacement failure leaves the original Markdown unchanged. Cleanup removes only the temporary inode this operation created. A failure after visible replacement leaves a complete new Markdown file for intent recovery. The containing directory is synced after rename. A process killed before replacement can leave its temporary sibling; startup does not scan/delete unverified orphan files. Filesystem snapshots/rename do not lock unrelated external editors or provide a cross-file transaction; a write racing the final validation remains a reconciliation risk. Extended file metadata beyond the copied mode is not promised to survive replacement.

The intent's original timestamp makes a same-input retry deterministic if the process failed before writing Markdown. If disk already matches the intended after-hash, restart/request recovery commits one receipt without appending another comment. If it still matches the before-hash, retry with the same version and comment can finish the write. A changed/missing file is preserved and cannot silently become completion; uncertain contents require explicit reconciliation. A failed receipt commit leaves feedback on disk and reports unfinished. This is a recoverable two-write protocol, not an atomic transaction spanning Markdown and SQLite.

Receipt versions derive from the bytes and stats of one verified open-file snapshot. A mutation during that read is refused; a later external change remains for the integration to reconcile against the saved receipt.

## Catch-up and transport

`POST /api/review-events/watch` accepts `journalId`, `reviewId`, `fromNow: false`, `afterSequence` and optional `timeoutSeconds`/`batchWindowSeconds`. UUID lookup does not require the Markdown to exist. Unknown reviews, changed journal identity, or a cursor outside `0..latestSequence` return `recovery_unavailable`. Retired and superseded reviews return `context_retired` and `stale_context`, respectively.

Scoped watches default to a 240-second hold; explicit holds clamp to 300 seconds. Legacy path-based watches remain available and keep their indefinite default. `fromNow` defaults to true for compatibility; callers recovering a round must explicitly send false. Responses contain events strictly after the cursor, `timedOut`, and the journal snapshot. Timeout means pending, not cancellation. HTTP disconnect immediately removes that waiter and its timers; it does not retire the review or erase receipts.

Context/protocol failures return JSON `{ code, error }`: `invalid_request` (400), `stale_context`, `context_retired`, `save_conflict` or caller-binding `recovery_unavailable` (409), and storage `recovery_unavailable`, `writer_busy`, or `receipt_unavailable` (503). Existing local-file validation and save-conflict response shapes remain supported.

## Browser loading and saved feedback

The browser validates the accepted scoped tuple before fetching a file and again after its asynchronous load. It acknowledges the canonical path and actual version before enabling scoped saves or Done. Newer typing, selected documents and opening operations fence older responses. Each save must return the persisted Page; a nullish response is not success. Done flushes pending editor work and completes against the version that save confirmed. A provided version is checked for ordinary completion too; old callers that omit it keep their legacy contract.

A clean document revalidates on file-event connection/reconnection and same-path reopening. Connected change detection also observes ctime, so equal-size edits with restored mtime are detected. Dirty drafts survive external changes: autosave and Done pause until reload or explicit overwrite; keeping editing leaves autosave paused. Missing/unreadable files retain the visible draft and block completion. Restoring readability can revalidate the document. A completed scoped receipt remains Saved after page reload; it does not become a fresh review.

Scoped completion response loss keeps an in-memory pending request. A retry first checks its UUID receipt, or repeats the same confirmed-version completion without another save. Changed draft/comment input requires reconciliation instead of silently discarding new feedback. The durable receipt, not transport watcher presence, establishes completion; a disconnected agent can recover it later.

Each CLI opening also registers a transient `loadRequestId`. The server puts `openRequest=<id>` in the browser URL, accepts a matching version/path acknowledgment, and exposes it through `GET /api/open-request/load?id=…`. A browser can POST `/api/open-request/failure` with the ID, path and a short error. SSE delivery or native launcher exit alone is insufficient. These small load-operation records are memory-only, bounded to256, and eligible for cleanup after15 minutes when a new request is registered; they are not review metadata. After restart or cleanup, a browser may still validate its durable scoped context (or an ordinary unowned file) without recreating the lost operation. A CLI querying that lost load ID still gets an explicit recovery error and must retry opening.

## CLI adapter

Ordinary `roughdraft open <file>` verifies loading, then waits intentionally for Done Reviewing. `--no-watch` returns after verified loading instead of waiting for Done. `--open-timeout <seconds>` bounds the load step (default30, positive and at most300); opening or load failures exit1. `--no-open` and `--print-url` do not claim that a window launched or loaded. An API-less preview-web route cannot verify a local file opening. Remote-document mode keeps its separate existing transport and does not accept local scoped flags.

A local integration supplies both flags together:

```bash
roughdraft open /absolute/draft.md --no-watch --json \
  --journal-id JOURNAL_UUID \
  --review-context '{"storeId":"STORE_UUID","generation":1,"reviewId":"REVIEW_UUID","operationId":"OPEN_UUID"}'
```

The JSON result includes `opened`, `loaded`, `url`, `serverUrl`, input `path`, `openMode`, `loadRequestId`, `journalId`, pre-exposure `afterSequence`, and the explicit `reviewId` when scoped. A successful loaded result also identifies the canonical document and loaded version. An already completed scoped retry reports `completed:true` without opening another window; recover its existing UUID receipt rather than requiring another Done.

Recover without requiring the Markdown to remain on disk:

```bash
roughdraft watch --review-id REVIEW_UUID --journal-id JOURNAL_UUID \
  --after-sequence 0 --timeout 240 --json
```

A saved cursor requires its journal binding. UUID recovery uses `fromNow:false`; ordinary open captures the current journal sequence before exposing the window, so a fast Done cannot fall into the old open-before-watch gap. Explicit replay starts at zero. Watch timeout exits1 with `timedOut:true`, meaning pending, never cancellation. Without an explicit limit, UUID watch holds240 seconds and ordinary legacy path watch remains indefinite. Successful JSON goes only to stdout; errors are diagnostics on stderr. Server start, stop and status continue to use their existing lifecycle state/port flags.
