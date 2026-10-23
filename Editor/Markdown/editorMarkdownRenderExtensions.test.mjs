/** 文件说明：验证 Markdown 标题装饰覆盖完整文档，不随编辑器视口变化而丢失。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { collectMarkdownHeadingPrefixRanges } from './markdownHeadingModel.ts';

test('标题前缀收集覆盖视口外的所有 ATX 标题，并排除代码块', () => {
  const source = [
    '# 顶部标题',
    '正文',
    '```markdown',
    '# 代码块中的伪标题',
    '```',
    '## 中间标题',
    '### 尾部标题'
  ].join('\n');
  const state = EditorState.create({ doc: source, extensions: [markdown()] });

  assert.deepEqual(
    collectMarkdownHeadingPrefixRanges(state).map(({ lineFrom, level }) => ({ lineFrom, level })),
    [
      { lineFrom: 0, level: 1 },
      { lineFrom: source.indexOf('## 中间标题'), level: 2 },
      { lineFrom: source.indexOf('### 尾部标题'), level: 3 }
    ]
  );
});
