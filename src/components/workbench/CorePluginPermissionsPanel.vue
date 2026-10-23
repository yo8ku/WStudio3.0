<script setup lang="ts">
/**
 * 文件说明：渲染单个核心插件的权限页面，并提供权限授权开关。
 */
import WsSwitch from '@/components/WsSwitch/WsSwitch.vue';
const arrowBackIcon = 'icon icon-arrow-back';
import SettingsOptionItem from '@/components/workbench/SettingsOptionItem.vue';
import SettingsOptionList from '@/components/workbench/SettingsOptionList.vue';
import type { PluginPermissionId, PluginPermissionRequest, PluginSummary } from '../../../plugin/sdk';
import { computed } from 'vue';

interface CorePluginPermissionsPanelProps {
  plugin: PluginSummary;
  loading: boolean;
  error?: string;
}

const props = defineProps<CorePluginPermissionsPanelProps>();
const emit = defineEmits<{
  back: [];
  change: [permissionId: PluginPermissionId, enabled: boolean];
}>();

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
  'editor.read': '插件需要读取当前编辑器内容。',
  'editor.write': '插件需要修改当前编辑器内容。',
  'renderer.code': '插件请求执行渲染进程代码，当前版本不支持授权。',
  'node.fs': '插件请求访问 Node 文件系统，当前版本不支持授权。',
  'node.process': '插件请求访问 Node 进程能力，当前版本不支持授权。',
  'node.native': '插件请求加载 Node 原生模块，当前版本不支持授权。',
  'electron.system': '插件请求访问 Electron 系统能力，当前版本不支持授权。'
};

const privilegedPermissionIds: ReadonlySet<PluginPermissionId> = new Set([
  'renderer.code',
  'node.fs',
  'node.process',
  'node.native',
  'electron.system'
]);
const backButtonProps = {
  density: 'compact',
  variant: 'text'
} as const;
const privilegedChipProps = {
  class: 'rounded-0',
  color: 'warning',
  density: 'compact',
  size: 'small',
  variant: 'tonal'
} as const;

const permissionRequests = computed<readonly PluginPermissionRequest[]>(() => (
  props.plugin.permissionRequests.length > 0
    ? props.plugin.permissionRequests
    : props.plugin.permissions.map(id => ({ id, reason: permissionReasons[id] }))
));

/** 返回权限的本地化名称。 */
function getPermissionLabel(id: PluginPermissionId): string {
  return permissionLabels[id];
}

/** 返回权限说明并拼接可选 Scope。 */
function getPermissionDescription(request: PluginPermissionRequest): string {
  const reason = request.reason || permissionReasons[request.id];
  return request.scope?.length ? `${reason} 范围：${request.scope.join('、')}` : reason;
}

/** 判断权限是否已授权。 */
function hasGrantedPermission(id: PluginPermissionId): boolean {
  return props.plugin.grantedPermissions.includes(id);
}

/** 将权限开关变化交给设置窗口和插件 Store。 */
function handlePermissionChange(id: PluginPermissionId, value: unknown): void {
  if (typeof value === 'boolean' && !privilegedPermissionIds.has(id) && !props.loading) {
    emit('change', id, value);
  }
}
</script>

<template>
  <section class="core-plugin-permissions">
    <v-btn
      v-bind="backButtonProps"
      class="core-plugin-permissions__back"
      @click="emit('back')"
    >
      <span
        aria-hidden="true"
        class="core-plugin-permissions__back-icon"
        :class="arrowBackIcon"
      />
      <span>返回</span>
    </v-btn>

    <SettingsOptionList
      :list-label="`${plugin.name}权限列表`"
    >
      <SettingsOptionItem
        v-if="error"
        title="权限操作失败"
        :description="error"
      />
      <SettingsOptionItem
        v-else-if="permissionRequests.length === 0"
        title="无需权限"
        description="该插件没有声明额外权限。"
      />
      <template v-else>
        <SettingsOptionItem
          v-for="request in permissionRequests"
          :key="request.id"
          :title="getPermissionLabel(request.id)"
          :description="getPermissionDescription(request)"
        >
          <WsSwitch
            v-if="!privilegedPermissionIds.has(request.id)"
            :disabled="loading"
            :loading="loading"
            :model-value="hasGrantedPermission(request.id)"
            :aria-label="`授权${getPermissionLabel(request.id)}`"
            @update:model-value="handlePermissionChange(request.id, $event)"
          />
          <v-chip
            v-else
            v-bind="privilegedChipProps"
          >
            特权
          </v-chip>
        </SettingsOptionItem>
      </template>
    </SettingsOptionList>
  </section>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.core-plugin-permissions {
  min-width: 0;
}

.core-plugin-permissions__back {
  margin-bottom: $spacing-md;
  padding-inline: $spacing-xs;
  border-radius: $radius-xs !important;
}

.core-plugin-permissions__back-icon {
  display: block;
  width: $font-size-md;
  height: $font-size-md;
  margin-inline-end: $spacing-2xs;
  font-size: $font-size-md;
  line-height: 1;
}
</style>
