import { connectorPublicIdentitySchema, RELAY_PROTOCOL_VERSION, type ConnectorIdentity } from "@openremotecode/protocol";
import {
  FileConnectorAuthorizationStore,
  resolveConnectorAuthorizationPath,
  type ConnectorAuthorization,
} from "./auth/authorization-store.js";
import { maintainConnectorCredential } from "./auth/credential-renewal.js";
import { FileConnectorPairingStore, resolveConnectorPairingPath } from "./auth/pairing-store.js";
import { attemptQueuedRevocation, FileRevocationQueueStore, resolveRevocationQueuePath } from "./auth/revocation-queue.js";
import { CommandDispatcher } from "./command-dispatcher.js";
import { FileConnectorConnectionStatusStore, resolveConnectorConnectionStatusPath } from "./connection-status-store.js";
import {
  FileConnectorIdentityStore,
  resolveConnectorIdentityPath,
} from "./crypto/identity-store.js";
import type { ChatAdapter } from "./chat-adapter.js";
import type { ChatStreamReader } from "./chat-stream.js";
import { resolveConnectorInstanceLockPath, superviseOwnership } from "./instance-lock.js";
import type { SessionReader } from "./opencode-adapter.js";
import type { ProjectMcpReader } from "./project-mcp.js";
import { PairingClient } from "./pairing-client.js";
import { supervisePairing } from "./pairing-supervisor.js";
import { RelayConnection, type RelayLogLevel } from "./relay-connection.js";
import { RemoteAPIClient } from "./remote-api-client.js";
import { configuredServiceOrigin, validateLocalRelayURL } from "./service-origin.js";
import { monitorAuthorization } from "./auth/authorization-monitor.js";

const PLUGIN_VERSION = "0.1.0";
const RELAY_URL_ENVIRONMENT_VARIABLE = "OPENCODE_REMOTE_RELAY_URL";
const TRUSTED_CLIENT_ENVIRONMENT_VARIABLE = "OPENCODE_REMOTE_TRUSTED_CLIENT_IDENTITY";

/// Everything the connector needs from the OpenCode generation that loaded it. The lifecycle
/// below (identity, pairing, relay, ownership) is identical across generations; only how it
/// logs, notifies and reads chats differs, and that lives behind this interface.
export interface ConnectorAdapters {
  sessions: SessionReader
  chats: ChatAdapter
  mcp?: ProjectMcpReader
  stream?: ChatStreamReader
}

export interface ConnectorNotification {
  title: string
  message: string
  variant: "info" | "warning"
  durationMs: number
}

export interface ConnectorHost {
  options: Record<string, unknown>
  log: (level: RelayLogLevel, message: string, extra?: Record<string, unknown>) => Promise<void>
  notify: (notification: ConnectorNotification) => Promise<void>
  adapters: () => ConnectorAdapters
}

export interface ConnectorHandle { dispose?: () => Promise<void> }

