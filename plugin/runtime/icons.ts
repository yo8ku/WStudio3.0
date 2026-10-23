/**
 * 文件说明：维护宿主公开 SVG 图标注册表，并为普通插件提供 Obsidian 风格 setIcon DOM 能力。
 */

import type { IconsApi } from '../sdk/types';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const ICON_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const iconTemplates = new Map<string, SVGSVGElement>();
type PluginIconLoader = () => Promise<unknown>;
const iconSources = new Map<string, string>();
const iconLoaders = new Map<string, PluginIconLoader>();
const iconLoadPromises = new Map<string, Promise<SVGSVGElement>>();

/** 创建带稳定错误码的公开图标错误。 */
function createIconError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: code, code });
}

/** 将宿主 SVG 文件名转换为公开 kebab-case 图标名称。 */
export function toPluginIconName(fileName: string): string {
  return fileName
    .replace(/\.svg$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

/** 校验并解析宿主 SVG 源码，避免把非 SVG 节点加入公共注册表。 */
function parseSvg(markup: string, iconName: string): SVGSVGElement {
  const documentNode = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = documentNode.documentElement;
  if (root.namespaceURI !== SVG_NAMESPACE || root.localName !== 'svg') {
    throw createIconError('PLUGIN_ICON_SOURCE_INVALID', `Host icon "${iconName}" is not a valid SVG.`);
  }
  root.classList.add('wstudio-plugin-icon');
  root.setAttribute('aria-hidden', 'true');
  root.setAttribute('focusable', 'false');
  root.setAttribute('data-wstudio-icon', iconName);
  return root as unknown as SVGSVGElement;
}

/** 注册一个宿主 SVG；同名图标拒绝覆盖，保证名称解析稳定。 */
export function registerPluginIcon(iconName: string, markup: string): void {
  if (!ICON_NAME_PATTERN.test(iconName)) {
    throw createIconError('PLUGIN_ICON_NAME_INVALID', 'Host icon names must use kebab-case.');
  }
  if (iconTemplates.has(iconName) || iconSources.has(iconName) || iconLoaders.has(iconName)) {
    throw createIconError('PLUGIN_ICON_ALREADY_REGISTERED', `Host icon "${iconName}" is already registered.`);
  }
  iconTemplates.set(iconName, parseSvg(markup, iconName));
}

/** 注册已经由构建工具内联的 SVG 源码，不触发单独的资源请求。 */
export function registerPluginIconSources(
  sources: Readonly<Record<string, string>>
): void {
  for (const [path, markup] of Object.entries(sources)) {
    const fileName = path.split('/').pop() ?? '';
    const iconName = toPluginIconName(fileName);
    if (!ICON_NAME_PATTERN.test(iconName)) {
      throw createIconError('PLUGIN_ICON_NAME_INVALID', 'Host icon names must use kebab-case.');
    }
    if (iconTemplates.has(iconName) || iconSources.has(iconName) || iconLoaders.has(iconName)) {
      throw createIconError('PLUGIN_ICON_ALREADY_REGISTERED', `Host icon "${iconName}" is already registered.`);
    }
    iconSources.set(iconName, markup);
  }
}

/** 注册宿主 SVG 的延迟加载器，只建立名称索引，不读取 SVG 原文。 */
export function registerPluginIconLoaders(
  loaders: Readonly<Record<string, PluginIconLoader>>
): void {
  for (const [path, loader] of Object.entries(loaders)) {
    const fileName = path.split('/').pop() ?? '';
    const iconName = toPluginIconName(fileName);
    if (!ICON_NAME_PATTERN.test(iconName)) {
      throw createIconError('PLUGIN_ICON_NAME_INVALID', 'Host icon names must use kebab-case.');
    }
    if (iconTemplates.has(iconName) || iconSources.has(iconName) || iconLoaders.has(iconName)) {
      throw createIconError('PLUGIN_ICON_ALREADY_REGISTERED', `Host icon "${iconName}" is already registered.`);
    }
    iconLoaders.set(iconName, loader);
  }
}

/** 批量注册 Renderer 构建提供的宿主 SVG 模块。 */
export function registerPluginIconModules(modules: Readonly<Record<string, string>>): void {
  for (const [path, markup] of Object.entries(modules)) {
    const fileName = path.split('/').pop() ?? '';
    registerPluginIcon(toPluginIconName(fileName), markup);
  }
}

/** 从 Vite 动态模块结果中提取原始 SVG 字符串。 */
function resolveIconMarkup(moduleValue: unknown, iconName: string): string {
  if (typeof moduleValue === 'string') {
    return moduleValue;
  }

  if (
    typeof moduleValue === 'object'
    && moduleValue !== null
    && 'default' in moduleValue
    && typeof moduleValue.default === 'string'
  ) {
    return moduleValue.default;
  }

  throw createIconError('PLUGIN_ICON_SOURCE_INVALID', `Host icon "${iconName}" did not provide SVG source.`);
}

/** 按需加载并缓存单个宿主 SVG。 */
function loadPluginIconTemplate(iconName: string): Promise<SVGSVGElement> {
  const cachedTemplate = iconTemplates.get(iconName);
  if (cachedTemplate) {
    return Promise.resolve(cachedTemplate);
  }

  const pendingLoad = iconLoadPromises.get(iconName);
  if (pendingLoad) {
    return pendingLoad;
  }

  const source = iconSources.get(iconName);
  const loader = iconLoaders.get(iconName);
  if (source === undefined && !loader) {
    return Promise.reject(createIconError('PLUGIN_ICON_NOT_FOUND', `Host icon "${iconName}" is not registered.`));
  }

  const loadPromise = Promise.resolve()
    .then(() => source ?? loader?.())
    .then(moduleValue => parseSvg(resolveIconMarkup(moduleValue, iconName), iconName))
    .then(template => {
      iconTemplates.set(iconName, template);
      iconSources.delete(iconName);
      iconLoaders.delete(iconName);
      iconLoadPromises.delete(iconName);
      return template;
    })
    .catch(error => {
      iconLoadPromises.delete(iconName);
      if (error instanceof Error && 'code' in error) {
        throw error;
      }
      throw createIconError('PLUGIN_ICON_LOAD_FAILED', `Failed to load host icon "${iconName}".`);
    });

  iconLoadPromises.set(iconName, loadPromise);
  return loadPromise;
}

/** 将已解析模板复制到首次调用时创建的占位 SVG，保持同步 API 句柄稳定。 */
function applySvgTemplate(template: SVGSVGElement, target: SVGSVGElement): void {
  for (const attribute of Array.from(template.attributes)) {
    target.setAttribute(attribute.name, attribute.value);
  }
  target.replaceChildren(
    ...Array.from(template.childNodes).map(node => document.importNode(node, true))
  );
}

/** 创建按需加载期间使用的同步 SVG 占位节点。 */
function createIconPlaceholder(iconName: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.classList.add('wstudio-plugin-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('data-wstudio-icon', iconName);
  return svg;
}

/** 创建所有插件共享、只暴露稳定名称和真实 SVG DOM 的公开图标 API。 */
export function createIconsApi(): IconsApi {
  return {
    hasIcon: iconName => typeof iconName === 'string'
      && ICON_NAME_PATTERN.test(iconName)
      && (iconTemplates.has(iconName) || iconSources.has(iconName) || iconLoaders.has(iconName)),
    setIcon: (element, iconName) => {
      if (!(element instanceof Element)) {
        throw createIconError('PLUGIN_ICON_TARGET_INVALID', 'setIcon requires a DOM Element target.');
      }
      if (typeof iconName !== 'string' || !ICON_NAME_PATTERN.test(iconName)) {
        throw createIconError('PLUGIN_ICON_NAME_INVALID', 'Icon names must use kebab-case.');
      }
      const template = iconTemplates.get(iconName);
      if (template) {
        const svg = document.importNode(template, true);
        element.replaceChildren(svg);
        return svg;
      }

      const source = iconSources.get(iconName);
      if (source !== undefined) {
        const parsedTemplate = parseSvg(source, iconName);
        iconTemplates.set(iconName, parsedTemplate);
        iconSources.delete(iconName);
        const svg = document.importNode(parsedTemplate, true);
        element.replaceChildren(svg);
        return svg;
      }

      if (!iconLoaders.has(iconName)) {
        throw createIconError('PLUGIN_ICON_NOT_FOUND', `Host icon "${iconName}" is not registered.`);
      }

      const svg = createIconPlaceholder(iconName);
      element.replaceChildren(svg);
      void loadPluginIconTemplate(iconName)
        .then(loadedTemplate => applySvgTemplate(loadedTemplate, svg))
        .catch(error => {
          const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'PLUGIN_ICON_LOAD_FAILED';
          svg.setAttribute('data-wstudio-icon-error', code);
        });
      return svg;
    }
  };
}

/** 仅供测试和 Renderer 销毁时清空公共图标注册表。 */
export function clearPluginIcons(): void {
  iconTemplates.clear();
  iconSources.clear();
  iconLoaders.clear();
  iconLoadPromises.clear();
}
