/**
 * Copy text to the clipboard, with a fallback for non-secure contexts.
 *
 * `navigator.clipboard` is only defined in secure contexts (HTTPS or
 * localhost). When Paperclip is served over plain HTTP on a non-localhost host
 * (e.g. a LAN / tailnet IP), `navigator.clipboard` is `undefined`, so calling
 * `navigator.clipboard.writeText(...)` throws a TypeError and the copy action
 * silently no-ops. In that case we fall back to a hidden `<textarea>` plus the
 * deprecated-but-widely-supported `document.execCommand("copy")`.
 *
 * Throws when every path fails. Callers that prefer a boolean result should use
 * {@link copyToClipboard}.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for environments where the Clipboard API exists but is blocked.
    }
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard unavailable");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);

  try {
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const success = document.execCommand("copy");
    if (!success) throw new Error("execCommand copy failed");
  } finally {
    document.body.removeChild(textarea);
  }
}

/**
 * Non-throwing variant of {@link copyTextToClipboard}.
 *
 * @returns `true` if the copy succeeded, `false` otherwise. Never throws.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await copyTextToClipboard(text);
    return true;
  } catch {
    return false;
  }
}
