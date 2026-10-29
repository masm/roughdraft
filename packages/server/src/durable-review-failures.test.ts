import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractRoughdraftReviewIndex } from "@roughdraft/rfm";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "./index";

const fixture = `# Editorial review

The {==revenue projection==}{>>Please cite the assumption.<<}{#c1} needs review.
Add {++a sensitivity table++}{#s1}.

---
comments:
  c1:
    by: user
    at: "2026-10-28T10:00:00.000Z"
  c2:
    body: "Use the audited annual report, page 42."
    by: AI
    at: "2026-10-28T11:00:00.000Z"
    re: c1
  c3:
    body: "Page 42 excludes the new acquisition; please also cite note 9."
    by: user
    at: "2026-10-28T12:00:00.000Z"
    re: c2
suggestions:
  s1:
    by: AI
    at: "2026-10-28T13:00:00.000Z"
workflow:
  owner: editorial
`;
const context = {
  storeId: "review-failure-store",
  generation: 1,
  reviewId: "failure-round",
  operationId: "failure-open",
};
let scratch: string;
let file: string;
const applications: ReturnType<typeof createApp>[] = [];
beforeEach(() => {
  scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), "roughdraft-failure-contract-"),
  );
  file = path.join(scratch, "draft.md");
  fs.writeFileSync(file, fixture, { mode: 0o640 });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const app of applications.splice(0)) app.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});
function application() {
  const app = createApp({
    homeDir: scratch,
    reviewStateDir: path.join(scratch, "state"),
    staticDirPath: scratch,
  });
  applications.push(app);
  return app;
}
async function prepare(app: ReturnType<typeof createApp>, documentPath = file) {
  const status = await request(app.app).get("/api/status");
  expect(status.status).toBe(200);
  const journalId = status.body.reviewEvents.journalId;
  const opened = await request(app.app).post("/api/open-request").send({
    path: documentPath,
    url: "http://127.0.0.1/",
    journalId,
    reviewContext: context,
  });
  expect(opened.status).toBe(200);
  const relativePath = path.basename(documentPath);
  const page = await request(app.app)
    .get("/api/markdown-file")
    .query({ projectPath: scratch, path: relativePath });
  expect(page.status).toBe(200);
  expect(
    (
      await request(app.app).post("/api/open-request/ack").send({
        path: documentPath,
        journalId,
        reviewContext: context,
        version: page.body.version,
      })
    ).status,
  ).toBe(200);
  return {
    projectPath: scratch,
    path: relativePath,
    journalId,
    reviewContext: context,
    expectedVersion: page.body.version,
    overallComment: "Please reconcile the sources before merging.",
  };
}
function expectOriginalFeedback(content: string) {
  const index = extractRoughdraftReviewIndex(content);
  expect(index.diagnostics).toEqual([]);
  expect(index.items.find((item) => item.id === "c1")).toMatchObject({
    text: "Please cite the assumption.",
    parentId: null,
  });
  expect(index.items.find((item) => item.id === "c2")).toMatchObject({
    text: "Use the audited annual report, page 42.",
    parentId: "c1",
  });
  expect(index.items.find((item) => item.id === "c3")).toMatchObject({
    text: "Page 42 excludes the new acquisition; please also cite note 9.",
    parentId: "c2",
  });
  expect(index.items.find((item) => item.id === "s1")).toMatchObject({
    text: "a sensitivity table",
    kind: "suggestion",
  });
}

it("rejects an empty scoped save version after the nonempty stale-version control", async () => {
  const app = application();
  const body = await prepare(app);
  fs.writeFileSync(file, "# External saved feedback\n");
  const save = (expectedVersion: string) =>
    request(app.app)
      .put("/api/markdown-file")
      .query({ projectPath: scratch, path: "draft.md" })
      .send({
        content: "# Stale draft\n",
        journalId: body.journalId,
        reviewContext: context,
        expectedVersion,
      });
  expect((await save(body.expectedVersion)).status).toBe(409);
  expect(fs.readFileSync(file, "utf8")).toBe("# External saved feedback\n");
  expect((await save("")).status).toBe(409);
  expect(fs.readFileSync(file, "utf8")).toBe("# External saved feedback\n");
});

