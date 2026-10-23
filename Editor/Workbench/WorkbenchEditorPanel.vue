<script setup lang="ts">
/**
 * 文件说明：承载工作台编辑器面板，并将停靠标签页的数据桥接到 CodeMirror 编辑器。 */
import { computed } from 'vue';
import { storeToRefs } from 'pinia';

import CodeMirrorEditor from '@editor/Workbench/CodeMirrorEditor.vue';
import type { MarkdownInlineLinkNavigationTarget } from '@editor/Markdown/markdownInlineLinkPreview';
import { parseNoteDocument } from '@editor/NoteProperties/noteProperties';
import { useDockingThreeStore } from '@/store/dockingThree';
import { useFootnoteReferenceStore } from '@/store/footnoteReferences';
import { usePluginStore } from '@/store/plugin';
import { useWorkspaceStore } from '@/store/workspace';
import type { UpdateWorkspaceMarkdownFileResult } from '@/types/ipc';
import { workspaceApi } from '@/api/workspace';
import { useNotification } from '@/components/notification/useNotification';

interface WorkbenchEditorPanelParams {
  initialValue?: string;
  label?: string;
  tabId?: string;
  title?: string;
  filePath?: string;
}

interface WorkbenchEditorPanelProps {
  params: {
    params?: WorkbenchEditorPanelParams;
  };
}

const props = defineProps<WorkbenchEditorPanelProps>();
const dockingThreeStore = useDockingThreeStore();
const footnoteReferenceStore = useFootnoteReferenceStore();
const pluginStore = usePluginStore();
const workspaceStore = useWorkspaceStore();
const notification = useNotification();
const {
  editorDocuments,
  notePropertiesVisibility,
  pendingEditorNavigation,
  pendingNotePropertiesMenu,
  recentWorkspaceFiles
} = storeToRefs(dockingThreeStore);
const { dateNoteCreationPending, workspaceFiles } = storeToRefs(workspaceStore);
const { markdownFiles } = storeToRefs(footnoteReferenceStore);
const tabId = computed(() => props.params.params?.tabId ?? '');
const pathNavigationVisible = computed(() => (
  dockingThreeStore.isPathNavigationVisible(tabId.value)
));
const documentValue = computed(() => editorDocuments.value[tabId.value] ?? '');
const noteDocumentSnapshot = computed(() => parseNoteDocument(documentValue.value));
const notePropertiesVisible = computed(() => (
  notePropertiesVisibility.value[tabId.value] === true
  || noteDocumentSnapshot.value.presentPropertyKeys.size > 0
));
const notePropertiesMenuRequestId = computed(() => (
  pendingNotePropertiesMenu.value?.tabId === tabId.value
    ? pendingNotePropertiesMenu.value.id
    : 0
));
const navigationRequest = computed(() => (
  pendingEditorNavigation.value?.tabId === tabId.value
    ? pendingEditorNavigation.value
    : undefined
));

dockingThreeStore.ensureEditorDocument(tabId.value, props.params.params?.initialValue);

/** 将完整 Markdown 文档同步到 Docking Store 与脚注索引。 */
function syncDocumentValue(value: string): void {
  if (tabId.value) {
    dockingThreeStore.setEditorDocumentValue(tabId.value, value);
  }

  const filePath = props.params.params?.filePath;
  if (filePath) {
    footnoteReferenceStore.updateMarkdownFileContent(filePath, value);
  }
}

/** 将 CodeMirror 完整文档变化同步到工作台状态。 */
function handleEditorValueUpdate(value: string): void {
  syncDocumentValue(value);
}

/** 将 CodeMirror 当前选区同步到 Docking Store 的公开编辑器快照。 */
function handleEditorSelectionChange(start: number, end: number): void {
  dockingThreeStore.setEditorSelection(tabId.value, start, end);
}

/** 根据日期在当前文件目录创建 Markdown 笔记并打开对应标签页。 */
async function handleDateNoteCreation(date: string): Promise<void> {
  const filePath = props.params.params?.filePath;
  if (!filePath) return;

  await workspaceStore.createDateNote(filePath, date);
}

/** 将块引用生成的跨文档内容通过 Store 写回磁盘并同步已打开标签。 */
async function persistWikiLinkTarget(
  filePath: string,
  expectedContent: string,
  content: string
): Promise<UpdateWorkspaceMarkdownFileResult> {
  const result = await footnoteReferenceStore.persistMarkdownFileContent(
    filePath,
    expectedContent,
    content
  );

  if (result.status === 'updated' || result.status === 'unchanged') {
    dockingThreeStore.updateEditorDocumentByFilePath(filePath, expectedContent, content);
  }

  return result;
}

/** 通过 Docking Store 打开链接目标文件并定位到标题。 */
function handleMarkdownLinkNavigation(target: MarkdownInlineLinkNavigationTarget): void {
  dockingThreeStore.openTextFileAtPosition(target);
}

/** 将文件嵌入块的打开操作交给工作区公开 action，并反馈读取失败。 */
async function handleOpenFileInNewTab(filePath: string): Promise<void> {
  try {
    if (!await workspaceStore.openInNewTab(filePath)) {
      notification.error('文件打开失败，请检查文件是否仍存在');
    }
  } catch {
    notification.error('文件打开失败，请检查文件是否仍存在');
  }
}

/** 将 Markdown 外部链接交给具备公开 WebViewer 能力的插件视图。 */
async function handleExternalLink(url: string): Promise<void> {
  await pluginStore.openExternalLink(url);
}

/** 根据编辑器行号菜单切换路径导航栏显示状态。 */
function handlePathNavigationVisibility(visible: boolean): void {
  dockingThreeStore.setPathNavigationVisibility(tabId.value, visible);
}

/** 更新当前标签的笔记属性块显隐状态。 */
function handleNotePropertiesVisibility(visible: boolean): void {
  dockingThreeStore.setNotePropertiesVisibility(tabId.value, visible);
}
</script>

<template>
  <v-sheet
    class="workbench-editor-panel rounded-0"
  >
    <!-- S = Markdown 编辑器 -->
    <CodeMirrorEditor
      autofocus
      class="workbench-editor-panel__editor"
      :date-note-creation-pending="dateNoteCreationPending"
      :file-path="props.params.params?.filePath"
      :model-value="documentValue"
      :navigation-request="navigationRequest"
      :note-properties-menu-request-id="notePropertiesMenuRequestId"
      :note-properties-visible="notePropertiesVisible"
      :path-navigation-visible="pathNavigationVisible"
      :recent-workspace-files="recentWorkspaceFiles"
      :workspace-files="workspaceFiles"
      :workspace-markdown-files="markdownFiles"
      :read-workspace-file="workspaceApi.readMarkdownFile"
      :persist-wiki-link-target="persistWikiLinkTarget"
      @create-date-note="handleDateNoteCreation"
      @open-external-link="handleExternalLink"
      @open-file-in-new-tab="handleOpenFileInNewTab"
      @navigate-markdown-link="handleMarkdownLinkNavigation"
      @selection-change="handleEditorSelectionChange"
      @toggle-note-properties="handleNotePropertiesVisibility"
      @toggle-path-navigation="handlePathNavigationVisibility"
      @update:model-value="handleEditorValueUpdate"
    />
    <!-- E = Markdown 编辑器 -->
  </v-sheet>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.workbench-editor-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--ws-editor-background);
}

.workbench-editor-panel__editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
}
</style>
