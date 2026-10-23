<script setup lang="ts">
/**
 * 文件说明：展示已安装插件、运行状态和权限授权操作，并将所有业务变更委托给插件 Store。
 */
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';

const deleteIcon = 'icon icon-delete';
const refreshIcon = 'icon icon-refresh';
import WsSwitch from '@/components/WsSwitch/WsSwitch.vue';
import WsTooltip from '@/components/WsTooltip/WsTooltip.vue';
import SettingsOptionItem from '@/components/workbench/SettingsOptionItem.vue';
import SettingsOptionList from '@/components/workbench/SettingsOptionList.vue';
import { pluginApi } from '@/api/plugin';
import { usePluginStore } from '@/store/plugin';
import type {
  PluginPermissionId,
  PluginPermissionRequest,
  PluginRuntimeState,
  PluginSummary
} from '../../../plugin/sdk';

const pluginStore = usePluginStore();
const { plugins, loading, error: pluginError } = storeToRefs(pluginStore);
const selectedFile = ref<File | null>(null);
const updateFiles = ref<Record<string, File | null>>({});
const localError = ref<string | undefined>();
const permissionDrafts = ref<Record<string, PluginPermissionId[]>>({});
const expandedPluginIds = ref<string[]>([]);
const pluginToRemove = ref<PluginSummary | undefined>();
const pluginToRollback = ref<PluginSummary | undefined>();
const isUninstallDialogVisible = computed({
  get: () => pluginToRemove.value !== undefined,
  set: (visible: boolean) => {
    if (!visible) {
      pluginToRemove.value = undefined;
    }
  }
});
const isRollbackDialogVisible = computed({
  get: () => pluginToRollback.value !== undefined,
  set: (visible: boolean) => {
    if (!visible) {
      pluginToRollback.value = undefined;
    }
  }
});
const pluginFileInputProps = {
  accept: '.wstudio-plugin',
  clearable: true,
  density: 'compact',
  hideDetails: 'auto',
  prependIcon: '',
  variant: 'outlined'
} as const;
const updateFileInputProps = {
  accept: '.wstudio-plugin',
  clearable: true,
  density: 'compact',
  hideDetails: 'auto',
  prependIcon: '',
  variant: 'outlined'
} as const;
const progressProps = {
  indeterminate: true
} as const;
const stateChipProps = {
  class: 'rounded-0',
  density: 'compact',
  size: 'small',
  variant: 'tonal'
} as const;
const privilegedChipProps = {
  class: 'rounded-0',
  color: 'warning',
  density: 'compact',
  size: 'small',
  variant: 'tonal'
} as const;
const refreshButtonProps = {
  class: 'rounded-0',
  density: 'compact',
  icon: true,
  variant: 'text'
} as const;
const manageButtonProps = {
  class: 'rounded-0',
  density: 'compact',
  size: 'small',
  variant: 'tonal'
} as const;
const uninstallButtonProps = {
  class: 'plugin-manager__uninstall-button rounded-0',
  density: 'compact',
  size: 'small',
  variant: 'text'
} as const;
const uninstallDialogProps = {
  maxWidth: '30rem'
} as const;
const uninstallCancelButtonProps = {
  class: 'rounded-0',
  density: 'compact',
  variant: 'text'
} as const;
const uninstallConfirmButtonProps = {
  class: 'rounded-0',
  color: 'error',
  density: 'compact',
  variant: 'flat'
} as const;
const rollbackButtonProps = {
  class: 'plugin-manager__rollback-button rounded-0',
  density: 'compact',
  size: 'small',
  variant: 'text'
} as const;
const rollbackDialogProps = {
  maxWidth: '30rem'
} as const;
const rollbackCancelButtonProps = {
  class: 'rounded-0',
  density: 'compact',
  variant: 'text'
} as const;
const rollbackConfirmButtonProps = {
  class: 'rounded-0',
  color: 'warning',
  density: 'compact',
  variant: 'flat'
} as const;
const privilegedPermissionIds: ReadonlySet<PluginPermissionId> = new Set([
  'renderer.code',
  'node.fs',
  'node.process',
  'node.native',
  'electron.system'
]);
const stateLabels: Readonly<Record<PluginRuntimeState, string>> = {
  disabled: '已停用',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  crashed: '已崩溃',
  blocked: '已阻止'
};
const stateColors: Readonly<Record<PluginRuntimeState, string>> = {
  disabled: 'secondary',
  starting: 'info',
  running: 'success',
  stopping: 'info',
  crashed: 'error',
  blocked: 'warning'
};
const permissionLabels: Readonly<Record<PluginPermissionId, string>> = {
  'window.manage': '管理应用窗口',
  'workspace.read': '读取工作区',
  'workspace.write': '修改工作区',
  'workspace.open': '打开仓库',
  'network.request': '发起网络请求',
  'clipboard.read': '读取剪贴板',
  'clipboard.write': '写入剪贴板',
  'notifications.show': '发送通知',
  'notifications.system': '发送系统通知',
  'dialogs.show': '显示工作台对话框',
  'external.open': '打开外部链接',
  'webViewer.navigate': '访问外部网页',
  'storage.plugin': '读写插件存储',
  'editor.read': '读取编辑器内容',
  'editor.write': '修改编辑器内容',
  'renderer.code': '执行渲染进程代码',
  'node.fs': '访问 Node 文件系统',
  'node.process': '访问 Node 进程能力',
  'node.native': '加载 Node 原生模块',
  'electron.system': '访问 Electron 系统能力'
};
const permissionReasons: Readonly<Record<PluginPermissionId, string>> = {
  'window.manage': '插件需要列出、打开、聚焦或关闭应用窗口。',
  'workspace.read': '插件需要读取工作区文件。',
  'workspace.write': '插件需要创建或修改工作区文件。',
  'workspace.open': '插件可以请求用户通过系统目录选择器打开仓库。',
  'network.request': '插件需要访问远程服务。',
  'clipboard.read': '插件需要读取当前剪贴板内容。',
  'clipboard.write': '插件需要写入当前剪贴板。',
  'notifications.show': '插件需要向工作台发送通知。',
  'notifications.system': '插件需要向操作系统发送系统通知。',
  'dialogs.show': '插件需要显示由宿主渲染的列表、输入或确认对话框。',
  'external.open': '插件需要打开系统外部链接。',
  'webViewer.navigate': '插件需要在工作台中查看外部网页。',
  'storage.plugin': '插件需要保存自己的配置和缓存。',
  'editor.read': '插件需要读取当前编辑器文档。',
  'editor.write': '插件需要修改当前编辑器文档。',
  'renderer.code': '插件请求执行渲染进程代码，当前版本不支持授权。',
  'node.fs': '插件请求访问 Node 文件系统，当前版本不支持授权。',
  'node.process': '插件请求访问 Node 进程能力，当前版本不支持授权。',
  'node.native': '插件请求加载 Node 原生模块，当前版本不支持授权。',
  'electron.system': '插件请求访问 Electron 系统能力，当前版本不支持授权。'
};

