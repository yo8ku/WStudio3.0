<script setup lang="ts">
/**
 * 文件说明：渲染工作台设置弹窗、静态设置导航与当前主题选择入口。
 */
import {
  computed,
  onMounted,
  ref,
  watch
} from 'vue';
import { storeToRefs } from 'pinia';

const arrowDownIcon = 'icon icon-arrow-down';
const arrowForwardIcon = 'icon icon-arrow-forward';
const addIcon = 'icon icon-add';
const dotIcon = 'icon icon-dot';
import AIModelSettingsPanel from '@/components/workbench/AIModel/AIModelSettingsPanel.vue';
import CorePluginPermissionsPanel from '@/components/workbench/CorePluginPermissionsPanel.vue';
import WsDialog from '@/components/WsDialog/WsDialog.vue';
import WsIconButton from '@/components/WsIconButton/WsIconButton.vue';
import WsSelect from '@/components/WsSelect/WsSelect.vue';
import WsSwitch from '@/components/WsSwitch/WsSwitch.vue';
import WsTooltip from '@/components/WsTooltip/WsTooltip.vue';
import WorkbenchVerticalScrollbar from '@/components/scrollbar/WorkbenchVerticalScrollbar.vue';
import CorePluginsSettingsPanel from '@/components/workbench/CorePluginsSettingsPanel.vue';
import PluginManagerPanel from '@/components/workbench/PluginManagerPanel.vue';
import PluginSettingDefinitionList from '@/components/workbench/PluginSettingDefinitionList.vue';
import SettingsOptionItem from '@/components/workbench/SettingsOptionItem.vue';
import SettingsOptionList from '@/components/workbench/SettingsOptionList.vue';
import ShortcutSettingsPanel from '@/components/workbench/ShortcutSettingsPanel.vue';
import SettingsEditorView from '@/views/settingsEditor/SettingsEditorView.vue';
import { windowApi } from '@/api/window';
const closeIcon = 'icon icon-close';
const windowOpenIcon = 'icon icon-windowopen';
import { useAiModelStore } from '@/store/aiModel';
import { useThemeStore } from '@/store/theme';
import { usePluginStore } from '@/store/plugin';
import type { AiConfiguration } from '@/types/aiConfiguration';
import type {
  PluginPermissionId,
  PluginSettingContribution,
  PluginSettingField,
  PluginSettingValue
} from '../../../plugin/sdk';
import { getPluginSettingDefaultValue } from '../../../plugin/settings/model';

/** 设置窗口的导航与初始页面，支持独立窗口与工作台标签两种模式。 */
interface SettingsDialogProps {
  initialNavigationId?: string;
  embedded?: boolean;
}

/** 左侧设置导航的基础条目。 */
interface SettingsNavigationItem {
  id: string;
  label: string;
}

/** 左侧设置导航的分组。 */
interface SettingsNavigationSection {
  id: string;
  title: string;
  items: readonly SettingsNavigationItem[];
}

/** 内置设置页面的标题、说明与空状态文案。 */
interface BuiltInSettingsPage extends SettingsNavigationItem {
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
}

/** 插件贡献的设置导航条目。 */
interface PluginSettingsNavigationItem extends SettingsNavigationItem {
  pluginId: string;
  setting: PluginSettingContribution;
}

const props = withDefaults(defineProps<SettingsDialogProps>(), {
  initialNavigationId: undefined,
  embedded: false
});

const emit = defineEmits<{
  close: [];
}>();

const themeStore = useThemeStore();
const pluginStore = usePluginStore();
const aiModelStore = useAiModelStore();
const {
  availableThemes,
  activeThemeId,
  initializing,
  initializationError,
  modernUiEnabled
} = storeToRefs(themeStore);
const {
  plugins,
  contributions: pluginContributions,
  settings: pluginSettings,
  error: pluginError
} = storeToRefs(pluginStore);
const { configurations: aiConfigurations } = storeToRefs(aiModelStore);
const selectedThemeId = ref<string | null>(null);
const activeAiConfigurationId = ref('default');
const isAiNavigationExpanded = ref(true);
const isAiConfigurationDeleteDialogOpen = ref(false);
const settingsContentScrollerElement = ref<HTMLElement | null>(null);

