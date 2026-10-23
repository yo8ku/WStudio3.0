/**
 * 文件说明：定义块级 Widget 共享的选择、编辑与高度估算基础能力。
 */
import { WidgetType } from '@codemirror/view';

/** CodeMirror 块级 Widget 基类。 */
export abstract class EditorBlockWidget extends WidgetType {
  /**
   * 创建块级 Widget 的通用状态。
   */
  protected constructor(
    protected readonly selected: boolean,
    protected readonly editing: boolean,
    private readonly measuredHeight: number | null
  ) {
    super();
  }

  /**
   * 向 CodeMirror 高度图提供块的已测量高度。
   */
  public override get estimatedHeight(): number {
    return this.measuredHeight ?? -1;
  }

  /**
   * 判断当前块是否需要由块级行号标记补充真实行号。
   */
  public shouldShowBlockLineNumber(): boolean {
    return !this.editing;
  }

  /**
   * 比较两个块 Widget 的通用选择、编辑与高度状态。
   */
  protected hasEqualEditorBlockState(widget: EditorBlockWidget): boolean {
    return widget.selected === this.selected
      && widget.editing === this.editing
      && widget.measuredHeight === this.measuredHeight;
  }

  /** 比较不会影响 Widget DOM 生命周期的交互状态。 */
  protected hasEqualEditorBlockInteractionState(widget: EditorBlockWidget): boolean {
    return widget.selected === this.selected
      && widget.editing === this.editing;
  }
}
