import type { FnType, Schemas, Type } from "../lisp/types.ts"
import { fromLisp } from "../lisp/values.ts"

const MAX_DEPTH = 6

/** The JSON Schema a model sees for a tool's parameters, from the tool's Lisp signature: one property per parameter, all required. */
export function parametersOf(params: string[], signature: FnType, schemas: Schemas): object {
  return {
    type: "object",
    properties: Object.fromEntries(params.map((param, i) => [param, jsonSchemaOf(signature.params[i] ?? { t: "any" }, schemas)])),
    required: params,
    additionalProperties: false,
  }
}

export function jsonSchemaOf(type: Type, schemas: Schemas, depth = 0): object {
  if (depth > MAX_DEPTH) return {}
  const inner = (next: Type) => jsonSchemaOf(next, schemas, depth + 1)
  switch (type.t) {
    case "number":
      return { type: "number" }
    case "string":
    case "symbol":
    case "keyword":
      return { type: "string" }
    case "bool":
      return { type: "boolean" }
    case "void":
      return { type: "null" }
    case "map":
      return { type: "object" }
    case "list":
    case "stream":
      return { type: "array", items: inner(type.of) }
    case "record":
      return {
        type: "object",
        properties: Object.fromEntries(type.fields.map(({ key, type }) => [key, inner(type)])),
        required: type.fields.filter(({ isOptional }) => !isOptional).map(({ key }) => key),
      }
    case "literal":
      return { enum: [fromLisp(type.value)] }
    case "or":
      return type.options.every((option) => option.t === "literal")
        ? { enum: type.options.map((option) => (option.t === "literal" ? fromLisp(option.value) : undefined)) }
        : { anyOf: type.options.map(inner) }
    case "named": {
      const resolved = schemas(type.name)
      return resolved ? inner(resolved) : {}
    }
    default:
      return {}
  }
}

/** Model APIs allow letters, digits, `_` and `-` in tool names; Lisp names may also hold `?`, `!`, `*` and more. */
export function apiNameOf(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
}
