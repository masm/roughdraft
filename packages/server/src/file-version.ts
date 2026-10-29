import crypto from "node:crypto";
import fs from "node:fs";

export function fileVersionFromContent(
  stats: fs.Stats,
  content: string | Buffer,
): string {
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  return `${stats.mtimeMs}:${stats.size}:${hash}`;
}

export function readFileSnapshot(filePath: string | number): {
  content: string;
  version: string;
  stats: fs.Stats;
} {
  const fd =
    typeof filePath === "number" ? filePath : fs.openSync(filePath, "r");
  try {
    const before = fs.fstatSync(fd);
    const content = fs.readFileSync(fd, "utf8");
    const after = fs.fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      Buffer.byteLength(content) !== before.size
    )
      throw new Error("Markdown changed while its snapshot was being read");
    return {
      content,
      version: fileVersionFromContent(before, content),
      stats: before,
    };
  } finally {
    if (typeof filePath !== "number") fs.closeSync(fd);
  }
}

export function fileVersionFromFile(filePath: string): string {
  return readFileSnapshot(filePath).version;
}
