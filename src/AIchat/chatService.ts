/**
 * Coordinates conversation context, provider streaming, and run lifecycle controls.
 */
import { isAiModelEndpointType } from '../types/aiModel';

import { IpcAiChatTransport } from './ipcTransport';
import {
  AiChatError,
  type AiChatEvent,
  type AiChatMessage,
  type AiChatRequest,
  type AiChatResult,
  type AiChatRun,
  type AiChatServiceOptions,
  type AiChatTransport,
  type AiChatUsage
} from './interface';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CONTEXT_MESSAGES = 100;

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  public push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
    } else {
      this.values.push(value);
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise(resolve => this.waiters.push(resolve));
      }
    };
  }
}

class RunController {
  public paused = false;
  public cancelled = false;
  public timedOut = false;
  public finished = false;
  public readonly abortController = new AbortController();
  public readonly abortPromise: Promise<void>;
  private resolveAbort!: () => void;
  private readonly pauseWaiters: Array<() => void> = [];

  public constructor() {
    this.abortPromise = new Promise(resolve => {
      this.resolveAbort = resolve;
    });
  }

  public pause(): boolean {
    if (this.finished || this.cancelled || this.timedOut || this.paused) return false;
    this.paused = true;
    return true;
  }

  public resume(): boolean {
    if (!this.paused || this.finished || this.cancelled || this.timedOut) return false;
    this.paused = false;
    while (this.pauseWaiters.length > 0) this.pauseWaiters.shift()?.();
    return true;
  }

  public waitIfPaused(): Promise<void> {
    if (!this.paused || this.finished) return Promise.resolve();
    return new Promise(resolve => this.pauseWaiters.push(resolve));
  }

  public abort(kind: 'cancel' | 'timeout'): void {
    if (this.finished || this.abortController.signal.aborted) return;
    this.cancelled = kind === 'cancel';
    this.timedOut = kind === 'timeout';
    this.abortController.abort();
    while (this.pauseWaiters.length > 0) this.pauseWaiters.shift()?.();
    this.resolveAbort();
  }
}

interface ActiveRun {
  sessionId: string;
  controller: RunController;
}

export class AiChatService {
  private readonly transport: AiChatTransport;
  private readonly defaultTimeoutMs: number;
  private readonly maxContextMessages: number;
  private readonly contexts = new Map<string, AiChatMessage[]>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private sequence = 0;

  public constructor(options: AiChatServiceOptions = {}) {
    this.transport = options.transport ?? createDefaultTransport();
    this.defaultTimeoutMs = normalizePositiveInteger(
      options.defaultTimeoutMs,
      DEFAULT_TIMEOUT_MS
    );
    this.maxContextMessages = normalizePositiveInteger(
      options.maxContextMessages,
      DEFAULT_MAX_CONTEXT_MESSAGES
    );
  }

  /** Starts a run and returns controls immediately while provider data streams in. */
  public start(request: AiChatRequest): AiChatRun {
    if (!request || typeof request.conversationId !== 'string') {
      throw new AiChatError('INVALID_REQUEST', 'Conversation id is required');
    }
    const requestedConversationId = request.conversationId.trim();
    if (!requestedConversationId) {
      throw new AiChatError('INVALID_REQUEST', 'Conversation id is required');
    }
    if (this.activeRuns.has(requestedConversationId)) {
      throw new AiChatError('BUSY', 'Another AI chat request is active in this conversation');
    }
    const prepared = this.prepareRequest(request);
    if (this.activeRuns.has(prepared.conversationId)) {
      throw new AiChatError('BUSY', 'Another AI chat request is active in this conversation');
    }

    const sessionId = this.createSessionId();
    const controller = new RunController();
    const queue = new AsyncEventQueue<AiChatEvent>();
    const activeRun: ActiveRun = { sessionId, controller };
    this.activeRuns.set(prepared.conversationId, activeRun);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let removeExternalAbortListener: (() => void) | undefined;
    if (prepared.signal) {
      const onAbort = (): void => controller.abort('cancel');
      if (prepared.signal.aborted) onAbort();
      else {
        prepared.signal.addEventListener('abort', onAbort, { once: true });
        removeExternalAbortListener = () => prepared.signal?.removeEventListener('abort', onAbort);
      }
    }
    timeoutHandle = setTimeout(() => controller.abort('timeout'), prepared.timeoutMs);

    const completion = this.execute(
      prepared,
      sessionId,
      controller,
      queue,
      () => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        removeExternalAbortListener?.();
        if (this.activeRuns.get(prepared.conversationId)?.sessionId === sessionId) {
          this.activeRuns.delete(prepared.conversationId);
        }
      }
    );

