export const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!

export const $$ = <T extends Element>(selector: string) => [...document.querySelectorAll<T>(selector)]

export const showError = (output: HTMLOutputElement, error: unknown) => (output.value = `error: ${error instanceof Error ? error.message : error}`)

export const showStopOrError = (output: HTMLOutputElement, error: unknown) =>
  error instanceof DOMException && error.name === "AbortError" ? (output.value = "stopped") : showError(output, error)

export function downloadJson(filename: string, data: unknown) {
  const link = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" })),
    download: filename,
  })

  link.click()
  URL.revokeObjectURL(link.href)
}

type Child = Node | string | false | undefined

/** Builds an element: attributes set as given (`on*` functions become listeners), children appended, strings as text. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, unknown> = {}, ...children: Child[]) {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue
    if (typeof value === "function") element.addEventListener(name.slice(2), value as EventListener)
    else element.setAttribute(name, value === true ? "" : String(value))
  }
  for (const child of children) if (child !== false && child !== undefined) element.append(child)
  return element
}
