import type { JsonWebKey } from "node:crypto";
import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import {
  bearerRequired,
  notAuthenticated,
  refused,
  unknownParameter,
  unknownQueryRefusal,
} from "../route-conventions.ts";
import type { SignedClaims } from "./signatures.ts";

export type KeySet = {
  readonly keys: readonly JsonWebKey[];
};

export type StatementSigning = {
  sign(typ: string, claims: SignedClaims): Promise<string>;
};

export type ArtifactCheck = {
  verify(jws: string): Promise<Verdict>;
};

export type Verdict =
  | { readonly verified: false }
  | {
      readonly verified: true;
      readonly header: unknown;
      readonly payload: unknown;
    };

const rejectKeySetQuery = unknownQueryRefusal(
  "There is nothing to select here: the shared agent has one keypair, with no identifier and no rotation, so the whole set is the whole answer.",
);

const rejectBodyRouteQuery = unknownQueryRefusal(
  "Everything this route takes is in its body, and there is nothing here to select, filter or page.",
);

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

const keySetSchema = {
  type: "object",
  properties: { keys: { type: "array", items: jwkSchema } },
  required: ["keys"],
} as const;

const statementTyp = "concorde-statement+jws";

const statementSchema = { type: "string", minLength: 1 } as const;

const typSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  default: statementTyp,
  description: `What kind of thing this artifact is. It goes into the **protected header**, so the signature covers it. Swapping it invalidates the artifact, which keeps a receipt from being presented as an approval.\n\n**Any label, \`concorde-decision+jws\` included.** Domain separation between your *own* categories, such as receipts, votes and approvals, is something only you can express. Give each of them a label of its own, or they collapse into one domain and become replayable as each other. Defaults to \`${statementTyp}\`.`,
} as const;

const signSchema = {
  type: "object",
  properties: { statement: statementSchema, typ: typSchema },
  required: ["statement"],
  additionalProperties: false,
} as const;

const signedStatementSchema = {
  type: "object",
  properties: {
    jws: {
      type: "string",
      description:
        'The **Signed Statement**: a compact JWS, `header.payload.signature`, base64url, one URL-safe string. Its payload is `{"statement":…}` and nothing else, with no number and no timestamp, both of those being a Decision\'s. Its protected header carries the algorithm and the `typ` that was asked for. Nothing was stored: this string is the whole of what happened, so keep it or hand it on.',
    },
  },
  required: ["jws"],
} as const;

const verifySchema = {
  type: "object",
  properties: { jws: { type: "string", minLength: 1 } },
  required: ["jws"],
  additionalProperties: false,
} as const;

const verdictSchema = {
  type: "object",
  properties: {
    verified: {
      type: "boolean",
      description:
        "Whether this artifact carries a valid signature by **this** shared agent's key. `false` covers every way of not being ours at once: another identity's artifact, a tampered one, a wrong number of segments, malformed base64url and an unparseable header alike. None of them is an error, so none of them is a 4xx.",
    },
    header: {
      description:
        "The protected header the signature covers, as it was written: the algorithm, and the `typ` the signer chose. **`typ` is that signer's own claim about its artifact and not a guarantee of this framework's**. A `\"concorde-decision+jws\"` here means this identity labelled it a Decision, not that it is shaped like one and not that a row exists. Only an artifact fetched from `GET /decisions` is guaranteed well-formed.",
    },
    payload: {
      description:
        "The claims the signature covers, parsed out of the bytes that were signed. A Statement signed at `POST /sign` carries `{ statement }`; a Decision carries `{ seq, createdAt, statement }`, so everything a Decision record holds can be read back out of the artifact alone.",
    },
  },
  required: ["verified"],
} as const;

const whatTheKeyIsFor =
  "The shared agent's public key, as a JWK Set (RFC 7517). It is what makes a Signed Statement checkable **without trusting this Gateway**. Fetch it once, keep it, and verify artifacts offline with any JOSE library in any language. That is the real verification path, and the only one worth anything to somebody who does not trust the Operator.\n\nOne keypair, always, so the set holds one key. There is no rotation, no key identifier and nothing to select between. What a valid signature proves is narrow. **The Operator committed to this Statement on the shared agent's behalf.** It says nothing whatever about how the agent behaved.";