    return {
      sessionId,
      events: queue,
      completion,
      pause: () => {
        if (controller.pause()) queue.push({ type: 'paused', sessionId });
      },
      resume: () => {
        if (controller.resume()) queue.push({ type: 'resumed', sessionId });
      },
      cancel: () => controller.abort('cancel')
    };
  }

  /** Alias used by callers that model a chat interaction as a send operation. */
  public send(request: AiChatRequest): AiChatRun {
    return this.start(request);
  }

  /** Replays the latest user turn while preserving the conversation before that turn. */
  public regenerate(request: AiChatRequest): AiChatRun {
    const conversationId = typeof request?.conversationId === 'string'
      ? request.conversationId.trim()
      : '';
    const message = typeof request?.message === 'string' ? request.message : undefined;
    if (conversationId && message !== undefined) {
      const context = this.contexts.get(conversationId);
      if (context) {
        const lastMessage = context[context.length - 1];
        const userIndex = context.length - (lastMessage?.role === 'assistant' ? 2 : 1);
        const lastUserMessage = context[userIndex];
        if (lastUserMessage?.role === 'user' && lastUserMessage.content === message) {
          // A failed regeneration has already removed its turn. Preserve earlier replies on retry.
          this.contexts.set(conversationId, context.slice(0, userIndex));
        }
      }
    }
    return this.start(request);
  }

  public getContext(conversationId: string): readonly AiChatMessage[] {
    return [...(this.contexts.get(conversationId) ?? [])];
  }

  public clearContext(conversationId?: string): void {
    if (conversationId === undefined) this.contexts.clear();
    else this.contexts.delete(conversationId);
  }

  public isActive(conversationId: string): boolean {
    return this.activeRuns.has(conversationId);
  }

  private prepareRequest(request: AiChatRequest): PreparedRequest {
    if (!request || typeof request !== 'object') {
      throw new AiChatError('INVALID_REQUEST', 'AI chat request is required');
    }
    const conversationId = request.conversationId.trim();
    if (!conversationId) throw new AiChatError('INVALID_REQUEST', 'Conversation id is required');

    const model = request.model;
    if (
      !model
      || typeof model !== 'object'
      || typeof model.id !== 'string'
      || typeof model.apiEndpoint !== 'string'
      || typeof model.apiKey !== 'string'
      || !model.id.trim()
      || !model.apiEndpoint.trim()
      || !model.apiKey.trim()
    ) {
      throw new AiChatError('INVALID_REQUEST', 'AI model configuration is incomplete');
    }
    if (!isAiModelEndpointType(model.endpointType)) {
      throw new AiChatError('UNSUPPORTED_PROVIDER', 'AI model provider is not supported');
    }
    if (!isHttpEndpoint(model.apiEndpoint)) {
      throw new AiChatError('INVALID_REQUEST', 'AI provider endpoint is invalid');
    }
    if (request.signal !== undefined && !isAbortSignal(request.signal)) {
      throw new AiChatError('INVALID_REQUEST', 'Abort signal is invalid');
    }

    const additions: AiChatMessage[] = [];
    const current = this.contexts.get(conversationId) ?? [];
    if (request.systemPrompt !== undefined && typeof request.systemPrompt !== 'string') {
      throw new AiChatError('INVALID_REQUEST', 'System prompt is invalid');
    }
    if (request.systemPrompt?.trim() && !current.some(message => message.role === 'system')) {
      additions.push({ role: 'system', content: request.systemPrompt.trim() });
    }
    if (request.message !== undefined) {
      if (typeof request.message !== 'string') {
        throw new AiChatError('INVALID_REQUEST', 'Message is invalid');
      }
      if (!request.message.trim()) throw new AiChatError('INVALID_REQUEST', 'Message is required');
      additions.push({ role: 'user', content: request.message });
    }
    if (request.messages) {
      if (!Array.isArray(request.messages)) {
        throw new AiChatError('INVALID_REQUEST', 'Messages are invalid');
      }
      for (const message of request.messages) additions.push(validateMessage(message));
    }
    if (additions.length === 0) {
      throw new AiChatError('INVALID_REQUEST', 'Message or messages are required');
    }

    // Commit a turn only after a complete reply; failed/cancelled sends must not pollute retries.
    const messages = trimContext([...current, ...additions], this.maxContextMessages);

    return {
      ...request,
      conversationId,
      messages,
      timeoutMs: normalizePositiveInteger(request.timeoutMs, this.defaultTimeoutMs)
    };
  }

  private async execute(
    request: PreparedRequest,
    sessionId: string,
    controller: RunController,
    queue: AsyncEventQueue<AiChatEvent>,
    cleanup: () => void
  ): Promise<AiChatResult> {
    const assistantParts: string[] = [];
    let usage: AiChatUsage | undefined;
    let finishReason: string | undefined;
    const emit = (event: AiChatEvent): void => queue.push(event);
    emit({ type: 'started', sessionId, conversationId: request.conversationId });

    try {
      const streamPromise = this.transport.stream(
        {
          model: request.model,
          messages: request.messages,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
          signal: controller.abortController.signal
        },
        event => {
          const applyEvent = (): void => {
            if (controller.finished || controller.cancelled || controller.timedOut) return;
            if (event.type === 'delta') {
              assistantParts.push(event.text);
              emit({
                type: 'delta',
                sessionId,
                delta: event.text,
                text: assistantParts.join('')
              });
            } else if (event.type === 'usage') {
              usage = {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                totalTokens: event.totalTokens
              };
              emit({ type: 'usage', sessionId, usage });
            } else {
              finishReason = event.finishReason;
            }
          };
          if (controller.paused) return controller.waitIfPaused().then(applyEvent);
          applyEvent();
        }
      );
      await Promise.race([streamPromise, controller.abortPromise]);

      if (controller.timedOut) {
        void streamPromise.catch(() => undefined);
        throw new AiChatError('TIMEOUT', 'AI chat request timed out');
      }
      if (controller.cancelled || controller.abortController.signal.aborted) {
        const result: AiChatResult = { status: 'cancelled', conversationId: request.conversationId };
        controller.finished = true;
        emit({ type: 'cancelled', sessionId, result });
        queue.close();
        cleanup();
        void streamPromise.catch(() => undefined);
        return result;
      }

      const assistantMessage: AiChatMessage = {
        role: 'assistant',
        content: assistantParts.join('')
      };
      this.contexts.set(request.conversationId, trimContext([...request.messages, assistantMessage], this.maxContextMessages));
      const result: Extract<AiChatResult, { status: 'completed' }> = {
        status: 'completed',
        conversationId: request.conversationId,
        message: assistantMessage,
        ...(usage ? { usage } : {}),
        ...(finishReason ? { finishReason } : {})
      };
      controller.finished = true;
      emit({ type: 'completed', sessionId, result });
      queue.close();
      cleanup();
      return result;
    } catch (reason: unknown) {
      controller.finished = true;
      const error = normalizeChatError(reason, controller);
      emit({ type: 'error', sessionId, error });
      queue.close();
      cleanup();
      throw error;
    }
  }

  private createSessionId(): string {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
    this.sequence += 1;
    return `ai-chat-${Date.now()}-${this.sequence}`;
  }
}

