/**
 * 文件说明：提供插件声明式设置定义的跨进程校验、条件计算、扁平化和字段值校验。
 */

import type {
  PluginSettingCondition,
  PluginSettingContribution,
  PluginSettingDefinition,
  PluginSettingField,
  PluginSettingFieldBase,
  PluginSettingGroup,
  PluginSettingOption,
  PluginSettingPageDefinition,
  PluginSettingPage,
  PluginSettingStatusRow,
  PluginSettingValidationRule,
  PluginSettingValue
} from '../sdk';

const PLUGIN_SETTING_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const REGEXP_FLAGS_PATTERN = /^[dgimsuvy]*$/;

/** 描述字段值未通过宿主校验的稳定错误和展示消息。 */
export interface PluginSettingValidationFailure {
  code:
    | 'PLUGIN_SETTING_VALUE_TYPE_INVALID'
    | 'PLUGIN_SETTING_VALUE_OUT_OF_RANGE'
    | 'PLUGIN_SETTING_VALUE_INVALID_OPTION'
    | 'PLUGIN_SETTING_VALIDATION_FAILED';
  message: string;
}

/** 表示插件提供的声明式设置定义无法安全注册。 */
export class PluginSettingDefinitionError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'PluginSettingDefinitionError';
  }
}

/** 判断未知值是否为可按键读取的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 抛出统一的设置定义参数错误。 */
function invalidDefinition(message: string): never {
  throw new PluginSettingDefinitionError('PLUGIN_SETTING_DEFINITION_INVALID', message);
}

/** 读取必需的非空字符串。 */
function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalidDefinition(`${fieldName} must be a non-empty string.`);
  }
  return value;
}

/** 读取可选字符串。 */
function readOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalidDefinition(`${fieldName} must be a string.`);
  return value;
}

/** 读取工作区相对路径默认值，拒绝绝对路径和路径穿越。 */
function readOptionalWorkspacePath(value: unknown, fieldName: string): string | undefined {
  const pathValue = readOptionalString(value, fieldName);
  if (pathValue === undefined) return undefined;
  const normalized = pathValue.replace(/\\/g, '/').trim();
  if (
    normalized.length === 0
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized)
    || normalized.split('/').some(segment => segment === '..' || segment.length === 0)
  ) {
    invalidDefinition(`${fieldName} must be a workspace-relative path.`);
  }
  return normalized;
}

/** 校验设置页、分组和字段 ID 使用当前插件命名空间。 */
function readNamespacedId(value: unknown, pluginId: string, fieldName: string): string {
  const id = readRequiredString(value, fieldName);
  if (!PLUGIN_SETTING_ID_PATTERN.test(id) || !id.startsWith(`${pluginId}.`)) {
    invalidDefinition(`${fieldName} must use the current plugin namespace.`);
  }
  return id;
}

/** 读取设置值允许的跨进程基本类型。 */
function readSettingValue(value: unknown, fieldName: string): PluginSettingValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return invalidDefinition(`${fieldName} must be a string, finite number, or boolean.`);
}

/** 读取字段可见性或禁用状态条件。 */
function readCondition(
  value: unknown,
  pluginId: string,
  fieldName: string
): PluginSettingCondition | undefined {
  if (value === undefined || typeof value === 'boolean') return value;
  if (!isRecord(value)) invalidDefinition(`${fieldName} must be a boolean or condition object.`);
  if (value.operator !== 'equals' && value.operator !== 'not-equals') {
    invalidDefinition(`${fieldName}.operator must be equals or not-equals.`);
  }
  return {
    fieldId: readNamespacedId(value.fieldId, pluginId, `${fieldName}.fieldId`),
    operator: value.operator,
    value: readSettingValue(value.value, `${fieldName}.value`)
  };
}

/** 读取单条可序列化字段校验规则。 */
function readValidationRule(
  value: unknown,
  fieldName: string
): PluginSettingValidationRule {
  if (!isRecord(value)) invalidDefinition(`${fieldName} must be an object.`);
  const message = readRequiredString(value.message, `${fieldName}.message`);

  switch (value.type) {
    case 'required':
      return { type: 'required', message };
    case 'minLength':
    case 'maxLength': {
      if (!Number.isInteger(value.value) || (value.value as number) < 0) {
        invalidDefinition(`${fieldName}.value must be a non-negative integer.`);
      }
      return { type: value.type, value: value.value as number, message };
    }
    case 'pattern': {
      const pattern = readRequiredString(value.value, `${fieldName}.value`);
      const flags = readOptionalString(value.flags, `${fieldName}.flags`);
      if (flags !== undefined && !REGEXP_FLAGS_PATTERN.test(flags)) {
        invalidDefinition(`${fieldName}.flags contains unsupported regular expression flags.`);
      }
      try {
        new RegExp(pattern, flags);
      } catch {
        invalidDefinition(`${fieldName}.value must be a valid regular expression.`);
      }
      return {
        type: 'pattern',
        value: pattern,
        ...(flags !== undefined ? { flags } : {}),
        message
      };
    }
    default:
      return invalidDefinition(`${fieldName}.type is unsupported.`);
  }
}

