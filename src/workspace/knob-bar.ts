import { h } from "../dom.ts"
import type { Control } from "./compiler.ts"

type Dimension = { name: string; kind: "scale"; low: string; high: string } | { name: string; kind: "choice"; options: string[] }

export type Setting = { position: number; strength: number }

const STRENGTHS: [label: string, strength: number][] = [
  ["off", 0],
  ["slight", 0.2],
  ["moderate", 0.5],
  ["strong", 0.9],
]

/**
 * A row of code knobs, one per declared dimension: a scale is a slider between its poles, a choice a set of options, and each has a strength
 * that is off until set. `onChange` fires on every adjustment; the caller decides when to recompile.
 */
export function createKnobBar(container: HTMLElement, onChange: () => void) {
  let dimensions: Dimension[] = []
  const settings = new Map<string, Setting>()
  return { show, controls, settings: () => Object.fromEntries(settings), restore }

  function show(next: unknown[]) {
    dimensions = next as Dimension[]
    container.replaceChildren(...dimensions.map(knobOf))
  }

  function restore(saved: Record<string, Setting>) {
    for (const [name, setting] of Object.entries(saved)) settings.set(name, setting)
  }

  /** The knobs set to a strength above off, as controls for the compiler. */
  function controls(): Control[] {
    return dimensions.flatMap((dimension) => {
      const setting = settings.get(dimension.name)
      return setting && setting.strength > 0 ? [{ dimension, ...setting }] : []
    })
  }

  function knobOf(dimension: Dimension) {
    const setting = settings.get(dimension.name) ?? { position: 0.5, strength: 0 }
    const update = (next: Partial<Setting>) => {
      settings.set(dimension.name, { ...(settings.get(dimension.name) ?? setting), ...next })
      element.toggleAttribute("data-on", (settings.get(dimension.name)?.strength ?? 0) > 0)
      onChange()
    }
    const value =
      dimension.kind === "scale"
        ? h(
            "label",
            { class: "scale" },
            h("small", {}, dimension.low),
            h("input", {
              type: "range",
              min: 0,
              max: 1,
              step: 0.05,
              value: setting.position,
              "aria-label": `${dimension.name}: ${dimension.low} to ${dimension.high}`,
              oninput: (event: Event) => update({ position: Number((event.target as HTMLInputElement).value) }),
            }),
            h("small", {}, dimension.high),
          )
        : h(
            "span",
            { class: "choice", role: "radiogroup", "aria-label": dimension.name },
            ...dimension.options.map((option, i) =>
              h(
                "button",
                {
                  type: "button",
                  role: "radio",
                  "aria-checked": String(Math.min(dimension.options.length - 1, Math.floor(setting.position * dimension.options.length)) === i),
                  onclick: (event: MouseEvent) => {
                    for (const sibling of (event.currentTarget as HTMLElement).parentElement!.children) sibling.setAttribute("aria-checked", "false")
                    ;(event.currentTarget as HTMLElement).setAttribute("aria-checked", "true")
                    update({ position: (i + 0.5) / dimension.options.length })
                  },
                },
                option,
              ),
            ),
          )
    const strength = h(
      "select",
      { "aria-label": `${dimension.name} strength`, onchange: (event: Event) => update({ strength: Number((event.target as HTMLSelectElement).value) }) },
      ...STRENGTHS.map(([label, value]) => h("option", { value, selected: Math.abs(value - setting.strength) < 0.01 }, label)),
    )
    const element = h("div", { class: "knob-row", "data-on": setting.strength > 0 }, h("b", {}, dimension.name), value, strength)
    return element
  }
}
