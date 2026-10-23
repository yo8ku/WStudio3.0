/** 文件说明：清理编辑器光标几何兜底遗留的内联隐藏样式。 */

interface CursorStyleHost {
  style: {
    display: string;
  };
}

interface CursorVisibilityHost {
  dom: {
    querySelectorAll(selector: string): Iterable<CursorStyleHost>;
  };
}

/** 块布局变化后恢复普通光标的默认显示，由状态属性负责真正的隐藏。 */
export function resetEditorCursorGeometryVisibility(view: CursorVisibilityHost): void {
  for (const cursor of view.dom.querySelectorAll('.cm-cursor')) {
    cursor.style.display = '';
  }
}
