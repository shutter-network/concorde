/**
 * The two secrets the User Manager holds, kept in opposite ways.
 *
 * A Token is 32 bytes of `randomBytes`, stored as a plain single-pass SHA-256 with no salt. It
 * already carries full entropy, so nothing stretches it. Verification is a lookup by the hash,
 * so the unique index does the comparison.
 *
 * A password is scrypt, from `node:crypto`, with its cost parameters stored in each digest. New
 * passwords get the current cost and old digests keep verifying at theirs, so there is no rehash on
 * login. Nothing here is exported from the package except `ScryptParameters`.
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * What a scrypt derivation costs, as the Operator states it and as each digest records it.
 *
 * `logN` rather than `N`, because the parameter must be a power of two. Every published
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
 * What a Gateway that says nothing about cost gets: OWASP's 32 MiB row.
 *
 * `N = 2^15, r = 8, p = 3`, which is around 200ms of one core. That cost is paid on every login.
 * A flood of wrong passwords is a load problem, and nothing in this framework rate limits it.
 */
export const defaultScryptParameters: ScryptParameters = {
  logN: 15,
  blockSize: 8,
  parallelism: 3,
};

/**
 * The most a stored digest may ask for, which is a bound on memory rather than a policy.
 *
 * A digest names its own parameters, so a row decides how much memory the next verification
 * allocates. The cap keeps a hand-edited row from turning a login into a gigabyte allocation. No
 * published recommendation reaches it.
 */
const maxLogN = 20;

/** 16 bytes, which is the salt length every scrypt recommendation names. */
const saltBytes = 16;

/** 32 bytes out, matching SHA-256's width. */
const digestBytes = 32;

/**
 * The parameters, checked. Each must be a positive integer, and `logN` within the bound above.
 *
 * @throws If a parameter is outside those bounds.
 */
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
 * Hashes a password, PHC-style: `$scrypt$ln=15,r=8,p=3$<salt>$<digest>`, both base64url.
 *
 * The parameters travel in the string, so this argument decides what new digests cost. Nothing
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
 * Verifies a password against a stored digest, at that digest's cost.
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

/** A Token as its holder sees it, and as the Gateway keeps it. */
export type MintedToken = {
  /** The only time this string exists. It is answered once and never stored. */
  readonly token: string;
  /** What goes in the row: SHA-256 of exactly the string above. */
  readonly hash: string;
};

/**
 * The fixed prefix every Token carries, so a leaked one is recognizable as this framework's.
 *
 * A reader sees it in a log, in a bug report, or in a secret scanner's output.
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
 * How a Token is stored and how it is looked up: one pass of SHA-256 over the whole string.
 *
 * The prefix is included, so verification is `where token_hash = …` and the index compares.
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
