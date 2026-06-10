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
 * @returns `true` if the copy succeeded, `false` otherwise. Never throws.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the execCommand fallback below.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    // Keep it off-screen and unobtrusive while still selectable.
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    textarea.setAttribute("readonly", "");
    document.body.appendChild(textarea);
    try {
      textarea.select();
      return document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
  } catch {
    return false;
  }
}
