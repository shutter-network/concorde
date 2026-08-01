/**
 * The two servers.
 *
 * Asserting that Fastify routes a request would be testing Fastify, so what is
 * asserted here is ours: that the loopback default holds and is a choice rather than
 * an inability, that the reachable-from address is carried separately from the bind
 * address, that an Operator's plugin mounts on either server, and that neither
 * server knows anything about the other.
 *
 * These tests need no PostgreSQL. They do open real sockets, because the whole
 * subject is which address a socket ends up on — `fastify.inject` would answer every
 * request regardless of where the server bound, which is precisely the mistake
 * ADR-0010's accepted risk is about.
 */

import assert from "node:assert/strict";
import { networkInterfaces } from "node:os";
import { describe, it } from "node:test";
import type { FastifyPluginAsync } from "fastify";
import { createAgentServer, createPublicServer } from "./servers.ts";

/** Somewhere the agent's container could plausibly find the Gateway. */
const reachableAt = "http://host.docker.internal:7411";

/** What an Operator's own plugin looks like: Fastify's mechanism, not ours. */
function pingPlugin(body: string): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get("/ping", async () => body);
  };
}

/**
 * An address of this machine that is not the loopback interface, if it has one.
 *
 * The two bind-address tests are a pair: one asserts nothing answers here by
 * default, the other that something does when the Operator asks for it. Without the
 * second, a firewall would make the first pass for the wrong reason.
 */
function externalIPv4(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return undefined;
}

/** Whether anything answers at `url` within a couple of seconds. */
async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

async function bodyOf(url: string): Promise<string> {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url} should have answered`);
  return await response.text();
}

async function statusOf(url: string): Promise<number> {
  return (await fetch(url)).status;
}

describe("the two servers", () => {
  it("start listening independently, each on its own configuration", async (t) => {
    const publicServer = createPublicServer({ port: 0 });
    const agentServer = createAgentServer({ port: 0, reachableAt });
    t.after(() => Promise.all([publicServer.close(), agentServer.close()]));

    // An Operator's own plugin, on each server, through Fastify's plugin mechanism
    // and nothing of ours (ADR-0021). One is mounted under a prefix, because that is
    // Fastify's and an Operator gets it for free.
    await publicServer.fastify.register(pingPlugin("the world's"), { prefix: "/ops" });
    await agentServer.fastify.register(pingPlugin("the agent's"));

    const publicAddress = await publicServer.listen();
    const agentAddress = await agentServer.listen();
    assert.notEqual(new URL(publicAddress).port, new URL(agentAddress).port);

    assert.equal(await bodyOf(`${publicAddress}/ops/ping`), "the world's");
    assert.equal(await bodyOf(`${agentAddress}/ping`), "the agent's");

    // Neither server carries the other's routes: two surfaces by construction, which
    // is the whole reason there are two of them.
    assert.equal(await statusOf(`${publicAddress}/ping`), 404);
    assert.equal(await statusOf(`${agentAddress}/ops/ping`), 404);
  });

  it("start the Public server successfully with no routes registered", async (t) => {
    // The Messenger is out of scope, so the Public server carries no framework
    // routes at all in this slice. It exists because it is part of the Gateway's
    // shape and because it is where an Operator's own plugins go.
    const publicServer = createPublicServer({ port: 0 });
    t.after(() => publicServer.close());

    const address = await publicServer.listen();
    // Every interface, unlike the Agent server: the surface meant to be exposed is
    // useless bound to loopback inside a container.
    assert.match(address, /^http:\/\/0\.0\.0\.0:\d+$/);
    assert.equal(await statusOf(`${address}/`), 404);
  });
});

describe("the Agent server's bind address", () => {
  it("binds loopback unless told otherwise", async (t) => {
    const agentServer = createAgentServer({ port: 0, reachableAt });
    t.after(() => agentServer.close());
    agentServer.fastify.get("/ping", async () => "the agent's");

    const address = await agentServer.listen();
    assert.match(address, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(await bodyOf(`${address}/ping`), "the agent's");

    // The Agent server is unauthenticated, so reaching the port is access
    // (ADR-0010). Binding loopback is the whole of what stands in front of it, and
    // the only way to see it is from another address of this machine.
    const external = externalIPv4();
    if (external === undefined) return;
    assert.equal(
      await answers(`http://${external}:${new URL(address).port}/ping`),
      false,
      "the Agent server should answer on loopback alone until an Operator says otherwise",
    );
  });

  it("binds where it is told, so the default is a choice and not an inability", async (t) => {
    const external = externalIPv4();
    if (external === undefined) return;

    const agentServer = createAgentServer({ port: 0, host: "0.0.0.0", reachableAt });
    t.after(() => agentServer.close());
    agentServer.fastify.get("/ping", async () => "the agent's");

    const address = await agentServer.listen();
    assert.match(address, /^http:\/\/0\.0\.0\.0:\d+$/);
    assert.equal(
      await bodyOf(`http://${external}:${new URL(address).port}/ping`),
      "the agent's",
      "an Operator who asks for every interface should get one, exposure and all",
    );
  });

  it("carries the reachable-from address separately from where it binds", async (t) => {
    const agentServer = createAgentServer({ port: 0, reachableAt: `${reachableAt}/` });
    t.after(() => agentServer.close());

    // Stated rather than derived, and not the same value: Docker Desktop, a Linux
    // bridge and a shared compose network all differ, and none is discoverable from
    // the socket. The trailing slash is dropped so that `${reachableAt}/signals` is
    // what an agent's `curl` composes.
    assert.equal(agentServer.reachableAt, reachableAt);
    assert.match(await agentServer.listen(), /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("refuses a reachable-from address that is not an absolute HTTP URL", () => {
    // A bad deploy is obvious immediately rather than at the agent's first `curl`
    // mid-Run, which is a failed Run under ADR-0017 and permanent.
    for (const bad of ["host.docker.internal:7411", "/agent", "", "ftp://gateway:7411"]) {
      assert.throws(
        () => createAgentServer({ port: 0, reachableAt: bad }),
        /reachableAt/,
        `${JSON.stringify(bad)} should be refused where it is written`,
      );
    }
  });
});
