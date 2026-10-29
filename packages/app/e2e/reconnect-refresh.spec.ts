import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { createServer as createVite, type ViteDevServer } from "vite";
import { createApp } from "../../server/src/index";
import { logE2eEvent } from "./helpers";

let scratch: string;
let origin: string;
let server: Server;
let vite: ViteDevServer;
let application: ReturnType<typeof createApp>;
const appRoot = fileURLToPath(new URL("../", import.meta.url));

test.beforeAll(async () => {
  scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), "roughdraft-refresh-regression-"),
  );
  const homeDir = path.join(scratch, "home");
  fs.mkdirSync(homeDir);
  application = createApp({
    homeDir,
    reviewStateDir: path.join(scratch, "journal"),
    staticDirPath: path.join(scratch, "no-static"),
  });
  vite = await createVite({
    root: appRoot,
    configFile: path.join(appRoot, "vite.config.ts"),
    server: { middlewareMode: true, hmr: false },
    appType: "spa",
  });
  server = createServer((request, response) => {
    if (request.url?.startsWith("/api/")) application.app(request, response);
    else vite.middlewares(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await vite?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  application?.close();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

async function watchConnection(
  page: Page,
  connected: boolean,
  route = "markdown-file/events",
) {
  await page.waitForFunction(
    ({ expected, route }) => {
      const sources = (window as unknown as { refreshSources: EventSource[] })
        .refreshSources;
      return (
        sources.some(
          (source) => source.url.includes(route) && source.readyState === 1,
        ) === expected
      );
    },
    { expected: connected, route },
  );
}

for (const mode of ["code", "rich-text"] as const) {
  for (const boundary of ["reconnect", "same-path reopen"] as const) {
    test(`${mode} refreshes an edit missed during disconnect on ${boundary}`, async ({
      page,
      context,
      request,
    }) => {
      const filePath = path.join(
        scratch,
        `${mode}-${boundary.replaceAll(" ", "-")}.md`,
      );
      fs.writeFileSync(filePath, "# Refresh\n\nOriginal body.\n");
      await page.addInitScript(() => {
        const Native = window.EventSource;
        (
          window as unknown as { refreshSources: EventSource[] }
        ).refreshSources = [];
        window.EventSource = class extends Native {
          constructor(url: string | URL, options?: EventSourceInit) {
            super(url, options);
            (
              window as unknown as { refreshSources: EventSource[] }
            ).refreshSources.push(this);
          }
        };
      });
      const url = `${origin}/?${new URLSearchParams({ path: filePath, editor: mode })}`;
      await page.goto(url);
      const editor = page.getByTestId(
        mode === "code" ? "markdown-code-editor" : "rich-text-editor",
      );
      await expect(editor).toContainText("Original body.");
      await watchConnection(page, true);
      // The same watcher/editor must first prove connected filesystem refresh works.
      fs.writeFileSync(filePath, "# Refresh\n\nConnected body.\n");
      await expect(editor).toContainText("Connected body.");
      logE2eEvent("refresh.connected-control", {
        mode,
        boundary,
        filePath,
        text: await editor.innerText(),
      });

      await context.setOffline(true);
      server.closeAllConnections();
      await watchConnection(page, false);
      fs.writeFileSync(filePath, "# Refresh\n\nMissed while disconnected.\n");
      expect(fs.readFileSync(filePath, "utf8")).toBe(
        "# Refresh\n\nMissed while disconnected.\n",
      );
      await context.setOffline(false);
      await watchConnection(page, true);
      if (boundary === "same-path reopen") {
        await watchConnection(page, true, "open-requests");
        const response = await request.post(`${origin}/api/open-request`, {
          data: { path: filePath, url: page.url() },
        });
        expect(response.ok()).toBe(true);
        expect((await response.json()).delivered).toBe(true);
      }
      // Soft assertion lets the explicit reload control run even on the original bug.
      await expect
        .soft(editor)
        .toContainText("Missed while disconnected.", { timeout: 5_000 });
      logE2eEvent("refresh.after-disconnect", {
        mode,
        boundary,
        filePath,
        text: await editor.innerText(),
      });
      await page.reload();
      await expect(editor).toContainText("Missed while disconnected.");
      logE2eEvent("refresh.reload-control", {
        mode,
        boundary,
        filePath,
        text: await editor.innerText(),
      });
    });
  }
}

for (const mode of ["code", "rich-text"] as const) {
  test(`${mode} detects a connected equal-size edit with restored timestamps`, async ({
    page,
  }) => {
    const file = path.join(scratch, `equal-${mode}.md`);
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    fs.writeFileSync(file, "# Equal\n\nFirst equal.\n");
    fs.utimesSync(file, fixed, fixed);
    await page.goto(
      `${origin}/?${new URLSearchParams({ path: file, editor: mode })}`,
    );
    const editor = page.getByTestId(
      mode === "code" ? "markdown-code-editor" : "rich-text-editor",
    );
    await expect(editor).toContainText("First equal.");
    fs.writeFileSync(file, "# Equal\n\nOther equal.\n");
    await expect(editor).toContainText("Other equal.");
    fs.writeFileSync(file, "# Equal\n\nThird equal.\n");
    fs.utimesSync(file, fixed, fixed);
    await expect(editor).toContainText("Third equal.");
    fs.writeFileSync(file, "# Equal\n\nFinal equal.\n");
    fs.utimesSync(file, fixed, fixed);
    expect(fs.statSync(file).size).toBe(22);
    expect(fs.statSync(file).mtimeMs).toBe(1767225600000);
    await expect(editor).toContainText("Final equal.");
  });

  test(`${mode} records a disconnected scoped completion and starts a fresh same-path round`, async ({
    page,
    request,
  }) => {
    const file = path.join(scratch, `scoped-${mode}.md`);
    fs.writeFileSync(file, "# Scoped\n\nReview me.\n");
    const journalId = (await (await request.get(`${origin}/api/status`)).json())
      .reviewEvents.journalId;
    const first = {
      storeId: "browser-store",
      generation: 1,
      reviewId: `first-${mode}`,
      operationId: `first-open-${mode}`,
    };
    const firstOpen = await request.post(`${origin}/api/open-request`, {
      data: {
        path: file,
        url: `${origin}/?${new URLSearchParams({ path: file, editor: mode })}`,
        journalId,
        reviewContext: first,
        loadRequestId: `first-load-${mode}`,
        notify: false,
      },
    });
    expect(firstOpen.status()).toBe(200);
    await page.goto((await firstOpen.json()).url);
    const done = page.getByTestId("review-handoff-button");
    await expect(done).toBeEnabled();
    await page.getByTestId("review-handoff-comment-trigger").click();
    await page
      .getByTestId("review-handoff-overall-comment")
      .fill("One recorded browser handoff.");
    const checkedAfterSave = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/api/open-request",
    );
    await done.click();
    await expect(done).toHaveText("Saved");
    const receipt = await request.post(`${origin}/api/review-events/watch`, {
      data: {
        journalId,
        reviewId: first.reviewId,
        afterSequence: 0,
        fromNow: false,
        timeoutSeconds: 0,
      },
    });
    const events = (await receipt.json()).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reviewId: first.reviewId,
      summary: { comments: 1 },
    });
    await (await checkedAfterSave).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(done).toBeEnabled();
    await expect(page.getByTestId("file-conflict-notice")).toBeHidden();
    await page.keyboard.press("Escape");
    const second = {
      ...first,
      generation: 2,
      reviewId: `second-${mode}`,
      operationId: `second-open-${mode}`,
    };
    const secondOpen = await request.post(`${origin}/api/open-request`, {
      data: {
        path: file,
        url: page.url(),
        journalId,
        reviewContext: second,
        loadRequestId: `second-load-${mode}`,
      },
    });
    expect(secondOpen.status()).toBe(200);
    expect((await secondOpen.json()).delivered).toBe(true);
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(
                `${origin}/api/open-request/load?id=second-load-${mode}`,
              )
            ).json()
          ).load.status,
      )
      .toBe("loaded");
    await expect(done).toHaveText("Approve");
    await expect(done).toBeEnabled();
    await done.click();
    await expect(done).toHaveText("Saved");
    const secondReceipt = await request.post(
      `${origin}/api/review-events/watch`,
      {
        data: {
          journalId,
          reviewId: second.reviewId,
          afterSequence: 0,
          fromNow: false,
          timeoutSeconds: 0,
        },
      },
    );
    expect((await secondReceipt.json()).events).toHaveLength(1);
    expect(
      fs.readFileSync(file, "utf8").match(/One recorded browser handoff\./g),
    ).toHaveLength(1);
    await page.reload();
    await expect(done).toHaveText("Saved");
  });
}

