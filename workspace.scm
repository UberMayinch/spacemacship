;;; workspace.scm: how the workspace turns your intent into a running environment.
;;;
;;; Each paragraph you write is compiled by `compile-intent` into Lisp forms. The forms
;;; are checked against everything already loaded, repaired by the model if the checker
;;; rejects them, and only then loaded, with no effects allowed while loading: generated
;;; code can define tools and agents, but nothing runs until you or an agent calls it.
;;; Redefine anything here (ctrl+` opens this buffer) and the next compile uses it.

(define-schema Dimension
  (Or {:name String :kind "scale" :low String :high String}
      {:name String :kind "choice" :options (List String)}))

(define-schema Control {:dimension Dimension :position Number :strength Number})

(define-schema CompileRequest
  {:intent String
   :phrases (List String)
   :locked (List String)
   :controls (List Control)
   :environment String
   :repair? {:code String :errors (List String)}})

;;; Code dimensions: the knobs above the code. Each one changes how every unlocked
;;; paragraph is written the next time it compiles.

(define-dimension abstraction (choice inline helpers schemas)
  "Whether tools do everything in their body, factor helpers out, or declare data shapes first.")
(define-dimension strictness (scale "loosely typed" "fully typed")
  "How precise the signatures are: Any and String, or schemas and lists of exact types.")
(define-dimension reach (choice pure "uses llm" "uses the board")
  "What generated tools may do: compute only, ask a model, or share notes on the board.")
(define-dimension autonomy (scale "few steps" "many steps")
  "How long generated agents may run before they must answer.")

(define (grade-index position)
  (cond ((< position 0.2) 0)
        ((< position 0.4) 1)
        ((<= position 0.6) 2)
        ((<= position 0.8) 3)
        (else 4)))

(define (value-of control)
  (let* ((dimension (:dimension control))
         (position (:position control)))
    (if (= (:kind dimension) "choice")
        (nth (:options dimension) (min (- (length (:options dimension)) 1) (floor (* position (length (:options dimension))))))
        (nth (list (str "very " (:low dimension))
                   (str "somewhat " (:low dimension))
                   (str "midway between " (:low dimension) " and " (:high dimension))
                   (str "somewhat " (:high dimension))
                   (str "very " (:high dimension)))
             (grade-index position)))))

(define (strength-level strength)
  (cond ((< strength (/ 1 3)) "slight")
        ((< strength (/ 2 3)) "moderate")
        (else "strong")))

(define (control-line control)
  (str (:name (:dimension control)) ": " (value-of control) " (" (strength-level (:strength control)) ")"))

(define (message-block header lines)
  (if (empty? lines) '() (list (str header "\n" (string-join lines "\n")))))

;;; Compiling intent.

(define-prompt compile-prompt
  "You turn one paragraph of a user's intent into Spacemacship Lisp, which a checker validates and then loads into a running environment of tools and agents.

The language is Scheme with [vectors], {:key value} maps and :keywords. A keyword called as a function reads a map: (:city place). There is no JavaScript, no method call syntax, no I/O.

Output only Lisp forms: no prose, no markdown fences. Use these forms:

(define-tool (name param ...)
  (: ParamType ... -> ResultType ! (effect ...))
  \"What it does, written for the model that will call it.\"
  body ...)
  A tool is something an agent can call. The signature line is required. Its effects are ! pure, or a list of: llm (calls a model), store (uses the board). Types: String Number Bool Any (List T) {:key Type} or a schema name.

(define-agent name \"What it is for.\"
  {:instructions \"How it should work, step by step.\" :tools [tool-or-agent ...] :max-steps 6})
  An agent is a model in a loop that calls its tools. It may list other agents as tools to delegate to them.

(define (name param ...) body ...) for helpers, and (define-schema Name {:key Type}) for data shapes.

Useful built-ins: str, string-join, string-split, string-upcase, string-downcase, string-trim, string-contains?, string-replace, words, lines, map, filter, reduce, sort, take, length, get, assoc, list, range, number->string, string->number. These tools already exist: (ask-llm prompt) asks a model and returns its answer; (post-note topic text) and (read-notes topic) share notes on a board every agent can see.

Rules:
- Define what the paragraph asks for. Name things in kebab-case after what they do.
- Use only tools, agents, helpers and schemas listed under ENVIRONMENT or defined in your output, defined before use.
- Keep every form under LOCKED FORMS exactly as written, and do not define those names again.
- Honor every KEY PHRASE. CONTROLS set how the code is written; a strong control dominates, a slight one shows in one detail.
- Under REPAIR, rewrite the previous code so that every listed error is fixed.

EXAMPLE
User:
ENVIRONMENT
tool (ask-llm prompt) (: String -> String ! (llm)) ; Asks a model.

INTENT
A tool that counts the words in a text, and an agent that reports how long a passage is.
Assistant:
(define-tool (count-words text)
  (: String -> Number ! pure)
  \"Counts the words in a text.\"
  (length (words text)))

(define-agent length-reporter \"Reports how long a passage is.\"
  {:instructions \"Count the words of the passage you are given with count-words, then say how long it is in one sentence.\"
   :tools [count-words]
   :max-steps 4})")

(define (compile-message request)
  (string-join
   (append (list (str "ENVIRONMENT\n" (:environment request)))
           (message-block "KEY PHRASES" (:phrases request))
           (message-block "CONTROLS" (map control-line (:controls request)))
           (message-block "LOCKED FORMS" (:locked request))
           (if (has-key? request :repair)
               (list (str "REPAIR\nYour previous code:\n" (:code (:repair request))
                          "\n\nfailed with:\n" (string-join (:errors (:repair request)) "\n")))
               '())
           (list (str "INTENT\n" (:intent request))))
   "\n\n"))

(define-source (compile-intent request)
  (: CompileRequest -> (Stream String) ! (llm time))
  "Streams the Lisp source for one paragraph of intent."
  (if (flight?)
      (llm-stream {:system compile-prompt
                   :user (compile-message request)
                   :temperature 0.2
                   :max-tokens 4000})
      (sim-compile request)))

;;; Tools every environment starts with.

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

;;; How agents are told to work.

(define (agent-system-prompt agent)
  (str (:instructions agent)
       "\n\nYou are the agent " (:name agent) " in a shared environment."
       " Call your tools when they help; a tool that fails returns its error, so try another way."
       " When you are done, answer in plain text without calling a tool."))
