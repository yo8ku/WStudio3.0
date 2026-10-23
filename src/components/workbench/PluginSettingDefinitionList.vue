<script setup lang="ts">
/**
 * 文件说明：在统一设置列表中渲染插件字段、声明式分组、可见性和禁用条件。
 */
import { computed, ref, watch } from 'vue';

import PluginSettingFieldItem from '@/components/workbench/PluginSettingFieldItem.vue';
import SettingsOptionItem from '@/components/workbench/SettingsOptionItem.vue';
import SettingsOptionList from '@/components/workbench/SettingsOptionList.vue';
import WsTooltip from '@/components/WsTooltip/WsTooltip.vue';
import type {
  PluginSettingContribution,
  PluginSettingDefinition,
  PluginSettingField,
  PluginSettingGroup,
  PluginSettingPage,
  PluginSettingStatusRow,
  PluginSettingValue
} from '../../../plugin/sdk';
import {
  evaluatePluginSettingCondition,
  getPluginSettingDefaultValue,
  resolvePluginSettingDefinitions
} from '../../../plugin/settings/model';

/** 插件设置定义列表的权威贡献、值快照和保存状态。 */
interface PluginSettingDefinitionListProps {
  setting: PluginSettingContribution;
  values: Readonly<Record<string, PluginSettingValue>>;
  error?: string;
  savingFieldId?: string;
}

/** 顶层字段的最终展示状态。 */
interface VisiblePluginSettingField {
  type: 'field';
  field: PluginSettingField;
  disabled: boolean;
  inset: boolean;
}

/** 分组和其中可见字段的最终展示状态。 */
interface VisiblePluginSettingGroup {
  type: 'group';
  group: PluginSettingGroup;
  fields: readonly VisiblePluginSettingField[];
}

/** 子页面入口的最终展示状态。 */
interface VisiblePluginSettingPage {
  type: 'page';
  page: PluginSettingPage;
  disabled: boolean;
}

/** 只读状态行的最终展示状态。 */
interface VisiblePluginSettingStatus {
  type: 'status';
  row: PluginSettingStatusRow;
}

type VisiblePluginSettingDefinition =
  | VisiblePluginSettingField
  | VisiblePluginSettingGroup
  | VisiblePluginSettingPage
  | VisiblePluginSettingStatus;

const props = defineProps<PluginSettingDefinitionListProps>();

const backButtonProps = {
  density: 'compact',
  icon: true,
  size: 'small',
  variant: 'text'
} as const;

const emit = defineEmits<{
  change: [field: PluginSettingField, value: PluginSettingValue];
}>();

/** 判断声明式设置项在当前同页值快照下是否可见。 */
function isVisible(definition: PluginSettingDefinition): boolean {
  return evaluatePluginSettingCondition(definition.visible, props.values, true);
}

/** 当前设置页局部导航的路径状态，不写入插件设置值。 */
const pagePath = ref<string[]>([]);

/** 根据局部导航路径解析当前要渲染的定义容器。 */
const activePage = computed(() => {
  let definitions = resolvePluginSettingDefinitions(props.setting);
  let title = props.setting.title;
  let description = props.setting.description;
  let id = props.setting.id;
  const resolvedPath: string[] = [];

  for (const pageId of pagePath.value) {
    const page = definitions.find(
      (definition): definition is PluginSettingPage => (
        definition.type === 'page' && definition.id === pageId
      )
    );
    if (!page) break;
    definitions = page.items;
    title = page.title;
    description = page.description;
    id = page.id;
    resolvedPath.push(page.id);
  }

  return { id, title, description, definitions, path: resolvedPath };
});

/** 贡献重新加载后回到页面根节点，避免保留失效的子页面路径。 */
watch(() => props.setting, () => {
  pagePath.value = [];
});

/** 计算字段自身和所在分组共同决定的禁用状态。 */
function isDisabled(field: PluginSettingField, groupDisabled = false): boolean {
  return groupDisabled
    || evaluatePluginSettingCondition(field.disabled, props.values, false);
}

/** 将定义树映射为模板直接消费的可见列表状态。 */
const visibleDefinitions = computed<readonly VisiblePluginSettingDefinition[]>(() => {
  const visible: VisiblePluginSettingDefinition[] = [];

  for (const definition of activePage.value.definitions) {
    if (!isVisible(definition)) continue;
    if (definition.type !== 'group') {
      if (definition.type === 'page') {
        visible.push({
          type: 'page',
          page: definition,
          disabled: evaluatePluginSettingCondition(definition.disabled, props.values, false)
        });
        continue;
      }
      if (definition.type === 'status') {
        visible.push({ type: 'status', row: definition });
        continue;
      }
      visible.push({
        type: 'field',
        field: definition,
        disabled: isDisabled(definition),
        inset: false
      });
      continue;
    }
    const groupDisabled = evaluatePluginSettingCondition(
      definition.disabled,
      props.values,
      false
    );
    const fields = definition.items
      .filter(isVisible)
      .map((field): VisiblePluginSettingField => ({
        type: 'field',
        field,
        disabled: isDisabled(field, groupDisabled),
        inset: true
      }));
    if (fields.length > 0) visible.push({ type: 'group', group: definition, fields });
  }

  return visible;
});

