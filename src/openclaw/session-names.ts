export function refusedSessionName(name: string): string | undefined {
  if (name.trim() === "") {
    return "Session name must not be blank";
  }
  if (name.length > 512) {
    return `Session name must not be over 512 characters; this one is ${name.length}`;
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
