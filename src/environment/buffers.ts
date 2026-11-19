export type BufferKind = "scratch" | "terminal" | "notes"

/** `cwd` and `running` belong to terminals: the directory the next command runs in, and the command running now. */
export type Buffer = { name: string; kind: BufferKind; text: string; cwd?: string; running?: string }

export type ShellRun = { command: string; cwd: string; signal: AbortSignal; onOutput(text: string): void }
export type ShellResult = { exitCode: number; cwd: string }

/** Runs one command to completion in `cwd`, streaming its output; resolves with the exit code and the directory it ended in. */
export type Shell = (run: ShellRun) => Promise<ShellResult>

export type CommandResult = { exitCode: number; output: string }

/** Older text is dropped past this, so a chatty process cannot grow a buffer without bound. */
const MAX_CHARS = 120_000

/**
 * Named buffers, Emacs style: a scratch buffer to start from, terminals that run shell commands one at a time in their own directory,
 * and notes. Commands in a terminal queue behind each other, whoever sends them.
 */
export function createBuffers({ shell, home, onChange }: { shell: Shell; home: string; onChange: () => void }) {
  const buffers = new Map<string, Buffer>()
  const queues = new Map<string, Promise<unknown>>()
  const running = new Map<string, AbortController>()
  create("scratch", "*scratch*")

  return { list: () => [...buffers.values()], get: (name: string) => buffers.get(name), create, append, kill, run, interrupt }

  /** Stops the command running in terminal `name`, whoever started it; the commands queued behind it then run. */
  function interrupt(name: string) {
    running.get(name)?.abort(new DOMException("interrupted", "AbortError"))
  }

  function create(kind: BufferKind, name?: string): Buffer {
    const base = name?.trim() || (kind === "terminal" ? "term" : "notes")
    let unique = base
    for (let n = 2; buffers.has(unique); n++) unique = `${base}-${n}`
    const buffer: Buffer = { name: unique, kind, text: "", ...(kind === "terminal" ? { cwd: home } : {}) }
    buffers.set(unique, buffer)
    onChange()
    return buffer
  }

  function append(name: string, text: string) {
    const buffer = buffers.get(name) ?? fail(`no buffer ${name}`)
    buffer.text = (buffer.text + text).slice(-MAX_CHARS)
    onChange()
  }

  function kill(name: string) {
    if (name === "*scratch*") fail("*scratch* stays")
    if (!buffers.delete(name)) fail(`no buffer ${name}`)
    onChange()
  }

  /** Runs `command` in terminal `name` once the commands before it finish; its output goes into the buffer as it arrives. */
  function run(name: string, command: string, signal: AbortSignal): Promise<CommandResult> {
    const buffer = buffers.get(name) ?? fail(`no buffer ${name}`)
    if (buffer.kind !== "terminal") fail(`${name} is not a terminal`)
    const previous = queues.get(name) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => execute(buffer, command, signal))
    queues.set(name, next)
    return next
  }

  async function execute(buffer: Buffer, command: string, signal: AbortSignal): Promise<CommandResult> {
    signal.throwIfAborted()
    const controller = new AbortController()
    const forward = () => controller.abort(signal.reason)
    signal.addEventListener("abort", forward, { once: true })
    running.set(buffer.name, controller)
    let output = ""
    buffer.running = command
    append(buffer.name, `${buffer.text && !buffer.text.endsWith("\n") ? "\n" : ""}${buffer.cwd} $ ${command}\n`)
    try {
      const { exitCode, cwd } = await shell({
        command,
        cwd: buffer.cwd!,
        signal: controller.signal,
        onOutput: (text) => {
          output += text
          append(buffer.name, text)
        },
      })
      buffer.cwd = cwd
      if (exitCode !== 0) append(buffer.name, `${output.endsWith("\n") || !output ? "" : "\n"}[exit ${exitCode}]\n`)
      return { exitCode, output }
    } catch (error) {
      if (!controller.signal.aborted) throw error
      append(buffer.name, `${output.endsWith("\n") || !output ? "" : "\n"}[${signal.aborted ? "stopped" : "interrupted"}]\n`)
      throw signal.aborted ? signal.reason : new Error("interrupted by you")
    } finally {
      signal.removeEventListener("abort", forward)
      running.delete(buffer.name)
      buffer.running = undefined
      onChange()
    }
  }
}

function fail(message: string): never {
  throw new Error(message)
}
