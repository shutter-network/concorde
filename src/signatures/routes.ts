/**
 * Two plugins, because they go on two Fastify instances, and both at no prefix. The path is part of
 * a contract whose other half is the artifact: a client hands `…/jwks.json` to its own JOSE library
 * and expects RFC 7517's container back. Neither path nor prefix is configurable, and neither
 * plugin is exported.
 *
 * | Agent server | Answers |
 * | --- | --- |
 * | `POST /sign` | 200, the Signed Statement; 400 |
 *
 * | Public server | Answers |
 * | --- | --- |
 * | `POST /verify` | 200, the verdict; 400; 401 |
 * | `GET /jwks.json` | 200, the JWK Set. **No Token**; 400 |
 *
 * `GET /jwks.json` is the stated exception to the single 401 of Users on the Public server,
 * and the exception is the point: the whole audience for this identity is a third party with no
 * Token to present. Signing has no public route at all, because only the Shared Agent may make an
 * artifact. Checking one is open to any Token holder, since asking reveals nothing they could not
 * work out from the key set themselves.
 *
 * Three of the description strings below carry more weight than the rest, and each is hoisted to a
 * named constant so that it is edited as prose rather than found inside a template literal: what a
 * signature does not prove, what a `typ` is and is not, and what the lazy check is worth.
 */

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

/** RFC 7517's container. Why a Set for one key is at the construction site in `signatures.ts`. */
export type KeySet = {
  readonly keys: readonly JsonWebKey[];
};

/**
 * What `POST /sign` needs of the Component, which is one call and nothing that holds a key. A
 * route group that could reach the key would be one somebody could later have hand it out.
 */
export type StatementSigning = {
  sign(typ: string, claims: SignedClaims): Promise<string>;
};

export type ArtifactCheck = {
  verify(jws: string): Promise<Verdict>;
};

/**
 * A union rather than one shape with two optional members. The verification reads the header and
 * the payload out of the artifact, so they exist exactly when the verdict is `true` and there is no
 * state in which one is known and the verdict is not.
 */
export type Verdict =
  | { readonly verified: false }
  | {
      readonly verified: true;
      readonly header: unknown;
      readonly payload: unknown;
    };

// Its own sentence, because the obvious guess here is `?kid=`, which a client's key-set helper can
// have, and what that caller needs to hear is that there is nothing to select by.
const rejectKeySetQuery = unknownQueryRefusal(
  "There is nothing to select here: the Shared Agent has one keypair, with no identifier and no rotation, so the whole set is the whole answer.",
);

// Shared by the two body routes and naming neither, the two being on different servers. What
// somebody who wrote `?statement=…` needs to hear is that the request is a body.
const rejectBodyRouteQuery = unknownQueryRefusal(
  "Everything this route takes is in its body, and there is nothing here to select, filter or page.",
);

/**
 * A positive list of public members, and the second of the two things standing between a wrong
 * argument and `d` being served from an unauthenticated route. The first is `createPublicKey` in
 * the constructor, and neither is sufficient alone: a response schema is a serializer, so
 * `fast-json-stringify` drops every member not declared here, which for once is doing a job rather
 * than being survived.
 *
 * The list covers what a public JWK of any asymmetric type carries rather than only what today's
 * key needs: `y` for the second EC coordinate, `n` and `e` for RSA. A shorter list would silently
 * truncate somebody's key set, and truncation here reads as a corrupt key.
 *
 * Only `kty` is required, being the one member every key type has. There is no `kid`: the keypair
 * is the identity, and a name beside it would answer the same question twice.
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

const keySetSchema = {
  type: "object",
  properties: { keys: { type: "array", items: jwkSchema } },
  required: ["keys"],
} as const;

// Generic on purpose: the framework knows the agent signs things and nothing about what kinds of
// things they are, so the default says the one true thing.
const statementTyp = "saf-statement+jws";

/**
 * `minLength: 1` so that an empty commitment is a 400 rather than a signed nothing, and no
 * `maxLength`, Fastify's `bodyLimit` being the bound and the Operator's to raise.
 *
 * Duplicated beside a Decision's Statement rather than hoisted into `route-conventions.ts`, which
 * holds what the components agree about the shape of a *request*. "A Statement is a non-empty
 * string" is a fact about the domain, and each component may say it for itself.
 */
