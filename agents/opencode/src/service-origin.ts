export const DEFAULT_SERVICE_ORIGIN = "http://127.0.0.1:8080";
const INSECURE_LOOPBACK_ENV = "OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function configuredServiceOrigin(
  options: { apiUrl?: unknown } = {},
  environment: NodeJS.ProcessEnv = process.env,
): URL {
  if (options.apiUrl !== undefined) {
    if (typeof options.apiUrl !== "string" || !options.apiUrl.trim()) {
      throw new Error("Remote plugin apiUrl must be a non-empty URL string");
    }
    return validateServiceOrigin(options.apiUrl.trim(), environment);
  }
  return validateServiceOrigin(
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an env var explicitly set to "" must fall back to the default too, not just an unset one
    environment.OPENCODE_REMOTE_SERVER_URL?.trim() || DEFAULT_SERVICE_ORIGIN,
    environment,
  );
}

export function validateServiceOrigin(value: string, environment: NodeJS.ProcessEnv = process.env): URL {
  const url = parseURL(value);
  if (url.username || url.password || /[?#]/u.test(url.href) || url.pathname !== "/") {
    throw new Error("Remote service URL must be an origin without credentials, path, query, or fragment");
  }
  requireSecureTransport(url, "https:", "http:", environment);
  return url;
}

export function validateRelayURL(value: string, environment: NodeJS.ProcessEnv = process.env): URL {
  const url = parseURL(value);
  if (url.username || url.password || /[?#]/u.test(url.href)) {
    throw new Error("Relay URL must not contain credentials, query, or fragment");
  }
  requireSecureTransport(url, "wss:", "ws:", environment);
  return url;
}

export function validateLocalRelayURL(value: string, environment: NodeJS.ProcessEnv = process.env): URL {
  const url = validateRelayURL(value, environment);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("The unauthenticated development relay must remain on loopback");
  }
  return url;
}

function requireSecureTransport(url: URL, secure: string, plaintext: string, environment: NodeJS.ProcessEnv): void {
  const value = environment[INSECURE_LOOPBACK_ENV]?.trim();
  if (value !== undefined && value !== "" && value !== "true" && value !== "false") {
    throw new Error(`${INSECURE_LOOPBACK_ENV} must be true or false`);
  }
  if (url.protocol === secure) return;
  if (url.protocol === plaintext && value === "true" && LOOPBACK_HOSTS.has(url.hostname)) return;
  throw new Error(`Remote connections require ${secure.slice(0, -1).toUpperCase()}; loopback development requires ${INSECURE_LOOPBACK_ENV}=true`);
}

function parseURL(value: string): URL {
  try { return new URL(value); } catch { throw new Error("Remote connection URL is invalid"); }
}
