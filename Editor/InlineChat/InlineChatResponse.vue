<script setup lang="ts">
/** Renders the streamed inline-chat response as sanitized Markdown in its own editor block. */
import { computed, ref } from 'vue';
import DOMPurify from 'dompurify';
import { Marked } from 'marked';
const acceptIcon = 'icon icon-check-gou-xuan';
const closeIcon = 'icon icon-close';
const refreshIcon = 'icon icon-web-viewer-refresh';
import WorkbenchVerticalScrollbar from '@/components/scrollbar/WorkbenchVerticalScrollbar.vue';
import WsIconButton from '@/components/WsIconButton/WsIconButton.vue';

import type { InlineChatResponseState } from './inlineChatResponseState';

interface InlineChatResponseProps {
  responseState: InlineChatResponseState;
}

const props = defineProps<InlineChatResponseProps>();
const responseScrollerElement = ref<HTMLElement | null>(null);
const emit = defineEmits<{
  regenerate: [];
  accept: [];
  reject: [];
}>();
const markdownRenderer = new Marked({
  breaks: true,
  gfm: true
});
const responseHtml = computed(() => {
  if (!props.responseState.markdown) return '';
  const rendered = markdownRenderer.parse(props.responseState.markdown, { async: false });
  return DOMPurify.sanitize(rendered, {
    FORBID_TAGS: ['button', 'embed', 'form', 'iframe', 'input', 'object', 'script', 'style']
  });
});
</script>

<template>
  <section
    v-if="props.responseState.isStreaming || responseHtml || props.responseState.error"
    class="cm-editor-inline-chat__response-group"
  >
    <div
      aria-label="返回消息操作"
      class="cm-editor-inline-chat__response-toolbar"
      role="toolbar"
    >
      <WsIconButton
        class="cm-editor-inline-chat__response-action"
        :icon="refreshIcon"
        label="重新生成"
        title="重新生成"
        :disabled="props.responseState.isStreaming"
        @click="emit('regenerate')"
      />
      <WsIconButton
        class="cm-editor-inline-chat__response-action"
        :icon="acceptIcon"
        text="接受"
        label="接受"
        :disabled="props.responseState.isStreaming"
        @click="emit('accept')"
      />
      <WsIconButton
        class="cm-editor-inline-chat__response-action"
        :icon="closeIcon"
        text="拒绝"
        label="拒绝"
        :disabled="props.responseState.isStreaming"
        @click="emit('reject')"
      />
    </div>
    <section class="cm-editor-inline-chat__response" aria-live="polite">
      <div ref="responseScrollerElement" class="cm-editor-inline-chat__response-scroll">
    <p v-if="props.responseState.isStreaming && !responseHtml" class="cm-editor-inline-chat__response-status">
      正在思考…
    </p>
    <article v-if="responseHtml" v-html="responseHtml" />
    <p v-if="props.responseState.error" class="cm-editor-inline-chat__response-error">
      {{ props.responseState.error }}
    </p>
      </div>
      <WorkbenchVerticalScrollbar :scroller-element="responseScrollerElement" />
    </section>
  </section>
</template>