test("retries a scoped receipt after its successful HTTP response was lost", async ({
  page,
  request,
}) => {
  const file = path.join(scratch, "response-loss.md");
  fs.writeFileSync(file, "# Lost response\n");
  const journalId = (await (await request.get(`${origin}/api/status`)).json())
    .reviewEvents.journalId;
  const reviewContext = {
    storeId: "response-loss-store",
    generation: 1,
    reviewId: "response-loss-round",
    operationId: "response-loss-open",
  };
  const opened = await request.post(`${origin}/api/open-request`, {
    data: {
      path: file,
      url: `${origin}/?${new URLSearchParams({ path: file, editor: "code" })}`,
      journalId,
      reviewContext,
      loadRequestId: "response-loss-load",
      notify: false,
    },
  });
  await page.goto((await opened.json()).url);
  const done = page.getByTestId("review-handoff-button");
  await expect(done).toBeEnabled();
  let injected = 0;
  await page.route(/\/api\/review-events(?:\?|$)/, async (route) => {
    if (injected++) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    await route.abort("failed");
  });
  await page.getByTestId("review-handoff-comment-trigger").click();
  await page
    .getByTestId("review-handoff-overall-comment")
    .fill("Response-loss comment.");
  await done.click();
  await expect.poll(() => injected).toBe(1);
  await expect(done).toHaveText("Not sent");
  const existing = await request.post(`${origin}/api/review-events/watch`, {
    data: {
      journalId,
      reviewId: reviewContext.reviewId,
      afterSequence: 0,
      fromNow: false,
      timeoutSeconds: 0,
    },
  });
  expect((await existing.json()).events).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(done).toBeEnabled();
  await done.click();
  await expect(done).toHaveText("Saved");
  expect(
    fs.readFileSync(file, "utf8").match(/Response-loss comment\./g),
  ).toHaveLength(1);
});

