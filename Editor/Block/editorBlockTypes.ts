/**
 * 文件说明：定义 CodeMirror 块级 Widget 可复用的源码范围与视觉状态类型。
 */

/** 块级 Widget 的通用视觉状态。 */
export type EditorBlockVisualState = 'default' | 'selected' | 'editing';

/** 块级语法节点必须提供的源码范围。 */
export interface EditorBlockSourceRange {
  /** 块源码范围起点。 */
  readonly from: number;
  /** 块源码范围终点。 */
  readonly to: number;
}
