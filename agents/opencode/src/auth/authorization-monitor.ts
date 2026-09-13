import { setTimeout as delay } from "node:timers/promises"

import type { ConnectorAuthorization, ConnectorAuthorizationStore } from "./authorization-store.js"

export async function monitorAuthorization(
  store: ConnectorAuthorizationStore,
  authorization: ConnectorAuthorization,
  onInvalid: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    let current: ConnectorAuthorization | undefined
    try { current = await store.load() } catch { /* Unreadable authorization fails closed. */ }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- TS narrows this from the while-guard, but the signal can abort during the preceding await
    if (signal.aborted) return
    if (current?.credential !== authorization.credential ||
      current.serviceOrigin !== authorization.serviceOrigin ||
      current.connectorKeyId !== authorization.connectorKeyId ||
      Date.parse(current.credentialExpiresAt) <= Date.now()) {
      await onInvalid()
      return
    }
    try { await delay(250, undefined, { signal }) } catch { return }
  }
}