/** 读取字段共用标签、条件和校验属性。 */
function readFieldBase(
  value: Record<string, unknown>,
  pluginId: string,
  fieldName: string
): PluginSettingFieldBase {
  const base: PluginSettingFieldBase = {
    id: readNamespacedId(value.id, pluginId, `${fieldName}.id`),
    label: readRequiredString(value.label, `${fieldName}.label`)
  };
  const description = readOptionalString(value.description, `${fieldName}.description`);
  const visible = readCondition(value.visible, pluginId, `${fieldName}.visible`);
  const disabled = readCondition(value.disabled, pluginId, `${fieldName}.disabled`);

  if (description !== undefined) base.description = description;
  if (visible !== undefined) base.visible = visible;
  if (disabled !== undefined) base.disabled = disabled;

  if (value.validate !== undefined) {
    if (!Array.isArray(value.validate)) {
      invalidDefinition(`${fieldName}.validate must be an array.`);
    }
    base.validate = value.validate.map((rule, index) => (
      readValidationRule(rule, `${fieldName}.validate[${index}]`)
    ));
  }

  return base;
}

/** 读取选择字段的非空、值唯一选项。 */
function readOptions(value: unknown, fieldName: string): readonly PluginSettingOption[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalidDefinition(`${fieldName} must contain at least one option.`);
  }
  const options = value.map((option, index): PluginSettingOption => {
    if (!isRecord(option)) invalidDefinition(`${fieldName}[${index}] must be an object.`);
    return {
      label: readRequiredString(option.label, `${fieldName}[${index}].label`),
      value: readRequiredString(option.value, `${fieldName}[${index}].value`)
    };
  });
  if (new Set(options.map(option => option.value)).size !== options.length) {
    invalidDefinition(`${fieldName} contains duplicate option values.`);
  }
  return options;
}

