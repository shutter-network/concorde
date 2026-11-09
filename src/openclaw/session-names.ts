// The Session names the OpenClaw Runtime addresses, decided from what the daemon (2026.8.1) was
// observed to do with a session key rather than transcribed from a rule of its own. The daemon
// refuses only the empty key and one over 512 characters, and fails a Run whose key is a lone
// colon; everything else it accepts, and three things it normalises in silence: it lowercases the
// key, trims surrounding whitespace, and folds `global` into `main`. A name that does not come
// back as it went in is refused here, so that two Handler names are never one Session by surprise.

/** The daemon's own cap on a session key, measured before it prefixes `agent:<id>:`. */
export const longestSessionName = 512;

/**
 * Why `name` cannot be a Session under this Runtime, or `undefined` when it can. The reasons:
 *
 * - blank: the daemon refuses an empty key, and trims whitespace, so a whitespace-only name is
 *   the empty key
 * - over 512 characters: the daemon refuses it
 * - a colon: the daemon's key segment separator, so the name stays one segment and the daemon's
 *   own `agent:`, `subagent:`, `cron:` and `acp:` forms stay out of a Handler's reach
 * - `main` and `global`: the agent's main Session, where the daemon's heartbeats and channel
 *   traffic go; `global` is folded into `main`
 * - an uppercase letter: the daemon lowercases every key, so `User_42` and `user_42` would be
 *   one Session
 * - leading or trailing whitespace: the daemon trims it, so ` padded` and `padded` would be one
 *   Session
 */
export function refusedSessionName(name: string): string | undefined {
  if (name.trim() === "") {
    return "Session name must not be blank";
  }
  if (name.length > longestSessionName) {
    return `Session name must not be over ${longestSessionName} characters; this one is ${name.length}`;
  }
  if (name.includes(":")) {
    return "Session name must not contain a colon, the OpenClaw daemon's key segment separator";
  }
  if (name === "main" || name === "global") {
    return `Session name must not be "${name}", the OpenClaw agent's main Session`;
  }
  if (name !== name.toLowerCase()) {
    return "Session name must not contain an uppercase letter, since the OpenClaw daemon lowercases every session key";
  }
  if (name !== name.trim()) {
    return "Session name must not have leading or trailing whitespace, which the OpenClaw daemon trims";
  }
  return undefined;
}
