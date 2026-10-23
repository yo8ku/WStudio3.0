/** 文件说明：验证正文和代码块的多行括号折叠，以及编辑后的范围更新。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState } from '@codemirror/state';
import { codeFolding, foldEffect, foldable, foldedRanges, unfoldEffect } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { createEditorFoldGutterExtension } from './editorFoldGutterExtension.ts';

const sample = [
  '{',
  '  "name":"片段名称",',
  '  "type":"片段类型",',
  '  "无能的标题":{',
  '    "prefix":"片段前缀",',
  '    "body":[',
  '       .....',
  '    ],',
  '    "description":"片段描述"',
  '  }',
  '}'
].join('\n');

/** 复用真实 gutter 配置，不用模拟折叠服务替代宿主扩展。 */
function createState(doc, language = true) {
  return EditorState.create({
    doc,
    extensions: [createEditorFoldGutterExtension(), codeFolding(), ...(language ? [markdown()] : [])]
  });
}

function rangeAt(state, number) {
  const line = state.doc.line(number);
  return foldable(state, line.from, line.to);
}

test('普通正文里的外层对象、嵌套对象和数组分别可折叠，保留闭合括号', () => {
  const state = createState(sample);
  assert.deepEqual(rangeAt(state, 1), { from: 1, to: sample.lastIndexOf('}') });
  assert.deepEqual(rangeAt(state, 4), {
    from: sample.indexOf('{', 1) + 1,
    to: sample.lastIndexOf('  }') + 2
  });
  assert.deepEqual(rangeAt(state, 6), { from: sample.indexOf('[') + 1, to: sample.indexOf(']') });
});

test('代码块有无语言名称都支持嵌套数组和对象折叠', () => {
  for (const language of ['', 'json', 'javascript']) {
    const source = '```' + language + '\n' + sample + '\n```';
    const state = createState(source);
    assert.deepEqual(rangeAt(state, 5), {
      from: source.indexOf('{', source.indexOf('{') + 1) + 1,
      to: source.lastIndexOf('  }') + 2
    });
    assert.deepEqual(rangeAt(state, 7), { from: source.indexOf('[') + 1, to: source.indexOf(']') });
  }
});

test('列表中的正文数据也识别每层括号', () => {
  const source = '- 配置结构：\n' + sample.split('\n').map(line => '  ' + line).join('\n');
  const state = createState(source);
  assert.deepEqual(rangeAt(state, 5), {
    from: source.indexOf('{', source.indexOf('{') + 1) + 1,
    to: source.lastIndexOf('    }') + 4
  });
  assert.deepEqual(rangeAt(state, 7), { from: source.indexOf('[') + 1, to: source.indexOf(']') });
});

test('字符串中的括号和转义引号不改变数组配对', () => {
  const source = '[\n  "}", "[", "\\\" ]", \'{\'\n]';
  assert.deepEqual(rangeAt(createState(source, false), 1), {
    from: 1, to: source.lastIndexOf(']')
  });
});

test('代码注释里的括号不破坏外层配对', () => {
  const source = '[\n  // ] }\n  /* [ {\n     } ] */\n  1\n]';
  assert.deepEqual(rangeAt(createState(source, false), 1), { from: 1, to: source.lastIndexOf(']') });
});

test('英文正文中的撇号不会阻止后续数据折叠', () => {
  const source = "Here's an example:\n[\n正文\n]";
  assert.deepEqual(rangeAt(createState(source, false), 2), {
    from: source.indexOf('[') + 1, to: source.lastIndexOf(']')
  });
});

test('只有跨行且正确配对的括号才有折叠标记', () => {
  for (const source of ['{}', '[]', '{\n未闭合', '[\n}\n]', '`[\n正文\n]`']) {
    assert.equal(rangeAt(createState(source, false), 1), null, source);
  }
  assert.ok(rangeAt(createState('{\n[\n正文\n]', false), 2));
});

test('括号不跨越不同的围栏代码块配对', () => {
  const source = '```\n{\n```\n\n```\n}\n```';
  assert.equal(rangeAt(createState(source, false), 2), null);
});

test('删除和恢复闭合括号立即更新折叠范围', () => {
  const state = createState('[\n内容\n]', false);
  assert.deepEqual(rangeAt(state, 1), { from: 1, to: state.doc.length - 1 });
  const edited = state.update({ changes: { from: state.doc.length - 1, to: state.doc.length } }).state;
  assert.equal(rangeAt(edited, 1), null);
  const restored = edited.update({ changes: { from: edited.doc.length, insert: ']' } }).state;
  assert.deepEqual(rangeAt(restored, 1), rangeAt(state, 1));
});

test('嵌套折叠和展开复用 CodeMirror 状态，文档源码保持完整', () => {
  const state = createState(sample);
  const range = rangeAt(state, 6);
  assert.ok(range);
  const folded = state.update({ effects: foldEffect.of(range) }).state;
  assert.equal(foldedRanges(folded).size, 1);
  assert.equal(folded.doc.toString(), sample);
  const expanded = folded.update({ effects: unfoldEffect.of(range) }).state;
  assert.equal(foldedRanges(expanded).size, 0);
});

test('原有 Markdown 标题折叠仍可使用', () => {
  const state = createState('# 标题\n正文\n## 子标题\n内容');
  assert.ok(rangeAt(state, 1));
});
