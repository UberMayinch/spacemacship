import "./repl.css"
import type { EvalResult, Lisp } from "../lisp/lisp.ts"
import { show } from "../lisp/printer.ts"
import { readAll, type Site } from "../lisp/reader.ts"
import type { LispError } from "../lisp/values.ts"

const REPL_ORIGIN = "repl"
const MAX_ENTRIES = 400
const FLASH_MS = 250

type EntryKind = "input" | "value" | "out" | "warning" | "error" | "info"

type ReplPanelOptions = {
  /** The buffer's file name, as it appears in errors. */
  origin: string
  dialog: HTMLDialogElement
  toggle: HTMLButtonElement
  lisp: Lisp
  save(text: string): Promise<string>
}

/**
 * The Lisp pane: the page's config file as an editable buffer beside a REPL.
 * In the buffer, ctrl+enter evaluates the top-level form at point, ctrl+shift+enter the whole buffer, and ctrl+s saves it.
 * In the REPL, enter evaluates once the input reads as complete forms; up and down walk the history. Ctrl+g cancels a running evaluation,
 * and ctrl+` opens or closes the pane.
 */
export function createReplPanel({ origin: bufferOrigin, dialog, toggle, lisp, save }: ReplPanelOptions) {
  const buffer = dialog.querySelector<HTMLTextAreaElement>("[data-buffer]")!
  const transcript = dialog.querySelector<HTMLElement>("[data-transcript]")!
  const input = dialog.querySelector<HTMLTextAreaElement>("[data-input]")!
  const dirtyMark = dialog.querySelector<HTMLElement>("[data-dirty]")!
  const history: string[] = []
  let historyIndex = 0
  let savedText = ""
  let running: AbortController | undefined

  lisp.onLog(({ kind, text }) => print(kind, text))
  toggle.addEventListener("click", () => setOpen(!dialog.open))
  addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.key === "`") {
      event.preventDefault()
      setOpen(!dialog.open)
    }
  })
  dialog.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.key === "g") {
      event.preventDefault()
      cancel()
    }
  })
  buffer.addEventListener("input", showDirty)
  buffer.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.key === "Enter") {
      event.preventDefault()
      return event.shiftKey ? evaluateBuffer() : evaluateFormAtPoint()
    }
    if (event.ctrlKey && event.key === "s") {
      event.preventDefault()
      saveBuffer()
    }
  })
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) return submit(event)
    if (event.key === "ArrowUp" && input.selectionStart === 0) return recall(event, -1)
    if (event.key === "ArrowDown" && input.selectionEnd === input.value.length) return recall(event, 1)
  })

  return { load, reloadFromDisk, print, setOpen }

  /** Shows `text` as the buffer; evaluates it unless in safe mode, opening the pane if anything failed. */
  async function load(text: string, { isSafe }: { isSafe: boolean }) {
    buffer.value = savedText = text
    showDirty()
    if (isSafe) {
      print("info", `safe mode: ${bufferOrigin} was not evaluated, so the kernel's own sources run. Fix it here, then ctrl+shift+enter to load it.`)
      return setOpen(true)
    }
    const results = await evaluate(text, bufferOrigin, { keepGoing: true, isQuiet: true })
    const failed = results.filter(({ error }) => error).length
    print(failed ? "error" : "info", `loaded ${bufferOrigin}: ${results.length} forms${failed ? `, ${failed} failed` : ""}`)
    if (failed) setOpen(true)
  }

  /** The file changed on disk: take it and re-evaluate, unless the buffer has unsaved edits, which win. */
  async function reloadFromDisk(text: string) {
    if (text === buffer.value) return
    if (buffer.value !== savedText) return print("warning", `${bufferOrigin} changed on disk; keeping your unsaved edits here`)
    buffer.value = savedText = text
    showDirty()
    await evaluate(text, bufferOrigin, { keepGoing: true, isQuiet: true })
    print("info", `reloaded ${bufferOrigin} from disk`)
  }

  function setOpen(isOpen: boolean) {
    if (isOpen && !dialog.open) dialog.show()
    if (!isOpen && dialog.open) dialog.close()
    toggle.setAttribute("aria-pressed", `${isOpen}`)
    if (isOpen) input.focus()
  }

  async function evaluateFormAtPoint() {
    const text = buffer.value
    const start = topLevelStartBefore(text, buffer.selectionStart)
    if (start === -1) return print("warning", "no top-level form at point")
    const results = await evaluate(text, bufferOrigin, { from: start, to: start + 1 })
    const site = results[0]?.site
    if (site) flash(site)
  }

  async function evaluateBuffer() {
    const results = await evaluate(buffer.value, bufferOrigin, { keepGoing: true, isQuiet: true })
    const failed = results.filter(({ error }) => error).length
    print(failed ? "error" : "info", `evaluated ${bufferOrigin}: ${results.length} forms${failed ? `, ${failed} failed` : ""}`)
  }

  async function saveBuffer() {
    const text = buffer.value
    try {
      const where = await save(text)
      savedText = text
      showDirty()
      print("info", `saved to ${where}`)
    } catch (error) {
      print("error", (error as Error).message)
    }
  }

  function submit(event: KeyboardEvent) {
    const text = input.value
    if (!text.trim()) return event.preventDefault()
    try {
      readAll(text, REPL_ORIGIN)
    } catch (error) {
      if ((error as LispError).isIncomplete) return
    }
    event.preventDefault()
    history.push(text)
    historyIndex = history.length
    input.value = ""
    print("input", text)
    evaluate(text, REPL_ORIGIN, {})
  }

  function recall(event: KeyboardEvent, step: number) {
    const next = historyIndex + step
    if (next < 0 || next > history.length) return
    event.preventDefault()
    historyIndex = next
    input.value = history[next] ?? ""
  }

  async function evaluate(
    text: string,
    origin: string,
    { from, to, keepGoing = false, isQuiet = false }: { from?: number; to?: number; keepGoing?: boolean; isQuiet?: boolean },
  ): Promise<EvalResult[]> {
    running?.abort()
    const controller = (running = new AbortController())
    try {
      const results = await lisp.evalText(text, origin, { signal: controller.signal, keepGoing, from, to })
      for (const { value, error, warnings } of results) {
        for (const warning of warnings) report("warning", warning)
        if (error) report("error", error)
        else if (!isQuiet && value !== undefined) print("value", show(value))
      }
      return results
    } catch (error) {
      print(controller.signal.aborted ? "info" : "error", controller.signal.aborted ? "cancelled" : String(error))
      return []
    } finally {
      if (running === controller) running = undefined
    }
  }

  /** A problem in the buffer gets a link to its form instead of its location in the text. */
  function report(kind: "warning" | "error", error: LispError) {
    const isLinked = error.site?.origin === bufferOrigin
    print(kind, lisp.describeError(error, { withSite: !isLinked }), error.site)
  }

  function cancel() {
    if (!running) return
    running.abort()
  }

  function print(kind: EntryKind, text: string, site?: Site) {
    const entry = document.createElement("div")
    entry.dataset.kind = kind
    entry.textContent = text
    if (site?.origin === bufferOrigin) {
      const jump = document.createElement("button")
      jump.type = "button"
      jump.textContent = lisp.describeSite(site).where
      jump.addEventListener("click", () => flash(site, true))
      entry.append(" ", jump)
    }
    transcript.append(entry)
    while (transcript.childElementCount > MAX_ENTRIES) transcript.firstElementChild!.remove()
    transcript.scrollTop = transcript.scrollHeight
  }

  /** Selects a site's span in the buffer; briefly, unless `keep`, then puts the caret back. */
  function flash({ start, end }: Site, keep = false) {
    const caret = [buffer.selectionStart, buffer.selectionEnd] as const
    buffer.focus()
    buffer.setSelectionRange(start, end)
    if (keep) return
    setTimeout(() => buffer.setSelectionRange(...caret), FLASH_MS)
  }

  function showDirty() {
    dirtyMark.hidden = buffer.value === savedText
  }
}

/** Where the top-level form at `caret` starts: the last line at or before it that opens with a parenthesis in the first column. */
function topLevelStartBefore(text: string, caret: number) {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1
  if (text[lineStart] === "(") return lineStart
  const before = text.lastIndexOf("\n(", caret - 1)
  if (before !== -1) return before + 1
  return text.startsWith("(") ? 0 : -1
}
