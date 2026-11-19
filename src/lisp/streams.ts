import { show } from "./printer.ts"
import { primitive } from "./stdlib.ts"
import { equal, fail, isSequence, isStream, isTruthy, itemsOf, type CallContext, type Primitive, type Stream, type Value } from "./values.ts"

/** Streams are lazy and abortable: a stream opens under its consumer's cancel scope, so a source written in Lisp never handles a signal. */
export function streamLibrary(): Primitive[] {
  const any = (min: number, max = min): { arity: [number, number] } => ({ arity: [min, max] })
  return [
    primitive("stream", (items) => streamOf(items), { arity: [0, Infinity] }),
    primitive("stream-of", ([xs]) => asStream(xs), any(1)),
    primitive("stream-map", ([f, s]) => derive(s, (items, context) => mapped(items, f, context)), any(2)),
    primitive("stream-filter", ([f, s]) => derive(s, (items, context) => filtered(items, f, context)), any(2)),
    primitive("stream-keep", ([f, s]) => derive(s, (items, context) => kept(items, f, context)), any(2)),
    primitive(
      "stream-take",
      ([n, s]) => derive(s, (items) => taken(items, typeof n === "number" ? n : fail(`stream-take needs a count, got ${show(n)}`))),
      any(2),
    ),
    primitive("stream-distinct-by", ([f, s]) => derive(s, (items, context) => distinct(items, f, context)), any(2)),
    primitive("stream-lines", ([s]) => derive(s, (items) => linesOf(items)), any(1)),
    primitive(
      "stream-append",
      (streams) => ({
        tag: "stream",
        open: async function* (context) {
          for (const s of streams) yield* asStream(s).open(context)
        },
      }),
      { arity: [0, Infinity] },
    ),
    primitive(
      "stream->list",
      async ([s], context) => {
        const items: Value[] = []
        for await (const item of asStream(s).open(context)) items.push(item)
        return items
      },
      any(1),
    ),
    primitive(
      "stream-for-each",
      async ([f, s], context) => {
        for await (const item of asStream(s).open(context)) await context.call(f, [item])
      },
      any(2),
    ),
    primitive("generate", ([producer]) => ({ tag: "stream", open: (context) => generated(producer, context) }), any(1)),
    primitive("sleep", ([ms], { signal }) => delay(typeof ms === "number" ? ms : fail(`sleep needs milliseconds, got ${show(ms)}`), signal), {
      sig: "Number -> Void",
      effects: ["time"],
    }),
  ]
}

export function asStream(value: Value): Stream {
  if (isStream(value)) return value
  if (isSequence(value)) return streamOf(itemsOf(value))
  return fail(`expected a stream or a sequence, got ${show(value)}`)
}

export function streamOf(items: Value[]): Stream {
  return {
    tag: "stream",
    open: async function* () {
      yield* items
    },
  }
}

export function delay(ms: number, signal: AbortSignal) {
  return new Promise<undefined>((resolve, reject) => {
    signal.throwIfAborted()
    const timer = setTimeout(() => resolve(undefined), ms)
    signal.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true })
  })
}

function derive(source: Value, transform: (items: AsyncIterable<Value>, context: CallContext) => AsyncIterable<Value>): Stream {
  const upstream = asStream(source)
  return { tag: "stream", open: (context) => transform(upstream.open(context), context) }
}

async function* mapped(items: AsyncIterable<Value>, f: Value, context: CallContext) {
  for await (const item of items) yield await context.call(f, [item])
}

async function* filtered(items: AsyncIterable<Value>, f: Value, context: CallContext) {
  for await (const item of items) if (isTruthy(await context.call(f, [item]))) yield item
}

async function* kept(items: AsyncIterable<Value>, f: Value, context: CallContext) {
  for await (const item of items) {
    const value = await context.call(f, [item])
    if (value !== false && value !== undefined) yield value
  }
}

async function* taken(items: AsyncIterable<Value>, count: number) {
  if (count <= 0) return
  let seen = 0
  for await (const item of items) {
    yield item
    if (++seen >= count) return
  }
}

async function* distinct(items: AsyncIterable<Value>, f: Value, context: CallContext) {
  const seen: Value[] = []
  for await (const item of items) {
    const key = await context.call(f, [item])
    if (seen.some((other) => equal(other, key))) continue
    seen.push(key)
    yield item
  }
}

async function* linesOf(chunks: AsyncIterable<Value>) {
  let buffer = ""
  for await (const chunk of chunks) {
    const lines = (buffer + (typeof chunk === "string" ? chunk : show(chunk, false))).split("\n")
    buffer = lines.pop()!
    yield* lines
  }
  if (buffer) yield buffer
}

/** Runs `producer` with an `emit` procedure; items are yielded as they are emitted. Stopping early aborts the producer. */
async function* generated(producer: Value, context: CallContext): AsyncIterable<Value> {
  const controller = new AbortController()
  const stop = () => controller.abort(context.signal.reason)
  context.signal.addEventListener("abort", stop, { once: true })
  const queue: Value[] = []
  let wake: (() => void) | undefined
  let state: { done: boolean; error?: unknown } = { done: false }
  const notify = () => (wake?.(), (wake = undefined))
  const emit = primitive(
    "emit",
    ([item]) => {
      queue.push(item)
      notify()
    },
    { arity: [1, 1] },
  )
  context.call(producer, [emit], controller.signal).then(
    () => ((state = { done: true }), notify()),
    (error) => ((state = { done: true, error }), notify()),
  )
  try {
    while (true) {
      if (queue.length) {
        yield queue.shift()!
        continue
      }
      if (state.done) {
        if (state.error !== undefined && !controller.signal.aborted) throw state.error
        return
      }
      await new Promise<void>((resolve) => (wake = resolve))
    }
  } finally {
    context.signal.removeEventListener("abort", stop)
    controller.abort()
  }
}
