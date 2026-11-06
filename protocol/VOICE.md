# Voice input, version 1

Voice input is an optional peer capability. All five operations must be advertised:
`voice.status`, `voice.start`, `voice.audio`, `voice.finish`, `voice.cancel`. Requests and replies
are encrypted inner relay payloads. The relay neither understands nor stores audio.
The normative schemas are `src/protocol/voice.ts`; Dart and TypeScript assert the
same `test/fixtures/voice-v1.json` contract.

`voice.status` carries only `version: 1` and returns `{ version: 1, available: boolean }`.
It is read-only and scoped to the authenticated, pinned peer, not a project or
voice ID. The connector checks Hex's authenticated loopback `/health` (API 2)
and `/capabilities` (`streams: true`) within a shared two-second deadline. Missing,
unsafe or stale discovery, incompatible responses, network errors and timeouts
return unavailable. Checks never reserve a stream, capture audio, load a model,
or return local paths, ports, versions or credentials. Concurrent status requests
share one probe per peer; disconnect cancels it. Availability means a live,
compatible streaming API, not a guarantee that a model is loaded or a stream is
free. Those conditions retain the existing recoverable start errors.

1. `voice.start` carries `version: 1`, a fresh UUID `voiceId`, an approved opaque
   `projectId`, and optionally an authorized root `sessionId`. Omitting the session
   supports a quick note in a new-chat draft. The reply fixes `sampleRate: 16000`,
   `sampleFormat: "s16le"`, `maxChunkBytes: 16000`, and `maxDurationMs: 60000`.
2. `voice.audio` carries the version, voice ID, a zero-based contiguous `sequence`,
   and unpadded canonical base64url `audio`. Decoded audio is little-endian signed
   PCM16, mono, with whole samples, no container and at most 16,000 bytes per
   request. The reply echoes the sequence. Only one append may be in flight.
   Duplicate, missing, or reordered sequences close the stream; no audio retry
   is permitted after a missing acknowledgement.
3. `voice.finish` carries only the version and voice ID. The reply has `text`,
   at most 32,000 characters. Empty text means no recognized speech. It closes
   the utterance; another utterance requires a fresh voice ID.
4. `voice.cancel` carries only the version and voice ID. It discards the unfinished
   utterance and replies `cancelled: true`. It is idempotent for unknown IDs.

The connector reserves one stream per trusted peer/epoch, checks current folder
and session authorization before starting and returning text, and monitors it
every two seconds while open. Peer departure, epoch replacement, disposal,
revocation, more than 60 seconds of submitted audio, or idle expiry cancels it.
The connector expires idle streams after seven seconds (checked every two seconds)
and bounds an utterance's wall-clock lifetime to 90 seconds. Hex's own ten-second
lease is an independent cleanup fallback. Hex discovery and upload have bounded
responses/timeouts; finishing waits up to 15 seconds, within the client's normal
20-second request deadline.

Fixed error codes are `voice_unavailable`, `voice_busy`, and `voice_expired`, or
the existing authorization/validation errors. Neither errors nor diagnostics
include audio, transcript content, file paths, or Hex credentials.

## Mobile behavior

Hide both entry buttons until a current-connection status check succeeds; older
connectors without `voice.status` also keep them hidden. Refresh when entering a
conversation, reconnecting or resuming, then every ten seconds while visible.
Backgrounding or covering/leaving the conversation stops checks and clears cached
availability. Failed checks hide idle controls and stop active capture; controls
for stopping an active recording remain reachable during cleanup. Later successful
checks restore the buttons without restarting either app. A status result from a
previous connection or foreground lifetime must not restore availability.

The microphone beside Send starts a quick note; Stop finalizes it and appends its
text to the existing draft. It never submits a prompt. The Call action in the
header explicitly opts into automatic sending. A new chat is created first if
needed so a call stays bound to a stable session. Replies remain text.

Both modes stream audio to Hex while recording. Mobile batches approximately
500 ms per encrypted request. Call mode uses 100 ms RMS frames, at least 300 ms
above -38 dBFS, followed by 1.5 seconds of quiet, to finish an utterance. This is
a pause heuristic, not semantic turn detection or speaker recognition: nearby
speech can be sent, and a thinking pause can end an instruction. Hex's processing
segments (which can end at its own window limit) never trigger prompt submission.
No partial text is sent to OpenCode. The first version shows recording/transcribing
state, not Hex's partial transcript events.

Capture continues during transcription/submission with at most five seconds of
queued PCM in memory. Overflow stops recording instead of dropping words. A long
60-second turn is added to the draft for review, never split into automatic
prompts. Idle call streams rotate after 30 seconds of silence. Mute discards the
unfinished utterance and prevents audio transmission; unmute starts a new stream.
Hangup, navigation, backgrounding, microphone interruption, changed peer identity,
disconnect, or a pending permission/question stops the voice session. Calls never
answer permissions or questions. Uncertain prompt submission stops the call and
keeps the text for review without automatic retry. The existing prompt journal
and authoritative snapshot reconciliation still govern OpenCode submissions.

Audio is never written to disk. No server-side voice endpoint, public local port,
cloud speech API, background recording service, or durable transcript store is added.
