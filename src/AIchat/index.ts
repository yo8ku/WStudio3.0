/**
 * Host-internal AI chat entry point; UI components should depend on this module only.
 */
export { AiChatService } from './chatService';
export { IpcAiChatTransport } from './ipcTransport';
export {
  AiChatError,
  isAiChatError,
  AI_CHAT_ROLES
} from './interface';
export type {
  AiChatErrorCode,
  AiChatBridgeEvent,
  AiChatBridgeRequest,
  AiChatBridgeStartRequest,
  AiChatEvent,
  AiChatMessage,
  AiChatModel,
  AiChatProviderEvent,
  AiChatProviderRequest,
  AiChatRequest,
  AiChatResult,
  AiChatRun,
  AiChatServiceOptions,
  AiChatTransport,
  AiChatUsage
} from './interface';
