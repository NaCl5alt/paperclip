import { describe, expect, it } from "vitest";
import { buildGeminiInvocationArgs, isAgyCommand } from "./args.js";

const DEFAULT_MODEL = "gemini-2.5-pro";
const base = {
  model: DEFAULT_MODEL,
  defaultModel: DEFAULT_MODEL,
  sandbox: false,
  extraArgs: [] as string[],
  prompt: "hello world",
};

describe("isAgyCommand", () => {
  it("matches agy and antigravity by basename, with or without path/extension", () => {
    expect(isAgyCommand("agy")).toBe(true);
    expect(isAgyCommand("/Users/x/.local/bin/agy")).toBe(true);
    expect(isAgyCommand("antigravity")).toBe(true);
    expect(isAgyCommand("AGY.exe")).toBe(true);
    expect(isAgyCommand("  agy  ")).toBe(true);
  });

  it("does not match the stock gemini CLI", () => {
    expect(isAgyCommand("gemini")).toBe(false);
    expect(isAgyCommand("/usr/local/bin/gemini")).toBe(false);
    expect(isAgyCommand("agymnasium")).toBe(false);
  });
});

describe("buildGeminiInvocationArgs (gemini dialect)", () => {
  it("emits stream-json, approval-mode yolo, and sandbox=none", () => {
    const args = buildGeminiInvocationArgs({ ...base, isAgy: false, resumeSessionId: null });
    expect(args).toEqual([
      "--output-format",
      "stream-json",
      "--approval-mode",
      "yolo",
      "--sandbox=none",
      "--prompt",
      "hello world",
    ]);
  });

  it("passes --resume <id> when resuming", () => {
    const args = buildGeminiInvocationArgs({ ...base, isAgy: false, resumeSessionId: "sess-1" });
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-1");
  });
});

describe("buildGeminiInvocationArgs (agy dialect)", () => {
  it("omits gemini-only flags and uses agy equivalents", () => {
    const args = buildGeminiInvocationArgs({ ...base, isAgy: true, resumeSessionId: null });
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--print-timeout",
      "30m",
      "--prompt",
      "hello world",
    ]);
    expect(args).not.toContain("--output-format");
    expect(args).not.toContain("--approval-mode");
    expect(args).not.toContain("--sandbox=none");
  });

  it("uses timeoutSec to format --print-timeout", () => {
    const args = buildGeminiInvocationArgs({ ...base, isAgy: true, resumeSessionId: null, timeoutSec: 120 });
    expect(args).toContain("--print-timeout");
    expect(args[args.indexOf("--print-timeout") + 1]).toBe("120s");
  });

  it("does not override --print-timeout if specified in extraArgs", () => {
    const args = buildGeminiInvocationArgs({
      ...base,
      isAgy: true,
      resumeSessionId: null,
      extraArgs: ["--print-timeout", "60m"],
    });
    expect(args.filter(x => x === "--print-timeout").length).toBe(1);
    expect(args[args.indexOf("--print-timeout") + 1]).toBe("60m");
  });

  it("uses --continue (not --resume) when resuming", () => {
    const args = buildGeminiInvocationArgs({ ...base, isAgy: true, resumeSessionId: "agy:most-recent" });
    expect(args).toContain("--continue");
    expect(args).not.toContain("--resume");
  });

  it("passes a boolean --sandbox without =none", () => {
    const args = buildGeminiInvocationArgs({ ...base, isAgy: true, resumeSessionId: null, sandbox: true });
    expect(args).toContain("--sandbox");
    expect(args).not.toContain("--sandbox=none");
  });

  it("passes --model only when it differs from the default", () => {
    expect(
      buildGeminiInvocationArgs({ ...base, isAgy: true, resumeSessionId: null }),
    ).not.toContain("--model");
    const args = buildGeminiInvocationArgs({
      ...base,
      isAgy: true,
      resumeSessionId: null,
      model: "gemini-3-pro",
    });
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-3-pro");
  });

  it("appends extraArgs before the prompt", () => {
    const args = buildGeminiInvocationArgs({
      ...base,
      isAgy: true,
      resumeSessionId: null,
      extraArgs: ["--add-dir", "/repo"],
    });
    expect(args.indexOf("--add-dir")).toBeLessThan(args.indexOf("--prompt"));
  });
});
