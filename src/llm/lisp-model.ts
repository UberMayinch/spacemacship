import type { Lisp } from "../lisp/lisp.ts"
import { fromLisp, toLisp, type CallContext, type Stream, type Value } from "../lisp/values.ts"
import { storedApiKey, streamCompletion } from "./cerebras.ts"

/**
 * Model access as Lisp primitives, shared by every page. The key is read here, so Lisp gets the `llm` effect but never the key,
 * and no primitive reaches the DOM or storage.
 */
export function installModel(lisp: Lisp, isFlight: () => boolean, apiKey: () => string | undefined = storedApiKey) {
  lisp.definePrimitive("flight?", () => isFlight(), { sig: "-> Bool" })

  lisp.definePrimitive(
    "llm-stream",
    ([request]) => {
      const { system, user, temperature = 0.7, "max-tokens": maxCompletionTokens = 2000 } = fromLisp(request) as Record<string, never>
      if (typeof system !== "string" || typeof user !== "string") throw new Error("llm-stream needs {:system String :user String}")
      return streamFrom((signal) => streamCompletion({ apiKey: requireKey(apiKey), system, user, temperature, maxCompletionTokens, signal }))
    },
    { sig: "{:system String :user String :temperature? Number :max-tokens? Number} -> (Stream String)", effects: ["llm"] },
  )
}

export function requireKey(read: () => string | undefined = storedApiKey) {
  const apiKey = read()
  if (!apiKey) throw new Error("save a Cerebras API key first (launch flight mode from the tray)")
  return apiKey
}

/** A Lisp stream over a TS one; each opening gets its own controller, so a consumer that stops early also stops the request. */
export function streamFrom(start: (signal: AbortSignal) => AsyncIterable<unknown>): Stream {
  return {
    tag: "stream",
    open: async function* (context: CallContext) {
      const controller = new AbortController()
      const stop = () => controller.abort(context.signal.reason)
      context.signal.addEventListener("abort", stop, { once: true })
      try {
        yield* lispItems(start(controller.signal))
      } finally {
        context.signal.removeEventListener("abort", stop)
        controller.abort()
      }
    },
  }
}

export async function* lispItems(items: AsyncIterable<unknown>): AsyncIterable<Value> {
  for await (const item of items) yield toLisp(item)
}