const statementSchema = { type: "string", minLength: 1 } as const;

/**
 * 128 characters: longer than any media type anybody writes, short enough to keep a megabyte out of
 * a protected header. That is the whole of the validation and it is not a policy, so any label of
 * that shape is signed, `saf-decision+jws` included.
 *
 * `default` is applied by Fastify's ajv under `useDefaults`, so the handler reads a `typ` on every
 * request. The same mechanism `limit` uses on every list in the framework.
 */
const typSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  default: statementTyp,
  description: `What kind of thing this artifact is. It goes into the **protected header**, so the signature covers it. Swapping it invalidates the artifact, which keeps a receipt from being presented as an approval.\n\n**Any label, \`saf-decision+jws\` included.** Domain separation between your *own* categories, such as receipts, votes and approvals, is something only you can express. Give each of them a label of its own, or they collapse into one domain and become replayable as each other. Defaults to \`${statementTyp}\`.`,
} as const;

// No field for the payload: what is signed is `{ statement }` and the header, so a caller wanting
// more inside the artifact writes it into the Statement.
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

// `jws` and not `artifact` or `signature`: the string a caller has in hand came out of a `jws`
// field, on a Decision or on a signing, and a third name for one value is a mistake waiting.
const verifySchema = {
  type: "object",
  properties: { jws: { type: "string", minLength: 1 } },
  required: ["jws"],
  additionalProperties: false,
} as const;

/**
 * `header` and `payload` are declared as empty schemas: no `type` on either, which passes any JSON
 * through byte intact and renders in the document as "any". Constraining them would be this route
 * having an opinion about what the agent signs.
 *
 * Both are absent from `required` because both are absent from a `false` verdict. Reporting the
 * header of an artifact that is not ours would answer with the unverified assertions of a string
 * somebody posted.
 */
const verdictSchema = {
  type: "object",
  properties: {
    verified: {
      type: "boolean",
      description:
        "Whether this artifact carries a valid signature by **this** Shared Agent's key. `false` covers every way of not being ours at once: another identity's artifact, a tampered one, a wrong number of segments, malformed base64url and an unparseable header alike. None of them is an error, so none of them is a 4xx.",
    },
    header: {
      description:
        "The protected header the signature covers, as it was written: the algorithm, and the `typ` the signer chose. **`typ` is that signer's own claim about its artifact and not a guarantee of this framework's**. A `\"saf-decision+jws\"` here means this identity labelled it a Decision, not that it is shaped like one and not that a row exists. Only an artifact fetched from `GET /decisions` is guaranteed well-formed.",
    },
    payload: {
      description:
        "The claims the signature covers, parsed out of the bytes that were signed. A Statement signed at `POST /sign` carries `{ statement }`; a Decision carries `{ seq, createdAt, statement }`, so everything a Decision record holds can be read back out of the artifact alone.",
    },
  },
  required: ["verified"],
} as const;

// Both halves are load-bearing. The first is the mechanics: this is the URL a JOSE library
// consumes. The second says plainly what a signature proves, because a verifier who mistakes a
// cryptographic artifact for evidence about the agent's conduct has been misled by us.
const whatTheKeyIsFor =
  "The Shared Agent's public key, as a JWK Set (RFC 7517). It is what makes a Signed Statement checkable **without trusting this Gateway**. Fetch it once, keep it, and verify artifacts offline with any JOSE library in any language. That is the real verification path, and the only one worth anything to somebody who does not trust the Operator.\n\nOne keypair, always, so the set holds one key. There is no rotation, no key identifier and nothing to select between. What a valid signature proves is narrow. **The Operator committed to this Statement on the Shared Agent's behalf.** It says nothing whatever about how the agent behaved.";

