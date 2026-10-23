<script setup lang="ts">
/** 文件说明：将 blank 窗口的基础外壳与受信页面内容组合，避免注入完整工作台布局。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { pluginApi } from '@/api/plugin';
import { systemApi } from '@/api/system';
import { windowApi } from '@/api/window';
import { workspaceApi } from '@/api/workspace';
import RepositoryManagerDialog from '@/components/workbench/RepositoryManagerDialog.vue';
import SearchWindowView from '@/views/SearchWindowView.vue';
import SettingsDialog from '@/components/workbench/SettingsDialog.vue';
import LoginDialog from '@/components/LoginDialog/LoginDialog.vue';
import WindowShell from '@/components/workbench/WindowShell.vue';
import { useAccountStore } from '@/store/account';
import { usePluginStore } from '@/store/plugin';
import type {
  PluginDialogPickItem,
  PluginDialogRepositoryAction,
  PluginDialogRequest
} from '../../plugin/sdk';
import {
  getInitialSettingsNavigationId,
  getInitialWindowTitle,
  getWindowMode,
  getWindowPage
} from '@/utils/windowMode';

const pluginStore = usePluginStore();
const accountStore = useAccountStore();
const page = getWindowPage();
const isRepositoryManagerHost = getWindowMode() === 'blank' && page === 'repository-manager';
const title = getInitialWindowTitle() ?? (page === 'settings' ? '设置' : 'WStudio');
const initialSettingsNavigationId = getInitialSettingsNavigationId();
const isLoginDialogOpen = ref(false);
const repositoryManagerRequest = ref<Extract<PluginDialogRequest, { kind: 'repository-manager' }>>();
const repositoryManagerError = ref<string>();
const repositoryManagerHostItems = ref<PluginDialogPickItem[]>([]);
const repositoryManagerHostCurrentItemId = ref<string>();
const repositoryManagerHostVersion = ref('browser-only');
const repositoryManagerHostReady = ref(false);
let unsubscribeRepositoryManagerRequest: (() => void) | undefined;
const repositoryManagerHostActions: readonly PluginDialogRepositoryAction[] = [
  {
    id: 'create-repository',
    label: '新建仓库',
    description: '在指定文件夹下创建一个新的仓库'
  },
  {
    id: 'open-local-repository',
    label: '打开仓库',
    description: '将一个本地文件夹作为仓库在 wstudio 中打开'
  }
];
const repositoryManagerItems = computed(() => (
  repositoryManagerRequest.value?.options.items.map(normalizeRepositoryItem)
    ?? repositoryManagerHostItems.value
));
const repositoryManagerTitle = computed(() => (
  repositoryManagerRequest.value?.options.title ?? '管理仓库'
));
const repositoryManagerCurrentItemId = computed(() => (
  repositoryManagerRequest.value?.options.currentItemId ?? repositoryManagerHostCurrentItemId.value
));
const repositoryManagerVersion = computed(() => (
  repositoryManagerRequest.value?.options.version ?? repositoryManagerHostVersion.value
));
const repositoryManagerActions = computed(() => (
  repositoryManagerRequest.value?.options.actions ?? repositoryManagerHostActions
));

/** 设置页需要插件贡献数据，但不应在 blank 窗口中启动 DockingThree 视图运行时。 */
async function initializeSettingsPage(): Promise<void> {
  if (page !== 'settings') return;
  pluginStore.initialize({ activateRuntime: false });
  await pluginStore.refresh();
  await pluginStore.refreshContributions({ activateRuntime: false });
}

/** 订阅主进程定向给当前子窗口的仓库管理请求。 */
async function takeRepositoryManagerRequest(): Promise<void> {
  for (let attempt = 0; attempt < 20 && !repositoryManagerRequest.value; attempt += 1) {
    try {
      const request = await windowApi.takeRepositoryManagerRequest();
      if (request?.kind === 'repository-manager') {
        repositoryManagerRequest.value = request;
        return;
      }
    } catch {
      return;
    }
    await new Promise<void>(resolve => window.setTimeout(resolve, 50));
  }
}

function startRepositoryManagerPage(): void {
  if (!isRepositoryManagerHost) return;
  unsubscribeRepositoryManagerRequest = pluginApi.onDialogRequested(request => {
    if (request.kind !== 'repository-manager') return;
    repositoryManagerRequest.value = request;
  });
  const unsubscribeTauriRequest = windowApi.onRepositoryManagerRequest(request => {
    repositoryManagerRequest.value = request;
  });
  const previousUnsubscribe = unsubscribeRepositoryManagerRequest;
  unsubscribeRepositoryManagerRequest = () => {
    previousUnsubscribe();
    unsubscribeTauriRequest();
  };
  void loadHostRepositoryManager();
  void takeRepositoryManagerRequest();
}

/** 加载宿主仓库管理页所需的当前仓库、最近仓库和版本信息。*/
async function loadHostRepositoryManager(): Promise<void> {
  try {
    const [currentRepository, recentRepositories, version] = await Promise.all([
      workspaceApi.getRepository(),
      workspaceApi.listRecentRepositories(),
      systemApi.getVersion()
    ]);
    const seenNames = new Set<string>();
    repositoryManagerHostItems.value = recentRepositories.reduce<PluginDialogPickItem[]>(
      (items, repository) => {
        const key = repository.name.trim().toLocaleLowerCase();
        if (seenNames.has(key)) return items;
        seenNames.add(key);
        items.push({
          id: repository.id,
          label: repository.name,
          ...(repository.displayPath ? { description: repository.displayPath } : {})
        });
        return items;
      },
      []
    );
    repositoryManagerHostCurrentItemId.value = currentRepository?.id;
    repositoryManagerHostVersion.value = version;
  } catch {
    repositoryManagerError.value = '仓库列表加载失败，请重试。';
  } finally {
    repositoryManagerHostReady.value = true;
  }
}

