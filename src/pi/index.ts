/**
 * Placeholder so the `/pi` subpath exports something of its own. Ticket 07
 * replaces it with the `pi` Runtime Adapter, and it should be deleted then.
 *
 * It used to re-export through `../scaffold.ts`, to prove that a relative `.ts`
 * import resolves in the repository, in `dist`, and from an installed package
 * alike. The root subpath proves that now: it reaches the Store through
 * `./store/index.ts` and `./store/store.ts`, and `npm run check:package` calls
 * into it from a scratch project.
 */
export function piScaffoldCheck(): "ok" {
  return "ok";
}
