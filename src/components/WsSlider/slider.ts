/**
 * 文件说明：创建可供 CodeMirror Widget 等原生场景复用的全局范围滑块。
 */

/** 基础滑块创建参数。 */
export interface SliderOptions {
  /** 当前滑块值。 */
  readonly value: number;
  /** 滑块最小值。 */
  readonly min: number;
  /** 滑块最大值。 */
  readonly max: number;
  /** 滑块步进值。 */
  readonly step: number;
  /** 滑块可见提示与无障碍名称。 */
  readonly label: string;
  /** 调用方自定义的滑块样式类名。 */
  readonly className?: string | readonly string[];
  /** 滑块值发生变化时的回调。 */
  readonly onValueChange?: (value: number) => void;
}

/**
 * 将调用方传入的单个或多个 class 名称规范化为数组。
 */
function normalizeSliderClassNames(
  className: SliderOptions['className']
): readonly string[] {
  if (typeof className !== 'string') {
    return className ?? [];
  }

  return className.length > 0
    ? className.split(/\s+/u).filter(Boolean)
    : [];
}

/**
 * 将滑块值限制在定义的范围内，并同步进度样式。
 */
export function setSliderValue(
  slider: HTMLInputElement,
  value: number
): void {
  const min = Number(slider.min);
  const max = Number(slider.max);
  const normalizedValue = Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : min;
  const range = max - min;
  const progress = range > 0
    ? ((normalizedValue - min) / range) * 100
    : 0;

  slider.value = String(normalizedValue);
  slider.style.setProperty('--ws-slider-progress', `${progress}%`);
}

/**
 * 创建带统一语义、键盘操作和进度样式的原生范围滑块。
 */
export function createSlider(
  options: SliderOptions
): HTMLInputElement {
  const slider = document.createElement('input');

  slider.type = 'range';
  slider.className = [
    'ws-slider',
    ...normalizeSliderClassNames(options.className)
  ].join(' ');
  slider.min = String(options.min);
  slider.max = String(options.max);
  slider.step = String(options.step);
  slider.setAttribute('aria-label', options.label);
  /**
   * 阻止范围滑块的指针事件冒泡到 CodeMirror 或其他宿主容器，
   * 但保留浏览器原生 range 控件的默认拖动行为。
   */
  const stopSliderEventPropagation = (event: Event): void => {
    event.stopPropagation();
  };
  slider.addEventListener('mousedown', stopSliderEventPropagation);
  slider.addEventListener('pointerdown', stopSliderEventPropagation);
  slider.addEventListener('click', stopSliderEventPropagation);
  slider.addEventListener('input', () => {
    const value = Number(slider.value);
    setSliderValue(slider, value);
    options.onValueChange?.(value);
  });

  setSliderValue(slider, options.value);
  return slider;
}
