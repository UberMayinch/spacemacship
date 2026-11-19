import { show } from "./printer.ts"
import { readAll } from "./reader.ts"
import { parseSignature, type FnType } from "./types.ts"
import {
  equal,
  fail,
  isKeyword,
  isList,
  isMap,
  isProcedure,
  isSequence,
  isStream,
  isSym,
  isTruthy,
  isVector,
  itemsOf,
  keyword,
  makeMap,
  mapAssoc,
  mapDissoc,
  mapGet,
  mapHas,
  sym,
  typeName,
  type CallContext,
  type LispMap,
  type Primitive,
  type Value,
} from "./values.ts"

type Fn = (args: Value[], context: CallContext) => Value | Promise<Value>

/** `sig` is a signature as written after `:` in Lisp, e.g. "Number ... -> Number"; it also sets the arity. */
export function primitive(name: string, fn: Fn, spec: { sig?: string; arity?: [number, number]; effects?: string[] }): Primitive {
  const signature = spec.sig ? signatureOf(spec.sig, spec.effects) : undefined
  const arity =
    spec.arity ?? (signature ? [signature.params.length, signature.rest ? Infinity : signature.params.length] : fail(`${name} needs a signature or an arity`))
  return { tag: "primitive", name, arity, effects: spec.effects ?? [], signature, fn }
}

export function signatureOf(text: string, effects?: string[]): FnType {
  const signature = parseSignature(readAll(text, "builtin").map(({ form }) => form))
  return effects ? { ...signature, effects } : signature
}

let gensymCount = 0

