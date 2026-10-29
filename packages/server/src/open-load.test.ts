import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp } from "./index";

let scratch: string;
let file: string;
let application: ReturnType<typeof createApp>;
const context = {
  storeId: "load-store",
  generation: 1,
  reviewId: "load-round",
  operationId: "load-operation",
};
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-open-load-"));
  file = path.join(scratch, "draft.md");
  fs.writeFileSync(file, "# Actual loaded file\n");
  application = createApp({
    homeDir: scratch,
    reviewStateDir: path.join(scratch, "state"),
    staticDirPath: scratch,
  });
});
afterEach(() => {
  application.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});
async function version() {
  return (
    await request(application.app)
      .get("/api/markdown-file")
      .query({ projectPath: scratch, path: "draft.md" })
  ).body.version;
}
async function journal() {
  return (await request(application.app).get("/api/status")).body.reviewEvents
    .journalId;
}

it("keeps ordinary load evidence separate from durable plugin review ownership", async () => {
  const opened = await request(application.app)
    .post("/api/open-request")
    .send({
      path: file,
      url: `http://127.0.0.1/?path=${encodeURIComponent(file)}`,
      loadRequestId: "ordinary-load",
      notify: false,
    });
  expect(opened.status).toBe(200);
  expect(opened.body.context).toBeUndefined();
  expect(opened.body.load).toMatchObject({
    id: "ordinary-load",
    status: "opening",
    documentPath: fs.realpathSync(file),
  });
  expect(new URL(opened.body.url).searchParams.get("openRequest")).toBe(
    "ordinary-load",
  );
  const loaded = await request(application.app)
    .post("/api/open-request/ack")
    .send({
      path: file,
      version: await version(),
      loadRequestId: "ordinary-load",
    });
  expect(loaded.status).toBe(200);
  const status = await request(application.app)
    .get("/api/open-request/load")
    .query({ id: "ordinary-load" });
  expect(status.body.load).toMatchObject({
    id: "ordinary-load",
    status: "loaded",
    documentPath: fs.realpathSync(file),
  });
  const current = await request(application.app)
    .get("/api/open-request")
    .query({ path: file, journalId: await journal() });
  expect(current.body.context).toBeNull();
});

it("requires a fresh load acknowledgment even if the same scoped tuple loaded earlier", async () => {
  const journalId = await journal();
  const payload = {
    path: file,
    url: "http://127.0.0.1/",
    journalId,
    reviewContext: context,
    notify: false,
  };
  await request(application.app)
    .post("/api/open-request")
    .send({ ...payload, loadRequestId: "first-load" });
  expect(
    (
      await request(application.app)
        .post("/api/open-request/ack")
        .send({
          path: file,
          journalId,
          reviewContext: context,
          version: await version(),
          loadRequestId: "first-load",
        })
    ).status,
  ).toBe(200);
  const repeated = await request(application.app)
    .post("/api/open-request")
    .send({ ...payload, loadRequestId: "second-load" });
  expect(repeated.body.context.status).toBe("loaded");
  expect(repeated.body.load.status).toBe("opening");
  const mismatch = await request(application.app)
    .post("/api/open-request/ack")
    .send({
      path: file,
      version: await version(),
      loadRequestId: "second-load",
    });
  expect(mismatch.status).toBe(409);
  expect(mismatch.body.code).toBe("stale_context");
});

it("fences reversed acknowledgments and reports stale opening attempts as failed", async () => {
  const journalId = await journal();
  const newer = {
    ...context,
    generation: 2,
    reviewId: "newer-round",
    operationId: "newer-operation",
  };
  for (const [reviewContext, loadRequestId] of [
    [context, "old-load"],
    [newer, "new-load"],
  ] as const) {
    expect(
      (
        await request(application.app).post("/api/open-request").send({
          path: file,
          url: "http://127.0.0.1/",
          journalId,
          reviewContext,
          loadRequestId,
          notify: false,
        })
      ).status,
    ).toBe(200);
  }
  const oldAck = await request(application.app)
    .post("/api/open-request/ack")
    .send({
      path: file,
      journalId,
      reviewContext: context,
      version: await version(),
      loadRequestId: "old-load",
    });
  expect(oldAck.status).toBe(409);
  const oldStatus = await request(application.app)
    .get("/api/open-request/load")
    .query({ id: "old-load" });
  expect(oldStatus.body.load.status).toBe("failed");
  const current = await request(application.app)
    .get("/api/open-request")
    .query({ path: file, journalId });
  expect(current.body.context).toMatchObject({
    reviewId: "newer-round",
    status: "opening",
  });
  expect(
    (
      await request(application.app)
        .post("/api/open-request/ack")
        .send({
          path: file,
          journalId,
          reviewContext: newer,
          version: await version(),
          loadRequestId: "new-load",
        })
    ).status,
  ).toBe(200);
});

it("reports a real browser load failure without retiring the scoped review", async () => {
  const journalId = await journal();
  expect(
    (
      await request(application.app).post("/api/open-request").send({
        path: file,
        url: "http://127.0.0.1/",
        journalId,
        reviewContext: context,
        loadRequestId: "failed-load",
        notify: false,
      })
    ).status,
  ).toBe(200);
  fs.unlinkSync(file);
  const failure = await request(application.app)
    .post("/api/open-request/failure")
    .send({
      path: file,
      loadRequestId: "failed-load",
      error: "Could not read the requested Markdown file.",
    });
  expect(failure.status).toBe(200);
  const status = await request(application.app)
    .get("/api/open-request/load")
    .query({ id: "failed-load" });
  expect(status.body.load).toMatchObject({
    status: "failed",
    error: "Could not read the requested Markdown file.",
  });
  const current = await request(application.app)
    .get("/api/open-request")
    .query({ path: file, journalId });
  expect(current.body.context).toMatchObject({
    reviewId: "load-round",
    status: "opening",
  });
});

it("continues a persisted context after restart even when its old transient load ID is gone", async () => {
  const journalId = await journal();
  await request(application.app).post("/api/open-request").send({
    path: file,
    url: "http://127.0.0.1/",
    journalId,
    reviewContext: context,
    loadRequestId: "before-restart-load",
    notify: false,
  });
  expect(
    (
      await request(application.app)
        .post("/api/open-request/ack")
        .send({
          path: file,
          journalId,
          reviewContext: context,
          version: await version(),
          loadRequestId: "before-restart-load",
        })
    ).status,
  ).toBe(200);
  application.close();
  application = createApp({
    homeDir: scratch,
    reviewStateDir: path.join(scratch, "state"),
    staticDirPath: scratch,
  });
  const reloaded = await request(application.app)
    .post("/api/open-request/ack")
    .send({
      path: file,
      journalId,
      reviewContext: context,
      version: await version(),
      loadRequestId: "before-restart-load",
    });
  expect(reloaded.status).toBe(200);
  expect(reloaded.body.context).toMatchObject({
    reviewId: "load-round",
    status: "loaded",
  });
  expect(
    (
      await request(application.app)
        .get("/api/open-request/load")
        .query({ id: "before-restart-load" })
    ).status,
  ).toBe(409);
});
