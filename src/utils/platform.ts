/** macOS 的窗口装饰和红黄绿按钮由原生宿主管理。 */
export const isMacOS = typeof navigator !== 'undefined' && /^Mac/.test(navigator.platform);
