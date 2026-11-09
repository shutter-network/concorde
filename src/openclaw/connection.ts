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
};

export type Connection = {
  request<T>(method: string, params: unknown): Promise<T>;
  /** Includes buffered events from before iteration began, in arrival order. */
  events(): AsyncGenerator<EventFrame, void, undefined>;
  closed(): string | undefined;
  close(): Promise<void>;
};

// Request the scopes these methods need instead of the client's operator.admin default.
const scopes = ["operator.read", "operator.write"];

const clientDisplayName = "concorde";

export function deviceIdentityOf(privateKey: KeyObject): DeviceIdentity {
  const publicKey = createPublicKey(privateKey);
  return {
    deviceId: createHash("sha256").update(rawPublicKey(publicKey)).digest("hex"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
  };
}

// Ed25519 SPKI encoding ends with the 32-byte public key, after a 12-byte header.
function rawPublicKey(publicKey: KeyObject): Buffer {
  return (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
}

// The client requires these crypto hooks; its defaults throw. Leave token storage disabled.
const hostDeps: GatewayClientHostDeps = {
  signDevicePayload: (privateKeyPem, payload) =>
    sign(null, Buffer.from(payload, "utf8"), createPrivateKey(privateKeyPem)).toString("base64url"),
  publicKeyRawBase64UrlFromPem: (publicKeyPem) =>
    rawPublicKey(createPublicKey(publicKeyPem)).toString("base64url"),
};

/**
 * Stop the client before returning from a failed connection hook. It schedules reconnection
 * after the hook returns, which would leave a failed run reconnecting in the background.
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
      client.stop();
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