const displayError = computed(() => localError.value ?? pluginError.value);
const thirdPartyPlugins = computed(() => plugins.value.filter(plugin => !plugin.isCore));

/** 获取插件的权限声明；兼容没有权限原因的旧摘要。 */
function getPermissionRequests(plugin: PluginSummary): readonly PluginPermissionRequest[] {
  if (plugin.permissionRequests.length > 0) {
    return plugin.permissionRequests;
  }

  return plugin.permissions.map((id) => ({
    id,
    reason: permissionReasons[id]
  }));
}

/** 获取权限在界面上的本地化名称。 */
function getPermissionLabel(id: PluginPermissionId): string {
  return permissionLabels[id];
}

/** 获取权限的展示原因。 */
function getPermissionReason(request: PluginPermissionRequest): string {
  return request.reason || permissionReasons[request.id];
}

/** 组合权限原因与可选 Scope，作为列表行的完整描述。 */
function getPermissionDescription(request: PluginPermissionRequest): string {
  const reason = getPermissionReason(request);
  return request.scope?.length ? `${reason} 范围：${request.scope.join('、')}` : reason;
}

/** 判断权限是否属于当前版本禁止授权的特权能力。 */
function isPrivilegedPermission(id: PluginPermissionId): boolean {
  return privilegedPermissionIds.has(id);
}

