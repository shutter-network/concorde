#!/usr/bin/env bash

set -euo pipefail

: "${RELAY_URL:?set RELAY_URL to the relay this stack runs}"
: "${AGENT_PUBKEY:?set AGENT_PUBKEY to the Nostr public key of the agent}"
: "${USER_SECRET:?set USER_SECRET to the Nostr secret key of this person}"
: "${USER_PUBKEY:?set USER_PUBKEY to the Nostr public key of this person}"

if [ "$#" -gt 0 ] && [ -n "$1" ]; then
  nak event -k 14 -c "$1" -p "$AGENT_PUBKEY" --sec "$USER_SECRET" |
    nak gift wrap --sec "$USER_SECRET" -p "$AGENT_PUBKEY" |
    nak event "$RELAY_URL"
fi

echo "listening on $RELAY_URL for $USER_PUBKEY, Ctrl-C to stop"
nak req -k 1059 -p "$USER_PUBKEY" --stream "$RELAY_URL" | nak gift unwrap --sec "$USER_SECRET"
