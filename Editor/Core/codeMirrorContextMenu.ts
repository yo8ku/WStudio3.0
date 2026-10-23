/**
 * 文件说明：定义 CodeMirror 编辑器右键菜单的分层结构与动作标识，避免模板中散落硬编码菜单项。
 */

/**
 * 右键菜单中所有可执行动作的唯一标识。 */
export type CodeMirrorContextMenuActionId =
  | 'insert-link'
  | 'insert-external-link'
  | 'insert-image'
  | 'paragraph-unordered-list'
  | 'paragraph-ordered-list'
  | 'paragraph-task-list'
  | 'paragraph-heading-1'
  | 'paragraph-heading-2'
  | 'paragraph-heading-3'
  | 'paragraph-heading-4'
  | 'paragraph-heading-5'
  | 'paragraph-heading-6'
  | 'paragraph-body'
  | 'paragraph-quote'
  | 'insert-inline-code'
  | 'insert-footnote'
  | 'insert-table'
  | 'insert-admonition-note'
  | 'insert-admonition-tip'
  | 'insert-admonition-important'
  | 'insert-admonition-warning'
  | 'insert-admonition-caution'
  | 'insert-divider'
  | 'insert-code-block-menu'
  | 'insert-math-block'
  | 'insert-bold'
  | 'insert-italic'
  | 'insert-strikethrough'
  | 'insert-highlight'
  | 'color'
  | 'local-media'
  | 'clipboard-cut'
  | 'clipboard-copy'
  | 'clipboard-paste'
  | 'selection-select-all';

/**
 * 基础菜单项展示字段。 */
interface CodeMirrorContextMenuBaseItem {
  id: string;
}

/**
 * 可直接执行的动作菜单项。 */
export interface CodeMirrorContextMenuActionItem extends CodeMirrorContextMenuBaseItem {
  kind: 'action';
  label: string;
  actionId: CodeMirrorContextMenuActionId;
}

/**
 * 仅用于视觉分隔的菜单项。 */
export interface CodeMirrorContextMenuDividerItem extends CodeMirrorContextMenuBaseItem {
  kind: 'divider';
}

/**
 * 包含一组二级动作的子菜单项。 */
export interface CodeMirrorContextMenuSubmenuItem extends CodeMirrorContextMenuBaseItem {
  kind: 'submenu';
  label: string;
  children: readonly CodeMirrorContextMenuChildItem[];
}

type CodeMirrorContextMenuChildItem =
  | CodeMirrorContextMenuActionItem
  | CodeMirrorContextMenuDividerItem
  | CodeMirrorContextMenuSubmenuItem;

/**
 * 编辑器右键菜单允许出现的任意菜单项类型。 */
export type CodeMirrorContextMenuItem =
  | CodeMirrorContextMenuActionItem
  | CodeMirrorContextMenuSubmenuItem
  | CodeMirrorContextMenuDividerItem;

/**
 * 统一声明编辑器右键菜单结构。 */
