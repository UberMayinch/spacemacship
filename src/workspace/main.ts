import "@fontsource-variable/jetbrains-mono/wght.css"
import shippedWorkspace from "../../workspace.scm?raw"
import { createAgentEnvironment } from "../agents/environment.ts"
import { liveModel, simulatedModel } from "../agents/model.ts"
import { $ } from "../dom.ts"
import { installModel } from "../llm/lisp-model.ts"
import { createLisp } from "../lisp/lisp.ts"
import { configFile, isSafeMode } from "../repl/config-file.ts"
import { createReplPanel } from "../repl/repl-panel.ts"
import { bindModeToggle } from "../text/live-mode.ts"
import { createEnvironmentView } from "./environment-view.ts"
import { createKnobBar } from "./knob-bar.ts"
import { loadWorkspace, saveWorkspace } from "./saved-workspace.ts"
import { renderUnits } from "./unit-view.ts"
import { createUnits } from "./units.ts"
import { installWorkspaceHost } from "./workspace-host.ts"

const SYNC_DELAY_MS = 900
const KNOB_DELAY_MS = 700
const STARTER_INTENT = `A tool called word-count that counts the words in a text.

A tool called shout that turns text into upper case.

An agent called editor that uses word-count and shout to report on a passage and make its first sentence loud.`

const intent = $<HTMLTextAreaElement>("#intent")
const unitsElement = $("#units")
const status = $("#status")

const mode = bindModeToggle($<HTMLButtonElement>("#mode-toggle"), $<HTMLDialogElement>("#live-keys"), () => render())
const lisp = createLisp()
installModel(lisp, mode.isLive)
const env = createAgentEnvironment(lisp, () => (mode.isLive() ? liveModel : simulatedModel))
installWorkspaceHost(lisp, env)
const knobs = createKnobBar($("#knobs"), () => {
  clearTimeout(knobTimer)
  knobTimer = setTimeout(units.recompileAll, KNOB_DELAY_MS)
  persist()
})
const units = createUnits({ lisp, controls: knobs.controls, environment: env.summary, onChange: render })
const environmentView = createEnvironmentView($("#environment"), env)
const config = configFile({ origin: "workspace.scm", shipped: shippedWorkspace })
const repl = createReplPanel({
  origin: config.origin,
  dialog: $<HTMLDialogElement>("#repl"),
  toggle: $<HTMLButtonElement>("#repl-toggle"),
  lisp,
  save: config.save,
})
let frame: number | undefined
let syncTimer: number | undefined
let knobTimer: number | undefined

await lisp.ready
await env.ready
await repl.load(config.initial(), { isSafe: isSafeMode })
import.meta.hot?.accept("../../workspace.scm?raw", (module) => module && repl.reloadFromDisk(module.default))
knobs.show(lisp.dimensions())
lisp.onChange((names) => names.some((name) => name.startsWith("dimension:")) && knobs.show(lisp.dimensions()))
env.onChange(render)

const saved = loadWorkspace()
if (saved) {
  intent.value = saved.intent
  knobs.restore(saved.knobs)
  knobs.show(lisp.dimensions())
  await units.restore(saved.units)
} else {
  intent.value = STARTER_INTENT
  units.sync(intent.value)
}

intent.addEventListener("input", () => {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => units.sync(intent.value), SYNC_DELAY_MS)
})
intent.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key === "l") {
    event.preventDefault()
    lockSelection()
  }
})
$("#lock-phrase").addEventListener("click", lockSelection)

/** The selected words become a key phrase of the paragraph they are in, which then compiles again honoring them. */
function lockSelection() {
  const phrase = intent.value.slice(intent.selectionStart, intent.selectionEnd)
  if (!phrase.trim()) return
  clearTimeout(syncTimer)
  units.sync(intent.value)
  const unit = units.unitAtOffset(intent.value, intent.selectionStart)
  if (unit) units.addPhrase(unit, phrase)
}

/** Redraws once per frame, however many changes ask for it, and keeps the workspace saved. */
function render() {
  frame ??= requestAnimationFrame(() => {
    frame = undefined
    renderUnits(unitsElement, units.units(), units)
    environmentView.render()
    const running = env.runs().filter((run) => run.status === "running").length
    status.textContent = `${units.units().length} ¶ · ${env.tools().length} tools · ${env.agents().length} agents · ${running} running`
    persist()
  })
}

function persist() {
  saveWorkspace({ intent: intent.value, units: units.save(), knobs: knobs.settings() })
}
