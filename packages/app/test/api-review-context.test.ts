import { afterEach, expect, it, vi } from "vitest";
import { ApiBackend } from "../src/api-backend";
const binding = {
  journalId: "journal-one",
  documentPath: "/scratch/draft.md",
  status: "loaded" as const,
  reviewContext: {
    storeId: "store-one",
    generation: 2,
    reviewId: "round-two",
    operationId: "open-two",
  },
};
function backend() {
  return new ApiBackend({
    kind: "local-files",
    label: "Local",
    detail: "Local files",
    projectPath: "/scratch",
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("carries scoped identity and the caller's saved version in saves and completion", async () => {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      delivered: false,
      event: { type: "review.completed", eventId: "receipt-one" },
    }),
  });
  vi.stubGlobal("fetch", fetch);
  const value = backend();
  await value.saveMarkdownFile("draft.md", "# Saved\n", "saved-one", binding);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
    expectedVersion: "saved-one",
    journalId: "journal-one",
    reviewContext: binding.reviewContext,
  });
  const result = await value.completeReview("draft.md", {
    expectedVersion: "saved-two",
    reviewBinding: binding,
  });
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({
    expectedVersion: "saved-two",
    journalId: "journal-one",
    reviewContext: binding.reviewContext,
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({ delivered: false, recorded: true });
});
it("validates an accepted context and acknowledges the actual canonical loaded path/version", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        context: {
          ...binding.reviewContext,
          documentPath: binding.documentPath,
          status: "opening",
        },
      }),
    })
    .mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", fetch);
  const value = backend();
  const accepted = await value.getReviewContext("draft.md", "journal-one");
  expect(accepted).toMatchObject({ ...binding, status: "opening" });
  await value.acknowledgeReviewContext(
    "draft.md",
    "actual-loaded-version",
    accepted,
    "transient-load-one",
  );
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({
    path: "/scratch/draft.md",
    version: "actual-loaded-version",
    journalId: "journal-one",
    reviewContext: binding.reviewContext,
    loadRequestId: "transient-load-one",
  });
});
it("keeps explicit ordinary saved versions on completion without discovering a newer version", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ delivered: true }) });
  vi.stubGlobal("fetch", fetch);
  await backend().completeReview("draft.md", {
    expectedVersion: "confirmed-before-second-edit",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0][1].body).expectedVersion).toBe(
    "confirmed-before-second-edit",
  );
});
