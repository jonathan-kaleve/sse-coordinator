export interface SSEEvent {
  type: string;
  data: unknown;
  id: string;
  timestamp: string;
}

export interface Logger {
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

export interface SSECoordinatorOptions {
  url: string;
  eventTypes: string[];
  channelName?: string;
  withCredentials?: boolean;
  maxReconnectAttempts?: number;
  logger?: Logger;
  onEvent: (event: SSEEvent) => void;
  onError?: (error: Error) => void;
  onConnectionChange?: (connected: boolean) => void;
}