/** 读取单个声明式设置字段并收窄为公开 SDK 类型。 */
function readField(
  value: unknown,
  pluginId: string,
  fieldName: string
): PluginSettingField {
  if (!isRecord(value)) invalidDefinition(`${fieldName} must be an object.`);
  const base = readFieldBase(value, pluginId, fieldName);

  switch (value.type) {
    case 'text': {
      const defaultValue = readOptionalString(value.defaultValue, `${fieldName}.defaultValue`);
      const placeholder = readOptionalString(value.placeholder, `${fieldName}.placeholder`);
      return {
        ...base,
        type: 'text',
        ...(defaultValue !== undefined ? { defaultValue } : {}),
        ...(placeholder !== undefined ? { placeholder } : {})
      };
    }
    case 'number': {
      if (base.validate?.length) {
        invalidDefinition(`${fieldName}.validate is only supported for string-valued fields.`);
      }
      const readNumber = (input: unknown, name: string): number | undefined => {
        if (input === undefined) return undefined;
        if (typeof input !== 'number' || !Number.isFinite(input)) {
          invalidDefinition(`${name} must be a finite number.`);
        }
        return input;
      };
      const defaultValue = readNumber(value.defaultValue, `${fieldName}.defaultValue`);
      const min = readNumber(value.min, `${fieldName}.min`);
      const max = readNumber(value.max, `${fieldName}.max`);
      const step = readNumber(value.step, `${fieldName}.step`);
      if (min !== undefined && max !== undefined && min > max) {
        invalidDefinition(`${fieldName}.min must be less than or equal to max.`);
      }
      if (step !== undefined && step <= 0) invalidDefinition(`${fieldName}.step must be positive.`);
      if (defaultValue !== undefined && min !== undefined && defaultValue < min) {
        invalidDefinition(`${fieldName}.defaultValue must be greater than or equal to min.`);
      }
      if (defaultValue !== undefined && max !== undefined && defaultValue > max) {
        invalidDefinition(`${fieldName}.defaultValue must be less than or equal to max.`);
      }
      return {
        ...base,
        type: 'number',
        ...(defaultValue !== undefined ? { defaultValue } : {}),
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(step !== undefined ? { step } : {})
      };
    }
    case 'boolean': {
      if (base.validate?.length) {
        invalidDefinition(`${fieldName}.validate is only supported for string-valued fields.`);
      }
      if (value.defaultValue !== undefined && typeof value.defaultValue !== 'boolean') {
        invalidDefinition(`${fieldName}.defaultValue must be a boolean.`);
      }
      return {
        ...base,
        type: 'boolean',
        ...(typeof value.defaultValue === 'boolean' ? { defaultValue: value.defaultValue } : {})
      };
    }
    case 'select': {
      const options = readOptions(value.options, `${fieldName}.options`);
      const defaultValue = readOptionalString(value.defaultValue, `${fieldName}.defaultValue`);
      if (defaultValue !== undefined && !options.some(option => option.value === defaultValue)) {
        invalidDefinition(`${fieldName}.defaultValue must match a declared option.`);
      }
      return {
        ...base,
        type: 'select',
        options,
        ...(defaultValue !== undefined ? { defaultValue } : {})
      };
    }
    case 'file': {
      if (base.validate?.length) {
        invalidDefinition(`${fieldName}.validate is only supported for string-valued fields.`);
      }
      const defaultValue = readOptionalWorkspacePath(value.defaultValue, `${fieldName}.defaultValue`);
      let extensions: readonly string[] | undefined;
      if (value.extensions !== undefined) {
        if (!Array.isArray(value.extensions) || value.extensions.length === 0) {
          invalidDefinition(`${fieldName}.extensions must be a non-empty array.`);
        }
        extensions = value.extensions.map((extension, index) => {
          const normalized = readRequiredString(extension, `${fieldName}.extensions[${index}]`)
            .trim()
            .toLowerCase();
          if (!/^\.[a-z0-9][a-z0-9._-]*$/u.test(normalized)) {
            invalidDefinition(`${fieldName}.extensions[${index}] must start with a file extension dot.`);
          }
          return normalized;
        });
        if (new Set(extensions).size !== extensions.length) {
          invalidDefinition(`${fieldName}.extensions contains duplicate values.`);
        }
      }
      if (
        defaultValue !== undefined
        && extensions !== undefined
        && !extensions.some(extension => defaultValue.toLowerCase().endsWith(extension))
      ) {
        invalidDefinition(`${fieldName}.defaultValue must match a declared extension.`);
      }
      return {
        ...base,
        type: 'file',
        ...(defaultValue !== undefined ? { defaultValue } : {}),
        ...(extensions !== undefined ? { extensions } : {})
      };
    }
    case 'folder': {
      if (base.validate?.length) {
        invalidDefinition(`${fieldName}.validate is only supported for string-valued fields.`);
      }
      const defaultValue = readOptionalWorkspacePath(value.defaultValue, `${fieldName}.defaultValue`);
      return {
        ...base,
        type: 'folder',
        ...(defaultValue !== undefined ? { defaultValue } : {})
      };
    }
    default:
      return invalidDefinition(`${fieldName}.type is unsupported.`);
  }
}

/** 读取一个设置字段分组。 */
function readGroup(
  value: Record<string, unknown>,
  pluginId: string,
  fieldName: string
): PluginSettingGroup {
  if (!Array.isArray(value.items)) invalidDefinition(`${fieldName}.items must be an array.`);
  const group: PluginSettingGroup = {
    type: 'group',
    id: readNamespacedId(value.id, pluginId, `${fieldName}.id`),
    title: readRequiredString(value.title, `${fieldName}.title`),
    items: value.items.map((item, index) => readField(item, pluginId, `${fieldName}.items[${index}]`))
  };
  const description = readOptionalString(value.description, `${fieldName}.description`);
  const visible = readCondition(value.visible, pluginId, `${fieldName}.visible`);
  const disabled = readCondition(value.disabled, pluginId, `${fieldName}.disabled`);
  if (description !== undefined) group.description = description;
  if (visible !== undefined) group.visible = visible;
  if (disabled !== undefined) group.disabled = disabled;
  return group;
}

/** 读取只读状态行，禁止传入函数或宿主对象。 */
function readStatusRow(
  value: Record<string, unknown>,
  pluginId: string,
  fieldName: string
): PluginSettingStatusRow {
  const row: PluginSettingStatusRow = {
    type: 'status',
    id: readNamespacedId(value.id, pluginId, `${fieldName}.id`),
    label: readRequiredString(value.label, `${fieldName}.label`)
  };
  const description = readOptionalString(value.description, `${fieldName}.description`);
  const statusValue = readOptionalString(value.value, `${fieldName}.value`);
  const visible = readCondition(value.visible, pluginId, `${fieldName}.visible`);
  if (description !== undefined) row.description = description;
  if (statusValue !== undefined) row.value = statusValue;
  if (visible !== undefined) row.visible = visible;
  return row;
}

