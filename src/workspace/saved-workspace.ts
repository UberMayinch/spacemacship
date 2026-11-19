import type { Setting } from "./knob-bar.ts"
import type { SavedUnit } from "./units.ts"

/** The intent, each paragraph's versions and locks, and the knobs, so a reload replays the loaded code instead of asking the model again. */
export type SavedWorkspace = { intent: string; units: SavedUnit[]; knobs: Record<string, Setting> }

const KEY = "spacemacship:workspace"

export function loadWorkspace(): SavedWorkspace | undefined {
  try {
    const text = localStorage.getItem(KEY)
    return text ? (JSON.parse(text) as SavedWorkspace) : undefined
  } catch {
    return undefined
  }
}

export function saveWorkspace(workspace: SavedWorkspace) {
  try {
    localStorage.setItem(KEY, JSON.stringify(workspace))
  } catch {
    // Storage may be full or blocked; the workspace keeps running without it.
  }
}
