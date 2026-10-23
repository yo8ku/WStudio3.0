<script setup lang="ts">
/**
 * 文件说明：渲染核心插件设置列表，提供插件名称搜索与启用状态切换。
 */
import { computed, ref } from 'vue';

const pluginSettingsIcon = 'icon icon-settings';
const pluginShortcutsIcon = 'icon icon-plugin-shortcuts';
const shieldIcon = 'icon icon-shield';
import WsSearchInput from '@/components/WsSearchInput/WsSearchInput.vue';
import WsSwitch from '@/components/WsSwitch/WsSwitch.vue';
import WsTooltip from '@/components/WsTooltip/WsTooltip.vue';
import SettingsOptionItem from '@/components/workbench/SettingsOptionItem.vue';
import SettingsOptionList from '@/components/workbench/SettingsOptionList.vue';
import { WORKBENCH_TOOLTIP_OPEN_DELAY } from '@/utils/workbenchTooltip';
import type { PluginSummary } from '../../../plugin/sdk';

/** 核心插件列表面板的输入属性。 */
interface CorePluginsSettingsPanelProps {
  plugins: readonly PluginSummary[];
  configurablePluginIds: readonly string[];
  loading: boolean;
  error?: string;
}

const props = defineProps<CorePluginsSettingsPanelProps>();

const emit = defineEmits<{
  toggle: [pluginId: string, enabled: boolean];
  'open-settings': [pluginId: string];
  'open-shortcuts': [];
  'open-permissions': [pluginId: string];
}>();

const searchQuery = ref('');
const actionButtonProps = {
  density: 'compact',
  icon: true,
  ripple: false,
  variant: 'text'
} as const;
const actionTooltipProps = {
  location: 'top',
  openDelay: WORKBENCH_TOOLTIP_OPEN_DELAY
} as const;

const corePlugins = computed<readonly PluginSummary[]>(() => (
  props.plugins
    .filter(plugin => plugin.isCore)
    .sort((left, right) => left.name.localeCompare(right.name))
));

const filteredCorePlugins = computed<readonly PluginSummary[]>(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase();

  if (!query) {
    return corePlugins.value;
  }

  return corePlugins.value.filter(plugin => (
    plugin.name.toLocaleLowerCase().includes(query)
    || plugin.description.toLocaleLowerCase().includes(query)
  ));
});

/** 判断插件是否处于不能立即切换的生命周期状态。 */
function isPluginBusy(plugin: PluginSummary): boolean {
  return props.loading || plugin.state === 'starting' || plugin.state === 'stopping';
}

/** 判断核心插件是否声明了可打开的设置页。 */
function hasPluginSettings(pluginId: string): boolean {
  return props.configurablePluginIds.includes(pluginId);
}

/** 判断核心插件是否声明了需要用户授权的权限。 */
function hasPluginPermissions(plugin: PluginSummary): boolean {
  return plugin.permissionRequests.length > 0;
}

/** 请求打开指定核心插件声明的设置页。 */
function requestPluginSettings(pluginId: string): void {
  if (hasPluginSettings(pluginId)) {
    emit('open-settings', pluginId);
  }
}

/** 请求打开快捷键设置页。 */
function requestPluginShortcuts(): void {
  emit('open-shortcuts');
}

/** 请求打开指定核心插件的权限页面。 */
function requestPluginPermissions(pluginId: string): void {
  emit('open-permissions', pluginId);
}

/** 将开关值转发给设置弹窗，由插件 Store 完成持久化与运行时同步。 */
function handlePluginToggle(plugin: PluginSummary, value: unknown): void {
  if (typeof value !== 'boolean' || isPluginBusy(plugin) || (plugin.state === 'blocked' && value)) {
    return;
  }

  emit('toggle', plugin.id, value);
}
</script>

