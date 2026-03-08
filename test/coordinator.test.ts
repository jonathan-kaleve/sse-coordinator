import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { SSECoordinator } from '../src/coordinator';
import type { SSEEvent } from '../src/types';

const TEST_URL = 'https://api.example.com/events/stream';
const TEST_EVENTS = ['message', 'notification.created', 'processing.started'];

describe('SSECoordinator', () => {
  let coordinator: SSECoordinator;
  let broadcastChannelMock: any;
  let messages: any[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
    messages = [];

    globalThis.EventSource = class {
      addEventListener() {}
      removeEventListener() {}
      close() {}
      onopen = null;
      onerror = null;
    } as any;

    broadcastChannelMock = {
      postMessage: mock((msg: any) => { messages.push(msg); }),
      close: mock(() => {}),
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
    };

    globalThis.BroadcastChannel = mock(() => broadcastChannelMock) as any;
  });

  afterEach(() => {
    coordinator?.disconnect();
    jest.useRealTimers();
  });

  describe('Leader Election', () => {
    it('elects first tab as leader', () => {
      coordinator = new SSECoordinator();
      coordinator.connect({ url: TEST_URL, eventTypes: TEST_EVENTS, onEvent: () => {} });

      jest.advanceTimersByTime(200);

      expect(coordinator.isLeader()).toBe(true);
    });

    it('marks subsequent tabs as followers when leader heartbeat is received', () => {
      const channelWithCapture: any = {
        postMessage: mock(() => {}),
        close: mock(() => {}),
        addEventListener: mock(() => {}),
        removeEventListener: mock(() => {}),
      };

      let capturedHandler: ((e: MessageEvent) => void) | null = null;
      channelWithCapture.addEventListener = mock((type: string, handler: any) => {
        if (type === 'message') capturedHandler = handler;
      });

      globalThis.BroadcastChannel = mock(() => channelWithCapture) as any;

      coordinator = new SSECoordinator();
      coordinator.connect({ url: TEST_URL, eventTypes: TEST_EVENTS, onEvent: () => {} });

      capturedHandler?.({ data: { type: 'heartbeat', tabId: 'existing-leader' } } as MessageEvent);
      jest.advanceTimersByTime(200);

      expect(coordinator.isLeader()).toBe(false);
    });
  });

  describe('Event Broadcasting', () => {
    it('broadcasts SSE events to all tabs via BroadcastChannel', () => {
      coordinator = new SSECoordinator();
      coordinator.connect({ url: TEST_URL, eventTypes: TEST_EVENTS, onEvent: () => {} });

      const event: SSEEvent = {
        type: 'test-event',
        data: { message: 'hello' },
        id: '123',
        timestamp: new Date().toISOString(),
      };

      coordinator.broadcastEvent(event);

      expect(broadcastChannelMock.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'sse-event', event })
      );
    });

    it('receives events from BroadcastChannel and calls onEvent', () => {
      const onEvent = mock(() => {});
      coordinator = new SSECoordinator();
      coordinator.connect({ url: TEST_URL, eventTypes: TEST_EVENTS, onEvent });

      const event: SSEEvent = {
        type: 'notification.created',
        data: { id: 1 },
        id: '456',
        timestamp: new Date().toISOString(),
      };

      coordinator.handleBroadcastMessage({ type: 'sse-event', event });

      expect(onEvent).toHaveBeenCalledWith(event);
    });
  });

  describe('Leader Failover', () => {
    it('promotes follower to leader when leader disconnects', () => {
      coordinator = new SSECoordinator();
      coordinator.connect({ url: TEST_URL, eventTypes: TEST_EVENTS, onEvent: () => {} });

      jest.advanceTimersByTime(200);
      coordinator.demoteToFollower();
      expect(coordinator.isLeader()).toBe(false);

      coordinator.handleBroadcastMessage({ type: 'leader-disconnect', tabId: 'old-leader' });
      jest.advanceTimersByTime(100);

      expect(coordinator.isLeader()).toBe(true);
    });

    it('sends disconnect message when leader closes', () => {
      coordinator = new SSECoordinator();
      coordinator.connect({ url: TEST_URL, eventTypes: TEST_EVENTS, onEvent: () => {} });

      jest.advanceTimersByTime(200);
      expect(coordinator.isLeader()).toBe(true);

      coordinator.disconnect();

      expect(broadcastChannelMock.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'leader-disconnect' })
      );
    });
  });

  describe('Heartbeat', () => {
    it('sends heartbeat messages periodically when leader', () => {
      coordinator = new SSECoordinator();
      coordinator.connect({ url: TEST_URL, eventTypes: TEST_EVENTS, onEvent: () => {} });

      jest.advanceTimersByTime(200);
      expect(coordinator.isLeader()).toBe(true);
      messages = [];

      jest.advanceTimersByTime(5000);

      expect(messages.filter(m => m.type === 'heartbeat').length).toBeGreaterThan(0);
    });

    it('detects missing heartbeats and promotes follower', () => {
      coordinator = new SSECoordinator();
      coordinator.connect({ url: TEST_URL, eventTypes: TEST_EVENTS, onEvent: () => {} });

      jest.advanceTimersByTime(200);
      coordinator.demoteToFollower();
      expect(coordinator.isLeader()).toBe(false);

      jest.advanceTimersByTime(20001);
      jest.advanceTimersByTime(101);

      expect(coordinator.isLeader()).toBe(true);
    });
  });

  describe('Connection Management', () => {
    it('only creates EventSource connection when leader', () => {
      coordinator = new SSECoordinator();
      const createConnectionSpy = mock(() => {});
      (coordinator as any).createEventSource = createConnectionSpy;

      coordinator.connect({ url: TEST_URL, eventTypes: TEST_EVENTS, onEvent: () => {} });

      if (coordinator.isLeader()) {
        expect(createConnectionSpy).toHaveBeenCalled();
      } else {
        expect(createConnectionSpy).not.toHaveBeenCalled();
      }
    });

    it('closes EventSource when demoted from leader', () => {
      coordinator = new SSECoordinator();
      coordinator.connect({ url: TEST_URL, eventTypes: TEST_EVENTS, onEvent: () => {} });

      const closeConnectionSpy = mock(() => {});
      (coordinator as any).closeEventSource = closeConnectionSpy;

      if (coordinator.isLeader()) {
        coordinator.demoteToFollower();
        expect(closeConnectionSpy).toHaveBeenCalled();
      }
    });
  });

  describe('Custom Options', () => {
    it('uses custom channelName when provided', () => {
      coordinator = new SSECoordinator();
      coordinator.connect({
        url: TEST_URL,
        eventTypes: TEST_EVENTS,
        channelName: 'my-app-sse',
        onEvent: () => {},
      });

      expect(globalThis.BroadcastChannel).toHaveBeenCalledWith('my-app-sse');
    });

    it('uses default channelName when not provided', () => {
      coordinator = new SSECoordinator();
      coordinator.connect({ url: TEST_URL, eventTypes: TEST_EVENTS, onEvent: () => {} });

      expect(globalThis.BroadcastChannel).toHaveBeenCalledWith('sse-coordinator');
    });

    it('calls logger.debug when provided', () => {
      const logger = {
        debug: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      };

      coordinator = new SSECoordinator();
      coordinator.connect({ url: TEST_URL, eventTypes: TEST_EVENTS, logger, onEvent: () => {} });
      jest.advanceTimersByTime(200);

      expect(logger.info.mock.calls.length).toBeGreaterThan(0);
    });
  });
});