/** 读取可递归嵌套的设置子页面。 */
function readSubPage(
  value: Record<string, unknown>,
  pluginId: string,
  fieldName: string
): PluginSettingPage {
  if (!Array.isArray(value.items)) invalidDefinition(`${fieldName}.items must be an array.`);
  const page: PluginSettingPage = {
    type: 'page',
    id: readNamespacedId(value.id, pluginId, `${fieldName}.id`),
    title: readRequiredString(value.title, `${fieldName}.title`),
    items: value.items.map((item, index) => (
      readDefinition(item, pluginId, `${fieldName}.items[${index}]`)
    ))
  };
  const description = readOptionalString(value.description, `${fieldName}.description`);
  const visible = readCondition(value.visible, pluginId, `${fieldName}.visible`);
  const disabled = readCondition(value.disabled, pluginId, `${fieldName}.disabled`);
  if (description !== undefined) page.description = description;
  if (visible !== undefined) page.visible = visible;
  if (disabled !== undefined) page.disabled = disabled;
  return page;
}

/** 读取定义树中的任意安全声明式节点。 */
function readDefinition(
  value: unknown,
  pluginId: string,
  fieldName: string
): PluginSettingDefinition {
  if (!isRecord(value)) invalidDefinition(`${fieldName} must be an object.`);
  if (value.type === 'group') return readGroup(value, pluginId, fieldName);
  if (value.type === 'page') return readSubPage(value, pluginId, fieldName);
  if (value.type === 'status') return readStatusRow(value, pluginId, fieldName);
  return readField(value, pluginId, fieldName);
}

/** 返回设置页定义树中的全部字段。 */
export function flattenPluginSettingDefinitions(
  definitions: readonly PluginSettingDefinition[]
): readonly PluginSettingField[] {
  return definitions.flatMap(definition => {
    if (definition.type === 'group') return definition.items;
    if (definition.type === 'page') return flattenPluginSettingDefinitions(definition.items);
    return definition.type === 'status' ? [] : [definition];
  });
}

/** 返回贡献中供宿主渲染的定义，兼容旧版扁平 fields。 */
export function resolvePluginSettingDefinitions(
  setting: PluginSettingContribution
): readonly PluginSettingDefinition[] {
  return setting.definitions ?? setting.fields ?? [];
}

/** 校验并复制插件运行时返回的可序列化设置页定义。 */
export function parsePluginSettingPageDefinition(
  value: unknown,
  pluginId: string
): PluginSettingPageDefinition {
  if (!isRecord(value)) invalidDefinition('Settings page definition must be an object.');
  const page: PluginSettingPageDefinition = {
    id: readNamespacedId(value.id, pluginId, 'page.id')
  };
  const title = readOptionalString(value.title, 'page.title');
  const description = readOptionalString(value.description, 'page.description');
  if (title !== undefined && title.trim().length === 0) invalidDefinition('page.title must not be empty.');
  if (title !== undefined) page.title = title;
  if (description !== undefined) page.description = description;

  if (value.definitions === undefined) return page;
  if (!Array.isArray(value.definitions)) invalidDefinition('page.definitions must be an array.');
  const definitions = value.definitions.map((definition, index): PluginSettingDefinition => (
    readDefinition(definition, pluginId, `page.definitions[${index}]`)
  ));
  const fields = flattenPluginSettingDefinitions(definitions);
  const collectIds = (items: readonly PluginSettingDefinition[]): string[] => items.flatMap(item => {
    if (item.type === 'group') return [item.id, ...item.items.map(field => field.id)];
    if (item.type === 'page') return [item.id, ...collectIds(item.items)];
    return [item.id];
  });
  const allIds = [page.id, ...collectIds(definitions)];
  if (new Set(allIds).size !== allIds.length) {
    invalidDefinition('Settings page definitions contain duplicate ids.');
  }
  const fieldIds = new Set(fields.map(field => field.id));
  const collectConditions = (items: readonly PluginSettingDefinition[]): readonly (PluginSettingCondition | undefined)[] => items.flatMap(item => {
    if (item.type === 'group') {
      return [item.visible, item.disabled, ...item.items.flatMap(field => [field.visible, field.disabled])];
    }
    if (item.type === 'page') return [item.visible, item.disabled, ...collectConditions(item.items)];
    return [item.visible, ...(item.type === 'status' ? [] : [item.disabled])];
  });
  const conditions = collectConditions(definitions);
  for (const condition of conditions) {
    if (typeof condition === 'object' && !fieldIds.has(condition.fieldId)) {
      invalidDefinition(`Condition field ${condition.fieldId} is not declared in the same settings page.`);
    }
  }
  page.definitions = definitions;
  return page;
}

