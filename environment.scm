;;; environment.scm: the policy of the Spacemacship environment.
;;;
;;; Loaded by the kernel process (npm run kernel) at start and whenever this file changes.
;;; Everything an agent does is a Lisp form: it proposes one, the checker reads its
;;; effects, and anything beyond the granted effects (shell, net) waits for your approval.
;;; You can scrub through alternative forms, edit one, or reject it with a note.

;;; Knobs on running agents. Changing one while an action is being written or waits for
;;; you writes that action again under the new setting.

(define-dimension approach (choice explore fix verify)
  "Whether the agent looks around first, goes straight at the problem, or checks its work.")
(define-dimension pace (scale careful fast)
  "Small safe steps, or larger ones with fewer checks.")
(define-dimension verbosity (scale terse chatty)
  "How much the agent says about what it is doing.")

(define (grade-index position)
  (cond ((< position 0.2) 0) ((< position 0.4) 1) ((<= position 0.6) 2) ((<= position 0.8) 3) (else 4)))

(define (value-of control)
  (let* ((dimension (:dimension control))
         (position (:position control)))
    (if (= (:kind dimension) "choice")
        (nth (:options dimension) (min (- (length (:options dimension)) 1) (floor (* position (length (:options dimension))))))
        (nth (list (str "very " (:low dimension)) (str "somewhat " (:low dimension))
                   (str "midway between " (:low dimension) " and " (:high dimension))
                   (str "somewhat " (:high dimension)) (str "very " (:high dimension)))
             (grade-index position)))))

(define (strength-level strength)
  (cond ((< strength (/ 1 3)) "slight") ((< strength (/ 2 3)) "moderate") (else "strong")))

(define (control-line control)
  (str (:name (:dimension control)) ": " (value-of control) " (" (strength-level (:strength control)) ")"))

(define (message-block header lines)
  (if (empty? lines) '() (list (str header "\n" (string-join lines "\n")))))

(define action-vocabulary
  "(shell \"command\")           run a command in your terminal; returns its exit code and output. Effect: shell.
(shell-in \"buffer\" \"command\") run a command in another terminal. Effect: shell.
(say \"text\")                 tell the user something.
(done \"summary\")             finish the current goal or message, with a one-line summary.
(read-buffer \"name\")         the recent text of a buffer.
(write-buffer! \"name\" \"text\") append text to a buffer.
(open-terminal \"name\")       open a new terminal buffer; returns its name.
(new-buffer \"name\")          open a notes buffer.
(start-agent 'name \"buffer\" \"goal\")  start another agent that lives in a buffer.
(send-agent 'name \"text\")    message a running agent.
(define-tool (name param ...) (: Type ... -> Type ! (effect ...)) \"doc\" body ...)  add a tool to the environment.
(let ((x (shell \"ls\"))) ...) compose actions; use str, lines, words, filter, map, string-contains? and the like.")

;;; Your requests in *scratch*.

(define-prompt interpret-prompt
  (str "You turn a user's request into Spacemacship Lisp that acts on a live environment of buffers, terminals and agents.

Output only Lisp, no prose and no markdown fences: one form, or several inside (begin ...).

You can use:
" action-vocabulary "
(define-agent name \"doc\" {:instructions \"...\" :tools [tool ...]})  define a task agent that calls tools.

Rules:
- Do exactly what is asked, nothing more. Prefer starting an agent in a terminal over running long sequences yourself.
- An agent's goal is a plain sentence; name commands it should run in backticks.
- Use only the buffers, agents and tools listed under ENVIRONMENT, or ones your code creates first.

EXAMPLE
User:
ENVIRONMENT
buffers: *scratch*

REQUEST
open a terminal called tests and start an agent there that runs the test suite and tells me what fails
Assistant:
(begin
  (open-terminal \"tests\")
  (start-agent 'tester \"tests\" \"Run `npm test`, then say which tests fail and why.\"))"))

(define (interpret-message request)
  (string-join
   (append (list (str "ENVIRONMENT\nbuffers: " (string-join (:buffers request) ", ")
                      "\nagents: " (if (empty? (:agents request)) "none" (string-join (:agents request) ", "))
                      "\n" (:tools request)))
           (message-block "ALREADY OFFERED (offer something different)" (:avoid request))
           (list (str "REQUEST\n" (:request request))))
   "\n\n"))

(define-source (interpret request)
  (: Map -> (Stream String) ! (llm time))
  "Streams the Lisp for one request typed in *scratch*."
  (if (flight?)
      (llm-stream {:system interpret-prompt :user (interpret-message request) :temperature 0.2 :max-tokens 1500})
      (sim-interpret request)))

;;; Agents that live in buffers.

(define-prompt action-prompt
  (str "You are an agent living in one buffer of a Spacemacship environment. You work toward your goal one action at a time. Each action is a single Lisp form; you will see its result before choosing the next.

Reply with exactly one Lisp form and nothing else: no prose, no markdown fences.

Actions:
" action-vocabulary "

Rules:
- Take one small step at a time and read each result before the next.
- Anything with the shell effect waits for the user's approval, so make each command worth approving.
- FOCUS is what the user wants you to pay attention to now; CONTROLS set how you work.
- When the goal or the latest message is handled, reply (done \"summary\").
- If the user rejected an action, read their note and do something else."))

(define (log-line entry)
  (str (:kind entry) ": " (:text entry)))

(define (action-message context)
  (string-join
   (append (list (str "GOAL\n" (:goal context))
                 (str "BUFFER\n" (:buffer context) (if (:is-terminal context) " (a terminal)" " (not a terminal)")))
           (message-block "FOCUS" (:focus context))
           (message-block "CONTROLS" (map control-line (:controls context)))
           (message-block "HISTORY" (map log-line (:log context)))
           (message-block "ALREADY OFFERED FOR THIS STEP (offer a different action)" (:avoid context))
           (list "Your next action:"))
   "\n\n"))

(define-source (propose-action context)
  (: Map -> (Stream String) ! (llm time))
  "Streams a resident agent's next action, as one Lisp form."
  (if (flight?)
      (llm-stream {:system action-prompt :user (action-message context) :temperature 0.3 :max-tokens 1200})
      (sim-propose context)))

;;; Tools every environment starts with, for task agents and for you.

(define-tool (ask-llm prompt)
  (: String -> String ! (llm))
  "Asks a language model and returns its answer."
  (if (flight?)
      (string-join (stream->list (llm-stream {:system "Answer briefly and precisely." :user prompt :temperature 0.3 :max-tokens 1000})) "")
      (str "(sim answer to: " prompt ")")))

(define-tool (post-note topic text)
  (: String String -> String ! (store))
  "Posts a note under a topic on the board that every agent can read."
  (board-post! topic text))

(define-tool (read-notes topic)
  (: String -> (List String) ! (store))
  "Reads every note posted under a topic."
  (board-read topic))

(define (agent-system-prompt agent)
  (str (:instructions agent)
       "\n\nYou are the agent " (:name agent) " in a shared environment."
       " Call your tools when they help; a tool that fails returns its error, so try another way."
       " When you are done, answer in plain text without calling a tool."))
