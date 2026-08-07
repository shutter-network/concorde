#!/usr/bin/env bash
#
# Says one thing to the agent over NIP-17, then streams back whatever the agent says to you.
#
#   docker compose run --rm nak-alice "what is on my plate today?"
#   docker compose run --rm nak-bob                 # listen only, say nothing
#
# Ctrl-C stops the listening half. The sending half has already happened by then.
#
# Every value below comes from `.env` through the service definition in `compose.yml`, and the
# only secret this container ever sees is the one User it speaks for.

set -euo pipefail

# No apostrophe in any of these four messages. The word after `:?` is a shell word, so one
# would open a quote and the file would not parse.
: "${RELAY_URL:?set RELAY_URL to the relay this stack runs}"
: "${AGENT_PUBKEY:?set AGENT_PUBKEY to the Nostr public key of the agent}"
: "${USER_SECRET:?set USER_SECRET to the Nostr secret key of this person}"
: "${USER_PUBKEY:?set USER_PUBKEY to the Nostr public key of this person}"

if [ "$#" -gt 0 ] && [ -n "$1" ]; then
  # Three acts and three processes. A kind 14 rumor addressed to the agent, sealed and gift
  # wrapped to the agent's key, and the wrap handed to the relay. Only the third one touches the
  # network, and only the wrap reaches it.
  nak event -k 14 -c "$1" -p "$AGENT_PUBKEY" --sec "$USER_SECRET" |
    nak gift wrap --sec "$USER_SECRET" -p "$AGENT_PUBKEY" |
    nak event "$RELAY_URL"
fi

# Every gift wrap the relay holds for this person, and then every one that arrives, unwrapped
# back to the rumor the agent wrote. No `since`: NIP-59 randomises a wrap's timestamp up to two
# days into the past, so a watermark would hide most of them.
echo "listening on $RELAY_URL for $USER_PUBKEY, Ctrl-C to stop"
nak req -k 1059 -p "$USER_PUBKEY" --stream "$RELAY_URL" | nak gift unwrap --sec "$USER_SECRET"