it("publishes a same-process recovered receipt to an existing watcher exactly once", async () => {
  const app = application();
  const body = await prepare(app);
  const waiting = request(app.app)
    .post("/api/review-events/watch")
    .send({
      projectPath: scratch,
      path: "draft.md",
      fromNow: false,
      timeoutSeconds: 2,
      batchWindowSeconds: 0,
    })
    .then((result) => result);
  let registered = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await request(app.app)
      .get("/api/review-events/status")
      .query({ projectPath: scratch, path: "draft.md" });
    if (status.body.watcherCount === 1) {
      registered = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(registered).toBe(true);
  const originalRename = fs.renameSync;
  const rename = vi
    .spyOn(fs, "renameSync")
    .mockImplementationOnce((source, destination) => {
      originalRename(source, destination);
      throw new Error("post-visible replacement failure");
    });
  const failed = await request(app.app).post("/api/review-events").send(body);
  expect(rename).toHaveBeenCalledTimes(1);
  rename.mockRestore();
  expect(failed.status).toBe(503);
  expect(fs.readFileSync(file, "utf8")).toContain(
    "Please reconcile the sources before merging.",
  );
  const retry = await request(app.app).post("/api/review-events").send(body);
  expect(retry.status).toBe(200);
  expect(retry.body.delivered).toBe(true);
  const watched = await waiting;
  expect(watched.status).toBe(200);
  expect(watched.body.timedOut).toBe(false);
  expect(watched.body.events).toHaveLength(1);
  expect(watched.body.events[0]).toMatchObject({
    reviewId: "failure-round",
    sequence: 1,
    eventId: retry.body.event.eventId,
  });
  const repeated = await request(app.app).post("/api/review-events").send(body);
  expect(repeated.status).toBe(200);
  expect(repeated.body.delivered).toBe(false);
  expect(repeated.body.event.eventId).toBe(retry.body.event.eventId);
  expect(
    fs
      .readFileSync(file, "utf8")
      .match(/Please reconcile the sources before merging\./g),
  ).toHaveLength(1);
});

it("preserves all existing feedback on normal completion through a symlink and keeps the target mode", async () => {
  const alias = path.join(scratch, "alias.md");
  fs.symlinkSync(file, alias);
  const app = application();
  const body = await prepare(app, alias);
  const completed = await request(app.app)
    .post("/api/review-events")
    .send(body);
  expect(completed.status).toBe(201);
  expectOriginalFeedback(fs.readFileSync(file, "utf8"));
  expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
  expect(fs.realpathSync(alias)).toBe(fs.realpathSync(file));
  expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  expect(
    extractRoughdraftReviewIndex(fs.readFileSync(file, "utf8")).summary,
  ).toEqual({ comments: 2, replies: 2, suggestions: 1, unresolved: 5 });
});

it("keeps existing YAML feedback byte-for-byte after a real partial write then ENOSPC", async () => {
  expectOriginalFeedback(fixture);
  const app = application();
  const body = await prepare(app);
  const originalOpen = fs.openSync;
  const originalWrite = fs.writeSync;
  let targetFd: number | undefined;
  let writes = 0;
  let partialBytes = 0;
  const open = vi.spyOn(fs, "openSync").mockImplementation(((
    target: fs.PathLike,
    flags: string | number,
    mode?: fs.Mode,
  ) => {
    const fd = originalOpen(target, flags, mode);
    if (
      (String(target) === file && flags === "r+") ||
      (String(target).includes(".roughdraft-") && flags === "wx")
    )
      targetFd = fd;
    return fd;
  }) as typeof fs.openSync);
  const write = vi.spyOn(fs, "writeSync").mockImplementation(((
    fd: number,
    bytes: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => {
    if (fd !== targetFd)
      return originalWrite(fd, bytes, offset, length, position);
    writes += 1;
    if (writes === 1) {
      expect(position).toBe(0);
      expect(length).toBeGreaterThan(393);
      partialBytes = originalWrite(fd, bytes, offset, 393, position);
      return partialBytes;
    }
    throw Object.assign(new Error("real partial write followed by ENOSPC"), {
      code: "ENOSPC",
    });
  }) as typeof fs.writeSync);
  const failed = await request(app.app).post("/api/review-events").send(body);
  open.mockRestore();
  write.mockRestore();
  expect(writes).toBe(2);
  expect(partialBytes).toBe(393);
  expect(failed.status).toBe(503);
  expect(fs.readFileSync(file, "utf8")).toBe(fixture);
  expectOriginalFeedback(fs.readFileSync(file, "utf8"));
  expect(
    fs.readdirSync(scratch).filter((name) => name.includes(".roughdraft-")),
  ).toEqual([]);
  app.close();
  const restarted = application();
  const pending = await request(restarted.app)
    .post("/api/review-events/watch")
    .send({
      journalId: body.journalId,
      reviewId: "failure-round",
      fromNow: false,
      timeoutSeconds: 0,
    });
  expect(pending.status).toBe(200);
  expect(pending.body.events).toEqual([]);
  const retry = await request(restarted.app)
    .post("/api/review-events")
    .send(body);
  expect(retry.status).toBe(201);
  expectOriginalFeedback(fs.readFileSync(file, "utf8"));
  expect(
    fs
      .readFileSync(file, "utf8")
      .match(/Please reconcile the sources before merging\./g),
  ).toHaveLength(1);
});

it.each([
  "temporary sync",
  "before replacement",
])("preserves original feedback and cleans its temporary file on %s failure", async (boundary) => {
  const app = application();
  const body = await prepare(app);
  const fault =
    boundary === "temporary sync"
      ? vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
          throw new Error("temporary fsync failed");
        })
      : vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
          throw new Error("rename refused before visibility");
        });
  const failed = await request(app.app).post("/api/review-events").send(body);
  expect(fault).toHaveBeenCalledTimes(1);
  fault.mockRestore();
  expect(failed.status).toBe(503);
  expect(fs.readFileSync(file, "utf8")).toBe(fixture);
  expectOriginalFeedback(fs.readFileSync(file, "utf8"));
  expect(
    fs.readdirSync(scratch).filter((name) => name.includes(".roughdraft-")),
  ).toEqual([]);
  expect(
    (await request(app.app).post("/api/review-events").send(body)).status,
  ).toBe(201);
});