const themeOptions = computed(() => availableThemes.value.map((theme) => ({
  title: theme.label,
  value: theme.id
})));
const activeSettingsNavigationItemId = ref('appearance');
const activeCorePluginPermissionId = ref<string | undefined>();
const builtInSettingsPages: readonly BuiltInSettingsPage[] = [
  {
    id: 'about',
    label: '关于',
    title: '关于',
    description: '查看 WStudio 的产品与运行信息。',
    emptyTitle: '暂无可配置项',
    emptyDescription: '当前版本没有提供关于页面的可配置选项。'
  },
  {
    id: 'editor',
    label: '编辑器',
    title: '编辑器',
    description: '调整文本编辑与内容展示偏好。',
    emptyTitle: '暂无编辑器选项',
    emptyDescription: '当前版本没有提供编辑器级设置。'
  },
  {
    id: 'files-and-links',
    label: '文件与链接',
    title: '文件与链接',
    description: '管理文件与链接相关行为。',
    emptyTitle: '暂无文件与链接选项',
    emptyDescription: '当前版本没有提供文件与链接设置。'
  },
  {
    id: 'appearance',
    label: '外观',
    title: '外观',
    description: '调整工作台的视觉偏好。',
    emptyTitle: '',
    emptyDescription: ''
  },
  {
    id: 'shortcuts',
    label: '快捷键',
    title: '快捷键',
    description: '管理工作台命令快捷键。',
    emptyTitle: '',
    emptyDescription: ''
  },
  {
    id: 'ai-model',
    label: 'AI',
    title: 'AI',
    description: '配置 AI 服务商与连接信息。',
    emptyTitle: '',
    emptyDescription: ''
  },
  {
    id: 'core-plugins',
    label: '核心插件',
    title: '核心插件',
    description: '管理随 WStudio 发布的内置插件。',
    emptyTitle: '暂无核心插件',
    emptyDescription: '当前版本没有可用的核心插件。'
  },
  {
    id: 'plugin-manager',
    label: '第三方插件',
    title: '第三方插件',
    description: '安装、启停第三方插件并管理权限。',
    emptyTitle: '',
    emptyDescription: ''
  }
] as const;
const builtInSettingsNavigationSections = computed<readonly SettingsNavigationSection[]>(() => [{
  id: 'options',
  title: '选项',
  items: builtInSettingsPages
}]);
const pluginSettingsItems = computed<PluginSettingsNavigationItem[]>(() => (
  pluginContributions.value.flatMap((contribution) => contribution.settings.map((setting) => ({
    id: `plugin-setting:${contribution.pluginId}:${setting.id}`,
    label: setting.title,
    pluginId: contribution.pluginId,
    setting
  })))
));
const configurableCorePluginIds = computed<readonly string[]>(() => (
  [...new Set(pluginSettingsItems.value.map(item => item.pluginId))]
));
const settingsNavigationSections = computed<readonly SettingsNavigationSection[]>(() => {
  const sections: SettingsNavigationSection[] = [...builtInSettingsNavigationSections.value];

  if (pluginSettingsItems.value.length > 0) {
    sections.push(
    {
      id: 'plugin-settings',
      title: '插件设置',
      items: pluginSettingsItems.value
    }
    );
  }

  return sections;
});
const activePluginSetting = computed(() => pluginSettingsItems.value.find(
  (item) => item.id === activeSettingsNavigationItemId.value
));
const isPluginManagerActive = computed(
  () => activeSettingsNavigationItemId.value === 'plugin-manager'
);
const isCorePluginSectionActive = computed(
  () => activeSettingsNavigationItemId.value === 'core-plugins'
);
const activeCorePluginPermission = computed(() => plugins.value.find(plugin => (
  plugin.isCore && plugin.id === activeCorePluginPermissionId.value
)));
const activeBuiltInSettingsPage = computed<BuiltInSettingsPage | undefined>(() => {
  return builtInSettingsPages.find(page => page.id === activeSettingsNavigationItemId.value);
});
const activeAiConfiguration = computed(() => aiConfigurations.value.find(
  configuration => configuration.id === activeAiConfigurationId.value
) ?? aiConfigurations.value[0]);
const activeAiConfigurationName = computed({
  get: () => activeAiConfiguration.value?.name ?? '',
  set: (name: string) => updateActiveAiConfiguration({ name })
});
const activeAiConfigurationEnabled = computed({
  get: () => activeAiConfiguration.value?.enabled ?? true,
  set: (enabled: boolean) => {
    if (enabled !== activeAiConfiguration.value?.enabled) {
      updateActiveAiConfiguration({ enabled });
    }
  }
});
const pluginSettingDrafts = ref<Record<string, PluginSettingValue>>({});
const activePluginSettingValues = computed<Record<string, PluginSettingValue>>(() => {
  const setting = activePluginSetting.value;

  if (!setting) {
    return {};
  }

  return {
    ...pluginSettings.value[`${setting.pluginId}:${setting.setting.id}`],
    ...pluginSettingDrafts.value
  };
});
const savingPluginFieldId = ref<string | undefined>();
const dialogCardProps = {
  elevation: 8,
  rounded: '0'
} as const;
const titleActionButtonProps = {
  density: 'comfortable',
  icon: true,
  variant: 'text'
} as const;
const navigationListProps = {
  density: 'compact',
  nav: true
} as const;
const navigationItemProps = {
  ripple: false
} as const;
const navigationActionButtonProps = {
  density: 'compact',
  ripple: false,
  size: 'x-small',
  variant: 'text'
} as const;
const dialogActionButtonProps = {
  density: 'comfortable',
  ripple: false,
  variant: 'text'
} as const;