async function observeOpeningStream(page: Page) {
  await page.addInitScript(() => {
    const Native = window.EventSource;
    (window as unknown as { refreshSources: EventSource[] }).refreshSources =
      [];
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        (
          window as unknown as { refreshSources: EventSource[] }
        ).refreshSources.push(this);
      }
    };
  });
}

for (const scoped of [false, true]) {
  test(`explicit overwrite resolves a dirty same-path ${scoped ? "new scoped round" : "ordinary reopen"}`, async ({
    page,
    request,
  }) => {
    const file = path.join(scratch, `overwrite-reopen-${scoped}.md`);
    fs.writeFileSync(file, "# Reopen\n\nOriginal body.\n");
    const journalId = (await (await request.get(`${origin}/api/status`)).json())
      .reviewEvents.journalId;
    const first = {
      storeId: "overwrite-store",
      generation: 1,
      reviewId: `overwrite-${scoped}-first`,
      operationId: `overwrite-${scoped}-first-open`,
    };
    const second = {
      ...first,
      generation: 2,
      reviewId: `overwrite-${scoped}-second`,
      operationId: `overwrite-${scoped}-second-open`,
    };
    const url = `${origin}/?${new URLSearchParams({ path: file, editor: "code" })}`;
    await observeOpeningStream(page);
    if (scoped) {
      const registered = await request.post(`${origin}/api/open-request`, {
        data: {
          path: file,
          url,
          journalId,
          reviewContext: first,
          loadRequestId: "overwrite-first",
          notify: false,
        },
      });
      expect(registered.status()).toBe(200);
      await page.goto((await registered.json()).url);
      await expect(page.getByTestId("review-handoff-button")).toBeEnabled();
    } else await page.goto(url);
    await watchConnection(page, true, "open-requests");
    const editor = page
      .getByTestId("markdown-code-editor")
      .locator(".cm-content");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("\nPreserved local overwrite draft.\n");
    const reopened = await request.post(`${origin}/api/open-request`, {
      data: {
        path: file,
        url,
        loadRequestId: `overwrite-second-${scoped}`,
        ...(scoped ? { journalId, reviewContext: second } : {}),
      },
    });
    expect(reopened.status()).toBe(200);
    expect((await reopened.json()).delivered).toBe(true);
    await expect(page.getByTestId("file-conflict-notice")).toContainText(
      "Your local draft was preserved",
    );
    expect(fs.readFileSync(file, "utf8")).toBe("# Reopen\n\nOriginal body.\n");
    await expect(editor).toContainText("Preserved local overwrite draft.");
    await page.getByTestId("file-conflict-action-overwrite").click();
    await expect
      .poll(() => fs.readFileSync(file, "utf8"))
      .toContain("Preserved local overwrite draft.");
    await expect(page.getByTestId("file-conflict-notice")).toBeHidden();
    await expect(page.getByTestId("document-save-status")).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    if (scoped) {
      const done = page.getByTestId("review-handoff-button");
      await expect(done).toBeEnabled();
      await done.click();
      await expect(done).toHaveText("Saved");
      const receipt = await request.post(`${origin}/api/review-events/watch`, {
        data: {
          journalId,
          reviewId: second.reviewId,
          afterSequence: 0,
          fromNow: false,
          timeoutSeconds: 0,
        },
      });
      expect((await receipt.json()).events).toHaveLength(1);
    }
  });
}

