/**
 * 文件说明：在运行时校验插件 manifest，并将未知输入收窄为公开 PluginManifest 类型。
 */

import type {
  PluginActivationEvent,
  PluginApiVersion,
  PluginAuthor,
  PluginCommandContribution,
  PluginContributions,
  PluginManifest,
  PluginPermissionId,
  PluginPermissionRequest,
  PluginSettingField,
  PluginSettingFieldBase,
  PluginSettingFieldType,
  PluginSettingBooleanField,
  PluginSettingFileField,
  PluginSettingFolderField,
  PluginSettingNumberField,
  PluginSettingOption,
  PluginSettingSelectField,
  PluginSettingTextField,
  PluginSettingContribution,
  PluginStatusBarContribution,
  PluginViewContribution,
  PluginViewRegion
} from '../sdk';

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const API_VERSION_PATTERN = /^\d+\.\d+$/;
const RELATIVE_PATH_PATTERN = /^(?![\\/])(?:[A-Za-z0-9._-]+[\\/])*[A-Za-z0-9._-]+$/;
const ACTIVATION_EVENT_PATTERN = /^(onStartupFinished|onCommand:[a-z0-9]+(?:[.-][a-z0-9]+)*|onView:[a-z0-9]+(?:[.-][a-z0-9]+)*|onLanguage:[A-Za-z0-9._+-]+|workspaceContains:.+)$/;

const PLUGIN_PERMISSION_IDS = new Set<PluginPermissionId>([
  'workspace.read',
  'workspace.write',
  'workspace.open',
  'window.manage',
  'network.request',
  'clipboard.read',
  'clipboard.write',
  'notifications.show',
  'notifications.system',
  'dialogs.show',
  'external.open',
  'webViewer.navigate',
  'storage.plugin',
  'editor.read',
  'editor.write',
  'renderer.code',
  'node.fs',
  'node.process',
  'node.native',
  'electron.system'
]);

const PLUGIN_VIEW_REGIONS = new Set<PluginViewRegion>([
  'left-sidebar',
  'editor',
  'right-sidebar',
  'bottom'
]);

const PLUGIN_SETTING_FIELD_TYPES = new Set<PluginSettingFieldType>([
  'text',
  'number',
  'boolean',
  'select',
  'file',
  'folder'
]);

/** 描述 manifest 校验失败的来源和字段问题。 */
export class PluginManifestValidationError extends Error {
  constructor(
    message: string,
    public readonly source: string,
    public readonly issues: readonly string[]
  ) {
    super(message);
    this.name = 'PluginManifestValidationError';
  }
}

/** 校验未知输入并返回可供插件管理器使用的 manifest。 */
export function validatePluginManifest(
  input: unknown,
  source = 'plugin manifest'
): PluginManifest {
  const issues: string[] = [];

  if (!isRecord(input)) {
    throw new PluginManifestValidationError(
      `Invalid plugin manifest at "${source}".`,
      source,
      ['Root value must be a plain object.']
    );
  }

  checkUnknownKeys(input, [
    '$schema',
    'id',
    'name',
    'version',
    'description',
    'author',
    'license',
    'homepage',
    'repository',
    'icon',
    'keywords',
    'minAppVersion',
    'apiVersion',
    'main',
    'sidecar',
    'activationEvents',
    'permissions',
    'contributes'
  ], '', issues);

  const id = readPluginId(input.id, 'id', issues);
  const manifest: PluginManifest = {
    id,
    name: readRequiredString(input.name, 'name', issues),
    version: readSemver(input.version, 'version', issues),
    description: readRequiredString(input.description, 'description', issues),
    author: readAuthor(input.author, 'author', issues),
    minAppVersion: readSemver(input.minAppVersion, 'minAppVersion', issues),
    apiVersion: readApiVersion(input.apiVersion, 'apiVersion', issues),
    main: readJavascriptPath(input.main, 'main', issues),
    activationEvents: readActivationEvents(input.activationEvents, 'activationEvents', issues),
    permissions: readPermissions(input.permissions, 'permissions', issues),
    contributes: readContributions(input.contributes, id, 'contributes', issues)
  };

  if (input.sidecar !== undefined && isRecord(input.sidecar)) {
    checkUnknownKeys(input.sidecar, ['type', 'executable', 'args'], 'sidecar', issues);
    if (input.sidecar.type !== 'sidecar') {
      issues.push('Field "sidecar.type" must be "sidecar".');
    }
    const executable = readRequiredString(input.sidecar.executable, 'sidecar.executable', issues);
    const args = input.sidecar.args === undefined
      ? undefined
      : readStringArray(input.sidecar.args, 'sidecar.args', issues);
    if ((args?.length ?? 0) > 32 || args?.some(argument => argument.length > 512)) {
      issues.push('Field "sidecar.args" exceeds its limits.');
    }
    if (executable && (!RELATIVE_PATH_PATTERN.test(executable)
      || executable.replace(/\\/g, '/').split('/').some(segment => segment === '.' || segment === '..'))) {
      issues.push('Field "sidecar.executable" must be a safe relative path.');
    } else if (executable) {
      manifest.sidecar = { type: 'sidecar', executable, ...(args ? { args } : {}) };
    }
  } else if (input.sidecar !== undefined) {
    issues.push('Field "sidecar" must be an object.');
  }

  if (manifest.main !== 'main.js') {
    issues.push('Field "main" must be exactly "main.js".');
  }

  assignOptionalString(manifest, '$schema', input.$schema, issues);
  assignOptionalString(manifest, 'license', input.license, issues);
  assignOptionalUri(manifest, 'homepage', input.homepage, issues);
  assignOptionalUri(manifest, 'repository', input.repository, issues);
  assignOptionalRelativePath(manifest, 'icon', input.icon, issues);
  assignOptionalStringArray(manifest, 'keywords', input.keywords, issues);

  if (issues.length > 0) {
    throw new PluginManifestValidationError(
      `Invalid plugin manifest at "${source}".`,
      source,
      issues
    );
  }

  return manifest;
}

