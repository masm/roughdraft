import { joinPath } from "./app-navigation";
import {
  parseReviewContext,
  sameRequestedReview,
  type ReviewBinding,
} from "./review-context";
import {
  type BackendInfo,
  type CompleteReviewOptions,
  type CompleteReviewResult,
  type MarkdownFileChangeEvent,
  MarkdownFileConflictError,
  type Page,
  type ReviewWatchStatus,
  type StorageBackend,
  type StoredAsset,
} from "./storage";

export class ApiBackend implements StorageBackend {
  info: BackendInfo;
  canManageProjects = true;

  constructor(info: BackendInfo) {
    this.info = info;
  }

  private updateProjectInfo(projectPath?: string): void {
    this.info = {
      ...this.info,
      detail: projectPath || "Markdown file on disk",
      projectPath,
    };
  }

  private buildUrl(route: string, params?: Record<string, string>): string {
    const url = new URL(route, window.location.origin);
    const projectPath = this.info.projectPath?.trim();

    if (projectPath) {
      url.searchParams.set("projectPath", projectPath);
    }

    Object.entries(params ?? {}).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    return `${url.pathname}${url.search}`;
  }

  async getMarkdownFile(relativePath: string): Promise<Page> {
    const res = await fetch(
      this.buildUrl("/api/markdown-file", {
        path: relativePath,
      }),
    );
    if (!res.ok) {
      throw new Error(
        `Failed to get markdown file ${relativePath}: ${res.status}`,
      );
    }
    return res.json();
  }