test("an old completion response cannot mark a newer loaded round Saved", async ({
  page,
  request,
}) => {
  const file = path.join(scratch, "old-completion-response.md");
  fs.writeFileSync(file, "# Completion response race\n");
  const journalId = (await (await request.get(`${origin}/api/status`)).json())
    .reviewEvents.journalId;
  const first = {
    storeId: "delayed-response-store",
    generation: 1,
    reviewId: "delayed-first",
    operationId: "delayed-first-open",
  };
  const second = {
    ...first,
    generation: 2,
    reviewId: "delayed-second",
    operationId: "delayed-second-open",
  };
  const url = `${origin}/?${new URLSearchParams({ path: file, editor: "code" })}`;
  await observeOpeningStream(page);
  const opened = await request.post(`${origin}/api/open-request`, {
    data: {
      path: file,
      url,
      journalId,
      reviewContext: first,
      loadRequestId: "delayed-first-load",
      notify: false,
    },
  });
  expect(opened.status()).toBe(200);
  await page.goto((await opened.json()).url);
  await watchConnection(page, true, "open-requests");
  const done = page.getByTestId("review-handoff-button");
  await expect(done).toBeEnabled();
  let release!: () => void;
  let committed!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const saved = new Promise<void>((resolve) => {
    committed = resolve;
  });
  let intercepted = 0;
  await page.route(/\/api\/review-events(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    if (intercepted++ === 0) {
      expect(response.status()).toBe(201);
      committed();
      await gate;
    }
    await route.fulfill({ response });
  });
  try {
    await done.click();
    await saved;
    const receipt = await request.post(`${origin}/api/review-events/watch`, {
      data: {
        journalId,
        reviewId: first.reviewId,
        afterSequence: 0,
        fromNow: false,
        timeoutSeconds: 0,
      },
    });
    expect((await receipt.json()).events).toHaveLength(1);
    const reopened = await request.post(`${origin}/api/open-request`, {
      data: {
        path: file,
        url,
        journalId,
        reviewContext: second,
        loadRequestId: "delayed-second-load",
      },
    });
    expect(reopened.status()).toBe(200);
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(
                `${origin}/api/open-request/load?id=delayed-second-load`,
              )
            ).json()
          ).load.status,
      )
      .toBe("loaded");
    await expect(done).toHaveText("Approve");
    await expect(done).toBeEnabled();
    const oldResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/review-events",
    );
    release();
    await (await oldResponse).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(intercepted).toBe(1);
    await expect(done).toHaveText("Approve");
    const pending = await request.post(`${origin}/api/review-events/watch`, {
      data: {
        journalId,
        reviewId: second.reviewId,
        afterSequence: 0,
        fromNow: false,
        timeoutSeconds: 0,
      },
    });
    expect((await pending.json()).events).toHaveLength(0);
    await done.click();
    await expect(done).toHaveText("Saved");
    const secondReceipt = await request.post(
      `${origin}/api/review-events/watch`,
      {
        data: {
          journalId,
          reviewId: second.reviewId,
          afterSequence: 0,
          fromNow: false,
          timeoutSeconds: 0,
        },
      },
    );
    expect((await secondReceipt.json()).events).toHaveLength(1);
    expect(intercepted).toBe(2);
  } finally {
    release();
  }
});

