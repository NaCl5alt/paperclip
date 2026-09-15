// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TimeoutError } from "@/api/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const getHealth = vi.fn();

vi.mock("@/lib/router", () => ({
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
  Outlet: () => <div data-testid="outlet">OUTLET</div>,
  useLocation: () => ({ pathname: "/tasks", search: "" }),
}));
vi.mock("@/api/health", () => ({ healthApi: { get: () => getHealth() } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: vi.fn() } }));
vi.mock("@/api/access", () => ({
  accessApi: { getCurrentBoardAccess: vi.fn(), claimBootstrapAdmin: vi.fn() },
}));

import { CloudAccessGate } from "./CloudAccessGate";

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function settle() {
  // Let react-query's queryFn promise + re-render flush (needs macrotasks, not
  // just microtasks, for the query state machine to advance).
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("CloudAccessGate timeout/retry", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    getHealth.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    container.remove();
    document.body.innerHTML = "";
  });

  function renderGate(children?: ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    return act(async () => {
      root!.render(
        <QueryClientProvider client={client}>
          <CloudAccessGate />
          {children}
        </QueryClientProvider>,
      );
    });
  }

  it("shows a timeout message + retry, then recovers when retry succeeds", async () => {
    // First load times out; the retry succeeds with a trusted-local health.
    getHealth.mockRejectedValueOnce(new TimeoutError(30_000));
    getHealth.mockResolvedValueOnce({ deploymentMode: "local_trusted", bootstrapStatus: "ready" });

    await renderGate();
    await settle();

    expect(container.textContent).toContain("読み込みがタイムアウトしました");
    const retryButton = container.querySelector("button");
    expect(retryButton).not.toBeNull();
    expect(retryButton?.textContent).toContain("再試行");

    await act(async () => {
      retryButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();

    // Recovered: local_trusted mode short-circuits auth and renders the app.
    expect(container.querySelector('[data-testid="outlet"]')).not.toBeNull();
    expect(container.textContent).not.toContain("タイムアウト");
    expect(getHealth).toHaveBeenCalledTimes(2);
  });

  it("shows a generic (non-timeout) message for a plain load failure", async () => {
    getHealth.mockRejectedValueOnce(new Error("boom"));
    await renderGate();
    await settle();
    expect(container.textContent).toContain("アプリの読み込みに失敗しました");
    expect(container.textContent).not.toContain("タイムアウト");
  });
});
