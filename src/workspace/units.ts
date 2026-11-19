import type { Lisp } from "../lisp/lisp.ts"
import { compileUnit, formsOf, loadCode, unload, type CompilePhase, type Control, type Loaded } from "./compiler.ts"

export type UnitStatus = "queued" | CompilePhase | "ready" | "failed" | "frozen"

/**
 * One paragraph of intent and the code it compiled to. `versions` are the codes that loaded, oldest first; `current` is the one loaded now.
 * Locked names keep their forms verbatim through every recompile; key phrases go to the compiler as must-honor; a frozen unit is never recompiled.
 */
export type Unit = {
  id: number
  text: string
  phrases: string[]
  lockedNames: string[]
  isFrozen: boolean
  versions: string[]
  current: number
  loaded?: Loaded
  status: UnitStatus
  draft: string
  errors: string[]
}

export type SavedUnit = Pick<Unit, "text" | "phrases" | "lockedNames" | "isFrozen" | "versions" | "current">

type UnitsOptions = {
  lisp: Lisp
  controls: () => Control[]
  environment: () => string
  onChange: () => void
}

/**
 * Keeps the units in step with the intent text and compiles them one at a time, in document order, so a paragraph can use what the ones
 * above it define. Editing a paragraph cancels its compile in flight and queues it again.
 */
