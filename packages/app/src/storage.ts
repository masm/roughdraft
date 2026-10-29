import type { ReviewBinding } from "./review-context";
export interface Page {
  id: string;
  title: string;
  content: string;
  version?: string;
}

export interface MarkdownFileChangeEvent {
  path: string;
  exists: boolean;
  version: string | null;
}

export class MarkdownFileConflictError extends Error {
  current: Page;

  constructor(current: Page) {
    super("Markdown file changed on disk");
    this.name = "MarkdownFileConflictError";
    this.current = current;
  }
}

export interface StoredAsset {
  markdownPath: string;
  previewUrl: string;
  mimeType: string;
}

export interface CompleteReviewResult {
  delivered: boolean;
  recorded?: boolean;
}

export interface CompleteReviewOptions {
  overallComment?: string;
  expectedVersion?: string;
  reviewBinding?: ReviewBinding;
}

export interface ReviewWatchStatus {
  watching: boolean;
  watcherCount: number;
}

export interface BackendInfo {
  kind: "local-files" | "local-storage" | "remote";
  label: string;
  detail: string;
  projectPath?: string;
  sessionId?: string;
  originPath?: string;
}

export interface StorageBackend {
  info: BackendInfo;
  canManageProjects: boolean;
  getMarkdownFile(relativePath: string): Promise<Page>;
  saveMarkdownFile(
    relativePath: string,
    content: string,
    expectedVersion?: string,
    reviewBinding?: ReviewBinding,
  ): Promise<Page>;
  getReviewContext?(
    relativePath: string,
    journalId?: string,
  ): Promise<ReviewBinding | null>;
  acknowledgeReviewContext?(
    relativePath: string,
    version: string,
    binding?: ReviewBinding | null,
    loadRequestId?: string,
  ): Promise<void>;
  reportOpenFailure?(
    relativePath: string,
    loadRequestId: string,
    error: string,
  ): Promise<void>;
  watchMarkdownFile?(
    relativePath: string,
    onChange: (event: MarkdownFileChangeEvent) => void,
  ): () => void;
  completeReview?(
    relativePath: string,
    options?: CompleteReviewOptions,
  ): Promise<CompleteReviewResult>;
  getReviewReceipt?(
    relativePath: string,
    binding: ReviewBinding,
  ): Promise<CompleteReviewResult | null>;
  getReviewWatchStatus?(relativePath: string): Promise<ReviewWatchStatus>;
  saveAsset(file: File): Promise<StoredAsset>;
  resolveFileUrl(path: string): string | null;
  openProject(path: string): Promise<void>;
}

export function requireSavedPage(value: unknown, content: string): Page {
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("title" in value) ||
    typeof value.title !== "string" ||
    !("content" in value) ||
    value.content !== content
  )
    throw new Error(
      "Saving did not confirm the current document. The review remains unfinished.",
    );
  return value as Page;
}
