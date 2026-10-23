/** 文件说明：测量编辑器的空格与引用标记宽度，供缩进、代码块及引用换行共享。 */
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

interface EditorPrefixWidths {
  readonly space: number;
  readonly quoteMarker: number;
}

/** 在布局读取阶段测量前缀字符，兼容非等宽字体。 */
function measureEditorPrefixWidths(view: EditorView): EditorPrefixWidths {
  const fallback = Math.max(1, view.defaultCharacterWidth);
  const ownerDocument = view.scrollDOM.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  const context = ownerDocument.createElement('canvas').getContext('2d');
  if (!ownerWindow || !context) return { space: fallback, quoteMarker: fallback };

  context.font = ownerWindow.getComputedStyle(view.scrollDOM).font;
  const space = context.measureText(' ').width;
  const quoteMarker = context.measureText('>').width;
  return {
    space: Number.isFinite(space) && space > 0 ? space : fallback,
    quoteMarker: Number.isFinite(quoteMarker) && quoteMarker > 0 ? quoteMarker : fallback
  };
}

/** 首次布局和字体几何变化后更新共享尺寸；多处接入复用同一个插件实例。 */
export const editorSpaceWidthExtension = ViewPlugin.fromClass(class {
  private readonly measurement = {
    read: measureEditorPrefixWidths,
    write: (widths: EditorPrefixWidths, view: EditorView): void => {
      view.dom.style.setProperty('--workbench-editor-space-width', `${widths.space}px`);
      view.dom.style.setProperty('--workbench-editor-quote-marker-width', `${widths.quoteMarker}px`);
    }
  };

  /** 安排首次测量，等待编辑器挂载后读取最终字体。 */
  public constructor(view: EditorView) {
    view.requestMeasure(this.measurement);
  }

  /** 字体、字号及布局改变时重新测量。 */
  public update(update: ViewUpdate): void {
    if (update.geometryChanged) update.view.requestMeasure(this.measurement);
  }
});
