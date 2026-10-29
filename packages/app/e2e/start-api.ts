import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The browser suite must never create its durable journal in the real home.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-e2e-api-"));
process.env.ROUGHDRAFT_STATE_FILE = path.join(scratch, "server.json");
process.env.ROUGHDRAFT_STATE_DIR = scratch;
process.env.ROUGHDRAFT_BIND_HOST = "";
process.env.ROUGHDRAFT_TOKEN = "";
process.once("exit", () =>
  fs.rmSync(scratch, { recursive: true, force: true }),
);
process.once("SIGTERM", () => process.exit(0));
process.once("SIGINT", () => process.exit(0));
const { createServer } = await import("../../server/src/index");
await createServer(Number(process.env.API_PORT ?? 4317));
