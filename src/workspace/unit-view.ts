import { h } from "../dom.ts"
import { formsOf } from "./compiler.ts"
import type { Unit } from "./units.ts"

export type UnitActions = {
  step(unit: Unit, delta: number): void
  toggleLock(unit: Unit, name: string): void
  toggleFreeze(unit: Unit): void
  recompile(unit: Unit): void
  removePhrase(unit: Unit, phrase: string): void
}

const STATUS_LABELS: Record<Unit["status"], string> = {
  queued: "queued",
  writing: "writing",
  repairing: "repairing",
  checking: "checking",
  loading: "loading",
  ready: "loaded",
  failed: "failed",
  frozen: "frozen",
}

/** One card per paragraph: its code form by form, each lockable, with the unit's versions, status and errors. */
export function renderUnits(container: HTMLElement, units: Unit[], actions: UnitActions) {
  container.replaceChildren(...units.map((unit, index) => unitCard(unit, index, actions)))
}

function unitCard(unit: Unit, index: number, actions: UnitActions) {
  const isBusy = ["writing", "repairing", "checking", "loading"].includes(unit.status)
  const code = isBusy || !unit.loaded ? unit.draft : unit.loaded.code
  const forms = formsOf(code)
  const pending = code.slice(forms.at(-1)?.end ?? 0).trim()
  return h(
    "article",
    { class: "unit", "data-status": unit.status },
    h(
      "header",
      {},
      h("b", {}, `§${index + 1}`),
      h("span", { class: "status" }, STATUS_LABELS[unit.status]),
      h(
        "span",
        { class: "versions" },
        h("button", { type: "button", disabled: unit.current <= 0, "aria-label": "previous version", onclick: () => actions.step(unit, -1) }, "◀"),
        unit.versions.length ? `v${unit.current + 1}/${unit.versions.length}` : "v–",
        h(
          "button",
          { type: "button", disabled: unit.current >= unit.versions.length - 1, "aria-label": "next version", onclick: () => actions.step(unit, 1) },
          "▶",
        ),
      ),
      h(
        "button",
        { type: "button", "aria-pressed": String(unit.isFrozen), onclick: () => actions.toggleFreeze(unit), title: "a frozen paragraph is never recompiled" },
        "freeze",
      ),
      h("button", { type: "button", onclick: () => actions.recompile(unit), title: "compile this paragraph again" }, "↻"),
    ),
    h("p", { class: "intent" }, unit.text),
    unit.phrases.length > 0 &&
      h(
        "p",
        { class: "phrases" },
        ...unit.phrases.map((phrase) =>
          h(
            "button",
            { type: "button", class: "chip", title: "key phrase: click to remove", onclick: () => actions.removePhrase(unit, phrase) },
            `[${phrase}] ×`,
          ),
        ),
      ),
    ...forms.map((form) => {
      const isLocked = form.name !== undefined && unit.lockedNames.includes(form.name)
      return h(
        "section",
        { class: "form", "data-locked": isLocked },
        h(
          "header",
          {},
          h("span", {}, form.kind ?? "form", " ", h("b", {}, form.name ?? "")),
          form.name &&
            !isBusy &&
            h(
              "button",
              {
                type: "button",
                "aria-pressed": String(isLocked),
                onclick: () => actions.toggleLock(unit, form.name!),
                title: "a locked form is kept verbatim when this paragraph recompiles",
              },
              isLocked ? "locked" : "lock",
            ),
        ),
        h("pre", {}, form.text),
      )
    }),
    pending && h("pre", { class: "pending" }, pending),
    unit.errors.length > 0 && h("ul", { class: "errors" }, ...unit.errors.map((error) => h("li", {}, error))),
  )
}
