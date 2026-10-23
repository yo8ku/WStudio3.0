import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as vue from 'vue';
import * as pinia from 'pinia';

function compile(source, imports, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText, { exports, require: name => imports[name] ?? {}, ...globals });
  return exports;
}

function fixture(families = ['Bodoni 72', 'Beirut', 'Al Bayan']) {
  pinia.setActivePinia(pinia.createPinia());
  const writes = [];
  const storeModule = compile(readFileSync(new URL('../../store/editorSettings.ts', import.meta.url), 'utf8'), {
    vue, pinia,
    '@/api/appSettings': { appSettingsApi: { set: async (key, value) => writes.push([key, value]) } },
    '@/types/appSettings': { APP_SETTING_KEYS: { editorFontFamilies: 'fonts', editorFontSize: 'size' } }
  });
  const store = storeModule.useEditorSettingsStore();
  store.selectedFontFamilies = [...families];
  class Handle {
    captured = new Set();
    setPointerCapture(id) { this.captured.add(id); }
    hasPointerCapture(id) { return this.captured.has(id); }
    releasePointerCapture(id) { this.captured.delete(id); }
  }
  const handle = new Handle();
  const source = readFileSync(new URL('./SettingsEditorView.vue', import.meta.url), 'utf8')
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const view = compile(source + '\nexport { selectedFontListElement, draggedFontIndex, dragOverFontIndex, handleFontPointerDown, handleFontPointerMove, handleFontPointerUp, handleFontPointerEnd };', {
    vue: { ...vue, onMounted: () => {} }, pinia,
    '@/store/editorSettings': storeModule
  }, { HTMLElement: Handle });
  view.selectedFontListElement.value = {
    querySelectorAll: () => families.map((_, index) => ({
      getBoundingClientRect: () => ({ top: index * 32, height: 32 })
    }))
  };
  return {
    view, store, writes, handle,
    event: (clientY, pointerId = 1, button = 0) => ({ clientY, pointerId, button, currentTarget: handle })
  };
}

test('dragging the first font below the last row updates and persists the fallback order', () => {
  const { view, store, writes, handle, event } = fixture();
  view.handleFontPointerDown(0, event(16));
  assert.ok(handle.hasPointerCapture(1));
  view.handleFontPointerMove(event(100));
  assert.equal(view.dragOverFontIndex.value, 3);
  assert.equal(writes.length, 0);
  view.handleFontPointerUp(event(100));
  assert.deepEqual([...store.selectedFontFamilies], ['Beirut', 'Al Bayan', 'Bodoni 72']);
  assert.equal(store.editorFontFamily, 'Beirut');
  assert.deepEqual(writes, [['fonts', '["Beirut","Al Bayan","Bodoni 72"]']]);
  assert.equal(view.draggedFontIndex.value, null);
  assert.equal(handle.hasPointerCapture(1), false);
});

test('dragging upward can make the last font primary', () => {
  const { view, store, event } = fixture();
  view.handleFontPointerDown(2, event(80));
  view.handleFontPointerUp(event(0));
  assert.deepEqual([...store.selectedFontFamilies], ['Al Bayan', 'Bodoni 72', 'Beirut']);
});

test('cancelled drags and unrelated pointers never persist an order change', () => {
  const { view, writes, event, handle } = fixture();
  view.handleFontPointerDown(0, event(16));
  view.handleFontPointerMove(event(100, 2));
  view.handleFontPointerUp(event(100, 2));
  assert.ok(handle.hasPointerCapture(1));
  view.handleFontPointerEnd(event(100));
  view.handleFontPointerUp(event(100));
  assert.equal(writes.length, 0);
  assert.equal(view.draggedFontIndex.value, null);
});

test('single fonts, right clicks and drops in the original slot are unchanged', () => {
  const single = fixture(['Arial']);
  single.view.handleFontPointerDown(0, single.event(16));
  assert.equal(single.handle.hasPointerCapture(1), false);
  const { view, writes, event, handle } = fixture();
  view.handleFontPointerDown(0, event(16, 1, 2));
  assert.equal(handle.hasPointerCapture(1), false);
  view.handleFontPointerDown(0, event(10));
  view.handleFontPointerUp(event(25));
  assert.equal(writes.length, 0);
});
