/**
 * 文件说明：导出插件 manifest Schema 及运行时校验入口。
 */

export { PluginManifestValidationError, validatePluginManifest } from './validateManifest';
export type {
  PluginActivationEvent,
  PluginApiVersion,
  PluginAuthor,
  PluginCommandContribution,
  PluginContributions,
  PluginManifest,
  PluginSidecarManifest,
  PluginPermissionId,
  PluginPermissionRequest,
  PluginSettingBooleanField,
  PluginSettingContribution,
  PluginSettingField,
  PluginSettingFieldBase,
  PluginSettingFieldType,
  PluginSettingFileField,
  PluginSettingFolderField,
  PluginSettingNumberField,
  PluginSettingOption,
  PluginSettingSelectField,
  PluginSettingTextField,
  PluginSettingValue,
  PluginStatusBarContribution,
  PluginViewContribution,
  PluginViewRegion
} from '../sdk';
