# Leased Read-Only Project MCP Status

Status: accepted

MCP server availability belongs to an authorized project, not a chat snapshot.
We expose an independent encrypted snapshot/subscribe/unsubscribe topic and a
non-callable updated event capability. The exact contract, shared fixture and
threat analysis are in [PROJECT-MCP](../../../../protocol/PROJECT-MCP.md).

The supplied root SDK pinned at 1.18.25 provides
`mcp.status({ query: { directory }, signal })`. Current v2 documentation uses a
different signature. The adapter reuses chat's configured project registry and
rechecks canonical directory/device/inode membership before and after each call.
Only validated names and the five status discriminators cross the adapter boundary.
No configuration, authentication, connection mutation or tool execution is exposed.

Without a reliable complete status event stream, poll only active subscriptions.
Each trusted-client dispatcher has four slots, 60-second leases, serialized
renewals/revisions and three-second polling after completed reads/sends. One
ten-second deadline bounds waiting for each read, including authorization. Native
failures are unavailable, not empty-ready. Clients renew at 30 seconds.

Cancellation cannot stop unabortable filesystem work or an SDK ignoring its
signal. A reader-scoped weak counter therefore allows at most four outstanding
underlying reads across snapshots and subscriptions using that adapter instance.
Each reservation remains until actual fulfillment or rejection, even after timeout,
unsubscribe, lease expiry, disposal or relay reattachment. Saturated requests return
unavailable without starting or queuing I/O. Only counts, not a growing promise
collection, are retained. Synchronous reader failures also release reservations.
This bounds outstanding work independently of how quickly callers stop waiting;
four permanently hung reads deliberately keep that reader unavailable until they
settle or the local process/adapter is replaced.

Expiry removes orphan clients without requiring connector disconnection. Socket
closure/disposal invalidates pending reads/encryption; reconnect requires fresh
subscriptions. Encrypted event senders bind to their admitted socket generation.
There is no application event queue, and socket saturation disconnects rather
than losing authoritative updates or growing memory without bounds.

Server names and changed names may be sensitive: they stay E2EE and are never
logged or added to routing/telemetry metadata. Existing trusted-peer HPKE,
recipient validation, replay protection and account isolation remain unchanged.
