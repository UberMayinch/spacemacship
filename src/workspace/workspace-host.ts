import type { createAgentEnvironment } from "../agents/environment.ts"
import { streamFrom } from "../llm/lisp-model.ts"
import type { Lisp } from "../lisp/lisp.ts"
import { delay } from "../lisp/streams.ts"
import { fromLisp } from "../lisp/values.ts"

type AgentEnvironment = ReturnType<typeof createAgentEnvironment>

type Control = { dimension: { name: string; kind: string; options?: string[]; low?: string; high?: string }; position: number; strength: number }
type CompileRequest = { intent: string; controls: Control[] }

const CHUNK_CHARS = 18
const CHUNK_MS = 12
const BUILT_IN_TOOLS = ["ask-llm", "post-note", "read-notes"]
const STOPWORDS = new Set(
  "a an the that which who whom it its it's to of for and or with from into on in by as is are be make makes create creates write build builds called named tool tools agent agents uses use using should can will then".split(
    " ",
  ),
)

/** The workspace's capabilities beyond model access: `sim-compile`, which plays the compiler without a model, so the loop runs in sim. */
export function installWorkspaceHost(lisp: Lisp, env: AgentEnvironment) {
  lisp.definePrimitive(
    "sim-compile",
    ([request]) => {
      const code = simulatedCode(
        fromLisp(request) as CompileRequest,
        env.tools().map(({ name }) => name),
        env.agents().map(({ name }) => name),
      )
      return streamFrom(async function* (signal) {
        for (let i = 0; i < code.length; i += CHUNK_CHARS) {
          await delay(CHUNK_MS, signal)
          yield code.slice(i, i + CHUNK_CHARS)
        }
      })
    },
    { sig: "CompileRequest -> (Stream String)", effects: ["time"] },
  )
}

/**
 * A stand-in compiler: each clause of the intent that mentions an agent becomes an agent over the tools it names (or the ones defined so far);
 * every other clause becomes a tool. The code knobs change its shape, so steering is visible without a model.
 */
export function simulatedCode({ intent, controls }: CompileRequest, tools: string[], agents: string[]) {
  const settings = Object.fromEntries(controls.map((control) => [control.dimension.name, control]))
  const defined = new Set([...tools, ...agents])
  const written = new Set<string>()
  const forms: string[] = []
  for (const clause of clausesOf(intent)) {
    const isAgent = /\bagents?\b/i.test(clause)
    const name = nameOf(clause, written, isAgent ? "-agent" : "")
    if (isAgent)
      forms.push(
        agentCode(
          name,
          clause,
          [...defined].filter((tool) => tool !== name),
          settings.autonomy,
        ),
      )
    else forms.push(...toolCode(name, clause, settings))
    defined.add(name)
    written.add(name)
  }
  return forms.join("\n\n")
}

function agentCode(name: string, clause: string, available: string[], autonomy: Control | undefined) {
  const text = clause.toLowerCase()
  const named = available.filter((tool) => text.includes(tool.replaceAll("-", " ")) || text.includes(tool))
  const own = available.filter((tool) => !BUILT_IN_TOOLS.includes(tool) && tool !== name)
  const tools = named.length ? named : own.length ? own.slice(-3) : ["ask-llm"]
  const steps = autonomy ? Math.round(2 + autonomy.position * 8) : 4
  return `(define-agent ${name} ${quoted(clause)}
  {:instructions ${quoted(`${clause} Use your tools, then answer in one or two sentences.`)}
   :tools [${tools.join(" ")}]
   :max-steps ${steps}})`
}

function toolCode(name: string, clause: string, settings: Record<string, Control>) {
  const reach = choiceOf(settings.reach)
  const isLoose = settings.strictness ? settings.strictness.position < 0.4 : false
  const abstraction = choiceOf(settings.abstraction) ?? "inline"
  const effect = reach === "uses llm" ? "(llm)" : reach === "uses the board" ? "(store)" : "pure"
  const result = (input: string) =>
    reach === "uses llm"
      ? `(ask-llm (str ${quoted(`${clause}: `)} ${input}))`
      : reach === "uses the board"
        ? `(post-note "${name}" ${input})`
        : `(str "${name}: " ${input})`
  if (abstraction === "schemas") {
    const schema = name.replace(/(^|-)(\w)/g, (_, _dash, letter: string) => letter.toUpperCase()) + "Input"
    return [
      `(define-schema ${schema} {:text String})`,
      `(define-tool (${name} input)\n  (: ${schema} -> String ! ${effect})\n  ${quoted(clause)}\n  ${result("(:text input)")})`,
    ]
  }
  const type = isLoose ? "Any" : "String"
  if (abstraction === "helpers")
    return [
      `(define (${name}-step text)\n  ${result("text")})`,
      `(define-tool (${name} text)\n  (: ${type} -> String ! ${effect})\n  ${quoted(clause)}\n  (${name}-step (str text)))`,
    ]
  return [`(define-tool (${name} text)\n  (: ${type} -> String ! ${effect})\n  ${quoted(clause)}\n  ${result("(str text)")})`]
}

function clausesOf(intent: string) {
  return intent
    .split(/(?<=[.;!?])\s+|,?\s+and\s+(?=(?:an?|the)\s+(?:agent|tool)\b)/i)
    .map((clause) => clause.trim())
    .filter((clause) => /[a-z]/i.test(clause))
}

/** An explicit "called x" wins; otherwise the first two content words, with `suffix` so an agent never takes the name of a tool it uses. */
function nameOf(clause: string, taken: Set<string>, suffix: string) {
  const explicit = clause.match(/\b(?:called|named)\s+["']?([\w-]+)/i)?.[1]
  const words = clause.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const base =
    explicit?.toLowerCase() ??
    `${
      words
        .filter((word) => !STOPWORDS.has(word))
        .slice(0, 2)
        .join("-") || "thing"
    }${suffix}`
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
  return name
}

function choiceOf(control: Control | undefined) {
  const options = control?.dimension.options
  if (!control || !options?.length) return
  return options[Math.min(options.length - 1, Math.floor(control.position * options.length))]
}

function quoted(text: string) {
  return JSON.stringify(text)
}
