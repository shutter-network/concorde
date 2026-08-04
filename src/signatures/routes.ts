/**
 * Signatures' contributions to the two servers: the signing, the lazy check, and the key.
 *
 * Two plugins and not one, because they are registered on different Fastify instances
 * listening on different addresses, and both at **no prefix**: the path is part of a contract
 * whose other half is the artifact, and a client hands `…/jwks.json` to its own JOSE library
 * and expects RFC 7517's container to come back. Neither path nor prefix is configurable and
 * neither plugin is exported, on the HTTP Messenger's reasoning
 * ([ADR-0042](../../docs/adr/0042-a-signature-is-a-compact-jws.md), ADR-0034).
 *
 * | Agent server | Answers |
 * | --- | --- |
 * | `POST /sign` | 200, the Signed Statement; 400 |
 *
 * | Public server | Answers |
 * | --- | --- |
 * | `POST /verify` | 200, the verdict, and it is a **convenience**; 400; 401 |
 * | `GET /jwks.json` | 200, the JWK Set. **No Token**; 400 |
 *
 * **Signing is the Agent server's alone and checking is not.** Only the Shared Agent may make
 * an artifact, so there is no public route that signs and no plan for one; anybody with a
 * Token may ask about one, because asking reveals nothing they could not work out for
 * themselves from the key set. `GET /jwks.json` is the stated exception to the User Manager's
 * single 401 on this server: a public key is public, and the whole audience for this identity
 * is a third party who never touches the rest of the Gateway and has no Token to present
 * (ADR-0042, ADR-0043).
 *
 * Nothing here authenticates anybody. The Agent server has no authentication at all
 * (ADR-0010), and `POST /verify` takes the User Manager's `requireUser` as **one option on the
 * route**, so every refusal there is the Manager's single 401 (ADR-0030).
 *
 * Each route describes what it answers with, which is how somebody writing a verifier learns
 * the shape without reading the quickstart
 * ([ADR-0040](../../docs/adr/0040-the-gateway-describes-its-own-http-api.md)). The sentences
 * below are load-bearing prose rather than commentary: they are what `/openapi.json` serves,
 * and three of them carry more weight than the rest — what a signature does **not** prove,
 * what a `typ` is and is not, and what the lazy check is worth. None of the three is
 * expressible as a schema, and a reader who skips any of them gets it wrong in the direction
 * that matters.
 */

import type { JsonWebKey } from "node:crypto";
import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import { refused, unknownParameter, unknownQueryRefusal } from "../route-conventions.ts";
import { authenticationFailed, bearerRequired } from "../users/routes.ts";
import type { SignedClaims } from "./signatures.ts";

/**
 * The JWK Set this part serves: RFC 7517's container, with the one key in it.
 *
 * A Set and not a bare JWK even though there is one key and there will only ever be one, so
 * that a client's remote-key-set helper consumes the URL with no glue code (ADR-0042).
 */
export type KeySet = {
  readonly keys: readonly JsonWebKey[];
};

/**
 * What `POST /sign` needs of the part, and no more: one call, and nothing that holds a key.
 *
 * A type of its own rather than the whole `Signatures`, for the reason Decisions writes
 * `DecisionOperations`: a route group that could reach the key would be a route group somebody
 * could later have hand it out.
 *
 * Named for the act and not for a **Signer**, which is on this Component's `_Avoid_` list in
 * `CONTEXT.md` and which ADR-0044 rejected by name. The rejection was about naming the
 * Component, and a narrowed seam is not that; the word is still not reintroduced here, because
 * a term rejected in one place and used in another is a glossary nobody can trust.
 */
export type StatementSigning = {
  sign(typ: string, claims: SignedClaims): Promise<string>;
};

/** What `POST /verify` needs of the part: one question asked of one artifact. */
export type ArtifactCheck = {
  verify(jws: string): Promise<Verdict>;
};

/**
 * What the check answers: whether the artifact is this Shared Agent's, and what it said if so.
 *
 * A union rather than one shape with two optional members, because the header and the payload
 * exist exactly when the verdict is `true`: they are read **out of the artifact** by the
 * verification itself, so there is no state in which one is known and the verdict is not.
 */
export type Verdict =
  | { readonly verified: false }
  | {
      readonly verified: true;
      readonly header: unknown;
      readonly payload: unknown;
    };

