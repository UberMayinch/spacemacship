import type { ChatMessage, ToolSpec } from "../llm/cerebras.ts"
import type { Lisp } from "../lisp/lisp.ts"
import { show } from "../lisp/printer.ts"
import { showSignature, type FnType } from "../lisp/types.ts"
import { fail, fromLisp, isKeyword, isMap, isProcedure, isSym, itemsOf, keyword, mapAssoc, mapGet, sym, toLisp, type Value } from "../lisp/values.ts"
import type { AgentModel, ToolRequest } from "./model.ts"
import { apiNameOf, parametersOf } from "./tool-schema.ts"

export type ToolEntry = { name: string; apiName: string; doc: string; params: string[]; signature: FnType }
export type AgentEntry = { name: string; apiName: string; doc: string; instructions: string; tools: string[]; maxSteps: number }
export type RunStep = { kind: "note" | "call" | "result" | "answer" | "error"; text: string }
export type RunStatus = "running" | "done" | "failed" | "stopped"
export type Run = { id: number; agent: string; task: string; parent?: number; status: RunStatus; steps: RunStep[] }
export type BoardEntry = { topic: string; text: string }

const DEFAULT_MAX_STEPS = 6

type Allows = (effect: string) => boolean

/** The declaration forms, as macros over the primitives below. */
const AGENT_FORMS = `
(define-macro (define-tool signature . body)
  "Defines a typed procedure and offers it to agents as a tool. The signature line, with its effects, is required."
  \`(begin (define ,signature ,@body) (register-tool! ',(car signature))))

(define-macro (define-agent name . rest)
  "Defines an agent: (define-agent name \\"what it is for\\" {:instructions \\"...\\" :tools [tool-or-agent ...] :max-steps 6})."
  (let ((doc (if (string? (car rest)) (car rest) #f))
        (spec (if (string? (car rest)) (cadr rest) (car rest))))
    \`(define ,name (register-agent! ',name ,spec ,doc))))
`
const MAX_KEPT_RUNS = 60

/**
 * Tools and agents defined in Lisp, and the agents running now. A tool is a typed Lisp procedure whose signature becomes the schema the model
 * sees and whose declared effects bound what it may do when the model calls it. An agent is a model in a loop with a set of tools, which may
 * include other agents. Runs and a shared board are what the page shows; every run stops when its caller's scope is cancelled.
 */
