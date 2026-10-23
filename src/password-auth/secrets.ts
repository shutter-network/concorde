import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export type ScryptParameters = {
  readonly logN: number;
  readonly blockSize: number;
  readonly parallelism: number;
};

export const defaultScryptParameters: ScryptParameters = {
  logN: 15,
  blockSize: 8,
  parallelism: 3,
};

const maxLogN = 20;

const saltBytes = 16;

const digestBytes = 32;

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

export async function hashPassword(
  password: string,
  parameters: ScryptParameters,
): Promise<string> {
  const salt = randomBytes(saltBytes);
  const digest = await derive(password, salt, parameters);
  const cost = `ln=${parameters.logN},r=${parameters.blockSize},p=${parameters.parallelism}`;
  return `$scrypt$${cost}$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

export async function verifyPassword(digest: string, password: string): Promise<boolean> {
  const parsed = parseDigest(digest);
  if (parsed === undefined) return false;
  const derived = await derive(password, parsed.salt, parsed.parameters);
  return derived.length === parsed.digest.length && timingSafeEqual(derived, parsed.digest);
}

export type MintedToken = {
  readonly token: string;
  readonly hash: string;
};

const tokenPrefix = "concorde_";

const tokenBytes = 32;

export function mintToken(): MintedToken {
  const token = `${tokenPrefix}${randomBytes(tokenBytes).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

type ParsedDigest = {
  readonly parameters: ScryptParameters;
  readonly salt: Buffer;
  readonly digest: Buffer;
};

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
