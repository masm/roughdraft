import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createApp } from "./index";

interface RunningApp {
  application: ReturnType<typeof createApp>;
  server: Server;
  origin: string;
}

it("recovers a saved completion after restarting the HTTP application", async () => {
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), "roughdraft-durable-restart-"),
  );
  const projectDir = path.join(scratch, "documents");
  const homeDir = path.join(scratch, "home");
  fs.mkdirSync(projectDir);
  fs.mkdirSync(homeDir);
  const documentPath = path.join(projectDir, "draft.md");
  fs.writeFileSync(documentPath, "# Restart review\n\nOriginal text.\n");
  let running: RunningApp | undefined;

  async function start(): Promise<RunningApp> {
    const application = createApp({ homeDir, staticDirPath: projectDir });
    const server = createServer(application.app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    return {
      application,
      server,
      origin: `http://127.0.0.1:${address.port}`,
    };
  }

  async function stop(application: RunningApp): Promise<void> {
    application.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      application.server.close((error) => (error ? reject(error) : resolve()));
    });
    (application.application as { close?: () => void }).close?.();
  }

  async function post(route: string, body: Record<string, unknown>) {
    if (!running) throw new Error("HTTP application is not running");
    return fetch(`${running.origin}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3_000),
    });
  }

  async function catchUp() {
    const response = await post("/api/review-events/watch", {
      projectPath: projectDir,
      path: "draft.md",
      fromNow: false,
      afterSequence: 0,
      timeoutSeconds: 0,
    });
    expect(response.status).toBe(200);
    return response.json();
  }

  try {
    running = await start();
    const completion = await post("/api/review-events", {
      projectPath: projectDir,
      path: "draft.md",
      overallComment: "Restart handoff.",
    });
    expect(completion.status).toBe(201);

    const beforeRestart = await catchUp();
    expect(beforeRestart.events).toHaveLength(1);
    expect(beforeRestart.events[0]).toMatchObject({
      type: "review.completed",
      sequence: 1,
      documentPath,
      relativePath: "draft.md",
      overallComment: "Restart handoff.",
      summary: { comments: 1, replies: 0, suggestions: 0, unresolved: 1 },
    });

    await stop(running);
    running = undefined;
    running = await start();

    expect(fs.readFileSync(documentPath, "utf8")).toContain("Restart handoff.");
    const afterRestart = await catchUp();
    expect(afterRestart.events).toHaveLength(1);
    expect(afterRestart.timedOut).toBe(false);
    expect(afterRestart.events[0].overallComment).toBeUndefined();
    expect(afterRestart.events[0]).toMatchObject({
      type: "review.completed",
      sequence: 1,
      documentPath,
      relativePath: "draft.md",
      summary: { comments: 1, replies: 0, suggestions: 0, unresolved: 1 },
    });
  } finally {
    if (running) await stop(running);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
