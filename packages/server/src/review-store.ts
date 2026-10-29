import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readFileSnapshot } from "./file-version.js";
import type {
  ReviewCompletedEvent,
  ReviewCompletedEventInput,
} from "./review-events.js";

export type ReviewFailureCode =
  | "invalid_request"
  | "stale_context"
  | "context_retired"
  | "recovery_unavailable"
  | "writer_busy"
  | "save_conflict"
  | "receipt_unavailable";

export class ReviewStateError extends Error {
  constructor(
    readonly code: ReviewFailureCode,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "ReviewStateError";
  }
}

export interface ReviewContext {
  storeId: string;
  generation: number;
  reviewId: string;
  operationId: string;
}

export interface AcceptedReviewContext extends ReviewContext {
  documentPath: string;
  projectPath: string;
  relativePath: string;
  status: "opening" | "loaded" | "retired" | "superseded" | "completed";
  loadedVersion?: string;
}

interface CompletionIntent {
  key: string;
  eventId: string;
  createdAt: string;
  beforeHash: string;
  afterHash: string;
  expectedVersion: string;
  input: ReviewCompletedEventInput;
  reviewContext?: ReviewContext;
  overallCommentDigest?: string;
}

export interface ReviewJournalSnapshot {
  journalId: string;
  startId: string;
  latestSequence: number;
  earliestSequence: number;
  nextSequence: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(value)
  );
}

export function parseReviewContext(value: unknown): ReviewContext {
  if (
    !record(value) ||
    !identifier(value.storeId) ||
    !identifier(value.reviewId) ||
    !identifier(value.operationId) ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 1
  ) {
    throw new ReviewStateError(
      "invalid_request",
      "A review context needs storeId, reviewId, operationId and a positive safe generation.",
      400,
    );
  }
  return {
    storeId: value.storeId,
    generation: Number(value.generation),
    reviewId: value.reviewId,
    operationId: value.operationId,
  };
}

export function sameContext(
  left: ReviewContext,
  right: ReviewContext,
): boolean {
  return (
    left.storeId === right.storeId &&
    left.generation === right.generation &&
    left.reviewId === right.reviewId &&
    left.operationId === right.operationId
  );
}

export function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function parseStored<T>(
  raw: unknown,
  validate: (value: unknown) => boolean,
): T {
  try {
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : null;
    if (!validate(value)) throw new Error("invalid record");
    return value as T;
  } catch {
    throw new ReviewStateError(
      "recovery_unavailable",
      "Stored review metadata is malformed; preserve it for recovery.",
      503,
    );
  }
}

function validInput(value: unknown): value is ReviewCompletedEventInput {
  if (
    !record(value) ||
    typeof value.documentPath !== "string" ||
    !path.isAbsolute(value.documentPath) ||
    typeof value.projectPath !== "string" ||
    !path.isAbsolute(value.projectPath) ||
    typeof value.relativePath !== "string" ||
    typeof value.version !== "string" ||
    !record(value.summary)
  )
    return false;
  for (const name of ["comments", "replies", "suggestions", "unresolved"]) {
    if (
      !Number.isSafeInteger(value.summary[name]) ||
      Number(value.summary[name]) < 0
    )
      return false;
  }
  return (
    value.overallComment === undefined ||
    typeof value.overallComment === "string"
  );
}

function validContext(value: unknown): value is AcceptedReviewContext {
  if (!record(value)) return false;
  try {
    parseReviewContext(value);
  } catch {
    return false;
  }
  if (
    (value.status === "loaded" || value.status === "completed") &&
    (typeof value.loadedVersion !== "string" ||
      value.loadedVersion.length === 0)
  )
    return false;
  return (
    typeof value.documentPath === "string" &&
    path.isAbsolute(value.documentPath) &&
    typeof value.projectPath === "string" &&
    path.isAbsolute(value.projectPath) &&
    typeof value.relativePath === "string" &&
    ["opening", "loaded", "retired", "superseded", "completed"].includes(
      String(value.status),
    ) &&
    (value.loadedVersion === undefined ||
      typeof value.loadedVersion === "string")
  );
}

