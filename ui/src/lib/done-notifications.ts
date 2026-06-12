const DONE_NOTIFICATIONS_STORAGE_KEY = "paperclip.notifications.taskDone";
const RENOTIFY_SUPPRESS_MS = 60_000;

export type DoneNotificationPermission = NotificationPermission | "unsupported";

export function isNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function getNotificationPermission(): DoneNotificationPermission {
  if (!isNotificationSupported()) return "unsupported";
  return Notification.permission;
}

export function readStoredDoneNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(DONE_NOTIFICATIONS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function persistDoneNotificationsEnabled(enabled: boolean) {
  try {
    localStorage.setItem(DONE_NOTIFICATIONS_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore local storage write failures in restricted environments.
  }
}

export async function requestNotificationPermission(): Promise<DoneNotificationPermission> {
  if (!isNotificationSupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export interface DoneNotificationInput {
  issueId: string;
  title: string;
  body?: string;
  href?: string;
}

const lastNotifiedAt = new Map<string, number>();

export function showIssueDoneNotification(input: DoneNotificationInput, now = Date.now()): boolean {
  if (!isNotificationSupported() || Notification.permission !== "granted") return false;

  const last = lastNotifiedAt.get(input.issueId);
  if (last !== undefined && now - last < RENOTIFY_SUPPRESS_MS) return false;

  let notification: Notification;
  try {
    notification = new Notification(input.title, {
      body: input.body,
      tag: `paperclip-issue-done-${input.issueId}`,
      icon: "/android-chrome-192x192.png",
    });
  } catch {
    // Some platforms reject page-scoped notification construction.
    return false;
  }

  lastNotifiedAt.set(input.issueId, now);

  if (input.href) {
    const href = input.href;
    notification.onclick = () => {
      window.focus();
      window.location.assign(href);
      notification.close();
    };
  }
  return true;
}

export const __doneNotificationsTestUtils = {
  lastNotifiedAt,
  RENOTIFY_SUPPRESS_MS,
  DONE_NOTIFICATIONS_STORAGE_KEY,
};
