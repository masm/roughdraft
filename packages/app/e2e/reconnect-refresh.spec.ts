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