/**
 * The refusal `GET /jwks.json` answers an unknown query parameter with.
 *
 * The convention and its reasoning are in `route-conventions.ts`; the sentence the message ends
 * with is this route's, and it says outright that there is nothing to select by, since the
 * obvious guess — `?kid=` — is a parameter a client's key-set helper might well have.
 */
const rejectKeySetQuery = unknownQueryRefusal(
  "There is nothing to select here: the Shared Agent has one keypair, with no identifier and no rotation, so the whole set is the whole answer.",
);

/**
 * The refusal the two body routes answer an unknown query parameter with.
 *
 * Their own sentence rather than the one above, because "there is nothing to select" is the
 * wrong thing to say to somebody who wrote `?statement=…`: what they need to hear is that the
 * request is a body. Written so that it names neither route, since the two are on different
 * servers and a refusal that mentioned the other would be describing a surface the caller
 * cannot reach.
 */
const rejectBodyRouteQuery = unknownQueryRefusal(
  "Everything this route takes is in its body, and there is nothing here to select, filter or page.",
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
 * The type label an artifact carries when the caller asks for none.
 *
 * Generic on purpose: the framework knows the agent signs things and knows nothing about what
 * kinds of things they are, so the default says the one true thing — a Statement, signed by
 * this identity. A caller with categories of its own names them itself, which is what the
 * option below is for.
 */
const statementTyp = "saf-statement+jws";

/**
 * The Statement being signed: non-empty, and with **no upper bound**.
 *
 * `minLength: 1` so that an empty commitment is a 400 rather than a signed nothing. No
 * `maxLength`, because Fastify's `bodyLimit` is already the bound and it is the Operator's to
 * raise on the server they constructed — a second number of ours would shadow one they can
 * already set.
 *
 * The same two sentences are true of a Decision's statement and are written beside it too, and
 * that is one fact about a Statement stated twice rather than a convention gone unshared.
 * `route-conventions.ts` holds what the parts agree about the *shape of a request* — the cursor
 * pair, the capped limit, the error body — and "a Statement is a non-empty string" is a fact
 * about the domain instead, which each part that validates one is entitled to say for itself.
 */
const statementSchema = { type: "string", minLength: 1 } as const;

/**
 * The type label, validated as a string of sane length and **as nothing else**.
 *
 * The bound is 128 characters, which is longer than any media type anybody writes and short
 * enough that this cannot be a megabyte inside a protected header, where it would be
 * base64url'd into every copy of the artifact forever. That is the whole of the validation and
 * it is not a policy: any label of that shape is signed, `saf-decision+jws` included, and the
 * reason it is fine for the agent to ask for that one is in the route description below and in
 * `signatures.ts`.
 *
 * `default` is applied by Fastify's ajv, which is configured with `useDefaults`, so the handler
 * reads a `typ` on every request — the same mechanism `limit` uses on every list in the
 * framework.
 */
const typSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  default: statementTyp,
  description: `What kind of thing this artifact is. It goes into the **protected header**, so it is covered by the signature and swapping it invalidates the artifact, which is what keeps a receipt from being presented as an approval.\n\n**Any label, \`saf-decision+jws\` included.** Domain separation between your *own* categories — receipts, votes, approvals — is something only you can express, and each of them wants a label of its own or they collapse into one domain and become replayable as each other. Defaults to \`${statementTyp}\`.`,
} as const;

/**
 * The body of `POST /sign`: the string, and what to call it.
 *
 * There is nothing else, and in particular no field for the payload: what is signed is
 * `{ statement }` and the header, so a caller wanting more inside the artifact writes it into
 * the Statement. A caller that writes a field anyway has it dropped by
 * `additionalProperties: false` and reaches nothing.
 */
const signSchema = {
  type: "object",
  properties: { statement: statementSchema, typ: typSchema },
  required: ["statement"],
  additionalProperties: false,
} as const;

/** What a signing answers with: the artifact, and nothing this part kept. */
const signedStatementSchema = {
  type: "object",
  properties: {
    jws: {
      type: "string",
      description:
        'The **Signed Statement**: a compact JWS, `header.payload.signature`, base64url, one URL-safe string. Its payload is `{"statement":…}` and nothing else — no number and no timestamp, both of those being a Decision\'s — and its protected header carries the algorithm and the `typ` that was asked for. Nothing was stored: this string is the whole of what happened, so keep it or hand it on.',
    },
  },
  required: ["jws"],
} as const;

