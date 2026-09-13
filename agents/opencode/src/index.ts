import type { Plugin } from "@opencode-ai/plugin"

import { connectorPublicIdentitySchema, type ConnectorIdentity } from "@openremotecode/protocol"
import {
  FileConnectorAuthorizationStore,
  resolveConnectorAuthorizationPath,
  type ConnectorAuthorization,
} from "./auth/authorization-store.js"
import { FileConnectorPairingStore, resolveConnectorPairingPath } from "./auth/pairing-store.js"
import { CommandDispatcher } from "./command-dispatcher.js"
import { FileConnectorConnectionStatusStore, resolveConnectorConnectionStatusPath } from "./connection-status-store.js"
import {
  FileConnectorIdentityStore,
  resolveConnectorIdentityPath,
} from "./crypto/identity-store.js"
import { OpenCodeChatAdapter } from "./chat-adapter.js"
import { OpenCodeAdapter } from "./opencode-adapter.js"
import { PairingClient } from "./pairing-client.js"
import { supervisePairing } from "./pairing-supervisor.js"
import { RelayConnection, type RelayLogLevel } from "./relay-connection.js"
import { RemoteAPIClient } from "./remote-api-client.js"
import { configuredServiceOrigin, validateLocalRelayURL } from "./service-origin.js"
import { monitorAuthorization } from "./auth/authorization-monitor.js"

const PLUGIN_VERSION = "0.1.0"
const RELAY_URL_ENVIRONMENT_VARIABLE = "OPENCODE_REMOTE_RELAY_URL"
const TRUSTED_CLIENT_ENVIRONMENT_VARIABLE = "OPENCODE_REMOTE_TRUSTED_CLIENT_IDENTITY"

