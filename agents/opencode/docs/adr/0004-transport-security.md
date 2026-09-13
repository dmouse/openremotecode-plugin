# ADR 0004: Require TLS and explicit loopback development transport

## Status

Accepted.

## Context

HPKE protects inner chat and control payloads between the plugin and a trusted client. Pairing secrets, connector credentials, relay tickets, public identities, presence, and routing metadata also travel between the plugin and the API. These exchanges require authenticated TLS independently of HPKE.

## Decision

- Require HTTPS/WSS for plugin connections by default. Permit HTTP/WS only when `OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK=true` is set in the launching process and the URL resolves syntactically to an allowed loopback host: `127.0.0.1`, `localhost`, or `[::1]`. Project options cannot enable the exception. Unset, empty, and `false` disable it; other values fail closed.
- Apply the same transport policy to new pairings, stored authorization, TUI requests, every reconnect, and the unauthenticated local test harness. The harness remains restricted to loopback even when using WSS. HTTPS/WSS retain normal certificate verification in development.
- Validate and copy the API origin at the HTTP client boundary so callers cannot mutate a URL object and redirect stored credentials. Reject redirects for every API operation, including same-origin redirects.
- Resolve the relay URL, verify its origin, and accept only the exact `/v1/relay` path defined in v1. Reject alternate origins, schemes, credentials, queries, fragments, and noncanonical path forms before constructing a WebSocket or attaching a ticket.
- Require `TLS_CERT_FILE` and `TLS_KEY_FILE` for the Go listener outside development. Load the certificate pair before database access and never fall back to HTTP when TLS configuration is incomplete or invalid. Use the standard Go TLS implementation, TLS 1.2 or newer, and an HTTPS upstream from the edge proxy. Default the listener to loopback; deployments explicitly choose another private binding when needed.

## Threat analysis

Network observers must not obtain pairing credentials or tickets through a transport downgrade. Initial HTTPS validation is insufficient if later requests can follow an HTTP redirect; rejecting redirects keeps the entire exchange on the selected origin. Strict URL resolution and contract validation prevent normalization ambiguities from moving a ticket to another host. Neither mechanism depends on trusting API response fields as executable routing instructions.

HPKE continues to protect conversation content from the relay; this change does not give the server content keys or change account routing, device trust, or the inner protocol. TLS authenticates the selected API endpoint but does not hide API credentials or routing metadata from that endpoint. A compromised trusted endpoint or local process remains outside this transport guarantee.

The loopback opt-in deliberately exposes API metadata and credentials to the local transport. It is intended only for development on a trusted machine. Syntactic host validation assumes the operating system resolves `localhost` to loopback; it is not a defense against a compromised local resolver, runtime, or user-supplied network proxy.

Certificate material stays in restricted local files. Configuration and rejection messages omit supplied URLs and private key contents. Proxy access logs must redact credential-bearing headers. Server startup reports transport mode without logging certificate material. Deployment operators remain responsible for certificate issuance, trusted roots, edge HSTS, upstream verification, restricted network access, and certificate rotation.

## Verification and compatibility

Unit tests cover secure defaults, malformed flags, IPv4/IPv6 loopback, nonlocal plaintext rejection, origin mutation, every API operation's redirect policy, and malformed relay paths. Integration tests exercise real HTTPS ticket acquisition and WSS admission, rejection of untrusted certificates even with loopback opt-in, and 301/302/303/307/308 redirects without reaching their targets. Go tests exercise TLS configuration failures, HTTPS/WSS, plaintext rejection before the API handler, and rejection of obsolete TLS versions. Existing encryption, revocation, and pinned OpenCode integration tests remain required.

Local demo and integration processes explicitly opt in to their HTTP/WS fixtures. Existing development users must set the flag for each OpenCode launch, including after restoring saved credentials. Production deployments must configure the Go certificate pair and HTTPS proxy upstream; there is no production plaintext escape hatch. No HTTP body or relay envelope contract changes are required.

References: [Fetch redirect handling](https://fetch.spec.whatwg.org/#http-redirect-fetch), [Go ServeTLS](https://pkg.go.dev/net/http#Server.ServeTLS), [Go certificate loading](https://pkg.go.dev/crypto/tls#LoadX509KeyPair).