export function createAgentEnvironment(lisp: Lisp, model: () => AgentModel) {
  const tools = new Map<string, ToolEntry>()
  const agents = new Map<string, AgentEntry>()
  const runs: Run[] = []
  const controllers = new Map<number, AbortController>()
  const board: BoardEntry[] = []
  const listeners = new Set<() => void>()
  let nextRun = 1

  installPrimitives()
  lisp.onChange(prune)
  const ready = lisp.evalText(AGENT_FORMS, "agents.scm").then((results) => {
    const failure = results.find(({ error }) => error)?.error
    if (failure) throw failure
  })

  return {
    ready,
    tools: () => [...tools.values()],
    agents: () => [...agents.values()],
    runs: () => runs,
    board: () => board,
    spawn,
    stop,
    summary,
    onChange: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)),
  }

  /**
   * Starts `agent` on `task` in the background; its run is tracked until it ends or is stopped. Started from Lisp, it may use only the effects
   * its caller `allows`; started by you, from the page, it may use them all.
   */
  function spawn(agent: string, task: string, allows?: Allows) {
    if (!agents.has(agent)) fail(`no agent ${agent} is defined`)
    const id = nextRun
    runAgent(agent, task, new AbortController().signal, undefined, allows).catch(() => {})
    return id
  }

  function stop(id: number) {
    controllers.get(id)?.abort(new DOMException("stopped", "AbortError"))
  }

  async function runAgent(name: string, task: string, signal: AbortSignal, parent?: number, allows?: Allows): Promise<string> {
    const agent = agents.get(name) ?? fail(`no agent ${name} is defined`)
    const controller = new AbortController()
    const forward = () => controller.abort(signal.reason)
    signal.addEventListener("abort", forward, { once: true })
    const run: Run = { id: nextRun++, agent: name, task, parent, status: "running", steps: [] }
    runs.push(run)
    while (runs.length > MAX_KEPT_RUNS && runs[0].status !== "running") runs.shift()
    controllers.set(run.id, controller)
    notify()
    try {
      const messages: ChatMessage[] = [
        { role: "system", content: await systemPromptOf(agent, controller.signal) },
        { role: "user", content: task },
      ]
      const specs = agent.tools.map(specOf)
      for (let step = 0; step < agent.maxSteps; step++) {
        const turn = await model()({ messages, tools: specs }, controller.signal)
        if (!turn.toolCalls.length) {
          const answer = turn.content?.trim() ?? ""
          record(run, "answer", answer)
          run.status = "done"
          return answer
        }
        if (turn.content?.trim()) record(run, "note", turn.content.trim())
        messages.push(turn.raw)
        for (const call of turn.toolCalls) {
          record(run, "call", `${call.name} ${JSON.stringify(call.args)}`)
          const result = await callTool(agent, call, controller.signal, run.id, allows)
          record(run, result.isError ? "error" : "result", result.text)
          messages.push({ role: "tool", tool_call_id: call.id, content: result.text })
        }
      }
      return fail(`${name} used all ${agent.maxSteps} steps without answering`)
    } catch (error) {
      run.status = controller.signal.aborted ? "stopped" : "failed"
      if (!controller.signal.aborted) record(run, "error", (error as Error).message)
      throw error
    } finally {
      signal.removeEventListener("abort", forward)
      controllers.delete(run.id)
      notify()
    }
  }

  /**
   * A failing tool does not end the run: its error goes back to the model as the result, so the agent can try something else.
   * A tool whose effects the run's caller lacks is refused the same way, so a task agent never does more than whoever started it may.
   */
  async function callTool(
    agent: AgentEntry,
    call: ToolRequest,
    signal: AbortSignal,
    runId: number,
    allows?: Allows,
  ): Promise<{ text: string; isError: boolean }> {
    const name = agent.tools.find((tool) => apiNameOf(tool) === call.name)
    try {
      if (!name) return fail(`${agent.name} has no tool ${call.name}`)
      const subAgent = agents.get(name)
      if (subAgent) return { text: await runAgent(name, String(call.args.task ?? JSON.stringify(call.args)), signal, runId, allows), isError: false }
      const tool = tools.get(name) ?? fail(`${name} is no longer defined`)
      const missing = (tool.signature.effects ?? []).filter((effect) => allows && !allows(effect))
      if (missing.length) fail(`${name} needs the ${missing.join(" and ")} effect, which whoever started this agent may not use without your approval`)
      const procedure = lisp.binding(name)?.value
      if (!isProcedure(procedure)) return fail(`${name} is no longer a procedure`)
      const args = tool.params.map((param) => toLisp(call.args[param]))
      const value = await lisp.callValue(procedure, args, signal, tool.signature.effects)
      return { text: typeof value === "string" ? value : show(value), isError: false }
    } catch (error) {
      if (signal.aborted) throw error
      return { text: `error: ${(error as Error).message}`, isError: true }
    }
  }

  function specOf(name: string): ToolSpec {
    const agent = agents.get(name)
    if (agent)
      return {
        type: "function",
        function: {
          name: agent.apiName,
          description: `Agent: ${agent.doc || agent.instructions}`,
          parameters: { type: "object", properties: { task: { type: "string", description: "What to ask this agent to do" } }, required: ["task"] },
        },
      }
    const tool = tools.get(name) ?? fail(`${name} is not a tool or an agent`)
    return {
      type: "function",
      function: { name: tool.apiName, description: tool.doc || name, parameters: parametersOf(tool.params, tool.signature, lisp.schema) },
    }
  }

  /** The system prompt comes from Lisp when `agent-system-prompt` is defined, so the policy can be redefined like anything else. */
  async function systemPromptOf(agent: AgentEntry, signal: AbortSignal) {
    const procedure = lisp.binding("agent-system-prompt")?.value
    if (!isProcedure(procedure)) return agent.instructions
    const value = await lisp.callValue(procedure, [toLisp(agent)], signal, [])
    return typeof value === "string" ? value : show(value, false)
  }

  function summary() {
    const lines = [
      ...[...tools.values()].map(
        ({ name, params, signature, doc }) => `tool (${[name, ...params].join(" ")}) ${showSignature(signature)}${doc ? ` ; ${doc}` : ""}`,
      ),
      ...[...agents.values()].map(({ name, tools, doc }) => `agent ${name} :tools [${tools.join(" ")}]${doc ? ` ; ${doc}` : ""}`),
    ]
    return lines.length ? lines.join("\n") : "(nothing defined yet)"
  }

  function record(run: Run, kind: RunStep["kind"], text: string) {
    run.steps.push({ kind, text })
    notify()
  }

  function prune(names: string[]) {
    let isChanged = false
    for (const name of names) {
      if (lisp.has(name)) continue
      isChanged = tools.delete(name) || agents.delete(name) || isChanged
    }
    if (isChanged) notify()
  }

  function notify() {
    for (const listener of listeners) listener()
  }

  function installPrimitives() {
    lisp.definePrimitive(
      "register-tool!",
      ([name]) => {
        const toolName = nameOf(name)
        const binding = lisp.binding(toolName)
        const procedure = binding?.value
        if (!isProcedure(procedure) || procedure.tag !== "closure") return fail(`tool ${toolName} needs a procedure`)
        const signature = procedure.signature ?? fail(`tool ${toolName} needs a signature, e.g. (: String -> String ! pure), so a model can call it`)
        if (!signature.effects) fail(`tool ${toolName} must declare its effects, e.g. ! pure or ! (llm), so its caller knows what it may do`)
        if (procedure.rest) fail(`tool ${toolName} cannot take a rest parameter`)
        tools.set(toolName, { name: toolName, apiName: apiNameOf(toolName), doc: binding?.doc ?? "", params: procedure.params, signature })
        notify()
        return sym(toolName)
      },
      { arity: [1, 1] },
    )
    lisp.definePrimitive(
      "register-agent!",
      ([name, spec, doc]) => {
        const agentName = nameOf(name)
        if (!isMap(spec)) return fail(`agent ${agentName} needs a map like {:instructions "..." :tools [...]}`)
        const instructions = mapGet(spec, keyword("instructions"))
        if (typeof instructions !== "string" || !instructions.trim()) fail(`agent ${agentName} needs :instructions`)
        const maxSteps = mapGet(spec, keyword("max-steps")) ?? DEFAULT_MAX_STEPS
        if (typeof maxSteps !== "number" || maxSteps < 1) fail(`agent ${agentName}: :max-steps is a positive number`)
        const toolNames = itemsOf(mapGet(spec, keyword("tools")) ?? [], "list of tools").map(toolNameOf)
        for (const tool of toolNames)
          if (tool === agentName) fail(`agent ${agentName} cannot list itself as a tool`)
          else if (!tools.has(tool) && !agents.has(tool)) fail(`agent ${agentName}: ${tool} is not a defined tool or agent`)
        agents.set(agentName, {
          name: agentName,
          apiName: apiNameOf(agentName),
          doc: typeof doc === "string" ? doc : "",
          instructions: instructions as string,
          tools: toolNames,
          maxSteps: maxSteps as number,
        })
        notify()
        return mapAssoc(spec, keyword("name"), agentName)
      },
      { arity: [2, 3] },
    )
    lisp.definePrimitive("tools", () => [...tools.keys()].map(sym), { arity: [0, 0] })
    lisp.definePrimitive("agents", () => [...agents.keys()].map(sym), { arity: [0, 0] })
    lisp.definePrimitive("run-agent", ([name, task], { signal, allows }) => runAgent(nameOf(name), String(fromLisp(task)), signal, undefined, allows), {
      sig: "Any String -> String",
      effects: ["llm"],
    })
    lisp.definePrimitive("spawn-agent", ([name, task], { allows }) => spawn(nameOf(name), String(fromLisp(task)), allows), {
      sig: "Any String -> Number",
      effects: ["llm"],
    })
    lisp.definePrimitive("stop-agent", ([id]) => void stop(Number(id)), { sig: "Number -> Void" })
    lisp.definePrimitive(
      "board-post!",
      ([topic, text]) => {
        board.push({ topic: String(fromLisp(topic)), text: String(fromLisp(text)) })
        notify()
        return "posted"
      },
      { sig: "String String -> String", effects: ["store"] },
    )
    lisp.definePrimitive("board-read", ([topic]) => board.filter((entry) => entry.topic === String(fromLisp(topic))).map(({ text }) => text), {
      sig: "String -> (List String)",
      effects: ["store"],
    })
    lisp.definePrimitive("environment-summary", () => summary(), { sig: "-> String" })
  }
}

function nameOf(value: Value) {
  if (isSym(value) || isKeyword(value)) return value.name
  if (typeof value === "string") return value
  return fail(`expected a name, got ${show(value)}`)
}

/** A tool list may hold names, or the tools and agents themselves, as `[lookup summarize]` evaluates to. */
function toolNameOf(value: Value): string {
  if (isProcedure(value) && value.name) return value.name
  if (isMap(value)) {
    const name = mapGet(value, keyword("name"))
    if (typeof name === "string") return name
  }
  return nameOf(value)
}