/**
 * 更新设置导航当前选中项。
 */
function selectSettingsNavigationItem(itemId: string): void {
  activeCorePluginPermissionId.value = undefined;
  activeSettingsNavigationItemId.value = itemId;
}

/** 选中 AI 导航项并切换其配置子项的可见状态。*/
function selectAiNavigation(): void {
  selectSettingsNavigationItem('ai-model');
  isAiNavigationExpanded.value = !isAiNavigationExpanded.value;
}

/** Keeps a configuration child active only while the AI settings page is selected. */
function isAiConfigurationActive(configurationId: string): boolean {
  return activeSettingsNavigationItemId.value === 'ai-model'
    && activeAiConfigurationId.value === configurationId;
}

/** Returns the accessible status text for an AI configuration in the navigation. */
function getAiConfigurationStatusLabel(configuration: AiConfiguration): string {
  if (!configuration.enabled) return '已关闭';
  return configuration.hasConnectedModel ? '已连接成功' : '尚未连接成功';
}

/** 更新当前 AI 配置项中的可编辑字段。*/
function updateActiveAiConfiguration(
  updates: Partial<Pick<AiConfiguration, 'name' | 'enabled'>>
): void {
  const configuration = activeAiConfiguration.value;
  if (!configuration) return;

  const nextName = updates.name ?? configuration.name;
  const nextEnabled = updates.enabled ?? configuration.enabled;
  if (nextName === configuration.name && nextEnabled === configuration.enabled) {
    return;
  }

  void aiModelStore.updateConfiguration(configuration.id, {
    name: nextName,
    enabled: nextEnabled
  });
}

/** 选中指定 AI 配置项并保持分组展开。*/
function selectAiConfiguration(configurationId: string): void {
  activeAiConfigurationId.value = configurationId;
  selectSettingsNavigationItem('ai-model');
  isAiNavigationExpanded.value = true;
}

/** 新增一项按顺序命名的 AI 配置并将其设为当前配置。*/
async function addAiConfiguration(): Promise<void> {
  const configuration = await aiModelStore.createConfiguration();
  if (configuration) {
    selectAiConfiguration(configuration.id);
  }
}

/** Opens the deletion confirmation for the configuration currently shown in the right panel. */
function openAiConfigurationDeleteDialog(): void {
  if (!activeAiConfiguration.value || aiConfigurations.value.length <= 1) {
    return;
  }

  aiModelStore.clearError();
  isAiConfigurationDeleteDialogOpen.value = true;
}

/** Closes the configuration deletion dialog and clears errors specific to that operation. */
function closeAiConfigurationDeleteDialog(): void {
  isAiConfigurationDeleteDialogOpen.value = false;
  aiModelStore.clearError();
}

