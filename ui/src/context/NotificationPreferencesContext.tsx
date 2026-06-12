import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  getNotificationPermission,
  persistDoneNotificationsEnabled,
  readStoredDoneNotificationsEnabled,
  requestNotificationPermission,
  type DoneNotificationPermission,
} from "../lib/done-notifications";

interface NotificationPreferencesValue {
  doneNotificationsEnabled: boolean;
  /** True when the toggle is on and the browser permission allows showing notifications. */
  doneNotificationsActive: boolean;
  permission: DoneNotificationPermission;
  toggleDoneNotifications: () => Promise<void>;
}

const NotificationPreferencesContext = createContext<NotificationPreferencesValue | undefined>(undefined);

export function NotificationPreferencesProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(() => readStoredDoneNotificationsEnabled());
  const [permission, setPermission] = useState<DoneNotificationPermission>(() => getNotificationPermission());

  useEffect(() => {
    persistDoneNotificationsEnabled(enabled);
  }, [enabled]);

  useEffect(() => {
    // The user can change the site permission from browser settings at any time;
    // refresh our snapshot whenever the window regains focus.
    const refreshPermission = () => setPermission(getNotificationPermission());
    window.addEventListener("focus", refreshPermission);
    return () => window.removeEventListener("focus", refreshPermission);
  }, []);

  const toggleDoneNotifications = useCallback(async () => {
    if (enabled) {
      setEnabled(false);
      return;
    }
    const nextPermission = await requestNotificationPermission();
    setPermission(nextPermission);
    if (nextPermission === "granted") {
      setEnabled(true);
    }
  }, [enabled]);

  const value = useMemo(
    () => ({
      doneNotificationsEnabled: enabled,
      doneNotificationsActive: enabled && permission === "granted",
      permission,
      toggleDoneNotifications,
    }),
    [enabled, permission, toggleDoneNotifications],
  );

  return (
    <NotificationPreferencesContext.Provider value={value}>
      {children}
    </NotificationPreferencesContext.Provider>
  );
}

export function useNotificationPreferences() {
  const context = useContext(NotificationPreferencesContext);
  if (!context) {
    throw new Error("useNotificationPreferences must be used within NotificationPreferencesProvider");
  }
  return context;
}
