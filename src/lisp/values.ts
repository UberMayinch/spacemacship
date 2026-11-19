import type { Node } from "./analyze.ts"
import type { Site } from "./reader.ts"
import type { FnType } from "./types.ts"

export type Sym = { tag: "sym"; name: string }
export type Keyword = { tag: "kw"; name: string }
export type Vector = { tag: "vector"; items: Value[] }
export type LispMap = { tag: "map"; entries: Map<string, [Value, Value]> }
export type Env = { vars: Map<string, Value>; parent?: Env }

/** What a primitive can do while it runs: abort with the caller, call back into Lisp, and use effects the caller allows. */
export type CallContext = {
  signal: AbortSignal
  /** `signal` replaces the caller's, e.g. to stop a producer the consumer no longer needs. */
  call(procedure: Value, args: Value[], signal?: AbortSignal): Promise<Value>
  allows(effect: string): boolean
  /** The effects the caller may use, to hand on to code it runs; undefined when unrestricted. */
  effects?: ReadonlySet<string>
  log(text: string): void
  /** Who the evaluation runs for, e.g. an agent and its buffer; primitives like `shell` act on its behalf. */
  actor?: unknown
}

export type Closure = { tag: "closure"; name?: string; params: string[]; rest?: string; locals: string[]; body: Node; env: Env; signature?: FnType }
export type Primitive = {
  tag: "primitive"
  name: string
  arity: [min: number, max: number]
  effects: string[]
  signature?: FnType
  fn(args: Value[], context: CallContext): Value | Promise<Value>
}
export type Macro = { tag: "macro"; name: string; expander: Value }
/** Lazy: nothing runs until a consumer opens it, under the consumer's cancel scope. */
export type Stream = { tag: "stream"; open(context: CallContext): AsyncIterable<Value> }

export type Value = number | string | boolean | undefined | Value[] | Sym | Keyword | Vector | LispMap | Closure | Primitive | Macro | Stream

export type LispError = Error & { site?: Site; trace?: string[]; isIncomplete?: boolean }

const symbols = new Map<string, Sym>()
const keywords = new Map<string, Keyword>()

export function sym(name: string): Sym {
  let symbol = symbols.get(name)
  if (!symbol) symbols.set(name, (symbol = { tag: "sym", name }))
  return symbol
}

export function keyword(name: string): Keyword {
  let value = keywords.get(name)
  if (!value) keywords.set(name, (value = { tag: "kw", name }))
  return value
}

export function fail(message: string): never {
  throw new Error(message)
}

export const isSym = (value: Value): value is Sym => isTagged(value) && value.tag === "sym"
export const isKeyword = (value: Value): value is Keyword => isTagged(value) && value.tag === "kw"
export const isVector = (value: Value): value is Vector => isTagged(value) && value.tag === "vector"
export const isMap = (value: Value): value is LispMap => isTagged(value) && value.tag === "map"
export const isStream = (value: Value): value is Stream => isTagged(value) && value.tag === "stream"
export const isMacro = (value: Value): value is Macro => isTagged(value) && value.tag === "macro"
export const isList = (value: Value): value is Value[] => Array.isArray(value)
export const isProcedure = (value: Value): value is Closure | Primitive => isTagged(value) && (value.tag === "closure" || value.tag === "primitive")
export const isTruthy = (value: Value) => value !== false

/** Lists and vectors alike, for the sequence functions. */
export function itemsOf(value: Value, what = "sequence"): Value[] {
  if (isList(value)) return value
  if (isVector(value)) return value.items
  if (isMap(value)) return [...value.entries.values()].map(([key, item]) => [key, item])
  if (typeof value === "string") return [...value]
  return fail(`expected a ${what}, got ${typeName(value)}`)
}

export function isSequence(value: Value) {
  return isList(value) || isVector(value)
}

export function makeMap(pairs: Iterable<[Value, Value]>): LispMap {
  const entries = new Map<string, [Value, Value]>()
  for (const [key, value] of pairs) entries.set(mapKeyOf(key), [key, value])
  return { tag: "map", entries }
}

export function mapGet(map: LispMap, key: Value): Value {
  return map.entries.get(mapKeyOf(key))?.[1]
}

export function mapHas(map: LispMap, key: Value) {
  return map.entries.has(mapKeyOf(key))
}

export function mapAssoc(map: LispMap, key: Value, value: Value): LispMap {
  const entries = new Map(map.entries)
  entries.set(mapKeyOf(key), [key, value])
  return { tag: "map", entries }
}

export function mapDissoc(map: LispMap, key: Value): LispMap {
  const entries = new Map(map.entries)
  entries.delete(mapKeyOf(key))
  return { tag: "map", entries }
}

/** Map keys are atoms, compared by value. */
export function mapKeyOf(key: Value) {
  if (typeof key === "string") return `s${key}`
  if (typeof key === "number") return `n${key}`
  if (typeof key === "boolean") return `b${key}`
  if (isKeyword(key)) return `k${key.name}`
  if (isSym(key)) return `y${key.name}`
  return fail(`a map key must be a keyword, string, symbol, number or boolean, got ${typeName(key)}`)
}

export function equal(a: Value, b: Value): boolean {
  if (a === b) return true
  if (isList(a) && isList(b)) return a.length === b.length && a.every((item, i) => equal(item, b[i]))
  if (isVector(a) && isVector(b)) return equal(a.items, b.items)
  if (isMap(a) && isMap(b))
    return a.entries.size === b.entries.size && [...a.entries].every(([key, [, value]]) => b.entries.has(key) && equal(value, b.entries.get(key)![1]))
  return false
}

export function typeName(value: Value): string {
  if (value === undefined) return "void"
  if (typeof value === "number") return "number"
  if (typeof value === "string") return "string"
  if (typeof value === "boolean") return "boolean"
  if (isList(value)) return "list"
  return { sym: "symbol", kw: "keyword", vector: "vector", map: "map", closure: "procedure", primitive: "procedure", macro: "macro", stream: "stream" }[
    value.tag
  ]
}

/** Plain JS data in: arrays become vectors, objects become maps keyed by keywords; undefined fields are left out, as optional keys. */
export function toLisp(data: unknown): Value {
  if (data === null || data === undefined) return undefined
  if (typeof data === "number" || typeof data === "string" || typeof data === "boolean") return data
  if (Array.isArray(data)) return { tag: "vector", items: data.map(toLisp) }
  if (typeof data === "object")
    return makeMap(Object.entries(data).flatMap(([key, value]): [Value, Value][] => (value === undefined ? [] : [[keyword(key), toLisp(value)]])))
  return fail(`cannot pass ${typeof data} to Lisp`)
}

/** Lisp data out: sequences become arrays, maps become objects, symbols and keywords become their names. */
export function fromLisp(value: Value): unknown {
  if (value === undefined || typeof value !== "object") return value
  if (isList(value)) return value.map(fromLisp)
  if (isVector(value)) return value.items.map(fromLisp)
  if (isSym(value) || isKeyword(value)) return value.name
  if (isMap(value)) return Object.fromEntries([...value.entries.values()].map(([key, item]) => [keyNameOf(key), fromLisp(item)]))
  return fail(`cannot pass a ${typeName(value)} out of Lisp`)
}

function keyNameOf(key: Value) {
  return isKeyword(key) || isSym(key) ? key.name : String(key)
}

function isTagged(value: Value): value is Exclude<Value, number | string | boolean | undefined | Value[]> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
