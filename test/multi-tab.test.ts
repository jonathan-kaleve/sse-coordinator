import { describe, it, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { SSECoordinator } from '../src/coordinator';

/**
 * Shared BroadcastChannel mock that routes messages between coordinator instances
 * within the same test, simulating real multi-tab behaviour synchronously.
 *
 * Each channel name has a registry of all active message listeners. When any
 * instance calls postMessage, all OTHER instances on the same channel receive
 * the message immediately (synchronous delivery mirrors how fake timers work).
 */
const channelRegistry = new Map<string, Set<(e: MessageEvent) => void>>();

class SharedBroadcastChannel {
  private ownListeners: Array<(e: MessageEvent) => void> = [];

  constructor(private name: string) {
    if (!channelRegistry.has(name)) channelRegistry.set(name, new Set());
  }

  addEventListener(type: string, handler: (e: MessageEvent) => void) {
    if (type !== 'message') return;
    this.ownListeners.push(handler);
    channelRegistry.get(this.name)!.add(handler);
  }

  removeEventListener(type: string, handler: (e: MessageEvent) => void) {
    if (type !== 'message') return;
    const idx = this.ownListeners.indexOf(handler);
    if (idx !== -1) this.ownListeners.splice(idx, 1);
    channelRegistry.get(this.name)!.delete(handler);
  }

  postMessage(data: unknown) {
    const event = new MessageEvent('message', { data });
    // Snapshot before iterating — handlers may remove themselves during delivery
    for (const listener of [...(channelRegistry.get(this.name) ?? [])]) {
      if (!this.ownListeners.includes(listener)) {
        listener(event);
      }
    }
  }

  close() {
    for (const listener of this.ownListeners) {
      channelRegistry.get(this.name)?.delete(listener);
    }
    this.ownListeners = [];
  }
}

const CHANNEL = 'test-channel';
const TEST_URL = 'https://api.example.com/events';
const TEST_EVENTS = ['message'];

function makeCoordinator(): SSECoordinator {
  const c = new SSECoordinator();
  c.connect({ url: TEST_URL, eventTypes: TEST_EVENTS, channelName: CHANNEL, onEvent: () => {} });
  return c;
}

beforeEach(() => {
  jest.useFakeTimers();
  channelRegistry.clear();

  globalThis.EventSource = class {
    addEventListener() {}
    removeEventListener() {}
    close() {}
    onopen = null;
    onerror = null;
  } as any;

  globalThis.BroadcastChannel = SharedBroadcastChannel as any;
});

afterEach(() => {
  jest.useRealTimers();
  channelRegistry.clear();
});

describe('Multi-tab leader election', () => {
  it('elects exactly one leader when three tabs connect simultaneously', () => {
    // All three connect at the same fake-time instant.
    // The first coordinator's 200ms timer fires first and its immediate
    // heartbeat (sent on promotion) cancels the other two timers via the
    // checkForExistingLeader listener — so only one ever calls promoteToLeader.
    const a = makeCoordinator();
    const b = makeCoordinator();
    const c = makeCoordinator();

    jest.advanceTimersByTime(200);

    const leaders = [a, b, c].filter(x => x.isLeader());
    expect(leaders).toHaveLength(1);

    [a, b, c].forEach(x => x.disconnect());
  });

  it('elects exactly one new leader among two followers when the leader disconnects', () => {
    // Initial election: a, b, c all connect; first one wins.
    const a = makeCoordinator();
    const b = makeCoordinator();
    const c = makeCoordinator();

    jest.advanceTimersByTime(200);

    const [leader] = [a, b, c].filter(x => x.isLeader());
    const followers = [a, b, c].filter(x => !x.isLeader());
    expect(followers).toHaveLength(2);

    // Leader disconnects: both followers call attemptPromotion() with a 100ms
    // timer. When the first follower promotes, its immediate heartbeat updates
    // the second follower's lastLeaderHeartbeat, preventing it from promoting.
    leader.disconnect();
    jest.advanceTimersByTime(200);

    const newLeaders = followers.filter(x => x.isLeader());
    expect(newLeaders).toHaveLength(1);

    followers.forEach(x => x.disconnect());
  });

  it('followers stay as followers while the leader is alive and sending heartbeats', () => {
    const a = makeCoordinator();
    const b = makeCoordinator();
    const c = makeCoordinator();

    jest.advanceTimersByTime(200);

    // Advance well past HEARTBEAT_TIMEOUT (15 s) — the leader's periodic
    // heartbeats keep followers from ever attempting promotion.
    jest.advanceTimersByTime(30_000);

    const leaders = [a, b, c].filter(x => x.isLeader());
    expect(leaders).toHaveLength(1);
    expect([a, b, c].filter(x => !x.isLeader())).toHaveLength(2);

    [a, b, c].forEach(x => x.disconnect());
  });

  it('fires onConnectionChange(true) on the promoted tab after leader failover', () => {
    let createdSources: any[] = [];

    class TrackingEventSource {
      onopen: ((e: Event) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      constructor() { createdSources.push(this); }
      addEventListener() {}
      removeEventListener() {}
      close() {}
      fireOpen() { this.onopen?.(new Event('open')); }
    }
    globalThis.EventSource = TrackingEventSource as any;

    const onChangePrimary = mock(() => {});
    const onChangeFollower = mock(() => {});

    const a = new SSECoordinator();
    a.connect({ url: TEST_URL, eventTypes: TEST_EVENTS, channelName: CHANNEL, onEvent: () => {}, onConnectionChange: onChangePrimary });
    const b = new SSECoordinator();
    b.connect({ url: TEST_URL, eventTypes: TEST_EVENTS, channelName: CHANNEL, onEvent: () => {}, onConnectionChange: onChangeFollower });

    jest.advanceTimersByTime(200);

    // Only the leader (a) created an EventSource
    expect(createdSources).toHaveLength(1);
    createdSources[0].fireOpen();
    expect(onChangePrimary).toHaveBeenCalledWith(true);
    expect(onChangeFollower).not.toHaveBeenCalledWith(true);

    onChangePrimary.mockClear();

    // Leader disconnects; follower promotes and opens its own EventSource
    a.disconnect();
    jest.advanceTimersByTime(200);

    expect(createdSources).toHaveLength(2);
    createdSources[1].fireOpen();
    expect(onChangeFollower).toHaveBeenCalledWith(true);

    b.disconnect();
  });

  it('a late-joining tab detects the leader at its next scheduled heartbeat and stays a follower', () => {
    // a connects and becomes leader, sending an immediate heartbeat at t=200.
    const a = makeCoordinator();
    jest.advanceTimersByTime(200);
    expect(a.isLeader()).toBe(true);

    // Advance to just before a's first scheduled heartbeat (HEARTBEAT_INTERVAL = 5000ms
    // after promotion, so t=5200). lateB's checkForExistingLeader window is 200ms,
    // so lateB connects at t=5100 and its window runs t=5100–5300.
    jest.advanceTimersByTime(4900); // now at t=5100

    const lateB = makeCoordinator();

    // a's scheduled heartbeat fires at t=5200 (within lateB's election window),
    // setting hasLeader=true and cancelling lateB's 200ms promotion timer.
    jest.advanceTimersByTime(400); // now at t=5500

    expect(a.isLeader()).toBe(true);
    expect(lateB.isLeader()).toBe(false);

    [a, lateB].forEach(x => x.disconnect());
  });
});