/** Deletes the active configuration and selects its next sibling, or the previous one at the list end. */
async function deleteActiveAiConfiguration(): Promise<void> {
  const configuration = activeAiConfiguration.value;
  if (!configuration) return;

  const currentIndex = aiConfigurations.value.findIndex(item => item.id === configuration.id);
  const deleted = await aiModelStore.deleteConfiguration(configuration.id);
  if (!deleted) return;

  const nextIndex = Math.min(Math.max(currentIndex, 0), aiConfigurations.value.length - 1);
  const nextConfiguration = aiConfigurations.value[nextIndex];
  if (nextConfiguration) {
    selectAiConfiguration(nextConfiguration.id);
  }
  isAiConfigurationDeleteDialogOpen.value = false;
}

/** 同步从其他窗口或设置标签传入的初始导航项。 */
watch(() => props.initialNavigationId, (navigationId) => {
  if (navigationId) {
    activeSettingsNavigationItemId.value = navigationId;
  }
}, { immediate: true });

/** 在插件贡献变化后保证当前设置导航仍然指向有效项目。 */
watch(settingsNavigationSections, (sections) => {
  const allItems = sections.flatMap((section) => section.items);

  if (!allItems.some((item) => item.id === activeSettingsNavigationItemId.value)) {
    activeSettingsNavigationItemId.value = 'appearance';
  }
}, { immediate: true });

/** 在切换插件设置页时从主进程加载持久化字段值。 */
watch(activePluginSetting, (setting) => {
  if (setting) {
    void pluginStore.loadSettings(setting.pluginId, setting.setting.id).then((values) => {
      if (values) {
        pluginSettingDrafts.value = { ...pluginSettingDrafts.value, ...values };
      }
    });
  }
}, { immediate: true });

/**
 * 将主题 Store 的当前值同步到弹窗选择控件。
 */
watch(activeThemeId, (themeId) => {
  selectedThemeId.value = themeId;
}, { immediate: true });

/**
 * 应用用户选择的主题，并保留当前主题以便失败时恢复选择。
 */
async function handleThemeChange(themeId: string | null): Promise<void> {
  if (!themeId || themeId === activeThemeId.value) {
    return;
  }

  try {
    await themeStore.setActiveTheme(themeId);
  } catch {
    selectedThemeId.value = activeThemeId.value;
  }
}

/** 将 Vuetify 复选框值收窄为布尔值并更新工作区外观偏好。 */
function handleModernUiChange(rawValue: unknown): void {
  if (typeof rawValue === 'boolean') {
    themeStore.setModernUiEnabled(rawValue);
  }
}

/** 打开核心插件声明的第一个设置页。 */
function handleCorePluginSettingsRequest(pluginId: string): void {
  const setting = pluginSettingsItems.value.find(item => item.pluginId === pluginId);

  if (setting) {
    selectSettingsNavigationItem(setting.id);
  }
}

/** 打开快捷键设置页，后续由快捷键页面按插件继续筛选。 */
function handleCorePluginShortcutsRequest(): void {
  selectSettingsNavigationItem('shortcuts');
}

/** 打开指定核心插件的权限页面。 */
function handleCorePluginPermissionsRequest(pluginId: string): void {
  activeCorePluginPermissionId.value = pluginId;
}

/** 返回核心插件列表页面。 */
function handleCorePluginPermissionsBack(): void {
  activeCorePluginPermissionId.value = undefined;
}

/** 请求主工作台创建设置标签，并关闭当前独立设置窗口。 */
async function handleOpenMainWindow(): Promise<void> {
  if (props.embedded) return;
  await windowApi.openSettingsTab(activeSettingsNavigationItemId.value);
  await windowApi.close();
}

/** Handles an explicit close request without coupling it to dialog visibility updates. */
function requestClose(): void {
  if (props.embedded) {
    emit('close');
    return;
  }
  void windowApi.close();
}

/** 更新核心插件权限，并由插件 Store 负责重启运行时和持久化。 */
async function handleCorePluginPermissionChange(
  permissionId: PluginPermissionId,
  enabled: boolean
): Promise<void> {
  const plugin = plugins.value.find(candidate => candidate.id === activeCorePluginPermissionId.value);

  if (!plugin) {
    return;
  }

  await pluginStore.setPermissionEnabled(plugin.id, permissionId, enabled);
}

/** 更新核心插件启用状态，并由插件 Store 负责主进程同步。 */
async function handleCorePluginEnabledChange(pluginId: string, enabled: boolean): Promise<void> {
  const plugin = plugins.value.find(candidate => candidate.id === pluginId);

  if (!plugin || enabled === plugin.enabled) {
    return;
  }

  await pluginStore.setEnabled(pluginId, enabled);
}

