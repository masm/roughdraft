import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import request from "supertest";
import { expect, it } from "vitest";
import { createApp } from "./index";

const loader = fileURLToPath(
  new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url),
);
const storeUrl = pathToFileURL(
  fileURLToPath(new URL("./review-store.ts", import.meta.url)),
).href;

function child(script: string, cwd: string) {
  const process = spawn(
    globalThis.process.execPath,
    ["--import", loader, "--input-type=module", "-e", script],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );
  let errors = "";
  process.stderr?.on("data", (chunk) => {
    errors += String(chunk);
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const firstLine = new Promise<Record<string, string>>((resolve, reject) => {
    const stdout = process.stdout;
    if (!stdout) {
      reject(new Error("Child stdout was not piped"));
      return;
    }
    const lines = createInterface({ input: stdout });
    const timer = setTimeout(() => {
      lines.close();
      reject(new Error(`Child produced no receipt: ${errors}`));
    }, 5_000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      lines.close();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
    exited.then(({ code }) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`Child exited ${code}: ${errors}`));
      }
    }, reject);
  });
  return { process, exited, firstLine };
}

async function reap(process: ChildProcess) {
  if (process.exitCode === null && process.signalCode === null) {
    process.kill("SIGKILL");
    await new Promise<void>((resolve) => process.once("exit", () => resolve()));
  }
}

it("refuses a writer in another process and releases admission after that process dies", async () => {
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), "roughdraft-writer-process-"),
  );
  const directory = path.join(scratch, "journal");
  const live = child(
    `import { ReviewStore } from ${JSON.stringify(storeUrl)}; const store = new ReviewStore(${JSON.stringify(directory)}); console.log(JSON.stringify(store.snapshot())); setInterval(() => {}, 1000);`,
    scratch,
  );
  let refused: ReturnType<typeof createApp> | undefined;
  let reopened: ReturnType<typeof createApp> | undefined;
  try {
    const metadata = await live.firstLine;
    expect(typeof metadata.journalId).toBe("string");
    refused = createApp({ homeDir: scratch, reviewStateDir: directory });
    const rejection = await request(refused.app).get("/api/status");
    expect(rejection.status).toBe(503);
    expect(rejection.body.code).toBe("writer_busy");
    live.process.kill("SIGKILL");
    expect((await live.exited).signal).toBe("SIGKILL");
    reopened = createApp({ homeDir: scratch, reviewStateDir: directory });
    const recovered = await request(reopened.app).get("/api/status");
    expect(recovered.status).toBe(200);
    expect(recovered.body.reviewEvents.journalId).toBe(metadata.journalId);
    expect(recovered.body.reviewEvents.startId).not.toBe(metadata.startId);
    expect(recovered.body.reviewEvents.latestSequence).toBe(0);
  } finally {
    refused?.close();
    reopened?.close();
    await reap(live.process);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}, 10_000);

it("recovers the write-to-receipt crash gap after an actual process kill", async () => {
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), "roughdraft-intent-process-"),
  );
  const directory = path.join(scratch, "journal");
  const documentPath = path.join(scratch, "draft.md");
  const before = "# Crash recovery\n";
  const after =
    '# Crash recovery\n\n{>>Crash handoff.<<}{id="c1" by="user" at="2026-10-29T08:00:00.000Z"}\n';
  fs.writeFileSync(documentPath, before);
  const context = {
    storeId: "process-control-store",
    generation: 1,
    reviewId: "process-round",
    operationId: "process-open",
  };
  const killed = child(
    `import fs from "node:fs"; import { ReviewStore } from ${JSON.stringify(storeUrl)}; const store = new ReviewStore(${JSON.stringify(directory)}); const context = ${JSON.stringify(context)}; store.prepare(${JSON.stringify(documentPath)}, ${JSON.stringify(scratch)}, "draft.md", context); store.acknowledge(${JSON.stringify(documentPath)}, context, "injected-saved-version"); store.prepareCompletion({documentPath:${JSON.stringify(documentPath)}, projectPath:${JSON.stringify(scratch)}, relativePath:"draft.md",version:"injected-saved-version",summary:{comments:1,replies:0,suggestions:0,unresolved:1},overallComment:"Crash handoff."},${JSON.stringify(before)},${JSON.stringify(after)},"injected-saved-version",context); const fd=fs.openSync(${JSON.stringify(documentPath)},"w");fs.writeFileSync(fd,${JSON.stringify(after)});fs.fsyncSync(fd);fs.closeSync(fd); console.log(JSON.stringify(store.snapshot())); process.kill(process.pid,"SIGKILL");`,
    scratch,
  );
  let recovered: ReturnType<typeof createApp> | undefined;
  try {
    const metadata = await killed.firstLine;
    expect((await killed.exited).signal).toBe("SIGKILL");
    expect(fs.readFileSync(documentPath, "utf8")).toBe(after);
    recovered = createApp({ homeDir: scratch, reviewStateDir: directory });
    const receipt = await request(recovered.app)
      .post("/api/review-events/watch")
      .send({
        journalId: metadata.journalId,
        reviewId: "process-round",
        fromNow: false,
        afterSequence: 0,
        timeoutSeconds: 0,
      });
    expect(receipt.status).toBe(200);
    expect(receipt.body.events).toHaveLength(1);
    expect(receipt.body.events[0]).toMatchObject({
      reviewId: "process-round",
      sequence: 1,
      summary: { comments: 1, replies: 0, suggestions: 0, unresolved: 1 },
    });
    expect(receipt.body.events[0].overallComment).toBeUndefined();
    expect(fs.readFileSync(documentPath, "utf8")).toBe(after);
    expect(receipt.body.latestSequence).toBe(1);
  } finally {
    recovered?.close();
    await reap(killed.process);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}, 10_000);
