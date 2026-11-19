import "@fontsource-variable/jetbrains-mono/wght.css"
import { $, h } from "../dom.ts"
import { createAgentCards } from "./agent-card.ts"
import { createPanes } from "./buffer-pane.ts"
import { connectKernel, type Snapshot } from "./kernel-client.ts"
import { createProposalViews } from "./proposal-view.ts"

const NOTICE_MS = 6000

const bufferList = $("#buffer-list")
const agentList = $("#agent-list")
const toolList = $("#tool-list")
const notice = $("#notice")
const connection = $("#connection")
const modeToggle = $<HTMLButtonElement>("#mode-toggle")
const keyDialog = $<HTMLDialogElement>("#key-dialog")

const kernel = connectKernel(render, (isConnected) => {
  connection.textContent = isConnected ? "kernel" : "kernel offline: npm run kernel"
  connection.toggleAttribute("data-offline", !isConnected)
})
const proposals = createProposalViews(kernel.send, showNotice)
const agentCards = createAgentCards(kernel.send, proposals, showNotice)
const panes = createPanes($("#panes"), kernel.send, agentCards, proposals, close, showNotice)
/** Buffers shown as panes: *scratch* to start, and every buffer that appears, until closed. */
let open = ["*scratch*"]
let known = new Set<string>()
let latest: Snapshot | undefined
let noticeTimer: number | undefined

$("#new-terminal").addEventListener("click", () => kernel.send({ type: "open", kind: "terminal" }).catch((error) => showNotice((error as Error).message)))
$("#new-notes").addEventListener("click", () => kernel.send({ type: "open", kind: "notes" }).catch((error) => showNotice((error as Error).message)))
modeToggle.addEventListener("click", () => {
  if (!latest) return
  if (latest.isFlight) return kernel.send({ type: "mode", flight: false })
  if (latest.hasKey) return kernel.send({ type: "mode", flight: true })
  keyDialog.showModal()
})
keyDialog.addEventListener("close", async () => {
  const key = (keyDialog.querySelector("input") as HTMLInputElement).value
  ;(keyDialog.querySelector("input") as HTMLInputElement).value = ""
  if (keyDialog.returnValue !== "launch" || !key.trim()) return
  keyDialog.returnValue = ""
  await kernel.send({ type: "key", key })
  await kernel.send({ type: "mode", flight: true })
})

function render(snapshot: Snapshot) {
  latest = snapshot
  for (const { name } of snapshot.buffers) if (!known.has(name) && !open.includes(name)) open.push(name)
  known = new Set(snapshot.buffers.map(({ name }) => name))
  open = open.filter((name) => known.has(name))
  panes.render(snapshot, open)
  bufferList.replaceChildren(
    ...snapshot.buffers.map(({ name, kind, running }) =>
      h(
        "li",
        { "data-open": open.includes(name), "data-running": Boolean(running) },
        h("button", { type: "button", onclick: () => toggle(name) }, name),
        h("small", {}, kind),
      ),
    ),
  )
  agentList.replaceChildren(
    ...snapshot.residents.map(({ name, buffer, status }) => h("li", { "data-status": status }, h("b", {}, name), " ", h("small", {}, `${status} · ${buffer}`))),
  )
  toolList.replaceChildren(...snapshot.tools.map((tool) => h("li", {}, tool)))
  modeToggle.querySelector("b")!.textContent = snapshot.isFlight ? "flight" : "sim"
  modeToggle.setAttribute("aria-pressed", String(snapshot.isFlight))
}

function toggle(name: string) {
  open = open.includes(name) ? open.filter((other) => other !== name) : [...open, name]
  if (latest) render(latest)
}

function close(name: string) {
  open = open.filter((other) => other !== name)
  if (latest) render(latest)
}

function showNotice(message: string) {
  notice.textContent = message
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (notice.textContent = ""), NOTICE_MS)
}