it("refuses overall-comment replacement of a hard-linked document without splitting its aliases", async () => {
  const alias = path.join(scratch, "hard-link.md");
  fs.linkSync(file, alias);
  expect(fs.statSync(file).nlink).toBe(2);
  expect(fs.statSync(alias).ino).toBe(fs.statSync(file).ino);
  const app = application();
  const body = await prepare(app);
  const completed = await request(app.app)
    .post("/api/review-events")
    .send(body);
  expect(completed.status).toBe(409);
  expect(completed.body.code).toBe("save_conflict");
  expect(fs.readFileSync(file, "utf8")).toBe(fixture);
  expect(fs.readFileSync(alias, "utf8")).toBe(fixture);
  expect(fs.statSync(alias).ino).toBe(fs.statSync(file).ino);
  expect(
    fs.readdirSync(scratch).filter((name) => name.includes(".roughdraft-")),
  ).toEqual([]);
});

it("cannot use a writable parent directory to bypass a read-only document", async () => {
  const app = application();
  const body = await prepare(app);
  fs.chmodSync(file, 0o444);
  // A real sibling write proves the directory remains writable during the denied target write.
  const control = path.join(scratch, "writable-parent-control");
  fs.writeFileSync(control, "directory write works\n");
  expect(fs.readFileSync(control, "utf8")).toBe("directory write works\n");
  const completed = await request(app.app)
    .post("/api/review-events")
    .send(body);
  expect(completed.status).toBe(503);
  expect(completed.body.code).toBe("receipt_unavailable");
  expect(fs.readFileSync(file, "utf8")).toBe(fixture);
  expect(fs.statSync(file).mode & 0o777).toBe(0o444);
  expect(
    fs.readdirSync(scratch).filter((name) => name.includes(".roughdraft-")),
  ).toEqual([]);
});
