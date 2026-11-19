/** `?safe` boots without any config: the kernel's own behaviour runs, so a broken config can always be fixed from inside the page. */
export const isSafeMode = new URLSearchParams(location.search).has("safe")

const SAVE_URL = "/__spacemacship/save"

/**
 * A page's Lisp config file. The dev server writes the file itself, so it stays the source of truth;
 * a build without the dev server keeps edits in this browser's storage instead.
 */
export function configFile({ origin, shipped }: { origin: string; shipped: string }) {
  const draftKey = `spacemacship:${origin}`
  return { origin, initial, save }

  function initial() {
    if (import.meta.env.DEV) return shipped
    try {
      return localStorage.getItem(draftKey) ?? shipped
    } catch {
      return shipped
    }
  }

  /** Resolves to where the text went. */
  async function save(text: string): Promise<string> {
    if (import.meta.env.DEV) {
      const response = await fetch(`${SAVE_URL}?file=${encodeURIComponent(origin)}`, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "X-Spacemacship": "save" },
        body: text,
      })
      if (!response.ok) throw new Error(`saving failed: ${response.status} ${await response.text()}`)
      return origin
    }
    localStorage.setItem(draftKey, text)
    return "this browser's storage"
  }
}
