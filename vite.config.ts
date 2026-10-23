/** 文件说明：配置渲染端构建、开发首屏预热、SVG 与样式加载。 */
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import vuetify from 'vite-plugin-vuetify';

const DEV_STYLE_RUNTIME_ID = '\0ws-dev-style-runtime';
const SVG_VIRTUAL_MODULE_ID = 'virtual:ws-svg-icons';
const SVG_RESOLVED_MODULE_ID = '\0ws-svg-icons';
const SVG_SOURCE_DIRECTORY = path.resolve(__dirname, 'src/assets/svg');

/** 读取宿主 SVG 源码，供单一虚拟模块内联输出。 */
function readSvgSources(): Readonly<Record<string, string>> {
  const entries = fs.readdirSync(SVG_SOURCE_DIRECTORY)
    .filter(fileName => fileName.toLowerCase().endsWith('.svg'))
    .sort((left, right) => left.localeCompare(right));

  return Object.fromEntries(
    entries.map(fileName => [
      `./assets/svg/${fileName}`,
      fs.readFileSync(path.join(SVG_SOURCE_DIRECTORY, fileName), 'utf8')
    ])
  );
}

/** 将 SVG 文件名转换为虚拟模块的合法具名导出。 */
function toSvgExportName(fileName: string): string {
  const name = fileName.replace(/\.svg$/iu, '').replace(/[^a-zA-Z0-9_$]/gu, '_');
  return /^[0-9]/u.test(name) ? `_${name}` : name;
}

/** 将所有宿主 SVG 合并为一次加载的虚拟模块，避免逐文件 ?raw 请求。 */
function inlineSvgAssets(): Plugin {
  return {
    name: 'ws:inline-svg-assets',
    enforce: 'pre',
    resolveId(id) {
      return id === SVG_VIRTUAL_MODULE_ID ? SVG_RESOLVED_MODULE_ID : undefined;
    },
    load(id) {
      if (id !== SVG_RESOLVED_MODULE_ID) return undefined;

      const sources = readSvgSources();
      const namedExports = Object.entries(sources)
        .map(([sourcePath, markup]) => {
          const fileName = sourcePath.split('/').pop() ?? '';
          return `export const ${toSvgExportName(fileName)} = ${JSON.stringify(markup)};`;
        })
        .join('\n');

      return `const sources = ${JSON.stringify(sources)};\nexport default sources;\n${namedExports}`;
    },
    handleHotUpdate(context) {
      if (!context.file.startsWith(SVG_SOURCE_DIRECTORY)) return undefined;
      const module = context.server.moduleGraph.getModuleById(SVG_RESOLVED_MODULE_ID);
      if (module) context.server.moduleGraph.invalidateModule(module);
      context.server.ws.send({ type: 'full-reload' });
      return [];
    },
    transform(code, id) {
      if (!id.includes('/src/') || (!id.includes('.vue') && !id.endsWith('.ts'))) {
        return undefined;
      }

      const transformedCode = code.replace(
        /import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])@\/assets\/svg\/([^'"]+)\.svg\?raw\2\s*;?/gu,
        (_match, localName: string, _quote: string, fileName: string) => (
          `import { ${toSvgExportName(`${fileName}.svg`)} as ${localName} } from '${SVG_VIRTUAL_MODULE_ID}';`
        )
      );

      return transformedCode === code ? undefined : { code: transformedCode, map: null };
    }
  };
}

/** 在开发态把 Vite 各 CSS 模块聚合到单个 style 节点，同时保留 HMR 更新能力。 */
function aggregateDevStyles(): Plugin {
  let isDevServer = false;

  return {
    name: 'ws:aggregate-dev-styles',
    enforce: 'post',
    configResolved(config) {
      isDevServer = config.command === 'serve';
    },
    resolveId(id) {
      return id === DEV_STYLE_RUNTIME_ID ? DEV_STYLE_RUNTIME_ID : undefined;
    },
    load(id) {
      if (id !== DEV_STYLE_RUNTIME_ID) return undefined;

      return `
        const styleParts = new Map();
        let styleElement;

        function ensureStyleElement() {
          if (styleElement) return styleElement;
          document.querySelectorAll('style[data-vite-dev-id]').forEach((element) => element.remove());
          styleElement = document.querySelector('[data-ws-dev-style-bundle]')
            || document.createElement('style');
          styleElement.setAttribute('type', 'text/css');
          styleElement.setAttribute('data-ws-dev-style-bundle', 'true');
          if (!styleElement.parentNode) document.head.appendChild(styleElement);
          return styleElement;
        }

        function renderStyles() {
          ensureStyleElement().textContent = Array.from(styleParts.values()).join('\\n');
        }

        export function updateStyle(id, content) {
          styleParts.set(id, content);
          renderStyles();
        }

        export function removeStyle(id) {
          styleParts.delete(id);
          renderStyles();
        }
      `;
    },
    transform(code, id) {
      if (!isDevServer || id === DEV_STYLE_RUNTIME_ID) return undefined;
      if (!code.includes('__vite__updateStyle')) return undefined;

      return {
        code: code.replace(
          /from\s+(['"])[^'"]*\/@vite\/client\1/u,
          `from ${JSON.stringify(DEV_STYLE_RUNTIME_ID)}`
        ),
        map: null
      };
    }
  };
}

/** 开发态改用完整预编译样式，避免组件脚本逐个请求 CSS；生产态保持按需样式。 */
function bundleVuetifyDevStyles(): Plugin {
  let isDevServer = false;

  return {
    name: 'ws:bundle-vuetify-dev-styles',
    enforce: 'pre',
    configResolved(config) {
      isDevServer = config.command === 'serve';
    },
    transform(code, id) {
      if (!isDevServer || !id.endsWith('/src/plugins/vuetify.ts')) return undefined;

      const transformedCode = code.replace("'vuetify/styles'", "'vuetify/dist/vuetify.css'");
      return transformedCode === code ? undefined : { code: transformedCode, map: null };
    }
  };
}

export default defineConfig(({ command }) => ({
  // Keep assets relative to the Tauri app protocol's index.html.
  base: './',
  // 开发态统一加载预编译 CSS，避免为每个 Vuetify 组件创建独立样式模块请求。
  plugins: [
    bundleVuetifyDevStyles(),
    inlineSvgAssets(),
    vue(),
    vuetify({ autoImport: true, styles: command === 'serve' ? 'none' : true }),
    aggregateDevStyles()
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@editor': path.resolve(__dirname, 'Editor'),
      '@theme': path.resolve(__dirname, 'theme')
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    // Cargo 会生成 HTML 资源副本；它们不属于前端源码，避免触发整页重载。
    watch: {
      ignored: ['**/src-tauri/target/**']
    },
    // 在原生宿主构建期间转换首屏模块，减少窗口打开后的请求等待。
    warmup: {
      clientFiles: ['./src/main.ts', './src/views/WorkbenchView.vue']
    }
  },
  build: {
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const modulePath = id.replace(/\\/gu, '/');
          if (
            modulePath.includes('/node_modules/dompurify/')
            || modulePath.includes('/node_modules/marked/')
            || modulePath.includes('/node_modules/yaml/')
          ) {
            return 'editor-rendering';
          }

          if (
            modulePath.includes('/node_modules/@codemirror/lint/')
            || modulePath.includes('/node_modules/@codemirror/search/')
          ) {
            return 'editor-tools';
          }

          return undefined;
        }
      }
    }
  }
}));