/** 判断值是否为非数组对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 检查对象是否包含当前协议未定义的字段。 */
function checkUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  parentPath: string,
  issues: string[]
): void {
  const allowed = new Set(allowedKeys);

  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push(`Unknown field "${parentPath ? `${parentPath}.` : ''}${key}".`);
    }
  }
}

/** 读取非空字符串字段。 */
function readRequiredString(value: unknown, fieldPath: string, issues: string[]): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`Field "${fieldPath}" must be a non-empty string.`);
    return '';
  }

  return value.trim();
}

/** 读取并校验插件 ID 或命名空间 ID。 */
function readPluginId(value: unknown, fieldPath: string, issues: string[]): string {
  const id = readRequiredString(value, fieldPath, issues);

  if (id && !PLUGIN_ID_PATTERN.test(id)) {
    issues.push(`Field "${fieldPath}" must be a lowercase namespaced identifier.`);
  }

  return id;
}

/** 读取 SemVer 版本号。 */
function readSemver(value: unknown, fieldPath: string, issues: string[]): string {
  const version = readRequiredString(value, fieldPath, issues);

  if (version && !SEMVER_PATTERN.test(version)) {
    issues.push(`Field "${fieldPath}" must be a valid SemVer value.`);
  }

  return version;
}

/** 读取 SDK 主次版本号。 */
function readApiVersion(value: unknown, fieldPath: string, issues: string[]): PluginApiVersion {
  const version = readRequiredString(value, fieldPath, issues);

  if (version !== '1.0' || !API_VERSION_PATTERN.test(version)) {
    issues.push(`Field "${fieldPath}" must be the supported API version "1.0".`);
  }

  return '1.0';
}

/** 读取插件入口 JavaScript 相对路径。 */
function readJavascriptPath(value: unknown, fieldPath: string, issues: string[]): string {
  const filePath = readRequiredString(value, fieldPath, issues);

  if (filePath && (!RELATIVE_PATH_PATTERN.test(filePath) || !filePath.endsWith('.js'))) {
    issues.push(`Field "${fieldPath}" must be a safe relative .js path.`);
  }

  return filePath;
}

/** 读取插件作者信息。 */
function readAuthor(value: unknown, fieldPath: string, issues: string[]): PluginAuthor {
  if (!isRecord(value)) {
    issues.push(`Field "${fieldPath}" must be an object.`);
    return { name: '' };
  }

  checkUnknownKeys(value, ['name', 'url'], fieldPath, issues);
  const author: PluginAuthor = {
    name: readRequiredString(value.name, `${fieldPath}.name`, issues)
  };

  if (value.url !== undefined) {
    const url = readRequiredString(value.url, `${fieldPath}.url`, issues);

    if (url && !isHttpUrl(url)) {
      issues.push(`Field "${fieldPath}.url" must be an http or https URL.`);
    } else if (url) {
      author.url = url;
    }
  }

  return author;
}

