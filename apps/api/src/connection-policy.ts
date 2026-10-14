/** How long a closing socket gets to finish the close handshake before it is terminated. */
export const CLOSE_HANDSHAKE_TIMEOUT_MS = 5_000;

/** Interval between pings; a socket that did not pong by the next tick is dead. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Unsent bytes a socket may hold before it counts as a slow consumer. */
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
