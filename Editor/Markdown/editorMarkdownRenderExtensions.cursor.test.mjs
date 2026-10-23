/** 文件说明：验证 Markdown 标题与引用的源码装饰不依赖焦点更新时序。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isSelectionOnDocumentLine } from './markdownSelectionState.ts';

test('选择已落在标题或引用行时即视为编辑态，即使焦点标记尚未更新', () => {
  const view = {
    hasFocus: false,
    state: {
      selection: {
        ranges: [{ empty: true, head: 7 }]
      },
      doc: {
        lineAt(position) {
          assert.ok(position === 0 || position === 7);
          return { from: 0, to: 12 };
        }
      }
    }
  };

  assert.equal(isSelectionOnDocumentLine(view, 0), true);
});

test('拖选范围与引用行相交时，该行进入编辑态', () => {
  const view = {
    state: {
      selection: {
        ranges: [{ empty: false, from: 8, to: 22, head: 22 }]
      },
      doc: {
        lineAt(position) {
          return position < 12
            ? { from: 0, to: 12 }
            : { from: 20, to: 30 };
        }
      }
    }
  };

  assert.equal(isSelectionOnDocumentLine(view, 0), true);
});

test('只读嵌入视图不会因默认选区显示源码标记', () => {
  const view = {
    state: {
      readOnly: true,
      selection: {
        ranges: [{ empty: true, head: 7 }]
      },
      doc: {
        lineAt() {
          return { from: 0 };
        }
      }
    }
  };

  assert.equal(isSelectionOnDocumentLine(view, 0), false);
});
