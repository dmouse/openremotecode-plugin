# ADR 0001: HPKE Authenticated Relay Envelopes

## Status

Provisional. Implementation and interoperability testing are approved for development. Production use requires a focused cryptographic review and verification in every supported client runtime.

## Context

Open Remote Code routes chat and control messages through a server that must not read their content. Each connector and client device requires an independent public identity. Visible routing metadata must be bound to encrypted content so the relay cannot alter sender, recipient, ordering, or expiry fields undetected.

The implementation must run in OpenCode's Bun runtime and later in modern browsers and Expo clients. It must use a standardized construction rather than combining low-level key exchange and encryption primitives locally.

## Decision

Relay payloads use HPKE authenticated mode as defined by RFC 9180 with:

- DHKEM using P-256 and HKDF-SHA256.
- HKDF-SHA256.
- AES-256-GCM.
- One fresh HPKE sender context per envelope.
- The sender's connector or device private key as the authenticated sender key.
- The recipient's pinned public key as the encryption target.
- Protocol identity, message identifier, sender and recipient key identifiers, sequence, expiry, and suite identifier as additional authenticated data.

The implementation currently uses `@hpke/core`. The package relies on Web Crypto, supports HPKE Auth mode, and is tested by its maintainers against RFC 9180 and Project Wycheproof vectors. Its maintainers state that it has not been formally audited, so this choice remains provisional.

## Identity Storage

The plugin stores serialized connector key material in a dedicated local data directory. Creation uses a complete temporary file followed by an exclusive hard link so concurrent OpenCode processes converge on one identity. POSIX files must have mode `0600` and the containing directory is restricted to `0700`.

The file store is a fallback boundary. Native operating-system key storage should replace or wrap it where reliable cross-platform support is available. Private key values never enter logs, relay frames, test output, or server persistence.

## Consequences

- The relay can route messages but cannot decrypt inner operations or content.
- A recipient verifies the expected sender key as part of HPKE context setup.
- Metadata modification causes authenticated decryption failure.
- Static recipient-key compromise can expose previously captured envelopes, so this design does not provide full post-compromise forward secrecy.
- Device revocation and replay tracking remain protocol responsibilities outside HPKE.
- Every browser and Expo target must pass shared interoperability vectors before release.
- The implementation must be replaced or independently reviewed if its maintenance, runtime support, or security posture becomes unsuitable.
