import { z } from "zod";
import { utf16Length } from "./utf16.js";
import { decodeBase64Url } from "./base64url.js";

export const VOICE_VERSION = 1 as const;
export const VOICE_CHUNK_BYTES = 16000; // 500 ms, mono signed PCM16 at 16 kHz.
export const VOICE_MAX_AUDIO_BYTES = 1920000; // 60 seconds per utterance.
const version = { version: z.literal(VOICE_VERSION) };
const target = { ...version, voiceId: z.uuid() };
const audio = z.string().min(3).max(21334).regex(/^[A-Za-z0-9_-]+$/u)
  .refine((value) => {
    if (value.length > 21334) return false;
    try {
      const bytes = decodeBase64Url(value);
      return bytes.length > 0 && bytes.length <= VOICE_CHUNK_BYTES && bytes.length % 2 === 0;
    } catch { return false; }
  });

export const voiceRequests = {
  "voice.status": z.object(version).strict(),
  "voice.start": z.object({ ...target, projectId: z.uuid(), sessionId: z.string().check(utf16Length(1, 128)).optional() }).strict(),
  "voice.audio": z.object({ ...target, sequence: z.number().int().min(0).max(5999), audio }).strict(),
  "voice.finish": z.object(target).strict(),
  "voice.cancel": z.object(target).strict(),
} as const;
export const voiceResponses = {
  "voice.status": z.object({ ...version, available: z.boolean() }).strict(),
  "voice.start": z.object({ ...target, sampleRate: z.literal(16000), sampleFormat: z.literal("s16le"),
    maxChunkBytes: z.literal(VOICE_CHUNK_BYTES), maxDurationMs: z.literal(60000) }).strict(),
  "voice.audio": z.object({ ...target, sequence: z.number().int().min(0).max(5999) }).strict(),
  "voice.finish": z.object({ ...target, text: z.string().check(utf16Length(0, 32000)) }).strict(),
  "voice.cancel": z.object({ ...target, cancelled: z.literal(true) }).strict(),
} as const;
export const VOICE_CAPABILITIES = Object.keys(voiceRequests);
export type VoiceOperation = keyof typeof voiceRequests;
export type VoiceTarget = z.infer<typeof voiceRequests["voice.start"]>;
