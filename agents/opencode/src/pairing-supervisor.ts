import type { ConnectorAuthorization } from "./auth/authorization-store.js"

export interface PairingSupervisorOptions {
  pair(signal: AbortSignal): Promise<ConnectorAuthorization>
  onPaired(authorization: ConnectorAuthorization): void
  onFailure(error: unknown): void
  signal: AbortSignal
  retryDelay?: (failureCount: number) => number
}

export async function supervisePairing(options: PairingSupervisorOptions): Promise<void> {
  let failureCount = 0
  while (!options.signal.aborted) {
    try {
      const authorization = await options.pair(options.signal)
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the signal can abort during the preceding await
      if (!options.signal.aborted) options.onPaired(authorization)
      return
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the signal can abort during the preceding await
      if (options.signal.aborted) return
      failureCount += 1
      options.onFailure(error)
      const delay = options.retryDelay?.(failureCount) ?? retryDelay(failureCount)
      try {
        await abortableDelay(delay, options.signal)
      } catch {
        return
      }
    }
  }
}

function retryDelay(failureCount: number): number {
  return Math.min(1_000 * (2 ** Math.min(failureCount - 1, 5)), 30_000)
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  // AbortSignal.reason is typed `any` and isn't guaranteed to be an Error for a custom abort reason.
  const rejectReason = (reject: (reason: Error) => void) => {
    reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) { rejectReason(reject); return }
    const onAbort = () => {
      clearTimeout(timer)
      rejectReason(reject)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
