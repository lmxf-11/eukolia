/**
 * Constants substituted by the bundler.
 *
 * `vite.config.ts` replaces these at build time, so they are not variables at runtime — the value is
 * written into the emitted source. The application builds with every one of them at its shipped
 * value; only probes override them, from the environment, which means changing one costs a rebuild.
 *
 * That cost is deliberate for `__EUKOLIA_NO_WIDGETS`. It is the switch behind the elimination test in
 * `ARCHITECTURE.md` §3.45, and two attempts to publish it as a *runtime* global failed silently: the
 * main process writing it at `did-start-loading` races the renderer's module evaluation, so the page
 * reported the switch as absent while the runner believed it was on. An A/B in that state compares
 * two identical configurations and produces a confident, meaningless number — which is what §3.40
 * did. A constant that can only change by rebuilding cannot disagree with itself.
 *
 * One practical note, paid for with 53 failing tests: **the test runner does not substitute these.**
 * A bare read of an unsubstituted constant is a `ReferenceError` at module load, so every consumer
 * must guard with `typeof __EUKOLIA_X !== 'undefined'` — which answers `'undefined'` for an
 * undeclared name instead of throwing, and lets the suite run with the shipped value.
 */
declare const __EUKOLIA_NO_WIDGETS: boolean
