// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./clipboard";

describe("copyToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("uses navigator.clipboard in a secure context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("isSecureContext", true);

    const ok = await copyToClipboard("hello");

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand in a non-secure context (no clipboard API)", async () => {
    // Simulate plain HTTP on a non-localhost host: clipboard API is undefined.
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("isSecureContext", false);
    const execCommand = vi.fn().mockReturnValue(true);
    // jsdom does not implement execCommand; install a stub.
    (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;

    const ok = await copyToClipboard("fallback-text");

    expect(ok).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("returns false when both paths fail", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("isSecureContext", true);
    const execCommand = vi.fn().mockReturnValue(false);
    (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;

    const ok = await copyToClipboard("nope");

    expect(ok).toBe(false);
  });
});