/**
 * The body of `POST /verify`: one artifact, under the name a Decision carries it under.
 *
 * `jws` and not `artifact` or `signature`, because the string a caller has in hand came out of
 * a `jws` field on a Decision or out of `jws` on a signing, and a third name for one value is
 * a client author's mistake waiting to be made.
 */
const verifySchema = {
  type: "object",
  properties: { jws: { type: "string", minLength: 1 } },
  required: ["jws"],
  additionalProperties: false,
} as const;

/**
 * The verdict on the wire, with `header` and `payload` declared as **empty schemas**.
 *
 * No `type` on either, which passes any JSON through byte intact and renders in the document as
 * "any". Constraining them would be this route having an opinion about what the agent signs,
 * which it does not have anywhere else: the payload of an artifact is whatever claims the
 * signer was handed, and the header is whatever `jose` wrote.
 *
 * Both are absent from `required`, because both are absent from a `false` verdict: there is
 * nothing to report about an artifact that is not ours, and reporting the header of one anyway
 * would be answering with the unverified assertions of a string somebody posted.
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
        "The protected header the signature covers, as it was written: the algorithm, and the `typ` the signer chose. **`typ` is that signer's own claim about its artifact and not a guarantee of this framework's** — a `\"saf-decision+jws\"` here means this identity labelled it a Decision, not that it is shaped like one and not that a row exists. Only an artifact fetched from `GET /decisions` is guaranteed well-formed (ADR-0042).",
    },
    payload: {
      description:
        "The claims the signature covers, parsed out of the bytes that were signed. A Statement signed at `POST /sign` carries `{ statement }`; a Decision carries `{ seq, createdAt, statement }`, so everything a Decision record holds can be read back out of the artifact alone.",
    },
  },
  required: ["verified"],
} as const;

/**
 * The 401, which is the User Manager's and is described in its words.
 *
 * The imported sentence is the whole of what the refusal says; what this part adds is where it
 * comes from, said for the reason Decisions says it: a client reading this route should not
 * have to discover that the hook belongs to another part in order to know the answer is
 * identical there (ADR-0030).
 */
const notAuthenticated = `${authenticationFailed} This part authenticates nobody: the refusal is the User Manager's \`requireUser\`, taken as one option on the route, so it is the same 401 the routes under \`/auth\` answer.`;

/**
 * What the key set is for, said to the person who will use it, and what it deliberately does
 * not establish.
 *
 * Both halves are load-bearing. The first is the mechanics: this is the URL a JOSE library
 * consumes. The second is the sentence ADR-0041 insists on stating unflatteringly, because a
 * verifier who mistakes a cryptographic artifact for evidence about the agent's conduct has
 * been misled by us rather than by themselves.
 */
const whatTheKeyIsFor =
  "The Shared Agent's public key, as a JWK Set (RFC 7517), which is what makes a Signed Statement checkable **without trusting this Gateway**: fetch this once, keep it, and verify artifacts offline with any JOSE library in any language. That is the real verification path, and it is the only one worth anything to somebody who does not trust the Operator.\n\nOne keypair, always, so the set holds one key: there is no rotation, no key identifier and nothing to select between. What a valid signature proves is narrow and worth stating plainly — **that the Operator committed to this Statement on the Shared Agent's behalf, and nothing whatever about how the agent behaved** (ADR-0041).";

/**
 * What the lazy check is worth, which is the sentence this route ships with rather than the
 * limitation it is fixed of.
 *
 * It proves less than it looks like it proves and there is no version of it that proves more:
 * the answer comes from the Gateway, so believing it means trusting the Gateway, and the party
 * this whole identity exists for is precisely the one who does not (ADR-0042). Stated here, in
 * the document, because the caller who most needs to read it is the one who would otherwise
 * hand a third party a screenshot of a `true`.
 */
