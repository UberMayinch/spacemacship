import { h } from "../dom.ts"
import type { Command } from "../environment/environment.ts"
import type { Proposal } from "../environment/proposals.ts"

type Send = (command: Command) => Promise<unknown>

/**
 * A proposed action as you decide on it: the Lisp as it is being written, the effects the checker read from it, the alternatives to scrub
 * through (scrubbing past the last writes another), and run, edit or reject. A card is rebuilt only when its proposal changes, so a note or
 * an edit in progress survives the snapshots of everything else.
 */
export function createProposalViews(send: Send, onError: (message: string) => void) {
  const cache = new Map<number, { key: string; element: HTMLElement }>()
  return { viewOf, forget }

  function viewOf(proposal: Proposal) {
    const key = JSON.stringify([proposal.status, proposal.index, proposal.alternatives])
    const cached = cache.get(proposal.id)
    if (cached?.key === key) return cached.element
    const element = build(proposal)
    cache.set(proposal.id, { key, element })
    return element
  }

  /** Drops cards of proposals no longer shown. */
  function forget(shown: Set<number>) {
    for (const id of cache.keys()) if (!shown.has(id)) cache.delete(id)
  }

  function build(proposal: Proposal) {
    const current = proposal.alternatives[proposal.index]
    const isOpen = proposal.status === "pending" || proposal.status === "writing"
    const run = (command: Command) => send(command).catch((error) => onError((error as Error).message))
    const note = h("input", { placeholder: "why not? (optional)", "aria-label": "note for the agent" })
    const editor = h("textarea", { class: "editor", spellcheck: "false", "aria-label": "edit the action", hidden: true })
    editor.value = current?.code ?? ""
    const editButton = h("button", { type: "button" }, "edit")
    editButton.addEventListener("click", () => {
      editor.hidden = !editor.hidden
      editButton.textContent = editor.hidden ? "edit" : "unedit"
      if (!editor.hidden) editor.focus()
    })
    return h(
      "section",
      { class: "proposal", "data-status": proposal.status, "data-needs-approval": current?.needsApproval === true },
      h(
        "header",
        {},
        h("span", { class: "status" }, current?.isWriting ? "writing…" : statusLabel(proposal)),
        ...(current?.effects ?? []).map((effect) => h("span", { class: "effect", "data-effect": effect }, effect)),
        isOpen &&
          h(
            "span",
            { class: "scrub" },
            h(
              "button",
              {
                type: "button",
                disabled: proposal.index === 0,
                "aria-label": "previous alternative",
                onclick: () => run({ type: "scrub", proposal: proposal.id, delta: -1 }),
              },
              "◀",
            ),
            `${proposal.index + 1}/${proposal.alternatives.length}`,
            h(
              "button",
              {
                type: "button",
                "aria-label": "next alternative",
                title: "past the last one, the agent writes another",
                onclick: () => run({ type: "scrub", proposal: proposal.id, delta: 1 }),
              },
              "▶",
            ),
          ),
      ),
      h("pre", { class: "code" }, current?.code || "…"),
      current?.error && h("p", { class: "error" }, current.error),
      editor,
      proposal.status === "pending" &&
        h(
          "p",
          { class: "actions" },
          h(
            "button",
            { type: "button", class: "run", onclick: () => run({ type: "approve", proposal: proposal.id, code: editor.hidden ? undefined : editor.value }) },
            "run",
          ),
          editButton,
          note,
          h("button", { type: "button", onclick: () => run({ type: "reject", proposal: proposal.id, note: note.value }) }, "reject"),
        ),
    )
  }
}

function statusLabel(proposal: Proposal) {
  const current = proposal.alternatives[proposal.index]
  if (proposal.status === "pending") return current?.error ? "does not check" : current?.needsApproval ? "needs your approval" : "ready"
  return { writing: "writing…", approved: "ran", rejected: "rejected", cancelled: "rewritten" }[proposal.status]
}
