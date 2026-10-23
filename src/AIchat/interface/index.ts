/**
 * Internal contracts shared by the host-owned AI chat service and providers.
 */
import type { AiModelEndpointType } from '../../types/aiModel';

export const AI_CHAT_ROLES = ['system', 'user', 'assistant', 'tool'] as const;
export type AiChatRole = typeof AI_CHAT_ROLES[number];

export interface AiChatMessage {
  role: AiChatRole;
  content: string;
  name?: string;
}

export interface AiChatModel {
  id: string;
  endpointType: AiModelEndpointType;
  apiEndpoint: string;
  apiKey: string;
}

export interface AiChatRequest {
  conversationId: string;
  model: AiChatModel;
  message?: string;
  messages?: readonly AiChatMessage[];
  systemPrompt?: string;
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface AiChatProviderRequest {
  model: AiChatModel;
  messages: readonly AiChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal: AbortSignal;
}

/** Serializable provider request passed to the host process over the private bridge. */
export type AiChatBridgeRequest = Omit<AiChatProviderRequest, 'signal'>;

/** Starts one host-owned provider stream with a caller-generated session id. */
export interface AiChatBridgeStartRequest {
  sessionId: string;
  request: AiChatBridgeRequest;
}

export type AiChatProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; totalTokens?: number }
  | { type: 'completed'; finishReason?: string };

/** Serializable events emitted by the host process while a provider stream runs. */
export type AiChatBridgeEvent =
  | { type: 'delta'; sessionId: string; text: string }
  | { type: 'usage'; sessionId: string; inputTokens?: number; outputTokens?: number; totalTokens?: number }
  | { type: 'completed'; sessionId: string; finishReason?: string }
  | { type: 'cancelled'; sessionId: string }
  | {
    type: 'error';
    sessionId: string;
    error: { code: AiChatErrorCode; message: string; status?: number };
  };

export interface AiChatTransport {
  stream(
    request: AiChatProviderRequest,
    onEvent: (event: AiChatProviderEvent) => void | Promise<void>
  ): Promise<void>;
}

export type AiChatErrorCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_PROVIDER'
  | 'BUSY'
  | 'NETWORK'
  | 'HTTP'
  | 'PROTOCOL'
  | 'TIMEOUT'
  | 'CANCELLED';

export class AiChatError extends Error {
  public readonly code: AiChatErrorCode;
  public readonly status: number | undefined;

  public constructor(
    code: AiChatErrorCode,
    message: string,
    status?: number,
    options?: { cause?: unknown }
  ) {
    super(message);
    if (options && 'cause' in options) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        enumerable: false,
        value: options.cause,
        writable: false
      });
    }
    this.code = code;
    this.status = status;
    this.name = 'AiChatError';
  }
}

export function isAiChatError(value: unknown): value is AiChatError {
  return value instanceof AiChatError;
}

export interface AiChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type AiChatResult =
  | {
    status: 'completed';
    conversationId: string;
    message: AiChatMessage;
    usage?: AiChatUsage;
    finishReason?: string;
  }
  | {
    status: 'cancelled';
    conversationId: string;
  };

export type AiChatEvent =
  | { type: 'started'; sessionId: string; conversationId: string }
  | { type: 'delta'; sessionId: string; delta: string; text: string }
  | { type: 'usage'; sessionId: string; usage: AiChatUsage }
  | { type: 'paused'; sessionId: string }
  | { type: 'resumed'; sessionId: string }
  | { type: 'completed'; sessionId: string; result: Extract<AiChatResult, { status: 'completed' }> }
  | { type: 'cancelled'; sessionId: string; result: Extract<AiChatResult, { status: 'cancelled' }> }
  | { type: 'error'; sessionId: string; error: AiChatError };

export interface AiChatRun {
  readonly sessionId: string;
  readonly events: AsyncIterable<AiChatEvent>;
  readonly completion: Promise<AiChatResult>;
  pause(): void;
  resume(): void;
  cancel(): void;
}

export interface AiChatServiceOptions {
  transport?: AiChatTransport;
  defaultTimeoutMs?: number;
  maxContextMessages?: number;
}
