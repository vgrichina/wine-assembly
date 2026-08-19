;; End-to-end probe module: renders RGBA pixels into shared memory.
;;
;; Compiled in the browser by lib/compile-wat.js, transferred to a Worker, and
;; instantiated there against a shared WebAssembly.Memory created on the page's
;; thread. The worker then blits the pixels it produces onto an OffscreenCanvas
;; transferred from the page — the same shape as the real GDI path in
;; lib/host-imports.js (_flushGdiSurfacePresentation: surface bytes -> rgbaRect
;; -> putImageData), minus the emulator.
;;
;; Kept deliberately small and free of the emulator's imports so a failure here
;; is unambiguous: WAT -> WASM -> worker -> canvas, nothing else.
(module
  (import "host" "memory" (memory 8192 8192 shared))

  ;; A gradient plus a per-frame moving band, so consecutive frames differ and
  ;; a still image on screen cannot be mistaken for a working animation.
  ;; base:  byte offset of the pixel buffer
  ;; w,h:   dimensions
  ;; tid:   which thread drew this (tints the band)
  ;; frame: animation phase
  ;; returns the number of pixels written
  (func (export "paint") (param $base i32) (param $w i32) (param $h i32)
                         (param $tid i32) (param $frame i32) (result i32)
    (local $x i32) (local $y i32) (local $p i32)
    (local $r i32) (local $g i32) (local $b i32) (local $band i32)
    (local.set $band (i32.rem_u (local.get $frame) (local.get $h)))
    (local.set $y (i32.const 0))
    (block $rows_done
      (loop $rows
        (br_if $rows_done (i32.ge_u (local.get $y) (local.get $h)))
        (local.set $x (i32.const 0))
        (block $cols_done
          (loop $cols
            (br_if $cols_done (i32.ge_u (local.get $x) (local.get $w)))
            (local.set $p (i32.add (local.get $base)
              (i32.mul (i32.const 4)
                (i32.add (i32.mul (local.get $y) (local.get $w)) (local.get $x)))))
            ;; gradient: red across, green down
            (local.set $r (i32.div_u (i32.mul (local.get $x) (i32.const 255)) (local.get $w)))
            (local.set $g (i32.div_u (i32.mul (local.get $y) (i32.const 255)) (local.get $h)))
            (local.set $b (i32.and (i32.mul (local.get $tid) (i32.const 96)) (i32.const 255)))
            ;; a 6px band at the animation phase, brightened
            (if (i32.lt_u (i32.sub (local.get $y) (local.get $band)) (i32.const 6))
              (then
                (local.set $r (i32.const 255))
                (local.set $g (i32.const 255))
                (local.set $b (i32.const 255))))
            (i32.store8 (local.get $p) (local.get $r))
            (i32.store8 offset=1 (local.get $p) (local.get $g))
            (i32.store8 offset=2 (local.get $p) (local.get $b))
            (i32.store8 offset=3 (local.get $p) (i32.const 255))
            (local.set $x (i32.add (local.get $x) (i32.const 1)))
            (br $cols)))
        (local.set $y (i32.add (local.get $y) (i32.const 1)))
        (br $rows)))
    (i32.mul (local.get $w) (local.get $h)))

  ;; Sum of every byte in the buffer. The page calls this on ITS OWN instance,
  ;; over the same memory, to confirm it can see what the worker's instance
  ;; wrote — the emulator's whole threading model in one assertion.
  (func (export "checksum") (param $base i32) (param $len i32) (result i32)
    (local $i i32) (local $sum i32)
    (block $done
      (loop $scan
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (local.set $sum (i32.add (local.get $sum)
          (i32.load8_u (i32.add (local.get $base) (local.get $i)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $scan)))
    (local.get $sum))
)
