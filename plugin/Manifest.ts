/**
 * 文件说明：兼容导出插件 manifest 类型和运行时校验入口。
 */

export { PluginManifestValidationError, validatePluginManifest } from './schema';
export type {
  PluginActivationEvent,
  PluginApiVersion,
  PluginAuthor,
  PluginCommandContribution,
  PluginContributions,
  PluginManifest,
  PluginPermissionId,
  PluginPermissionRequest,
  PluginSettingContribution,
  PluginStatusBarContribution,
  PluginViewContribution,
  PluginViewRegion
} from './sdk';
