# Model + Reasoning Effort v1

`chat.models` accepts the strict body `{ version: 1, projectId }` and returns
`{ version: 1, models: ModelSummary[] }` (bounded to 200 entries). Each summary is
`{ providerID, providerName, modelID, modelName, effortLevels? }`; `effortLevels`,
when present, is 1-10 bounded ids and is only ever included for a model OpenCode
itself reports as supporting a variable reasoning-effort choice (its own `variant`
concept). Its absence means the model has no such choice -- clients must not offer
one. Ids are not a fixed set: OpenCode ships different built-in variants per
provider (for example OpenAI's `none`/`minimal`/`low`/`medium`/`high`/`xhigh` vs.
Anthropic's `high`/`max`), and a user's own config can define arbitrarily named
variants -- clients must treat `effortLevels` as opaque, display-as-reported
choices, never assume or hardcode a particular set.

`chat.prompt` gains an optional `model` field: `{ providerID, modelID, effort? }`.
`effort` is only meaningful paired with a `providerID`/`modelID`, and must be one
of that model's own reported `effortLevels` -- not a fixed enum. Extra fields or
null are rejected. The response remains `{ version: 1, accepted: true }`.

`chat.snapshot`/`chat.subtask.snapshot` gain the same optional `model` field on
their response, reporting the model (and effort, if any) the most recent
assistant reply actually used -- so a client reopening a chat it didn't just
send from can recover what it's using, instead of showing nothing. It is
present only on an unpaginated (latest-page) snapshot request, since only that
page reliably contains the true most recent reply; a client must not treat its
absence on an earlier-history page as "no model was ever used." Absent entirely
for a chat with no assistant reply yet.

## Compatibility

`chat.models` is a normal capability-gated operation like `chat.list`: its key
in `chatRequests`/`chatResponses` is enough to advertise support, no separate
marker needed. `chat.prompt.model` is a separate, non-callable capability marker
-- like `chat.prompt.mode` -- advertised alongside `chat.prompt` when the connector
accepts the `model` field. Dispatching `chat.prompt.model` directly returns
`unsupported_operation`.

Mobile should offer model/effort selection only when the active connector
advertises `chat.models`, `chat.prompt`, and `chat.prompt.model` together. Without
all three, omit `model` from `chat.prompt` and do not promise selection -- the
existing text-only and mode-only clients remain valid; omission leaves OpenCode's
local default model in effect. Recheck capabilities after reconnect. As with mode,
do not retry a prompt automatically, including by dropping `model`/`effort` after
a failure or uncertain outcome.

## Threat Analysis

- `chat.models` returns only what OpenCode itself reports as configured providers
  and models for the requesting project's directory -- the same project-membership
  authorization as every other project-scoped operation. No credentials, API keys,
  or raw provider config leave this boundary; only bounded id/name pairs and each
  model's own reported effort-variant ids -- never the provider-specific request
  overrides (reasoning tokens, thinking budgets, provider option bags) a variant
  maps to internally. `chat.snapshot`'s recovered `model` field is bounded the
  same way -- the two id fields and an effort id, read from the already-authorized
  message history, never a raw message object.
- `chat.prompt`'s `model`/`effort` values are never spread into the SDK call. The
  adapter narrows them to the two id fields it forwards and, before honoring an
  `effort` value, re-validates the pair against its own last-known provider data --
  a client asserting an effort level a model doesn't actually support is rejected
  server-side, not just gated by the mobile UI. This mirrors the "narrow, never
  spread" handling of `mode` in CHAT-PROMPT-MODE.md.
- Model/provider choice is bounded to whatever OpenCode's local configuration
  already exposes; this marker promises field support, not that a particular
  provider or model is available, authenticated, or affordable. Local overrides
  can change what's configured at any time -- a validated selection is a snapshot,
  not a persistent guarantee.
- No new direct shell, filesystem, configuration, or persistent permission grants
  are exposed. Existing project/session authorization, child-session rejection,
  trusted-device authentication, deadlines, replay rejection, and bounded mutation
  deduplication still apply unchanged. Model/effort travel only inside the
  authenticated encrypted `chat.prompt`/`chat.models` payloads; no plaintext
  provider/model choices, SDK errors, or raw options bags reach logs or outer
  metadata.

The shared [fixture](test/fixtures/chat-model-v1.json) validates both `chat.models`
request/response bounds and `chat.prompt`'s `model`/`effort` bounds; see
[test/chat-model.test.mjs](test/chat-model.test.mjs).
