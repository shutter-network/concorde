/**
 * The two secrets this component holds want opposite treatment, and that is the part most likely
 * to be "corrected" later by somebody applying one rule to both
 * ([ADR-0030](../../docs/adr/0030-passwords-are-traded-for-bearer-tokens.md)).
 *
 * A Token is 32 bytes of `randomBytes`, stored as a plain single-pass SHA-256 with no salt. A KDF
 * exists to make a low-entropy input expensive to guess, and this input already carries 256 bits
 * of uniform entropy. Stretching it would add per-request cost for nothing, and a salt would
 * defend against a precomputed dictionary that cannot exist. Do not stretch it and do not salt it.
 *
 * A password is scrypt, chosen over argon2 and bcrypt because it is memory-hard, in the standard
 * library, and needs no native build in a package whose tarball check imports and calls every
 * runtime dependency. Its cost parameters travel inside each digest rather than being fixed in
 * code, and there is deliberately **no rehash on login**. That is not anticipating a migration: with
 * no account-recovery flow, fixed parameters could never be raised at all, because every existing
 * digest would become unverifiable and the only remedy would be a password reset for every User.
 *
 * Nothing here is exported from the package except `ScryptParameters`.
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * What a scrypt derivation costs, as the Operator states it and as each digest records it.
 *
 * `logN` rather than `N`, because the parameter must be a power of two and every published
 * recommendation is written that way. The other two are scrypt's own `r` and `p`, spelled out.
 */
export type ScryptParameters = {
  /** log₂ of the CPU/memory cost. Memory is `128 · 2^logN · blockSize` bytes. */
  readonly logN: number;
  /** scrypt's `r`. With `logN` it decides how much memory the derivation needs. */
  readonly blockSize: number;
  /** scrypt's `p`. Node runs the passes serially, so this multiplies the time. */
  readonly parallelism: number;
};

/**
 * OWASP's 32 MiB row: `N = 2^15, r = 8, p = 3`, around 200ms of one core.
 *
 * That cost is paid on every login, and a flood of wrong passwords is therefore a load problem.
 * Nothing in this framework rate limits one, deliberately: rate limiting belongs to the edge that
 * is already terminating TLS, and an in-process limiter does not survive a second Gateway process.
 */
export const defaultScryptParameters: ScryptParameters = {
  logN: 15,
  blockSize: 8,
  parallelism: 3,
};

// A bound on memory rather than a policy. A digest names its own parameters, so a row decides how
// much memory the next verification allocates, and this keeps a hand-edited row from turning a
// login into a gigabyte allocation. No published recommendation reaches it.
const maxLogN = 20;

// 16 bytes, the salt length every scrypt recommendation names.
const saltBytes = 16;

// 32 bytes out, matching SHA-256's width.
const digestBytes = 32;

/** @throws If a parameter is not a positive integer, or `logN` is above the bound above. */
export function checkedScryptParameters(parameters: ScryptParameters): ScryptParameters {
  const bounded =
    isCount(parameters.logN) &&
    parameters.logN <= maxLogN &&
    isCount(parameters.blockSize) &&
    isCount(parameters.parallelism);
  if (!bounded) {
    throw new Error(
      `scrypt parameters must be positive integers with logN at most ${maxLogN}, not ${JSON.stringify(parameters)}`,
    );
  }
  return parameters;
}

/**
 * PHC-style: `$scrypt$ln=15,r=8,p=3$<salt>$<digest>`, both halves base64url.
 *
 * The parameters travel in the string, so this argument decides what new digests cost and nothing
 * else in the system has to agree with it.
 */
export async function hashPassword(
  password: string,
  parameters: ScryptParameters,
): Promise<string> {
  const salt = randomBytes(saltBytes);
  const digest = await derive(password, salt, parameters);
  const cost = `ln=${parameters.logN},r=${parameters.blockSize},p=${parameters.parallelism}`;
  return `$scrypt$${cost}$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

/**
 * Verifies at the stored digest's own cost, which is what keeps old digests working.
 *
 * A digest this cannot parse answers `false` without deriving anything. Every digest in the table
 * was written by `hashPassword`, and so is the fixed digest a miss is verified against.
 */
export async function verifyPassword(digest: string, password: string): Promise<boolean> {
  const parsed = parseDigest(digest);
  if (parsed === undefined) return false;
  const derived = await derive(password, parsed.salt, parsed.parameters);
  // Length first, because `timingSafeEqual` throws on a mismatch rather than answering false.
  return derived.length === parsed.digest.length && timingSafeEqual(derived, parsed.digest);
}

/** A Token as its holder sees it, and as the Gateway keeps it. The plaintext is never stored. */
export type MintedToken = {
  readonly token: string;
  readonly hash: string;
};

// A fixed prefix so a leaked Token is recognizable as this framework's, in a log, in a bug report,
// or in a secret scanner's output.
const tokenPrefix = "saf_";

// 32 bytes: full entropy, which is what makes the storage above sufficient.
const tokenBytes = 32;

export function mintToken(): MintedToken {
  const token = `${tokenPrefix}${randomBytes(tokenBytes).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

// One pass of SHA-256 over the whole string, prefix included, so verification is
// `where token_hash = …` and the unique index does the comparison.
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

type ParsedDigest = {
  readonly parameters: ScryptParameters;
  readonly salt: Buffer;
  readonly digest: Buffer;
};

// `$scrypt$ln=…,r=…,p=…$<salt>$<digest>`, or `undefined` if it is not that.
function parseDigest(stored: string): ParsedDigest | undefined {
  const [empty, algorithm, cost, salt, digest, ...rest] = stored.split("$");
  if (empty !== "" || algorithm !== "scrypt" || rest.length > 0) return undefined;
  if (cost === undefined || salt === undefined || digest === undefined) return undefined;

  const named = new Map(
    cost.split(",").map((parameter) => {
      const [name, value] = parameter.split("=");
      return [name ?? "", Number(value)];
    }),
  );
  const parameters = {
    logN: named.get("ln") ?? Number.NaN,
    blockSize: named.get("r") ?? Number.NaN,
    parallelism: named.get("p") ?? Number.NaN,
  };
  try {
    checkedScryptParameters(parameters);
  } catch {
    return undefined;
  }
  return {
    parameters,
    salt: Buffer.from(salt, "base64url"),
    digest: Buffer.from(digest, "base64url"),
  };
}

function derive(password: string, salt: Buffer, parameters: ScryptParameters): Promise<Buffer> {
  const cost = 2 ** parameters.logN;
  const options = {
    N: cost,
    r: parameters.blockSize,
    p: parameters.parallelism,
    // Node refuses a derivation that needs more than `maxmem`, whose default is 32 MiB. The
    // default parameters sit exactly on that. Stated from the parameters themselves, with room
    // over the `128 · N · r` the algorithm needs.
    maxmem: 256 * cost * parameters.blockSize,
  };
  return new Promise((resolve, reject) => {
    scrypt(password, salt, digestBytes, options, (failure, key) =>
      failure ? reject(failure) : resolve(key),
    );
  });
}

function isCount(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
