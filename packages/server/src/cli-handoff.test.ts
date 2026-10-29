import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createCliDependencies, runCli } from "./cli";
import { createApp } from "./index";

let scratch: string;
let file: string;
let application: ReturnType<typeof createApp>;
let server: Server;
let origin: string;
let port: number;
const context = {
  storeId: "cli-store",
  generation: 1,
  reviewId: "cli-round",
  operationId: "cli-open",
};
beforeEach(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-cli-handoff-"));
  file = path.join(scratch, "draft.md");
  fs.writeFileSync(file, "# CLI handoff\n");
  application = createApp({
    homeDir: scratch,
    reviewStateDir: path.join(scratch, "journal"),
    staticDirPath: scratch,
  });
  server = createServer(application.app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  application.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});
async function post(route: string, body: unknown) {
  return fetch(origin + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function acknowledge(url: string) {
  const parsed = new URL(url);
  const version = (
    await (
      await fetch(
        origin +
          "/api/markdown-file?" +
          new URLSearchParams({ projectPath: scratch, path: "draft.md" }),
      )
    ).json()
  ).version;
  const id = parsed.searchParams.get("openRequest");
  if (id) {
    const journalId = parsed.searchParams.get("journalId");
    const raw = parsed.searchParams.get("reviewContext");
    const response = await post("/api/open-request/ack", {
      path: file,
      version,
      loadRequestId: id,
      ...(raw ? { journalId, reviewContext: JSON.parse(raw) } : {}),
    });
    expect(response.status).toBe(200);
  }
  return { parsed, version };
}
function dependencies(
  open: (
    url: string,
  ) => "browser" | "disabled" | Promise<"browser" | "disabled">,
) {
  const logs: string[] = [],
    errors: string[] = [];
  const deps = createCliDependencies({
    cwd: scratch,
    env: {
      ...process.env,
      ROUGHDRAFT_PORT: String(port),
      ROUGHDRAFT_PUBLIC_HOST: "127.0.0.1",
      ROUGHDRAFT_STATE_DIR: path.join(scratch, "cli"),
      ROUGHDRAFT_DEV_FRONTEND_STATE_FILE: path.join(scratch, "absent-dev.json"),
      ROUGHDRAFT_HOST: "",
      ROUGHDRAFT_NO_OPEN: "0",
    },
    fetchImpl: (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      url.hostname = "127.0.0.1";
      return fetch(url, init);
    },
    openUrl: open,
    log: (s) => logs.push(s),
    error: (s) => errors.push(s),
    spawnServerProcess: () => {
      throw new Error("The isolated existing API must be reused");
    },
    resolveUpdateStatus: async () => ({
      packageName: "roughdraft",
      currentVersion: "test",
      latestVersion: "test",
      updateAvailable: false,
      updateCommand: "unused",
    }),
  });
  return { deps, logs, errors };
}
it("returns a verified ordinary load acknowledgment without claiming plugin ownership", async () => {
  const d = dependencies(async (url) => {
    await acknowledge(url);
    return "browser";
  });
  expect(await runCli(["open", file, "--no-watch", "--json"], d.deps)).toBe(0);
  const result = JSON.parse(d.logs[0]);
  expect(result).toMatchObject({ opened: true, loaded: true, path: file });
  expect(typeof result.loadRequestId).toBe("string");
  expect(d.errors).toEqual([]);
});
it("reports a bounded load timeout instead of entering the review wait", async () => {
  const d = dependencies(() => "browser");
  expect(
    await runCli(["open", file, "--open-timeout", "0.02", "--json"], d.deps),
  ).toBe(1);
  expect(d.errors.join(" ")).toMatch(/load.*(time|acknowledg)/i);
});
it("reports opener failure instead of a successful opening", async () => {
  const d = dependencies(async () => {
    throw new Error("fixture opener failed");
  });
  expect(await runCli(["open", file, "--no-watch", "--json"], d.deps)).toBe(1);
  expect(d.errors.join(" ")).toContain("fixture opener failed");
  expect(d.logs).toEqual([]);
});
it("catches completion made during opening before the CLI starts its watch", async () => {
  const d = dependencies(async (url) => {
    const { version } = await acknowledge(url);
    expect(
      (
        await post("/api/review-events", {
          projectPath: scratch,
          path: "draft.md",
          expectedVersion: version,
        })
      ).status,
    ).toBe(201);
    return "browser";
  });
  expect(
    await runCli(
      ["open", file, "--timeout", "0.05", "--batch-window", "0", "--json"],
      d.deps,
    ),
  ).toBe(0);
  expect(JSON.parse(d.logs[0]).events).toHaveLength(1);
});
it("opens an explicit review and recovers its receipt by ID after file deletion", async () => {
  const journalId = (await (await fetch(`${origin}/api/status`)).json())
    .reviewEvents.journalId;
  const d = dependencies(async (url) => {
    await acknowledge(url);
    return "browser";
  });
  expect(
    await runCli(
      [
        "open",
        file,
        "--review-context",
        JSON.stringify(context),
        "--journal-id",
        journalId,
        "--no-watch",
        "--json",
      ],
      d.deps,
    ),
  ).toBe(0);
  const version = (
    await acknowledge(d.logs.length ? JSON.parse(d.logs[0]).url : "")
  ).version;
  expect(
    (
      await post("/api/review-events", {
        projectPath: scratch,
        path: "draft.md",
        journalId,
        reviewContext: context,
        expectedVersion: version,
      })
    ).status,
  ).toBe(201);
  fs.unlinkSync(file);
  d.logs.length = 0;
  expect(
    await runCli(
      [
        "watch",
        "--review-id",
        "cli-round",
        "--journal-id",
        journalId,
        "--after-sequence",
        "0",
        "--timeout",
        "0",
        "--json",
      ],
      d.deps,
    ),
  ).toBe(0);
  expect(JSON.parse(d.logs[0]).events[0]).toMatchObject({
    reviewId: "cli-round",
    sequence: 1,
    journalId,
  });
});
it("does not report an opened window when opening is explicitly disabled", async () => {
  const d = dependencies(() => "disabled");
  expect(
    await runCli(["open", file, "--no-open", "--no-watch", "--json"], d.deps),
  ).toBe(0);
  expect(JSON.parse(d.logs[0]).opened).toBe(false);
});
