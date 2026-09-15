import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __inflightGetCount, api, detachInflightGet, GET_TIMEOUT_MS, TimeoutError } from "./client";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("in-tab GET coalescing", () => {
  it("shares one underlying fetch for identical in-flight GETs", async () => {
    const d = deferred<Response>();
    fetchMock.mockReturnValue(d.promise);

    const p1 = api.get("/coalesce-a");
    const p2 = api.get("/coalesce-a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(__inflightGetCount()).toBe(1);

    d.resolve(jsonResponse({ value: 1 }));
    expect(await p1).toEqual({ value: 1 });
    expect(await p2).toEqual({ value: 1 });
    // Entry cleared once settled.
    expect(__inflightGetCount()).toBe(0);
  });

  it("issues a fresh fetch after the previous one settles", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ value: "x" }));
    await api.get("/coalesce-b");
    await api.get("/coalesce-b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce different paths", async () => {
    fetchMock.mockReturnValue(deferred<Response>().promise);
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = api.get("/path-1", { signal: c1.signal });
    const p2 = api.get("/path-2", { signal: c2.signal });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Clean up the never-settling shared entries so the module map does not leak.
    c1.abort();
    c2.abort();
    await expect(p1).rejects.toMatchObject({ name: "AbortError" });
    await expect(p2).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stops later callers joining a detached in-flight GET", async () => {
    // A GET issued under one account's session must not answer a caller that
    // runs after the account changed.
    const first = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise);
    const previousAccount = api.get("/detach-me");
    expect(__inflightGetCount()).toBe(1);

    detachInflightGet("/detach-me");
    expect(__inflightGetCount()).toBe(0);

    const second = deferred<Response>();
    fetchMock.mockReturnValueOnce(second.promise);
    const currentAccount = api.get("/detach-me");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Each caller gets its own response, not the other's.
    first.resolve(jsonResponse({ companies: ["previous"] }));
    second.resolve(jsonResponse({ companies: ["current"] }));
    expect(await previousAccount).toEqual({ companies: ["previous"] });
    expect(await currentAccount).toEqual({ companies: ["current"] });
    expect(__inflightGetCount()).toBe(0);
  });

  it("never coalesces mutations", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await Promise.all([api.post("/mutate", { a: 1 }), api.post("/mutate", { a: 1 })]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("per-caller abort semantics", () => {
  it("aborting one caller rejects only that caller, not the shared fetch", async () => {
    const d = deferred<Response>();
    let sharedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      sharedSignal = init.signal ?? undefined;
      return d.promise;
    });

    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = api.get("/abort-a", { signal: c1.signal });
    const p2 = api.get("/abort-a", { signal: c2.signal });

    c1.abort();
    await expect(p1).rejects.toMatchObject({ name: "AbortError" });
    // The shared fetch is still alive because caller 2 has not aborted.
    expect(sharedSignal?.aborted).toBe(false);

    d.resolve(jsonResponse({ value: 2 }));
    expect(await p2).toEqual({ value: 2 });
  });

  it("aborts the shared fetch once every caller has aborted", async () => {
    const d = deferred<Response>();
    let sharedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      sharedSignal = init.signal ?? undefined;
      return d.promise;
    });

    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = api.get("/abort-b", { signal: c1.signal });
    const p2 = api.get("/abort-b", { signal: c2.signal });

    c1.abort();
    c2.abort();
    await expect(p1).rejects.toMatchObject({ name: "AbortError" });
    await expect(p2).rejects.toMatchObject({ name: "AbortError" });
    expect(sharedSignal?.aborted).toBe(true);
    expect(__inflightGetCount()).toBe(0);
  });

  it("rejects immediately if the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(api.get("/already-aborted", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// A fetch that only settles when its signal aborts — like the real fetch, which
// rejects with a generic AbortError DOMException (the abort *reason* lives on the
// signal, not on the rejection).
function fetchRejectingOnAbort() {
  return (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
}

describe("GET timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a stalled GET with a TimeoutError once the timeout elapses", async () => {
    fetchMock.mockImplementation(fetchRejectingOnAbort());
    const p = api.get("/stalled");
    const settled = expect(p).rejects.toMatchObject({ name: "TimeoutError", isTimeout: true });
    await vi.advanceTimersByTimeAsync(GET_TIMEOUT_MS);
    await settled;
    await expect(p.catch((e) => e)).resolves.toBeInstanceOf(TimeoutError);
    // Entry cleared so a retry issues a fresh fetch.
    expect(__inflightGetCount()).toBe(0);
  });

  it("does not fire the timeout for a GET that resolves in time", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ value: "ok" }));
    const result = await api.get("/fast");
    expect(result).toEqual({ value: "ok" });
    // Advancing past the deadline must not abort anything after the fact.
    await vi.advanceTimersByTimeAsync(GET_TIMEOUT_MS * 2);
    expect(__inflightGetCount()).toBe(0);
  });

  it("does not time out mutations, so a slow write is never auto-aborted and resent", async () => {
    let aborted = false;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise<Response>(() => {});
    });
    const p = api.post("/write", { a: 1 });
    let settled = false;
    void p.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(GET_TIMEOUT_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no resend
    expect(aborted).toBe(false); // never auto-aborted
    expect(settled).toBe(false); // stays pending — caller decides, not a client timer
  });
});
