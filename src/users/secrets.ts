/**
 * The two secrets the User Directory holds, in one file so that they are read
 * together.
 *
 * They want **opposite** treatment, and that is the thing most likely to be
 * "corrected" later by someone applying one rule to both (ADR-0030), so the reason
 * each is stored the way it is sits beside it here rather than at either call site:
 *
 *  - A **Token** is 32 bytes of `randomBytes`, and is stored as a plain single-pass
 *    SHA-256 with no salt and no KDF. It already carries 256 bits of uniform
 *    entropy, so stretching it would add per-request cost for nothing and a salt
 *    would defend against a precomputed dictionary that cannot be built. It is
 *    verified by a **lookup by the hash**, so the unique index does the comparison
 *    and there is no per-row loop and no constant-time compare.
 *  - A **password** is scrypt, from `node:crypto` and therefore no dependency, with
 *    its cost parameters stored **with each digest**. Not in anticipation of a
 *    migration: with no account-recovery flow, parameters fixed in code could never
 *    change at all, because raising them would make every stored digest unverifiable
 *    and the only remedy is a password reset for every User, the one thing this
 *    framework has decided not to build. There is deliberately **no
 *    rehash-on-login**: new passwords get the current cost and old digests keep
 *    verifying at theirs.
 *
 * Internal to the part. Nothing here is exported from the package except
 * `ScryptParameters`, which an Operator needs in order to name the cost they
 * construct with; the digests themselves are never readable, only verifiable.
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * What a scrypt derivation costs, as the Operator states it and as each digest
 * records it.
 *
 * `logN` rather than `N` because the parameter must be a power of two and the log is
 * how every published recommendation is written; the other two are scrypt's own `r`
 * and `p`, spelled out because `r` beside a digest is unreadable a year later.
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
 * What a Gateway that says nothing about cost gets: OWASP's 32 MiB row,
 * `N = 2^15, r = 8, p = 3`, which is around 200ms of one core here.
 *
 * The cost is the point of it and it is paid on every login, so it is stated in the
 * quickstart as an operational fact rather than hidden: a flood of wrong passwords
 * is a load problem as well as a security one, and nothing in this framework rate
 * limits it (ADR-0030).
 */
export const defaultScryptParameters: ScryptParameters = {
  logN: 15,
  blockSize: 8,
  parallelism: 3,
};

/**
 * The most a **stored** digest may ask for, which is a bound on memory and not a
 * policy.
 *
 * A digest names its own parameters, so the number in a row decides how much memory
 * the next verification allocates. Every row was written by this code, but the cap
 * keeps a corrupted or hand-edited one from turning a login into a gigabyte
 * allocation, and it is high enough that no recommendation reaches it.
 */
const maxLogN = 20;

/** 16 bytes, which is the salt length every scrypt recommendation names. */
const saltBytes = 16;

/** 32 bytes out, matching SHA-256's width for no reason other than habit. */
const digestBytes = 32;

/** Reject a cost that scrypt would refuse, or that this code would not survive. */
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
 * Hashes a password, PHC-style: `$scrypt$ln=15,r=8,p=3$<salt>$<digest>`, both
 * base64url.
 *
 * The parameters travel in the string, so this function's own argument decides what
 * *new* digests cost and nothing else in the system has to agree with it.
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
 * Verifies a password against a stored digest, at **that digest's** cost.
 *
 * A digest this cannot parse answers `false` without deriving anything. That is the
 * one path here with a timing signature, and it is unreachable through the seam:
 * every digest in the table was written by `hashPassword`, and the fixed digest a
 * miss is verified against is written the same way.
 */
export async function verifyPassword(digest: string, password: string): Promise<boolean> {
  const parsed = parseDigest(digest);
  if (parsed === undefined) return false;
  const derived = await derive(password, parsed.salt, parsed.parameters);
  // Length first, because `timingSafeEqual` throws on a mismatch rather than
  // answering false.
  return derived.length === parsed.digest.length && timingSafeEqual(derived, parsed.digest);
}

/** A Token as its holder sees it, and as the Gateway keeps it. */
export type MintedToken = {
  /** The only time this string exists. It is answered once and never stored. */
  readonly token: string;
  /** What goes in the row: SHA-256 of exactly the string above. */
  readonly hash: string;
};

/**
 * The fixed prefix every Token carries, so that a leaked one is recognisable as a
 * credential of this framework's: in a log, a bug report, or a secret scanner.
 */
const tokenPrefix = "saf_";

/** 32 bytes: full entropy, which is what makes the storage below sufficient. */
const tokenBytes = 32;

/** A new Token, and the hash of it to store. */
export function mintToken(): MintedToken {
  const token = `${tokenPrefix}${randomBytes(tokenBytes).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

/**
 * How a Token is stored and how it is looked up: one pass of SHA-256 over exactly
 * the string the client holds, prefix included, so verification is `where token_hash
 * = …` and the index does the comparison.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

type ParsedDigest = {
  readonly parameters: ScryptParameters;
  readonly salt: Buffer;
  readonly digest: Buffer;
};

/** `$scrypt$ln=…,r=…,p=…$<salt>$<digest>`, or `undefined` if it is not that. */
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
    // Node refuses a derivation needing more than `maxmem`, whose default is 32 MiB
    // which the default parameters sit exactly on. Stated from the parameters
    // themselves, with room over the `128 · N · r` the algorithm needs, so raising
    // the cost does not fail with a message about a limit nobody set.
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