/** 读取激活事件列表并检查重复项。 */
function readActivationEvents(
  value: unknown,
  fieldPath: string,
  issues: string[]
): readonly PluginActivationEvent[] {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`Field "${fieldPath}" must contain at least one activation event.`);
    return [];
  }

  const events: PluginActivationEvent[] = [];
  const seen = new Set<string>();

  value.forEach((entry, index) => {
    const eventPath = `${fieldPath}[${index}]`;
    const event = readRequiredString(entry, eventPath, issues);

    if (event && !ACTIVATION_EVENT_PATTERN.test(event)) {
      issues.push(`Field "${eventPath}" is not a supported activation event.`);
    }

    if (event && seen.has(event)) {
      issues.push(`Duplicate activation event "${event}".`);
    }

    if (event) {
      seen.add(event);
      events.push(event as PluginActivationEvent);
    }
  });

  return events;
}

/** 读取权限声明列表并检查权限 ID 和作用域。 */
function readPermissions(
  value: unknown,
  fieldPath: string,
  issues: string[]
): readonly PluginPermissionRequest[] {
  if (!Array.isArray(value)) {
    issues.push(`Field "${fieldPath}" must be an array.`);
    return [];
  }

  const permissions: PluginPermissionRequest[] = [];
  const seen = new Set<PluginPermissionId>();

  value.forEach((entry, index) => {
    const permissionPath = `${fieldPath}[${index}]`;

    if (!isRecord(entry)) {
      issues.push(`Field "${permissionPath}" must be an object.`);
      return;
    }

    checkUnknownKeys(entry, ['id', 'reason', 'scope'], permissionPath, issues);
    const idValue = readRequiredString(entry.id, `${permissionPath}.id`, issues);
    const id = PLUGIN_PERMISSION_IDS.has(idValue as PluginPermissionId)
      ? idValue as PluginPermissionId
      : undefined;

    if (!id) {
      issues.push(`Field "${permissionPath}.id" is not a supported permission.`);
      return;
    }

    if (seen.has(id)) {
      issues.push(`Duplicate permission "${id}".`);
    }

    seen.add(id);
    const permission: PluginPermissionRequest = {
      id,
      reason: readRequiredString(entry.reason, `${permissionPath}.reason`, issues)
    };

    if (entry.scope !== undefined) {
      permission.scope = readStringArray(entry.scope, `${permissionPath}.scope`, issues);
    }

    permissions.push(permission);
  });

  return permissions;
}

/** 读取扩展点声明。 */
function readContributions(
  value: unknown,
  pluginId: string,
  fieldPath: string,
  issues: string[]
): PluginContributions {
  if (!isRecord(value)) {
    issues.push(`Field "${fieldPath}" must be an object.`);
    return { commands: [], views: [], settings: [], statusBar: [] };
  }

  checkUnknownKeys(value, ['commands', 'views', 'settings', 'statusBar'], fieldPath, issues);

  return {
    commands: readCommands(value.commands, pluginId, `${fieldPath}.commands`, issues),
    views: readViews(value.views, pluginId, `${fieldPath}.views`, issues),
    settings: readSettings(value.settings, pluginId, `${fieldPath}.settings`, issues),
    statusBar: readStatusBar(value.statusBar, pluginId, `${fieldPath}.statusBar`, issues)
  };
}

/** 读取命令扩展列表。 */
function readCommands(
  value: unknown,
  pluginId: string,
  fieldPath: string,
  issues: string[]
): readonly PluginCommandContribution[] {
  if (!Array.isArray(value)) {
    issues.push(`Field "${fieldPath}" must be an array.`);
    return [];
  }

  const commands = value.flatMap((entry, index) => {
    const path = `${fieldPath}[${index}]`;

    if (!isRecord(entry)) {
      issues.push(`Field "${path}" must be an object.`);
      return [];
    }

    checkUnknownKeys(entry, ['id', 'title', 'description'], path, issues);
    const id = readNamespacedId(entry.id, `${path}.id`, pluginId, issues);
    const command: PluginCommandContribution = {
      id,
      title: readRequiredString(entry.title, `${path}.title`, issues)
    };

    assignOptionalDescription(command, entry.description, path, issues);
    return [command];
  });

  checkDuplicateValues(commands.map(command => command.id), fieldPath, issues);
  return commands;
}