/** 获取插件当前的权限草稿，避免在请求完成前丢失用户选择。 */
function getGrantedPermissions(plugin: PluginSummary): readonly PluginPermissionId[] {
  return permissionDrafts.value[plugin.id] ?? plugin.grantedPermissions;
}

/** 判断权限是否已被授予。 */
function hasGrantedPermission(plugin: PluginSummary, id: PluginPermissionId): boolean {
  return getGrantedPermissions(plugin).includes(id);
}

/** 判断插件是否处于不允许再次发起生命周期变更的状态。 */
function isPluginBusy(plugin: PluginSummary): boolean {
  return loading.value || plugin.state === 'starting' || plugin.state === 'stopping';
}

/** 获取插件运行状态的颜色。 */
function getStateColor(state: PluginRuntimeState): string {
  return stateColors[state];
}

/** 返回指定插件运行状态对应的 Vuetify 徽标属性。 */
function getStateChipProps(state: PluginRuntimeState): Readonly<Record<string, unknown>> {
  return {
    ...stateChipProps,
    color: getStateColor(state)
  };
}

/** 获取插件运行状态的中文名称。 */
function getStateLabel(state: PluginRuntimeState): string {
  return stateLabels[state];
}

/** 判断指定插件的列表详情是否展开。 */
function isPluginExpanded(pluginId: string): boolean {
  return expandedPluginIds.value.includes(pluginId);
}

/** 切换指定插件的列表详情显示状态。 */
function togglePluginDetails(pluginId: string): void {
  expandedPluginIds.value = isPluginExpanded(pluginId)
    ? expandedPluginIds.value.filter((id) => id !== pluginId)
    : [...expandedPluginIds.value, pluginId];
}

/** 判断 unknown 值是否为用户选择的文件。 */
function isFile(value: unknown): value is File {
  return typeof File !== 'undefined' && value instanceof File;
}