export const codeMirrorContextMenuItems: readonly CodeMirrorContextMenuItem[] = [
  {
    id: 'insert-link',
    kind: 'action',
    label: '新增链接',
    actionId: 'insert-link'
  },
  {
    id: 'insert-external-link',
    kind: 'action',
    label: '新增外部链接',
    actionId: 'insert-external-link'
  },
  {
    id: 'divider-link',
    kind: 'divider'
  },
  {
    id: 'text-format',
    kind: 'submenu',
    label: '文本格式',
    children: [
      {
        id: 'insert-bold',
        kind: 'action',
        label: '加粗',
        actionId: 'insert-bold'
      },
      {
        id: 'insert-italic',
        kind: 'action',
        label: '斜体',
        actionId: 'insert-italic'
      },
      {
        id: 'insert-strikethrough',
        kind: 'action',
        label: '删除线',
        actionId: 'insert-strikethrough'
      },
      {
        id: 'insert-highlight',
        kind: 'action',
        label: '高亮',
        actionId: 'insert-highlight'
      },
      {
        id: 'insert-inline-code',
        kind: 'action',
        label: '代码',
        actionId: 'insert-inline-code'
      }
    ]
  },
  {
    id: 'paragraph-settings',
    kind: 'submenu',
    label: '段落设置',
    children: [
      {
        id: 'paragraph-unordered-list',
        kind: 'action',
        label: '无序列表',
        actionId: 'paragraph-unordered-list'
      },
      {
        id: 'paragraph-ordered-list',
        kind: 'action',
        label: '有序列表',
        actionId: 'paragraph-ordered-list'
      },
      {
        id: 'paragraph-task-list',
        kind: 'action',
        label: '任务列表',
        actionId: 'paragraph-task-list'
      },
      {
        id: 'paragraph-divider-list',
        kind: 'divider'
      },
      {
        id: 'paragraph-heading-1',
        kind: 'action',
        label: '1级标题',
        actionId: 'paragraph-heading-1'
      },
      {
        id: 'paragraph-heading-2',
        kind: 'action',
        label: '2级标题',
        actionId: 'paragraph-heading-2'
      },
      {
        id: 'paragraph-heading-3',
        kind: 'action',
        label: '3级标题',
        actionId: 'paragraph-heading-3'
      },
      {
        id: 'paragraph-heading-4',
        kind: 'action',
        label: '4级标题',
        actionId: 'paragraph-heading-4'
      },
      {
        id: 'paragraph-heading-5',
        kind: 'action',
        label: '5级标题',
        actionId: 'paragraph-heading-5'
      },
      {
        id: 'paragraph-heading-6',
        kind: 'action',
        label: '6级标题',
        actionId: 'paragraph-heading-6'
      },
      {
        id: 'paragraph-body',
        kind: 'action',
        label: '正文',
        actionId: 'paragraph-body'
      },
      {
        id: 'paragraph-divider-quote',
        kind: 'divider'
      },
      {
        id: 'paragraph-quote',
        kind: 'action',
        label: '引用',
        actionId: 'paragraph-quote'
      }
    ]
  },
  {
    id: 'insert-content',
    kind: 'submenu',
    label: '插入',
    children: [
      {
        id: 'insert-footnote',
        kind: 'action',
        label: '脚注',
        actionId: 'insert-footnote'
      },
      {
        id: 'insert-table',
        kind: 'action',
        label: '表格',
        actionId: 'insert-table'
      },
      {
        id: 'insert-admonition',
        kind: 'submenu',
        label: '消息框',
        children: [
          { id: 'insert-admonition-note', kind: 'action', label: '提醒内容', actionId: 'insert-admonition-note' },
          { id: 'insert-admonition-tip', kind: 'action', label: '建议内容', actionId: 'insert-admonition-tip' },
          { id: 'insert-admonition-important', kind: 'action', label: '重要内容', actionId: 'insert-admonition-important' },
          { id: 'insert-admonition-warning', kind: 'action', label: '警告内容', actionId: 'insert-admonition-warning' },
          { id: 'insert-admonition-caution', kind: 'action', label: '注意内容', actionId: 'insert-admonition-caution' }
        ]
      },
      {
        id: 'insert-divider',
        kind: 'action',
        label: '分割线',
        actionId: 'insert-divider'
      },
      {
        id: 'insert-block-divider',
        kind: 'divider'
      },
      {
        id: 'insert-code-block-menu',
        kind: 'action',
        label: '代码块',
        actionId: 'insert-code-block-menu'
      },
      {
        id: 'insert-math-block',
        kind: 'action',
        label: '数学块',
        actionId: 'insert-math-block'
      }
    ]
  },
  {
    id: 'divider-style',
    kind: 'divider'
  },
  {
    id: 'color',
    kind: 'action',
    label: '颜色',
    actionId: 'color'
  },
  {
    id: 'local-media',
    kind: 'action',
    label: '本地媒体',
    actionId: 'local-media'
  },
  {
    id: 'divider-clipboard',
    kind: 'divider'
  },
  {
    id: 'clipboard-cut',
    kind: 'action',
    label: '剪切',
    actionId: 'clipboard-cut'
  },
  {
    id: 'clipboard-copy',
    kind: 'action',
    label: '复制',
    actionId: 'clipboard-copy'
  },
  {
    id: 'clipboard-paste',
    kind: 'action',
    label: '粘贴',
    actionId: 'clipboard-paste'
  },
  {
    id: 'selection-select-all',
    kind: 'action',
    label: '全选',
    actionId: 'selection-select-all'
  }
] as const;