/** 读取工作台视图扩展列表。 */
function readViews(
  value: unknown,
  pluginId: string,
  fieldPath: string,
  issues: string[]
): readonly PluginViewContribution[] {
  if (!Array.isArray(value)) {
    issues.push(`Field "${fieldPath}" must be an array.`);
    return [];
  }

  const views = value.flatMap((entry, index) => {
    const path = `${fieldPath}[${index}]`;

    if (!isRecord(entry)) {
      issues.push(`Field "${path}" must be an object.`);
      return [];
    }

    checkUnknownKeys(
      entry,
      ['type', 'title', 'region', 'multiple', 'openOnStartup', 'capabilities'],
      path,
      issues
    );
    const type = readNamespacedId(entry.type, `${path}.type`, pluginId, issues);
    const view: PluginViewContribution = {
      type,
      title: readRequiredString(entry.title, `${path}.title`, issues)
    };

    if (entry.region !== undefined) {
      const region = readRequiredString(entry.region, `${path}.region`, issues);

      if (!PLUGIN_VIEW_REGIONS.has(region as PluginViewRegion)) {
        issues.push(`Field "${path}.region" is not a supported view region.`);
      } else {
        view.region = region as PluginViewRegion;
      }
    }

    if (entry.multiple !== undefined) {
      if (typeof entry.multiple !== 'boolean') {
        issues.push(`Field "${path}.multiple" must be a boolean.`);
      } else {
        view.multiple = entry.multiple;
      }
    }

    if (entry.openOnStartup !== undefined) {
      if (typeof entry.openOnStartup !== 'boolean') {
        issues.push(`Field "${path}.openOnStartup" must be a boolean.`);
      } else {
        view.openOnStartup = entry.openOnStartup;
      }
    }

    if (entry.capabilities !== undefined) {
      if (!Array.isArray(entry.capabilities) || entry.capabilities.some(capability => capability !== 'webViewer')) {
        issues.push(`Field "${path}.capabilities" must contain only supported view capabilities.`);
      } else {
        view.capabilities = [...new Set(entry.capabilities)] as readonly 'webViewer'[];
      }
    }

    return [view];
  });

  checkDuplicateValues(views.map(view => view.type), fieldPath, issues);
  return views;
}

/** 读取设置页扩展列表。 */
function readSettings(
  value: unknown,
  pluginId: string,
  fieldPath: string,
  issues: string[]
): readonly PluginSettingContribution[] {
  if (!Array.isArray(value)) {
    issues.push(`Field "${fieldPath}" must be an array.`);
    return [];
  }

  const settings = value.flatMap((entry, index) => {
    const path = `${fieldPath}[${index}]`;

    if (!isRecord(entry)) {
      issues.push(`Field "${path}" must be an object.`);
      return [];
    }

    checkUnknownKeys(entry, ['id', 'title', 'description', 'fields'], path, issues);
    const setting: PluginSettingContribution = {
      id: readNamespacedId(entry.id, `${path}.id`, pluginId, issues),
      title: readRequiredString(entry.title, `${path}.title`, issues)
    };

    assignOptionalDescription(setting, entry.description, path, issues);
    const fields = readSettingFields(entry.fields, pluginId, `${path}.fields`, issues);

    if (fields.length > 0) {
      setting.fields = fields;
    }

    return [setting];
  });

  checkDuplicateValues(settings.map(setting => setting.id), fieldPath, issues);
  return settings;
}

