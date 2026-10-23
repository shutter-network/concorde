import { createHash, randomUUID } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";

export const httpAuthKind = 27235;

export type Signer = {
  readonly secretKey: Uint8Array;
  readonly publicKey: string;
};

export function signer(): Signer {
  const secretKey = generateSecretKey();
  return { secretKey, publicKey: getPublicKey(secretKey) };
}

export type CredentialParts = {
  readonly signer: Signer;
  readonly url: string;
  readonly method: string;
  readonly body?: unknown;
  readonly createdAt?: number;
  readonly kind?: number;
  readonly nonce?: string;
  readonly tags?: string[][];
};

export function nip98Header(parts: CredentialParts): string {
  return `Nostr ${nip98Token(parts)}`;
}

export function nip98Token(parts: CredentialParts): string {
  const tags = parts.tags ?? [
    ["u", parts.url],
    ["method", parts.method],
    ["nonce", parts.nonce ?? randomUUID()],
    ...(parts.body === undefined ? [] : [["payload", hashBody(parts.body)]]),
  ];
  const event = finalizeEvent(
    {
      kind: parts.kind ?? httpAuthKind,
      tags,
      content: "",
      created_at: parts.createdAt ?? Math.floor(Date.now() / 1000),
    },
    parts.signer.secretKey,
  );
  return Buffer.from(JSON.stringify(event), "utf8").toString("base64");
}

export function hashBody(body: unknown): string {
  const bytes = typeof body === "string" ? body : JSON.stringify(body);
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}
