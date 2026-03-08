# sse-coordinator

[![npm version](https://img.shields.io/npm/v/sse-coordinator)](https://www.npmjs.com/package/sse-coordinator)
[![bundle size](https://img.shields.io/bundlephobia/minzip/sse-coordinator)](https://bundlephobia.com/package/sse-coordinator)
[![license](https://img.shields.io/npm/l/sse-coordinator)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-blue)](https://www.typescriptlang.org/)

Share a single SSE connection across all browser tabs using BroadcastChannel leader election.

## The Problem

Browsers limit HTTP/1.1 connections to 6–8 per domain. Each tab opening its own `EventSource` exhausts this pool — 10 tabs means 10 SSE connections, blocking all other requests.

## The Solution

`sse-coordinator` elects one tab as the **leader**. Only the leader holds an `EventSource` connection. All other tabs receive events via the [BroadcastChannel API](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel) — zero extra connections.

```
Tab 1 (LEADER) ──── EventSource ────▶ Your Server
Tab 2 (follower) ◀──┐
Tab 3 (follower) ◀──┤── BroadcastChannel
Tab 4 (follower) ◀──┘
```

When the leader tab closes, a follower automatically promotes itself and opens a new connection.

## Install

```bash
npm install sse-coordinator
# or
bun add sse-coordinator
# or
pnpm add sse-coordinator
```

## Usage

```ts
import { SSECoordinator } from 'sse-coordinator';

const coordinator = new SSECoordinator();

coordinator.connect({
  url: 'https://api.example.com/events/stream',
  eventTypes: ['notification.created', 'job.completed'],

  onEvent(event) {
    console.log(event.type, event.data);
  },

  onConnectionChange(connected) {
    console.log('connected:', connected);
  },

  onError(error) {
    console.error('SSE error:', error);
  },
});

// Later:
coordinator.disconnect();
```

## API

### `new SSECoordinator()`

Creates a coordinator instance. Each tab should create its own instance.

### `coordinator.connect(options)`

Starts the coordinator. The tab will either become leader (opening an `EventSource`) or follower (listening via `BroadcastChannel`).

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | `string` | ✓ | — | SSE endpoint URL |
| `eventTypes` | `string[]` | ✓ | — | Named event types to listen for |
| `onEvent` | `(event: SSEEvent) => void` | ✓ | — | Called for every SSE event |
| `channelName` | `string` | | `'sse-coordinator'` | BroadcastChannel name — must match across tabs |
| `withCredentials` | `boolean` | | `false` | Pass cookies with the EventSource request |
| `maxReconnectAttempts` | `number` | | `10` | Max reconnection attempts before calling `onError` |
| `logger` | `Logger` | | none | Optional logger (`{ debug, info, warn, error }`) |
| `onError` | `(error: Error) => void` | | — | Called when max reconnections are exceeded |
| `onConnectionChange` | `(connected: boolean) => void` | | — | Called when the leader's connection opens or closes |

### `coordinator.disconnect()`

Closes the connection and BroadcastChannel. If this tab is the leader, broadcasts a disconnect message so a follower can take over.

### `coordinator.isLeader()`

Returns `true` if this tab currently holds the `EventSource` connection.

### SSEEvent

```ts
interface SSEEvent {
  type: string;
  data: unknown;
  id: string;
  timestamp: string; // ISO 8601
}
```

## How It Works

1. **Leader election** — on `connect()`, the tab waits 200ms for a heartbeat from an existing leader. If none arrives, it promotes itself.
2. **Heartbeat** — the leader broadcasts a heartbeat every 5 seconds. Followers monitor this.
3. **Failover** — if no heartbeat is received for 15 seconds, a follower promotes itself. When a leader tab closes cleanly, it sends a `leader-disconnect` message to trigger immediate promotion.
4. **Reconnection** — the leader reconnects with exponential backoff (capped at 30 seconds) up to `maxReconnectAttempts`.

## Multiple Apps on the Same Domain

If you run multiple independent apps on the same domain, give each a unique `channelName`:

```ts
coordinator.connect({
  url: '...',
  eventTypes: [...],
  channelName: 'my-app-sse',
  onEvent: () => {},
});
```

## Browser Support

Requires [BroadcastChannel API](https://caniuse.com/broadcastchannel) and [`crypto.randomUUID()`](https://caniuse.com/mdn-api_crypto_randomuuid) — supported in Chrome 92+, Firefox 95+, Safari 15.4+, Edge 92+.

## License

MIT

---

Made by [Pareo](https://pareo.ai)