function validEvent(value: unknown): value is ReviewCompletedEvent {
  if (!validInput(value) || !record(value)) return false;
  if (value.overallComment !== undefined) return false;
  if (
    value.overallCommentDigest !== undefined &&
    !/^[a-f0-9]{64}$/.test(String(value.overallCommentDigest))
  )
    return false;
  if (value.reviewId !== undefined) {
    try {
      const context = parseReviewContext(value.reviewContext);
      if (context.reviewId !== value.reviewId) return false;
    } catch {
      return false;
    }
  } else if (value.reviewContext !== undefined) return false;
  return (
    value.type === "review.completed" &&
    identifier(value.eventId) &&
    identifier(value.journalId) &&
    Number.isSafeInteger(value.sequence) &&
    Number(value.sequence) > 0 &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    (value.reviewId === undefined || identifier(value.reviewId))
  );
}

function validIntent(value: unknown): value is CompletionIntent {
  if (
    !record(value) ||
    !identifier(value.key) ||
    !identifier(value.eventId) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !/^[a-f0-9]{64}$/.test(String(value.beforeHash)) ||
    !/^[a-f0-9]{64}$/.test(String(value.afterHash)) ||
    typeof value.expectedVersion !== "string" ||
    !validInput(value.input)
  )
    return false;
  if (
    value.input.overallComment !== undefined ||
    (value.overallCommentDigest !== undefined &&
      !/^[a-f0-9]{64}$/.test(String(value.overallCommentDigest)))
  )
    return false;
  try {
    if (value.reviewContext !== undefined) {
      if (value.key !== parseReviewContext(value.reviewContext).reviewId)
        return false;
    } else if (value.key !== value.eventId) return false;
  } catch {
    return false;
  }
  return value.input.version === value.expectedVersion;
}

/** One live writer per journal. SQLite releases its exclusive OS lock on close or process death. */
export class ReviewStore {
  readonly startId = crypto.randomUUID();
  readonly journalId: string;
  readonly filePath: string;
  private readonly database: DatabaseSync;
  private closed = false;
  private readonly fileIdentity: { dev: number; ino: number };
  private readonly transientComments = new Map<string, string>();

