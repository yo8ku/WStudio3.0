/** 文件说明：验证编辑器块光标不会被块几何矩形误隐藏。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { resetEditorCursorGeometryVisibility } from './editorCursorVisibility.ts';

test('块矩形与普通光标重叠时只清理旧的内联隐藏样式', () => {
  const cursor = { style: { display: 'none' } };
  const view = {
    dom: {
      querySelectorAll(selector) {
        assert.equal(selector, '.cm-cursor');
        return [cursor];
      }
    }
  };

  resetEditorCursorGeometryVisibility(view);

  assert.equal(cursor.style.display, '');
});