/** 将已通过组件校验的字段值委托 Store 持久化。 */
async function handlePluginSettingChange(
  field: PluginSettingField,
  value: PluginSettingValue
): Promise<void> {
  const setting = activePluginSetting.value;

  if (!setting) {
    return;
  }

  savingPluginFieldId.value = field.id;
  pluginSettingDrafts.value = { ...pluginSettingDrafts.value, [field.id]: value };
  const values = await pluginStore.setSetting(
    setting.pluginId,
    setting.setting.id,
    field.id,
    value
  );

  if (values) {
    pluginSettingDrafts.value = { ...pluginSettingDrafts.value, ...values };
  } else {
    const storedValues = pluginSettings.value[`${setting.pluginId}:${setting.setting.id}`] ?? {};
    pluginSettingDrafts.value = {
      ...pluginSettingDrafts.value,
      [field.id]: storedValues[field.id] ?? getPluginSettingDefaultValue(field)
    };
  }

  savingPluginFieldId.value = undefined;
}

onMounted(() => {
  void themeStore.refreshUserThemes();
  void aiModelStore.loadConfigurations().then(() => {
    const selectedConfiguration = aiConfigurations.value.find(
      configuration => configuration.id === activeAiConfigurationId.value
    ) ?? aiConfigurations.value[0];
    if (selectedConfiguration) {
      activeAiConfigurationId.value = selectedConfiguration.id;
    }
  });
});

</script>