export async function startConnector(host: ConnectorHost): Promise<ConnectorHandle> {
  const { options, log } = host;

  let identity: ConnectorIdentity;
  try {
    identity = await new FileConnectorIdentityStore(resolveConnectorIdentityPath()).loadOrCreate();
  } catch (error) {
    deferLog(log, "error", "Connector identity is unavailable", { error: errorMessage(error) });
    return {};
  }

  const connectionStatusStore = new FileConnectorConnectionStatusStore(resolveConnectorConnectionStatusPath());
  // A prior crash could leave a stale "connected" status behind; every fresh start begins unconnected.
  const resetConnectionStatus = (): Promise<void> =>
    connectionStatusStore.replace({ version: 1, connected: false, updatedAt: new Date().toISOString() }).catch(
      (error: unknown) => { deferLog(log, "warn", "Could not reset connector connection status", { error: errorMessage(error) }); },
    );
  const onPresence = (connected: boolean): void => {
    void connectionStatusStore.replace({ version: 1, connected, updatedAt: new Date().toISOString() }).catch(
      (error: unknown) => { deferLog(log, "warn", "Could not persist connector connection status", { error: errorMessage(error) }); },
    );
  };

  const developmentRelay = developmentRelayConfiguration();
  if (developmentRelay) {
    await resetConnectionStatus();
    try {
      const trustedClient = connectorPublicIdentitySchema.parse(JSON.parse(developmentRelay.trustedClient));
      const dispatcher = new CommandDispatcher({
        connectorIdentity: identity,
        trustedClient,
        ...adapterOptions(host.adapters()),
      });
      const relay = createRelay({
        identity,
        dispatcher,
        log,
        onPresence,
        url: validateLocalRelayURL(developmentRelay.url),
      });
      relay.start();
      return {
        dispose: async () => {
          await relay.stop();
          await connectionStatusStore.clear().catch(() => {});
        },
      };
    } catch (error) {
      deferLog(log, "error", "Development relay configuration rejected", { error: errorMessage(error) });
      return {};
    }
  }

  let serviceOrigin: URL;
  try {
    serviceOrigin = configuredServiceOrigin(options);
  } catch (error) {
    deferLog(log, "error", "Remote service configuration rejected", { error: errorMessage(error) });
    return {};
  }

  const startOwned = async (): Promise<() => Promise<void>> => {
    await resetConnectionStatus();
    const authorizationStore = new FileConnectorAuthorizationStore(resolveConnectorAuthorizationPath());
    const pairingStore = new FileConnectorPairingStore(resolveConnectorPairingPath());
    const revocationQueueStore = new FileRevocationQueueStore(resolveRevocationQueuePath());
    const api = new RemoteAPIClient(serviceOrigin);
    const pairingController = new AbortController();
    let pairingTask: Promise<void> | undefined;
    let authorizationTask: Promise<void> | undefined;
    let relay: RelayConnection | undefined;

    // A prior revoke may have disabled this connector locally without reaching the server (an
    // outage or a hostile server refusing revocation must never block the local kill switch).
    // Retrying here, independent of pairing/relay startup, lets the server eventually learn too.
    const revocationRetryTask = attemptQueuedRevocation(revocationQueueStore, pairingController.signal);

    const startAuthorizedRelay = (authorization: ConnectorAuthorization): void => {
      if (
        authorization.connectorKeyId !== identity.publicIdentity.keyId ||
        authorization.serviceOrigin !== serviceOrigin.origin
      ) {
        throw new Error("Stored connector authorization does not match this identity and service");
      }
      const dispatcher = new CommandDispatcher({
        connectorIdentity: identity,
        trustedClient: authorization.trustedClient,
        ...adapterOptions(host.adapters()),
        log: (level, message, extra) => { deferLog(log, level, message, extra); },
      });
      // The live credential changes under the relay when a rotation completes, so admission
      // always reads the current one rather than the value captured at startup.
      let current = authorization;
      let maintaining: Promise<void> | undefined;
      const maintainCredential = (): void => {
        // Renewal runs only after admission has succeeded. Presenting the current credential
        // cancels a pending rotation, so a rotation started before admission would cancel
        // itself on every attempt and the credential would silently reach expiry.
        maintaining ??= maintainConnectorCredential({
          store: authorizationStore,
          api,
          authorization: current,
          signal: pairingController.signal,
        })
          .then(({ authorization: updated, outcome }) => {
            current = updated;
            if (outcome === "unchanged") return;
            deferLog(log, outcome === "renewed" ? "info" : "warn",
              outcome === "renewed" ? "Connector credential renewed" : "Connector credential renewal failed; retrying later");
            // The client is told too, so a renewal that keeps failing is visible on the
            // phone rather than only in a local log nobody is watching.
            dispatcher.reportCredentialRenewal(outcome);
          })
          .catch((error: unknown) => {
            deferLog(log, "warn", "Connector credential renewal failed; retrying later", { error: errorMessage(error) });
          })
          .finally(() => { maintaining = undefined; });
      };
      relay = createRelay({
        identity,
        dispatcher,
        log,
        onPresence,
        admissionProvider: async (signal) => {
          const admission = await api.relayAdmission(current.credential, signal);
          maintainCredential();
          return admission;
        },
      });
      relay.start();
      const authorizedRelay = relay;
      authorizationTask = monitorAuthorization(authorizationStore, authorization, async () => {
        await authorizedRelay.stop();
        deferLog(log, "info", "Remote authorization removed or expired; relay stopped");
      }, pairingController.signal);
    };

    try {
      const authorization = await authorizationStore.load();
      if (authorization && Date.parse(authorization.credentialExpiresAt) > Date.now()) {
        await pairingStore.clear();
        startAuthorizedRelay(authorization);
      } else {
        deferLog(log, "info", "Connector pairing is required; follow the OpenCode notification");
        const pairing = new PairingClient(api, identity, authorizationStore, pairingStore, {
          showPairing: async (userCode, _verificationURI, expiresAt) => {
            await host.notify({
              title: "Pair Open Remote Code",
              message: `In the Open Remote Code mobile app, choose Add connection and enter ${userCode}`,
              variant: "info",
              durationMs: remainingDuration(expiresAt),
            });
          },
          showSafetyCode: async (code, expiresAt) => {
            await host.notify({
              title: "Verify pairing safety code",
              message: code,
              variant: "warning",
              durationMs: remainingDuration(expiresAt),
            });
          },
        });
        pairingTask = supervisePairing({
          pair: (signal) => pairing.pair(signal),
          onPaired: startAuthorizedRelay,
          onFailure: (error) => {
            deferLog(log, "warn", "Connector pairing did not complete; retrying", { error: errorMessage(error) });
          },
          signal: pairingController.signal,
        });
      }
    } catch (error) {
      deferLog(log, "error", "Connector authorization is unavailable", { error: errorMessage(error) });
    }
    return async () => {
      pairingController.abort(new Error("Plugin disposed"));
      await relay?.stop();
      await pairingTask;
      await authorizationTask;
      await revocationRetryTask;
      await connectionStatusStore.clear().catch(() => {});
    };
  };

  // OpenCode loads one plugin instance per directory, all sharing this machine's connector
  // identity, and the relay evicts the older connection when an identity reconnects. Only one
  // instance may hold the connection; see superviseOwnership.
  let stopOwned: (() => Promise<void>) | undefined;
  const ownership = superviseOwnership({
    lockPath: resolveConnectorInstanceLockPath(),
    onAcquired: async () => { stopOwned = await startOwned(); },
    onLost: async () => {
      const stop = stopOwned;
      stopOwned = undefined;
      await stop?.();
    },
    onStandby: () => {
      deferLog(log, "info", "Another OpenCode instance holds the Open Remote Code connection; this directory is reachable " +
        "from the app only if the holder lists it in the projectDirectories plugin option");
    },
  });

  return { dispose: () => ownership.stop() };
}

