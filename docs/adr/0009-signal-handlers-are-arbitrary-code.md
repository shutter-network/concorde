# Signal Handlers are arbitrary code

A Signal Handler is ordinary code written by the Operator, in the way an endpoint handler is code in a web framework. It may read and write Gateway state, touch the filesystem, and call external services. The framework neither restricts nor sandboxes it.

The initial instinct was a purely declarative, non-code description of how Signals become Prompts. We rejected it, and also rejected a read-only pure-function contract. Operators need real power at this seam, and every restriction we imagined would have been worked around rather than respected. The web framework analogy is the intended one: the framework routes and provides context, the handler decides what happens.

A Signal produces **none, one, or many** Prompts. Declining a Signal is just producing none, and needs no separate concept or name — so filtering, authorization, rate limiting, deduplication, and ignoring Signals that don't warrant waking the agent all fall out of the same mechanism.

## Consequences

- **Authorization lives in Signal Handlers.** The Gateway authenticates users but has no notion of which Signals a given user may submit. A handler that produces no Prompt is how a deployment refuses one. There are deliberately no Gateway-level per-Signal permissions.
- Handlers sit on the critical path of every Signal. Their failure modes, latency, and external dependencies are the deployment's problem, and the framework's guidance should steer data fetching towards the agent's own tools during a Run instead.
- Handlers may write files or insert data for the agent to consume, which makes the boundary between Gateway state and agent-visible state a question the framework has to answer.