<template>
  <section
    aria-label="设置"
    class="settings-dialog-container settings-dialog-container--standalone"
  >
    <v-card
      v-bind="dialogCardProps"
      class="settings-dialog settings-dialog--standalone"
    >
      <v-card-title
        v-if="!props.embedded"
        class="settings-dialog__title"
      >
        <span>设置</span>
        <div class="settings-dialog__title-actions">
          <WsTooltip text="在主窗口中打开">
            <template #activator="{ props: tooltipProps }">
              <v-btn
                v-bind="{ ...titleActionButtonProps, ...tooltipProps }"
                aria-label="在主窗口中打开"
                class="settings-dialog__title-action"
                @click="handleOpenMainWindow"
              >
                <span
                  aria-hidden="true"
                  class="settings-dialog__title-action-icon"
                  :class="windowOpenIcon"
                />
              </v-btn>
            </template>
          </WsTooltip>
          <WsTooltip text="关闭设置">
            <template #activator="{ props: tooltipProps }">
              <v-btn
                v-bind="{ ...titleActionButtonProps, ...tooltipProps }"
                aria-label="关闭设置"
                class="settings-dialog__title-action"
                @click="requestClose"
              >
                <span
                  aria-hidden="true"
                  class="settings-dialog__title-action-icon"
                  :class="closeIcon"
                />
              </v-btn>
            </template>
          </WsTooltip>
        </div>
      </v-card-title>

      <v-card-text class="settings-dialog__body">
        <v-list
          v-bind="navigationListProps"
          aria-label="设置分类"
          class="settings-dialog__navigation"
        >
          <template
            v-for="(section, sectionIndex) in settingsNavigationSections"
            :key="section.id"
          >
            <v-list-subheader
              class="settings-dialog__navigation-title"
              :class="{
                'settings-dialog__navigation-title--separated': sectionIndex > 0
              }"
            >
              {{ section.title }}
            </v-list-subheader>
            <template
              v-for="item in section.items"
              :key="item.id"
            >
              <v-list-item
                v-bind="navigationItemProps"
                :active="item.id === activeSettingsNavigationItemId && (item.id !== 'ai-model' || !isAiNavigationExpanded)"
                class="settings-dialog__navigation-item"
                :class="{
                  'settings-dialog__navigation-item--active': item.id === activeSettingsNavigationItemId && (item.id !== 'ai-model' || !isAiNavigationExpanded)
                }"
                :title="item.label"
                @click="item.id === 'ai-model' ? selectAiNavigation() : selectSettingsNavigationItem(item.id)"
              >
                <template #prepend>
                  <span
                    v-if="item.id === 'ai-model'"
                    aria-hidden="true"
                    class="settings-dialog__navigation-icon"
                    :class="isAiNavigationExpanded ? arrowDownIcon : arrowForwardIcon"
                  />
                  <span
                    v-else
                    aria-hidden="true"
                    class="settings-dialog__navigation-control-placeholder"
                  />
                </template>
                <template
                  v-if="item.id === 'ai-model' && item.id === activeSettingsNavigationItemId"
                  #append
                >
                  <WsIconButton
                    v-bind="navigationActionButtonProps"
                    class="settings-dialog__navigation-add"
                    :icon="addIcon"
                    @click.stop="addAiConfiguration"
                    label="新增配置"
                  />
                </template>
              </v-list-item>
              <template v-if="item.id === 'ai-model' && isAiNavigationExpanded">
                <v-list-item
                  v-for="configuration in aiConfigurations"
                  :key="configuration.id"
                  v-bind="navigationItemProps"
                  :active="isAiConfigurationActive(configuration.id)"
                  class="settings-dialog__navigation-item settings-dialog__navigation-item--child"
                  :class="{
                    'settings-dialog__navigation-item--active': isAiConfigurationActive(configuration.id)
                  }"
                  :title="configuration.name"
                  @click="selectAiConfiguration(configuration.id)"
                >
                  <template #prepend>
                    <span
                      :aria-label="getAiConfigurationStatusLabel(configuration)"
                      class="settings-dialog__navigation-configuration-status"
                      :class="[dotIcon, {
                        'settings-dialog__navigation-configuration-status--connected': (
                          configuration.enabled && configuration.hasConnectedModel
                        ),
                        'settings-dialog__navigation-configuration-status--warning': (
                          configuration.enabled && !configuration.hasConnectedModel
                        ),
                        'settings-dialog__navigation-configuration-status--disabled': !configuration.enabled
                      }]"
                      role="img"
                    />
                  </template>
                </v-list-item>
              </template>
            </template>
          </template>
        </v-list>

        <main class="settings-dialog__content-shell">
          <div
            ref="settingsContentScrollerElement"
            class="settings-dialog__content"
          >
            <!-- S = 第三方插件 -->
            <PluginManagerPanel v-if="isPluginManagerActive" />
            <!-- E = 第三方插件 -->

            <template
              v-if="activePluginSetting"
            >
              <!-- S = 插件声明式设置 -->
              <PluginSettingDefinitionList
                :setting="activePluginSetting.setting"
                :values="activePluginSettingValues"
                :error="pluginError"
                :saving-field-id="savingPluginFieldId"
                @change="handlePluginSettingChange"
              />
              <!-- E = 插件声明式设置 -->
            </template>

            <template v-else-if="isCorePluginSectionActive">
              <!-- S = 核心插件权限 -->
              <CorePluginPermissionsPanel
                v-if="activeCorePluginPermission"
                :error="pluginError"
                :loading="pluginStore.loading"
                :plugin="activeCorePluginPermission"
                @back="handleCorePluginPermissionsBack"
                @change="handleCorePluginPermissionChange"
              />
              <!-- E = 核心插件权限 -->

              <!-- S = 核心插件设置列表 -->
              <CorePluginsSettingsPanel
                v-else
                :configurable-plugin-ids="configurableCorePluginIds"
                :error="pluginError"
                :loading="pluginStore.loading"
                :plugins="plugins"
                @open-settings="handleCorePluginSettingsRequest"
                @open-permissions="handleCorePluginPermissionsRequest"
                @open-shortcuts="handleCorePluginShortcutsRequest"
                @toggle="handleCorePluginEnabledChange"
              />
              <!-- E = 核心插件设置列表 -->
            </template>

            <template
              v-else-if="activeBuiltInSettingsPage"
            >
              <!-- S = 快捷键列表 -->
              <AIModelSettingsPanel
                v-if="activeBuiltInSettingsPage.id === 'ai-model' && activeAiConfiguration"
                :can-delete-configuration="aiConfigurations.length > 1"
                :configuration-id="activeAiConfiguration.id"
                v-model:configuration-enabled="activeAiConfigurationEnabled"
                v-model:configuration-name="activeAiConfigurationName"
                @delete:configuration="openAiConfigurationDeleteDialog"
              />
              <ShortcutSettingsPanel
                v-else-if="activeBuiltInSettingsPage.id === 'shortcuts'"
              />
              <SettingsEditorView
                v-else-if="activeBuiltInSettingsPage.id === 'editor'"
              />
              <!-- E = 快捷键列表 -->

              <SettingsOptionList
                v-else
                :list-label="activeBuiltInSettingsPage.title"
                :title="activeBuiltInSettingsPage.title"
              >
                <template v-if="activeBuiltInSettingsPage.id === 'appearance'">
                  <SettingsOptionItem
                    title="主题"
                    description="选择工作台使用的颜色主题。"
                  >
                    <WsSelect
                      v-model="selectedThemeId"
                      aria-label="主题"
                      class="settings-dialog__field-control"
                      :disabled="themeOptions.length === 0"
                      :error-messages="initializationError ?? undefined"
                      :items="themeOptions"
                      :loading="initializing"
                      @update:model-value="handleThemeChange"
                    />
                  </SettingsOptionItem>
                  <SettingsOptionItem
                    title="Modern UI"
                    description="启用紧凑圆角外观与现代化工作台间距。"
                  >
                    <WsSwitch
                      :model-value="modernUiEnabled"
                      aria-label="启用 Modern UI"
                      @update:model-value="handleModernUiChange"
                    />
                  </SettingsOptionItem>
                </template>
                <SettingsOptionItem
                  v-else
                  :title="activeBuiltInSettingsPage.emptyTitle"
                />
              </SettingsOptionList>
            </template>

            <WsDialog
              v-model="isAiConfigurationDeleteDialogOpen"
              close-label="关闭删除配置确认"
              :persistent="aiModelStore.configurationDeleting"
              title="删除配置"
              width="22rem"
            >
              <p class="settings-dialog__configuration-delete-message">
                删除“{{ activeAiConfiguration?.name }}”后，该配置中的 API 密钥、地址和模型将无法恢复。
              </p>
              <p
                v-if="aiModelStore.error"
                class="settings-dialog__configuration-delete-error"
                role="alert"
              >
                {{ aiModelStore.error }}
              </p>
              <template #actions>
                <v-spacer />
                <v-btn
                  v-bind="dialogActionButtonProps"
                  :disabled="aiModelStore.configurationDeleting"
                  @click="closeAiConfigurationDeleteDialog"
                >
                  取消
                </v-btn>
                <v-btn
                  v-bind="dialogActionButtonProps"
                  class="settings-dialog__configuration-delete-confirm"
                  :loading="aiModelStore.configurationDeleting"
                  @click="deleteActiveAiConfiguration"
                >
                  删除
                </v-btn>
              </template>
            </WsDialog>

          </div>

          <!-- S = 设置内容纵向滚动条 -->
          <WorkbenchVerticalScrollbar :scroller-element="settingsContentScrollerElement" />
          <!-- E = 设置内容纵向滚动条 -->
        </main>
      </v-card-text>
    </v-card>
  </section>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;

