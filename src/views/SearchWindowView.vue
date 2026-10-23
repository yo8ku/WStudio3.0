<script setup lang="ts">
/** 文件说明：在无边框子窗口中承载全局搜索组件，并将结果交回父工作台。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';

import { windowApi } from '@/api/window';
import { workspaceApi } from '@/api/workspace';
import WsSearch from '@/components/WsSearch/WsSearch.vue';
import WorkbenchTitleBar from '@/components/workbench/WorkbenchTitleBar.vue';
import { isMacOS } from '@/utils/platform';
import type { WsSearchResult } from '@/components/WsSearch/WsSearch.vue';
import { useWorkspaceStore } from '@/store/workspace';

const workspaceStore = useWorkspaceStore();
const { repository, workspaceFiles } = storeToRefs(workspaceStore);
const tagResults = ref<readonly WsSearchResult[]>([]);
let tagIndexRequestId = 0;

const TAG_PATTERN = /(^|[^\p{L}\p{N}_\-/])(#[\p{L}\p{N}_-]+)/gu;
const MARKDOWN_FILE_PATTERN = /\.(?:md|markdown)$/iu;

/** 从普通 Markdown 文本中提取标签，跳过围栏代码块和行内代码片段。 */
function extractMarkdownTags(source: string): readonly string[] {
  const tags = new Set<string>();
  let codeFence: '`' | '~' | undefined;

  for (const line of source.split(/\r?\n/u)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch) {
      const fenceCharacter = fenceMatch[1]?.[0] as '`' | '~' | undefined;
      if (!codeFence) {
        codeFence = fenceCharacter;
      } else if (codeFence === fenceCharacter) {
        codeFence = undefined;
      }
      continue;
    }
    if (codeFence) continue;

    const plainText = line.replace(/`[^`]*`|!?\[[^\]]*\]\([^)]*\)/gu, '');
    for (const match of plainText.matchAll(TAG_PATTERN)) {
      const tag = match[2];
      if (tag) tags.add(tag);
    }
  }

  return [...tags];
}

const fileResults = computed<readonly WsSearchResult[]>(() => workspaceFiles.value
  .filter((file) => {
    const segments = file.relativePath.split(/[\\/]+/u);
    return !segments.includes('.idea') && !segments.includes('.obsidian');
  })
  .map((file) => {
    const relativePath = (file.relativePath || file.name).replace(/[\\/]+/gu, '/');
    const pathSegments = relativePath.split(/[\\/]+/u).filter(Boolean);
    const repositoryRoot = repository.value?.name?.trim();
    const displayPath = repositoryRoot
      ? `${repositoryRoot}/${relativePath}`
      : relativePath;

    return {
      id: relativePath,
      title: file.name,
      path: displayPath,
      resultPath: pathSegments.length > 1 ? relativePath : undefined,
      type: 'file' as const
    };
  }));
const searchResults = computed<readonly WsSearchResult[]>(() => [
  ...fileResults.value,
  ...tagResults.value
]);

/** 为当前仓库的 Markdown 文件按需建立标签搜索索引。 */
async function refreshTagResults(): Promise<void> {
  const requestId = ++tagIndexRequestId;
  const repositoryRoot = repository.value?.name?.trim();
  const markdownFiles = workspaceFiles.value.filter(file => MARKDOWN_FILE_PATTERN.test(file.name));
  const markdownSnapshots = await Promise.all(markdownFiles.map(file => workspaceApi.readMarkdownFile(file.path)));
  if (requestId !== tagIndexRequestId) return;

  tagResults.value = markdownSnapshots.flatMap((file) => {
    if (!file) return [];
    const relativePath = file.relativePath.replace(/[\\/]+/gu, '/');
    const displayPath = repositoryRoot ? `${repositoryRoot}/${relativePath}` : relativePath;
    return extractMarkdownTags(file.content).map((tag) => ({
      id: `tag:${relativePath}:${tag}`,
      openPath: relativePath,
      title: tag,
      path: displayPath,
      resultPath: relativePath,
      type: 'tag' as const
    }));
  });
}

async function handleSearchSelect(item: WsSearchResult): Promise<void> {
  if (await windowApi.openSearchResult(item.openPath ?? String(item.id))) {
    await windowApi.close();
  }
}

function closeSearch(): void {
  void windowApi.close();
}

onMounted(() => {
  void workspaceStore.initialize().then(refreshTagResults);
});

watch([repository, workspaceFiles], () => {
  void refreshTagResults();
}, { deep: true });

onBeforeUnmount(() => {
  tagIndexRequestId += 1;
  workspaceStore.dispose();
});
</script>

<template>
  <main class="search-window">
    <WorkbenchTitleBar v-if="isMacOS" minimal title="搜索" />
    <div class="search-window__content">
      <WsSearch
        :items="searchResults"
        window-drag
        @select="handleSearchSelect"
        @close="closeSearch"
        @open-in-find-tool="closeSearch"
        @open-split="closeSearch"
      />
    </div>
  </main>
</template>

<style lang="scss" scoped>
.search-window {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--ws-background);
}

.search-window__content {
  position: relative;
  flex: 1;
  min-height: 0;
}

.search-window__content :deep(.ws-search-overlay) {
  position: absolute;
}
</style>
