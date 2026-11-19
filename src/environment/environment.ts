import { createAgentEnvironment } from "../agents/environment.ts"
import { liveModelWith, simulatedModel } from "../agents/model.ts"
import { installModel, streamFrom } from "../llm/lisp-model.ts"
import { createLisp } from "../lisp/lisp.ts"
import { show } from "../lisp/printer.ts"
import { showSignature } from "../lisp/types.ts"
import { delay } from "../lisp/streams.ts"
import { fail, fromLisp, isKeyword, isSym, type CallContext, type Value } from "../lisp/values.ts"
import { createBuffers, type Shell } from "./buffers.ts"
import { allowedEffects, createProposal, type Assessment } from "./proposals.ts"
import { createResidents, type Actor, type Resident } from "./residents.ts"
import { simulatedAction, simulatedInterpretation, type ActionContext } from "./simulated-actions.ts"

export type Command =
  | { type: "input"; buffer: string; text: string }
  | { type: "interrupt"; buffer: string }
  | { type: "open"; kind: "terminal" | "notes"; name?: string }
  | { type: "kill"; buffer: string }
  | { type: "approve"; proposal: number; code?: string }
  | { type: "reject"; proposal: number; note?: string }
  | { type: "scrub"; proposal: number; delta: number }
  | { type: "steer"; agent: string; knob: string; position: number; strength: number }
  | { type: "focus"; agent: string; text: string }
  | { type: "unfocus"; agent: string; text: string }
  | { type: "message"; agent: string; text: string }
  | { type: "stop"; agent: string }
  | { type: "mode"; flight: boolean }
  | { type: "key"; key: string }

export type Environment = Awaited<ReturnType<typeof createEnvironment>>

/** Effects an action may have without asking: model calls, the board, buffers and agents, and waiting. Shell and network wait for you. */
const GRANTED = ["llm", "store", "ui", "time"]
const SCRATCH = "*scratch*"
const RESULT_CHARS = 3000
const READ_CHARS = 4000
const HISTORY_ENTRIES = 16
const KEPT_REQUESTS = 20
const SIM_CHUNK_CHARS = 12
const SIM_CHUNK_MS = 15

type Request = { text: string; handle: ReturnType<typeof createProposal>; result?: string }

/**
 * The live environment: one Lisp image holding buffers, terminals, tools, task agents and resident agents, all of it extensible from
 * Lisp while it runs. Whatever acts, you in *scratch* or an agent in its buffer, acts by a Lisp form whose effects the checker reads first.
 * Runs in the kernel process; a page drives it with commands and watches its snapshots.
 */