/** 读取设置页的声明式字段，并验证字段类型、默认值和选项。 */
function readSettingFields(
  value: unknown,
  pluginId: string,
  fieldPath: string,
  issues: string[]
): readonly PluginSettingField[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    issues.push(`Field "${fieldPath}" must be an array.`);
    return [];
  }

  const fields = value.flatMap<PluginSettingField>((entry, index): PluginSettingField[] => {
    const path = `${fieldPath}[${index}]`;

    if (!isRecord(entry)) {
      issues.push(`Field "${path}" must be an object.`);
      return [];
    }

    checkUnknownKeys(
      entry,
      ['id', 'label', 'description', 'type', 'defaultValue', 'placeholder', 'min', 'max', 'step', 'options', 'extensions'],
      path,
      issues
    );

    const id = readNamespacedId(entry.id, `${path}.id`, pluginId, issues);
    const label = readRequiredString(entry.label, `${path}.label`, issues);
    const typeValue = readRequiredString(entry.type, `${path}.type`, issues);
    const type = PLUGIN_SETTING_FIELD_TYPES.has(typeValue as PluginSettingFieldType)
      ? typeValue as PluginSettingFieldType
      : 'text';
    const base: PluginSettingFieldBase = { id, label };

    assignOptionalSettingDescription(base, entry.description, path, issues);

    if (type !== 'text' && entry.placeholder !== undefined) {
      issues.push(`Field "${path}.placeholder" is only supported for text fields.`);
    }

    if (type !== 'number' && [entry.min, entry.max, entry.step].some(value => value !== undefined)) {
      issues.push(`Fields "${path}.min", "${path}.max" and "${path}.step" are only supported for number fields.`);
    }

    if (type !== 'select' && entry.options !== undefined) {
      issues.push(`Field "${path}.options" is only supported for select fields.`);
    }

    if (type !== 'file' && entry.extensions !== undefined) {
      issues.push(`Field "${path}.extensions" is only supported for file fields.`);
    }

    switch (type) {
      case 'number': {
        const field: PluginSettingNumberField = { ...base, type };
        const defaultValue = readOptionalFiniteNumber(entry.defaultValue, `${path}.defaultValue`, issues);
        const min = readOptionalFiniteNumber(entry.min, `${path}.min`, issues);
        const max = readOptionalFiniteNumber(entry.max, `${path}.max`, issues);
        const step = readOptionalFiniteNumber(entry.step, `${path}.step`, issues);

        if (defaultValue !== undefined) field.defaultValue = defaultValue;
        if (min !== undefined) field.min = min;
        if (max !== undefined) field.max = max;
        if (step !== undefined) field.step = step;
        if (min !== undefined && max !== undefined && min > max) {
          issues.push(`Field "${path}" must have min less than or equal to max.`);
        }
        if (step !== undefined && step <= 0) {
          issues.push(`Field "${path}.step" must be greater than zero.`);
        }
        if (defaultValue !== undefined && min !== undefined && defaultValue < min) {
          issues.push(`Field "${path}.defaultValue" must be greater than or equal to min.`);
        }
        if (defaultValue !== undefined && max !== undefined && defaultValue > max) {
          issues.push(`Field "${path}.defaultValue" must be less than or equal to max.`);
        }
        return [field];
      }
      case 'boolean': {
        const field: PluginSettingBooleanField = { ...base, type };
        const defaultValue = readOptionalBoolean(entry.defaultValue, `${path}.defaultValue`, issues);

        if (defaultValue !== undefined) field.defaultValue = defaultValue;
        return [field];
      }
      case 'select': {
        const options = readSettingOptions(entry.options, `${path}.options`, issues);
        const field: PluginSettingSelectField = { ...base, type, options };
        const defaultValue = readOptionalString(entry.defaultValue, `${path}.defaultValue`, issues);

        if (defaultValue !== undefined) {
          field.defaultValue = defaultValue;

          if (!options.some(option => option.value === defaultValue)) {
            issues.push(`Field "${path}.defaultValue" must match one of the declared options.`);
          }
        }

        return [field];
      }
      case 'file': {
        const field: PluginSettingFileField = { ...base, type };
        const defaultValue = readOptionalWorkspacePath(entry.defaultValue, `${path}.defaultValue`, issues);
        const extensions = readSettingExtensions(entry.extensions, `${path}.extensions`, issues);
        if (defaultValue !== undefined) field.defaultValue = defaultValue;
        if (extensions !== undefined) field.extensions = extensions;
        if (
          defaultValue !== undefined
          && extensions !== undefined
          && !extensions.some(extension => defaultValue.toLowerCase().endsWith(extension))
        ) {
          issues.push(`Field "${path}.defaultValue" must match one of the declared extensions.`);
        }
        return [field];
      }
      case 'folder': {
        const field: PluginSettingFolderField = { ...base, type };
        const defaultValue = readOptionalWorkspacePath(entry.defaultValue, `${path}.defaultValue`, issues);
        if (defaultValue !== undefined) field.defaultValue = defaultValue;
        return [field];
      }
      case 'text':
      default: {
        const field: PluginSettingTextField = { ...base, type: 'text' };
        const defaultValue = readOptionalTextDefault(entry.defaultValue, `${path}.defaultValue`, issues);
        const placeholder = readOptionalString(entry.placeholder, `${path}.placeholder`, issues);

        if (defaultValue !== undefined) field.defaultValue = defaultValue;
        if (placeholder !== undefined) field.placeholder = placeholder;
        return [field];
      }
    }
  });

  checkDuplicateValues(fields.map(field => field.id), fieldPath, issues);
  return fields;
}