export function standardLibrary(): Primitive[] {
  const any = (min: number, max = min): { arity: [number, number] } => ({ arity: [min, max] })
  return [
    primitive("+", (args) => numbers(args).reduce((a, b) => a + b, 0), { sig: "Number ... -> Number" }),
    primitive("*", (args) => numbers(args).reduce((a, b) => a * b, 1), { sig: "Number ... -> Number" }),
    primitive("-", (args) => (args.length === 1 ? -num(args[0]) : numbers(args).reduce((a, b) => a - b)), { sig: "Number Number ... -> Number" }),
    primitive("/", (args) => (args.length === 1 ? 1 / num(args[0]) : numbers(args).reduce((a, b) => a / b)), { sig: "Number Number ... -> Number" }),
    primitive("quotient", ([a, b]) => Math.trunc(num(a) / num(b)), { sig: "Number Number -> Number" }),
    primitive("remainder", ([a, b]) => num(a) % num(b), { sig: "Number Number -> Number" }),
    primitive("modulo", ([a, b]) => ((num(a) % num(b)) + num(b)) % num(b), { sig: "Number Number -> Number" }),
    ...comparisons(),
    primitive("min", (args) => Math.min(...numbers(args)), { sig: "Number Number ... -> Number" }),
    primitive("max", (args) => Math.max(...numbers(args)), { sig: "Number Number ... -> Number" }),
    ...(["abs", "floor", "ceil", "round", "sqrt", "trunc"] as const).map((name) =>
      primitive(name === "ceil" ? "ceiling" : name === "trunc" ? "truncate" : name, ([x]) => Math[name](num(x)), { sig: "Number -> Number" }),
    ),
    primitive("expt", ([a, b]) => num(a) ** num(b), { sig: "Number Number -> Number" }),
    primitive("random", ([n]) => (n === undefined ? Math.random() : Math.floor(Math.random() * num(n))), { arity: [0, 1] }),
    primitive("number->string", ([n]) => show(num(n)), { sig: "Number -> String" }),
    primitive("string->number", ([s]) => (Number.isNaN(Number(s)) || str(s).trim() === "" ? false : Number(s)), { sig: "String -> Any" }),

    primitive("=", (args) => args.every((arg) => equal(arg, args[0])), { arity: [1, Infinity] }),
    primitive("equal?", ([a, b]) => equal(a, b), any(2)),
    primitive("eq?", ([a, b]) => a === b, any(2)),
    primitive("not", ([x]) => x === false, any(1)),

    ...predicates(),

    primitive("list", (args) => args, { arity: [0, Infinity] }),
    primitive("cons", ([head, tail]) => [head, ...itemsOf(tail)], any(2)),
    primitive("car", ([xs]) => firstOf(xs, "car"), any(1)),
    primitive("first", ([xs]) => itemsOf(xs)[0], any(1)),
    primitive("cdr", ([xs]) => (itemsOf(xs).length ? itemsOf(xs).slice(1) : fail("cdr of an empty list")), any(1)),
    primitive("rest", ([xs]) => itemsOf(xs).slice(1), any(1)),
    primitive("cadr", ([xs]) => itemsOf(xs)[1], any(1)),
    primitive("second", ([xs]) => itemsOf(xs)[1], any(1)),
    primitive("last", ([xs]) => itemsOf(xs).at(-1), any(1)),
    primitive("nth", ([xs, n]) => itemsOf(xs)[num(n)], any(2)),
    primitive("length", ([xs]) => itemsOf(xs).length, { sig: "Any -> Number" }),
    primitive("count", ([xs]) => (isMap(xs) ? xs.entries.size : itemsOf(xs).length), { sig: "Any -> Number" }),
    primitive("empty?", ([xs]) => (isMap(xs) ? xs.entries.size === 0 : itemsOf(xs).length === 0), { sig: "Any -> Bool" }),
    primitive("null?", ([xs]) => isList(xs) && xs.length === 0, { sig: "Any -> Bool" }),
    primitive("append", (args) => args.flatMap((xs) => itemsOf(xs)), { arity: [0, Infinity] }),
    primitive("reverse", ([xs]) => [...itemsOf(xs)].reverse(), any(1)),
    primitive("take", ([n, xs]) => itemsOf(xs).slice(0, Math.max(0, num(n))), any(2)),
    primitive("drop", ([n, xs]) => itemsOf(xs).slice(Math.max(0, num(n))), any(2)),
    primitive("range", ([a, b]) => (b === undefined ? rangeOf(0, num(a)) : rangeOf(num(a), num(b))), { arity: [1, 2] }),
    primitive("map", async (args, context) => mapEach(args, context), { arity: [2, Infinity] }),
    primitive("for-each", async (args, context) => void (await mapEach(args, context)), { arity: [2, Infinity] }),
    primitive("filter", async ([f, xs], context) => filterEach(f, xs, context, true), any(2)),
    primitive("remove", async ([f, xs], context) => filterEach(f, xs, context, false), any(2)),
    primitive(
      "reduce",
      async ([f, init, xs], context) => {
        let acc = init
        for (const item of itemsOf(xs)) acc = await context.call(f, [acc, item])
        return acc
      },
      any(3),
    ),
    primitive(
      "find",
      async ([f, xs], context) => {
        for (const item of itemsOf(xs)) if (isTruthy(await context.call(f, [item]))) return item
        return false
      },
      any(2),
    ),
    primitive("any?", async ([f, xs], context) => (await filterEach(f, xs, context, true)).length > 0, any(2)),
    primitive("every?", async ([f, xs], context) => (await filterEach(f, xs, context, false)).length === 0, any(2)),
    primitive("member?", ([x, xs]) => itemsOf(xs).some((item) => equal(item, x)), any(2)),
    primitive("index-of", ([x, xs]) => itemsOf(xs).findIndex((item) => equal(item, x)), any(2)),
    primitive("distinct", ([xs]) => itemsOf(xs).filter((item, i, items) => items.findIndex((other) => equal(other, item)) === i), any(1)),
    primitive("sort", async ([xs, less], context) => sortAsync(itemsOf(xs), less, context), any(1, 2)),
    primitive("apply", async ([f, ...rest], context) => context.call(f, [...rest.slice(0, -1), ...itemsOf(rest.at(-1))]), { arity: [2, Infinity] }),

    primitive("vector", (args) => ({ tag: "vector", items: args }), { arity: [0, Infinity] }),
    primitive("list->vector", ([xs]) => ({ tag: "vector", items: [...itemsOf(xs)] }), any(1)),
    primitive("vector->list", ([xs]) => [...itemsOf(xs)], any(1)),
    primitive("hash-map", (args) => pairsToMap(args), { arity: [0, Infinity] }),
    primitive("get", ([coll, key, fallback]) => getIn(coll, key) ?? fallback, any(2, 3)),
    primitive("assoc", ([m, ...kvs]) => pairsOf(kvs).reduce((acc, [k, v]) => mapAssoc(acc, k, v), asMap(m)), { arity: [3, Infinity] }),
    primitive("dissoc", ([m, ...ks]) => ks.reduce((acc: LispMap, k) => mapDissoc(acc, k), asMap(m)), { arity: [2, Infinity] }),
    primitive("has-key?", ([m, k]) => mapHas(asMap(m), k), any(2)),
    primitive("keys", ([m]) => [...asMap(m).entries.values()].map(([k]) => k), any(1)),
    primitive("vals", ([m]) => [...asMap(m).entries.values()].map(([, v]) => v), any(1)),
    primitive("merge", (maps) => makeMap(maps.flatMap((m) => [...asMap(m).entries.values()])), { arity: [1, Infinity] }),

    primitive("str", (args) => args.map((arg) => (arg === undefined ? "" : show(arg, false))).join(""), { arity: [0, Infinity] }),
    primitive("string-append", (args) => args.map(str).join(""), { sig: "String ... -> String" }),
    primitive("string-length", ([s]) => str(s).length, { sig: "String -> Number" }),
    primitive("substring", ([s, a, b]) => str(s).slice(num(a), b === undefined ? undefined : num(b)), { arity: [2, 3] }),
    primitive("string-split", ([s, sep]) => str(s).split(str(sep)), { sig: "String String -> (List String)" }),
    primitive(
      "string-join",
      ([xs, sep]) =>
        itemsOf(xs)
          .map(str)
          .join(sep === undefined ? " " : str(sep)),
      { arity: [1, 2] },
    ),
    primitive("string-trim", ([s]) => str(s).trim(), { sig: "String -> String" }),
    primitive("string-upcase", ([s]) => str(s).toUpperCase(), { sig: "String -> String" }),
    primitive("string-downcase", ([s]) => str(s).toLowerCase(), { sig: "String -> String" }),
    primitive("string-contains?", ([s, part]) => str(s).includes(str(part)), { sig: "String String -> Bool" }),
    primitive("string-starts-with?", ([s, part]) => str(s).startsWith(str(part)), { sig: "String String -> Bool" }),
    primitive("string-ends-with?", ([s, part]) => str(s).endsWith(str(part)), { sig: "String String -> Bool" }),
    primitive("string-index-of", ([s, part]) => str(s).indexOf(str(part)), { sig: "String String -> Number" }),
    primitive("string-replace", ([s, from, to]) => str(s).replaceAll(str(from), str(to)), { sig: "String String String -> String" }),
    primitive("regex-replace", ([s, pattern, to]) => str(s).replace(new RegExp(str(pattern), "gu"), str(to)), { sig: "String String String -> String" }),
    primitive("regex-match?", ([s, pattern]) => new RegExp(str(pattern), "u").test(str(s)), { sig: "String String -> Bool" }),
    primitive("words", ([s]) => str(s).match(/\S+/g) ?? [], { sig: "String -> (List String)" }),
    primitive("lines", ([s]) => str(s).split("\n"), { sig: "String -> (List String)" }),
    primitive("symbol->string", ([s]) => (isSym(s) ? s.name : fail(`expected a symbol, got ${show(s)}`)), { sig: "Symbol -> String" }),
    primitive("string->symbol", ([s]) => sym(str(s)), { sig: "String -> Symbol" }),
    primitive("keyword", ([s]) => keyword(isSym(s) ? s.name : str(s)), any(1)),
    primitive("name", ([x]) => (isSym(x) || isKeyword(x) ? x.name : typeof x === "string" ? x : fail(`name of ${show(x)}`)), { sig: "Any -> String" }),

    primitive("error", (args) => fail(args.map((arg) => show(arg, false)).join(" ")), { arity: [1, Infinity] }),
    primitive("gensym", ([prefix]) => sym(`${prefix === undefined ? "g" : show(prefix, false)}__${++gensymCount}`), { arity: [0, 1] }),
    primitive("void", () => undefined, any(0)),
    primitive("type-of", ([x]) => sym(typeName(x)), any(1)),
    primitive("display", ([x], context) => void context.log(show(x, false)), any(1)),
    primitive("print", (args, context) => void context.log(args.map((arg) => show(arg, false)).join(" ")), { arity: [0, Infinity] }),
    primitive("show", ([x]) => show(x), { sig: "Any -> String" }),
  ]
}

