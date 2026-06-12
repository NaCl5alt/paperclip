// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __doneNotificationsTestUtils,
  getNotificationPermission,
  isNotificationSupported,
  persistDoneNotificationsEnabled,
  readStoredDoneNotificationsEnabled,
  requestNotificationPermission,
  showIssueDoneNotification,
} from "./done-notifications";

type NotificationStub = {
  title: string;
  options: NotificationOptions | undefined;
  onclick: (() => void) | null;
  close: () => void;
};

function installNotificationStub(permission: NotificationPermission) {
  const created: NotificationStub[] = [];
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = vi.fn(async () => FakeNotification.permission);
    onclick: (() => void) | null = null;
    close = vi.fn();
    constructor(public title: string, public options?: NotificationOptions) {
      created.push(this as unknown as NotificationStub);
    }
  }
  const windowStub = {
    Notification: FakeNotification,
    focus: vi.fn(),
    location: { assign: vi.fn(), pathname: "/" },
  };
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("Notification", FakeNotification);
  return { created, FakeNotification, windowStub };
}

function installLocalStorageStub() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  });
  return store;
}

beforeEach(() => {
  __doneNotificationsTestUtils.lastNotifiedAt.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("support and permission helpers", () => {
  it("reports unsupported without a window Notification global", () => {
    vi.stubGlobal("window", {});
    expect(isNotificationSupported()).toBe(false);
    expect(getNotificationPermission()).toBe("unsupported");
  });

  it("reflects the browser permission when supported", () => {
    installNotificationStub("denied");
    expect(isNotificationSupported()).toBe(true);
    expect(getNotificationPermission()).toBe("denied");
  });

  it("requests permission only while in the default state", async () => {
    const { FakeNotification } = installNotificationStub("default");
    FakeNotification.requestPermission.mockResolvedValueOnce("granted");
    await expect(requestNotificationPermission()).resolves.toBe("granted");

    FakeNotification.permission = "denied";
    await expect(requestNotificationPermission()).resolves.toBe("denied");
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });
});

describe("stored preference", () => {
  it("round-trips the enabled flag through localStorage", () => {
    installLocalStorageStub();
    expect(readStoredDoneNotificationsEnabled()).toBe(false);
    persistDoneNotificationsEnabled(true);
    expect(readStoredDoneNotificationsEnabled()).toBe(true);
    persistDoneNotificationsEnabled(false);
    expect(readStoredDoneNotificationsEnabled()).toBe(false);
  });

  it("defaults to disabled when localStorage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readStoredDoneNotificationsEnabled()).toBe(false);
    expect(() => persistDoneNotificationsEnabled(true)).not.toThrow();
  });
});

describe("showIssueDoneNotification", () => {
  it("does nothing without granted permission", () => {
    const { created } = installNotificationStub("denied");
    expect(showIssueDoneNotification({ issueId: "i1", title: "T-1 is done" })).toBe(false);
    expect(created).toHaveLength(0);
  });

  it("shows a tagged notification and navigates on click", () => {
    const { created, windowStub } = installNotificationStub("granted");
    const shown = showIssueDoneNotification({
      issueId: "i1",
      title: "T-1 is done",
      body: "Fix the thing",
      href: "/ACME/issues/T-1",
    });
    expect(shown).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]!.title).toBe("T-1 is done");
    expect(created[0]!.options?.tag).toBe("paperclip-issue-done-i1");

    created[0]!.onclick?.();
    expect(windowStub.focus).toHaveBeenCalled();
    expect(windowStub.location.assign).toHaveBeenCalledWith("/ACME/issues/T-1");
  });

  it("suppresses repeats for the same issue inside the renotify window", () => {
    const { created } = installNotificationStub("granted");
    const start = 1_000_000;
    expect(showIssueDoneNotification({ issueId: "i1", title: "T-1 is done" }, start)).toBe(true);
    expect(
      showIssueDoneNotification(
        { issueId: "i1", title: "T-1 is done" },
        start + __doneNotificationsTestUtils.RENOTIFY_SUPPRESS_MS - 1,
      ),
    ).toBe(false);
    expect(
      showIssueDoneNotification(
        { issueId: "i2", title: "T-2 is done" },
        start + 1,
      ),
    ).toBe(true);
    expect(
      showIssueDoneNotification(
        { issueId: "i1", title: "T-1 is done" },
        start + __doneNotificationsTestUtils.RENOTIFY_SUPPRESS_MS + 1,
      ),
    ).toBe(true);
    expect(created).toHaveLength(3);
  });
});