export const OpenCodeRemotePlugin: Plugin = async ({ client, directory }, options = {}) => {
  const log = async (
    level: RelayLogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): Promise<void> => {
    await client.app.log({
      body: {
        service: "opencode-remote",
        level,
        message,
        ...(extra ? { extra } : {}),
      },
    })
  }

  let identity: ConnectorIdentity
  try {
    identity = await new FileConnectorIdentityStore(resolveConnectorIdentityPath()).loadOrCreate()
  } catch (error) {
    deferLog(log, "error", "Connector identity is unavailable", { error: errorMessage(error) })
    return {}
  }

  const connectionStatusStore = new FileConnectorConnectionStatusStore(resolveConnectorConnectionStatusPath())
  // A prior crash could leave a stale "connected" status behind; every fresh start begins unconnected.
  await connectionStatusStore.replace({ version: 1, connected: false, updatedAt: new Date().toISOString() }).catch(
    (error: unknown) => { deferLog(log, "warn", "Could not reset connector connection status", { error: errorMessage(error) }); },
  )
  const onPresence = (connected: boolean): void => {
    void connectionStatusStore.replace({ version: 1, connected, updatedAt: new Date().toISOString() }).catch(
      (error: unknown) => { deferLog(log, "warn", "Could not persist connector connection status", { error: errorMessage(error) }); },
    )
  }

  const developmentRelay = developmentRelayConfiguration()
  if (developmentRelay) {
    try {
      const trustedClient = connectorPublicIdentitySchema.parse(JSON.parse(developmentRelay.trustedClient))
      const chats = new OpenCodeChatAdapter(client, directory, options.projectDirectories)
      const dispatcher = new CommandDispatcher({
        connectorIdentity: identity,
        trustedClient,
        sessions: new OpenCodeAdapter(client),
        chats,
        mcp: chats,
        stream: chats,
      })
      const relay = createRelay({
        identity,
        dispatcher,
        log,
        onPresence,
        url: validateLocalRelayURL(developmentRelay.url),
      })
      relay.start()
      return {
        dispose: async () => {
          await relay.stop()
          await connectionStatusStore.clear().catch(() => {})
        },
      }
    } catch (error) {
      deferLog(log, "error", "Development relay configuration rejected", { error: errorMessage(error) })
      return {}
    }
  }

  let serviceOrigin: URL
  try {
    serviceOrigin = configuredServiceOrigin(options)
  } catch (error) {
    deferLog(log, "error", "Remote service configuration rejected", { error: errorMessage(error) })
    return {}
  }

  const authorizationStore = new FileConnectorAuthorizationStore(resolveConnectorAuthorizationPath())
  const pairingStore = new FileConnectorPairingStore(resolveConnectorPairingPath())
  const api = new RemoteAPIClient(serviceOrigin)
  const pairingController = new AbortController()
  let pairingTask: Promise<void> | undefined
  let authorizationTask: Promise<void> | undefined
  let relay: RelayConnection | undefined

  const startAuthorizedRelay = (authorization: ConnectorAuthorization): void => {
    if (
      authorization.connectorKeyId !== identity.publicIdentity.keyId ||
      authorization.serviceOrigin !== serviceOrigin.origin
    ) {
      throw new Error("Stored connector authorization does not match this identity and service")
    }
    const chats = new OpenCodeChatAdapter(client, directory, options.projectDirectories)
    const dispatcher = new CommandDispatcher({
      connectorIdentity: identity,
      trustedClient: authorization.trustedClient,
      sessions: new OpenCodeAdapter(client),
      chats,
      mcp: chats,
      stream: chats,
    })
    relay = createRelay({
      identity,
      dispatcher,
      log,
      onPresence,
      admissionProvider: (signal) => api.relayAdmission(authorization.credential, signal),
    })
    relay.start()
    const authorizedRelay = relay
    authorizationTask = monitorAuthorization(authorizationStore, authorization, async () => {
      await authorizedRelay.stop()
      deferLog(log, "info", "Remote authorization removed or expired; relay stopped")
    }, pairingController.signal)
  }

  try {
    const authorization = await authorizationStore.load()
    if (authorization && Date.parse(authorization.credentialExpiresAt) > Date.now()) {
      await pairingStore.clear()
      startAuthorizedRelay(authorization)
    } else {
      deferLog(log, "info", "Connector pairing is required; follow the OpenCode notification")
      const pairing = new PairingClient(api, identity, authorizationStore, pairingStore, {
        showPairing: async (userCode, _verificationURI, expiresAt) => {
          await client.tui.showToast({
            body: {
              title: "Pair Open Remote Code",
              message: `In the Open Remote Code mobile app, choose Add connection and enter ${userCode}`,
              variant: "info",
              duration: remainingDuration(expiresAt),
            },
          })
        },
        showSafetyCode: async (code, expiresAt) => {
          await client.tui.showToast({
            body: {
              title: "Verify pairing safety code",
              message: code,
              variant: "warning",
              duration: remainingDuration(expiresAt),
            },
          })
        },
      })
      pairingTask = supervisePairing({
        pair: (signal) => pairing.pair(signal),
        onPaired: startAuthorizedRelay,
        onFailure: (error) => {
          deferLog(log, "warn", "Connector pairing did not complete; retrying", { error: errorMessage(error) })
        },
        signal: pairingController.signal,
      })
    }
  } catch (error) {
    deferLog(log, "error", "Connector authorization is unavailable", { error: errorMessage(error) })
  }

  return {
    dispose: async () => {
      pairingController.abort(new Error("Plugin disposed"))
      await relay?.stop()
      await pairingTask
      await authorizationTask
      await connectionStatusStore.clear().catch(() => {})
    },
  }
}

export default OpenCodeRemotePlugin

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
    ...(options.onPresence ? { onPresence: options.onPresence } : {}),
    log: options.log,
    hello: {
      protocolVersion: 1,
      type: "connector.hello",
      pluginVersion: PLUGIN_VERSION,
      identity: options.identity.publicIdentity,
      capabilities: options.dispatcher.capabilities,
    },
    handleMessage: (message: unknown) => options.dispatcher.handle(message),
    onReady: (send) => options.dispatcher.attachRelay(send),
  })
}

function developmentRelayConfiguration(): { url: string; trustedClient: string } | undefined {
  const url = process.env[RELAY_URL_ENVIRONMENT_VARIABLE]?.trim()
  const trustedClient = process.env[TRUSTED_CLIENT_ENVIRONMENT_VARIABLE]?.trim()
  return url && trustedClient ? { url, trustedClient } : undefined
}

function remainingDuration(expiresAt: string): number {
  return Math.max(5_000, Math.min(Date.parse(expiresAt) - Date.now(), 600_000))
}

function deferLog(
  log: (level: RelayLogLevel, message: string, extra?: Record<string, unknown>) => Promise<void>,
  level: RelayLogLevel,
  message: string,
  extra?: Record<string, unknown>,
): void {
  setTimeout(() => void log(level, message, extra).catch(() => {}), 0)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