  constructor(directory: string) {
    this.filePath = path.join(path.resolve(directory), "review-events.sqlite");
    let database: DatabaseSync | undefined;
    try {
      fs.mkdirSync(path.dirname(this.filePath), {
        recursive: true,
        mode: 0o700,
      });
      const exists = fs.existsSync(this.filePath);
      if (
        exists &&
        (!fs.lstatSync(this.filePath).isFile() ||
          fs.statSync(this.filePath).size === 0)
      ) {
        throw new ReviewStateError(
          "recovery_unavailable",
          "Existing review journal is not a populated regular file; preserve it for recovery.",
          503,
        );
      }
      if (!exists) fs.closeSync(fs.openSync(this.filePath, "wx", 0o600));
      database = new DatabaseSync(this.filePath);
      database.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE;");
      if (!exists) database.exec("PRAGMA journal_mode=DELETE");
      else if (
        database.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete"
      )
        throw new ReviewStateError(
          "recovery_unavailable",
          "The review journal mode is inconsistent; preserve its files for recovery.",
          503,
        );
      database.exec("BEGIN EXCLUSIVE");
      if (!exists) {
        database.exec(
          "CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, journal_id TEXT NOT NULL, next_sequence INTEGER NOT NULL); CREATE TABLE contexts (review_id TEXT PRIMARY KEY, document_path TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE heads (document_path TEXT PRIMARY KEY, review_id TEXT NOT NULL); CREATE TABLE events (sequence INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL); CREATE TABLE intents (event_key TEXT PRIMARY KEY, payload TEXT NOT NULL);",
        );
        database
          .prepare("INSERT INTO metadata VALUES (1,1,?,1)")
          .run(crypto.randomUUID());
      }
      const meta = database
        .prepare(
          "SELECT schema_version,journal_id,next_sequence FROM metadata WHERE id=1",
        )
        .get();
      if (
        !meta ||
        meta.schema_version !== 1 ||
        !identifier(meta.journal_id) ||
        !Number.isSafeInteger(meta.next_sequence) ||
        Number(meta.next_sequence) < 1
      )
        throw new ReviewStateError(
          "recovery_unavailable",
          "Review journal identity or schema is invalid; preserve it for recovery.",
          503,
        );
      this.journalId = meta.journal_id;
      this.database = database;
      const identity = fs.statSync(this.filePath);
      this.fileIdentity = { dev: identity.dev, ino: identity.ino };
      this.validateStoredRows();
      database.exec("COMMIT");
      this.recoverIntents();
    } catch (error) {
      try {
        database?.close();
      } catch {}
      if (error instanceof ReviewStateError) throw error;
      const sqlite = error as { errcode?: number; code?: string };
      if (sqlite.errcode === 5 || sqlite.errcode === 6)
        throw new ReviewStateError(
          "writer_busy",
          "Another live Roughdraft process owns this review journal.",
          503,
        );
      throw new ReviewStateError(
        "recovery_unavailable",
        "The review journal could not be opened; preserve its files for recovery.",
        503,
      );
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  assertJournal(value: unknown): void {
    if (value !== this.journalId)
      throw new ReviewStateError(
        "recovery_unavailable",
        "The caller's review journal is missing or has changed.",
      );
  }

  snapshot(): ReviewJournalSnapshot {
    this.assertBackingFile();
    const row = this.database
      .prepare("SELECT next_sequence FROM metadata WHERE id=1")
      .get();
    const nextSequence = Number(row?.next_sequence);
    const first = this.database
      .prepare("SELECT MIN(sequence) AS sequence FROM events")
      .get();
    return {
      journalId: this.journalId,
      startId: this.startId,
      nextSequence,
      latestSequence: nextSequence - 1,
      earliestSequence: Number(first?.sequence ?? 0),
    };
  }

  events(): ReviewCompletedEvent[] {
    this.assertBackingFile();
    return this.database
      .prepare("SELECT payload FROM events ORDER BY sequence")
      .all()
      .map((row) =>
        this.decorate(
          parseStored<ReviewCompletedEvent>(row.payload, validEvent),
        ),
      );
  }

  contextForPath(documentPath: string): AcceptedReviewContext | null {
    this.assertBackingFile();
    const row = this.database
      .prepare(
        "SELECT c.payload FROM contexts c JOIN heads h ON h.review_id=c.review_id WHERE h.document_path=?",
      )
      .get(documentPath);
    return row
      ? parseStored<AcceptedReviewContext>(row.payload, validContext)
      : null;
  }

  contextForReview(reviewId: string): AcceptedReviewContext | null {
    this.assertBackingFile();
    const row = this.database
      .prepare("SELECT payload FROM contexts WHERE review_id=?")
      .get(reviewId);
    return row
      ? parseStored<AcceptedReviewContext>(row.payload, validContext)
      : null;
  }

  prepare(
    documentPath: string,
    projectPath: string,
    relativePath: string,
    context: ReviewContext,
  ): AcceptedReviewContext {
    const current = this.contextForPath(documentPath);
    if (current) {
      if (current.storeId !== context.storeId)
        throw new ReviewStateError(
          "recovery_unavailable",
          "This path belongs to another integration store; explicit recovery is required.",
        );
      if (
        context.generation < current.generation ||
        (context.generation === current.generation &&
          !sameContext(current, context))
      )
        throw new ReviewStateError(
          "stale_context",
          "A newer or different opening operation owns this path.",
        );
      if (context.generation === current.generation) {
        if (current.status === "retired")
          throw new ReviewStateError(
            "context_retired",
            "This opening context was retired.",
          );
        return current;
      }
    }
    if (this.contextForReview(context.reviewId))
      throw new ReviewStateError(
        "stale_context",
        "This review ID is already bound to an opening operation.",
      );
    const next: AcceptedReviewContext = {
      ...context,
      documentPath,
      projectPath,
      relativePath,
      status: "opening",
    };
    this.transaction(() => {
      if (
        current &&
        current.status !== "completed" &&
        current.status !== "retired"
      )
        this.writeContext({ ...current, status: "superseded" });
      this.writeContext(next);
      this.database
        .prepare(
          "INSERT INTO heads VALUES (?,?) ON CONFLICT(document_path) DO UPDATE SET review_id=excluded.review_id",
        )
        .run(documentPath, context.reviewId);
    });
    return next;
  }

  requireCurrent(
    documentPath: string,
    context: ReviewContext,
  ): AcceptedReviewContext {
    const current = this.contextForPath(documentPath);
    if (!current || !sameContext(current, context))
      throw new ReviewStateError(
        "stale_context",
        "The opening context is no longer current.",
      );
    if (current.status === "retired")
      throw new ReviewStateError(
        "context_retired",
        "The opening context was retired.",
      );
    return current;
  }

  acknowledge(
    documentPath: string,
    context: ReviewContext,
    version: string,
  ): AcceptedReviewContext {
    const current = this.requireCurrent(documentPath, context);
    if (current.status === "completed") return current;
    const next: AcceptedReviewContext = {
      ...current,
      status: "loaded",
      loadedVersion: version,
    };
    this.transaction(() => this.writeContext(next));
    return next;
  }

  retire(documentPath: string, context: ReviewContext): AcceptedReviewContext {
    const current = this.contextForPath(documentPath);
    if (!current || !sameContext(current, context))
      throw new ReviewStateError(
        "stale_context",
        "The opening context is no longer current.",
      );
    if (current.status === "retired" || current.status === "completed")
      return current;
    const next: AcceptedReviewContext = { ...current, status: "retired" };
    this.transaction(() => this.writeContext(next));
    return next;
  }

  receipt(reviewId: string): ReviewCompletedEvent | null {
    this.assertBackingFile();
    const row = this.database
      .prepare("SELECT payload FROM events WHERE event_key=?")
      .get(reviewId);
    return row
      ? this.decorate(
          parseStored<ReviewCompletedEvent>(row.payload, validEvent),
        )
      : null;
  }

  completionCreatedAt(reviewId?: string): string {
    this.assertBackingFile();
    const row = reviewId
      ? this.database
          .prepare("SELECT payload FROM intents WHERE event_key=?")
          .get(reviewId)
      : undefined;
    return row
      ? parseStored<CompletionIntent>(row.payload, validIntent).createdAt
      : new Date().toISOString();
  }

  prepareCompletion(
    input: ReviewCompletedEventInput,
    beforeContent: string,
    afterContent: string,
    expectedVersion: string,
    context?: ReviewContext,
    createdAt = new Date().toISOString(),
  ): CompletionIntent {
    this.assertBackingFile();
    const key = context?.reviewId ?? crypto.randomUUID();
    const { overallComment, ...receiptInput } = input;
    const overallCommentDigest =
      overallComment === undefined ? undefined : contentHash(overallComment);
    const row = this.database
      .prepare("SELECT payload FROM intents WHERE event_key=?")
      .get(key);
    if (row) {
      const existing = parseStored<CompletionIntent>(row.payload, validIntent);
      if (
        existing.expectedVersion !== expectedVersion ||
        existing.overallCommentDigest !== overallCommentDigest ||
        existing.input.documentPath !== input.documentPath ||
        (context &&
          (!existing.reviewContext ||
            !sameContext(existing.reviewContext, context)))
      )
        throw new ReviewStateError(
          "recovery_unavailable",
          "An earlier completion attempt has different input; explicit reconciliation is required.",
        );
      if (
        contentHash(beforeContent) !== existing.beforeHash ||
        contentHash(afterContent) !== existing.afterHash
      )
        throw new ReviewStateError(
          "recovery_unavailable",
          "The document changed during a pending completion attempt.",
        );
      if (overallComment !== undefined)
        this.transientComments.set(existing.eventId, overallComment);
      return existing;
    }
    const intent: CompletionIntent = {
      key,
      eventId: context ? crypto.randomUUID() : key,
      createdAt,
      beforeHash: contentHash(beforeContent),
      afterHash: contentHash(afterContent),
      expectedVersion,
      input: receiptInput,
      ...(overallCommentDigest ? { overallCommentDigest } : {}),
      ...(context ? { reviewContext: context } : {}),
    };
    this.transaction(() => {
      this.database
        .prepare("INSERT INTO intents VALUES (?,?)")
        .run(key, JSON.stringify(intent));
    });
    if (overallComment !== undefined)
      this.transientComments.set(intent.eventId, overallComment);
    appendSlog("completion.prepared", {
      reviewId: context?.reviewId ?? null,
      eventId: intent.eventId,
    });
    return intent;
  }

  finishCompletion(intent: CompletionIntent): ReviewCompletedEvent {
    const existing = this.receipt(intent.key);
    if (existing) return existing;
    let saved: { content: string; version: string };
    try {
      saved = readFileSnapshot(intent.input.documentPath);
    } catch {
      throw new ReviewStateError(
        "recovery_unavailable",
        "The document for a pending completion is unavailable.",
      );
    }
    if (contentHash(saved.content) !== intent.afterHash)
      throw new ReviewStateError(
        "recovery_unavailable",
        "The document no longer matches the pending completion.",
      );
    const event: ReviewCompletedEvent = {
      ...intent.input,
      version: saved.version,
      ...(intent.overallCommentDigest
        ? { overallCommentDigest: intent.overallCommentDigest }
        : {}),
      type: "review.completed",
      eventId: intent.eventId,
      journalId: this.journalId,
      ...(intent.reviewContext
        ? {
            reviewId: intent.reviewContext.reviewId,
            reviewContext: intent.reviewContext,
          }
        : {}),
      sequence: this.snapshot().nextSequence,
      createdAt: intent.createdAt,
    };
    this.transaction(() => {
      this.database
        .prepare("INSERT INTO events VALUES (?,?,?)")
        .run(event.sequence, intent.key, JSON.stringify(event));
      this.database
        .prepare("UPDATE metadata SET next_sequence=? WHERE id=1")
        .run(event.sequence + 1);
      this.database
        .prepare("DELETE FROM intents WHERE event_key=?")
        .run(intent.key);
      if (intent.reviewContext) {
        const accepted = this.contextForReview(intent.reviewContext.reviewId);
        if (accepted) this.writeContext({ ...accepted, status: "completed" });
      }
    });
    appendSlog("completion.committed", {
      eventId: event.eventId,
      reviewId: event.reviewId ?? null,
      sequence: event.sequence,
    });
    return this.decorate(event);
  }

  recoverIntents(): void {
    this.assertBackingFile();
    for (const row of this.database
      .prepare("SELECT payload FROM intents")
      .all()) {
      const intent = parseStored<CompletionIntent>(row.payload, validIntent);
      try {
        if (
          contentHash(fs.readFileSync(intent.input.documentPath, "utf8")) ===
          intent.afterHash
        )
          this.finishCompletion(intent);
      } catch (error) {
        if (!(error instanceof ReviewStateError)) continue;
        if (error.code !== "recovery_unavailable") throw error;
      }
    }
  }

  assertRecoverableReview(reviewId: string): void {
    const accepted = this.contextForReview(reviewId);
    if (!accepted && !this.receipt(reviewId))
      throw new ReviewStateError(
        "recovery_unavailable",
        "This review is unknown to the current journal.",
      );
    if (accepted?.status === "retired")
      throw new ReviewStateError(
        "context_retired",
        "This opening context was retired.",
      );
    if (accepted?.status === "superseded")
      throw new ReviewStateError(
        "stale_context",
        "A newer opening context superseded this review.",
      );
    const row = this.database
      .prepare("SELECT payload FROM intents WHERE event_key=?")
      .get(reviewId);
    if (row) {
      const intent = parseStored<CompletionIntent>(row.payload, validIntent);
      try {
        const hash = contentHash(
          fs.readFileSync(intent.input.documentPath, "utf8"),
        );
        if (hash !== intent.beforeHash && hash !== intent.afterHash)
          throw new Error("changed");
      } catch {
        throw new ReviewStateError(
          "recovery_unavailable",
          "The pending completion cannot be reconciled with its saved file.",
        );
      }
    }
  }

  private writeContext(context: AcceptedReviewContext): void {
    this.database
      .prepare(
        "INSERT INTO contexts VALUES (?,?,?) ON CONFLICT(review_id) DO UPDATE SET payload=excluded.payload",
      )
      .run(context.reviewId, context.documentPath, JSON.stringify(context));
  }

  private transaction<T>(change: () => T): T {
    this.assertBackingFile();
    try {
      this.database.exec("BEGIN EXCLUSIVE");
      const result = change();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      if (error instanceof ReviewStateError) throw error;
      throw new ReviewStateError(
        "receipt_unavailable",
        "The review receipt could not be persisted; the review remains unfinished.",
        503,
      );
    }
  }

  private decorate(event: ReviewCompletedEvent): ReviewCompletedEvent {
    const body = event.eventId
      ? this.transientComments.get(event.eventId)
      : undefined;
    return body === undefined ? event : { ...event, overallComment: body };
  }

  private assertBackingFile(): void {
    try {
      const info = fs.lstatSync(this.filePath);
      if (
        this.closed ||
        !info.isFile() ||
        info.dev !== this.fileIdentity.dev ||
        info.ino !== this.fileIdentity.ino
      )
        throw new Error("journal replaced");
    } catch {
      throw new ReviewStateError(
        "recovery_unavailable",
        "The open review journal was removed or replaced; explicit recovery is required.",
        503,
      );
    }
  }

  private validateStoredRows(): void {
    const events = this.events();
    const next = this.snapshot().nextSequence;
    if (
      events.some(
        (event, index) =>
          event.journalId !== this.journalId || event.sequence !== index + 1,
      ) ||
      next !== events.length + 1
    )
      throw new ReviewStateError(
        "recovery_unavailable",
        "The review sequence is inconsistent; preserve the journal for recovery.",
        503,
      );
    for (const row of this.database
      .prepare("SELECT event_key,payload FROM events")
      .all()) {
      const value = parseStored<ReviewCompletedEvent>(row.payload, validEvent);
      if (row.event_key !== (value.reviewId ?? value.eventId))
        throw new ReviewStateError(
          "recovery_unavailable",
          "Stored receipt identity is inconsistent.",
          503,
        );
    }
    const contexts: AcceptedReviewContext[] = [];
    for (const row of this.database
      .prepare("SELECT review_id,document_path,payload FROM contexts")
      .all()) {
      const value = parseStored<AcceptedReviewContext>(
        row.payload,
        validContext,
      );
      contexts.push(value);
      if (
        row.review_id !== value.reviewId ||
        row.document_path !== value.documentPath
      )
        throw new ReviewStateError(
          "recovery_unavailable",
          "Stored review context identity is inconsistent.",
          503,
        );
    }
    for (const row of this.database
      .prepare("SELECT event_key,payload FROM intents")
      .all()) {
      const value = parseStored<CompletionIntent>(row.payload, validIntent);
      if (row.event_key !== value.key || this.receipt(value.key))
        throw new ReviewStateError(
          "recovery_unavailable",
          "Stored completion identity is inconsistent.",
          503,
        );
      if (value.reviewContext) {
        const accepted = contexts.find(
          (context) => context.reviewId === value.reviewContext?.reviewId,
        );
        if (
          !accepted ||
          !sameContext(accepted, value.reviewContext) ||
          accepted.documentPath !== value.input.documentPath
        )
          throw new ReviewStateError(
            "recovery_unavailable",
            "Stored completion context is inconsistent.",
            503,
          );
      }
    }
    for (const event of events) {
      if (!event.reviewContext) continue;
      const accepted = contexts.find(
        (context) => context.reviewId === event.reviewId,
      );
      if (
        !accepted ||
        !sameContext(accepted, event.reviewContext) ||
        accepted.status !== "completed" ||
        accepted.documentPath !== event.documentPath
      )
        throw new ReviewStateError(
          "recovery_unavailable",
          "Stored receipt context is inconsistent.",
          503,
        );
    }
    const heads = this.database
      .prepare(
        "SELECT h.document_path,h.review_id,c.payload FROM heads h LEFT JOIN contexts c ON c.review_id=h.review_id",
      )
      .all();
    if (
      heads.length !==
      new Set(contexts.map((context) => context.documentPath)).size
    )
      throw new ReviewStateError(
        "recovery_unavailable",
        "Stored path heads are incomplete.",
        503,
      );
    for (const row of heads) {
      const value = parseStored<AcceptedReviewContext>(
        row.payload,
        validContext,
      );
      const peers = contexts.filter(
        (context) => context.documentPath === value.documentPath,
      );
      if (
        value.status === "superseded" ||
        peers.some(
          (context) =>
            context.storeId !== value.storeId ||
            context.generation > value.generation ||
            (context.generation === value.generation &&
              !sameContext(context, value)) ||
            (context.reviewId !== value.reviewId &&
              context.status !== "superseded" &&
              context.status !== "retired" &&
              context.status !== "completed"),
        )
      )
        throw new ReviewStateError(
          "recovery_unavailable",
          "Stored path generation was rewound or duplicated.",
          503,
        );
      if (
        row.document_path !== value.documentPath ||
        row.review_id !== value.reviewId
      )
        throw new ReviewStateError(
          "recovery_unavailable",
          "Stored path generation is inconsistent.",
          503,
        );
    }
  }
}

function appendSlog(event: string, data: Record<string, unknown>): void {
  const target = process.env.THOUGHTFUL_SLOG_FILE;
  if (!target) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(
    target,
    `${JSON.stringify({ ts: new Date().toISOString(), runId: process.env.THOUGHTFUL_SLOG_RUN_ID ?? "manual", source: "review-store", event, data })}\n`,
  );
}
