import { chatWithTools, storedApiKey, type ChatMessage, type ToolSpec } from "../llm/cerebras.ts"
import { requireKey } from "../llm/lisp-model.ts"
import { delay } from "../lisp/streams.ts"

export type ToolRequest = { id: string; name: string; args: Record<string, unknown> }

export type ModelTurn = { content: string | null; toolCalls: ToolRequest[]; raw: ChatMessage }

/** One turn of an agent's conversation: text, or tool calls to make before the next turn. Must stop (by throwing) once `signal` aborts. */
export type AgentModel = (request: { messages: ChatMessage[]; tools: ToolSpec[] }, signal: AbortSignal) => Promise<ModelTurn>

const TEMPERATURE = 0.3
const MAX_TOKENS = 2000
const SIM_LATENCY_MS = 250

/** The model over Cerebras tool calling, with the key read from `apiKey` at every turn. */
export function liveModelWith(apiKey: () => string | undefined): AgentModel {
  return async ({ messages, tools }, signal) => {
    const { content, toolCalls } = await chatWithTools({
      apiKey: requireKey(apiKey),
      messages,
      tools,
      temperature: TEMPERATURE,
      maxCompletionTokens: MAX_TOKENS,
      signal,
    })
    return {
      content,
      toolCalls: toolCalls.map(({ id, function: { name, arguments: args } }) => ({ id, name, args: parseArgs(args) })),
      raw: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    }
  }
}

export const liveModel = liveModelWith(storedApiKey)

/**
 * Plays an agent without a model: it calls the one tool whose name and description share the most words with the task, filling each
 * parameter from the task, then answers with what the tool returned.
 */
export const simulatedModel: AgentModel = async ({ messages, tools }, signal) => {
  await delay(SIM_LATENCY_MS, signal)
  const task = messages.find((message) => message.role === "user")?.content ?? ""
  const results = messages.flatMap((message) => (message.role === "tool" ? [message.content] : []))
  if (tools.length && !results.length) {
    const tool = bestMatch(tools, task)
    const id = `sim-${Date.now()}`
    const args = argsFor(tool.function.parameters as JsonObject, task)
    const toolCalls = [{ id, type: "function" as const, function: { name: tool.function.name, arguments: JSON.stringify(args) } }]
    const content = `(sim) calling ${tool.function.name}`
    return { content, toolCalls: [{ id, name: tool.function.name, args }], raw: { role: "assistant", content, tool_calls: toolCalls } }
  }
  const content = results.length ? `(sim) ${results.join("; ")}` : `(sim) no tools to do: ${task}`
  return { content, toolCalls: [], raw: { role: "assistant", content } }
}

type JsonObject = { properties?: Record<string, { type?: string; enum?: unknown[] }> }

function argsFor({ properties = {} }: JsonObject, task: string): Record<string, unknown> {
  const numbers = (task.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)
  return Object.fromEntries(
    Object.entries(properties).map(([name, schema]) => {
      if (schema.enum) return [name, schema.enum[0]]
      if (schema.type === "number") return [name, numbers.shift() ?? 1]
      if (schema.type === "boolean") return [name, true]
      if (schema.type === "array") return [name, []]
      if (schema.type === "object") return [name, {}]
      return [name, task]
    }),
  )
}

function bestMatch(tools: ToolSpec[], task: string) {
  const words = new Set(wordsOf(task))
  const score = ({ function: { name, description } }: ToolSpec) => wordsOf(`${name} ${description}`).filter((word) => words.has(word)).length
  return tools.reduce((best, tool) => (score(tool) > score(best) ? tool : best))
}

function wordsOf(text: string) {
  return text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []
}

function parseArgs(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text || "{}")
    return typeof value === "object" && value !== null ? value : {}
  } catch {
    return {}
  }
}