/** 从 Vuetify 文件输入事件中提取单个插件包文件。 */
function readSelectedFile(value: unknown): File | undefined {
  if (isFile(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.find(isFile);
  }

  return undefined;
}

/** 安装用户选择的 `.wstudio-plugin` 包。 */
async function handleInstallFileChange(value: unknown): Promise<void> {
  const file = readSelectedFile(value);
  selectedFile.value = file ?? null;
  localError.value = undefined;

  if (!file) {
    return;
  }

  const sourcePath = await pluginApi.selectPackagePath();

  if (!sourcePath) {
    localError.value = 'PLUGIN_FILE_PATH_UNAVAILABLE';
    return;
  }

  await pluginStore.install(sourcePath);

  if (!pluginError.value) {
    selectedFile.value = null;
  }
}

/** 安装用户选择的新版本包，并保留当前版本用于回滚。 */
async function handleUpdateFileChange(plugin: PluginSummary, value: unknown): Promise<void> {
  if (plugin.isCore) {
    return;
  }

  const file = readSelectedFile(value);
  updateFiles.value = { ...updateFiles.value, [plugin.id]: file ?? null };
  localError.value = undefined;

  if (!file) {
    return;
  }

  const sourcePath = await pluginApi.selectPackagePath();

  if (!sourcePath) {
    localError.value = 'PLUGIN_FILE_PATH_UNAVAILABLE';
    return;
  }

  const updatedPlugin = await pluginStore.update(plugin.id, sourcePath);

  if (updatedPlugin) {
    updateFiles.value = { ...updateFiles.value, [plugin.id]: null };
  }
}

/** 刷新插件摘要和当前工作台贡献。 */
async function refreshPlugins(): Promise<void> {
  localError.value = undefined;
  await pluginStore.refresh();
  await pluginStore.refreshContributions({ activateRuntime: false });
}

/** 更新插件启用状态。 */
async function handleEnabledChange(plugin: PluginSummary, rawValue: unknown): Promise<void> {
  if (typeof rawValue !== 'boolean' || rawValue === plugin.enabled || isPluginBusy(plugin)) {
    return;
  }

  localError.value = undefined;
  await pluginStore.setEnabled(plugin.id, rawValue);
}

/** 更新普通权限授权，并在主进程拒绝时恢复旧值。 */
async function handlePermissionChange(
  plugin: PluginSummary,
  permissionId: PluginPermissionId,
  rawValue: unknown
): Promise<void> {
  if (
    typeof rawValue !== 'boolean'
    || isPrivilegedPermission(permissionId)
    || isPluginBusy(plugin)
  ) {
    return;
  }

  const previousPermissions = [...getGrantedPermissions(plugin)];
  const nextPermissions = rawValue
    ? [...new Set([...previousPermissions, permissionId])]
    : previousPermissions.filter((id) => id !== permissionId);
  permissionDrafts.value = { ...permissionDrafts.value, [plugin.id]: nextPermissions };
  localError.value = undefined;

  const updatedPlugin = await pluginStore.setPermissions(plugin.id, nextPermissions);

  permissionDrafts.value = {
    ...permissionDrafts.value,
    [plugin.id]: updatedPlugin
      ? [...updatedPlugin.grantedPermissions]
      : previousPermissions
  };
}

/** 打开插件卸载确认对话框。 */
function requestUninstall(plugin: PluginSummary): void {
  if (plugin.isCore) {
    return;
  }

  pluginToRemove.value = plugin;
}

/** 打开插件回滚确认对话框。 */
function requestRollback(plugin: PluginSummary): void {
  if (plugin.isCore) {
    return;
  }

  pluginToRollback.value = plugin;
}

/** 确认回滚当前选中的插件。 */
async function confirmRollback(): Promise<void> {
  const plugin = pluginToRollback.value;

  if (!plugin) {
    return;
  }

  localError.value = undefined;
  const rolledBackPlugin = await pluginStore.rollback(plugin.id);

  if (rolledBackPlugin) {
    pluginToRollback.value = undefined;
  }
}

/** 确认卸载当前选中的插件。 */
async function confirmUninstall(): Promise<void> {
  const plugin = pluginToRemove.value;

  if (!plugin) {
    return;
  }

  localError.value = undefined;
  const removed = await pluginStore.uninstall(plugin.id);

  if (removed) {
    const nextDrafts = { ...permissionDrafts.value };
    delete nextDrafts[plugin.id];
    permissionDrafts.value = nextDrafts;
    pluginToRemove.value = undefined;
  }
}
</script>

<template>
  <section
    aria-label="第三方插件"
    class="plugin-manager-panel"
  >
    <SettingsOptionList
      list-label="第三方插件列表"
      title="第三方插件"
      description="安装、启停第三方插件并管理其权限授权。"
      >
        <template #actions>
          <WsTooltip text="刷新插件列表">
            <template #activator="{ props: tooltipProps }">
              <v-btn
                v-bind="{ ...refreshButtonProps, ...tooltipProps }"
                aria-label="刷新插件列表"
                :disabled="loading"
                @click="refreshPlugins"
              >
                <span
                  aria-hidden="true"
                  class="plugin-manager__button-icon"
                  :class="refreshIcon"
                />
              </v-btn>
            </template>
          </WsTooltip>
        </template>

      <SettingsOptionItem
        v-if="displayError"
        title="插件操作失败"
        :description="displayError"
      />

      <SettingsOptionItem
        title="安装插件包"
        description="选择一个 .wstudio-plugin 包安装到当前工作台。"
      >
        <v-file-input
          v-model="selectedFile"
          v-bind="pluginFileInputProps"
          aria-label="安装插件包"
          class="plugin-manager__field-control"
          :loading="loading"
          placeholder="选择 .wstudio-plugin 文件"
          @update:model-value="handleInstallFileChange"
        />
      </SettingsOptionItem>

      <SettingsOptionItem
        v-if="loading"
        title="正在处理插件"
        description="插件状态更新完成后，列表会自动同步。"
      >
        <v-progress-linear
          v-bind="progressProps"
          class="plugin-manager__progress"
        />
      </SettingsOptionItem>

      <SettingsOptionItem
        v-if="!loading && thirdPartyPlugins.length === 0"
        title="暂无第三方插件"
        description="选择一个 .wstudio-plugin 包开始安装。"
      />

      <template
        v-for="plugin in thirdPartyPlugins"
        :key="plugin.id"
      >
        <SettingsOptionItem
          :title="plugin.name"
          :description="plugin.description"
        >
          <v-chip
            v-bind="getStateChipProps(plugin.state)"
          >
            {{ getStateLabel(plugin.state) }}
          </v-chip>
          <WsSwitch
            :disabled="isPluginBusy(plugin) || (plugin.state === 'blocked' && !plugin.enabled)"
            :model-value="plugin.enabled"
            :aria-label="`${plugin.name}启用状态`"
            @click.stop
            @update:model-value="handleEnabledChange(plugin, $event)"
          />
          <v-btn
            v-bind="manageButtonProps"
            :aria-label="`${isPluginExpanded(plugin.id) ? '收起' : '管理'}${plugin.name}`"
            @click="togglePluginDetails(plugin.id)"
          >
            {{ isPluginExpanded(plugin.id) ? '收起' : '管理' }}
          </v-btn>
        </SettingsOptionItem>

        <template v-if="isPluginExpanded(plugin.id)">
          <div class="plugin-manager__subheader">
            {{ plugin.name }}详情
          </div>

          <SettingsOptionItem
            title="插件标识"
            description="插件清单中的稳定 ID。"
            inset
          >
            <span class="plugin-manager__value">{{ plugin.id }}</span>
          </SettingsOptionItem>
          <SettingsOptionItem
            title="当前版本"
            description="当前已安装的插件版本。"
            inset
          >
            <span class="plugin-manager__value">v{{ plugin.version }}</span>
          </SettingsOptionItem>
          <SettingsOptionItem
            title="作者"
            description="插件清单中声明的作者。"
            inset
          >
            <span class="plugin-manager__value">{{ plugin.authorName }}</span>
          </SettingsOptionItem>
          <SettingsOptionItem
            title="信任级别"
            description="宿主根据插件清单确定的信任级别。"
            inset
          >
            <span class="plugin-manager__value">
              {{ plugin.trustLevel === 'privileged' ? '特权插件' : '标准插件' }}
            </span>
          </SettingsOptionItem>

          <SettingsOptionItem
            v-if="plugin.state === 'blocked'"
            title="插件未启动"
            description="该插件当前被宿主阻止，请检查清单和权限状态。"
            inset
          />

          <div class="plugin-manager__subheader">
            版本管理
          </div>
          <SettingsOptionItem
            title="更新插件"
            :description="plugin.enabled
              ? '请先停用插件后再选择更新包。'
              : '选择更高版本的 .wstudio-plugin 文件更新插件。'"
            inset
          >
            <v-file-input
              :model-value="updateFiles[plugin.id] ?? null"
              v-bind="updateFileInputProps"
              :aria-label="`更新${plugin.name}`"
              class="plugin-manager__field-control"
              :disabled="plugin.enabled || isPluginBusy(plugin)"
              placeholder="选择更新包"
              @update:model-value="handleUpdateFileChange(plugin, $event)"
            />
          </SettingsOptionItem>
          <SettingsOptionItem
            v-if="plugin.rollbackVersion"
            title="回滚插件"
            :description="`回滚到 v${plugin.rollbackVersion}，插件会保持停用状态。`"
            inset
          >
            <v-btn
              v-bind="rollbackButtonProps"
              :disabled="plugin.enabled || isPluginBusy(plugin)"
              @click="requestRollback(plugin)"
            >
              <span
                aria-hidden="true"
                class="plugin-manager__button-icon"
                :class="refreshIcon"
              />
              <span>回滚</span>
            </v-btn>
          </SettingsOptionItem>

          <div class="plugin-manager__subheader">
            权限授权
          </div>
          <SettingsOptionItem
            title="已授权权限"
            description="修改授权后，运行中的插件会自动重启以应用新权限。"
            inset
          >
            <span class="plugin-manager__value">
              {{ getGrantedPermissions(plugin).length }}/{{ getPermissionRequests(plugin).length }}
            </span>
          </SettingsOptionItem>
          <SettingsOptionItem
            v-for="request in getPermissionRequests(plugin)"
            :key="`${plugin.id}:${request.id}`"
            :title="getPermissionLabel(request.id)"
            :description="getPermissionDescription(request)"
            inset
          >
            <WsSwitch
              v-if="!isPrivilegedPermission(request.id)"
              :disabled="loading || isPluginBusy(plugin)"
              :model-value="hasGrantedPermission(plugin, request.id)"
              :aria-label="`授权${getPermissionLabel(request.id)}`"
              @update:model-value="handlePermissionChange(plugin, request.id, $event)"
            />
            <v-chip
              v-else
              v-bind="privilegedChipProps"
            >
              特权
            </v-chip>
          </SettingsOptionItem>
          <SettingsOptionItem
            v-if="getPermissionRequests(plugin).some((request) => isPrivilegedPermission(request.id))"
            title="特权权限暂不可授权"
            description="渲染进程代码、Node 和 Electron 系统级权限需要后续安全审批流程。"
            inset
          />

          <div class="plugin-manager__subheader">
            插件操作
          </div>
          <SettingsOptionItem
            title="卸载插件"
            description="删除插件运行数据和设置，此操作不可撤销。"
            inset
          >
            <v-btn
              v-bind="uninstallButtonProps"
              :disabled="isPluginBusy(plugin)"
              @click="requestUninstall(plugin)"
            >
              <span
                aria-hidden="true"
                class="plugin-manager__button-icon"
                :class="deleteIcon"
              />
              <span>卸载</span>
            </v-btn>
          </SettingsOptionItem>
        </template>
      </template>
    </SettingsOptionList>

    <v-dialog
      v-model="isUninstallDialogVisible"
      v-bind="uninstallDialogProps"
    >
      <v-card class="plugin-manager__uninstall-dialog rounded-0">
        <v-card-title>确认卸载插件</v-card-title>
        <v-card-text>
          将卸载「{{ pluginToRemove?.name }}」，同时删除该插件的运行数据和设置。此操作不可撤销。
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn
            v-bind="uninstallCancelButtonProps"
            :disabled="loading"
            @click="isUninstallDialogVisible = false"
          >
            取消
          </v-btn>
          <v-btn
            v-bind="uninstallConfirmButtonProps"
            :loading="loading"
            @click="confirmUninstall"
          >
            确认卸载
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog
      v-model="isRollbackDialogVisible"
      v-bind="rollbackDialogProps"
    >
      <v-card class="plugin-manager__uninstall-dialog rounded-0">
        <v-card-title>确认回滚插件</v-card-title>
        <v-card-text>
          将把「{{ pluginToRollback?.name }}」从 v{{ pluginToRollback?.version }} 回滚到
          v{{ pluginToRollback?.rollbackVersion }}，插件会保持停用状态。
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn
            v-bind="rollbackCancelButtonProps"
            :disabled="loading"
            @click="isRollbackDialogVisible = false"
          >
            取消
          </v-btn>
          <v-btn
            v-bind="rollbackConfirmButtonProps"
            :loading="loading"
            @click="confirmRollback"
          >
            确认回滚
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </section>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.plugin-manager-panel {
  min-width: 0;
  line-height: $editor-line-height;
  color: var(--ws-foreground);
}

.plugin-manager__button-icon {
  display: block;
  flex: none;
  width: $font-size-md;
  height: $font-size-md;
  font-size: $font-size-md;
  line-height: 1;
}

.plugin-manager__field-control {
  width: $settings-option-control-width;
}

.plugin-manager__progress {
  width: $settings-option-compact-control-width;
}

.plugin-manager__subheader {
  display: flex;
  align-items: center;
  min-height: $settings-dialog-navigation-item-height;
  padding-inline-start: $settings-option-detail-padding-inline-start;
  color: var(--ws-descriptionForeground);
  font-size: $font-size-xs;
  border-bottom: $settings-option-list-border-width solid var(--ws-border);
}

.plugin-manager__value {
  max-width: $settings-option-value-max-width;
  overflow: hidden;
  color: var(--ws-descriptionForeground);
  font-size: $font-size-sm;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-manager__uninstall-button {
  gap: $spacing-xs;
  color: var(--ws-danger-foreground);
  text-transform: none;
}

.plugin-manager__rollback-button {
  gap: $spacing-xs;
  color: var(--ws-foreground);
  text-transform: none;
}

.plugin-manager__uninstall-dialog {
  color: var(--ws-foreground);
  background: var(--ws-dialog-background);
  border: $settings-option-list-border-width solid var(--ws-border);
}

@media (max-width: $settings-option-mobile-breakpoint) {
  .plugin-manager__field-control {
    width: $settings-option-compact-control-width;
  }
}
</style>
