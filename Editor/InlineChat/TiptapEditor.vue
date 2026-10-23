<script setup lang="ts">
/** Hosts the inline-chat Tiptap input and its @ reference selector. */
import { nextTick, onBeforeUnmount, ref } from 'vue';
import { EditorContent, useEditor } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import AtReferenceMenu, {
  type AtReferenceItem,
  type AtReferenceMenuHandle
} from './AtReferenceMenu.vue';
import { inlineChatReferenceMark } from './inlineChatReferenceMark';
import type { WorkspaceFileEntry } from '@/types/ipc';
import type { RecentWorkspaceFile } from '@/store/dockingThree';

interface TiptapEditorProps {
  workspaceFiles?: readonly WorkspaceFileEntry[];
  recentFiles?: readonly RecentWorkspaceFile[];
}

const props = withDefaults(defineProps<TiptapEditorProps>(), {
  workspaceFiles: () => [],
  recentFiles: () => []
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
  textChange: [value: string];
  emptyChange: [empty: boolean];
  send: [];
}>();

const showAtMenu = ref(false);
const atMenu = ref<AtReferenceMenuHandle | null>(null);
const atMenuWidth = ref(0);
let tiptapResizeObserver: ResizeObserver | undefined;
let codeMirrorScroller: HTMLElement | null = null;

const editor = useEditor({
  extensions: [StarterKit, inlineChatReferenceMark],
  content: '',
  onCreate: ({ editor: current }) => {
    emit('update:modelValue', current.getHTML());
    emit('textChange', current.getText());
    emit('emptyChange', current.isEmpty);
    void nextTick(() => {
      observeTiptapWidth(current.view.dom);
      observeCodeMirrorScroll(current.view.dom);
    });
  },
  onUpdate: ({ editor: current }) => {
    emit('update:modelValue', current.getHTML());
    emit('textChange', current.getText());
    emit('emptyChange', current.isEmpty);
    showAtMenu.value = currentAtTriggerRange(current) !== null;
  },
  editorProps: {
    attributes: {
      class: 'cm-editor-inline-chat__tiptap',
      'aria-label': '内联聊天输入'
    },
    handleKeyDown: (_view, event) => {
      if (
        event.key === 'Enter'
        && !event.shiftKey
        && !event.ctrlKey
        && !event.altKey
        && !event.metaKey
      ) {
        if (showAtMenu.value) {
          atMenu.value?.selectActive();
          return true;
        }

        event.preventDefault();
        emit('send');
        return true;
      }

      if (!showAtMenu.value) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        atMenu.value?.moveActive(event.key === 'ArrowDown' ? 1 : -1);
        return true;
      }
      if (event.key === 'Enter') {
        atMenu.value?.selectActive();
        return true;
      }
      if (event.key === 'Escape') {
        showAtMenu.value = false;
        return true;
      }
      return false;
    }
  }
});

type TiptapEditorStateHost = Pick<NonNullable<typeof editor.value>, 'state'>;

/** Keeps the reference menu aligned with the rendered Tiptap contenteditable width. */
function observeTiptapWidth(element: HTMLElement): void {
  tiptapResizeObserver?.disconnect();

  const syncWidth = (): void => {
    atMenuWidth.value = Math.ceil(element.getBoundingClientRect().width);
  };

  tiptapResizeObserver = new ResizeObserver(syncWidth);
  tiptapResizeObserver.observe(element);
  syncWidth();
}

/** Closes the reference selector without moving focus while CodeMirror scrolls. */
function closeAtMenuForEditorScroll(): void {
  showAtMenu.value = false;
}

/** Observes the owning CodeMirror scroller and replaces stale listeners on remount. */
function observeCodeMirrorScroll(element: HTMLElement): void {
  const nextScroller = element.closest<HTMLElement>('.cm-scroller');
  if (codeMirrorScroller === nextScroller) return;

  codeMirrorScroller?.removeEventListener('scroll', closeAtMenuForEditorScroll);
  codeMirrorScroller = nextScroller;
  codeMirrorScroller?.addEventListener('scroll', closeAtMenuForEditorScroll, { passive: true });
}

/** 返回光标前最后一个 @ 查询范围；空格或换行会终止当前引用查询。 */
function currentAtTriggerRange(
  currentEditor: TiptapEditorStateHost | null | undefined
): { from: number; to: number } | null {
  if (!currentEditor) return null;
  const { $from } = currentEditor.state.selection;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\n', '\0');
  const atIndex = textBefore.lastIndexOf('@');
  if (atIndex < 0 || /\s/u.test(textBefore.slice(atIndex + 1))) return null;
  return {
    from: $from.start() + atIndex,
    to: $from.pos
  };
}

/** 将选中的工作区文件引用写回 Tiptap，并收起引用菜单。 */
function insertReference(item: AtReferenceItem): void {
  const currentEditor = editor.value;
  const range = currentAtTriggerRange(currentEditor);
  if (!range || !currentEditor) return;

  currentEditor
    .chain()
    .focus()
    .deleteRange(range)
    .insertContent([
      {
        type: 'text',
        text: item.title,
        marks: [{ type: inlineChatReferenceMark.name, attrs: { referencePath: item.path } }]
      },
      { type: 'text', text: ' ' }
    ])
    .run();
  showAtMenu.value = false;
}

function closeAtMenu(): void {
  showAtMenu.value = false;
  editor.value?.commands.focus();
}

/** Clears the current prompt after it has been handed to the chat service. */
function clearContent(): void {
  editor.value?.commands.clearContent();
}

/** Focuses the input after its owning inline-chat widget has been mounted. */
function focus(): void {
  editor.value?.commands.focus();
}

defineExpose({ clearContent, focus });

onBeforeUnmount(() => {
  tiptapResizeObserver?.disconnect();
  codeMirrorScroller?.removeEventListener('scroll', closeAtMenuForEditorScroll);
  codeMirrorScroller = null;
  editor.value?.destroy();
});
</script>

<template>
  <div class="ws-tiptap-editor">
    <EditorContent :editor="editor" />
    <div
      v-if="showAtMenu"
      class="ws-tiptap-editor__at-menu"
      :style="{ width: atMenuWidth > 0 ? `${atMenuWidth}px` : undefined }"
    >
      <AtReferenceMenu
        ref="atMenu"
        :files="props.workspaceFiles"
        :recent-files="props.recentFiles"
        @close="closeAtMenu"
        @select="insertReference"
      />
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as variables;

.ws-tiptap-editor {
  position: relative;
  min-width: 0;
}

.ws-tiptap-editor__at-menu {
  position: absolute;
  z-index: variables.$dropdown-menu-active-z-index;
  inset-block-start: calc(100% - 0.6rem);
  inset-inline-start: 0;
}
</style>
