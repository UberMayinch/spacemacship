import { h } from "../dom.ts"
import type { Buffer } from "../environment/buffers.ts"
import type { Command } from "../environment/environment.ts"
import type { createAgentCards } from "./agent-card.ts"
import type { Snapshot } from "./kernel-client.ts"
import type { createProposalViews } from "./proposal-view.ts"

type Send = (command: Command) => Promise<unknown>

const PLACEHOLDERS = {
  scratch: "say what you want (open a terminal called tests and start an agent there that runs `npm test`), or type Lisp",
  terminal: "command",
  notes: "add a note",
}

/**
 * One pane per open buffer: its text, the agents living in it, its input line, and in *scratch* your requests waiting for approval.
 * Selected text can be pinned as focus for the buffer's agents. Panes persist across snapshots so input is never interrupted.
 */
export function createPanes(
  container: HTMLElement,
  send: Send,
  agentCards: ReturnType<typeof createAgentCards>,
  proposals: ReturnType<typeof createProposalViews>,
  onClose: (name: string) => void,
  onError: (message: string) => void,
) {
  const panes = new Map<string, ReturnType<typeof build>>()
  return { render }

  function render(snapshot: Snapshot, open: string[]) {
    for (const name of [...panes.keys()]) if (!open.includes(name)) panes.delete(name)
    const shownProposals = new Set<number>()
    container.replaceChildren(
      ...open.flatMap((name) => {
        const buffer = snapshot.buffers.find((candidate) => candidate.name === name)
        if (!buffer) return []
        let pane = panes.get(name)
        if (!pane || pane.kind !== buffer.kind) {
          pane = build(buffer)
          panes.set(name, pane)
        }
        pane.update(buffer, snapshot, shownProposals)
        return [pane.root]
      }),
    )
    for (const resident of snapshot.residents) if (resident.proposal) shownProposals.add(resident.proposal.id)
    proposals.forget(shownProposals)
  }

  function build(buffer: Buffer) {
    const { name, kind } = buffer
    const run = (command: Command) => send(command).catch((error) => onError((error as Error).message))
    const where = h("small", {})
    const interrupt = h("button", { type: "button", title: "stop the running command", onclick: () => run({ type: "interrupt", buffer: name }) }, "interrupt")
    const focus = h("button", { type: "button", title: "pin the selected text as focus for this buffer's agents", onclick: pinSelection }, "focus")
    const text = h("pre", { class: "text" })
    const requests = h("div", { class: "requests" })
    const agents = h("div", { class: "agents" })
    const input = h("textarea", { rows: 1, placeholder: PLACEHOLDERS[kind], spellcheck: kind !== "terminal", "aria-label": `input to ${name}` })
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey) return
      event.preventDefault()
      if (!input.value.trim()) return
      run({ type: "input", buffer: name, text: input.value })
      input.value = ""
    })
    const root = h(
      "section",
      { class: "pane", "data-kind": kind },
      h(
        "header",
        {},
        h("b", {}, name),
        h("span", {}, kind),
        where,
        interrupt,
        focus,
        h("button", { type: "button", "aria-label": `close ${name}`, onclick: () => onClose(name) }, "×"),
      ),
      text,
      requests,
      agents,
      input,
    )
    let residentNames: string[] = []

    return { root, kind, update }

    function update(next: Buffer, snapshot: Snapshot, shown: Set<number>) {
      const isAtBottom = text.scrollTop + text.clientHeight >= text.scrollHeight - 4
      if (text.textContent !== next.text) {
        text.textContent = next.text
        if (isAtBottom) text.scrollTop = text.scrollHeight
      }
      where.textContent = next.running ? `running ${next.running}` : shortPath(next.cwd ?? "")
      where.title = next.cwd ?? ""
      root.toggleAttribute("data-running", Boolean(next.running))
      interrupt.hidden = !next.running
      const residents = snapshot.residents.filter((resident) => resident.buffer === name)
      residentNames = residents.map((resident) => resident.name)
      focus.hidden = !residents.length
      agents.replaceChildren(...residents.map((resident) => agentCards.cardOf(resident, snapshot.dimensions as never)))
      if (kind === "scratch") {
        const open = snapshot.requests.filter(({ proposal }) => proposal.status === "pending" || proposal.status === "writing")
        for (const { proposal } of open) shown.add(proposal.id)
        requests.replaceChildren(...open.map(({ text, proposal }) => h("div", { class: "request" }, h("p", {}, `» ${text}`), proposals.viewOf(proposal))))
      }
    }

    function pinSelection() {
      const selected = getSelection()?.toString().trim()
      if (!selected) return onError("select some text in the buffer first")
      for (const agent of residentNames) run({ type: "focus", agent, text: selected })
    }
  }
}

/** The last few directories of a long path, which are the ones that tell terminals apart. */
function shortPath(path: string) {
  const parts = path.split("/")
  return parts.length > 4 ? `…/${parts.slice(-3).join("/")}` : path
}