  async saveMarkdownFile(
    relativePath: string,
    content: string,
    expectedVersion?: string,
    reviewBinding?: ReviewBinding,
  ): Promise<Page> {
    const res = await fetch(
      this.buildUrl("/api/markdown-file", { path: relativePath }),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          expectedVersion,
          projectPath: this.info.projectPath,
          ...(reviewBinding
            ? {
                journalId: reviewBinding.journalId,
                reviewContext: reviewBinding.reviewContext,
              }
            : {}),
        }),
      },
    );
    if (res.status === 409) {
      const payload = (await res.json()) as { current?: Page };
      if (payload.current) {
        throw new MarkdownFileConflictError(payload.current);
      }
    }
    if (!res.ok) {
      throw new Error(
        `Failed to save markdown file ${relativePath}: ${res.status}`,
      );
    }
    return res.json();
  }

  watchMarkdownFile(
    relativePath: string,
    onChange: (event: MarkdownFileChangeEvent) => void,
  ): () => void {
    const source = new EventSource(
      this.buildUrl("/api/markdown-file/events", { path: relativePath }),
    );

    source.addEventListener("open", () => {
      onChange({ path: relativePath, exists: true, version: null });
    });
    source.addEventListener("change", (event) => {
      try {
        onChange(JSON.parse((event as MessageEvent<string>).data));
      } catch (error) {
        console.error("Failed to read markdown file change event:", error);
      }
    });

    source.onerror = (error) => {
      console.error("Markdown file event stream failed:", error);
    };

    return () => {
      source.close();
    };
  }

  async completeReview(
    relativePath: string,
    options: CompleteReviewOptions = {},
  ): Promise<CompleteReviewResult> {
    const overallComment = options.overallComment?.trim();
    const res = await fetch(
      this.buildUrl("/api/review-events", { path: relativePath }),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: this.info.projectPath,
          path: relativePath,
          ...(overallComment ? { overallComment } : {}),
          ...(options.expectedVersion !== undefined
            ? { expectedVersion: options.expectedVersion }
            : {}),
          ...(options.reviewBinding
            ? {
                journalId: options.reviewBinding.journalId,
                reviewContext: options.reviewBinding.reviewContext,
              }
            : {}),
        }),
      },
    );

    if (!res.ok) {
      throw new Error(
        `Failed to complete review ${relativePath}: ${res.status}`,
      );
    }

    const payload = (await res.json()) as {
      delivered?: unknown;
      event?: { type?: string; eventId?: string };
    };
    return {
      delivered: payload.delivered === true,
      ...(payload.event?.type === "review.completed" &&
      typeof payload.event.eventId === "string"
        ? { recorded: true }
        : {}),
    };
  }

  async getReviewReceipt(
    _relativePath: string,
    binding: ReviewBinding,
  ): Promise<CompleteReviewResult | null> {
    const response = await fetch("/api/review-events/watch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        journalId: binding.journalId,
        reviewId: binding.reviewContext.reviewId,
        afterSequence: 0,
        fromNow: false,
        timeoutSeconds: 0,
        batchWindowSeconds: 0,
      }),
    });
    if (!response.ok)
      throw new Error(
        `The review receipt could not be recovered: ${response.status}`,
      );
    const payload = await response.json();
    if (!Array.isArray(payload.events))
      throw new Error("The review receipt response is invalid.");
    if (payload.events.length === 0) return null;
    const event = payload.events[0];
    if (
      payload.events.length !== 1 ||
      event.type !== "review.completed" ||
      typeof event.eventId !== "string" ||
      event.journalId !== binding.journalId ||
      event.reviewId !== binding.reviewContext.reviewId ||
      !sameRequestedReview(binding, {
        journalId: event.journalId,
        reviewContext: parseReviewContext(event.reviewContext),
      })
    )
      throw new Error("The recovered receipt belongs to another review.");
    return { recorded: true, delivered: false };
  }

  async getReviewContext(
    relativePath: string,
    journalId?: string,
  ): Promise<ReviewBinding | null> {
    if (!journalId) {
      const status = await fetch("/api/status");
      if (!status.ok)
        throw new Error(`Review state is unavailable: ${status.status}`);
      const payload = await status.json();
      journalId = payload.reviewEvents?.journalId;
      if (typeof journalId !== "string")
        throw new Error(
          "This server does not support durable review contexts.",
        );
    }
    const path = /^(?:\/|[A-Za-z]:[\\/])/.test(relativePath)
      ? relativePath
      : joinPath(this.info.projectPath ?? "", relativePath);
    const response = await fetch(
      this.buildUrl("/api/open-request", { path, journalId }),
    );
    if (!response.ok)
      throw new Error(
        `Could not validate the opening context: ${response.status}`,
      );
    const payload = await response.json();
    const context = payload.context;
    if (!context || context.status === "retired") return null;
    if (
      (context.status !== "opening" &&
        context.status !== "loaded" &&
        context.status !== "completed") ||
      typeof context.documentPath !== "string"
    )
      throw new Error("The accepted review context is invalid.");
    return {
      journalId,
      reviewContext: parseReviewContext(context),
      documentPath: context.documentPath,
      status: context.status,
    };
  }

  async acknowledgeReviewContext(
    relativePath: string,
    version: string,
    binding?: ReviewBinding | null,
    loadRequestId?: string,
  ): Promise<void> {
    if (!binding && !loadRequestId) return;
    const response = await fetch("/api/open-request/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path:
          binding?.documentPath ??
          joinPath(this.info.projectPath ?? "", relativePath),
        version,
        ...(binding
          ? {
              journalId: binding.journalId,
              reviewContext: binding.reviewContext,
            }
          : {}),
        ...(loadRequestId ? { loadRequestId } : {}),
      }),
    });
    if (!response.ok)
      throw new Error(
        `The document load could not be acknowledged: ${response.status}`,
      );
  }

  async reportOpenFailure(
    relativePath: string,
    loadRequestId: string,
    error: string,
  ): Promise<void> {
    const response = await fetch("/api/open-request/failure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: joinPath(this.info.projectPath ?? "", relativePath),
        loadRequestId,
        error,
      }),
    });
    if (!response.ok)
      throw new Error(
        `The opening failure could not be reported: ${response.status}`,
      );
  }

  async getReviewWatchStatus(relativePath: string): Promise<ReviewWatchStatus> {
    const res = await fetch(
      this.buildUrl("/api/review-events/status", { path: relativePath }),
    );

    if (!res.ok) {
      throw new Error(
        `Failed to get review watch status ${relativePath}: ${res.status}`,
      );
    }

    const payload = (await res.json()) as {
      watching?: unknown;
      watcherCount?: unknown;
    };
    return {
      watching: payload.watching === true,
      watcherCount:
        typeof payload.watcherCount === "number" ? payload.watcherCount : 0,
    };
  }

  async saveAsset(file: File): Promise<StoredAsset> {
    const buffer = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      if (byte === undefined) continue;
      binary += String.fromCharCode(byte);
    }

    const res = await fetch(this.buildUrl("/api/assets"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        dataBase64: btoa(binary),
        projectPath: this.info.projectPath,
      }),
    });

    if (!res.ok) throw new Error(`Failed to save asset: ${res.status}`);
    return res.json();
  }

  resolveFileUrl(path: string): string | null {
    const normalized = path.replace(/^\.?\//, "");
    return this.buildUrl("/api/files", { path: normalized });
  }

  async openProject(path: string): Promise<void> {
    this.updateProjectInfo(path);
  }
}
