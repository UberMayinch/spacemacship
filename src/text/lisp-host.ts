import { installModel, lispItems, streamFrom } from "../llm/lisp-model.ts"
import type { Lisp } from "../lisp/lisp.ts"
import { asStream } from "../lisp/streams.ts"
import { fromLisp, type Stream, type Value } from "../lisp/values.ts"
import { simulatedSource } from "./completion.ts"
import { liveAttention } from "./live-attention.ts"
import { withoutEchoStream } from "./live-completion.ts"
import { liveInfluence } from "./live-influence.ts"
import { liveRealization } from "./live-realization.ts"
import { liveRelevance } from "./live-relevance.ts"
import { simulatedAttention } from "./simulated-attention.ts"
import { simulatedInfluence } from "./simulated-influence.ts"
import { simulatedRealization } from "./simulated-realization.ts"
import { simulatedRelevance } from "./simulated-relevance.ts"

type Run = (args: never[], signal: AbortSignal) => AsyncIterable<unknown>

/** The story page's sources, as Lisp primitives over the TypeScript implementations, plus the model access every page shares. */
export function installHost(lisp: Lisp, isFlight: () => boolean) {
  installModel(lisp, isFlight)

  lisp.definePrimitive(
    "strip-echo",
    ([prefix, deltas]) => {
      const upstream = asStream(deltas)
      return {
        tag: "stream",
        open: (context) => lispItems(withoutEchoStream(String(prefix), plainStrings(upstream.open(context)))),
      } satisfies Stream
    },
    { sig: "String Stream -> (Stream String)" },
  )

  const sources: [name: string, sig: string, effect: string, run: Run][] = [
    ["sim-continue", "String Steering -> (Stream String)", "time", ([prefix, steering], signal) => simulatedSource.complete(prefix, steering, signal)],
    ["sim-attention", "String -> (Stream AttentionBox)", "time", ([text], signal) => simulatedAttention(text, signal)],
    ["live-attention", "String -> (Stream AttentionBox)", "llm", ([text], signal) => liveAttention(text, signal)],
    ["sim-influence", "(List String) Focus -> (Stream Influence)", "time", ([sentences, focus], signal) => simulatedInfluence(sentences, focus, signal)],
    ["live-influence", "(List String) Focus -> (Stream Influence)", "llm", ([sentences, focus], signal) => liveInfluence(sentences, focus, signal)],
    ["sim-realization", "RealizationRequest -> (Stream Realization)", "time", ([request], signal) => simulatedRealization(request, signal)],
    ["live-realization", "RealizationRequest -> (Stream Realization)", "llm", ([request], signal) => liveRealization(request, signal)],
    ["sim-relevance", "RelevanceRequest -> (Stream Relevance)", "time", ([request], signal) => simulatedRelevance(request, signal)],
    ["live-relevance", "RelevanceRequest -> (Stream Relevance)", "llm", ([request], signal) => liveRelevance(request, signal)],
  ]
  for (const [name, sig, effect, run] of sources)
    lisp.definePrimitive(name, (args) => streamFrom((signal) => run(args.map(fromLisp) as never[], signal)), { sig, effects: [effect] })
}

async function* plainStrings(items: AsyncIterable<Value>) {
  for await (const item of items) yield typeof item === "string" ? item : String(fromLisp(item))
}
