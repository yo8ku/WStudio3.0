import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const stateModule = require('@codemirror/state');
const viewModule = require('@codemirror/view');
const source = readFileSync(new URL('./editorAdmonitionExtension.ts', import.meta.url), 'utf8');
const exports = {};
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, {
  exports,
  require: name => name === '@/components/WsIconButton/iconButton'
    ? { createIconButton: () => ({}) }
    : require(name)
});

const { EditorState, EditorSelection } = stateModule;
const { EditorView } = viewModule;
const { history, undo, redo } = require('@codemirror/commands');
const [admonitionStateField] = exports.editorAdmonitionExtension;

test('source mode places the caret after the title and keeps the whole admonition editable after typing', () => {
  const doc = '> [!NOTE] Title\n> Body';
  const state = EditorState.create({ doc, extensions: exports.editorAdmonitionExtension });
  const from = 0;
  const caret = exports.getEditorAdmonitionSourceSelection(state, from);

  assert.equal(caret, doc.indexOf('Title') + 'Title'.length);
  assert.ok(caret > doc.indexOf('[!NOTE]'));

  let sourceState = state.update({
    effects: exports.setEditorAdmonitionEditingEffect.of(from),
    selection: EditorSelection.cursor(caret)
  }).state;
  assert.equal(sourceState.field(admonitionStateField).editingBlockFrom, from);

  sourceState = sourceState.update({ changes: { from: caret, insert: ' edited' } }).state;
  assert.equal(sourceState.doc.toString(), '> [!NOTE] Title edited\n> Body');
  assert.equal(sourceState.field(admonitionStateField).editingBlockFrom, from);
  assert.equal(sourceState.field(admonitionStateField).decorations.size, 0);
});

test('source mode without a title starts just after the admonition marker', () => {
  const doc = '> [!TIP]\n> Body';
  const state = EditorState.create({ doc, extensions: exports.editorAdmonitionExtension });
  const caret = exports.getEditorAdmonitionSourceSelection(state, 0);

  assert.equal(caret, doc.indexOf(']') + 1);
});

test('source selection is unavailable for a non-admonition position', () => {
  const state = EditorState.create({ doc: '> [!NOTE] Title\n> Body', extensions: exports.editorAdmonitionExtension });
  assert.equal(exports.getEditorAdmonitionSourceSelection(state, 1), undefined);
});

test('the ordinary line after a rendered admonition remains outside its atomic range', () => {
  const doc = '> [!NOTE] Title\n> Body\nAfter';
  const state = EditorState.create({ doc, extensions: exports.editorAdmonitionExtension });
  const atomicRanges = state.field(admonitionStateField).atomicRanges;
  const ranges = [];
  atomicRanges.between(0, state.doc.length, (from, to) => ranges.push({ from, to }));

  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].to, doc.indexOf('\nAfter'));
  assert.equal(state.doc.line(3).from, ranges[0].to + 1);
});

test('rendered edits update Markdown, retain the card and support document undo/redo', () => {
  const doc = 'Before\n\n> [!NOTE] Title\n> Body\n\nAfter';
  const from = doc.indexOf('>');
  let state = EditorState.create({ doc, extensions: [exports.editorAdmonitionExtension, history()] });
  const changes = exports.buildEditorAdmonitionSource(state, from, '新标题', '正文\n第二行\n\n第四行');
  state = state.update({ changes, userEvent: 'input' }).state;

  assert.equal(state.doc.toString(), 'Before\n\n> [!NOTE] 新标题\n> 正文\n> 第二行\n> \n> 第四行\n\nAfter');
  assert.equal(state.field(admonitionStateField).editingBlockFrom, null);
  assert.equal(state.field(admonitionStateField).decorations.size, 1);
  const target = { get state() { return state; }, dispatch: transaction => { state = transaction.state; } };
  assert.equal(undo(target), true);
  assert.equal(state.doc.toString(), doc);
  assert.equal(redo(target), true);
  assert.match(state.doc.toString(), /第二行\n> \n> 第四行/);
});

test('title edits leave body indentation, spaces and surrounding text intact', () => {
  const doc = 'Before\n\n  > [!TIP] Title\n  >   indented\n  >\n  > last  \n\nAfter';
  const state = EditorState.create({ doc, extensions: exports.editorAdmonitionExtension });
  const from = doc.indexOf('  >');
  const changes = exports.buildEditorAdmonitionSource(state, from, 'Changed ', '  indented\n\nlast  ');
  const next = state.update({ changes }).state;
  assert.equal(next.doc.toString(), doc.replace('Title', 'Changed '));
});

test('typing into an empty rendered body creates quoted lines, including shorthand blocks', () => {
  for (const opening of ['> [!NOTE]', '[!NOTE]']) {
    const state = EditorState.create({ doc: `${opening}\n\nAfter`, extensions: exports.editorAdmonitionExtension });
    const next = state.update({ changes: exports.buildEditorAdmonitionSource(state, 0, '', '正文\n第二行') }).state;
    assert.equal(next.doc.toString(), '> [!NOTE]\n> 正文\n> 第二行\n\nAfter');
    assert.equal(next.field(admonitionStateField).decorations.size, 1);
  }
});

test('clearing title and body retains a valid empty editable admonition', () => {
  const state = EditorState.create({ doc: '> [!NOTE] Title\n> Body\n\nAfter', extensions: exports.editorAdmonitionExtension });
  const next = state.update({ changes: exports.buildEditorAdmonitionSource(state, 0, '', '') }).state;
  assert.equal(next.doc.toString(), '> [!NOTE] \n> \n\nAfter');
  assert.equal(next.field(admonitionStateField).decorations.size, 1);
});
