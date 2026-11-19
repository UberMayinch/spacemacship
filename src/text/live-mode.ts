import { KEY_STORAGE as CEREBRAS_KEY_STORAGE } from "../llm/cerebras.ts"
import { KEY_STORAGE as GEMINI_KEY_STORAGE } from "../llm/decisions.ts"

/** Each key's field in the dialog's form, by name, and where it is kept for reuse. */
const KEY_FIELDS = { cerebras: CEREBRAS_KEY_STORAGE, gemini: GEMINI_KEY_STORAGE }

/**
 * Sim plays simulated sources; flight calls the models. Sources ask `isLive` on every call, so switching takes effect at once, without a reload;
 * the URL keeps the mode for the next visit. Launching always asks for both API keys first, prefilled with the ones kept from last time;
 * the dialog's submit button returns "live".
 */
export function bindModeToggle(toggle: HTMLButtonElement, dialog: HTMLDialogElement, onSwitch: (isLive: boolean) => void) {
  const form = dialog.querySelector("form")!
  const inputOf = (name: string) => form.elements.namedItem(name) as HTMLInputElement
  let isLive = new URLSearchParams(location.search).get("live") === "true"
  show()

  toggle.addEventListener("click", () => {
    if (isLive) return switchTo(false)
    for (const [name, storageKey] of Object.entries(KEY_FIELDS)) inputOf(name).value = localStorage.getItem(storageKey) ?? ""
    dialog.showModal()
  })
  dialog.addEventListener("close", () => {
    const choice = dialog.returnValue
    dialog.returnValue = ""
    if (choice !== "live") return
    for (const [name, storageKey] of Object.entries(KEY_FIELDS)) localStorage.setItem(storageKey, inputOf(name).value.trim())
    switchTo(true)
  })

  return { isLive: () => isLive }

  function switchTo(next: boolean) {
    isLive = next
    show()
    const url = new URL(location.href)
    if (isLive) url.searchParams.set("live", "true")
    else url.searchParams.delete("live")
    history.replaceState(null, "", url)
    onSwitch(isLive)
  }

  function show() {
    toggle.setAttribute("aria-pressed", `${isLive}`)
    toggle.querySelector("b")!.textContent = isLive ? "flight" : "sim"
  }
}
