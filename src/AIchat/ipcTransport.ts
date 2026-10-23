/**
 * Sends provider requests through the host process so renderer CORS policies cannot block streaming.
 */
import { aiChatApi } from '../api/aiChat';
import {
  AiChatError,
  type AiChatProviderEvent,
  type AiChatProviderRequest,
  type AiChatTransport
} from './interface';

export class IpcAiChatTransport implements AiChatTransport {
  public async stream(
    request: AiChatProviderRequest,
    onEvent: (event: AiChatProviderEvent) => void | Promise<void>
  ): Promise<void> {
    const sessionId = createSessionId();
    let settled = false;
    let listenerReady: Promise<void> | undefined;
    let removeListener = (): void => undefined;
    let removeAbortListener = (): void => undefined;
    let eventChain = Promise.resolve();

    const completion = new Promise<void>((resolve, reject) => {
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        removeListener();
        removeAbortListener();
        operation();
      };

      const schedule = (event: AiChatProviderEvent): Promise<void> => {
        eventChain = eventChain.then(() => onEvent(event));
        return eventChain;
      };

      const subscription = aiChatApi.onEvent((event) => {
        if (event.sessionId !== sessionId || settled) return;
        if (event.type === 'delta') {
          void schedule({ type: 'delta', text: event.text }).catch(reason => {
            if (!settled) finish(() => reject(reason));
          });
          return;
        }
        if (event.type === 'usage') {
          void schedule({
            type: 'usage',
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            totalTokens: event.totalTokens
          }).catch(reason => {
            if (!settled) finish(() => reject(reason));
          });
          return;
        }
        if (event.type === 'completed') {
          finish(() => {
            void schedule({ type: 'completed', finishReason: event.finishReason })
              .then(resolve, reject);
          });
          return;
        }
        if (event.type === 'cancelled') {
          finish(resolve);
          return;
        }

        finish(() => reject(new AiChatError(
          event.error.code,
          event.error.message,
          event.error.status
        )));
      });
      removeListener = subscription;
      listenerReady = subscription.ready;

      const abort = (): void => {
        void aiChatApi.cancel(sessionId).catch(() => undefined);
      };
      removeAbortListener = () => request.signal.removeEventListener('abort', abort);
      if (request.signal.aborted) abort();
      else request.signal.addEventListener('abort', abort, { once: true });
    });

    try {
      await listenerReady;
      if (request.signal.aborted) return;
      await aiChatApi.start({
        sessionId,
        request: {
          model: request.model,
          messages: [...request.messages],
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {})
        }
      });
      await completion;
    } catch (reason: unknown) {
      if (reason instanceof AiChatError) throw reason;
      throw new AiChatError('NETWORK', 'AI provider request failed', undefined, { cause: reason });
    } finally {
      removeListener();
      removeAbortListener();
    }
  }
}

function createSessionId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `ai-chat-ipc-${uuid}` : `ai-chat-ipc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
