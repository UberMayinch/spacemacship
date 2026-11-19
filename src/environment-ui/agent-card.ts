import { h } from "../dom.ts"
import type { Command } from "../environment/environment.ts"
import type { Resident } from "../environment/residents.ts"
import type { createProposalViews } from "./proposal-view.ts"

type Send = (command: Command) => Promise<unknown>
type Dimension = { name: string; kind: "scale"; low: string; high: string } | { name: string; kind: "choice"; options: string[] }

const LOG_SHOWN = 24
const STRENGTHS: [label: string, strength: number][] = [
  ["off", 0],
  ["slight", 0.2],
  ["moderate", 0.5],
  ["strong", 0.9],
]

/**
 * A resident agent as you steer it: what it is doing, its recent log, the action it proposes, knobs that rewrite that action as you turn them,
 * the focus you pinned, and a line to message it. Cards persist across snapshots so typing into them is never interrupted.
 */
export function createAgentCards(send: Send, proposals: ReturnType<typeof createProposalViews>, onError: (message: string) => void) {
  const cards = new Map<string, ReturnType<typeof build>>()
  return { cardOf }

  function cardOf(resident: Resident, dimensions: Dimension[]) {
    let card = cards.get(resident.name)
    if (!card || card.dimensionsKey !== JSON.stringify(dimensions)) {
      card = build(resident.name, dimensions)
      cards.set(resident.name, card)
    }
    card.update(resident)
    return card.root
  }

  function build(name: string, dimensions: Dimension[]) {
    const run = (command: Command) => send(command).catch((error) => onError((error as Error).message))
    const status = h("span", { class: "status" })
    const stop = h("button", { type: "button", onclick: () => run({ type: "stop", agent: name }) }, "stop")
    const goal = h("p", { class: "goal" })
    const log = h("ol", { class: "log" })
    const proposalSlot = h("div", {})
    const focus = h("p", { class: "focus" })
    const message = h("input", { placeholder: `tell ${name}…`, "aria-label": `message ${name}` })
    const knobs = dimensions.map((dimension) => knobOf(name, dimension, run))
    const root = h(
      "article",
      { class: "agent" },
      h("header", {}, h("b", {}, name), status, stop),
      goal,
      log,
      proposalSlot,
      h("div", { class: "knobs" }, ...knobs.map(({ element }) => element)),
      focus,
      h(
        "form",
        {
          class: "message",
          onsubmit: (event: SubmitEvent) => {
            event.preventDefault()
            if (!message.value.trim()) return
            run({ type: "message", agent: name, text: message.value })
            message.value = ""
          },
        },
        message,
      ),
    )
    let logKey = ""
    let focusKey = ""

    return { root, dimensionsKey: JSON.stringify(dimensions), update }

    function update(resident: Resident) {
      root.dataset.status = resident.status
      status.textContent = resident.status === "waiting" ? "waiting for you" : resident.status
      stop.hidden = resident.status === "stopped"
      goal.textContent = resident.goal
      const shown = resident.log.slice(1).slice(-LOG_SHOWN)
      const nextLogKey = JSON.stringify(shown)
      if (nextLogKey !== logKey) {
        logKey = nextLogKey
        log.replaceChildren(...shown.map(({ kind, text }) => h("li", { "data-kind": kind }, text)))
        log.scrollTop = log.scrollHeight
      }
      const proposal = resident.proposal
      const isShown = proposal && (resident.status === "thinking" || resident.status === "waiting")
      proposalSlot.replaceChildren(...(isShown ? [proposals.viewOf(proposal)] : []))
      for (const knob of knobs) knob.show(resident.knobs[knob.name])
      const nextFocusKey = JSON.stringify(resident.focus)
      if (nextFocusKey !== focusKey) {
        focusKey = nextFocusKey
        focus.replaceChildren(
          ...resident.focus.map((text) =>
            h(
              "button",
              { type: "button", class: "chip", title: "focus: click to drop", onclick: () => run({ type: "unfocus", agent: name, text }) },
              `◎ ${text.slice(0, 60)} ×`,
            ),
          ),
        )
      }
    }
  }
}

/** One knob: where on the dimension, and how strongly; it steers only above off. */
function knobOf(agent: string, dimension: Dimension, run: (command: Command) => void) {
  let setting = { position: 0.5, strength: 0 }
  const steer = (next: Partial<typeof setting>) => {
    setting = { ...setting, ...next }
    run({ type: "steer", agent, knob: dimension.name, ...setting })
  }
  const range = h("input", { type: "range", min: 0, max: 1, step: 0.05, "aria-label": `${dimension.name}` })
  range.addEventListener("change", () => steer({ position: Number(range.value) }))
  const options =
    dimension.kind === "choice"
      ? dimension.options.map((option, i) =>
          h("button", { type: "button", role: "radio", onclick: () => steer({ position: (i + 0.5) / dimension.options.length }) }, option),
        )
      : []
  const strength = h("select", { "aria-label": `${dimension.name} strength` }, ...STRENGTHS.map(([label, value]) => h("option", { value }, label)))
  strength.addEventListener("change", () => steer({ strength: Number(strength.value) }))
  const value =
    dimension.kind === "scale"
      ? h("label", { class: "scale" }, h("small", {}, dimension.low), range, h("small", {}, dimension.high))
      : h("span", { class: "choice", role: "radiogroup", "aria-label": dimension.name }, ...options)
  const element = h("div", { class: "knob" }, h("b", {}, dimension.name), value, strength)

  return { name: dimension.name, element, show }

  function show(next: typeof setting | undefined) {
    if (next) setting = next
    element.toggleAttribute("data-on", setting.strength > 0)
    if (document.activeElement !== range) range.value = String(setting.position)
    if (document.activeElement !== strength)
      strength.value = String(STRENGTHS.reduce((best, [, value]) => (Math.abs(value - setting.strength) < Math.abs(best - setting.strength) ? value : best), 0))
    if (dimension.kind === "choice") {
      const chosen = Math.min(dimension.options.length - 1, Math.floor(setting.position * dimension.options.length))
      options.forEach((option, i) => option.setAttribute("aria-checked", String(i === chosen)))
    }
  }
}
