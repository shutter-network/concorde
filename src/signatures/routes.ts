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
  "The signing identity has one key. Key selection and rotation are not supported.",
);

const rejectBodyRouteQuery = unknownQueryRefusal(
  "This route accepts body fields only, not query parameters.",
);

const jwkSchema = {
  type: "object",
  properties: {
    kty: {
      type: "string",
      description: "JOSE key type: OKP, EC, or RSA.",
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
  description: `Artifact type written into the signed protected header. Use distinct values for distinct application purposes and validate the type when verifying. No value is reserved, including concorde-decision+jws; that label alone does not prove a decision was stored. Defaults to ${statementTyp}.`,
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
        "Compact JWS with payload `{ statement }`. The protected header contains the signing algorithm and requested typ. This component stores no copy.",
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
        "Whether the artifact verifies under this signing identity. Invalid or malformed artifacts return false rather than an HTTP error.",
    },
    header: {
      description:
        "The signed protected header. typ is a caller-selected label, not validation of the payload shape or proof of a stored decision.",
    },
    payload: {
      description:
        "The signed JSON payload. POST /sign produces `{ statement }`; published decisions contain `{ seq, createdAt, statement }`.",
    },
  },
  required: ["verified"],
} as const;

const whatTheKeyIsFor =
  "Fetch and retain the public signing key to verify artifacts independently. A valid signature authenticates the statement under this identity, not the agent's behavior. Establish trust in the key separately. The set contains one key; rotation and key identifiers are not supported.";

const whatTheCheckIsWorth =
  "Checks an artifact using this gateway's public signing key. This convenience endpoint requires trusting the gateway's answer. For independent verification, retain a trusted public key from GET /jwks.json and verify locally.";

export function agentSignatureRoutes(signing: StatementSigning): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: { statement: string; typ: string } }>(
      "/sign",
      {
        schema: {
          tags: ["Signatures"],
          summary: "Sign a statement",
          description: `Returns a compact JWS without storing it. Use POST /decisions when you need a stored, numbered decision. The caller selects typ; no label is reserved, and a decision label here does not create a decision record. Statement size is bounded by the server's body limit. ${unknownParameter}`,
          body: signSchema,
          response: {
            200: {
              ...signedStatementSchema,
              description: "The signed artifact. Retain it; the component stores no copy.",
            },
            400: refused(
              "A nonempty statement is required. If supplied, typ must contain 1–128 characters. Query parameters are not accepted.",
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
          summary: "Verify a signed artifact",
          description: `${whatTheCheckIsWorth} Returns 200 with verified=false for invalid, malformed, or foreign artifacts. ${bearerRequired} ${unknownParameter}`,
          body: verifySchema,
          response: {
            200: {
              ...verdictSchema,
              description:
                "Verification result. A successful result includes the signed header and parsed payload.",
            },
            400: refused("A nonempty jws is required. Query parameters are not accepted."),
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
          summary: "Fetch the public signing key",
          description: `${whatTheKeyIsFor} No authentication is required. ${unknownParameter}`,
          response: {
            200: {
              ...keySetSchema,
              description: "JWK set containing one public key and no private key material.",
            },
            400: refused("Query parameters are not accepted."),
          },
        },
        preValidation: rejectKeySetQuery(),
      },
      async () => keySet,
    );
  };
}
