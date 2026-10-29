export interface ReviewContext {
  storeId: string;
  generation: number;
  reviewId: string;
  operationId: string;
}
export interface RequestedReview {
  journalId: string;
  reviewContext: ReviewContext;
}
export interface ReviewBinding extends RequestedReview {
  documentPath: string;
  status: "opening" | "loaded" | "completed";
}
function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(value)
  );
}
export function parseReviewContext(value: unknown): ReviewContext {
  if (!value || typeof value !== "object")
    throw new Error("Invalid review context.");
  const context = value as Partial<ReviewContext>;
  if (
    !identifier(context.storeId) ||
    !identifier(context.reviewId) ||
    !identifier(context.operationId) ||
    !Number.isSafeInteger(context.generation) ||
    Number(context.generation) < 1
  )
    throw new Error("Invalid review context.");
  return {
    storeId: context.storeId,
    generation: Number(context.generation),
    reviewId: context.reviewId,
    operationId: context.operationId,
  };
}
export function sameRequestedReview(
  left: RequestedReview | null,
  right: RequestedReview | null,
): boolean {
  if (!left || !right) return left === right;
  const a = left.reviewContext,
    b = right.reviewContext;
  return (
    left.journalId === right.journalId &&
    a.storeId === b.storeId &&
    a.generation === b.generation &&
    a.reviewId === b.reviewId &&
    a.operationId === b.operationId
  );
}
export function requestedReviewFromUrl(url: URL): RequestedReview | undefined {
  const journalId = url.searchParams.get("journalId");
  const raw = url.searchParams.get("reviewContext");
  if (journalId === null && raw === null) return undefined;
  if (!identifier(journalId) || !raw)
    throw new Error("The review URL has incomplete context.");
  return { journalId, reviewContext: parseReviewContext(JSON.parse(raw)) };
}
