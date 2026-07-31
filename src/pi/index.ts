import { scaffoldCheck } from "../scaffold.ts";

/**
 * Placeholder so the `/pi` subpath exports something of its own. Ticket 07
 * replaces it with the `pi` Runtime Adapter, and it should be deleted then.
 */
export function piScaffoldCheck(): "ok" {
  return scaffoldCheck();
}