function adapterOptions(adapters: ConnectorAdapters): {
  sessions: SessionReader; chats: ChatAdapter; mcp?: ProjectMcpReader; stream?: ChatStreamReader
} {
  return {
    sessions: adapters.sessions,
    chats: adapters.chats,
    ...(adapters.mcp ? { mcp: adapters.mcp } : {}),
    ...(adapters.stream ? { stream: adapters.stream } : {}),
  };
}

function createRelay(options: {
  identity: ConnectorIdentity
  dispatcher: CommandDispatcher
  log: (level: RelayLogLevel, message: string, extra?: Record<string, unknown>) => Promise<void>
  onPresence?: (clientConnected: boolean) => void
  url?: URL
  admissionProvider?: (signal: AbortSignal) => ReturnType<RemoteAPIClient["relayAdmission"]>
}): RelayConnection {
  return new RelayConnection({
    ...(options.url ? { url: options.url } : {}),
    ...(options.admissionProvider ? { admissionProvider: options.admissionProvider } : {}),
    onPresence: (connected, epoch) => {
      options.dispatcher.setEpoch(epoch);
      options.onPresence?.(connected);
    },
    log: options.log,
    hello: {
      protocolVersion: RELAY_PROTOCOL_VERSION,
      type: "connector.hello",
      pluginVersion: PLUGIN_VERSION,
      identity: options.identity.publicIdentity,
      capabilities: options.dispatcher.capabilities,
    },
    handleMessage: (message: unknown) => options.dispatcher.handle(message),
    onReady: (send) => options.dispatcher.attachRelay(send),
  });
}

function developmentRelayConfiguration(): { url: string; trustedClient: string } | undefined {
  const url = process.env[RELAY_URL_ENVIRONMENT_VARIABLE]?.trim();
  const trustedClient = process.env[TRUSTED_CLIENT_ENVIRONMENT_VARIABLE]?.trim();
  return url && trustedClient ? { url, trustedClient } : undefined;
}

function remainingDuration(expiresAt: string): number {
  return Math.max(5_000, Math.min(Date.parse(expiresAt) - Date.now(), 600_000));
}

function deferLog(
  log: (level: RelayLogLevel, message: string, extra?: Record<string, unknown>) => Promise<void>,
  level: RelayLogLevel,
  message: string,
  extra?: Record<string, unknown>,
): void {
  setTimeout(() => void log(level, message, extra).catch(() => {}), 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
