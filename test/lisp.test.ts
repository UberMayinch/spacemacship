import assert from "node:assert/strict"
import { test } from "node:test"
import { createLisp } from "../src/lisp/lisp.ts"
import { show } from "../src/lisp/printer.ts"
import { metaOf, readAll } from "../src/lisp/reader.ts"

async function image() {
  const lisp = createLisp()
  await lisp.ready
  return lisp
}

async function run(source: string, lisp?: Awaited<ReturnType<typeof image>>) {
  const results = await (lisp ?? (await image())).evalText(source, "test.scm")
  const last = results.at(-1)!
  if (last.error) throw last.error
  return show(last.value)
}

async function failure(source: string, lisp?: Awaited<ReturnType<typeof image>>) {
  const results = await (lisp ?? (await image())).evalText(source, "test.scm")
  const error = results.find((result) => result.error)?.error
  assert.ok(error, `expected ${source} to fail`)
  return error
}

test("reader keeps spans and ids on compound forms and their items", () => {
  const [{ form, site }] = readAll('  (define x [1 :a "s"])', "buf")
  assert.deepEqual([site.start, site.end], [2, 23])
  const meta = metaOf(form)!
  assert.equal(meta.origin, "buf")
  assert.deepEqual(
    meta.children.map(({ start, end }) => [start, end]),
    [
      [3, 9],
      [10, 11],
      [12, 22],
    ],
  )
  assert.ok(meta.id > 0)
})

test("reader reports incomplete input with its site", () => {
  assert.throws(
    () => readAll("(foo (bar", "buf"),
    (error: { isIncomplete: boolean; site: { start: number } }) => error.isIncomplete && error.site.start === 5,
  )
  assert.throws(
    () => readAll("(foo]", "buf"),
    (error: { isIncomplete: boolean }) => !error.isIncomplete,
  )
})

test("arithmetic, data literals and printing", async () => {
  assert.equal(await run("(+ 1 2 (* 3 4))"), "15")
  assert.equal(await run('[1 (+ 1 1) :k "s"]'), '[1 2 :k "s"]')
  assert.equal(await run("{:a (+ 1 2) :b ['x]}"), "{:a 3 :b [x]}")
})

test("tail calls run in constant stack", async () => {
  assert.equal(await run("(define (loop n acc) (if (= n 0) acc (loop (- n 1) (+ acc 1)))) (loop 200000 0)"), "200000")
  assert.equal(await run("(let count ((i 0)) (if (< i 100000) (count (+ i 1)) i))"), "100000")
})

test("closures, let forms, cond and internal defines", async () => {
  assert.equal(await run("(define (adder n) (lambda (x) (+ x n))) ((adder 3) 4)"), "7")
  assert.equal(await run("(let* ((a 1) (b (+ a 1))) (list a b))"), "(1 2)")
  assert.equal(await run("(define (f x) (define y (* x 2)) (cond ((> y 5) 'big) (else 'small))) (list (f 1) (f 3))"), "(small big)")
  assert.equal(await run("(letrec ((even? (fn (n) (if (= n 0) #t (odd? (- n 1))))) (odd? (fn (n) (if (= n 0) #f (even? (- n 1)))))) (even? 1000))"), "#t")
})

test("quasiquote with unquote and splicing, in lists, vectors and maps", async () => {
  assert.equal(await run("(define xs '(2 3)) `(1 ,@xs ,(+ 2 2) [a ,(car xs)])"), "(1 2 3 4 [a 2])")
  assert.equal(await run("(let ((v 5)) `{:v ,v})"), "{:v 5}")
})

test("macros expand and can use gensym", async () => {
  const lisp = await image()
  await run("(define-macro (swap! a b) (let ((t (gensym))) `(let ((,t ,a)) (set! ,a ,b) (set! ,b ,t))))", lisp)
  assert.equal(await run("(define p 1) (define q 2) (swap! p q) (list p q)", lisp), "(2 1)")
})

test("errors point at the failing form and try catches them", async () => {
  const error = await failure("(define (f) (car '()))\n(f)")
  assert.match(error.message, /car of an empty list/)
  assert.equal(error.site?.origin, "test.scm")
  assert.equal(await run('(try (error "boom" 1) (catch e (str "caught: " e)))'), '"caught: boom 1"')
})

test("maps, keywords as functions and sequence functions", async () => {
  assert.equal(await run("(:b {:a 1 :b 2})"), "2")
  assert.equal(await run("(map (fn (x) (* x x)) [1 2 3])"), "(1 4 9)")
  assert.equal(await run("(filter odd? '(1 2 3 4 5))", await withOdd()), "(1 3 5)")
  assert.equal(await run("(reduce + 0 (range 5))"), "10")
  assert.equal(await run('(string-join (map string-upcase (string-split "a,b" ",")) "-")'), '"A-B"')
  assert.equal(await run("(sort '(3 1 2))"), "(1 2 3)")
})

test("streams are lazy, composable and collected", async () => {
  assert.equal(await run("(stream->list (stream-take 2 (stream-map (fn (x) (* 10 x)) (stream 1 2 3))))"), "(10 20)")
  assert.equal(await run('(stream->list (stream-lines (stream "a\\nb" "c\\n" "d")))'), '("a" "bc" "d")')
  assert.equal(await run("(stream->list (stream-take 3 (generate (fn (emit) (for-each emit '(1 2 3 4 5))))))"), "(1 2 3)")
  assert.equal(await run("(stream->list (stream-distinct-by identity (stream-append (stream 1 2) (stream 2 3))))"), "(1 2 3)")
})

