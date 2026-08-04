/**
 * Signatures' contribution to the Public server: the public key, and nothing else yet.
 *
 * One plugin, registered at **no prefix**, because the path is part of a contract whose other
 * half is the artifact: a client hands `…/jwks.json` to its own JOSE library and expects RFC
 * 7517's container to come back. Neither the path nor the prefix is configurable and the
 * plugin is not exported, on the HTTP Messenger's reasoning
 * ([ADR-0042](../../docs/adr/0042-a-signature-is-a-compact-jws.md), ADR-0034).
 *
 * | Public server | Answers |
 * | --- | --- |
 * | `GET /jwks.json` | 200, the JWK Set. **No Token**; 400 |
 *
 * **Unauthenticated on purpose.** Every other read on the Public server sits behind the User
 * Manager's single 401, and this is the stated exception: a public key is public, and the
 * whole audience for this identity is a third party who never touches the rest of the Gateway
 * and has no Token to present (ADR-0043).
 *
 * The route describes what it answers with, which is how somebody writing a verifier learns
 * the shape without reading the quickstart
 * ([ADR-0040](../../docs/adr/0040-the-gateway-describes-its-own-http-api.md)). The sentences
 * below are load-bearing prose rather than commentary: they are what `/openapi.json` serves,
 * and the sharpest of them is the one saying what a signature does **not** prove, which no
 * schema could convey and which a reader who skips it will get wrong in the direction that
 * matters.
 */

import type { JsonWebKey } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { refused, unknownParameter, unknownQueryRefusal } from "../route-conventions.ts";

/**
 * The JWK Set this part serves: RFC 7517's container, with the one key in it.
 *
 * A Set and not a bare JWK even though there is one key and there will only ever be one, so
 * that a client's remote-key-set helper consumes the URL with no glue code (ADR-0042).
 */
export type KeySet = {
  readonly keys: readonly JsonWebKey[];
};

/** The refusal this route answers an unknown query parameter with. */
const rejectUnknownQuery = unknownQueryRefusal(
  "There is nothing to select here: the Shared Agent has one keypair, with no identifier and no rotation, so the whole set is the whole answer.",
);

/**
 * One public JWK, written as **the members that may be answered**.
 *
 * A response schema is a serializer: Fastify compiles it with `fast-json-stringify`, which
 * drops every member the schema does not declare and says nothing about it (ADR-0040). Here
 * that fact is doing a job rather than merely being survived — this is a **positive list of
 * public members**, so the private scalar `d` cannot reach this route even if the wrong
 * `KeyObject` were exported into it. That is the worst failure available on this surface, and
 * the two things standing in front of it are `createPublicKey` in the constructor and this
 * list. Both are cheap and neither is sufficient alone.
 *
 * The list covers what a public JWK of any asymmetric type carries — `crv` and `x` for an
 * `OKP` or `EC` key, `y` for the second `EC` coordinate, `n` and `e` for `RSA` — rather than
 * only what today's key needs. A shorter list would be a positive list that silently truncated
 * somebody's key set, and truncation here reads as a corrupt key rather than as a missing
 * field.
 *
 * Only `kty` is required, because it is the only member every key type has. There is no `kid`,
 * for the reason there is no `key_id` on a Decision: the keypair **is** the identity, so a name
 * beside it would be a second answer to "which Shared Agent signed this" and a verifier would
 * have to decide what to do when the two disagreed (ADR-0041).
 */
const jwkSchema = {
  type: "object",
  properties: {
    kty: {
      type: "string",
      description:
        "The key type, in JOSE's own vocabulary rather than OpenSSL's: `OKP` for an Edwards key, `EC` for a NIST curve, `RSA` for an RSA key.",
    },
    crv: { type: "string" },
    x: { type: "string" },
    y: { type: "string" },
    n: { type: "string" },
    e: { type: "string" },
  },
  required: ["kty"],
} as const;

/** RFC 7517's container, which is what a client's key-set helper is written against. */
const keySetSchema = {
  type: "object",
  properties: { keys: { type: "array", items: jwkSchema } },
  required: ["keys"],
} as const;

/**
 * What this route is for, said to the person who will use it, and what it deliberately does
 * not establish.
 *
 * Both halves are load-bearing. The first is the mechanics: this is the URL a JOSE library
 * consumes. The second is the sentence ADR-0041 insists on stating unflatteringly, because a
 * verifier who mistakes a cryptographic artifact for evidence about the agent's conduct has
 * been misled by us rather than by themselves.
 */
const whatTheKeyIsFor =
  "The Shared Agent's public key, as a JWK Set (RFC 7517), which is what makes a Signed Statement checkable **without trusting this Gateway**: fetch this once, keep it, and verify artifacts offline with any JOSE library in any language. That is the real verification path, and it is the only one worth anything to somebody who does not trust the Operator.\n\nOne keypair, always, so the set holds one key: there is no rotation, no key identifier and nothing to select between. What a valid signature proves is narrow and worth stating plainly — **that the Operator committed to this Statement on the Shared Agent's behalf, and nothing whatever about how the agent behaved** (ADR-0041).";

/** Signatures' Public server routes, over the key set the constructor derived. */
export function publicSignatureRoutes(keySet: KeySet): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get(
      "/jwks.json",
      {
        schema: {
          tags: ["Signatures"],
          summary: "Fetch the Shared Agent's public key",
          description: `${whatTheKeyIsFor}\n\n**No Token is required**, a public key being public, and this is the one route on the Public server that asks for none besides the login itself. ${unknownParameter}`,
          response: {
            200: {
              ...keySetSchema,
              description:
                "The key set, holding the one key this Shared Agent signs with. It carries **no private member**: the schema is a positive list of public ones, so there is nothing here to keep secret and nothing to send it over TLS for.",
            },
            400: refused("A query parameter was written, and this route takes none."),
          },
        },
        preValidation: rejectUnknownQuery(),
      },
      // The same object every time, held since construction: the key does not change while
      // the process is running, and deriving it per request would be work done to produce
      // the identical bytes.
      async () => keySet,
    );
  };
}
