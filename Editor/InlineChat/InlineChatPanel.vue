<script setup lang="ts">
/** Renders the inline-chat input, current-message bar, and provider request controls. */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const addIcon = 'icon icon-add';
const arrowDownIcon = 'icon icon-arrow-down';
const circleStopIcon = 'icon icon-circle-stop';
const closeIcon = 'icon icon-close';
const sendIcon = 'icon icon-send';
import { AiChatError, AiChatService, type AiChatRun } from '@/AIchat';
import { aiConnectionApi } from '@/api/aiConnection';
import WsDropdownMenu from '@/components/WsDropdownMenu/WsDropdownMenu.vue';
import WsIconButton from '@/components/WsIconButton/WsIconButton.vue';
import type { RecentWorkspaceFile } from '@/store/dockingThree';
import type { AiConnectedModel } from '@/types/aiModel';
import type { WorkspaceFileEntry } from '@/types/ipc';

import InlineChatModelSelect from './InlineChatModelSelect.vue';
import TiptapEditor from './TiptapEditor.vue';
import type { InlineChatResponseState } from './inlineChatResponseState';

interface InlineChatPanelProps {
  workspaceFiles?: readonly WorkspaceFileEntry[];
  recentFiles?: readonly RecentWorkspaceFile[];
  responseState: InlineChatResponseState;
  getSelectionContext?: () => string;
  registerRegenerate?: (handler: (() => void) | undefined) => void;
  registerCancel?: (handler: (() => void) | undefined) => void;
  onClose: () => void;
}

const props = withDefaults(defineProps<InlineChatPanelProps>(), {
  workspaceFiles: () => [],
  recentFiles: () => []
});

const chatService = new AiChatService();
const conversationId = createConversationId();

const tiptapEditor = ref<InstanceType<typeof TiptapEditor> | null>(null);
const inputText = ref('');
const selectedModel = ref<AiConnectedModel | null>(null);
const sentMessages = ref<string[]>([]);
const currentSentMessage = ref('');
const currentContextText = ref('');
const messageListOpen = ref(false);
let activeRun: AiChatRun | undefined;
let cancelRequested = false;
let suppressCancellationError = false;
let disposed = false;

const canSend = computed(() => inputText.value.trim().length > 0 && !props.responseState.isStreaming);
const sendButtonIcon = computed(() => props.responseState.isStreaming ? circleStopIcon : sendIcon);
const sendButtonLabel = computed(() => props.responseState.isStreaming ? '暂停' : '发送');
/** Sends a prompt through the selected model, optionally replacing its previous response. */
async function sendMessage(message?: string, regenerate = false): Promise<void> {
  const content = (message ?? inputText.value).trim();
  if (!content || props.responseState.isStreaming) return;

  const contextText = regenerate
    ? currentContextText.value
    : props.getSelectionContext?.().trim() ?? '';
  const requestMessage = contextText
    ? `上下文信息：\n${contextText}\n\n用户问题：\n${content}`
    : content;

  const model = selectedModel.value;
  if (!model) {
    props.responseState.error = '请先选择一个可用模型。';
    return;
  }

  props.responseState.error = '';
  props.responseState.markdown = '';
  if (!regenerate) currentContextText.value = contextText;
  currentSentMessage.value = content;
  sentMessages.value = [content, ...sentMessages.value.filter(item => item !== content)].slice(0, 20);
  tiptapEditor.value?.clearContent();
  props.responseState.isStreaming = true;
  cancelRequested = false;

  let run: AiChatRun | undefined;
  let eventConsumption: Promise<void> | undefined;
  try {
    const settings = await aiConnectionApi.getSettings(model.configurationId);
    if (disposed || cancelRequested) return;
    if (!settings.apiEndpoint || !settings.apiKey) {
      throw new AiChatError('INVALID_REQUEST', 'AI model connection settings are incomplete');
    }

    const request = {
      conversationId,
      model: {
        id: model.id,
        endpointType: model.endpointType,
        apiEndpoint: settings.apiEndpoint,
        apiKey: settings.apiKey
      },
      message: requestMessage
    };
    run = regenerate ? chatService.regenerate(request) : chatService.start(request);
    activeRun = run;
    eventConsumption = consumeRunEvents(run);
    await run.completion;
  } catch (reason: unknown) {
    if (!(suppressCancellationError && reason instanceof AiChatError && reason.code === 'CANCELLED')) {
      props.responseState.error = readChatError(reason);
    }
  } finally {
    await eventConsumption;
    if (activeRun === run) activeRun = undefined;
    props.responseState.isStreaming = false;
  }
}

