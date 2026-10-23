/**
 * 文件说明：维护工作区 Markdown 元数据与跨文档脚注引用索引，避免在渲染进程长期保留所有正文。
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { workspaceApi } from '@/api/workspace';
import { useDockingThreeStore } from '@/store/dockingThree';
import type {
  UpdateWorkspaceMarkdownFileResult,
  WorkspaceMarkdownFile,
  WorkspaceMarkdownFileMetadata
} from '@/types/ipc';
import {
  buildEditorFootnoteReferenceIndexFromSource,
  type EditorFootnoteReference
} from '@editor/Footnote/editorFootnoteReferenceIndex';
import { closeInlineChat } from '@editor/InlineChat/inlineChatLifecycle';

export const FOOTNOTE_PROJECT_INDEX_UPDATED_EVENT = 'wstudio:footnote-project-index-updated';

/** 全项目脚注引用索引 Store。Markdown 正文仅在构建或按需读取时短暂存在。 */
export const useFootnoteReferenceStore = defineStore('footnoteReferences', () => {
  const markdownFiles = ref<WorkspaceMarkdownFileMetadata[]>([]);
  const referencesByFootnoteId = ref<Record<string, EditorFootnoteReference[]>>({});
  const loading = ref(false);
  const referencesByFilePath = new Map<string, readonly EditorFootnoteReference[]>();
  const pendingContentByPath = new Map<string, string>();
  let refreshPromise: Promise<void> | undefined;
  let refreshQueued = false;
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;

  const filesByPath = computed(() => new Map(
    markdownFiles.value.map((file) => [file.path, file])
  ));

  /** 将每个文件的独立索引聚合为供编辑器查询的脚注引用表。 */
  function rebuildReferences(): void {
    if (rebuildTimer) {
      clearTimeout(rebuildTimer);
      rebuildTimer = undefined;
    }

    const nextReferences: Record<string, EditorFootnoteReference[]> = {};
    for (const references of referencesByFilePath.values()) {
      for (const reference of references) {
        nextReferences[reference.footnoteId] = [
          ...(nextReferences[reference.footnoteId] ?? []),
          reference
        ];
      }
    }

    referencesByFootnoteId.value = nextReferences;
    window.dispatchEvent(new CustomEvent(FOOTNOTE_PROJECT_INDEX_UPDATED_EVENT));
  }

  /** 解析一个文件的正文并仅保留轻量的脚注引用结果。 */
  function indexFileContent(filePath: string, content: string): void {
    const index = buildEditorFootnoteReferenceIndexFromSource(content, {
      documentId: filePath
    });
    referencesByFilePath.set(filePath, [...index.referencesByFootnoteId.values()].flat());
  }

  /** 合并快速输入期间的重复索引请求，避免每次按键重建项目聚合索引。 */
  function queueReferencesRebuild(filePath: string, content: string): void {
    pendingContentByPath.set(filePath, content);
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = undefined;
      for (const [pendingPath, pendingContent] of pendingContentByPath) {
        indexFileContent(pendingPath, pendingContent);
      }
      pendingContentByPath.clear();
      rebuildReferences();
    }, 100);
  }

  /** 扫描文件元数据，并逐个读取正文构建索引，正文不写入 Pinia。 */
  async function refreshProjectIndex(): Promise<void> {
    if (refreshPromise) {
      refreshQueued = true;
      return refreshPromise;
    }

    refreshPromise = (async () => {
      loading.value = true;

      try {
        do {
          refreshQueued = false;
          const files = await workspaceApi.listMarkdownFiles();
          const nextReferencesByFilePath = new Map<string, readonly EditorFootnoteReference[]>();

          for (const file of files) {
            const snapshot = await workspaceApi.readMarkdownFile(file.path);
            if (!snapshot) continue;
            const index = buildEditorFootnoteReferenceIndexFromSource(snapshot.content, {
              documentId: snapshot.path
            });
            nextReferencesByFilePath.set(snapshot.path, [
              ...index.referencesByFootnoteId.values()
            ].flat());
          }

          markdownFiles.value = files;
          referencesByFilePath.clear();
          for (const [filePath, references] of nextReferencesByFilePath) {
            referencesByFilePath.set(filePath, references);
          }
          rebuildReferences();
        } while (refreshQueued);
      } finally {
        loading.value = false;
      }
    })();

    try {
      await refreshPromise;
    } finally {
      refreshPromise = undefined;
    }
  }

  /** 使用已打开编辑器的最新正文更新单个文件索引，不将正文存入 Store。 */
  function updateMarkdownFileContent(filePath: string, content: string): void {
    if (!filesByPath.value.has(filePath)) return;
    queueReferencesRebuild(filePath, content);
  }

  /** 用写入返回的快照更新元数据和引用索引。 */
  function updateIndexedFile(file: WorkspaceMarkdownFile): void {
    const metadata: WorkspaceMarkdownFileMetadata = {
      path: file.path,
      relativePath: file.relativePath,
      name: file.relativePath.replace(/\\/g, '/').split('/').pop() ?? file.relativePath,
      size: new TextEncoder().encode(file.content).byteLength,
      modifiedAt: Date.now()
    };
    const fileIndex = markdownFiles.value.findIndex((item) => item.path === file.path);
    markdownFiles.value = fileIndex < 0
      ? [...markdownFiles.value, metadata]
      : markdownFiles.value.map((item, index) => index === fileIndex ? metadata : item);
    indexFileContent(file.path, file.content);
    rebuildReferences();
  }

  /** 比较并写入一个工作区 Markdown 文件，再定点更新无正文索引。 */
  async function persistMarkdownFileContent(
    filePath: string,
    expectedContent: string,
    content: string
  ): Promise<UpdateWorkspaceMarkdownFileResult> {
    const persistedContent = useDockingThreeStore()
      .getEditorDocumentBaselineByFilePath(filePath)
      ?? expectedContent;

    if (closeInlineChat(persistedContent) !== closeInlineChat(expectedContent)) {
      const currentFile = await workspaceApi.readMarkdownFile(filePath);
      if (currentFile) return { status: 'conflict', file: currentFile };
    }

    const result = await workspaceApi.updateMarkdownFile({
      path: filePath,
      expectedContent: persistedContent,
      content: closeInlineChat(content)
    });

    if (
      result.status === 'updated'
      || result.status === 'unchanged'
      || result.status === 'conflict'
    ) {
      updateIndexedFile(result.file);
    }

    return result;
  }

  /** 获取指定脚注的全项目引用。 */
  function getReferences(footnoteId: string): readonly EditorFootnoteReference[] {
    return referencesByFootnoteId.value[footnoteId] ?? [];
  }

  /** 获取文件元数据；正文由调用方通过 workspaceApi 按需读取。 */
  function getFile(filePath: string): WorkspaceMarkdownFileMetadata | undefined {
    return filesByPath.value.get(filePath);
  }

  return {
    markdownFiles,
    referencesByFootnoteId,
    loading,
    refreshProjectIndex,
    updateMarkdownFileContent,
    persistMarkdownFileContent,
    getReferences,
    getFile
  };
});
