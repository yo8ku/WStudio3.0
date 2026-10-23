/**
 * 文件说明：提供 Markdown 任务列表的复选框装饰、点击切换与源码续行能力。
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view';
import {
  EditorSelection,
  RangeSetBuilder,
  type EditorState,
  type StateCommand
} from '@codemirror/state';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';

const TASK_LIST_PATTERN = /^(\s*)([-+*]|\d+[.)])\s+\[([ xX])\](?=\s|$)/;

/** 按任务源码续行，兼容深缩进；新项取消勾选，围栏代码保持原有换行行为。 */
export const continueTaskListFromSource: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;

  const prefixes = state.selection.ranges.map((range) => {
    if (!range.empty || !markdownLanguage.isActiveAt(state, range.head, -1)) return null;
    const line = state.doc.lineAt(range.head);
    const match = TASK_LIST_PATTERN.exec(line.text);
    if (!match || range.head < line.from + match[0].length
      || line.text.slice(match[0].length).trim().length === 0) return null;

    for (let node = syntaxTree(state).resolveInner(range.head, -1); node; ) {
      if (node.name === 'FencedCode') return null;
      if (!node.parent) break;
      node = node.parent;
    }

    const marker = /^\d+[.)]$/.test(match[2])
      ? `${Number.parseInt(match[2], 10) + 1}${match[2].slice(-1)}`
      : match[2];
    const markerSpacing = match[0].slice(match[1].length + match[2].length, -3);
    const bodySpacing = /^[\t ]*/.exec(line.text.slice(match[0].length))?.[0] || ' ';
    return `${match[1]}${marker}${markerSpacing}[ ]${bodySpacing}`;
  });
  if (prefixes.some((prefix) => prefix === null)) return false;

  const changes = state.changeByRange((range) => {
    const prefix = prefixes[state.selection.ranges.indexOf(range)] ?? '';
    const insert = `\n${prefix}`;
    return {
      changes: { from: range.head, insert },
      range: EditorSelection.cursor(range.head + insert.length)
    };
  });
  dispatch(state.update({ ...changes, scrollIntoView: true, userEvent: 'input' }));
  return true;
};

/**
 * 判断光标是否位于任务列表标记范围内，用于保持 `- [ ]` 源码可编辑。
 */
export function isTaskListSourcePosition(
  state: EditorState,
  lineFrom: number,
  hasFocus: boolean
): boolean {
  if (!hasFocus) {
    return false;
  }

  const line = state.doc.lineAt(lineFrom);
  const match = TASK_LIST_PATTERN.exec(line.text);

  if (!match) {
    return false;
  }

  const markerStart = line.from + match[1].length;
  const checkboxEnd = line.from + match[0].length;

  return state.selection.ranges.some((range) => (
    range.empty
    && range.head >= markerStart
    && range.head <= checkboxEnd
  ));
}

/**
 * 任务列表复选框小部件，负责渲染当前完成状态并响应用户点击。
 */
class TaskListCheckboxWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly from: number,
    private readonly to: number
  ) {
    super();
  }

  /**
   * 创建主题化复选框节点。
   */
  toDOM(view: EditorView): HTMLElement {
    const checkbox = document.createElement('button');
    checkbox.type = 'button';
    checkbox.className = 'cm-markdown-task-list-checkbox';
    checkbox.setAttribute('aria-label', this.checked ? '标记为未完成' : '标记为已完成');
    checkbox.setAttribute('aria-pressed', String(this.checked));
    checkbox.dataset.checked = String(this.checked);
    checkbox.addEventListener('mousedown', (event) => event.preventDefault());
    checkbox.addEventListener('click', () => {
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: this.checked ? '[ ]' : '[x]' },
        userEvent: 'input'
      });
      view.focus();
    });
    return checkbox;
  }

  /**
   * 判断小部件是否可以复用。
   */
  eq(other: TaskListCheckboxWidget): boolean {
    return this.checked === other.checked && this.from === other.from && this.to === other.to;
  }

  /**
   * 允许复选框接收鼠标事件。
   */
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 构建当前可见区域内的任务列表装饰。
 */
function buildTaskListDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  for (const { from, to } of view.visibleRanges) {
    let position = from;

    while (position <= to) {
      const line = view.state.doc.lineAt(position);
      const match = TASK_LIST_PATTERN.exec(line.text);

      if (match) {
        const checkboxEnd = line.from + match[0].length;
        const checkboxStart = checkboxEnd - 3;
        const isChecked = match[3].toLowerCase() === 'x';
        const isEditingSource = isTaskListSourcePosition(view.state, line.from, view.hasFocus);

        if (isEditingSource) {
          builder.add(line.from, line.from, Decoration.line({
            attributes: {
              class: 'cm-markdown-task-list-line--editing-source'
            }
          }));
        } else {
          // 标记隐藏与复选框使用同一行匹配，不依赖深缩进时可能缺失的 ListMark 节点。
          if (/^[-+*]$/.test(match[2])) {
            const markerStart = line.from + match[1].length;
            builder.add(markerStart, markerStart + match[2].length, Decoration.replace({}));
          }
          builder.add(
            checkboxStart,
            checkboxEnd,
            Decoration.replace({
              widget: new TaskListCheckboxWidget(isChecked, checkboxStart, checkboxEnd)
            })
          );
        }

        if (isChecked) {
          const contentOffset = line.text.slice(checkboxEnd - line.from).search(/\S/);

          if (contentOffset >= 0) {
            const contentStart = checkboxEnd + contentOffset;
            builder.add(contentStart, line.to, Decoration.mark({
              class: 'cm-markdown-task-list-content--checked'
            }));
          }
        }
      }

      if (line.to >= to) break;
      position = line.to + 1;
    }
  }

  return builder.finish();
}

/**
 * 在文档、选区或视口变化时刷新任务列表装饰。
 */
const taskListDecorationsExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    /**
     * 初始化任务列表装饰。
     */
    constructor(view: EditorView) {
      this.decorations = buildTaskListDecorations(view);
    }

    /**
     * 响应编辑器状态变化并更新任务列表装饰。
     */
    update(update: ViewUpdate): void {
      if (
        update.docChanged
        || update.selectionSet
        || update.viewportChanged
        || update.focusChanged
      ) {
        this.decorations = buildTaskListDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

/**
 * 导出任务列表装饰扩展，供主编辑器统一注册。
 */
export const taskListExtension = taskListDecorationsExtension;

/**
 * 定义任务列表复选框的主题外观，颜色跟随 Vuetify 当前主题主色。
 */
export const taskListThemeExtension = EditorView.theme({
  '.cm-markdown-task-list-checkbox': {
    position: 'relative',
    // 以首行行盒居中，避免固定基线偏移受字号和字体影响。
    top: 'calc((var(--workbench-editor-line-height) - var(--workbench-editor-task-list-checkbox-size)) / 2)',
    width: 'var(--workbench-editor-task-list-checkbox-size)',
    height: 'var(--workbench-editor-task-list-checkbox-size)',
    padding: '0',
    border: 'var(--workbench-editor-task-list-checkbox-border-width) solid var(--ws-checked-border)',
    borderRadius: 'var(--workbench-editor-task-list-checkbox-radius)',
    color: 'var(--ws-checked-selectedForeground)',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    verticalAlign: 'var(--workbench-editor-task-list-checkbox-align)'
  },
  '.cm-markdown-task-list-checkbox[data-checked="true"]': {
    backgroundColor: 'var(--ws-checked-selectedBackground)'
  },
  '.cm-markdown-task-list-checkbox[data-checked="true"]::after': {
    position: 'absolute',
    insetInlineStart: 'var(--workbench-editor-task-list-check-inset-inline)',
    insetBlockStart: 'var(--workbench-editor-task-list-check-inset-block)',
    width: 'var(--workbench-editor-task-list-check-width)',
    height: 'var(--workbench-editor-task-list-check-height)',
    borderInlineEnd: 'var(--workbench-editor-task-list-check-border-width) solid currentColor',
    borderBlockEnd: 'var(--workbench-editor-task-list-check-border-width) solid currentColor',
    content: '""',
    transform: 'rotate(45deg)'
  },
  '.cm-markdown-task-list-line--editing-source .cm-matchingBracket': {
    backgroundColor: 'unset'
  },
  '.cm-markdown-task-list-content--checked': {
    color: 'var(--ws-checked-deleLineForeground) !important',
    textDecorationLine: 'line-through',
    textDecorationColor: 'var(--ws-checked-deleLineColor)',
    textDecorationThickness: 'var(--workbench-editor-delete-line-width)'
  }
});
