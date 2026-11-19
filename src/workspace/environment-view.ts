import type { createAgentEnvironment, Run } from "../agents/environment.ts"
import { h } from "../dom.ts"
import { showSignature } from "../lisp/types.ts"

type AgentEnvironment = ReturnType<typeof createAgentEnvironment>

/**
 * What is loaded and what is running: tools with their signatures, agents with a task box each, the runs newest first with every step,
 * and the board. Agent cards are kept across renders so a half-typed task survives the steps of other runs.
 */
export function createEnvironmentView(container: HTMLElement, env: AgentEnvironment) {
  const agentCards = new Map<string, { element: HTMLElement; tools: HTMLElement }>()
  const toolList = h("ul", { class: "tools" })
  const agentList = h("div", { class: "agents" })
  const runList = h("div", { class: "runs" })
  const boardList = h("dl", { class: "board" })
  container.replaceChildren(h("h3", {}, "tools"), toolList, h("h3", {}, "agents"), agentList, h("h3", {}, "runs"), runList, h("h3", {}, "board"), boardList)
  return { render }

  function render() {
    toolList.replaceChildren(
      ...env.tools().map(({ name, signature, doc }) => h("li", {}, h("b", {}, name), " ", h("code", {}, showSignature(signature)), doc && h("small", {}, doc))),
    )
    renderAgents()
    const runs = [...env.runs()].reverse()
    runList.replaceChildren(...(runs.length ? runs.map(runCard) : [h("p", { class: "empty" }, "no runs yet: give an agent a task")]))
    boardList.replaceChildren(...env.board().flatMap(({ topic, text }) => [h("dt", {}, topic), h("dd", {}, text)]))
  }

  function renderAgents() {
    const agents = env.agents()
    for (const name of [...agentCards.keys()]) if (!agents.some((agent) => agent.name === name)) agentCards.delete(name)
    agentList.replaceChildren(
      ...agents.map((agent) => {
        let card = agentCards.get(agent.name)
        if (!card) {
          const input = h("input", { name: "task", placeholder: "task", autocomplete: "off", required: true })
          const tools = h("p", { class: "agent-tools" })
          const form = h(
            "form",
            {
              onsubmit: (event: SubmitEvent) => {
                event.preventDefault()
                env.spawn(agent.name, input.value)
                input.value = ""
              },
            },
            input,
            h("button", {}, "run"),
          )
          card = { element: h("article", { class: "agent" }, h("header", {}, h("b", {}, agent.name)), tools, form), tools }
          agentCards.set(agent.name, card)
        }
        card.tools.textContent = `${agent.doc ? `${agent.doc} ` : ""}tools: ${agent.tools.join(" ") || "none"} · up to ${agent.maxSteps} steps`
        return card.element
      }),
    )
  }

  function runCard(run: Run) {
    return h(
      "article",
      { class: "run", "data-status": run.status },
      h(
        "header",
        {},
        h("b", {}, `#${run.id} ${run.agent}`),
        h("span", { class: "status" }, run.status),
        run.parent !== undefined && h("small", {}, `for #${run.parent}`),
        run.status === "running" && h("button", { type: "button", onclick: () => env.stop(run.id) }, "stop"),
      ),
      h("p", { class: "task" }, run.task),
      h("ol", { class: "steps" }, ...run.steps.map(({ kind, text }) => h("li", { "data-kind": kind }, text))),
    )
  }
}