/** 在宿主边界整理仓库名称，兼容插件将绝对路径放在 label 中的旧数据。 */
function normalizeRepositoryItem(item: PluginDialogPickItem): PluginDialogPickItem {
  const label = item.label.trim();
  const isPath = label.includes('\\') || label.includes('/') || /^[A-Za-z]:/u.test(label);
  const pathValue = item.description?.trim() || (isPath ? label : '');
  const segments = pathValue.split(/[\\/]/u).filter(Boolean);
  return {
    ...item,
    label: isPath ? (segments[segments.length - 1] || label) : (label || '未命名仓库'),
    ...(pathValue ? { description: pathValue } : {})
  };
}

/** 把仓库选择或管理动作交还插件，并关闭已完成请求的子窗口。 */
async function respondRepositoryManager(value: string): Promise<void> {
  const request = repositoryManagerRequest.value;
  if (!request) return;
  repositoryManagerError.value = undefined;
  try {
    const accepted = await pluginApi.respondDialog({
      requestId: request.requestId,
      status: 'confirmed',
      value
    });
    if (accepted) await windowApi.close();
  } catch {
    repositoryManagerError.value = '仓库管理请求响应失败，请重试。';
  }
}

/** 处理宿主仓库管理页的选择和操作，并在需要时刷新列表或关闭子窗口。*/
async function handleHostRepositoryManager(value: string): Promise<void> {
  repositoryManagerError.value = undefined;
  try {
    if (value === 'create-repository') {
      if (await workspaceApi.createRepository()) await windowApi.close();
      return;
    }
    if (value === 'open-local-repository') {
      if (await workspaceApi.openRepository()) await windowApi.close();
      return;
    }
    if (value.startsWith('repository-action:')) {
      const [, repositoryId, actionId, encodedName] = value.split(':');
      if (!repositoryId || !actionId) return;
      if (actionId === 'rename') {
        if (!encodedName) return;
        const name = decodeURIComponent(encodedName).trim();
        if (!name) return;
        await workspaceApi.renameRecentRepository(repositoryId, name);
      } else if (actionId === 'move') {
        const moved = await workspaceApi.moveRecentRepository(repositoryId);
        if (moved) await loadHostRepositoryManager();
        return;
      } else if (actionId === 'reveal') {
        await workspaceApi.revealRecentRepository(repositoryId);
      } else if (actionId === 'remove') {
        await workspaceApi.removeRecentRepository(repositoryId);
      } else {
        return;
      }
      await loadHostRepositoryManager();
      return;
    }
    if (await workspaceApi.openRecentRepository(value)) await windowApi.close();
  } catch {
    repositoryManagerError.value = '仓库操作失败，请重试。';
  }
}

/** 统一分派插件对话请求和宿主仓库管理页事件。*/
async function handleRepositoryManagerValue(value: string): Promise<void> {
  if (repositoryManagerRequest.value) {
    await respondRepositoryManager(value);
    return;
  }
  await handleHostRepositoryManager(value);
}

/** 使用 Escape 关闭仓库管理子窗口，并向插件返回取消结果。 */
async function cancelRepositoryManager(): Promise<void> {
  const request = repositoryManagerRequest.value;
  if (!request) {
    await windowApi.close();
    return;
  }
  try {
    await pluginApi.respondDialog({ requestId: request.requestId, status: 'cancelled' });
  } finally {
    await windowApi.close();
  }
}

function handleRepositoryManagerKeydown(event: KeyboardEvent): void {
  if (isRepositoryManagerHost && event.key === 'Escape') {
    event.preventDefault();
    void cancelRepositoryManager();
  }
}

watch(() => accountStore.loginRequestId, (requestId, previousRequestId) => {
  if (page === 'settings' && requestId !== previousRequestId) {
    isLoginDialogOpen.value = true;
  }
});

// Register before mount so a fast blank window cannot miss its initial request.
startRepositoryManagerPage();

onMounted(() => {
  void initializeSettingsPage();
  if (page === 'settings') void accountStore.restore();
  window.addEventListener('keydown', handleRepositoryManagerKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleRepositoryManagerKeydown);
  unsubscribeRepositoryManagerRequest?.();
  if (page === 'settings') pluginStore.dispose();
});
</script>

<template>
  <v-app class="window-host-app">
    <SearchWindowView v-if="page === 'search'" />
    <WindowShell
      v-else
      :title="title"
      :title-class="page === 'settings' ? 'setting-title' : undefined"
      :show-window-controls="page === 'settings'"
      :disable-maximize="page === 'settings'"
    >
      <SettingsDialog
        v-if="page === 'settings'"
        embedded
        :initial-navigation-id="initialSettingsNavigationId"
      />
      <LoginDialog
        v-if="page === 'settings'"
        v-model="isLoginDialogOpen"
        :restore-existing="false"
      />
      <RepositoryManagerDialog
        v-if="isRepositoryManagerHost && (repositoryManagerRequest || repositoryManagerHostReady)"
        :title="repositoryManagerTitle"
        :items="repositoryManagerItems"
        :current-item-id="repositoryManagerCurrentItemId"
        :version="repositoryManagerVersion"
        :actions="repositoryManagerActions"
        :error="repositoryManagerError"
        @select="handleRepositoryManagerValue"
        @action="handleRepositoryManagerValue"
      />
    </WindowShell>
  </v-app>
</template>

<style lang="scss" scoped>
.window-host-app {
  width: 100%;
  height: 100%;
  background: transparent;
  overflow: hidden;
}
</style>