for (const scoped of [false, true]) {
  test(`restoration after a failed ${scoped ? "scoped" : "ordinary"} reopen restores saving`, async ({
    page,
    request,
  }) => {
    const file = path.join(scratch, `restore-reopen-${scoped}.md`);
    fs.writeFileSync(file, "# Before disappearance\n");
    const journalId = (await (await request.get(`${origin}/api/status`)).json())
      .reviewEvents.journalId;
    const first = {
      storeId: "restore-store",
      generation: 1,
      reviewId: `restore-${scoped}-first`,
      operationId: `restore-${scoped}-first-open`,
    };
    const second = {
      ...first,
      generation: 2,
      reviewId: `restore-${scoped}-second`,
      operationId: `restore-${scoped}-second-open`,
    };
    const url = `${origin}/?${new URLSearchParams({ path: file, editor: "code" })}`;
    await observeOpeningStream(page);
    if (scoped) {
      const opened = await request.post(`${origin}/api/open-request`, {
        data: {
          path: file,
          url,
          journalId,
          reviewContext: first,
          loadRequestId: "restore-first",
          notify: false,
        },
      });
      expect(opened.status()).toBe(200);
      await page.goto((await opened.json()).url);
      await expect(page.getByTestId("review-handoff-button")).toBeEnabled();
    } else await page.goto(url);
    await watchConnection(page, true, "open-requests");
    await watchConnection(page, true);
    const editor = page
      .getByTestId("markdown-code-editor")
      .locator(".cm-content");
    await expect(editor).toContainText("Before disappearance");
    let removed = false;
    await page.route(/\/api\/markdown-file(?:\?|$)/, async (route) => {
      if (route.request().method() === "GET" && !removed) {
        fs.unlinkSync(file);
        removed = true;
      }
      await route.continue();
    });
    const failedRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/markdown-file" &&
        response.request().method() === "GET" &&
        response.status() === 404,
    );
    const reopened = await request.post(`${origin}/api/open-request`, {
      data: {
        path: file,
        url,
        loadRequestId: `restore-second-${scoped}`,
        ...(scoped ? { journalId, reviewContext: second } : {}),
      },
    });
    expect(reopened.status()).toBe(200);
    expect((await reopened.json()).delivered).toBe(true);
    await (await failedRead).finished();
    expect(removed).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    await expect(page.getByTestId("file-conflict-notice")).toBeVisible();
    await expect(editor).toContainText("Before disappearance");
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(
                `${origin}/api/open-request/load?id=restore-second-${scoped}`,
              )
            ).json()
          ).load.status,
      )
      .toBe("failed");
    fs.writeFileSync(file, "# Restored review\n");
    await expect(editor).toContainText("Restored review");
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(
                `${origin}/api/open-request/load?id=restore-second-${scoped}`,
              )
            ).json()
          ).load.status,
      )
      .toBe("loaded");
    await expect(page.getByTestId("file-conflict-notice")).toBeHidden();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("\nRecovered local review.\n");
    await expect
      .poll(() => fs.readFileSync(file, "utf8"))
      .toContain("Recovered local review.");
    await expect(page.getByTestId("document-save-status")).toHaveAttribute(
      "aria-label",
      "Saved",
    );
    if (scoped) {
      const done = page.getByTestId("review-handoff-button");
      await expect(done).toBeEnabled();
      await done.click();
      await expect(done).toHaveText("Saved");
      const receipt = await request.post(`${origin}/api/review-events/watch`, {
        data: {
          journalId,
          reviewId: second.reviewId,
          afterSequence: 0,
          fromNow: false,
          timeoutSeconds: 0,
        },
      });
      expect((await receipt.json()).events).toHaveLength(1);
    }
  });
}