function createDefaultTransport(): AiChatTransport {
  return new IpcAiChatTransport();
}

interface PreparedRequest extends AiChatRequest {
  conversationId: string;
  messages: readonly AiChatMessage[];
  timeoutMs: number;
}

function validateMessage(value: AiChatMessage): AiChatMessage {
  if (!value || typeof value !== 'object' || !isAiChatRole(value.role) || typeof value.content !== 'string') {
    throw new AiChatError('INVALID_REQUEST', 'AI chat message is invalid');
  }
  return { role: value.role, content: value.content, ...(value.name ? { name: value.name } : {}) };
}

function isAiChatRole(value: unknown): value is AiChatMessage['role'] {
  return value === 'system' || value === 'user' || value === 'assistant' || value === 'tool';
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function isHttpEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAbortSignal(value: AbortSignal): boolean {
  return typeof value === 'object'
    && value !== null
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function';
}

function trimContext(messages: AiChatMessage[], maxMessages: number): AiChatMessage[] {
  if (messages.length <= maxMessages) return messages;
  if (maxMessages === 1) return [messages[messages.length - 1]];
  const systemMessage = messages.find(message => message.role === 'system');
  const tail = messages.slice(-maxMessages);
  return systemMessage && tail[0] !== systemMessage
    ? [systemMessage, ...tail.slice(1)]
    : tail;
}

function normalizeChatError(reason: unknown, controller: RunController): AiChatError {
  if (controller.timedOut) return new AiChatError('TIMEOUT', 'AI chat request timed out');
  if (controller.cancelled || isAbortReason(reason)) return new AiChatError('CANCELLED', 'AI chat request cancelled');
  if (reason instanceof AiChatError) return reason;
  return new AiChatError('NETWORK', 'AI chat request failed', undefined, { cause: reason });
}

function isAbortReason(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
    || reason instanceof Error && reason.name === 'AbortError';
}
