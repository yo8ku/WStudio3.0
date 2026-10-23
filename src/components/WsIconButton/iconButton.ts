/**
 * 文件说明：创建可供 CodeMirror Widget 等原生场景复用的全局 Vuetify 图标按钮 DOM。
 */

/** 基础图标按钮创建参数。 */
export interface IconButtonOptions {
  /** 按钮内部的字体图标 class；传入 HTML markup 时保留旧 SVG 兼容。 */
  readonly iconMarkup: string;
  /** 按钮的无障碍名称。 */
  readonly label: string;
  /** 调用方自定义的按钮样式类名。 */
  readonly className?: string | readonly string[];
  /** 调用方自定义的图标容器样式类名。 */
  readonly iconClassName?: string | readonly string[];
  /** 可选的按下状态。 */
  readonly pressed?: boolean;
  /** 可选的视觉激活状态。 */
  readonly active?: boolean;
}

/** 通用图标按钮的默认 Vuetify 视觉配置，Vue 与原生 Widget 共用。 */
export const iconButtonDefaultProps = {
  density: 'comfortable',
  ripple: false,
  size: 'small',
  variant: 'text'
} as const;

const iconButtonDefaultClasses = [
  `v-btn--density-${iconButtonDefaultProps.density}`,
  `v-btn--size-${iconButtonDefaultProps.size}`,
  `v-btn--variant-${iconButtonDefaultProps.variant}`
] as const;

export const iconButtonBaseClasses = [
  'v-btn',
  'v-btn--icon',
  ...iconButtonDefaultClasses,
  'ws-icon-button'
] as const;

/**
 * 将调用方传入的单个或多个 class 名称规范化为数组。
 */
function normalizeIconButtonClassNames(
  className: IconButtonOptions['className']
): readonly string[] {
  if (typeof className !== 'string') {
    return className ?? [];
  }

  return className.length > 0
    ? className.split(/\s+/u).filter(Boolean)
    : [];
}

/**
 * 创建带 Vuetify 图标按钮内部结构的原生 button。
 *
 * 基础函数只提供按钮结构、图标和无障碍属性，尺寸、位置、
 * 颜色、变体与交互状态由调用方通过 className 自行决定。
 */
export function createIconButton(
  options: IconButtonOptions
): HTMLButtonElement {
  const button = document.createElement('button');
  const overlay = document.createElement('span');
  const underlay = document.createElement('span');
  const content = document.createElement('span');
  const icon = document.createElement('span');

  button.className = [
    ...iconButtonBaseClasses,
    ...(options.active ? ['v-btn--active', 'ws-icon-button--active'] : []),
    ...normalizeIconButtonClassNames(options.className)
  ].join(' ');
  button.type = 'button';
  button.setAttribute('aria-label', options.label);

  if (options.pressed !== undefined) {
    button.setAttribute('aria-pressed', String(options.pressed));
  }

  overlay.className = 'v-btn__overlay';
  underlay.className = 'v-btn__underlay';
  content.className = 'v-btn__content';
  icon.className = [
    'ws-icon-button__icon',
    ...normalizeIconButtonClassNames(options.iconClassName)
  ].join(' ');
  if (options.iconMarkup.trimStart().startsWith('<')) {
    icon.innerHTML = options.iconMarkup;
  } else {
    icon.className += ` ${options.iconMarkup}`;
  }
  icon.setAttribute('aria-hidden', 'true');

  content.append(icon);
  button.append(overlay, underlay, content);

  return button;
}
