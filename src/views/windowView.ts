/** 文件说明：按窗口模式共享首屏模块加载，启动预加载与根壳复用同一请求。 */
import { getWindowMode } from '@/utils/windowMode';

/** 只加载当前窗口需要的页面，不在设置窗口下载整个工作台。 */
export function loadWindowView() {
  return getWindowMode() === 'blank'
    ? import('./WindowHostView.vue')
    : import('./WorkbenchView.vue');
}
