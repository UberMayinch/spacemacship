;;; config.scm: everything Spacemacship does that you might want to change.
;;;
;;; Evaluated at boot, and again whenever this file changes on disk. Edit it in the
;;; REPL pane (ctrl+` to open): ctrl+enter evaluates the form at point,
;;; ctrl+shift+enter the whole buffer, ctrl+s saves. A redefinition takes effect at
;;; once: whatever was streaming from the old definition restarts under the new one.
;;;
;;; Signatures are optional. Write (: Param ... -> Result ! (effects)) as the first
;;; form of a definition and the checker holds the body to it when you evaluate it.
;;; Effects: llm (model calls), time (delays), net, store, ui. ! pure means none.

;;; Shapes of the data passed between the page and the sources. Sources declare
;;; them in their signatures; what a source streams is checked against them.

(define-schema Lead {:before String :keyword String :after String})

(define-schema Dimension
  (Or {:name String :kind "scale" :low String :high String}
      {:name String :kind "choice" :options (List String)}))

(define-schema Control {:dimension Dimension :position Number :strength Number})
(define-schema Steering {:leads (List Lead) :controls (List Control)})
(define-schema DimensionContext {:text String :leads (List Lead) :taken (List Dimension)})
(define-schema AttentionBox {:keyword Number :before Number :after Number})
(define-schema Focus {:kind (One-of "next sentence" "key phrase") :text String})
(define-schema Influence {:index Number :strength Number})
(define-schema RealizationRequest {:context String :sentences (List String) :asked (List Number) :control String})
(define-schema Realization {:index Number :confidence Number})
(define-schema RelevanceRequest {:story String :tip String :leads (List Lead)})
(define-schema Relevance {:index Number :relevance Number})

;;; Dimensions: the axes a future knob can tune, most consequential first.
;;; (scale low high) or (choice option ...); labels with spaces are strings.

(define-dimension tension (scale relaxed strained)
  "How strained the next passage feels.")
(define-dimension resolution (scale "open question" answered)
  "Whether the passage leaves its question open or answers it.")
(define-dimension pace (scale compressed expanded)
  "How much happens per sentence.")
(define-dimension mode (choice dialogue action description)
  "What the passage is mostly made of.")
(define-dimension focus (choice :characters)
  "Who the passage follows; the model names the story's characters.")
(define-dimension tone (choice wry tender somber wondrous))
(define-dimension distance (scale "outside view" "inside mind")
  "How close the narration sits to a character's thoughts.")
(define-dimension fortune (scale worsens improves))
(define-dimension surprise (scale expected unexpected))

;;; Continuing the story.

(define story-max-words 400)

(define-prompt story-prompt
  (str "Continue the story. The user message is its opening, which may stop mid-sentence.

- Output only the words that come next. Do not repeat the opening.
- Your first word directly follows the opening's last word.
- Plain text only. No title, markdown or commentary.
- At most " story-max-words " words. End on a complete sentence.

EXAMPLE
User: The alarm went off, but
Assistant:
it was not the one on her phone. Mara lay still and listened."))

(define-prompt steered-story-prompt
  (str "Continue the story. The user message may list KEY PHRASES and CONTROLS, then the story so far, which may stop mid-sentence.

- Output only the words that come next. Your first word directly follows the story's last word: if the story stops mid-sentence, finish that sentence first. Never repeat or restart any of the story so far, not even its last word: after \"…the door was still\" write \"locked, and…\", never \"still locked\" or \"The door was still locked\".
- Key phrases lead what happens next: build the continuation on them, most of all on the [bracketed] words.
- Controls set how the next passage reads. Each is a dimension given only by its name and its poles or options, so infer from the labels what to change in the events, focus or style. A scale gives a position between two poles: at an extreme, exaggerate that pole so a reader notices it within two sentences; midway, balance both. A choice names the option to follow. Each control ends with a strength in parentheses that sets how much it shapes the passage. Strong: it dominates every sentence. Moderate: a clear influence throughout. Slight: show it in one or two touches only, such as a single sentence or image, and otherwise write the passage as the story's own events, the key phrases and the stronger controls would have it; a slight control must never set the overall character of the passage. Strength is separate from the value and replaces the exaggeration rule: exaggerate a pole only at strong. Obey every control from the first sentence to the last, but never write a label itself as words of the story.
- With both, key phrases are the content and controls are the manner: what happens next grows out of the key phrases, whose bracketed words appear in the first two sentences, written in the controlled manner.
- Plain text only. No title, markdown or commentary.
- Write 120 to 300 words, never more than " story-max-words ". End on a complete sentence.

EXAMPLE
User:
KEY PHRASES
not the one on her [phone]

CONTROLS
tension: very strained

STORY SO FAR
Mara had locked the kitchen an hour ago. Now the alarm went off, but it was not the one on her phone. She lay still and
Assistant:
clawed for the phone anyway. Dark screen. The ringing did not stop."))

(define (grade-index position)
  "Which of the five grades a scale position is spoken as, from very low to very high."
  (cond ((< position 0.2) 0)
        ((< position 0.4) 1)
        ((<= position 0.6) 2)
        ((<= position 0.8) 3)
        (else 4)))

(define (option-index count position)
  (min (- count 1) (floor (* position count))))

(define (value-of control)
  "A control's value in words: a scale's grade, or a choice's selected option."
  (let* ((dimension (:dimension control))
         (position (:position control)))
    (if (= (:kind dimension) "choice")
        (nth (:options dimension) (option-index (length (:options dimension)) position))
        (let ((low (:low dimension))
              (high (:high dimension)))
          (nth (list (str "very " low)
                     (str "somewhat " low)
                     (str "midway between " low " and " high)
                     (str "somewhat " high)
                     (str "very " high))
               (grade-index position))))))

(define (strength-level strength)
  (cond ((< strength (/ 1 3)) "slight")
        ((< strength (/ 2 3)) "moderate")
        (else "strong")))

(define (lead-line lead)
  (str (:before lead) "[" (:keyword lead) "]" (:after lead)))

(define (control-line control)
  (let ((dimension (:dimension control)))
    (str (:name dimension) ": " (value-of control)
         (if (= (:kind dimension) "choice")
             (str " (options: " (string-join (:options dimension) ", ") ")")
             "")
         " (" (strength-level (:strength control)) ")")))

(define (message-block header lines)
  (if (empty? lines) '() (list (str header "\n" (string-join lines "\n")))))

(define (steered-message prefix steering)
  (string-join (append (message-block "KEY PHRASES" (map lead-line (:leads steering)))
                       (message-block "CONTROLS" (map control-line (:controls steering)))
                       (message-block "STORY SO FAR" (list prefix)))
               "\n\n"))

(define (steered? steering)
  (not (and (empty? (:leads steering)) (empty? (:controls steering)))))

(define-source (continue-story prefix steering)
  (: String Steering -> (Stream String) ! (llm time))
  "Streams the words that continue `prefix`, led by the key phrases and tuned by the controls."
  (if (flight?)
      (strip-echo prefix
                  (llm-stream {:system (if (steered? steering) steered-story-prompt story-prompt)
                               :user (if (steered? steering) (steered-message prefix steering) prefix)
                               :temperature 0.9
                               :max-tokens 2000}))
      (sim-continue prefix steering)))

;;; The fan menu: which dimensions a new future knob offers.

(define menu-size 5)
(define max-words-per-label 3)
(define characters-slot "<characters>")

(define-prompt dimension-menu-prompt
  "The user message has the start of a story, cut off where the reader is, sometimes the reader's key phrases (keyword in brackets), and a list of axes. Each axis is one way the next 100 words could vary, written as \"name: label | label\".

Pick the axes that matter most for what could happen next at this point, as many as asked, most important first. With key phrases, favor the axes that act on them. Output the picked lines unchanged, one per line, and nothing else.

The one exception is focus, which is who the passage follows: replace <characters> with each character present in the story, by name or in at most 3 words. Leave focus out when the story has no character yet.

EXAMPLE
User:
Story: Mara had locked the kitchen an hour ago. Now a chair scraped across its tiles, and her brother was not answering his phone. She lay still and
Axes:
tension: relaxed | strained
pace: compressed | expanded
mode: dialogue | action | description
focus: <characters> | narrator
fortune: worsens | improves
Pick 3.
Assistant:
tension: relaxed | strained
focus: Mara | her brother | narrator
mode: dialogue | action | description")

(define (characters-axis? axis)
  (and (= (:kind axis) "choice") (empty? (:options axis))))

(define (axis-line axis)
  (str (:name axis) ": "
       (cond ((= (:kind axis) "scale") (str (:low axis) " | " (:high axis)))
             ((characters-axis? axis) (str characters-slot " | narrator"))
             (else (string-join (:options axis) " | ")))))

(define (plain-label label)
  "Drops a parenthesised aside, which the model sometimes adds to a character."
  (string-trim (regex-replace (regex-replace label "\\(.*?\\)" "") "\\s+" " ")))

(define (valid-label? label)
  (and (not (= label ""))
       (not (= label characters-slot))
       (<= (length (words label)) max-words-per-label)))

(define (parse-axis line axes)
  "Reads a \"name: label | label\" line as one of `axes`, keeping its kind; #f when it is none of them or its labels do not fit."
  (let ((colon (string-index-of line ":")))
    (if (< colon 0)
        #f
        (let* ((name (string-downcase (string-trim (substring line 0 colon))))
               (axis (find (fn (a) (= (:name a) name)) axes))
               (labels (map plain-label (string-split (substring line (+ colon 1)) "|"))))
          (cond ((not axis) #f)
                ((not (every? valid-label? labels)) #f)
                ((= (:kind axis) "scale")
                 (and (= (length labels) 2)
                      {:name (:name axis) :kind "scale" :low (first labels) :high (second labels)}))
                (else
                 (and (<= 2 (length labels) 4)
                      {:name (:name axis) :kind "choice" :options (list->vector labels)})))))))

(define (lead-bullet lead)
  (str "- " (lead-line lead)))

(define (menu-message ctx free size)
  (str "Story: " (:text ctx) "\n"
       (if (empty? (:leads ctx))
           ""
           (str "Key phrases:\n" (string-join (map lead-bullet (:leads ctx)) "\n") "\n"))
       "Axes:\n" (string-join (map axis-line free) "\n")
       "\nPick " size "."))

(define-source (dimension-menu ctx)
  (: DimensionContext -> (Stream Dimension) ! (llm time))
  "Offers the free dimensions that matter most here, most relevant first. In flight the model picks and names the characters; axes it leaves out or garbles are filled in from the declared dimensions."
  (let* ((taken (map (fn (d) (string-downcase (:name d))) (:taken ctx)))
         (free (remove (fn (d) (member? (:name d) taken)) (dimensions)))
         (generic (remove characters-axis? free))
         (size (min menu-size (length generic))))
    (cond ((= size 0) (stream))
          ((flight?)
           (stream-take size
                        (stream-distinct-by :name
                                            (stream-append
                                             (stream-keep (fn (line) (parse-axis line free))
                                                          (stream-lines
                                                           (llm-stream {:system dimension-menu-prompt
                                                                        :user (menu-message ctx free size)
                                                                        :temperature 0.3
                                                                        :max-tokens 1500})))
                                             (stream-of generic)))))
          (else
           (sleep 150)
           (stream-of (take size generic))))))

;;; The other sources still call the kernel's built-in implementations; redefine
;;; any of them here to change what it does.

(define-source (attention text)
  (: String -> (Stream AttentionBox) ! (llm time))
  "Key phrases in the shown text that the next words depend on."
  (if (flight?) (live-attention text) (sim-attention text)))

(define-source (influence sentences focus)
  (: (List String) Focus -> (Stream Influence) ! (llm time))
  "How strongly each sentence connects to the focus."
  (if (flight?) (live-influence sentences focus) (sim-influence sentences focus)))

(define-source (realization request)
  (: RealizationRequest -> (Stream Realization) ! (llm time))
  "How surely each asked sentence delivers a future knob's setting."
  (if (flight?) (live-realization request) (sim-realization request)))

(define-source (relevance request)
  (: RelevanceRequest -> (Stream Relevance) ! (llm time))
  "How relevant each attention box's keyword is to the sentence under the knob."
  (if (flight?) (live-relevance request) (sim-relevance request)))
