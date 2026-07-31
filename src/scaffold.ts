/**
 * Placeholder so the package has something to export, resolve, type-check and
 * emit declarations for. No framework behaviour ships yet: ticket 02 replaces
 * this file with the Store, and it should be deleted then.
 *
 * It is a separate file on purpose. The re-exports in `index.ts` and
 * `pi/index.ts` are what prove that a relative `.ts` import resolves in the
 * repository, in `dist`, and from an installed package alike. Node runs such an
 * import directly by stripping types; `tsc` rewrites it to `.js` on emit.
 */
export function scaffoldCheck(): "ok" {
  return "ok";
}