export function createUnits({ lisp, controls, environment, onChange }: UnitsOptions) {
  let units: Unit[] = []
  let nextId = 1
  const queued = new Set<Unit>()
  let active: { unit: Unit; controller: AbortController } | undefined

  return {
    units: () => units,
    sync,
    recompile,
    recompileAll,
    step,
    toggleLock,
    toggleFreeze,
    addPhrase,
    removePhrase,
    unitAtOffset,
    isBusy: () => active !== undefined || queued.size > 0,
    save,
    restore,
  }

  /** Matches paragraphs to units: unchanged text keeps its unit as is, edited ones compile again, removed ones unload. */
  function sync(intent: string) {
    const paragraphs = paragraphsOf(intent)
    const unmatched = new Set(units)
    const next: (Unit | undefined)[] = paragraphs.map((text) => {
      const same = units.find((unit) => unmatched.has(unit) && unit.text === text)
      if (same) unmatched.delete(same)
      return same
    })
    const leftovers = units.filter((unit) => unmatched.has(unit))
    const result = next.map((unit, i) => {
      if (unit) return unit
      const reused = leftovers.shift()
      if (reused) {
        unmatched.delete(reused)
        reused.text = paragraphs[i]
        if (reused.isFrozen) reused.status = "frozen"
        else enqueue(reused)
        return reused
      }
      const created = blankUnit(paragraphs[i])
      enqueue(created)
      return created
    })
    for (const removed of unmatched) remove(removed)
    units = result
    onChange()
    pump()
  }

  function recompile(unit: Unit) {
    enqueue(unit)
    pump()
  }

  /** The code knobs changed: every unit that is not frozen is written again under them. */
  function recompileAll() {
    for (const unit of units) if (!unit.isFrozen) enqueue(unit)
    pump()
  }

  /** Scrubs to an earlier or later version of the unit's code and loads it in place of the current one. */
  async function step(unit: Unit, delta: number) {
    const index = unit.current + delta
    if (index < 0 || index >= unit.versions.length || active?.unit === unit) return
    const result = await loadCode(lisp, originOf(unit), unit.versions[index], unit.loaded)
    if (result.loaded) {
      unit.loaded = result.loaded
      unit.current = index
      unit.errors = []
    } else unit.errors = result.errors
    onChange()
  }

  function toggleLock(unit: Unit, name: string) {
    unit.lockedNames = unit.lockedNames.includes(name) ? unit.lockedNames.filter((locked) => locked !== name) : [...unit.lockedNames, name]
    onChange()
  }

  function toggleFreeze(unit: Unit) {
    unit.isFrozen = !unit.isFrozen
    if (unit.isFrozen) {
      queued.delete(unit)
      if (active?.unit === unit) active.controller.abort()
      unit.status = "frozen"
    } else unit.status = unit.loaded ? "ready" : "failed"
    onChange()
  }

  function addPhrase(unit: Unit, phrase: string) {
    const trimmed = phrase.trim()
    if (!trimmed || unit.phrases.includes(trimmed)) return
    unit.phrases = [...unit.phrases, trimmed]
    if (!unit.isFrozen) recompile(unit)
    onChange()
  }

  function removePhrase(unit: Unit, phrase: string) {
    unit.phrases = unit.phrases.filter((other) => other !== phrase)
    if (!unit.isFrozen) recompile(unit)
    onChange()
  }

  /** The unit whose paragraph holds character `offset` of `intent`. */
  function unitAtOffset(intent: string, offset: number) {
    const before = paragraphsOf(intent.slice(0, offset)).length
    const isInGap = /\n\s*\n\s*$/.test(intent.slice(0, offset))
    return units[Math.max(0, isInGap ? before : before - 1)]
  }

  function save(): SavedUnit[] {
    return units.map(({ text, phrases, lockedNames, isFrozen, versions, current }) => ({ text, phrases, lockedNames, isFrozen, versions, current }))
  }

  /** Loads each unit's saved current version without asking the model; units with nothing saved compile. */
  async function restore(saved: SavedUnit[]) {
    units = saved.map((unit) => ({ ...blankUnit(unit.text), ...unit }))
    onChange()
    for (const unit of units) {
      const code = unit.versions[unit.current]
      if (code === undefined) {
        enqueue(unit)
        continue
      }
      const result = await loadCode(lisp, originOf(unit), code, undefined)
      unit.loaded = result.loaded
      unit.errors = result.errors
      unit.status = result.loaded ? (unit.isFrozen ? "frozen" : "ready") : "failed"
      onChange()
    }
    pump()
  }

  function enqueue(unit: Unit) {
    if (active?.unit === unit) active.controller.abort()
    queued.add(unit)
    unit.status = "queued"
  }

  function remove(unit: Unit) {
    queued.delete(unit)
    if (active?.unit === unit) active.controller.abort()
    unload(lisp, unit.loaded)
  }

  async function pump() {
    if (active) return
    const unit = units.find((candidate) => queued.has(candidate))
    if (!unit) return
    queued.delete(unit)
    const controller = new AbortController()
    active = { unit, controller }
    try {
      const input = {
        origin: originOf(unit),
        intent: unit.text,
        phrases: unit.phrases,
        locked: lockedFormsOf(unit),
        controls: controls(),
        environment,
      }
      const result = await compileUnit(lisp, input, unit.loaded, controller.signal, (phase, code) => {
        unit.status = phase
        unit.draft = code
        onChange()
      })
      if (!units.includes(unit)) return unload(lisp, result.loaded)
      unit.draft = result.code
      unit.errors = result.errors
      if (result.loaded) {
        unit.loaded = result.loaded
        unit.versions.push(result.code)
        unit.current = unit.versions.length - 1
        unit.status = "ready"
      } else unit.status = "failed"
    } catch (error) {
      if (!controller.signal.aborted) {
        unit.status = "failed"
        unit.errors = [(error as Error).message]
      }
    } finally {
      active = undefined
      onChange()
      pump()
    }
  }

  function lockedFormsOf(unit: Unit) {
    if (!unit.loaded) return []
    return formsOf(unit.loaded.code).flatMap((form) => (form.name && unit.lockedNames.includes(form.name) ? [form.text] : []))
  }

  function blankUnit(text: string): Unit {
    return { id: nextId++, text, phrases: [], lockedNames: [], isFrozen: false, versions: [], current: -1, status: "queued", draft: "", errors: [] }
  }
}

export function originOf(unit: Unit) {
  return `§${unit.id}`
}

function paragraphsOf(intent: string) {
  return intent
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
}
