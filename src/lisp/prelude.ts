/** Loaded into every image before any config: the declaration forms, written as macros over kernel primitives. */
export const PRELUDE = `
(define-macro (define-dimension name spec . doc)
  "Declares a dimension future knobs can tune: (scale low high) or (choice option ...)."
  \`(register-dimension! ',name ',spec ,@doc))

(define-macro (define-schema name type)
  "Declares a data shape, checked wherever a signature names it and used to validate what sources stream."
  \`(register-schema! ',name ',type))

(define-macro (define-prompt name . body)
  "Defines a prompt: a string, or a procedure returning one."
  \`(define ,name ,@body))

(define (identity x) x)

(define (compose . fs)
  (if (null? fs)
      identity
      (lambda (x) ((car fs) ((apply compose (cdr fs)) x)))))
`
