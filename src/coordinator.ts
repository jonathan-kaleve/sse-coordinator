import type { SSECoordinatorOptions, SSEEvent } from './types';

const DEFAULT_CHANNEL_NAME = 'sse-coordinator';
const HEARTBEAT_INTERVAL = 5000;
const HEARTBEAT_TIMEOUT = 15000;
const PROMOTION_DELAY = 100;

interface BroadcastMessage {
  type: 'sse-event' | 'heartbeat' | 'leader-disconnect';
  tabId?: string;
  event?: SSEEvent;
  timestamp?: number;
}

export class SSECoordinator {
  private channel: BroadcastChannel | null = null;
  private eventSource: EventSource | null = null;
  private isLeaderTab = false;
  private tabId: string;
  private currentOptions: SSECoordinatorOptions | null = null;
  private heartbeatInterval: number | null = null;
  private heartbeatTimeoutId: number | null = null;
  private lastLeaderHeartbeat: number = Date.now();
  private reconnectAttempts = 0;

  constructor() {
    this.tabId = `tab-${Math.random().toString(36).substring(2, 11)}`;
  }

  connect(options: SSECoordinatorOptions): void {
    this.currentOptions = options;

    const channelName = options.channelName ?? DEFAULT_CHANNEL_NAME;
    this.channel = new BroadcastChannel(channelName);
    this.channel.addEventListener('message', this.handleBroadcastMessage.bind(this));

    this.checkForExistingLeader();
    this.startHeartbeatMonitoring();
  }

  disconnect(): void {
    if (this.isLeaderTab) {
      this.broadcast({ type: 'leader-disconnect', tabId: this.tabId });
    }

    this.closeEventSource();
    this.stopHeartbeat();
    this.stopHeartbeatMonitoring();

    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }

    this.currentOptions = null;
  }

  isLeader(): boolean {
    return this.isLeaderTab;
  }

  broadcastEvent(event: SSEEvent): void {
    this.broadcast({ type: 'sse-event', event });
  }

  handleBroadcastMessage(messageOrEvent: BroadcastMessage | MessageEvent): void {
    const message: BroadcastMessage =
      'data' in messageOrEvent ? (messageOrEvent as MessageEvent).data : messageOrEvent;

    if (message.tabId === this.tabId) return;

    switch (message.type) {
      case 'sse-event':
        if (message.event && this.currentOptions) {
          this.currentOptions.onEvent(message.event);
        }
        break;

      case 'heartbeat':
        this.lastLeaderHeartbeat = Date.now();
        if (this.isLeaderTab && message.tabId !== this.tabId) {
          this.log('debug', 'Another leader detected, demoting to follower');
          this.demoteToFollower();
        }
        break;

      case 'leader-disconnect':
        this.log('debug', 'Leader disconnected, attempting promotion');
        this.attemptPromotion();
        break;
    }
  }

  demoteToFollower(): void {
    if (!this.isLeaderTab) return;
    this.log('info', 'Demoting to follower');
    this.isLeaderTab = false;
    this.closeEventSource();
    this.stopHeartbeat();
  }

  private checkForExistingLeader(): void {
    let hasLeader = false;

    const checkTimeout = setTimeout(() => {
      this.channel?.removeEventListener('message', handleMessage);
      if (!hasLeader) {
        this.promoteToLeader();
      }
    }, 200);

    const handleMessage = (e: MessageEvent) => {
      const message: BroadcastMessage = e.data;
      if (message.type === 'heartbeat') {
        hasLeader = true;
        clearTimeout(checkTimeout);
        this.channel?.removeEventListener('message', handleMessage);
        this.lastLeaderHeartbeat = Date.now();
      }
    };

    this.channel?.addEventListener('message', handleMessage);
  }

  private promoteToLeader(): void {
    if (this.isLeaderTab) return;
    this.log('info', 'Promoting to leader');
    this.isLeaderTab = true;
    this.createEventSource();
    this.startHeartbeat();
  }

  private attemptPromotion(): void {
    setTimeout(() => {
      if (!this.isLeaderTab) {
        this.promoteToLeader();
      }
    }, PROMOTION_DELAY);
  }

  private createEventSource(): void {
    if (this.eventSource || !this.currentOptions) return;

    const { url, eventTypes, withCredentials = true } = this.currentOptions;
    this.eventSource = new EventSource(url, { withCredentials });

    this.eventSource.onopen = () => {
      this.reconnectAttempts = 0;
      this.currentOptions?.onConnectionChange?.(true);
      this.log('debug', 'Leader connection established');
    };

    eventTypes.forEach(type => {
      this.eventSource!.addEventListener(type, (e: MessageEvent) => {
        try {
          const event: SSEEvent = {
            type,
            data: JSON.parse(e.data),
            id: e.lastEventId,
            timestamp: new Date().toISOString(),
          };
          this.currentOptions?.onEvent(event);
          this.broadcastEvent(event);
        } catch {
          this.log('error', `Failed to parse event: ${type}`);
        }
      });
    });

    this.eventSource.onerror = () => {
      this.currentOptions?.onConnectionChange?.(false);
      this.log('warn', 'Leader connection error');
      this.handleReconnect();
    };
  }

  private closeEventSource(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
      this.currentOptions?.onConnectionChange?.(false);
    }
  }

  private handleReconnect(): void {
    if (!this.isLeaderTab || !this.currentOptions) return;

    const maxAttempts = this.currentOptions.maxReconnectAttempts ?? 10;
    if (this.reconnectAttempts >= maxAttempts) {
      this.log('warn', 'Max reconnection attempts reached');
      this.currentOptions.onError?.(new Error('Max reconnection attempts reached'));
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.log('debug', `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${maxAttempts})`);

    setTimeout(() => {
      if (this.isLeaderTab) {
        this.closeEventSource();
        this.createEventSource();
      }
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      this.broadcast({ type: 'heartbeat', tabId: this.tabId, timestamp: Date.now() });
    }, HEARTBEAT_INTERVAL) as unknown as number;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private startHeartbeatMonitoring(): void {
    this.stopHeartbeatMonitoring();
    this.heartbeatTimeoutId = setInterval(() => {
      if (this.isLeaderTab) return;
      if (Date.now() - this.lastLeaderHeartbeat > HEARTBEAT_TIMEOUT) {
        this.log('warn', 'Leader heartbeat timeout, attempting promotion');
        this.attemptPromotion();
      }
    }, HEARTBEAT_INTERVAL) as unknown as number;
  }

  private stopHeartbeatMonitoring(): void {
    if (this.heartbeatTimeoutId) {
      clearInterval(this.heartbeatTimeoutId);
      this.heartbeatTimeoutId = null;
    }
  }

  private broadcast(message: BroadcastMessage): void {
    this.channel?.postMessage({ ...message, tabId: this.tabId });
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.currentOptions?.logger?.[level](`[SSECoordinator] ${message}`);
  }
}
