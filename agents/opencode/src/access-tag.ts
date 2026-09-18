// Not a secret: this file ships as published open-source source, and its value must
// be readable to anyone who installs the package. It exists only to cut automated
// scanner/bot noise on the server's public HTTP endpoints before a request reaches
// real auth logic (see server/README.md, "Client Access Tag") — it grants no access
// and proves no identity. Real authorization still comes entirely from pairing and
// connector credentials.
//
// Must match the server operator's CLIENT_ACCESS_TAG. Changing it is a breaking
// release: every connector sends the same value, so older installs are rejected by a
// server that has rotated to a new one until they update.
export const ACCESS_TAG_HEADER = "X-Orc-Access";
export const ACCESS_TAG_VALUE = "orc-client-v1";