const whatTheCheckIsWorth =
  "A convenience, and **it proves less than it looks like it proves**. It answers one question: is this artifact this shared agent's? You have to believe the answer, because a dishonest Gateway says `true` to anything. So it is worth nothing to the party this identity exists for. That party does not trust the Operator. It is genuinely useful to a User, who trusts the Operator already. They want a quick confirmation without embedding a JOSE library.\n\n**Real verification is offline.** Fetch `GET /jwks.json` once, keep the key, and check the artifact yourself in whatever language you are already writing. That asks this Gateway nothing. The path is open to anybody holding the string, needs no Token, and keeps working after this deployment is gone.";

export function agentSignatureRoutes(signing: StatementSigning): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: { statement: string; typ: string } }>(
      "/sign",
      {
        schema: {
          tags: ["Signatures"],
          summary: "Sign a Statement",
          description: `Have any string signed with the shared agent's key, and receive one compact JWS back. **Nothing is stored.** There is no row afterwards and no route that lists what has been signed, so the artifact answered is the whole of what happened. Losing it means signing again. A commitment worth keeping is a Decision: \`POST /decisions\` signs it too, and numbers it, and keeps it.\n\nThe \`typ\` is yours, and **nothing is reserved**. Asking for \`concorde-decision+jws\` here is allowed and is not a forgery. Publishing a Decision is an authority you already hold, so a decision-typed artifact minted here is that same authority exercised without a log row. What it is *not* is a promise to a verifier. \`typ\` is your signed claim about your own artifact, and only an artifact fetched from \`GET /decisions\` is guaranteed to be shaped like one.\n\nThe Statement has no length limit of ours. The server's own body limit is the bound, and it belongs to the Operator. ${unknownParameter}`,
          body: signSchema,
          response: {
            200: {
              ...signedStatementSchema,
              description:
                "The Signed Statement, which is the whole answer: this part kept no copy of it and no record that it was made, beyond one line in the log carrying the `typ` and a digest.",
            },
            400: refused(
              "`statement` is missing or empty, `typ` is empty or longer than 128 characters, or a query parameter was written.",
            ),
          },
        },
        preValidation: rejectBodyRouteQuery(),
      },
      async (request) => ({
        jws: await signing.sign(request.body.typ, { statement: request.body.statement }),
      }),
    );
  };
}

export function publicSignatureRoutes(
  keySet: KeySet,
  check: ArtifactCheck,
  presentedUser: preHandlerAsyncHookHandler,
): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: { jws: string } }>(
      "/verify",
      {
        schema: {
          tags: ["Signatures"],
          summary: "Check whether an artifact is this shared agent's",
          description: `${whatTheCheckIsWorth}\n\nAnswers **200 either way**. An artifact that is not ours is a \`false\` and not an error. That covers a foreign identity's artifact, a tampered one and a wrong number of segments. Malformed base64url and an unparseable header get the same answer. All of those arrive from a caller, and none of them is this Gateway failing. ${bearerRequired} ${unknownParameter}`,
          body: verifySchema,
          response: {
            200: {
              ...verdictSchema,
              description:
                "The verdict, and the artifact's own header and payload when it is ours. Both of those are read out of the bytes the signature covers, so they are what was signed rather than what was posted.",
            },
            400: refused("`jws` is missing or empty, or a query parameter was written."),
            401: refused(notAuthenticated),
          },
        },
        preHandler: presentedUser,
        preValidation: rejectBodyRouteQuery(),
      },
      async (request) => check.verify(request.body.jws),
    );

    fastify.get(
      "/jwks.json",
      {
        schema: {
          tags: ["Signatures"],
          summary: "Fetch the shared agent's public key",
          description: `${whatTheKeyIsFor}\n\n**No Token is required**, a public key being public. Besides the login itself, this is the one route on the Public server that asks for none. ${unknownParameter}`,
          response: {
            200: {
              ...keySetSchema,
              description:
                "The key set, holding the one key this shared agent signs with. It carries **no private member**: the schema is a positive list of public ones, so there is nothing here to keep secret and nothing to send it over TLS for.",
            },
            400: refused("A query parameter was written, and this route takes none."),
          },
        },
        preValidation: rejectKeySetQuery(),
      },
      async () => keySet,
    );
  };
}
