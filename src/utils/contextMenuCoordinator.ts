/**
 * 文件说明：协调渲染进程中的上下文菜单，保证不同组件实例的菜单互斥显示。
 */

export type ContextMenuOwner = object;

interface ContextMenuRegistration {
  owner: ContextMenuOwner;
  close: () => void;
}

const registrations = new Set<ContextMenuRegistration>();

/** 注册右键菜单或下拉菜单实例，并返回释放函数。 */
export function registerContextMenu(owner: ContextMenuOwner, close: () => void): () => void {
  const registration = { owner, close };
  registrations.add(registration);
  return () => registrations.delete(registration);
}

/** 通知新的右键菜单或下拉菜单即将打开，并关闭其他组件实例的浮层。 */
export function announceContextMenuOpen(owner: ContextMenuOwner): void {
  for (const registration of registrations) {
    if (registration.owner !== owner) registration.close();
  }
}

/** 注册通用浮层实例，语义上兼容原有上下文菜单注册接口。 */
export const registerOverlay = registerContextMenu;

/** 通知新的通用浮层即将打开，关闭其他右键菜单和下拉菜单。 */
export const announceOverlayOpen = announceContextMenuOpen;
