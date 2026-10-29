import { expect, it } from "vitest";
import {
  getReviewHandoffButtonLabel,
  isReviewHandoffDisabled,
} from "../src/DocumentWorkspace";
it("labels a durable receipt as saved even while its agent is disconnected", () => {
  expect(
    getReviewHandoffButtonLabel({
      reviewHandoffState: "recorded",
      documentChangedSinceOpen: true,
    }),
  ).toBe("Saved");
});
it("allows retrying a failed receipt handoff once file saving is healthy", () => {
  expect(
    isReviewHandoffDisabled({
      saveState: "saved",
      documentDiskChangeState: "clean",
      reviewHandoffState: "error",
    }),
  ).toBe(false);
});
