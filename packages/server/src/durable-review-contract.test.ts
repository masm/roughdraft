import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "./index";
import { ReviewStore } from "./review-store";

let scratch: string;
let projectDir: string;
let homeDir: string;
let file: string;
const applications: ReturnType<typeof createApp>[] = [];
const context = {
  storeId: "plugin-control-store",
  generation: 1,
  reviewId: "round-one",
  operationId: "open-one",
};

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-contract-"));
  projectDir = path.join(scratch, "documents");
  homeDir = path.join(scratch, "home");
  fs.mkdirSync(projectDir);
  fs.mkdirSync(homeDir);
  file = path.join(projectDir, "draft.md");
  fs.writeFileSync(file, "# Contract\n\nSaved review content.\n");
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const application of applications.splice(0)) {
    (application as { close?: () => void }).close?.();
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

function application() {
  const value = createApp({ homeDir, staticDirPath: projectDir });
  applications.push(value);
  return value;
}

async function prepare(value: ReturnType<typeof createApp>, next = context) {
  const health = await request(value.app).get("/api/status");
  expect(health.status).toBe(200);
  const journalId = health.body.reviewEvents?.journalId;
  const opened = await request(value.app)
    .post("/api/open-request")
    .send({
      path: file,
      url: `http://localhost:7373/?path=${encodeURIComponent(file)}`,
      journalId,
      reviewContext: next,
    });
  expect(opened.status).toBe(200);
  return { journalId, opened };
}

async function acknowledge(
  value: ReturnType<typeof createApp>,
  journalId: string,
  next = context,
) {
  const page = await request(value.app)
    .get("/api/markdown-file")
    .query({ projectPath: projectDir, path: "draft.md" });
  const response = await request(value.app).post("/api/open-request/ack").send({
    path: file,
    journalId,
    reviewContext: next,
    version: page.body.version,
  });
  expect(response.status).toBe(200);
  return page.body.version as string;
}

it("advertises durable identity with a new start ID and stable journal ID after restart", async () => {
  const first = application();
  const before = await request(first.app).get("/api/status");
  expect(before.body.capabilities.durableReviewEvents).toBe(1);
  expect(before.body.capabilities.reviewContext).toBe(1);
  expect(before.body.reviewEvents).toMatchObject({
    latestSequence: 0,
    earliestSequence: 0,
  });
  expect(before.body.reviewEvents.journalId).toEqual(expect.any(String));
  expect(before.body.reviewEvents.startId).toEqual(expect.any(String));
  (first as { close?: () => void }).close?.();
  const second = application();
  const after = await request(second.app).get("/api/status");
  expect(after.body.reviewEvents.journalId).toBe(
    before.body.reviewEvents.journalId,
  );
  expect(after.body.reviewEvents.startId).not.toBe(
    before.body.reviewEvents.startId,
  );
});

it("records one scoped completion and one overall comment across response-loss retries and restart", async () => {
  const first = application();
  const { journalId } = await prepare(first);
  const expectedVersion = await acknowledge(first, journalId);
  const body = {
    projectPath: projectDir,
    path: "draft.md",
    journalId,
    reviewContext: context,
    expectedVersion,
    overallComment: "One durable handoff.",
  };
  const completed = await request(first.app)
    .post("/api/review-events")
    .send(body);
  expect(completed.status).toBe(201);
  expect(completed.body.event).toMatchObject({
    reviewId: "round-one",
    sequence: 1,
    journalId,
    summary: { comments: 1, replies: 0, suggestions: 0, unresolved: 1 },
  });
  const retry = await request(first.app).post("/api/review-events").send(body);
  expect(retry.status).toBe(200);
  expect(retry.body.event.eventId).toBe(completed.body.event.eventId);
  expect(
    fs.readFileSync(file, "utf8").match(/One durable handoff\./g),
  ).toHaveLength(1);
  (first as { close?: () => void }).close?.();
  const second = application();
  const recovered = await request(second.app)
    .post("/api/review-events/watch")
    .send({
      journalId,
      reviewId: "round-one",
      fromNow: false,
      afterSequence: 0,
      timeoutSeconds: 0,
    });
  expect(recovered.status).toBe(200);
  expect(recovered.body.events).toHaveLength(1);
  expect(recovered.body.events[0]).toMatchObject({
    reviewId: "round-one",
    sequence: 1,
    eventId: completed.body.event.eventId,
  });
  expect(
    fs.readFileSync(file, "utf8").match(/One durable handoff\./g),
  ).toHaveLength(1);
});

it("recovers a receipt after the reviewed Markdown is removed", async () => {
  const value = application();
  const { journalId } = await prepare(value);
  const expectedVersion = await acknowledge(value, journalId);
  expect(
    (
      await request(value.app).post("/api/review-events").send({
        projectPath: projectDir,
        path: "draft.md",
        journalId,
        reviewContext: context,
        expectedVersion,
      })
    ).status,
  ).toBe(201);
  fs.unlinkSync(file);
  const recovered = await request(value.app)
    .post("/api/review-events/watch")
    .send({
      journalId,
      reviewId: "round-one",
      fromNow: false,
      afterSequence: 0,
      timeoutSeconds: 0,
    });
  expect(recovered.status).toBe(200);
  expect(recovered.body.events).toHaveLength(1);
  expect(recovered.body.events[0]).toMatchObject({
    reviewId: "round-one",
    sequence: 1,
  });
});

it("fences a delayed old open, acknowledgment, retirement and completion after a fresh round", async () => {
  const value = application();
  const { journalId } = await prepare(value);
  const oldVersion = await acknowledge(value, journalId);
  const newer = {
    storeId: "plugin-control-store",
    generation: 2,
    reviewId: "round-two",
    operationId: "open-two",
  };
  await prepare(value, newer);
  const newVersion = await acknowledge(value, journalId, newer);
  const staleOpen = await request(value.app).post("/api/open-request").send({
    path: file,
    url: "http://localhost:7373/",
    journalId,
    reviewContext: context,
  });
  expect(staleOpen.status).toBe(409);
  expect(staleOpen.body.code).toBe("stale_context");
  for (const route of ["/api/open-request/ack", "/api/open-request/retire"]) {
    const stale = await request(value.app).post(route).send({
      path: file,
      journalId,
      reviewContext: context,
      version: oldVersion,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("stale_context");
  }
  const staleDone = await request(value.app).post("/api/review-events").send({
    projectPath: projectDir,
    path: "draft.md",
    journalId,
    reviewContext: context,
    expectedVersion: oldVersion,
  });
  expect(staleDone.status).toBe(409);
  expect(staleDone.body.code).toBe("stale_context");
  const current = await request(value.app)
    .get("/api/open-request")
    .query({ path: file, journalId });
  expect(current.body.context).toMatchObject({ ...newer, status: "loaded" });
  const completed = await request(value.app).post("/api/review-events").send({
    projectPath: projectDir,
    path: "draft.md",
    journalId,
    reviewContext: newer,
    expectedVersion: newVersion,
  });
  expect(completed.status).toBe(201);
  expect(completed.body.event).toMatchObject({
    reviewId: "round-two",
    sequence: 1,
  });
});

it("does not admit a different operation at the same generation or revive a retired context", async () => {
  const value = application();
  const { journalId } = await prepare(value);
  const replaced = await request(value.app)
    .post("/api/open-request")
    .send({
      path: file,
      url: "http://localhost:7373/",
      journalId,
      reviewContext: { ...context, operationId: "different-open" },
    });
  expect(replaced.status).toBe(409);
  expect(replaced.body.code).toBe("stale_context");
  const retired = await request(value.app)
    .post("/api/open-request/retire")
    .send({ path: file, journalId, reviewContext: context });
  expect(retired.status).toBe(200);
  const retry = await request(value.app).post("/api/open-request").send({
    path: file,
    url: "http://localhost:7373/",
    journalId,
    reviewContext: context,
  });
  expect(retry.status).toBe(409);
  expect(retry.body.code).toBe("context_retired");
});

it("preserves new external content and leaves the round unfinished when the saved version changed", async () => {
  const value = application();
  const { journalId } = await prepare(value);
  const expectedVersion = await acknowledge(value, journalId);
  fs.writeFileSync(file, "# External replacement\n");
  const completed = await request(value.app).post("/api/review-events").send({
    projectPath: projectDir,
    path: "draft.md",
    journalId,
    reviewContext: context,
    expectedVersion,
    overallComment: "Must not append.",
  });
  expect(completed.status).toBe(409);
  expect(completed.body.code).toBe("save_conflict");
  expect(fs.readFileSync(file, "utf8")).toBe("# External replacement\n");
  const waiting = await request(value.app)
    .post("/api/review-events/watch")
    .send({
      journalId,
      reviewId: "round-one",
      fromNow: false,
      afterSequence: 0,
      timeoutSeconds: 0,
    });
  expect(waiting.status).toBe(200);
  expect(waiting.body.events).toHaveLength(0);
  expect(waiting.body.timedOut).toBe(true);
});

it("reconciles a durable intent after a post-visible replacement failure without duplicating its comment", async () => {
  const first = application();
  const { journalId } = await prepare(first);
  const expectedVersion = await acknowledge(first, journalId);
  const originalRename = fs.renameSync;
  const sync = vi
    .spyOn(fs, "renameSync")
    .mockImplementationOnce((source, destination) => {
      originalRename(source, destination);
      throw new Error("post-visible replacement fault");
    });
  const body = {
    projectPath: projectDir,
    path: "draft.md",
    journalId,
    reviewContext: context,
    expectedVersion,
    overallComment: "Recovered handoff.",
  };
  const failed = await request(first.app).post("/api/review-events").send(body);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(failed.status).toBe(503);
  expect(failed.body.code).toBe("receipt_unavailable");
  sync.mockRestore();
  expect(
    fs.readFileSync(file, "utf8").match(/Recovered handoff\./g),
  ).toHaveLength(1);
  (first as { close?: () => void }).close?.();
  const second = application();
  const recovered = await request(second.app)
    .post("/api/review-events/watch")
    .send({
      journalId,
      reviewId: "round-one",
      fromNow: false,
      afterSequence: 0,
      timeoutSeconds: 0,
    });
  expect(recovered.status).toBe(200);
  expect(recovered.body.events).toHaveLength(1);
  expect(recovered.body.events[0]).toMatchObject({
    reviewId: "round-one",
    sequence: 1,
  });
  expect(
    (await request(second.app).post("/api/review-events").send(body)).status,
  ).toBe(200);
  expect(
    fs.readFileSync(file, "utf8").match(/Recovered handoff\./g),
  ).toHaveLength(1);
});

it("refuses another live writer and preserves malformed existing state", async () => {
  const first = application();
  expect((await request(first.app).get("/api/status")).status).toBe(200);
  const second = application();
  const refused = await request(second.app).get("/api/status");
  expect(refused.status).toBe(503);
  expect(refused.body.code).toBe("writer_busy");
  (first as { close?: () => void }).close?.();
  (second as { close?: () => void }).close?.();
  const journal = path.join(homeDir, ".roughdraft", "review-events.sqlite");
  fs.writeFileSync(journal, "not a sqlite database\n");
  const malformed = application();
  const result = await request(malformed.app).get("/api/status");
  expect(result.status).toBe(503);
  expect(result.body.code).toBe("recovery_unavailable");
  expect(fs.readFileSync(journal, "utf8")).toBe("not a sqlite database\n");
});

it("does not reuse an old journal binding when required state has been removed", async () => {
  const first = application();
  const { journalId } = await prepare(first);
  (first as { close?: () => void }).close?.();
  fs.rmSync(path.join(homeDir, ".roughdraft"), {
    recursive: true,
    force: true,
  });
  const second = application();
  const health = await request(second.app).get("/api/status");
  expect(health.status).toBe(200);
  expect(health.body.reviewEvents?.journalId).not.toBe(journalId);
  const failed = await request(second.app)
    .post("/api/review-events/watch")
    .send({
      journalId,
      reviewId: "round-one",
      fromNow: false,
      afterSequence: 0,
      timeoutSeconds: 0,
    });
  expect(failed.status).toBe(409);
  expect(failed.body.code).toBe("recovery_unavailable");
});

it("does not let an unscoped old client complete an active plugin review", async () => {
  const value = application();
  const { journalId } = await prepare(value);
  await acknowledge(value, journalId);
  const unscoped = await request(value.app).post("/api/review-events").send({
    projectPath: projectDir,
    path: "draft.md",
    overallComment: "Old window must not complete the new round.",
  });
  expect(unscoped.status).toBe(409);
  expect(unscoped.body.code).toBe("stale_context");
  expect(fs.readFileSync(file, "utf8")).toBe(
    "# Contract\n\nSaved review content.\n",
  );
});

it("uses one accepted context for a real document and a symlink alias", async () => {
  const value = application();
  const { journalId } = await prepare(value);
  const alias = path.join(projectDir, "alias.md");
  fs.symlinkSync(file, alias);
  const repeated = await request(value.app)
    .post("/api/open-request")
    .send({
      path: alias,
      url: `http://localhost:7373/?path=${encodeURIComponent(alias)}`,
      journalId,
      reviewContext: context,
    });
  expect(repeated.status).toBe(200);
  expect(repeated.body.context).toMatchObject({
    reviewId: "round-one",
    generation: 1,
    documentPath: fs.realpathSync(file),
  });
  const unscoped = await request(value.app)
    .post("/api/review-events")
    .send({ projectPath: projectDir, path: "alias.md" });
  expect(unscoped.status).toBe(409);
  expect(unscoped.body.code).toBe("stale_context");
});

it("refuses receipt-key corruption without rewriting the malformed journal", async () => {
  const first = application();
  const { journalId } = await prepare(first);
  const expectedVersion = await acknowledge(first, journalId);
  expect(
    (
      await request(first.app).post("/api/review-events").send({
        projectPath: projectDir,
        path: "draft.md",
        journalId,
        reviewContext: context,
        expectedVersion,
      })
    ).status,
  ).toBe(201);
  (first as { close?: () => void }).close?.();
  const journal = path.join(homeDir, ".roughdraft", "review-events.sqlite");
  const database = new DatabaseSync(journal);
  database
    .prepare("UPDATE events SET event_key=? WHERE sequence=1")
    .run("wrong-review-key");
  database.close();
  const second = application();
  const refused = await request(second.app).get("/api/status");
  expect(refused.status).toBe(503);
  expect(refused.body.code).toBe("recovery_unavailable");
});

it("refuses a rewound path-generation head instead of accepting stale operations", async () => {
  const first = application();
  await prepare(first);
  await prepare(first, {
    storeId: "plugin-control-store",
    generation: 2,
    reviewId: "round-two",
    operationId: "open-two",
  });
  (first as { close?: () => void }).close?.();
  const journal = path.join(homeDir, ".roughdraft", "review-events.sqlite");
  const database = new DatabaseSync(journal);
  database.prepare("UPDATE heads SET review_id=?").run("round-one");
  database.close();
  const second = application();
  const refused = await request(second.app).get("/api/status");
  expect(refused.status).toBe(503);
  expect(refused.body.code).toBe("recovery_unavailable");
});

it("detects journal removal under a live writer instead of serving detached state", async () => {
  const first = application();
  const { journalId } = await prepare(first);
  expect(typeof journalId).toBe("string");
  fs.unlinkSync(path.join(homeDir, ".roughdraft", "review-events.sqlite"));
  const refused = await request(first.app).get("/api/status");
  expect(refused.status).toBe(503);
  expect(refused.body.code).toBe("recovery_unavailable");
});

it("keeps overall-comment bodies in Markdown instead of durable receipt metadata", async () => {
  const first = application();
  const { journalId } = await prepare(first);
  const expectedVersion = await acknowledge(first, journalId);
  const completed = await request(first.app).post("/api/review-events").send({
    projectPath: projectDir,
    path: "draft.md",
    journalId,
    reviewContext: context,
    expectedVersion,
    overallComment: "Private feedback body control.",
  });
  expect(completed.status).toBe(201);
  expect(completed.body.event.overallComment).toBe(
    "Private feedback body control.",
  );
  (first as { close?: () => void }).close?.();
  const database = new DatabaseSync(
    path.join(homeDir, ".roughdraft", "review-events.sqlite"),
  );
  const rows = database
    .prepare("SELECT payload FROM events UNION ALL SELECT payload FROM intents")
    .all();
  database.close();
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain("Private feedback body control.");
  expect(fs.readFileSync(file, "utf8")).toContain(
    "Private feedback body control.",
  );
});

it("refuses a file changed between completion snapshot reads rather than recording replacement bytes", () => {
  const store = new ReviewStore(path.join(homeDir, "isolated-journal"));
  const input = {
    documentPath: file,
    projectPath: projectDir,
    relativePath: "draft.md",
    version: "injected-version",
    summary: { comments: 0, replies: 0, suggestions: 0, unresolved: 0 },
  };
  const content = "# Contract\n\nSaved review content.\n";
  const intent = store.prepareCompletion(
    input,
    content,
    content,
    "injected-version",
  );
  const originalRead = fs.readFileSync;
  let changed = false;
  const reader = vi.spyOn(fs, "readFileSync").mockImplementation(((
    target: fs.PathOrFileDescriptor,
    options: never,
  ) => {
    const result = originalRead(target, options);
    const targetIsDocument =
      typeof target === "number"
        ? fs.fstatSync(target).ino === fs.statSync(file).ino
        : String(target) === file;
    if (!changed && targetIsDocument) {
      changed = true;
      fs.writeFileSync(file, "# Unreviewed replacement with different bytes\n");
    }
    return result;
  }) as typeof fs.readFileSync);
  try {
    expect(() => store.finishCompletion(intent)).toThrowError(
      expect.objectContaining({ code: "recovery_unavailable" }),
    );
    expect(changed).toBe(true);
    expect(store.events()).toHaveLength(0);
    expect(fs.readFileSync(file, "utf8")).toBe(
      "# Unreviewed replacement with different bytes\n",
    );
  } finally {
    reader.mockRestore();
    store.close();
  }
});

it("rejects a document mutation during the completion read without acknowledging new bytes", async () => {
  const value = application();
  const { journalId } = await prepare(value);
  const expectedVersion = await acknowledge(value, journalId);
  const originalRead = fs.readFileSync;
  let changed = false;
  const reader = vi.spyOn(fs, "readFileSync").mockImplementation(((
    target: fs.PathOrFileDescriptor,
    options: never,
  ) => {
    const result = originalRead(target, options);
    const targetIsDocument =
      typeof target === "number"
        ? fs.fstatSync(target).ino === fs.statSync(file).ino
        : String(target) === file;
    if (!changed && targetIsDocument) {
      changed = true;
      fs.writeFileSync(file, "# External mutation during read\n");
    }
    return result;
  }) as typeof fs.readFileSync);
  const completed = await request(value.app).post("/api/review-events").send({
    projectPath: projectDir,
    path: "draft.md",
    journalId,
    reviewContext: context,
    expectedVersion,
    overallComment: "Must not append.",
  });
  reader.mockRestore();
  expect(changed).toBe(true);
  expect(completed.status).toBe(409);
  expect(completed.body.code).toBe("save_conflict");
  expect(fs.readFileSync(file, "utf8")).toBe(
    "# External mutation during read\n",
  );
  const recovered = await request(value.app)
    .post("/api/review-events/watch")
    .send({
      journalId,
      reviewId: "round-one",
      fromNow: false,
      timeoutSeconds: 0,
    });
  expect(recovered.body.events).toHaveLength(0);
});

it("disconnects a real HTTP watcher without retiring its context or losing later completion", async () => {
  const value = application();
  const { journalId } = await prepare(value);
  const expectedVersion = await acknowledge(value, journalId);
  const server = createServer(value.app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const controller = new AbortController();
  const waiting = fetch(`${origin}/api/review-events/watch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectPath: projectDir,
      path: "draft.md",
      fromNow: false,
      timeoutSeconds: 240,
    }),
    signal: controller.signal,
  }).then(
    () => "response",
    () => "disconnected",
  );
  async function waiterCount(expected: number) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await request(value.app)
        .get("/api/review-events/status")
        .query({ projectPath: projectDir, path: "draft.md" });
      if (status.body.watcherCount === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Watcher count did not become ${expected}`);
  }
  try {
    await waiterCount(1);
    controller.abort();
    expect(await waiting).toBe("disconnected");
    await waiterCount(0);
    const current = await request(value.app)
      .get("/api/open-request")
      .query({ path: file, journalId });
    expect(current.body.context).toMatchObject({
      reviewId: "round-one",
      status: "loaded",
    });
    const completed = await request(value.app).post("/api/review-events").send({
      projectPath: projectDir,
      path: "draft.md",
      journalId,
      reviewContext: context,
      expectedVersion,
    });
    expect(completed.status).toBe(201);
    const receipt = await request(value.app)
      .post("/api/review-events/watch")
      .send({
        journalId,
        reviewId: "round-one",
        fromNow: false,
        afterSequence: 0,
        timeoutSeconds: 0,
      });
    expect(receipt.body.events).toHaveLength(1);
    expect(receipt.body.events[0]).toMatchObject({
      sequence: 1,
      reviewId: "round-one",
    });
    const invalid = await request(value.app)
      .post("/api/review-events/watch")
      .send({
        journalId,
        reviewId: "round-one",
        fromNow: false,
        afterSequence: 2,
        timeoutSeconds: 0,
      });
    expect(invalid.status).toBe(409);
    expect(invalid.body.code).toBe("recovery_unavailable");
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("refuses a corrupted intent context before crash recovery can publish it", async () => {
  const directory = path.join(homeDir, ".roughdraft");
  const store = new ReviewStore(directory);
  store.prepare(file, projectDir, "draft.md", context);
  store.acknowledge(file, context, "injected-version");
  const content = "# Contract\n\nSaved review content.\n";
  store.prepareCompletion(
    {
      documentPath: file,
      projectPath: projectDir,
      relativePath: "draft.md",
      version: "injected-version",
      summary: { comments: 0, replies: 0, suggestions: 0, unresolved: 0 },
    },
    content,
    content,
    "injected-version",
    context,
  );
  store.close();
  const database = new DatabaseSync(
    path.join(directory, "review-events.sqlite"),
  );
  const row = database.prepare("SELECT payload FROM intents").get();
  const intent = JSON.parse(String(row?.payload));
  intent.reviewContext.reviewId = "corrupted-round";
  const corrupted = JSON.stringify(intent);
  database.prepare("UPDATE intents SET payload=?").run(corrupted);
  database.close();
  const value = application();
  const status = await request(value.app).get("/api/status");
  expect(status.status).toBe(503);
  expect(status.body.code).toBe("recovery_unavailable");
  value.close();
  const preserved = new DatabaseSync(
    path.join(directory, "review-events.sqlite"),
  );
  expect(preserved.prepare("SELECT payload FROM intents").get()?.payload).toBe(
    corrupted,
  );
  expect(
    preserved.prepare("SELECT COUNT(*) AS count FROM events").get()?.count,
  ).toBe(0);
  preserved.close();
});

it("retries a pre-write failure with the original comment timestamp after restart", async () => {
  const first = application();
  const { journalId } = await prepare(first);
  const expectedVersion = await acknowledge(first, journalId);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-29T09:00:00.000Z"));
  const originalOpen = fs.openSync;
  let refusedWrite = false;
  const opener = vi.spyOn(fs, "openSync").mockImplementation(((
    target: fs.PathLike,
    flags: string | number,
    mode?: fs.Mode,
  ) => {
    if (
      String(target).includes(".roughdraft-") &&
      flags === "wx" &&
      !refusedWrite
    ) {
      refusedWrite = true;
      throw new Error("pre-write failure");
    }
    return originalOpen(target, flags, mode);
  }) as typeof fs.openSync);
  const body = {
    projectPath: projectDir,
    path: "draft.md",
    journalId,
    reviewContext: context,
    expectedVersion,
    overallComment: "Pre-write retry.",
  };
  try {
    const failed = await request(first.app)
      .post("/api/review-events")
      .send(body);
    opener.mockRestore();
    expect(refusedWrite).toBe(true);
    expect(failed.status).toBe(503);
    expect(fs.readFileSync(file, "utf8")).toBe(
      "# Contract\n\nSaved review content.\n",
    );
    first.close();
    vi.setSystemTime(new Date("2026-10-29T10:00:00.000Z"));
    const second = application();
    const retry = await request(second.app)
      .post("/api/review-events")
      .send(body);
    expect(retry.status).toBe(201);
    expect(retry.body.event).toMatchObject({
      reviewId: "round-one",
      sequence: 1,
      createdAt: "2026-10-29T09:00:00.000Z",
    });
    const saved = fs.readFileSync(file, "utf8");
    expect(saved.match(/Pre-write retry\./g)).toHaveLength(1);
    expect(saved).toContain("at: 2026-10-29T09:00:00.000Z");
  } finally {
    opener.mockRestore();
    vi.useRealTimers();
  }
});

it("fences scoped saves and old unscoped saves while keeping ordinary unscoped editing", async () => {
  const value = application();
  const ordinary = await request(value.app)
    .put("/api/markdown-file")
    .query({ projectPath: projectDir, path: "draft.md" })
    .send({ content: "# Ordinary save\n" });
  expect(ordinary.status).toBe(200);
  const { journalId } = await prepare(value);
  await acknowledge(value, journalId);
  const newer = {
    storeId: "plugin-control-store",
    generation: 2,
    reviewId: "round-two",
    operationId: "open-two",
  };
  await prepare(value, newer);
  const version = await acknowledge(value, journalId, newer);
  for (const metadata of [{}, { journalId, reviewContext: context }]) {
    const stale = await request(value.app)
      .put("/api/markdown-file")
      .query({ projectPath: projectDir, path: "draft.md" })
      .send({
        content: "# Stale overwrite\n",
        expectedVersion: version,
        ...metadata,
      });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("stale_context");
    expect(fs.readFileSync(file, "utf8")).toBe("# Ordinary save\n");
  }
  const saved = await request(value.app)
    .put("/api/markdown-file")
    .query({ projectPath: projectDir, path: "draft.md" })
    .send({
      content: "# Scoped save\n",
      expectedVersion: version,
      journalId,
      reviewContext: newer,
    });
  expect(saved.status).toBe(200);
  expect(fs.readFileSync(file, "utf8")).toBe("# Scoped save\n");
  const conflict = await request(value.app)
    .put("/api/markdown-file")
    .query({ projectPath: projectDir, path: "draft.md" })
    .send({
      content: "# Bad version\n",
      expectedVersion: version,
      journalId,
      reviewContext: newer,
    });
  expect(conflict.status).toBe(409);
  expect(fs.readFileSync(file, "utf8")).toBe("# Scoped save\n");
});

it("keeps a nested document receipt recoverable when the request uses its project root", async () => {
  fs.mkdirSync(path.join(projectDir, "nested"));
  file = path.join(projectDir, "nested", "draft.md");
  fs.writeFileSync(file, "# Nested review\n");
  const first = application();
  const { journalId } = await prepare(first);
  const page = await request(first.app)
    .get("/api/markdown-file")
    .query({ projectPath: projectDir, path: "nested/draft.md" });
  const acknowledgment = await request(first.app)
    .post("/api/open-request/ack")
    .send({
      path: file,
      journalId,
      reviewContext: context,
      version: page.body.version,
    });
  expect(acknowledgment.status).toBe(200);
  const completed = await request(first.app).post("/api/review-events").send({
    projectPath: projectDir,
    path: "nested/draft.md",
    journalId,
    reviewContext: context,
    expectedVersion: page.body.version,
  });
  expect(completed.status).toBe(201);
  first.close();
  const second = application();
  const receipt = await request(second.app)
    .post("/api/review-events/watch")
    .send({
      journalId,
      reviewId: "round-one",
      fromNow: false,
      timeoutSeconds: 0,
    });
  expect(receipt.status).toBe(200);
  expect(receipt.body.events[0]).toMatchObject({
    documentPath: fs.realpathSync(file),
    relativePath: "nested/draft.md",
    sequence: 1,
  });
});

it("preserves an active scoped context on the first unscoped open after restart", async () => {
  const first = application();
  const { journalId } = await prepare(first);
  await acknowledge(first, journalId);
  first.close();
  const second = application();
  const reopened = await request(second.app)
    .post("/api/open-request")
    .send({
      path: file,
      url: `http://localhost:7373/?path=${encodeURIComponent(file)}`,
    });
  expect(reopened.status).toBe(200);
  expect(reopened.body.context).toMatchObject({
    reviewId: "round-one",
    generation: 1,
    status: "loaded",
  });
  expect(reopened.body.journalId).toBe(journalId);
});

it("preserves an external edit that arrives while preparing the replacement", async () => {
  const value = application();
  const { journalId } = await prepare(value);
  const expectedVersion = await acknowledge(value, journalId);
  const originalSync = fs.fsyncSync;
  let changed = false;
  const opener = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    originalSync(fd);
    if (!changed && fs.fstatSync(fd).isFile()) {
      changed = true;
      fs.writeFileSync(file, "# External edit before write\n");
    }
  });
  const completed = await request(value.app).post("/api/review-events").send({
    projectPath: projectDir,
    path: "draft.md",
    journalId,
    reviewContext: context,
    expectedVersion,
    overallComment: "Must not overwrite external edit.",
  });
  opener.mockRestore();
  expect(changed).toBe(true);
  expect(completed.status).toBe(409);
  expect(completed.body.code).toBe("save_conflict");
  expect(fs.readFileSync(file, "utf8")).toBe("# External edit before write\n");
});

it("rejects an explicit unscoped completion version after a second edit following save", async () => {
  const value = application();
  const loaded = await request(value.app)
    .get("/api/markdown-file")
    .query({ projectPath: projectDir, path: "draft.md" });
  const saved = await request(value.app)
    .put("/api/markdown-file")
    .query({ projectPath: projectDir, path: "draft.md" })
    .send({
      content: "# Confirmed saved bytes\n",
      expectedVersion: loaded.body.version,
    });
  expect(saved.status).toBe(200);
  expect(saved.body.content).toBe("# Confirmed saved bytes\n");
  fs.writeFileSync(file, "# Second external edit\n");
  const completed = await request(value.app).post("/api/review-events").send({
    projectPath: projectDir,
    path: "draft.md",
    expectedVersion: saved.body.version,
    overallComment: "Must not attach to the second edit.",
  });
  expect(completed.status).toBe(409);
  expect(completed.body.code).toBe("save_conflict");
  expect(fs.readFileSync(file, "utf8")).toBe("# Second external edit\n");
});
