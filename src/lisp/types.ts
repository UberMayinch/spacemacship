import { show } from "./printer.ts"
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
  isVector,
  itemsOf,
  keyword,
  mapGet,
  mapHas,
  type Value,
} from "./values.ts"

export type FnType = { t: "fn"; params: Type[]; rest?: Type; ret: Type; effects?: string[] }

/** Gradual: `any` is consistent with every type, both ways. Lists and vectors are one sequence type. */
export type Type =
  | { t: "any" | "number" | "string" | "bool" | "symbol" | "keyword" | "void" | "map" | "procedure" }
  | { t: "list"; of: Type }
  | { t: "stream"; of: Type }
  | { t: "record"; fields: Field[] }
  | { t: "literal"; value: Value }
  | { t: "or"; options: Type[] }
  | { t: "named"; name: string }
  | FnType

export type Field = { key: string; type: Type; isOptional: boolean }

export type Schemas = (name: string) => Type | undefined

/** Effects the kernel treats differently; a row is a subset, and the empty row is pure. */
export const EFFECTS = ["llm", "net", "time", "store", "ui", "shell"]

export const ANY: Type = { t: "any" }

const BASE: Record<string, Type> = {
  Any: ANY,
  Number: { t: "number" },
  String: { t: "string" },
  Bool: { t: "bool" },
  Boolean: { t: "bool" },
  Symbol: { t: "symbol" },
  Keyword: { t: "keyword" },
  Void: { t: "void" },
  Map: { t: "map" },
  Procedure: { t: "procedure" },
  List: { t: "list", of: ANY },
  Vector: { t: "list", of: ANY },
  Stream: { t: "stream", of: ANY },
}

export function parseType(form: Value): Type {
  if (isSym(form)) {
    if (form.name in BASE) return BASE[form.name]
    if (/^[A-Z]/.test(form.name)) return { t: "named", name: form.name }
    return fail(`unknown type ${form.name}: types are capitalized`)
  }
  if (typeof form === "string" || typeof form === "number" || typeof form === "boolean" || isKeyword(form)) return { t: "literal", value: form }
  if (isMap(form))
    return {
      t: "record",
      fields: [...form.entries.values()].map(([key, type]) => {
        if (!isKeyword(key)) return fail(`a record type's keys are keywords, got ${show(key)}`)
        const isOptional = key.name.endsWith("?")
        return { key: isOptional ? key.name.slice(0, -1) : key.name, type: parseType(type), isOptional }
      }),
    }
  if (isVector(form)) return { t: "list", of: form.items.length === 1 ? parseType(form.items[0]) : ANY }
  if (!isList(form) || !isSym(form[0])) return fail(`not a type: ${show(form)}`)
  const [head, ...args] = form
  switch (head.name) {
    case "quote":
      return { t: "literal", value: args[0] }
    case "List":
    case "Vector":
      return { t: "list", of: args.length ? parseType(args[0]) : ANY }
    case "Stream":
      return { t: "stream", of: args.length ? parseType(args[0]) : ANY }
    case "Or":
      return { t: "or", options: args.map(parseType) }
    case "One-of":
      return { t: "or", options: args.map((value) => ({ t: "literal", value })) }
    case "->":
    case ":":
      return parseSignature(args)
  }
  return fail(`not a type: ${show(form)}`)
}

/** `A B -> R ! (llm time)`: parameter types, an optional `T ...` rest, the result, and an optional effect row. */
export function parseSignature(items: Value[]): FnType {
  const arrow = items.findIndex((item) => isSym(item) && item.name === "->")
  if (arrow === -1) return fail("a signature needs ->, as in (: String -> Number)")
  const bang = items.findIndex((item) => isSym(item) && item.name === "!")
  const before = items.slice(0, arrow)
  const after = items.slice(arrow + 1, bang === -1 ? undefined : bang)
  if (after.length !== 1) return fail("a signature has exactly one result type after ->")
  const isRest = before.length > 0 && isSym(before.at(-1)!) && (before.at(-1) as { name: string }).name === "..."
  const params = (isRest ? before.slice(0, -2) : before).map(parseType)
  const rest = isRest ? parseType(before.at(-2)!) : undefined
  return { t: "fn", params, rest, ret: parseType(after[0]), effects: bang === -1 ? undefined : effectRowOf(items.slice(bang + 1)) }
}

function effectRowOf(items: Value[]): string[] {
  const row = items.length === 1 && isList(items[0]) ? items[0] : items
  const names = row.map((item) => (isSym(item) ? item.name : fail(`an effect is a symbol, got ${show(item)}`)))
  if (names.length === 1 && names[0] === "pure") return []
  for (const name of names) if (!EFFECTS.includes(name)) fail(`unknown effect ${name}; known: pure ${EFFECTS.join(" ")}`)
  return names
}