/** Replays the latest prompt without adding a duplicate user message to the conversation. */
async function regenerateMessage(): Promise<void> {
  const content = currentSentMessage.value.trim();
  if (!content || props.responseState.isStreaming) return;
  await sendMessage(content, true);
}

/** Starts a fresh conversation while stopping any active provider stream. */
async function handleNewChat(): Promise<void> {
  const run = activeRun;
  suppressCancellationError = true;
  cancelActiveRun();
  if (run) await run.completion.catch(() => undefined);

  chatService.clearContext(conversationId);
  props.responseState.markdown = '';
  props.responseState.error = '';
  props.responseState.isStreaming = false;
  currentSentMessage.value = '';
  currentContextText.value = '';
  sentMessages.value = [];
  messageListOpen.value = false;
  inputText.value = '';
  tiptapEditor.value?.clearContent();
  suppressCancellationError = false;
}

/** Cancels the active provider stream during pause, widget disposal, or editor teardown. */
function cancelActiveRun(): void {
  cancelRequested = true;
  activeRun?.cancel();
}

/** Cancels the active provider stream while it is being displayed as a pause button. */
function handleSendClick(): void {
  if (!props.responseState.isStreaming) {
    void sendMessage();
    return;
  }

  cancelActiveRun();
}

/** Sends the prompt submitted from the Tiptap Enter shortcut without cancelling a stream. */
function handleInputSend(): void {
  void sendMessage();
}

/** Keeps the response block synchronized with cumulative stream deltas. */
async function consumeRunEvents(run: AiChatRun): Promise<void> {
  for await (const event of run.events) {
    if (event.type === 'delta') {
      props.responseState.markdown = event.text;
    } else if (event.type === 'error' && !suppressCancellationError) {
      props.responseState.error = readChatError(event.error);
    }
  }
}

function handleModelChange(model: AiConnectedModel | undefined): void {
  selectedModel.value = model ?? null;
}

function handleInputTextChange(value: string): void {
  inputText.value = value;
}

function removeSentMessage(message: string, event: MouseEvent): void {
  event.stopPropagation();
  sentMessages.value = sentMessages.value.filter(item => item !== message);

  if (currentSentMessage.value === message) {
    currentSentMessage.value = sentMessages.value[0] ?? '';
  }

  if (sentMessages.value.length === 0) {
    messageListOpen.value = false;
  }
}

function readChatError(reason: unknown): string {
  if (!(reason instanceof AiChatError)) return '服务商请求失败，请检查网络或模型配置。';
  switch (reason.code) {
    case 'TIMEOUT':
      return '请求超时，请稍后重试。';
    case 'CANCELLED':
      return '请求已取消。';
    case 'HTTP':
      return reason.status
        ? `服务商请求失败（HTTP ${reason.status}），请检查 API 地址、密钥和模型可用性。`
        : '服务商请求失败，请检查 API 地址、密钥和模型可用性。';
    case 'PROTOCOL':
      return reason.message === '服务商未返回回复内容，请检查模型与流式接口配置。'
        ? reason.message
        : '服务商返回的不是有效的流式 AI 回复，请检查 API 地址与接口类型。';
    case 'INVALID_REQUEST':
    case 'UNSUPPORTED_PROVIDER':
      return '服务商请求失败，请检查网络或模型配置。';
    case 'NETWORK':
      if (reason.message === 'AI provider stream failed') {
        return '服务商回复中途断开，请稍后重试。';
      }
      if (reason.message === 'AI provider disconnected before response') {
        return '服务商在返回回复前断开了连接，自动重试后仍失败，请稍后重试。';
      }
      return '连接服务商失败，请检查网络、代理或服务地址。';
    default:
      return '服务商请求失败，请检查网络或模型配置。';
  }
}

