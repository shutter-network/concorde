# Users are opaque ids, and authentication is pluggable

> **Superseded in part** by [ADR-0029](./0029-users-are-a-part-of-their-own.md) and
> [ADR-0030](./0030-passwords-are-traded-for-bearer-tokens.md). Four claims below no
> longer hold, and the rest — opaque ids, no privileged naming scheme, arbitrary-JSON
> attributes the Gateway cannot meaningfully index, provisioning two ways,
> self-registration as a Signal — still do:
>
> 1. *"Authentication is a replaceable component, the **Authenticator**"*, and with it
>    the second half of this ADR's title. There is no Authenticator; the extension point
>    is token issuance (ADR-0030).
> 2. *"It holds no passwords."* It holds scrypt hashes (ADR-0030). *"Runs no
>    account-recovery flow"* is unaffected and reaffirmed.
> 3. *"Removal is deactivation, not erasure."* Nothing removes a User at all (ADR-0029).
> 4. Users belonging to the Messenger — stated in
>    [`architecture.md`](../architecture.md) and [`data-model.md`](../data-model.md)
>    rather than here. They are their own part (ADR-0029).

A User is identified by an opaque id issued by the Gateway, and carries a bag of deployment-defined attributes as arbitrary JSON. No naming scheme is privileged. A Shared Agent may identify people by wallet address, DID, employee number, or chat handle, and building in email would force every other scheme to masquerade as one. Attributes are also where grouping lives, per [ADR-0008](./0008-party-is-not-in-the-data-model.md).

Authentication is a replaceable component, the **Authenticator**. The framework ships Gateway-issued bearer tokens as the default, since they are the minimum that works for a REST client without presuming a browser or a human. Pluggability is not motivated by any particular scenario — it is that authentication is irrelevant to mediating a Shared Agent, so it stays out of the core per [ADR-0013](./0013-the-core-framework-stays-generic.md).

**Provisioning** happens two ways: the Operator creates Users out of band, and the agent creates them over its HTTP API ([ADR-0010](./0010-the-agent-reaches-the-gateway-over-http.md)), which a deployment may disable. Self-registration is not a framework feature — a registration request is just a Signal, so a deployment that wants it writes a Signal Handler.

## Consequences

- **Removal is deactivation, not erasure.** Deleting a User invalidates their credential and stops delivery to their Outbox. Their past Signals remain, and Session history cannot be retracted: what the agent already knows cannot be unlearned. Anything stronger would be a promise the architecture cannot keep.
- The Gateway is not an identity provider. It holds no passwords and runs no account-recovery flow; both belong to whatever the Authenticator delegates to.
- Because attributes are arbitrary JSON, the Gateway cannot validate or index them meaningfully. Handlers that route on attributes are responsible for their own assumptions about shape.
