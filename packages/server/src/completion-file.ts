import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readFileSnapshot } from "./file-version.js";
import { ReviewStateError } from "./review-store.js";

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function conflict(message: string): never {
  throw new ReviewStateError("save_conflict", message);
}

/** Replace only an overall-comment completion write; never edit the original inode. */
export function replaceCompletionFile(
  requestedPath: string,
  canonicalPath: string,
  expected: ReturnType<typeof readFileSnapshot>,
  content: string,
): void {
  const sourceFd = fs.openSync(canonicalPath, "r+");
  let temporaryPath: string | undefined;
  let temporaryIdentity: fs.Stats | undefined;
  let failure: unknown;
  try {
    const original = fs.fstatSync(sourceFd);
    if (!sameFile(original, expected.stats))
      conflict("Markdown was replaced before its completion write.");
    if (original.nlink !== 1)
      conflict(
        "Overall-comment replacement requires a document with one hard link; all linked names were left unchanged.",
      );
    const candidate = path.join(
      path.dirname(canonicalPath),
      `.${path.basename(canonicalPath)}.roughdraft-${crypto.randomUUID()}.tmp`,
    );
    const temporaryFd = fs.openSync(candidate, "wx", 0o600);
    temporaryPath = candidate;
    try {
      temporaryIdentity = fs.fstatSync(temporaryFd);
      const bytes = Buffer.from(content);
      let written = 0;
      while (written < bytes.length) {
        const count = fs.writeSync(
          temporaryFd,
          bytes,
          written,
          bytes.length - written,
          written,
        );
        if (count === 0)
          throw new Error("Markdown replacement write made no progress");
        written += count;
      }
      fs.fchmodSync(temporaryFd, original.mode & 0o7777);
      fs.fsyncSync(temporaryFd);
    } finally {
      fs.closeSync(temporaryFd);
    }

    let current: ReturnType<typeof readFileSnapshot>;
    try {
      current = readFileSnapshot(sourceFd);
      if (
        fs.realpathSync(requestedPath) !== canonicalPath ||
        !sameFile(fs.statSync(canonicalPath), original)
      )
        conflict("Markdown's path changed before replacement.");
    } catch (error) {
      if (error instanceof ReviewStateError) throw error;
      conflict("Markdown could not be validated before replacement.");
    }
    if (
      current.version !== expected.version ||
      !sameFile(current.stats, expected.stats) ||
      current.stats.mode !== expected.stats.mode ||
      current.stats.ctimeMs !== expected.stats.ctimeMs ||
      current.stats.nlink !== 1
    )
      conflict("Markdown changed before its completion replacement.");
    if (!sameFile(fs.lstatSync(candidate), temporaryIdentity))
      conflict("The completion's temporary file was replaced.");
    fs.renameSync(candidate, canonicalPath);
    const directoryFd = fs.openSync(path.dirname(canonicalPath), "r");
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      fs.closeSync(sourceFd);
    } catch (error) {
      failure ??= error;
    }
    if (temporaryPath && temporaryIdentity) {
      try {
        if (sameFile(fs.lstatSync(temporaryPath), temporaryIdentity))
          fs.unlinkSync(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          failure ??= error;
      }
    }
  }
  if (failure !== undefined) throw failure;
}
