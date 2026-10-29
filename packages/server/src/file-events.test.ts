import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createApp } from "./index";

it("reports an unreadable watched file and recovers without terminating the API", async () => {
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), "roughdraft-unreadable-watch-"),
  );
  const file = path.join(scratch, "draft.md");
  fs.writeFileSync(file, "# Preserved draft\n");
  const application = createApp({
    homeDir: scratch,
    reviewStateDir: path.join(scratch, "state"),
    staticDirPath: scratch,
  });
  const server = createServer(application.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(
      `${origin}/api/markdown-file/events?${new URLSearchParams({ projectPath: scratch, path: "draft.md" })}`,
      { signal: controller.signal },
    );
    expect(response.status).toBe(200);
    reader = response.body?.getReader();
    if (!reader) throw new Error("The real file-event stream is missing");
    // Consume the initial retry frame, proving the stream is open first.
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "retry:",
    );
    const streamReader = reader;
    const nextChange = async () => {
      let text = "";
      const deadline = setTimeout(() => controller.abort(), 2_500);
      try {
        while (true) {
          const chunk = await streamReader.read();
          if (chunk.done)
            throw new Error("File-event stream unexpectedly ended");
          text += new TextDecoder().decode(chunk.value);
          const payload = text.match(/event: change\ndata: ([^\n]+)/)?.[1];
          if (payload) return JSON.parse(payload);
        }
      } finally {
        clearTimeout(deadline);
      }
    };
    fs.chmodSync(file, 0o000);
    expect(() => fs.readFileSync(file)).toThrow();
    expect(await nextChange()).toMatchObject({
      path: "draft.md",
      exists: false,
      version: null,
    });
    expect((await fetch(`${origin}/api/status`)).status).toBe(200);
    fs.chmodSync(file, 0o640);
    expect(await nextChange()).toMatchObject({
      path: "draft.md",
      exists: true,
    });
    expect(fs.readFileSync(file, "utf8")).toBe("# Preserved draft\n");
  } finally {
    fs.chmodSync(file, 0o640);
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    application.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