export async function createEnvironment({ shell, home, config, onChange }: { shell: Shell; home: string; config: string; onChange: () => void }) {
  let isFlight = false
  let apiKey: string | undefined = undefined
  const lisp = createLisp()
  await lisp.ready
  installModel(
    lisp,
    () => isFlight,
    () => apiKey,
  )
  const agents = createAgentEnvironment(lisp, () => (isFlight ? liveModelWith(() => apiKey) : simulatedModel))
  await agents.ready
  const buffers = createBuffers({ shell, home, onChange })
  const residents = createResidents({
    propose: (context, signal) => lisp.callSource("propose-action", [context], signal) as AsyncIterable<string>,
    context: contextOf,
    assess,
    execute,
    granted: GRANTED,
    onChange,
  })
  const requests: Request[] = []
  let nextRequest = 1_000_000
  agents.onChange(onChange)
  installPrimitives()
  const loaded = await load(config)

  return { lisp, buffers, residents, command, snapshot, load, loaded }

  /** Evaluates the policy file; problems go to *scratch*, and the forms around them still load. */
  async function load(text: string) {
    const results = await lisp.evalText(text, "environment.scm", { keepGoing: true })
    const problems = results.flatMap(({ error }) => (error ? [lisp.describeError(error)] : []))
    buffers.append(SCRATCH, problems.length ? `;; environment.scm: ${problems.join("\n;; ")}\n` : `;; loaded environment.scm (${results.length} forms)\n`)
    return problems
  }

  /** Input is answered at once and carries on in the background: a request may wait a long time for your approval. */
  async function command(command: Command): Promise<unknown> {
    switch (command.type) {
      case "input":
        input(command.buffer, command.text).catch((error) => buffers.append(SCRATCH, `!! ${(error as Error).message}\n`))
        return
      case "interrupt":
        return buffers.interrupt(command.buffer)
      case "open":
        return buffers.create(command.kind, command.name).name
      case "kill":
        return buffers.kill(command.buffer)
      case "approve":
        return handleOf(command.proposal).approve(command.code)
      case "reject":
        return handleOf(command.proposal).reject(command.note)
      case "scrub":
        return handleOf(command.proposal).scrub(command.delta)
      case "steer":
        return residents.steer(command.agent, command.knob, { position: command.position, strength: command.strength })
      case "focus":
        return residents.focus(command.agent, command.text)
      case "unfocus":
        return residents.unfocus(command.agent, command.text)
      case "message":
        return residents.send(command.agent, command.text)
      case "stop":
        return residents.stop(command.agent)
      case "mode":
        isFlight = command.flight
        return onChange()
      case "key":
        apiKey = command.key.trim() || undefined
        return onChange()
    }
  }

  /** What the page shows: plain data, rebuilt on every change. */
  function snapshot() {
    return {
      isFlight,
      hasKey: apiKey !== undefined,
      buffers: buffers.list(),
      residents: residents.list(),
      requests: requests.map(({ text, handle, result }) => ({ text, proposal: handle.proposal, result })),
      dimensions: lisp.dimensions(),
      tools: agents.tools().map(({ name, signature }) => `${name} ${showSignature(signature)}`),
      agents: agents.agents().map(({ name }) => name),
    }
  }

  /** In *scratch*, Lisp runs as typed and anything else is a request the interpreter turns into Lisp; a terminal runs it; notes keep it. */
  async function input(name: string, text: string) {
    const buffer = buffers.get(name) ?? fail(`no buffer ${name}`)
    if (buffer.kind === "terminal") return runUserCommand(name, text)
    if (buffer.kind === "notes") return buffers.append(name, `${text}\n`)
    if (/^\s*[(\['`]/.test(text)) return evaluate(text)
    return request(text)
  }

  async function evaluate(text: string) {
    buffers.append(SCRATCH, `> ${text}\n`)
    const results = await lisp.evalText(text, SCRATCH, { actor: { name: "you", buffer: SCRATCH } satisfies Actor })
    for (const { value, error } of results) buffers.append(SCRATCH, error ? `!! ${lisp.describeError(error)}\n` : `=> ${show(value)}\n`)
  }

  /** Interruptions are already marked in the terminal; anything else that went wrong is noted there. */
  async function runUserCommand(name: string, text: string) {
    try {
      await buffers.run(name, text, new AbortController().signal)
    } catch (error) {
      if ((error as Error).message !== "interrupted by you") buffers.append(name, `[${(error as Error).message}]\n`)
    }
  }

  /** A request becomes a proposal like any agent's: it runs at once if it only does what is granted, otherwise it waits for you. */
  async function request(text: string) {
    buffers.append(SCRATCH, `» ${text}\n`)
    const handle = createProposal({
      id: nextRequest++,
      actor: "you",
      generate: (_index, avoid, signal) =>
        lisp.callSource(
          "interpret",
          [
            {
              request: text,
              buffers: buffers.list().map(({ name, kind }) => `${name} (${kind})`),
              agents: residents.list().map(({ name, buffer, status }) => `${name} in ${buffer} (${status})`),
              tools: `tools: ${
                agents
                  .tools()
                  .map(({ name }) => name)
                  .join(", ") || "none"
              }`,
              avoid,
            },
          ],
          signal,
        ) as AsyncIterable<string>,
      assess,
      onChange,
    })
    const entry: Request = { text, handle }
    requests.push(entry)
    if (requests.length > KEPT_REQUESTS) requests.shift()
    handle.write(0).then((first) => first && !first.needsApproval && !first.error && handle.approve())
    const decision = await handle.decision
    if (decision.kind !== "approve") return buffers.append(SCRATCH, `;; ${decision.kind === "reject" ? "rejected" : "cancelled"}\n`)
    buffers.append(SCRATCH, `${decision.code}\n`)
    const actor: Actor = { name: "you", buffer: SCRATCH }
    const result = await execute(decision.code, actor, allowedEffects(await assess(decision.code), GRANTED), new AbortController().signal)
    entry.result = result.text
    buffers.append(SCRATCH, result.isError ? `!! ${result.text}\n` : `=> ${result.text || "ok"}\n`)
  }

  async function assess(code: string): Promise<Assessment> {
    if (!code.trim()) return { effects: [], needsApproval: true, error: "no Lisp form" }
    const report = await lisp.checkText(code, "proposal")
    if (report.errors.length) return { effects: report.effects, needsApproval: true, error: report.errors.map((error) => error.message).join("\n") }
    return { effects: report.effects, needsApproval: report.hasUnknownEffects || report.effects.some((effect) => !GRANTED.includes(effect)) }
  }

  async function execute(code: string, actor: Actor, effects: string[] | undefined, signal: AbortSignal) {
    const results = await lisp.evalText(code, actor.name, { effects, actor, signal })
    const failure = results.find(({ error }) => error)?.error
    if (failure) return { text: lisp.describeError(failure), isError: true }
    const value = results.at(-1)?.value
    if (value === undefined) return { text: "", isError: false }
    return { text: (typeof value === "string" ? value : show(value)).slice(-RESULT_CHARS), isError: false }
  }

  function contextOf(resident: Resident, avoid: string[]): ActionContext {
    const buffer = buffers.get(resident.buffer)
    const controls = lisp.dimensions().flatMap((dimension) => {
      const setting = resident.knobs[(dimension as { name: string }).name]
      return setting && setting.strength > 0 ? [{ dimension: dimension as ActionContext["controls"][number]["dimension"], ...setting }] : []
    })
    return {
      name: resident.name,
      goal: resident.goal,
      buffer: resident.buffer,
      "is-terminal": buffer?.kind === "terminal",
      log: resident.log.slice(-HISTORY_ENTRIES).map(({ kind, text }) => ({ kind, text: text.slice(-RESULT_CHARS) })),
      focus: resident.focus,
      controls,
      avoid,
    }
  }

  function handleOf(id: number) {
    return residents.proposal(id) ?? requests.find(({ handle }) => handle.proposal.id === id)?.handle ?? fail(`no pending proposal ${id}`)
  }

  function installPrimitives() {
    const actorOf = (context: CallContext) => (context.actor as Actor | undefined) ?? { name: "you", buffer: SCRATCH }
    const text = (value: Value) => (typeof value === "string" ? value : show(value, false))
    const nameOf = (value: Value) => (isSym(value) || isKeyword(value) ? value.name : text(value))
    const shellIn = async (buffer: string, commandText: string, signal: AbortSignal) => {
      const { exitCode, output } = await buffers.run(buffer, commandText, signal)
      return `exit ${exitCode}\n${output.slice(-RESULT_CHARS)}`
    }
    const ui = { effects: ["ui"] }

    lisp.definePrimitive(
      "shell",
      ([commandText], context) => {
        const actor = actorOf(context)
        if (buffers.get(actor.buffer)?.kind !== "terminal") fail(`${actor.buffer} is not a terminal; use (shell-in "terminal" "command")`)
        return shellIn(actor.buffer, text(commandText), context.signal)
      },
      { sig: "String -> String", effects: ["shell"] },
    )
    lisp.definePrimitive("shell-in", ([buffer, commandText], context) => shellIn(nameOf(buffer), text(commandText), context.signal), {
      sig: "Any String -> String",
      effects: ["shell"],
    })
    lisp.definePrimitive(
      "say",
      ([message], context) => {
        const actor = actorOf(context)
        if (actor.resident) {
          actor.resident.log.push({ kind: "say", text: text(message) })
          onChange()
        } else buffers.append(actor.buffer, `;; ${text(message)}\n`)
      },
      { sig: "Any -> Void", ...ui },
    )
    lisp.definePrimitive(
      "done",
      ([summary], context) => {
        actorOf(context).finished = summary === undefined ? "" : text(summary)
        return summary ?? ""
      },
      { arity: [0, 1], ...ui },
    )
    lisp.definePrimitive("read-buffer", ([name]) => (buffers.get(nameOf(name)) ?? fail(`no buffer ${nameOf(name)}`)).text.slice(-READ_CHARS), {
      sig: "Any -> String",
      ...ui,
    })
    lisp.definePrimitive(
      "write-buffer!",
      ([name, message]) => {
        buffers.append(nameOf(name), `${text(message)}\n`)
        return nameOf(name)
      },
      { sig: "Any Any -> String", ...ui },
    )
    lisp.definePrimitive("open-terminal", ([name]) => buffers.create("terminal", name === undefined ? undefined : nameOf(name)).name, { arity: [0, 1], ...ui })
    lisp.definePrimitive("new-buffer", ([name]) => buffers.create("notes", name === undefined ? undefined : nameOf(name)).name, { arity: [0, 1], ...ui })
    lisp.definePrimitive("kill-buffer", ([name]) => void buffers.kill(nameOf(name)), { sig: "Any -> Void", ...ui })
    lisp.definePrimitive("buffers", () => buffers.list().map(({ name }) => name), { arity: [0, 0] })
    lisp.definePrimitive(
      "start-agent",
      ([name, buffer, goal]) => {
        if (!buffers.get(nameOf(buffer))) fail(`no buffer ${nameOf(buffer)}`)
        return residents.start(nameOf(name), nameOf(buffer), text(goal)).name
      },
      { sig: "Any Any String -> String", ...ui },
    )
    lisp.definePrimitive("send-agent", ([name, message]) => void residents.send(nameOf(name), text(message)), { sig: "Any String -> Void", ...ui })
    lisp.definePrimitive("halt-agent", ([name]) => void residents.stop(nameOf(name)), { sig: "Any -> Void", ...ui })
    lisp.definePrimitive("residents", () => residents.list().map(({ name }) => name), { arity: [0, 0] })
    lisp.definePrimitive(
      "sim-interpret",
      ([request]) => {
        const { request: text } = fromLisp(request) as { request: string }
        const terminals = buffers
          .list()
          .filter(({ kind }) => kind === "terminal")
          .map(({ name }) => name)
        return streamFrom((signal) => typed(simulatedInterpretation(text, terminals), signal))
      },
      { sig: "Map -> (Stream String)", effects: ["time"] },
    )
    lisp.definePrimitive(
      "sim-propose",
      ([context]) => {
        const action = simulatedAction(fromLisp(context) as ActionContext)
        return streamFrom((signal) => typed(action, signal))
      },
      { sig: "Map -> (Stream String)", effects: ["time"] },
    )
  }
}

/** Streams `text` a few characters at a time, as a model would, so sim shows code arriving. */
async function* typed(text: string, signal: AbortSignal) {
  for (let i = 0; i < text.length; i += SIM_CHUNK_CHARS) {
    await delay(SIM_CHUNK_MS, signal)
    yield text.slice(i, i + SIM_CHUNK_CHARS)
  }
}