const whatTheCheckIsWorth =
  "A convenience, and **it proves less than it looks like it proves**. It answers one question — is this artifact this Shared Agent's? — and you have to believe the answer, because a dishonest Gateway says `true` to anything. So it is worth nothing to the party this identity exists for, a third party who does not trust the Operator, and it is genuinely useful to a User, who trusts the Operator already (ADR-0001) and wants a quick confirmation without embedding a JOSE library.\n\n**Real verification is offline.** Fetch `GET /jwks.json` once, keep the key, and check the artifact yourself in whatever language you are already writing, asking this Gateway nothing. That path is available to anybody holding the string, needs no Token, and keeps working after this deployment is gone.";

/**
 * Signatures' Agent server route: the signing, which is the agent's alone.
 *
 * `POST /sign` and not a method the agent could call, because the agent is a container over
 * HTTP and the key is deliberately on this side of that boundary: a compromise of the container
 * mints nothing once the Gateway is stopped, where a key handed to the agent signs forever and
 * there is nothing to revoke (ADR-0041).
 */
export function agentSignatureRoutes(signing: StatementSigning): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: { statement: string; typ: string } }>(
      "/sign",
      {
        schema: {
          tags: ["Signatures"],
          summary: "Sign a Statement",
          description: `Have any string signed with the Shared Agent's key and receive one compact JWS back. **Nothing is stored**: there is no row anywhere afterwards and no route that lists what has been signed, so the artifact answered is the whole of what happened and losing it means signing again. A commitment worth keeping is a Decision — \`POST /decisions\` signs it too, and numbers it and keeps it (ADR-0043).\n\nThe \`typ\` is yours, and **nothing is reserved**. Asking for \`saf-decision+jws\` here is allowed and is not a forgery: publishing a Decision is an authority you already hold, so a decision-typed artifact minted here is that same authority exercised without a log row. What it is *not* is a promise to a verifier — \`typ\` is your signed claim about your own artifact, and only an artifact fetched from \`GET /decisions\` is guaranteed to be shaped like one.\n\nThe Statement has no length limit of ours; the server's own body limit is the bound and it belongs to the Operator. ${unknownParameter}`,
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
      // 200 and not 201, because nothing was created: there is no resource behind this and
      // nowhere it could be fetched from again.
      //
      // The claims are built here rather than the body being passed along, and the difference
      // is the whole payload: `typ` is a *header* parameter, so a body forwarded whole would
      // sign it into the payload as well and every artifact would carry its own label twice,
      // in two places a verifier could find them disagreeing.
      async (request) => ({
        jws: await signing.sign(request.body.typ, { statement: request.body.statement }),
      }),
    );
  };
}

/**
 * Signatures' Public server routes: the lazy check behind a Token, and the key in front of
 * everything.
 *
 * `presentedUser` is `requireUser`, taken as one option on the route and not wrapped, extended
 * or re-implemented, so an unauthenticated check is the Manager's single 401 and this part
 * authenticates nobody (ADR-0030).
 *
 * **The Token is required and the User it names is then unused**, as on Decisions' read: it
 * gates the surface rather than scoping the answer, because the Gateway is not a free signature
 * oracle for whoever finds the port. The key set beside it takes none, which is the pair worth
 * seeing together — the route that answers about *your* string wants a Token, and the route
 * that hands over the means to answer it yourself does not.
 *
 * The hook runs at `preHandler`, after validation, so a missing body and an unknown query
 * parameter are both answered before a Token is looked at. That is the order every other Public
 * route already answers in, and it leaks nothing: a refusal names a field of the route and never
 * a User, and it certainly never says anything about the artifact, which nobody has looked at.
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
          description: `${whatTheCheckIsWorth}\n\nAnswers **200 either way**. An artifact that is not ours is a \`false\` and not an error, and that covers a foreign identity's artifact, a tampered one, a wrong number of segments, malformed base64url and an unparseable header alike: all of those arrive from a caller, and none of them is this Gateway failing. ${bearerRequired} ${unknownParameter}`,
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
      // The User the hook just verified is deliberately not read: an artifact belongs to
      // nobody, so there is nothing here to scope.
      async (request) => check.verify(request.body.jws),
    );

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
        preValidation: rejectKeySetQuery(),
      },
      // The same object every time, held since construction: the key does not change while
      // the process is running, and deriving it per request would be work done to produce
      // the identical bytes.
      async () => keySet,
    );
  };
}