function comparisons() {
  const ops: [string, (a: number, b: number) => boolean][] = [
    ["<", (a, b) => a < b],
    [">", (a, b) => a > b],
    ["<=", (a, b) => a <= b],
    [">=", (a, b) => a >= b],
  ]
  return ops.map(([name, test]) =>
    primitive(
      name,
      (args) => {
        const values = numbers(args)
        return values.every((value, i) => i === 0 || test(values[i - 1], value))
      },
      { sig: "Number Number ... -> Bool" },
    ),
  )
}

function predicates() {
  const tests: [string, (x: Value) => boolean][] = [
    ["number?", (x) => typeof x === "number"],
    ["integer?", (x) => Number.isInteger(x)],
    ["string?", (x) => typeof x === "string"],
    ["boolean?", (x) => typeof x === "boolean"],
    ["symbol?", isSym],
    ["keyword?", isKeyword],
    ["list?", isList],
    ["pair?", (x) => isList(x) && x.length > 0],
    ["vector?", isVector],
    ["sequence?", isSequence],
    ["map?", isMap],
    ["procedure?", isProcedure],
    ["stream?", isStream],
    ["void?", (x) => x === undefined],
    ["zero?", (x) => x === 0],
  ]
  return tests.map(([name, test]) => primitive(name, ([x]) => test(x), { sig: "Any -> Bool" }))
}

