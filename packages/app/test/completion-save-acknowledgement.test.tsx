import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { DocumentWorkspace } from "../src/DocumentWorkspace";
import { detectBackend } from "../src/detect-backend";
import type { MarkdownFileChangeEvent, Page } from "../src/storage";
import { LocalStorageBackend } from "../src/local-storage-backend";

// Keep App's real save/completion callbacks, without mounting two editor engines.
const workspace = vi.hoisted(() => ({
  props: null as ComponentProps<typeof DocumentWorkspace> | null,
}));
vi.mock("../src/DocumentWorkspace", () => ({
  DocumentWorkspace: (props: ComponentProps<typeof DocumentWorkspace>) => {
    workspace.props = props;
    return null;
  },
}));
vi.mock("../src/detect-backend", () => ({ detectBackend: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
let backend: LocalStorageBackend;
let onFileChange: (event: MarkdownFileChangeEvent) => void;
let onOpenRequest: EventListener;

function currentWorkspace() {
  if (!workspace.props) throw new Error("The document workspace did not load");
  return workspace.props;
}

beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  workspace.props = null;
  window.history.replaceState(null, "", "/?path=/scratch/draft.md&editor=code");
  localStorage.clear();
  localStorage.setItem(
    "roughdraft:pages",
    JSON.stringify({
      draft: { id: "draft", title: "Original", content: "# Original\n" },
    }),
  );
  backend = Object.assign(new LocalStorageBackend(), {
    watchMarkdownFile: (
      _path: string,
      callback: (event: MarkdownFileChangeEvent) => void,
    ) => {
      onFileChange = callback;
      return () => {};
    },
  });
  vi.mocked(detectBackend).mockResolvedValue(backend);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener(name: string, callback: EventListener) {
        if (name === "open-request") onOpenRequest = callback;
      }
      removeEventListener() {}
      close() {}
    },
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
  expect(workspace.props?.activeDocumentPath).toBe("draft.md");
  currentWorkspace().onDocumentLocalContentChange("# Saved handoff\n");
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  undefined,
  null,
])("does not complete a review after a %s save acknowledgement", async (acknowledgement) => {
  // A missing acknowledgement is an invalid backend contract, not a simulated disk error.
  const save = vi
    .spyOn(backend, "saveMarkdownFile")
    .mockResolvedValue(acknowledgement as undefined);
  const complete = vi.spyOn(backend, "completeReview");
  await act(async () => {
    await currentWorkspace()
      .onCompleteReview()
      .catch(() => undefined);
  });
  expect(save).toHaveBeenCalledWith("draft.md", "# Saved handoff\n", undefined);
  expect(complete).not.toHaveBeenCalled();
});

it("allows completion after a real LocalStorage save", async () => {
  const complete = vi.spyOn(backend, "completeReview");
  await act(async () => {
    await currentWorkspace().onCompleteReview();
  });
  const persisted = localStorage.getItem("roughdraft:pages");
  if (!persisted) throw new Error("LocalStorage did not retain the saved page");
  expect(JSON.parse(persisted).draft.content).toBe("# Saved handoff\n");
  expect(complete).toHaveBeenCalledExactlyOnceWith("draft.md", undefined);
});

it("does not apply a delayed disk fetch over newer local typing", async () => {
  let release!: (page: Page) => void;
  vi.spyOn(backend, "getMarkdownFile").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await act(async () => {
    onFileChange({ path: "draft.md", exists: true, version: "external:one" });
  });
  expect(release).toBeTypeOf("function");
  await act(async () => {
    currentWorkspace().onDocumentLocalContentChange("# Newer local typing\n");
    currentWorkspace().onDocumentDirtyStateChange(true);
    release({
      id: "draft",
      title: "External",
      content: "# External fetched before typing\n",
      version: "external:one",
    });
  });
  expect(currentWorkspace().documentPage?.content).toBe("# Original\n");
  expect(currentWorkspace().documentDiskChangeState).not.toBe("clean");
});

it("does not apply an older refresh after a later refresh response", async () => {
  const releases: ((page: Page) => void)[] = [];
  vi.spyOn(backend, "getMarkdownFile").mockImplementation(
    () =>
      new Promise((resolve) => {
        releases.push(resolve);
      }),
  );
  await act(async () => {
    onFileChange({ path: "draft.md", exists: true, version: "external:one" });
  });
  await act(async () => {
    onFileChange({ path: "draft.md", exists: true, version: "external:two" });
  });
  expect(releases).toHaveLength(2);
  await act(async () => {
    releases[1]({
      id: "draft",
      title: "Newer",
      content: "# Newer external\n",
      version: "external:two",
    });
  });
  expect(currentWorkspace().documentPage?.content).toBe("# Newer external\n");
  await act(async () => {
    releases[0]({
      id: "draft",
      title: "Older",
      content: "# Older external\n",
      version: "external:one",
    });
  });
  expect(currentWorkspace().documentPage?.content).toBe("# Newer external\n");
});

it("keeps an unavailable document unfinished even when completion is called directly", async () => {
  const complete = vi.spyOn(backend, "completeReview");
  await act(async () => {
    onFileChange({ path: "draft.md", exists: false, version: null });
  });
  expect(currentWorkspace().documentPage?.content).toBe("# Original\n");
  await act(async () => {
    await currentWorkspace()
      .onCompleteReview()
      .catch(() => undefined);
  });
  expect(complete).not.toHaveBeenCalled();
});