/** Why `value` does not conform to `type`, or undefined when it does. */
export function validate(value: Value, type: Type, schemas: Schemas): string | undefined {
  switch (type.t) {
    case "any":
      return
    case "number":
      return typeof value === "number" ? undefined : expected("a number", value)
    case "string":
      return typeof value === "string" ? undefined : expected("a string", value)
    case "bool":
      return typeof value === "boolean" ? undefined : expected("a boolean", value)
    case "symbol":
      return isSym(value) ? undefined : expected("a symbol", value)
    case "keyword":
      return isKeyword(value) ? undefined : expected("a keyword", value)
    case "void":
      return value === undefined ? undefined : expected("void", value)
    case "map":
      return isMap(value) ? undefined : expected("a map", value)
    case "procedure":
    case "fn":
      return isProcedure(value) ? undefined : expected("a procedure", value)
    case "stream":
      return isStream(value) || isSequence(value) ? undefined : expected("a stream", value)
    case "literal":
      return equal(value, type.value) ? undefined : expected(show(type.value), value)
    case "named": {
      const resolved = schemas(type.name)
      if (!resolved) return `unknown schema ${type.name}`
      const problem = validate(value, resolved, schemas)
      return problem && `not a ${type.name}: ${problem}`
    }
    case "list": {
      if (!isSequence(value)) return expected("a list or vector", value)
      for (const [index, item] of itemsOf(value).entries()) {
        const problem = validate(item, type.of, schemas)
        if (problem) return `item ${index}: ${problem}`
      }
      return
    }
    case "record": {
      if (!isMap(value)) return expected("a map", value)
      for (const { key, type: fieldType, isOptional } of type.fields) {
        if (!mapHas(value, keyword(key))) {
          if (isOptional) continue
          return `missing :${key}`
        }
        const problem = validate(mapGet(value, keyword(key)), fieldType, schemas)
        if (problem) return `:${key} ${problem}`
      }
      return
    }
    case "or": {
      const problems = type.options.map((option) => validate(value, option, schemas))
      if (problems.some((problem) => problem === undefined)) return
      return problems.length === 1 ? problems[0] : `none of ${type.options.map(showType).join(", ")} fits: ${problems.join("; ")}`
    }
  }
}

/** Whether a value of type `from` may flow where `to` is expected: false only when they surely cannot meet. */
export function consistent(from: Type, to: Type, schemas: Schemas, depth = 0): boolean {
  if (depth > 8 || from.t === "any" || to.t === "any") return true
  if (from.t === "named") return resolve(from, schemas, (type) => consistent(type, to, schemas, depth + 1))
  if (to.t === "named") return resolve(to, schemas, (type) => consistent(from, type, schemas, depth + 1))
  if (from.t === "or") return from.options.some((option) => consistent(option, to, schemas, depth + 1))
  if (to.t === "or") return to.options.some((option) => consistent(from, option, schemas, depth + 1))
  if (from.t === "literal") return to.t === "literal" ? equal(from.value, to.value) : validate(from.value, to, schemas) === undefined
  if (to.t === "literal") return false
  if (to.t === "procedure" || to.t === "fn") return from.t === "procedure" || from.t === "fn"
  if (from.t === "fn" || from.t === "procedure") return false
  if (to.t === "stream") return from.t === "stream" || from.t === "list" ? consistent(from.of, to.of, schemas, depth + 1) : false
  if (to.t === "list") return from.t === "list" && consistent(from.of, to.of, schemas, depth + 1)
  if (to.t === "map") return from.t === "map" || from.t === "record"
  if (to.t === "record") {
    if (from.t === "map") return true
    if (from.t !== "record") return false
    return to.fields.every(({ key, type, isOptional }) => {
      const field = from.fields.find((field) => field.key === key)
      return field ? consistent(field.type, type, schemas, depth + 1) : isOptional
    })
  }
  return from.t === to.t
}

export function showType(type: Type): string {
  switch (type.t) {
    case "list":
      return type.of.t === "any" ? "List" : `(List ${showType(type.of)})`
    case "stream":
      return type.of.t === "any" ? "Stream" : `(Stream ${showType(type.of)})`
    case "record":
      return `{${type.fields.map(({ key, type, isOptional }) => `:${key}${isOptional ? "?" : ""} ${showType(type)}`).join(" ")}}`
    case "literal":
      return show(type.value)
    case "or":
      return `(Or ${type.options.map(showType).join(" ")})`
    case "named":
      return type.name
    case "fn":
      return showSignature(type)
    default:
      return type.t === "bool" ? "Bool" : type.t[0].toUpperCase() + type.t.slice(1)
  }
}

export function showSignature({ params, rest, ret, effects }: FnType) {
  const parts = [...params.map(showType), ...(rest ? [showType(rest), "..."] : []), "->", showType(ret)]
  if (effects) parts.push("!", effects.length ? `(${effects.join(" ")})` : "pure")
  return `(: ${parts.join(" ")})`
}

/** The type a constant has, as precisely as the checker can use. */
export function typeOfValue(value: Value): Type {
  if (typeof value === "number") return { t: "number" }
  if (typeof value === "string") return { t: "string" }
  if (typeof value === "boolean") return { t: "bool" }
  if (value === undefined) return { t: "void" }
  if (isSym(value)) return { t: "literal", value }
  if (isKeyword(value)) return { t: "keyword" }
  if (isSequence(value)) return { t: "list", of: ANY }
  if (isMap(value)) return { t: "map" }
  if (isStream(value)) return { t: "stream", of: ANY }
  if (isProcedure(value)) return value.signature ?? { t: "procedure" }
  return ANY
}

function resolve(type: { name: string }, schemas: Schemas, then: (type: Type) => boolean) {
  const resolved = schemas(type.name)
  return resolved ? then(resolved) : true
}

function expected(what: string, value: Value) {
  return `expected ${what}, got ${show(value)}`
}