/** 返回设置字段的显式默认值或稳定类型默认值。 */
export function getPluginSettingDefaultValue(field: PluginSettingField): PluginSettingValue {
  if (field.defaultValue !== undefined) return field.defaultValue;
  switch (field.type) {
    case 'text':
      return '';
    case 'number':
      return field.min ?? 0;
    case 'boolean':
      return false;
    case 'select':
      return field.options[0]?.value ?? '';
    case 'file':
    case 'folder':
      return '';
  }
}

/** 将输入控件的宽类型值收窄为字段允许的设置值。 */
export function coercePluginSettingInput(
  field: PluginSettingField,
  value: unknown
): PluginSettingValue | undefined {
  switch (field.type) {
    case 'text':
    case 'select':
    case 'file':
    case 'folder':
      return typeof value === 'string' ? value : undefined;
    case 'number': {
      if (value === '' || value === null || value === undefined) return undefined;
      const parsedValue = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(parsedValue) ? parsedValue : undefined;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
  }
}

/** 校验字段值的类型、范围、选项和声明式规则。 */
export function validatePluginSettingValue(
  field: PluginSettingField,
  value: PluginSettingValue
): PluginSettingValidationFailure | undefined {
  if (field.type === 'text' && typeof value !== 'string') {
    return { code: 'PLUGIN_SETTING_VALUE_TYPE_INVALID', message: '请输入有效文本。' };
  }
  if (
    (field.type === 'file' || field.type === 'folder')
    && (
      typeof value !== 'string'
      || value.length === 0
      || value.startsWith('/')
      || /^[A-Za-z]:\//u.test(value)
      || value.split('/').some(segment => segment === '..' || segment.length === 0)
    )
  ) {
    return { code: 'PLUGIN_SETTING_VALUE_TYPE_INVALID', message: '请选择工作区内的有效路径。' };
  }
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { code: 'PLUGIN_SETTING_VALUE_TYPE_INVALID', message: '请输入有效数字。' };
    }
    if (field.min !== undefined && value < field.min) {
      return { code: 'PLUGIN_SETTING_VALUE_OUT_OF_RANGE', message: `数值不能小于 ${field.min}。` };
    }
    if (field.max !== undefined && value > field.max) {
      return { code: 'PLUGIN_SETTING_VALUE_OUT_OF_RANGE', message: `数值不能大于 ${field.max}。` };
    }
  }
  if (field.type === 'boolean' && typeof value !== 'boolean') {
    return { code: 'PLUGIN_SETTING_VALUE_TYPE_INVALID', message: '请输入有效开关值。' };
  }
  if (field.type === 'select') {
    if (typeof value !== 'string') {
      return { code: 'PLUGIN_SETTING_VALUE_TYPE_INVALID', message: '请选择有效选项。' };
    }
    if (!field.options.some(option => option.value === value)) {
      return { code: 'PLUGIN_SETTING_VALUE_INVALID_OPTION', message: '所选项目不在可用选项中。' };
    }
  }

  if (typeof value !== 'string') return undefined;
  for (const rule of field.validate ?? []) {
    const failed = rule.type === 'required'
      ? value.trim().length === 0
      : rule.type === 'minLength'
        ? value.length < rule.value
        : rule.type === 'maxLength'
          ? value.length > rule.value
          : !new RegExp(rule.value, rule.flags).test(value);
    if (failed) return { code: 'PLUGIN_SETTING_VALIDATION_FAILED', message: rule.message };
  }
  return undefined;
}

/** 根据当前同页设置值计算声明式条件。 */
export function evaluatePluginSettingCondition(
  condition: PluginSettingCondition | undefined,
  values: Readonly<Record<string, PluginSettingValue>>,
  defaultValue: boolean
): boolean {
  if (condition === undefined) return defaultValue;
  if (typeof condition === 'boolean') return condition;
  const matches = Object.is(values[condition.fieldId], condition.value);
  return condition.operator === 'equals' ? matches : !matches;
}