<template>
  <section
    aria-label="核心插件"
    class="core-plugins-settings"
  >
    <SettingsOptionList
      list-label="核心插件列表"
    >
      <template #actions>
        <!-- S = 核心插件搜索框 -->
        <WsSearchInput
          v-model="searchQuery"
          aria-label="搜索核心插件"
          class="core-plugins-settings__search"
          clearable
          placeholder="输入插件名称或描述"
        />
        <!-- E = 核心插件搜索框 -->
      </template>

      <SettingsOptionItem
        v-if="error"
        title="插件列表加载失败"
        :description="error"
      />

      <SettingsOptionItem
        v-else-if="loading && corePlugins.length === 0"
        title="正在加载核心插件"
        description="插件加载完成后会显示在此处。"
      />

      <SettingsOptionItem
        v-else-if="corePlugins.length === 0"
        title="暂无核心插件"
        description="当前版本没有可用的核心插件。"
      />

      <SettingsOptionItem
        v-else-if="filteredCorePlugins.length === 0"
        title="没有匹配的核心插件"
        description="请尝试输入其他插件名称或描述。"
      />

      <template v-else>
        <SettingsOptionItem
          v-for="plugin in filteredCorePlugins"
          :key="plugin.id"
          :title="plugin.name"
          :description="plugin.description"
        >
          <WsTooltip
            v-if="hasPluginPermissions(plugin)"
            v-bind="actionTooltipProps"
            text="需要权限"
          >
            <template #activator="{ props: tooltipProps }">
              <v-btn
                v-bind="{ ...actionButtonProps, ...tooltipProps }"
                :aria-label="`打开${plugin.name}权限`"
                class="core-plugins-settings__action"
                @click.stop="requestPluginPermissions(plugin.id)"
              >
                <span
                  aria-hidden="true"
                  class="core-plugins-settings__action-icon"
                  :class="shieldIcon"
                />
              </v-btn>
            </template>
          </WsTooltip>
          <WsTooltip
            v-if="hasPluginSettings(plugin.id)"
            v-bind="actionTooltipProps"
            text="设置"
          >
            <template #activator="{ props: tooltipProps }">
              <v-btn
                v-bind="{ ...actionButtonProps, ...tooltipProps }"
                :aria-label="`打开${plugin.name}设置`"
                class="core-plugins-settings__action"
                @click.stop="requestPluginSettings(plugin.id)"
              >
                <span
                  aria-hidden="true"
                  class="core-plugins-settings__action-icon"
                  :class="pluginSettingsIcon"
                />
              </v-btn>
            </template>
          </WsTooltip>
          <WsTooltip
            v-bind="actionTooltipProps"
            text="快捷键"
          >
            <template #activator="{ props: tooltipProps }">
              <v-btn
                v-bind="{ ...actionButtonProps, ...tooltipProps }"
                :aria-label="`打开${plugin.name}快捷键`"
                class="core-plugins-settings__action"
                @click.stop="requestPluginShortcuts"
              >
                <span
                  aria-hidden="true"
                  class="core-plugins-settings__action-icon"
                  :class="pluginShortcutsIcon"
                />
              </v-btn>
            </template>
          </WsTooltip>
          <WsSwitch
            :disabled="isPluginBusy(plugin) || (plugin.state === 'blocked' && !plugin.enabled)"
            :loading="isPluginBusy(plugin)"
            :model-value="plugin.enabled"
            :aria-label="`${plugin.name}启用状态`"
            @update:model-value="handlePluginToggle(plugin, $event)"
          />
        </SettingsOptionItem>
      </template>
    </SettingsOptionList>
  </section>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.core-plugins-settings {
  min-width: 0;
}

.core-plugins-settings__search {
  width: $settings-option-control-width;
  max-width: 100%;
}

.core-plugins-settings__search :deep(.v-input__control),
.core-plugins-settings__search :deep(.v-field) {
  min-height: $settings-plugin-search-height;
  height: $settings-plugin-search-height;
}

.core-plugins-settings__search :deep(.v-field__input) {
  min-height: $settings-plugin-search-height;
  padding-block: $spacing-none;
  font-size: $font-size-xs;
}

.core-plugins-settings__action {
  width: $settings-plugin-action-size;
  min-width: $settings-plugin-action-size;
  height: $settings-plugin-action-size;
  border-radius: $radius-xs !important;
}

.core-plugins-settings__action-icon {
  display: block;
  width: $settings-plugin-action-icon-size;
  height: $settings-plugin-action-icon-size;
  font-size: $settings-plugin-action-icon-size;
  line-height: 1;
}

</style>
