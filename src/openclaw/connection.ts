import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign } from "node:crypto";
import {
  type DeviceIdentity,
  GatewayClient,
  type GatewayClientHostDeps,
} from "@openclaw/gateway-client";
import type { EventFrame } from "@openclaw/gateway-protocol";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";

export type ConnectionTarget = {
  readonly url: string;
  readonly token: string;
  readonly identity: DeviceIdentity;
  readonly agentId: string | undefined;
};

/** One authenticated connection to the OpenClaw daemon, opened for one Run and closed with it. */
export type Connection = {
  request<T>(method: string, params: unknown): Promise<T>;
  /** Every event frame since the connection opened, in order; ends when the connection closes. */
  events(): AsyncGenerator<EventFrame, void, undefined>;
  /** Why the connection closed, once it has. */
  closed(): string | undefined;
  close(): Promise<void>;
};

// chat.send needs operator.write and the event streams operator.read. The client's default is
// operator.admin; a connection that sends no scopes at all is accepted and refused every method.
const scopes = ["operator.read", "operator.write"];

const clientDisplayName = "concorde";

/**
 * The daemon derives a device id as the hex SHA-256 of the raw public key and refuses a mismatch,
 * so the id is computed here and never asked of the Operator.
 */
export function deviceIdentityOf(privateKey: KeyObject): DeviceIdentity {
  const publicKey = createPublicKey(privateKey);
  return {
    deviceId: createHash("sha256").update(rawPublicKey(publicKey)).digest("hex"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
  };
}

// An Ed25519 SPKI DER is a 12 byte header followed by the 32 byte key.
function rawPublicKey(publicKey: KeyObject): Buffer {
  return (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
}

// The two hooks whose client defaults throw. The client builds the payload (nonce, challenge
// timestamp, scopes, token); these only sign it and present the raw key. The token-store hooks
// stay at their no-op defaults, which is how the Runtime stores nothing.
const hostDeps: GatewayClientHostDeps = {
  signDevicePayload: (privateKeyPem, payload) =>
    sign(null, Buffer.from(payload, "utf8"), createPrivateKey(privateKeyPem)).toString("base64url"),
  publicKeyRawBase64UrlFromPem: (publicKeyPem) =>
    rawPublicKey(createPublicKey(publicKeyPem)).toString("base64url"),
};

/**
 * Resolves once the daemon has answered `hello-ok`; rejects with the daemon's refusal otherwise.
 * The client package would reconnect with backoff on a refusal, so it is stopped either way.
 */
export async function openConnection(target: ConnectionTarget): Promise<Connection> {
  const frames: EventFrame[] = [];
  let wake: (() => void) | undefined;
  let closed: string | undefined;
  let settled = false;
  const opened = Promise.withResolvers<void>();

  const notify = (): void => {
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };

  const client = new GatewayClient({
    url: target.url,
    token: target.token,
    deviceIdentity: target.identity,
    hostDeps,
    scopes,
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    clientDisplayName,
    onHelloOk: () => {
      if (settled) return;
      settled = true;
      opened.resolve();
    },
    onConnectError: (error) => {
      if (settled) return;
      settled = true;
      client.stop();
      opened.reject(error);
    },
    onClose: (code, reason) => {
      closed = `The connection closed (${code}${reason === "" ? "" : `: ${reason}`})`;
      notify();
      if (settled) return;
      settled = true;
      opened.reject(new Error(closed));
    },
    onEvent: (frame) => {
      frames.push(frame);
      notify();
    },
  });

  try {
    client.start();
  } catch (error) {
    settled = true;
    client.stop();
    throw error;
  }
  await opened.promise;

  return {
    request: <T>(method: string, params: unknown) => client.request<T>(method, params),
    async *events() {
      let next = 0;
      for (;;) {
        while (next < frames.length) {
          const frame = frames[next];
          next += 1;
          if (frame !== undefined) yield frame;
        }
        if (closed !== undefined) return;
        await new Promise<void>((resume) => {
          wake = resume;
        });
      }
    },
    closed: () => closed,
    close: () => client.stopAndWait(),
  };
}
