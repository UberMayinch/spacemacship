const API_URL = "https://api.cerebras.ai/v1/chat/completions"
const MODEL = "gpt-oss-120b"

export const KEY_STORAGE = "cerebras-api-key"

export const storedApiKey = () => localStorage.getItem(KEY_STORAGE)?.trim()

export type CompletionRequest = {
  apiKey: string
  system: string
  user: string
  temperature: number
  maxCompletionTokens: number
  signal: AbortSignal
}

export async function* streamCompletion({ apiKey, system, user, temperature, maxCompletionTokens, signal }: CompletionRequest) {
  const response = await fetch(API_URL, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      reasoning_effort: "low",
      temperature,
      max_completion_tokens: maxCompletionTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  })

  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  if (!response.body) throw new Error("no response body")

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += value

    const events = buffer.split("\n")
    buffer = events.pop() ?? ""

    for (const line of events) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : ""
      if (!data || data === "[DONE]") continue
      const content = JSON.parse(data).choices?.[0]?.delta?.content
      if (content) yield content as string
    }
  }
}

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } }

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

export type ToolSpec = { type: "function"; function: { name: string; description: string; parameters: object } }

export type ToolChatRequest = {
  apiKey: string
  messages: ChatMessage[]
  tools: ToolSpec[]
  temperature: number
  maxCompletionTokens: number
  signal: AbortSignal
}

/** One turn of a conversation the model may answer with tool calls instead of text. */
export async function chatWithTools({ apiKey, messages, tools, temperature, maxCompletionTokens, signal }: ToolChatRequest) {
  const response = await fetch(API_URL, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      reasoning_effort: "low",
      temperature,
      max_completion_tokens: maxCompletionTokens,
      messages,
      ...(tools.length ? { tools, tool_choice: "auto", parallel_tool_calls: false } : {}),
    }),
  })
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  const body = await response.json()
  const message = body.choices?.[0]?.message
  if (!message) throw new Error("the model returned no message")
  return { content: (message.content as string | null) ?? null, toolCalls: (message.tool_calls as ToolCall[] | undefined) ?? [] }
}
