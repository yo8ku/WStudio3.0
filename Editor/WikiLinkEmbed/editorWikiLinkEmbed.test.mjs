/**
 * 文件说明：验证 Wiki 文件嵌入补全的文件名语法与候选解析契约。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { editorMarkdownReadOnlyExtensions } from '../Markdown/editorMarkdownRenderExtensions.ts';
import {
  createEditorWikiLinkEmbedText,
  clampEditorWikiLinkEmbedHeight,
  findEditorWikiLinkEmbedCompletionContext,
  retainEditorWikiLinkEmbedSourceKeys,
  resolveEditorWikiLinkEmbedFile,
  stripEditorWikiLinkEmbedExtension,
  setEditorWikiLinkEmbedSourceMode
} from './editorWikiLinkEmbed.ts';

test('嵌入文件块高度被限制在配置的最小值和最大值之间', () => {
  assert.equal(clampEditorWikiLinkEmbedHeight(120, 128, 384), 128);
  assert.equal(clampEditorWikiLinkEmbedHeight(256, 128, 384), 256);
  assert.equal(clampEditorWikiLinkEmbedHeight(420, 128, 384), 384);
});

test('嵌入只读视图复用主编辑器的标题与代码块渲染扩展', () => {
  const state = EditorState.create({
    doc: '# 标题\n\n```ts\nconst value = 1;\n```',
    extensions: [editorMarkdownReadOnlyExtensions]
  });
  const nodeNames = new Set();

  syntaxTree(state).iterate({ enter: (node) => nodeNames.add(node.name) });

  assert.equal(nodeNames.has('ATXHeading1'), true);
  assert.equal(nodeNames.has('FencedCode'), true);
});

test('识别未闭合 ![[ 文件名查询范围', () => {
  const state = EditorState.create({
    doc: '正文\n![[项目笔记',
    selection: { anchor: '正文\n![[项目笔记'.length },
    extensions: []
  });
  const context = findEditorWikiLinkEmbedCompletionContext(state);

  assert.deepEqual(context, {
    from: 6,
    to: 10,
    query: '项目笔记'
  });
});

test('闭合嵌入链接删除文件名字符后仍识别补全范围', () => {
  const source = '![[12345]]';
  const state = EditorState.create({
    doc: source,
    selection: { anchor: source.indexOf(']]') },
    extensions: []
  });

  assert.deepEqual(findEditorWikiLinkEmbedCompletionContext(state), {
    from: 3,
    to: 8,
    query: '12345'
  });
});

test('带 Markdown 扩展名的嵌入语法不进入补全范围', () => {
  const source = '![[12345.md]]';
  const state = EditorState.create({
    doc: source,
    selection: { anchor: source.indexOf(']]') },
    extensions: []
  });

  assert.equal(findEditorWikiLinkEmbedCompletionContext(state), null);
});

test('按文件名称匹配候选，链接语法不接受 md 扩展名', () => {
  const files = [
    { path: 'notes/项目笔记.md', relativePath: 'notes/项目笔记.md', name: '项目笔记.md', size: 1, modifiedAt: 1 },
    { path: 'archive/其他.md', relativePath: 'archive/其他.md', name: '其他.md', size: 1, modifiedAt: 1 }
  ];

  assert.equal(resolveEditorWikiLinkEmbedFile('项目笔记', files)?.path, 'notes/项目笔记.md');
  assert.equal(resolveEditorWikiLinkEmbedFile('项目笔记.md', files), undefined);
});

test('补全选择写入文件名称，不写入路径', () => {
  assert.equal(createEditorWikiLinkEmbedText('项目笔记.md'), '![[项目笔记]]');
  assert.equal(stripEditorWikiLinkEmbedExtension('项目笔记.markdown'), '项目笔记');
});

test('同名文件不按文件系统顺序猜选目标', () => {
  const files = [
    { path: 'notes/方案.md', relativePath: 'notes/方案.md', name: '方案.md', size: 1, modifiedAt: 1 },
    { path: 'archive/方案.md', relativePath: 'archive/方案.md', name: '方案.md', size: 1, modifiedAt: 1 }
  ];

  assert.equal(resolveEditorWikiLinkEmbedFile('方案', files), undefined);
});

test('源码模式在选区离开源码行后恢复为嵌入块', () => {
  const sourceModeKeys = new Set();
  const sourceModeEnabled = setEditorWikiLinkEmbedSourceMode(sourceModeKeys, '12:笔记.md', true);

  assert.equal(sourceModeEnabled.has('12:笔记.md'), true);
  assert.equal(setEditorWikiLinkEmbedSourceMode(sourceModeEnabled, '40:其他.md', false).has('12:笔记.md'), true);
  assert.equal(setEditorWikiLinkEmbedSourceMode(sourceModeEnabled, '12:笔记.md', false).has('12:笔记.md'), false);
  assert.deepEqual(
    retainEditorWikiLinkEmbedSourceKeys(sourceModeEnabled, new Set(['40:其他.md'])),
    new Set()
  );
  assert.deepEqual(
    retainEditorWikiLinkEmbedSourceKeys(sourceModeEnabled, new Set(['12:笔记.md'])),
    new Set(['12:笔记.md'])
  );
});
