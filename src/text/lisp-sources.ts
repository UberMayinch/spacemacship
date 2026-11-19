import type { Lisp } from "../lisp/lisp.ts"
import type { AttentionBox, AttentionSource } from "./attention.ts"
import { simulatedSource } from "./completion.ts"
import type { Dimension, DimensionSource } from "./dimension.ts"
import type { Influence, InfluenceSource } from "./influence.ts"
import type { Relevance, RelevanceSource } from "./keyword-relevance.ts"
import { liveAttention } from "./live-attention.ts"
import { expandToStoryStart, liveSource } from "./live-completion.ts"
import { liveDimension } from "./live-dimension.ts"
import { liveInfluence } from "./live-influence.ts"
import { liveRealization } from "./live-realization.ts"
import { liveRelevance } from "./live-relevance.ts"
import type { Realization, RealizationSource } from "./realization.ts"
import { simulatedAttention } from "./simulated-attention.ts"
import { simulatedDimension } from "./simulated-dimension.ts"
import { simulatedInfluence } from "./simulated-influence.ts"
import { simulatedRealization } from "./simulated-realization.ts"
import { simulatedRelevance } from "./simulated-relevance.ts"
import type { TextSource } from "./text-stream.ts"

/**
 * The page's six seams, each looked up in Lisp by name on every call, so a redefinition applies to the next request.
 * A name with no procedure bound (safe mode, or a config that failed to define it) falls back to the kernel's own source for the current mode.
 */
export function lispSources(lisp: Lisp, isFlight: () => boolean) {
  function through<T>(name: string, args: unknown[], signal: AbortSignal, fallback: () => AsyncIterable<T>): AsyncIterable<T> {
    return lisp.isProcedure(name) ? (lisp.callSource(name, args, signal) as AsyncIterable<T>) : fallback()
  }

  const text: TextSource = {
    expand: (text) => (isFlight() ? expandToStoryStart(text) : text),
    complete: (prefix, steering, signal) =>
      through<string>("continue-story", [prefix, steering], signal, () => (isFlight() ? liveSource : simulatedSource).complete(prefix, steering, signal)),
  }
  const attention: AttentionSource = (text, signal) =>
    through<AttentionBox>("attention", [text], signal, () => (isFlight() ? liveAttention : simulatedAttention)(text, signal))
  const dimension: DimensionSource = (context, signal) =>
    through<Dimension>("dimension-menu", [context], signal, () => (isFlight() ? liveDimension : simulatedDimension)(context, signal))
  const influence: InfluenceSource = (sentences, focus, signal) =>
    through<Influence>("influence", [sentences, focus], signal, () => (isFlight() ? liveInfluence : simulatedInfluence)(sentences, focus, signal))
  const realization: RealizationSource = (request, signal) =>
    through<Realization>("realization", [request], signal, () => (isFlight() ? liveRealization : simulatedRealization)(request, signal))
  const relevance: RelevanceSource = (request, signal) =>
    through<Relevance>("relevance", [request], signal, () => (isFlight() ? liveRelevance : simulatedRelevance)(request, signal))

  return { text, attention, dimension, influence, realization, relevance }
}