function createConversationId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `inline-chat-${uuid}` : `inline-chat-${Date.now()}`;
}

props.registerRegenerate?.(regenerateMessage);
props.registerCancel?.(cancelActiveRun);

onMounted(() => {
  tiptapEditor.value?.focus();
});

onBeforeUnmount(() => {
  props.registerRegenerate?.(undefined);
  props.registerCancel?.(undefined);
  disposed = true;
  cancelActiveRun();
  activeRun = undefined;
});
</script>

<template>
  <div class="cm-editor-inline-chat__content">
    <WsDropdownMenu
      v-if="currentSentMessage"
      v-model:open="messageListOpen"
      class="cm-editor-inline-chat__message-menu"
      :items="sentMessages"
      match-trigger-width
      panel-placement="below"
      panel-align="start"
      close-on-scroll
    >
      <template #trigger="{ toggle }">
        <header class="cm-editor-inline-chat__message-bar" @click.stop>
          <span
            class="cm-editor-inline-chat__message-value"
            :title="currentSentMessage"
          >
            {{ currentSentMessage }}
          </span>
          <WsIconButton
            class="cm-editor-inline-chat__message-history-toggle"
            :icon="arrowDownIcon"
            label="展开消息列表"
            aria-haspopup="menu"
            :aria-expanded="messageListOpen"
            :pressed="messageListOpen"
            @click="toggle"
          />
        </header>
      </template>
      <template #prepend>
        <div class="cm-editor-inline-chat__message-history-title" role="presentation">消息历史</div>
      </template>
      <template #item="{ props: itemProps, item }">
        <div
          v-bind="itemProps"
          class="cm-editor-inline-chat__message-history-item"
        >
          <span class="cm-editor-inline-chat__message-history-text">{{ item.title }}</span>
          <WsIconButton
            class="cm-editor-inline-chat__message-history-delete"
            :icon="closeIcon"
            label="删除消息"
            title="删除消息"
            @click="removeSentMessage(item.title, $event)"
          />
        </div>
      </template>
      </WsDropdownMenu>

    <div class="cm-editor-inline-chat__body">
      <div class="cm-editor-inline-chat__editor">
        <TiptapEditor
          ref="tiptapEditor"
          :workspace-files="props.workspaceFiles"
          :recent-files="props.recentFiles"
          @send="handleInputSend"
          @text-change="handleInputTextChange"
        />
      </div>
      <WsIconButton
        class="cm-editor-inline-chat__send"
        :class="{ 'cm-editor-inline-chat__send--streaming': props.responseState.isStreaming }"
        :disabled="!props.responseState.isStreaming && !canSend"
        :icon="sendButtonIcon"
        :label="sendButtonLabel"
        :title="sendButtonLabel"
        @click="handleSendClick"
      />
      <WsIconButton
        class="cm-editor-inline-chat__close"
        :icon="closeIcon"
        label="关闭"
        title="关闭"
        @click="props.onClose"
      />
    </div>

    <footer class="cm-editor-inline-chat__toolbar">
      <WsIconButton
        class="cm-editor-inline-chat__new-chat"
        :icon="addIcon"
        label="新建聊天"
        title="新建聊天"
        @click="void handleNewChat()"
      />
      <div class="cm-editor-inline-chat__model">
        <InlineChatModelSelect @model-change="handleModelChange" />
      </div>
    </footer>
  </div>
</template>
