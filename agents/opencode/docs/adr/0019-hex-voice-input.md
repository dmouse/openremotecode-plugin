# ADR 0019: Stream phone audio to local Hex

Status: accepted

## Decision

Reuse the paired, end-to-end encrypted relay for optional voice input. A small
Hex adapter calls the running desktop application's API 2 `/streams` routes. The
phone owns microphone permission and recording; Hex owns transcription. The
connector never records the computer's microphone, loads a model, reads dictation
history, or invokes a shell command. It uses Hex's currently loaded GGUF model.

The composer microphone returns a quick note to the draft. The header Call action
keeps recording and automatically sends finalized utterances through `chat.prompt`.
The connector's voice operations only transcribe: they cannot send a prompt or
approve a permission. The mobile client explicitly chooses call behavior. See the
[wire contract and lifecycle limits](../../../../protocol/VOICE.md).

Hex 3.3.0 was the integration target. Its discovery file is read from the standard
platform data directory. On POSIX the file must be a regular file owned by the
current user, inaccessible to other users, and opened without following symlinks.
The parser bounds its size. It accepts only an API version, port and bearer token;
all requests go to a fixed `127.0.0.1` address and fixed routes. Redirects are
rejected. Stream owner tokens and the discovery token never cross the relay.
Reference: [Hex streaming API](https://github.com/anomalyco/hex/blob/dev/docs/streams.md).

`voice.status` separates implementation support from live availability. It probes
authenticated fixed loopback `/health` and `/capabilities` routes, shares one
in-flight check per peer, and returns only a boolean inside E2EE. A two-second
shared deadline and the existing response-size limit bound the probe. Discovery
alone is not evidence that Hex is running. Checks never create a stream or load
a model; busy/no-model errors remain start-time conditions. Mobile hides entry
buttons until confirmed, refreshes every ten seconds only in a visible foreground
conversation, and invalidates results on lifecycle/connection changes.

## Threat analysis

- **Untrusted or cross-account client:** Existing peer pinning, authenticated
  encryption, account routing and epoch replay checks apply before any voice work.
  Voice requires the same local approved project and root-session access as chat.
  A background authorization monitor cancels a stream if approval disappears.
- **Local service credential leakage / SSRF:** The remote client cannot name an
  endpoint, path, model, command or token. Owner-only discovery and localhost-only
  requests prevent credential delivery to arbitrary hosts. Raw errors are replaced
  by fixed protocol codes. A compromised local user account remains outside the
  existing trust model.
- **Denial of service:** One reserved stream, sequential bounded PCM chunks,
  bounded overall audio, response limits, deadlines and independent idle leases
  bound memory and inference use. Cancellation during startup retains the slot
  until startup settles. Hex's global one-stream limit also rejects competing
  clients/processes. No remote request starts Hex or downloads a model.
  Status checks share one in-flight probe per trusted peer, do no inference,
  and are cancelled when the peer disconnects. They expose no discovery metadata.
- **Replay / duplicate actions:** Audio sequence numbers are checked within a
  voice ID and epoch. Reconnect discards the stream, and no audio is resent. Voice
  returns text only. Automatic call submissions use the existing `chat.prompt`
  mutation journal and stop on uncertain results.
- **Ambient audio / mistaken transcription:** Call mode is an explicit visible
  opt-in, with mute and hangup always available. Pause detection is heuristic and
  cannot identify the speaker or infer intent. Quick notes retain manual review.
  Permissions always need an individual tap. Long turns become drafts.
- **Wrong-chat delivery / lifecycle races:** Capture and pending transcription are
  bound to a composer, project, session and peer generation. Late results after
  navigation, backgrounding, identity change or cancellation are discarded.
- **Sensitive retention:** Audio stays in bounded memory buffers. No audio file,
  history lookup, transcript log, analytics event, notification content or server
  conversation store is added. Transcripts become ordinary drafts/prompts under
  the existing conversation retention policy. Hex is trusted as a local processor.

## Verification

Shared TypeScript/Dart fixtures fix the format and limits. Encrypted dispatcher
tests cover wrong identities, validation, authorization, duplicates, cancellation
and epoch changes. Hex adapter tests cover fixed routing, authentication, response
limits and startup cancellation. Flutter tests exercise both input modes, silent
audio, mute, slow inference, permission denial, navigation and uncertain sends.
Android/iOS recording uses the maintained `record` plugin and native permission
declarations. Device tests must use the isolated native test application; builds
and fake-recorder tests do not establish microphone behavior on physical devices.