/** 读取字段当前值，并在快照未加载时使用字段默认值。 */
function getFieldValue(field: PluginSettingField): PluginSettingValue {
  return props.values[field.id] ?? getPluginSettingDefaultValue(field);
}

/** 将字段提交事件转发给设置页容器。 */
function handleFieldChange(field: PluginSettingField, value: PluginSettingValue): void {
  emit('change', field, value);
}

/** 进入声明式子页面。 */
function openPage(page: PluginSettingPage): void {
  if (evaluatePluginSettingCondition(page.disabled, props.values, false)) return;
  pagePath.value = [...activePage.value.path, page.id];
}

/** 返回上一级设置列表。 */
function goBack(): void {
  pagePath.value = activePage.value.path.slice(0, -1);
}

/** 为不同类型的列表定义返回稳定的 Vue key。 */
function getDefinitionKey(definition: VisiblePluginSettingDefinition): string {
  if (definition.type === 'field') return definition.field.id;
  if (definition.type === 'group') return definition.group.id;
  if (definition.type === 'page') return definition.page.id;
  return definition.row.id;
}
</script>

<template>
  <SettingsOptionList
    :list-label="activePage.title"
  >
    <template
      v-if="activePage.path.length > 0"
      #actions
    >
      <WsTooltip text="返回上一级设置">
        <template #activator="{ props: tooltipProps }">
          <v-btn
            v-bind="{ ...backButtonProps, ...tooltipProps }"
            aria-label="返回上一级设置"
            @click="goBack"
          >
            <span class="icon icon-arrow-back" aria-hidden="true" />
          </v-btn>
        </template>
      </WsTooltip>
    </template>
    <SettingsOptionItem
      v-if="error"
      title="设置保存失败"
      :description="error"
    />

    <template
      v-for="definition in visibleDefinitions"
      :key="getDefinitionKey(definition)"
    >
      <PluginSettingFieldItem
        v-if="definition.type === 'field'"
        :field="definition.field"
        :model-value="getFieldValue(definition.field)"
        :disabled="definition.disabled"
        :inset="definition.inset"
        :loading="savingFieldId === definition.field.id"
        @change="handleFieldChange"
      />

      <SettingsOptionItem
        v-else-if="definition.type === 'page'"
        :title="definition.page.title"
        :description="definition.page.description"
        :disabled="definition.disabled"
        :clickable="!definition.disabled"
        @click="openPage(definition.page)"
      >
        <span class="icon icon-arrow-forward" aria-hidden="true" />
      </SettingsOptionItem>

      <SettingsOptionItem
        v-else-if="definition.type === 'status'"
        :title="definition.row.label"
        :description="definition.row.description"
      >
        <span class="plugin-setting-definition-list__status">
          {{ definition.row.value ?? '未提供' }}
        </span>
      </SettingsOptionItem>

      <template v-else>
        <div class="plugin-setting-definition-list__group">
          <span class="plugin-setting-definition-list__group-copy">
            <strong>{{ definition.group.title }}</strong>
            <small v-if="definition.group.description">
              {{ definition.group.description }}
            </small>
          </span>
        </div>
        <PluginSettingFieldItem
          v-for="field in definition.fields"
          :key="field.field.id"
          :field="field.field"
          :model-value="getFieldValue(field.field)"
          :disabled="field.disabled"
          :inset="field.inset"
          :loading="savingFieldId === field.field.id"
          @change="handleFieldChange"
        />
      </template>
    </template>

    <SettingsOptionItem
      v-if="visibleDefinitions.length === 0"
      title="暂无设置字段"
      description="此插件设置页没有当前可编辑的字段。"
    />
  </SettingsOptionList>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;

.plugin-setting-definition-list__group {
  display: flex;
  align-items: center;
  min-height: $settings-option-row-min-height;
  padding-inline: $spacing-md;
  color: var(--ws-foreground);
}

.plugin-setting-definition-list__group-copy {
  @include flex-column;
  gap: $spacing-3xs;
  min-width: 0;
}

.plugin-setting-definition-list__group-copy strong {
  font-size: $font-size-sm;
  font-weight: $editor-heading-font-weight;
  letter-spacing: 0;
}

.plugin-setting-definition-list__group-copy small {
  color: var(--ws-descriptionForeground);
  font-size: $font-size-xs;
  line-height: $editor-line-height;
}

.plugin-setting-definition-list__status {
  max-width: $settings-option-value-max-width;
  overflow: hidden;
  color: var(--ws-descriptionForeground);
  font-size: $font-size-sm;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