test("the checker rejects calls that surely mismatch, before running", async () => {
  const lisp = await image()
  const error = await failure('(define (f) (+ 1 "two"))', lisp)
  assert.match(error.message, /argument 2 of \+ should be Number, got String/)
  assert.equal(lisp.has("f"), false)
  assert.match((await failure("(define (g x) (: Number -> String) (+ x 1))", lisp)).message, /should return String but returns Number/)
  assert.match((await failure("(define (h) (string-length 1 2))", lisp)).message, /takes 1 arguments, got 2/)
})

test("untyped code loads; typed boundaries check what it hands them", async () => {
  const lisp = await image()
  await run("(define (twice x) (: Number -> Number) (* 2 x)) (define (untyped v) (twice v))", lisp)
  assert.equal(await run("(untyped 4)", lisp), "8")
  assert.match((await failure('(untyped "x")', lisp)).message, /argument 1 of twice should be Number/)
})

test("effect rows: declared, inferred and enforced", async () => {
  const lisp = await image()
  const error = await failure("(define (nap) (: -> Void ! pure) (sleep 1))", lisp)
  assert.match(error.message, /uses effect time but declares ! pure/)
  await run("(define (napper) (sleep 1)) (define (calls-napper) (napper))", lisp)
  assert.match(await run("(describe->string 'calls-napper)", lisp), /effects: time \(inferred\)/)
  await run("(define (pure-caller f) (: Procedure -> Void ! pure) (f))", lisp)
  assert.match((await failure("(pure-caller (lambda () (sleep 1)))", lisp)).message, /sleep has effect time, which this scope does not declare/)
})

test("dimensions are declared, validated and announced as changes", async () => {
  const lisp = await image()
  const changes: string[][] = []
  lisp.onChange((names) => changes.push(names))
  await run('(define-dimension tension (scale relaxed strained) "How strained.")', lisp)
  await run('(define-dimension resolution (scale "open question" answered))', lisp)
  await run("(define-dimension focus (choice :characters))", lisp)
  assert.deepEqual(lisp.dimensions()[1], { name: "resolution", kind: "scale", low: "open question", high: "answered" })
  assert.deepEqual(lisp.dimensions()[2], { name: "focus", kind: "choice", options: [] })
  assert.match((await failure("(define-dimension bad (scale only))", lisp)).message, /a scale has a low and a high pole/)
  assert.match((await failure("(define-dimension bad (choice a b c d e))", lisp)).message, /a choice has 2 to 4 options/)
  await run('(define-dimension tension (scale relaxed strained) "How strained.")', lisp)
  await run("(define-dimension tension (scale calm tense))", lisp)
  assert.deepEqual(changes, [["dimension:tension"], ["dimension:resolution"], ["dimension:focus"], ["dimension:tension"]])
})

test("sources stream plain data, validated against their declared item type", async () => {
  const lisp = await image()
  const warnings: string[] = []
  lisp.onLog(({ kind, text }) => kind === "warning" && warnings.push(text))
  await run(
    `(define-schema Axis {:name String :kind (One-of "scale" "choice")})
     (define-source (axes ctx) (: Map -> (Stream Axis) ! (time))
       (sleep 1)
       (stream {:name (:text ctx) :kind "scale"} {:name 3 :kind "scale"} {:name "b" :kind "choice"}))`,
    lisp,
  )
  const items = await Array.fromAsync(lisp.callSource("axes", [{ text: "a" }], new AbortController().signal))
  assert.deepEqual(items, [
    { name: "a", kind: "scale" },
    { name: "b", kind: "choice" },
  ])
  assert.equal(warnings.length, 1)
})

test("aborting a source stops it mid-run, by returning or throwing", async () => {
  const lisp = await image()
  await run("(define-source (slow) (generate (fn (emit) (emit 1) (sleep 10000) (emit 2))))", lisp)
  const controller = new AbortController()
  const seen: unknown[] = []
  const started = performance.now()
  const consume = (async () => {
    for await (const item of lisp.callSource("slow", [], controller.signal)) {
      seen.push(item)
      controller.abort()
    }
  })()
  await consume.catch(() => {})
  assert.deepEqual(seen, [1])
  assert.ok(performance.now() - started < 1000)
})

test("a runaway loop yields to the event loop and can be cancelled", async () => {
  const lisp = await image()
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(lisp.evalText("(define (spin) (spin)) (spin)", "test.scm", { signal: controller.signal }))
})

test("redefinition with the same source is not a change", async () => {
  const lisp = await image()
  const changes: string[][] = []
  lisp.onChange((names) => changes.push(names))
  await run("(define (f) 1)", lisp)
  await run("(define (f) 1)", lisp)
  await run("(define (f) 2)", lisp)
  assert.deepEqual(changes, [["f"], ["f"]])
})

async function withOdd() {
  const lisp = await image()
  await run("(define (odd? n) (= (modulo n 2) 1))", lisp)
  return lisp
}

test("with keepGoing, forms before a syntax error still load", async () => {
  const lisp = await image()
  const results = await lisp.evalText("(define a 1)\n(define b (+ a 1)\n(define c 3)", "test.scm", { keepGoing: true })
  assert.equal(lisp.has("a"), true)
  assert.equal(lisp.has("c"), false)
  assert.match(results.at(-1)!.error!.message, /missing \)/)
})