/** 读取选择字段的选项列表。 */
function readSettingOptions(
  value: unknown,
  fieldPath: string,
  issues: string[]
): readonly PluginSettingOption[] {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`Field "${fieldPath}" must contain at least one option.`);
    return [];
  }

  const options = value.flatMap((entry, index) => {
    const path = `${fieldPath}[${index}]`;

    if (!isRecord(entry)) {
      issues.push(`Field "${path}" must be an object.`);
      return [];
    }

    checkUnknownKeys(entry, ['label', 'value'], path, issues);
    return [{
      label: readRequiredString(entry.label, `${path}.label`, issues),
      value: readRequiredString(entry.value, `${path}.value`, issues)
    }];
  });

  checkDuplicateValues(options.map(option => option.value), fieldPath, issues);
  return options;
}

/** 读取可选的有限数字设置字段。 */
function readOptionalFiniteNumber(
  value: unknown,
  fieldPath: string,
  issues: string[]
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(`Field "${fieldPath}" must be a finite number.`);
    return undefined;
  }

  return value;
}

/** 读取可选布尔设置字段。 */
function readOptionalBoolean(
  value: unknown,
  fieldPath: string,
  issues: string[]
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    issues.push(`Field "${fieldPath}" must be a boolean.`);
    return undefined;
  }

  return value;
}

/** 读取可选字符串设置字段。 */
function readOptionalString(
  value: unknown,
  fieldPath: string,
  issues: string[]
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readRequiredString(value, fieldPath, issues) || undefined;
}

/** 读取工作区相对路径设置默认值，拒绝绝对路径和路径穿越。 */
function readOptionalWorkspacePath(
  value: unknown,
  fieldPath: string,
  issues: string[]
): string | undefined {
  const pathValue = readOptionalString(value, fieldPath, issues);
  if (pathValue === undefined) return undefined;
  const normalized = pathValue.replace(/\\/g, '/');
  if (
    !normalized
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized)
    || normalized.split('/').some(segment => segment === '..' || segment.length === 0)
    || !RELATIVE_PATH_PATTERN.test(normalized)
  ) {
    issues.push(`Field "${fieldPath}" must be a safe workspace-relative path.`);
    return undefined;
  }
  return normalized;
}

/** 读取文件选择器扩展名过滤列表。 */
function readSettingExtensions(
  value: unknown,
  fieldPath: string,
  issues: string[]
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`Field "${fieldPath}" must contain at least one extension.`);
    return undefined;
  }
  const extensions = value.flatMap((entry, index) => {
    const extension = readRequiredString(entry, `${fieldPath}[${index}]`, issues).toLowerCase();
    if (extension && !/^\.[a-z0-9][a-z0-9._-]*$/u.test(extension)) {
      issues.push(`Field "${fieldPath}[${index}]" must start with a file extension dot.`);
      return [];
    }
    return extension ? [extension] : [];
  });
  checkDuplicateValues(extensions, fieldPath, issues);
  return extensions;
}

/** 读取允许为空字符串的文本设置默认值。 */
function readOptionalTextDefault(
  value: unknown,
  fieldPath: string,
  issues: string[]
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    issues.push(`Field "${fieldPath}" must be a string.`);
    return undefined;
  }

  return value;
}

/** 将设置字段描述安全写入字段对象。 */
function assignOptionalSettingDescription(
  target: PluginSettingFieldBase,
  value: unknown,
  parentPath: string,
  issues: string[]
): void {
  if (value === undefined) {
    return;
  }

  const description = readRequiredString(value, `${parentPath}.description`, issues);

  if (description) {
    target.description = description;
  }
}

/** 读取状态栏扩展列表。 */
function readStatusBar(
  value: unknown,
  pluginId: string,
  fieldPath: string,
  issues: string[]
): readonly PluginStatusBarContribution[] {
  if (!Array.isArray(value)) {
    issues.push(`Field "${fieldPath}" must be an array.`);
    return [];
  }

  const statusBar = value.flatMap((entry, index) => {
    const path = `${fieldPath}[${index}]`;

    if (!isRecord(entry)) {
      issues.push(`Field "${path}" must be an object.`);
      return [];
    }

    checkUnknownKeys(entry, ['id', 'text', 'tooltip'], path, issues);
    const item: PluginStatusBarContribution = {
      id: readNamespacedId(entry.id, `${path}.id`, pluginId, issues),
      text: readRequiredString(entry.text, `${path}.text`, issues)
    };

    assignOptionalTooltip(item, entry.tooltip, path, issues);
    return [item];
  });

  checkDuplicateValues(statusBar.map(item => item.id), fieldPath, issues);
  return statusBar;
}

