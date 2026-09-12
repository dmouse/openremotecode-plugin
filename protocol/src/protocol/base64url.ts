const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

export function encodeBase64Url(bytes: ArrayBufferLike | ArrayBufferView): string {
  const value = asUint8Array(bytes)
  let binary = ""
  const chunkSize = 0x8000

  for (let offset = 0; offset < value.length; offset += chunkSize) {
    const chunk = value.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!value || !BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid base64url value")
  }

  const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")

  let binary: string
  try {
    binary = atob(padded)
  } catch {
    throw new Error("Invalid base64url value")
  }

  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (encodeBase64Url(bytes) !== value) {
    throw new Error("Non-canonical base64url value")
  }
  return bytes
}

function asUint8Array(value: ArrayBufferLike | ArrayBufferView): Uint8Array {
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return new Uint8Array(value)
}