async function mapEach([f, ...lists]: Value[], context: CallContext) {
  const columns = lists.map((list) => itemsOf(list))
  const length = Math.min(...columns.map((column) => column.length))
  const out: Value[] = []
  for (let i = 0; i < length; i++)
    out.push(
      await context.call(
        f,
        columns.map((column) => column[i]),
      ),
    )
  return out
}

async function filterEach(f: Value, xs: Value, context: CallContext, keep: boolean) {
  const out: Value[] = []
  for (const item of itemsOf(xs)) if (isTruthy(await context.call(f, [item])) === keep) out.push(item)
  return out
}

async function sortAsync(items: Value[], less: Value, context: CallContext): Promise<Value[]> {
  if (items.length <= 1) return [...items]
  const isLess = async (a: Value, b: Value) =>
    less === undefined ? (typeof a === "number" && typeof b === "number" ? a < b : show(a, false) < show(b, false)) : isTruthy(await context.call(less, [a, b]))
  const middle = Math.floor(items.length / 2)
  const [left, right] = [await sortAsync(items.slice(0, middle), less, context), await sortAsync(items.slice(middle), less, context)]
  const out: Value[] = []
  while (left.length && right.length) out.push((await isLess(right[0], left[0])) ? right.shift()! : left.shift()!)
  return [...out, ...left, ...right]
}

function getIn(coll: Value, key: Value): Value {
  if (isMap(coll)) return mapGet(coll, key)
  if (isSequence(coll) && typeof key === "number") return itemsOf(coll)[key]
  if (typeof coll === "string" && typeof key === "number") return coll[key]
  return undefined
}

function pairsToMap(args: Value[]) {
  return makeMap(pairsOf(args))
}

function pairsOf(args: Value[]): [Value, Value][] {
  if (args.length % 2) fail("expected keys and values in pairs")
  return Array.from({ length: args.length / 2 }, (_, i) => [args[2 * i], args[2 * i + 1]])
}

function asMap(value: Value): LispMap {
  return isMap(value) ? value : fail(`expected a map, got ${show(value)}`)
}

function firstOf(xs: Value, name: string) {
  const items = itemsOf(xs)
  return items.length ? items[0] : fail(`${name} of an empty list`)
}

function rangeOf(start: number, end: number) {
  return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i)
}

function num(value: Value): number {
  return typeof value === "number" ? value : fail(`expected a number, got ${show(value)}`)
}

function numbers(values: Value[]) {
  return values.map(num)
}

function str(value: Value): string {
  return typeof value === "string" ? value : fail(`expected a string, got ${show(value)}`)
}
