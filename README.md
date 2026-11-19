# λ Spacemacship

A fork of [Spaceship IDE](https://github.com/chuanqisun/spaceship) by Chuanqi Sun (MIT, see `CITATION.cff`) that rebuilds its realtime steering on a live Lisp environment: every dimension, prompt and model source is a form in [`config.scm`](./config.scm) that you can read, redefine and evaluate while the text is streaming.

- Open the Lisp pane with `` ctrl+` `` (or `λ lisp` in the tray). The left side is `config.scm`; the right side is a REPL.
- In the buffer, `ctrl+enter` evaluates the top-level form at point, `ctrl+shift+enter` the whole buffer, and `ctrl+s` saves (to `config.scm` under `npm run dev`, to browser storage in a static build). Editing `config.scm` in your own editor reloads it too.
- A redefinition takes effect at once. Text streamed under the old definition is cut and generated again, and the fan menu is fetched again.
- Signatures are optional and gradual: `(: DimensionContext -> (Stream Dimension) ! (llm time))` as the first form of a definition is checked when you evaluate it, typed procedures check their arguments at run time, and a source's streamed items are validated against its declared schema. Effects (`llm`, `time`, `net`, `store`, `ui`) are inferred, checked against what a definition declares, and enforced while it runs.
- Sources never handle cancellation: each runs inside a cancel scope owned by the kernel, so moving a knob still aborts whatever is in flight.
- API keys stay in the TypeScript kernel. Lisp gets an `llm-stream` capability, not the key.
- `?safe` in the URL boots without `config.scm`, so the kernel's built-in sources run and a broken config can be fixed from inside the page.
- `npm test` runs the evaluator and config tests in Node.

Try `(describe 'dimension-menu)`, `(dimensions)`, or `(define-dimension dread (scale safe doomed))` in the REPL.

## Workspace: intent → Lisp → running agents

[`workspace.html`](./workspace.html) turns plain-language intent into an environment of tools and agents.

- Write one paragraph per thing you want. Each paragraph compiles (via `compile-intent` in [`workspace.scm`](./workspace.scm)) to Lisp forms, which are checked against everything already loaded before anything loads. Checker or load errors go back to the model to repair, up to twice. Code loads with no effects allowed, so generated code can define things but nothing runs until you or an agent calls it.
- `define-tool` makes a typed Lisp procedure an agent can call. Its signature becomes the JSON schema the model sees, and its declared effects bound what it may do when called. `define-agent` makes a model-in-a-loop over a set of tools, which may include other agents.
- Steering: lock a form and it stays verbatim through every recompile. Select words and press `ctrl+l` to make them a key phrase the paragraph must honor. Freeze a paragraph to stop recompiling it. Code knobs (abstraction, strictness, reach, autonomy; declared with `define-dimension` in `workspace.scm`) rewrite every unlocked paragraph. `◀ ▶` scrubs between a paragraph's loaded versions.
- The environment column lists tools and agents, gives each agent a task box, and shows every run step by step: tool calls, results, delegated sub-runs, the answer. Runs can be stopped, and stopping cancels the model call in flight. Agents share a board (`post-note`, `read-notes`).
- From the REPL: `(run-agent 'editor "task")`, `(spawn-agent 'editor "task")`, `(tools)`, `(agents)`.
- Sim mode plays both the compiler and the agents' model, so the whole loop runs without keys; flight mode uses Cerebras with tool calling.

---

# 🕹️ Spaceship IDE

Steer your ideas in realtime, space pilot style!

![Screencast](./extra/screencast.gif)

## Demos

Watch on [Instagram](https://www.instagram.com/reels/DfyQPhFtW-z/) and [YouTube](https://www.youtube.com/watch?v=3WmNLWUmcnY). You can try the simulator at [https://chuanqisun.github.io/spaceship/](https://chuanqisun.github.io/spaceship/) with the option to go live with your API keys for Cerebras and Gemini. Keys stay in your browser local storage. Do it at your own risk.

## Conjecture

> In the near future, LLM and Decision Models will reach 60 FPS interactivity.

When that happens, what new interaction paradigms will unlock? This project demonstrates plausible and desirable interactions for that future.

1. **Focus monitor**: can we visualize what LLM is paying attention to, and use that to guide human's focus towards what's important?

   ![focus monitor](./extra/clips/focus-monitor.gif)

2. **Attention lock**: can we force LLM to pay more attention to specific phrases so as to bias its future behavior?

   ![attention lock](./extra/clips/attention-lock.gif)

3. **Future Vector Steering**: can we decompose the task into eigenvectors, independently tune each, and re-compose them to influence the incoming text?

   ![future steering](./extra/clips/future-steering.gif)

4. **Realtime re-generation**: when text generation is cheap and fast, can we explore alternative futures by scrubbing?

   ![realtime regeneration](./extra/clips/realtime-regeneration.gif)

## Design process

I used Claude Code for most of the implementation but stayed hands-on for the UI/UX. I iterate using interactive style swatch, a technique where I prompt AI to give me diverse options of designs, I provide feedback, and it iterates. You can see the design artifacts in the [extra page](https://chuanqisun.github.io/spaceship/extra/style-1.html).

To achieve the realtime experience, I have to use agreesive speculative generation and manage cache invalidation based on user interactions. For example, when the main knob moves backward, I have to empty future texts and cancel ongoing requests. There are many considerations like this throughout the system and that took a lot of human judgement - claude didn't one shot them.

## Theory

I'm currently focusing on systems that help human shape ideas in realtime. This project is a small step towards my [upcoming thesis](https://code.chuanqisun.com/master-thesis/) at the MIT Media Lab, where I investigate how semantic and symoblic systems can be coupled to enhance human creativity, agency, and joy of craft.

## Citation

If you build on this work, please cite it as:

```bibtex
@misc{sun2026spaceship,
  author       = {Sun, Chuanqi},
  title        = {Spaceship {IDE}: Steer Your Ideas in Realtime, Space Pilot Style},
  year         = {2026},
  publisher    = {GitHub},
  howpublished = {\url{https://github.com/chuanqisun/spaceship}},
  note         = {Demo: \url{https://chuanqisun.github.io/spaceship/}}
}
```

## Environment: buffers, terminals and agents that live in them

[`environment.html`](./environment.html) is the environment proper, backed by a kernel process on your machine: `npm run kernel` in one terminal, `npm run dev` in another, then open `/spaceship/environment.html`. Terminals start in the directory the kernel was started from, or in `SPACEMACSHIP_HOME`.

- You start with `*scratch*`. Type Lisp and it runs; type anything else and it is interpreted into Lisp (`interpret` in [`environment.scm`](./environment.scm)), e.g. "open a terminal called tests and start an agent there that runs \`npm test\`".
- Terminals run real shell commands, one at a time, keeping their directory between commands. You can type into them directly or interrupt them.
- `(start-agent 'name "buffer" "goal")` starts an agent that lives in that buffer until stopped. It works one action at a time, and each action is a Lisp form (`(shell "npm test")`, `(say ...)`, `(done ...)`, or a small program combining them). The checker reads each form's effects before it runs: anything using `shell` waits for your approval. You can scrub through alternative actions (scrubbing past the last one asks for another), edit one, or reject it with a note the agent reads.
- Steer agents while they run: knobs (approach, pace, verbosity, declared in `environment.scm`) and focus (select text in a buffer, press focus) rewrite the action being written or waiting for you. Message an agent to give it more work; it idles between messages.
- Agents can extend the environment, e.g. by proposing `define-tool` forms, which are checked like everything else.
- The kernel listens on 127.0.0.1 only and accepts requests only through the dev server's proxy, which adds a token the kernel writes to `.kernel-token` on every start; requests from other origins are refused. Your Cerebras key, entered from the tray, stays in the kernel's memory, or set `CEREBRAS_API_KEY` when starting it.
- Not yet: full-screen interactive programs (each command runs without a terminal attached), long-running servers inside a terminal (a command runs until it exits, up to ten minutes), and saving the environment across kernel restarts.