.settings-dialog-container--standalone {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.settings-dialog {
  color: var(--ws-foreground);
  background: var(--ws-dialog-background);
  user-select: none;
}

.settings-dialog--standalone {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  margin: 0;
  border: 0;
  border-radius: 0 !important;
}

.settings-dialog--standalone .settings-dialog__body {
  flex: 1 1 auto;
  min-height: 0;
}

.settings-dialog :deep(input),
.settings-dialog :deep(textarea) {
  user-select: text;
}

.settings-dialog__title {
  @include flex-between;
  height: $settings-dialog-title-height;
  padding: $spacing-sm $spacing-md;
  color: var(--ws-foreground);
  font-size: $font-size-md !important;
  border-bottom: $editor-table-border-width solid var(--ws-border);
  user-select: none;
  background: var(--ws-titleBar-activeBackground);
  -webkit-app-region: drag;
}

.settings-dialog__title-actions {
  @include flex-align-center;

  gap: $spacing-2xs;
  -webkit-app-region: no-drag;
}

.settings-dialog__title-action {
  height: auto !important;
  padding: $spacing-2xs;
  border-radius: $radius-xs !important;
  width: 30px;
  -webkit-app-region: no-drag;
}

.settings-dialog__body {
  display: grid;
  flex: 1 1 auto;
  grid-template-columns: $settings-dialog-navigation-width minmax(0, 1fr);
  min-height: 0;
  padding: 0 !important;
}

.settings-dialog__navigation {
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
  padding: $spacing-sm $spacing-xs;
  color: inherit;
  border-right: $editor-table-border-width solid var(--ws-border);
  background: inherit;
}

.settings-dialog__navigation-title {
  min-height: $settings-dialog-navigation-item-height;
  padding-inline: $spacing-sm;
  color: var(--ws-descriptionForeground);
  font-size: $font-size-xs;
}

.settings-dialog__navigation-title--separated {
  margin-top: $settings-dialog-navigation-section-gap;
}

.settings-dialog__navigation-item {
  --v-activated-opacity: #{$settings-dialog-navigation-overlay-opacity};
  --v-hover-opacity: #{$settings-dialog-navigation-overlay-opacity};

  min-height: $settings-dialog-navigation-item-height;
  color: inherit;
  font-size: 1.25rem;

  &:hover {
    background: var(--ws-list-hoverBackground);
  }
}

.settings-dialog__navigation-item--active {
  color: var(--ws-list-activeForeground);
  background: var(--ws-list-activeSelectionBackground) !important;
}

.settings-dialog__navigation-item--active :deep(.v-list-item__overlay) {
  display: none;
}

.settings-dialog__navigation-item :deep(.v-list-item__prepend) {
  align-items: center;
  margin-inline-end: $spacing-2xs;
}

.settings-dialog__navigation-item--child {
  padding-inline-start: $spacing-xl;
}

.settings-dialog__navigation-icon,
.settings-dialog__navigation-control-placeholder,
.settings-dialog__navigation-configuration-status {
  display: block;
  width: $font-size-lg;
  min-width: $font-size-lg;
  height: $font-size-lg;
  line-height: 0;
}

.settings-dialog__navigation-icon {
  color: var(--ws-descriptionForeground);
}

.settings-dialog__navigation-configuration-status--connected {
  color: #3fb950;
}

.settings-dialog__navigation-configuration-status--warning {
  color: #d1a80a;
}

.settings-dialog__navigation-configuration-status--disabled {
  color: #8d8d8d;
}

.settings-dialog__navigation-add {
  width: $icon-size-width;
  min-width: $icon-size-width;
  height: $icon-size-height;
  padding: 0;
  border-radius: $radius-xs;
  color: var(--ws-descriptionForeground);
}

.settings-dialog__navigation-add:hover,
.settings-dialog__navigation-add:focus-visible {
  color: var(--ws-foreground);
  background: var(--ws-menu-hoverBackground);
}

.settings-dialog__navigation-icon,
.settings-dialog__navigation-configuration-status {
  display: block;
  width: 100%;
  height: 100%;
}

.settings-dialog__navigation-add :deep(.ws-icon-button__icon) {
  width: 100%;
  height: 100%;
}

.settings-dialog__content-shell {
  --workbench-scrollbar-hit-width: #{$scrollbar-hit-width};
  --workbench-scrollbar-thumb-width: #{$scrollbar-thumb-width};
  --workbench-scrollbar-thumb-min-height: #{$scrollbar-thumb-min-height};
  --workbench-scrollbar-thumb: var(--ws-editor-scrollbarSlider-background);
  --workbench-scrollbar-thumb-hover: var(--ws-editor-scrollbarSlider-hoverBackground);
  --workbench-scrollbar-thumb-active: var(--ws-editor-scrollbarSlider-activeBackground);
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.settings-dialog__content {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: $spacing-lg;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.settings-dialog__content::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}

.settings-dialog__title-action-icon {
  display: block;
  width: $settings-dialog-close-icon-size;
  height: $settings-dialog-close-icon-size;
  font-size: $settings-dialog-close-icon-size;
  line-height: 1;
}

.settings-dialog__configuration-delete-message,
.settings-dialog__configuration-delete-error {
  margin: 0;
  font-size: $font-size-sm;
  line-height: $editor-line-height;
}

.settings-dialog__configuration-delete-error {
  margin-top: $spacing-sm;
  color: var(--ws-errorForeground);
}

.settings-dialog__configuration-delete-confirm {
  color: var(--ws-errorForeground);
}

@media (max-width: $settings-option-mobile-breakpoint) {
  .settings-dialog__body {
    grid-template-columns: $settings-dialog-navigation-compact-width minmax(0, 1fr);
  }

  .settings-dialog__content {
    padding: $spacing-sm;
  }

  .settings-dialog__field-control {
    width: $settings-option-compact-control-width;
  }
}
</style>
