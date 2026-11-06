import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { utf16Length } from "@openremotecode/protocol";

export class VoiceError extends Error {
  constructor(readonly code: "voice_unavailable" | "voice_busy" | "voice_expired") { super(code); }
}
export interface VoiceStream {
  append(audio: Uint8Array, signal: AbortSignal): Promise<void>
  finish(signal: AbortSignal): Promise<string>
  cancel(): Promise<void>
}
export interface VoiceEngine {
  available(signal: AbortSignal): Promise<boolean>
  start(signal: AbortSignal): Promise<VoiceStream>
}

const discoverySchema = z.object({ port: z.number().int().min(1).max(65535),
  token: z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/u), apiVersion: z.literal("2") });
type Discovery = z.infer<typeof discoverySchema>;
const opened = z.object({ id: z.number().int().nonnegative(), ownerToken: z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/u),
  sampleRate: z.literal(16000), sampleFormat: z.literal("s16le") });

async function discover(): Promise<Discovery> {
  const folder = process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "hex")
    : process.platform === "win32" ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "hex")
    : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "hex");
  const file = await open(join(folder, "local-api.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096 || (process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new VoiceError("voice_unavailable");
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new VoiceError("voice_unavailable");
    return discoverySchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
  } finally { await file.close(); }
}

// Bound even a compromised localhost response. No request/response body or token is logged.
async function json(response: Response): Promise<unknown> {
  if (!response.body) throw new VoiceError("voice_unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 256000) throw new VoiceError("voice_unavailable");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { await reader.cancel().catch(() => {}); }
}

/** Only fixed localhost routes are reachable; neither the phone nor discovery supplies a URL. */
export class HexVoiceEngine implements VoiceEngine {
  constructor(readonly discovery: () => Promise<Discovery> = discover, readonly fetcher: typeof fetch = fetch) {}

  async available(signal: AbortSignal): Promise<boolean> {
    const abort = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
    try {
      const endpoint = discoverySchema.parse(await this.discovery());
      const read = async (path: string): Promise<unknown> => {
        abort.throwIfAborted();
        const response = await this.fetcher(`http://127.0.0.1:${String(endpoint.port)}${path}`, {
          method: "GET", redirect: "error", signal: abort,
          headers: { Authorization: `Bearer ${endpoint.token}` },
        });
        if (!response.ok) { await response.body?.cancel(); throw new VoiceError("voice_unavailable"); }
        return json(response);
      };
      z.object({ version: z.string().check(utf16Length(1, 128)), apiVersion: z.literal("2") }).parse(await read("/health"));
      const capabilities = z.object({ streams: z.boolean() }).parse(await read("/capabilities"));
      abort.throwIfAborted();
      return capabilities.streams;
    } catch { return false; }
  }

  async start(signal: AbortSignal): Promise<VoiceStream> {
    const endpoint = discoverySchema.parse(await this.discovery());
    signal.throwIfAborted();
    const call = async (path: string, body: string | Uint8Array, type: string, abort: AbortSignal,
        owner?: string, timeout = 5000): Promise<Response> => {
      const response = await this.fetcher(`http://127.0.0.1:${String(endpoint.port)}${path}`, {
        method: "POST", redirect: "error", signal: AbortSignal.any([abort, AbortSignal.timeout(timeout)]),
        headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": type,
          "Content-Length": String(typeof body === "string" ? Buffer.byteLength(body) : body.length),
          ...(owner ? { "X-Hex-Stream-Token": owner } : {}) },
        body: typeof body === "string" ? body : new Uint8Array(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new VoiceError(response.status === 409 || response.status === 429 ? "voice_busy" : "voice_unavailable");
      }
      return response;
    };
    const stream = opened.parse(await json(await call("/streams",
      JSON.stringify({ sampleRate: 16000, sampleFormat: "s16le" }), "application/json", signal)));
    let ended = false;
    const cancel = async (): Promise<void> => {
      if (ended) return;
      ended = true;
      await call(`/streams/${String(stream.id)}/cancel`, "", "application/json", new AbortController().signal,
        stream.ownerToken, 2000).then(async (response) => { await response.body?.cancel(); }).catch(() => {});
    };
    if (signal.aborted) { await cancel(); signal.throwIfAborted(); }
    return {
      append: async (audio, abort) => {
        if (ended) throw new VoiceError("voice_expired");
        const response = await call(`/streams/${String(stream.id)}/audio`, audio, "application/octet-stream", abort, stream.ownerToken);
        await response.body?.cancel();
      },
      finish: async (abort) => {
        if (ended) throw new VoiceError("voice_expired");
        const result = z.object({ text: z.string().check(utf16Length(0, 32000)) }).parse(await json(await call(
          `/streams/${String(stream.id)}/finish`, "", "application/json", abort, stream.ownerToken, 15000)));
        ended = true;
        return result.text.trim();
      },
      cancel,
    };
  }
}