// There is no version of this route that proves more: the answer comes from the Gateway, so
// believing it means trusting the Gateway, and the party this identity exists for is the one who
// does not. Stated in the document because of who most needs to read it, which is the caller who
// would otherwise hand a third party a screenshot of a `true`.
const whatTheCheckIsWorth =
  "A convenience, and **it proves less than it looks like it proves**. It answers one question: is this artifact this Shared Agent's? You have to believe the answer, because a dishonest Gateway says `true` to anything. So it is worth nothing to the party this identity exists for. That party does not trust the Operator. It is genuinely useful to a User, who trusts the Operator already. They want a quick confirmation without embedding a JOSE library.\n\n**Real verification is offline.** Fetch `GET /jwks.json` once, keep the key, and check the artifact yourself in whatever language you are already writing. That asks this Gateway nothing. The path is open to anybody holding the string, needs no Token, and keeps working after this deployment is gone.";

/**
 * `POST /sign` and not a key the agent holds. The agent is a container over HTTP, and the key is
 * deliberately on this side of that boundary: a compromise of the container mints nothing once the
 * Gateway is stopped, where a key handed to the agent signs forever.
 */
export function agentSignatureRoutes(signing: StatementSigning): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: { statement: string; typ: string } }>(
      "/sign",
      {
        schema: {
          tags: ["Signatures"],
          summary: "Sign a Statement",
          description: `Have any string signed with the Shared Agent's key, and receive one compact JWS back. **Nothing is stored.** There is no row afterwards and no route that lists what has been signed, so the artifact answered is the whole of what happened. Losing it means signing again. A commitment worth keeping is a Decision: \`POST /decisions\` signs it too, and numbers it, and keeps it.\n\nThe \`typ\` is yours, and **nothing is reserved**. Asking for \`saf-decision+jws\` here is allowed and is not a forgery. Publishing a Decision is an authority you already hold, so a decision-typed artifact minted here is that same authority exercised without a log row. What it is *not* is a promise to a verifier. \`typ\` is your signed claim about your own artifact, and only an artifact fetched from \`GET /decisions\` is guaranteed to be shaped like one.\n\nThe Statement has no length limit of ours. The server's own body limit is the bound, and it belongs to the Operator. ${unknownParameter}`,
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
      // 200 and not 201, because nothing was created: there is no resource behind this and nowhere
      // it could be fetched from again.
      //
      // The claims are built here rather than the body being passed along, and the difference is the
      // whole payload. `typ` is a header parameter, so a body forwarded whole would sign it into the
      // payload too, and every artifact would carry its own label in two places.
      async (request) => ({
        jws: await signing.sign(request.body.typ, { statement: request.body.statement }),
      }),
    );
  };
}

/**
 * `presentedUser` is the server's `requireUser`, taken as one option and not wrapped, extended or
 * re-implemented, so an unauthenticated check is the single 401 of Users.
 *
 * The Token is required and the User it names is then unused: it gates the surface rather than
 * scoping the answer, the Gateway not being a free signature oracle for whoever finds the port. The
 * key set beside it takes none, which is the pair worth seeing together.
 *
 * The hook runs at `preHandler`, after validation, so a missing body and an unknown query parameter
 * are answered before a Token is looked at. That leaks nothing: such a refusal names a field of the
 * route and never a User, and says nothing about the artifact, which nobody has looked at.
 */
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
          summary: "Check whether an artifact is this Shared Agent's",
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
      // The User the hook just verified is deliberately not read: an artifact belongs to nobody, so
      // there is nothing here to scope.
      async (request) => check.verify(request.body.jws),
    );

    fastify.get(
      "/jwks.json",
      {
        schema: {
          tags: ["Signatures"],
          summary: "Fetch the Shared Agent's public key",
          description: `${whatTheKeyIsFor}\n\n**No Token is required**, a public key being public. Besides the login itself, this is the one route on the Public server that asks for none. ${unknownParameter}`,
          response: {
            200: {
              ...keySetSchema,
              description:
                "The key set, holding the one key this Shared Agent signs with. It carries **no private member**: the schema is a positive list of public ones, so there is nothing here to keep secret and nothing to send it over TLS for.",
            },
            400: refused("A query parameter was written, and this route takes none."),
          },
        },
        preValidation: rejectKeySetQuery(),
      },
      // The same object every time, held since construction. The key does not change while the
      // process is running, and deriving it per request would produce the identical bytes.
      async () => keySet,
    );
  };
}
