/** 文件说明：封装 Windows Tauri 原生弹出菜单，使右键菜单位于网页子视图之上。 */
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu';
import { isTauriRuntime } from './native';
import type { WorkbenchContextMenuEntry, WorkbenchContextMenuRequest } from '@/types/ipc';

/** Windows 弹出菜单在关闭后返回；其他平台继续使用工作台 DOM 菜单。 */
export function supportsNativeContextMenu(): boolean {
  return isTauriRuntime() && /Windows/.test(navigator.userAgent);
}

/** 转换分隔线、禁用项及子菜单，动作 ID 继续交给工作台处理。 */
async function menuItems(
  entries: readonly WorkbenchContextMenuEntry[],
  select: (id: string) => void,
  resources: Array<Menu | MenuItem | PredefinedMenuItem | Submenu>,
  sessionId: string
): Promise<Array<MenuItem | PredefinedMenuItem | Submenu>> {
  const items: Array<MenuItem | PredefinedMenuItem | Submenu> = [];
  for (const entry of entries) {
    let created: MenuItem | PredefinedMenuItem | Submenu;
    if (entry.type === 'separator') {
      created = await PredefinedMenuItem.new({ item: 'Separator' });
    } else {
      const item = { id: `${sessionId}:${entry.id}`, text: entry.label.replace(/&/g, '&&'), enabled: entry.enabled ?? true };
      created = entry.children?.length
        ? await Submenu.new({ ...item, items: await menuItems(entry.children, select, resources, sessionId) })
        : await MenuItem.new({ ...item, action: () => select(entry.id) });
    }
    resources.push(created);
    items.push(created);
  }
  return items;
}

/** 原生菜单关闭后返回选项或取消，并释放 Rust 菜单资源。 */
export async function showNativeContextMenu(request: WorkbenchContextMenuRequest): Promise<string | undefined> {
  let selected: string | undefined;
  const resources: Array<Menu | MenuItem | PredefinedMenuItem | Submenu> = [];
  try {
    // 显式保留条目资源，防止内联条目的 Rust 包装提前释放动作 Channel。
    const items = await menuItems(request.items, id => { selected = id; }, resources, crypto.randomUUID());
    const menu = await Menu.new({ items });
    resources.push(menu);
    await menu.popup(new LogicalPosition(request.x, request.y));
    // 条目读取经主线程排队，等待关闭菜单时产生的动作事件完成转发。
    const first = items[0];
    if (first) await first.text();
    return selected;
  } finally {
    await Promise.all(resources.reverse().map(resource => resource.close()));
  }
}
