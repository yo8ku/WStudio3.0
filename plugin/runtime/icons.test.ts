/**
 * 文件说明：验证公开插件图标 API 的真实 SVG 插入、输入校验和注册生命周期。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clearPluginIcons,
  createIconsApi,
  registerPluginIcon,
  registerPluginIconSources,
  registerPluginIconLoaders,
  toPluginIconName
} from './icons';

/** 测试使用的最小 DOM 元素，实现图标 API 依赖的标准方法。 */
class TestElement {
  readonly attributes: Array<{ name: string; value: string }> = [];
  readonly classList = { add: (_name: string): void => undefined };
  readonly namespaceURI: string;
  readonly localName: string;
  children: TestElement[] = [];
  readonly childNodes: TestElement[] = [];

  constructor(localName = 'span', namespaceURI = 'http://www.w3.org/1999/xhtml') {
    this.localName = localName;
    this.namespaceURI = namespaceURI;
  }

  /** 写入测试节点属性。 */
  setAttribute(name: string, value: string): void {
    const existing = this.attributes.find(attribute => attribute.name === name);
    if (existing) existing.value = value;
    else this.attributes.push({ name, value });
  }

  /** 替换测试目标内容。 */
  replaceChildren(...children: TestElement[]): void {
    this.children = children;
  }
}

/** 测试使用的 DOMParser，只区分合法 SVG 与无效根节点。 */
class TestDomParser {
  /** 将测试标记解析为最小文档。 */
  parseFromString(markup: string): { documentElement: TestElement } {
    return {
      documentElement: markup.trimStart().startsWith('<svg')
        ? new TestElement('svg', 'http://www.w3.org/2000/svg')
        : new TestElement('parsererror', 'http://www.mozilla.org/newlayout/xml/parsererror.xml')
    };
  }
}

/** 临时安装测试 DOM 全局对象，并在验证完成后完整恢复。 */
async function withTestDom(run: () => void | Promise<void>): Promise<void> {
  const descriptors = {
    DOMParser: Object.getOwnPropertyDescriptor(globalThis, 'DOMParser'),
    Element: Object.getOwnPropertyDescriptor(globalThis, 'Element'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document')
  };
  Object.defineProperties(globalThis, {
    DOMParser: { configurable: true, value: TestDomParser },
    Element: { configurable: true, value: TestElement },
    document: {
      configurable: true,
      value: {
        createElementNS: (_namespace: string, localName: string) => (
          new TestElement(localName, 'http://www.w3.org/2000/svg')
        ),
        importNode: (_template: TestElement) => new TestElement('svg', 'http://www.w3.org/2000/svg')
      }
    }
  });
  try {
    await run();
  } finally {
    clearPluginIcons();
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

/** 读取 SDK Error 上对 JavaScript 插件稳定公开的错误码。 */
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

test('setIcon 插入真实 SVG 并返回独立节点', async () => {
  await withTestDom(() => {
    registerPluginIcon('new-file', '<svg viewBox="0 0 24 24"/>');
    const api = createIconsApi();
    const firstTarget = new TestElement();
    const secondTarget = new TestElement();
    const first = api.setIcon(firstTarget as unknown as Element, 'new-file');
    const second = api.setIcon(secondTarget as unknown as Element, 'new-file');

    assert.equal(api.hasIcon('new-file'), true);
    assert.equal(firstTarget.children[0]?.localName, 'svg');
    assert.notEqual(first, second);
  });
});

test('图标 API 拒绝未知名称、非法名称和非 DOM 目标', async () => {
  await withTestDom(() => {
    const api = createIconsApi();
    const target = new TestElement();

    assert.equal(api.hasIcon('MissingIcon'), false);
    assert.throws(
      () => api.setIcon(target as unknown as Element, 'missing-icon'),
      (error: unknown) => errorCode(error) === 'PLUGIN_ICON_NOT_FOUND'
    );
    assert.throws(
      () => api.setIcon(target as unknown as Element, '../File.svg'),
      (error: unknown) => errorCode(error) === 'PLUGIN_ICON_NAME_INVALID'
    );
    assert.throws(
      () => api.setIcon({} as Element, 'file'),
      (error: unknown) => errorCode(error) === 'PLUGIN_ICON_TARGET_INVALID'
    );
  });
});

test('宿主图标注册拒绝无效 SVG 和重复稳定名称', async () => {
  await withTestDom(() => {
    assert.equal(toPluginIconName('ArrowForward.svg'), 'arrow-forward');
    assert.throws(
      () => registerPluginIcon('file', '<div/>'),
      (error: unknown) => errorCode(error) === 'PLUGIN_ICON_SOURCE_INVALID'
    );
    registerPluginIcon('file', '<svg/>');
    assert.throws(
      () => registerPluginIcon('file', '<svg/>'),
      (error: unknown) => errorCode(error) === 'PLUGIN_ICON_ALREADY_REGISTERED'
    );
  });
});

test('宿主延迟图标只在首次使用时加载并缓存', async () => {
  await withTestDom(async () => {
    let loadCount = 0;
    registerPluginIconLoaders({
      './LazyIcon.svg': async () => {
        loadCount += 1;
        return '<svg viewBox="0 0 24 24"/>';
      }
    });
    const api = createIconsApi();
    assert.equal(api.hasIcon('lazy-icon'), true);
    assert.equal(loadCount, 0);

    const firstTarget = new TestElement();
    api.setIcon(firstTarget as unknown as Element, 'lazy-icon');
    assert.equal(loadCount, 0);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    assert.equal(loadCount, 1);

    const secondTarget = new TestElement();
    api.setIcon(secondTarget as unknown as Element, 'lazy-icon');
    assert.equal(loadCount, 1);
  });
});

test('内联宿主图标源不依赖 SVG 网络请求', async () => {
  await withTestDom(() => {
    registerPluginIconSources({ './InlineIcon.svg': '<svg viewBox="0 0 24 24"/>' });
    const api = createIconsApi();
    const target = new TestElement();
    assert.equal(api.hasIcon('inline-icon'), true);
    const svg = api.setIcon(target as unknown as Element, 'inline-icon');
    assert.equal(svg.localName, 'svg');
    assert.equal(target.children[0]?.localName, 'svg');
  });
});