const oldBinding = {
  journalId: "journal-one",
  documentPath: "/scratch/draft.md",
  status: "opening" as const,
  reviewContext: {
    storeId: "store-one",
    generation: 1,
    reviewId: "round-one",
    operationId: "open-one",
  },
};
const newBinding = {
  ...oldBinding,
  reviewContext: {
    ...oldBinding.reviewContext,
    generation: 2,
    reviewId: "round-two",
    operationId: "open-two",
  },
};
function reopen(binding = oldBinding) {
  onOpenRequest(
    new MessageEvent("open-request", {
      data: JSON.stringify({
        path: "/scratch/draft.md",
        url: window.location.href,
        journalId: binding.journalId,
        reviewContext: binding.reviewContext,
        loadRequestId: "transient-load",
      }),
    }),
  );
}
it("ignores a stale scoped open before starting a document fetch", async () => {
  Object.assign(backend, {
    getReviewContext: vi.fn().mockResolvedValue(newBinding),
    acknowledgeReviewContext: vi.fn(),
  });
  const read = vi.spyOn(backend, "getMarkdownFile");
  await act(async () => {
    reopen(oldBinding);
  });
  expect(read).not.toHaveBeenCalled();
  expect(currentWorkspace().documentPage?.content).toBe("# Original\n");
});
it("does not apply a load when its accepted context changes during the file fetch", async () => {
  let accepted = oldBinding;
  let release!: (page: Page) => void;
  const ack = vi.fn();
  Object.assign(backend, {
    getReviewContext: vi.fn(async () => accepted),
    acknowledgeReviewContext: ack,
  });
  vi.spyOn(backend, "getMarkdownFile").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await act(async () => {
    reopen();
  });
  expect(release).toBeTypeOf("function");
  accepted = newBinding;
  await act(async () => {
    release({
      id: "draft",
      title: "Old load",
      content: "# Obsolete round bytes\n",
      version: "loaded-old",
    });
  });
  expect(currentWorkspace().documentPage?.content).toBe("# Original\n");
  expect(ack).not.toHaveBeenCalled();
});
it("acknowledges a loaded context and carries it with the confirmed save version into Done", async () => {
  backend.info.kind = "local-files";
  const ack = vi.fn().mockResolvedValue(undefined);
  Object.assign(backend, {
    getReviewContext: vi.fn().mockResolvedValue(oldBinding),
    acknowledgeReviewContext: ack,
  });
  vi.spyOn(backend, "getMarkdownFile").mockResolvedValue({
    id: "draft",
    title: "Scoped",
    content: "# Scoped loaded\n",
    version: "loaded-one",
  });
  await act(async () => {
    reopen();
  });
  expect(ack).toHaveBeenCalledWith(
    "draft.md",
    "loaded-one",
    oldBinding,
    "transient-load",
  );
  const save = vi.spyOn(backend, "saveMarkdownFile").mockResolvedValue({
    id: "draft",
    title: "Scoped",
    content: "# Scoped loaded\n",
    version: "saved-two",
  });
  const complete = vi.spyOn(backend, "completeReview");
  await act(async () => {
    await currentWorkspace().onCompleteReview();
  });
  expect(save).toHaveBeenCalledWith(
    "draft.md",
    "# Scoped loaded\n",
    "loaded-one",
    { ...oldBinding, status: "loaded" },
  );
  expect(complete).toHaveBeenCalledWith("draft.md", {
    expectedVersion: "saved-two",
    reviewBinding: { ...oldBinding, status: "loaded" },
  });
});

async function prepareRetryFixture() {
  backend.info.kind = "local-files";
  Object.assign(backend, {
    getReviewContext: vi.fn().mockResolvedValue(oldBinding),
    acknowledgeReviewContext: vi.fn().mockResolvedValue(undefined),
    getReviewReceipt: vi.fn().mockResolvedValue(null),
  });
  vi.spyOn(backend, "getMarkdownFile").mockResolvedValue({
    id: "draft",
    title: "Scoped",
    content: "# Retry bytes\n",
    version: "loaded-one",
  });
  await act(async () => {
    reopen();
  });
  const save = vi.spyOn(backend, "saveMarkdownFile").mockResolvedValue({
    id: "draft",
    title: "Scoped",
    content: "# Retry bytes\n",
    version: "saved-two",
  });
  const complete = vi
    .spyOn(backend, "completeReview")
    .mockRejectedValueOnce(new Error("uncertain network response"))
    .mockResolvedValue({ delivered: false });
  await act(async () => {
    await currentWorkspace()
      .onCompleteReview({ overallComment: "Original handoff" })
      .catch(() => undefined);
  });
  return { save, complete };
}
it("retries an uncertain scoped completion without saving the document a second time", async () => {
  const { save, complete } = await prepareRetryFixture();
  await act(async () => {
    await currentWorkspace().onCompleteReview({
      overallComment: "Original handoff",
    });
  });
  expect(save).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete.mock.calls[1]).toEqual(complete.mock.calls[0]);
});
it("preserves changed overall feedback instead of silently replaying a different pending handoff", async () => {
  const { save, complete } = await prepareRetryFixture();
  let error: unknown;
  await act(async () => {
    try {
      await currentWorkspace().onCompleteReview({
        overallComment: "New unsaved feedback",
      });
    } catch (e) {
      error = e;
    }
  });
  expect(error).toBeInstanceOf(Error);
  expect(save).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledTimes(1);
});