/** 读取并校验插件命名空间下的扩展点 ID。 */
function readNamespacedId(
  value: unknown,
  fieldPath: string,
  pluginId: string,
  issues: string[]
): string {
  const id = readPluginId(value, fieldPath, issues);

  if (id && pluginId && !id.startsWith(`${pluginId}.`)) {
    issues.push(`Field "${fieldPath}" must start with plugin id "${pluginId}.".`);
  }

  return id;
}

/** 读取字符串数组。 */
function readStringArray(value: unknown, fieldPath: string, issues: string[]): readonly string[] {
  if (!Array.isArray(value)) {
    issues.push(`Field "${fieldPath}" must be an array.`);
    return [];
  }

  return value.flatMap((entry, index) => {
    const item = readRequiredString(entry, `${fieldPath}[${index}]`, issues);
    return item ? [item] : [];
  });
}

/** 检查同一扩展点列表内的标识符是否重复。 */
function checkDuplicateValues(values: readonly string[], fieldPath: string, issues: string[]): void {
  const seen = new Set<string>();

  values.forEach((value, index) => {
    if (!value) {
      return;
    }

    if (seen.has(value)) {
      issues.push(`Duplicate contribution id "${value}" at "${fieldPath}[${index}]".`);
      return;
    }

    seen.add(value);
  });
}

/** 将可选字符串字段安全写入已构造的 manifest。 */
function assignOptionalString(
  target: PluginManifest,
  key: '$schema' | 'license',
  value: unknown,
  issues: string[]
): void {
  if (value === undefined) {
    return;
  }

  const item = readRequiredString(value, key, issues);

  if (item) {
    target[key] = item;
  }
}

/** 将可选 URL 字段安全写入已构造的 manifest。 */
function assignOptionalUri(
  target: PluginManifest,
  key: 'homepage' | 'repository',
  value: unknown,
  issues: string[]
): void {
  if (value === undefined) {
    return;
  }

  const uri = readRequiredString(value, key, issues);

  if (uri && !isHttpUrl(uri)) {
    issues.push(`Field "${key}" must be an http or https URL.`);
  } else if (uri) {
    target[key] = uri;
  }
}

/** 将可选相对路径字段安全写入已构造的 manifest。 */
function assignOptionalRelativePath(
  target: PluginManifest,
  key: 'icon',
  value: unknown,
  issues: string[]
): void {
  if (value === undefined) {
    return;
  }

  const filePath = readRequiredString(value, key, issues);

  if (filePath && !RELATIVE_PATH_PATTERN.test(filePath)) {
    issues.push(`Field "${key}" must be a safe relative path.`);
  } else if (filePath) {
    target[key] = filePath;
  }
}

/** 将可选字符串数组安全写入已构造的 manifest。 */
function assignOptionalStringArray(
  target: PluginManifest,
  key: 'keywords',
  value: unknown,
  issues: string[]
): void {
  if (value === undefined) {
    return;
  }

  target[key] = readStringArray(value, key, issues);
}

/** 将命令或设置扩展点中的可选描述安全写入目标对象。 */
function assignOptionalDescription(
  target: PluginCommandContribution | PluginSettingContribution,
  value: unknown,
  parentPath: string,
  issues: string[]
): void {
  if (value === undefined) {
    return;
  }

  const item = readRequiredString(value, `${parentPath}.description`, issues);

  if (item) {
    target.description = item;
  }
}

/** 将状态栏扩展点中的可选提示安全写入目标对象。 */
function assignOptionalTooltip(
  target: PluginStatusBarContribution,
  value: unknown,
  parentPath: string,
  issues: string[]
): void {
  if (value === undefined) {
    return;
  }

  const item = readRequiredString(value, `${parentPath}.tooltip`, issues);

  if (item) {
    target.tooltip = item;
  }
}

/** 判断 URL 是否为允许的 HTTP 或 HTTPS 地址。 */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
