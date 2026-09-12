# Image Presentation v1

`chat.images` is a display capability, not a callable operation, following the
same shape as [`chat.shell`](CHAT-SHELL.md). A supporting client requests
`includeImages: true` on `chat.snapshot`, `chat.subtask.snapshot`, or
`chat.stream.subscribe` only when the active connector advertises `chat.images`.
Unlike `chat.shell`, this opt-in is independent of `includeTools`: image
attachments are not nested inside a tool part, so no `.refine` dependency
exists between them. Omitting or disabling `includeImages` preserves today's
behavior exactly — a user-sent image still becomes a bounded `[File: filename]`
text label, and an assistant-produced image (for example a screenshot tool
result) is still excluded entirely. The chat protocol remains version 1.

A message part may have `{ id, type: "image", text: "", image }`:

```json
{
  "id": "shot",
  "type": "image",
  "text": "",
  "image": {
    "mime": "image/jpeg",
    "data": "<base64>",
    "width": 480,
    "height": 800
  }
}
```

`image.mime` is always the literal `image/jpeg`, regardless of the source
file's original format. `image.data` is base64, at most `IMAGE_DATA_MAX`
(34,000 units, ≈25.5KB decoded) and counts toward the existing 48,000-unit
per-message budget the same way shell `command`/`output` do. `width`/`height`
are optional, bounded positive integers describing the *re-encoded preview's*
dimensions, not the original file's — they exist purely so a client can
reserve layout space before decoding. No other fields are accepted.

Unlike every other structured part type, an `image` part may appear on a
**user** message, not only an assistant one: a user's own sent photo is
presented as a preview too. A user message's `parts`, when present, may
therefore only contain `text` and `image` entries — tool, subtask, and
reasoning parts remain assistant-only, unchanged. An image part's `text` is
always the empty string and is excluded from the `message.text` concatenation
invariant, the same way reasoning text is excluded.

## Where images come from and why this is always a preview, never the original

OpenCode hands the plugin an image as a `FilePart` with a `mime` and a `url`.
Both a user's own attachment and an assistant/tool-produced image (for
example a `mobile-mcp` screenshot tool result) arrive this way — the
plugin does not need to know which produced it. The plugin only accepts a
`FilePart` whose `mime` is `image/png`, `image/jpeg`, or `image/webp` **and**
whose `url` is an inline `data:<mime>;base64,...` URI matching that mime. A
filesystem path, `file://` reference, or remote URL is never fetched or
followed — if the part isn't already carrying its bytes inline, it is treated
exactly like any other non-image file (`[File: filename]` for a user message,
excluded for an assistant message).

The plugin decodes the inline bytes, guards the declared/decoded dimensions
against a fixed cap before allocating any buffer, and re-encodes a shrunk
JPEG preview: a fixed ladder of (long-edge, quality) pairs is tried from
largest to smallest, stopping at the first result that fits the budget. There
is no larger or original-resolution version to fetch later — the relay is a
live, non-retained pass-through, and this feature intentionally ships only a
small preview (see the size/quality trade-off recorded when this capability
was designed). If even the smallest ladder step does not fit the remaining
budget, or a decode fails, the image is dropped and the part falls back to
today's text-label/exclusion behavior instead of silently disappearing with
no trace; the message's `truncated` flag is set the same way a shortened
shell result sets it.

Re-encoding from decoded pixels is also a deliberate privacy property, not
just a size optimization: it strips all embedded metadata from the original
file (EXIF, ICC profiles, GPS tags, capture device info, etc.) because
none of it survives a decode/re-encode round trip. Only a flat raster
preview crosses the boundary.

## Threat analysis

- **Expanded disclosure boundary:** a small preview of a user's own photo or
  an assistant/tool screenshot — potentially showing on-screen sensitive
  content — now crosses the boundary as an intentional, capability-gated
  exception, the same category of decision as `chat.shell`. This is not a
  claim that previews are redacted; it is a bounded, low-resolution
  disclosure of what would otherwise already be visible on the paired device
  or in the OpenCode session.
- **Confidentiality:** previews travel only inside the existing authenticated
  end-to-end encrypted snapshot/stream. The server still routes opaque
  envelopes and retains nothing. No new logs, metrics, disk cache, or
  clipboard writes are introduced by this capability. Mobile keeps decoded
  bytes in bounded in-memory state only, consistent with the product's "no
  durable offline copy" position.
- **Hostile content / resource exhaustion:** the plugin only ever decodes
  bytes already resident in the part it was handed (never a fetched path or
  URL), rejects any non-allowlisted mime up front, and bounds declared
  dimensions before allocating a decode buffer to block a decompression-bomb
  style payload. A decode failure drops the image rather than crashing or
  retrying. The existing 100-part, 48,000-unit message, ten-message page,
  200-retained-message mobile, and relay frame limits all still apply
  unchanged — this capability introduces no new size ceiling anywhere in the
  pipeline, only a small new consumer of the existing one.
- **Integrity of re-encoding:** the output is always a freshly re-encoded
  JPEG from decoded pixels, never a copy of input bytes, which is also why no
  embedded metadata from the original file can survive into the preview.
- **Authorization:** no new SDK endpoint, remote capability, permission
  grant, or file-read path is introduced. Existing client trust, account
  isolation, project/session membership, and revocation checks apply
  unchanged; this is purely an additional presentation field inside already
  authorized snapshots.

The shared `chat-image-v1.json` fixture covers a PNG screenshot (exercising
transcoding) and a user-sent JPEG photo alongside an unrelated non-image
file attachment (proving the existing `[File: filename]` fallback is
unaffected). Protocol tests cover strict field validation, the relaxed
user-role `parts` invariant, and budget interaction. Plugin tests cover mime
allowlisting, non-data-URL rejection, the resize ladder landing under budget,
decode-failure fallback, and metadata stripping, plus an isolated native
OpenCode integration case proving the encrypted opt-in snapshot carries a
real attachment end-to-end.
