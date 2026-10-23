/**
 * 文件说明：在按住 Ctrl 悬停 Markdown 标题链接时显示当前文档或跨文件章节预览。
 */
import {
  activateHover,
  closeHoverTooltip,
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  type Tooltip,
  type TooltipView,
  ViewPlugin
} from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { createApp } from 'vue';

import type { WorkspaceMarkdownFile, WorkspaceMarkdownFileMetadata } from '@/types/ipc';
import WorkbenchVerticalScrollbar from '@/components/scrollbar/WorkbenchVerticalScrollbar.vue';
import { collectMarkdownInlineLinkRanges } from '@editor/Markdown/markdownInlineLink';
import {
  resolveMarkdownInlineLinkPreview,
  type MarkdownInlineLinkNavigationTarget,
  type MarkdownInlineLinkPreview
} from '@editor/Markdown/markdownInlineLinkPreview';

/** 设置或清除当前预览链接的高亮文本范围。 */
const setPreviewActiveLink = StateEffect.define<{ from: number; to: number } | null>();

/** 在预览面板存续期间维持源链接的悬停前景色。 */
const previewActiveLinkField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, transaction) {
    let nextDecorations = decorations.map(transaction.changes);

    for (const effect of transaction.effects) {
      if (!effect.is(setPreviewActiveLink)) {
        continue;
      }

      nextDecorations = effect.value
        ? Decoration.set([
            Decoration.mark({ class: 'cm-markdown-inline-link-content--preview-active' })
              .range(effect.value.from, effect.value.to)
          ])
        : Decoration.none;
    }

    return nextDecorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

/** 行内链接预览扩展读取当前文件和工作区文件的接口。 */
interface MarkdownInlineLinkPreviewExtensionOptions {
  getCurrentFilePath: () => string | undefined;
  getWorkspaceFiles: () => readonly WorkspaceMarkdownFileMetadata[];
  readWorkspaceFile: (filePath: string) => Promise<WorkspaceMarkdownFile | undefined>;
  onNavigateToFile: (target: MarkdownInlineLinkNavigationTarget) => void;
}

const markdownPreviewRenderer = new Marked({
  breaks: true,
  gfm: true
});

/** 将 Markdown 渲染为经过清洗的安全 HTML。 */
function renderMarkdownPreview(source: string): string {
  const rendered = markdownPreviewRenderer.parse(source, { async: false });
  return DOMPurify.sanitize(rendered, {
    FORBID_TAGS: ['button', 'embed', 'form', 'iframe', 'input', 'object', 'script', 'style']
  });
}

/** 创建未找到标题时的提示内容。 */
function createMissingPreviewDom(preview: Extract<MarkdownInlineLinkPreview, { kind: 'missing' }>): HTMLElement {
  const dom = document.createElement('section');
  dom.className = 'cm-markdown-inline-link-preview cm-markdown-inline-link-preview--missing';
  dom.textContent = `未找到 “${preview.heading}”`;
  return dom;
}

/** 创建找到标题时的标题与章节正文内容。 */
function createFoundPreviewView(
  preview: Extract<MarkdownInlineLinkPreview, { kind: 'found' }>,
  view: EditorView,
  options: MarkdownInlineLinkPreviewExtensionOptions
): TooltipView {
  const dom = document.createElement('section');
  const scroller = document.createElement('div');
  const header = document.createElement('header');
  const title = document.createElement('h2');
  const navigateButton = document.createElement('button');
  const navigateIcon = document.createElement('span');
  const content = document.createElement('article');
  const scrollbarHost = document.createElement('div');

  dom.className = 'cm-markdown-inline-link-preview';
  scroller.className = 'cm-markdown-inline-link-preview__scroller';
  header.className = 'cm-markdown-inline-link-preview__header';
  title.className = 'cm-markdown-inline-link-preview__title';
  title.textContent = `${'#'.repeat(preview.headingLevel)} ${preview.heading}`;
  navigateButton.className = 'cm-markdown-inline-link-preview__navigate';
  navigateButton.type = 'button';
  navigateButton.setAttribute('aria-label', '跳转到标题');
  navigateIcon.className = 'cm-markdown-inline-link-preview__navigate-icon';
  navigateIcon.setAttribute('aria-hidden', 'true');
  navigateButton.append(navigateIcon);
  navigateButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (preview.navigationTarget) {
      options.onNavigateToFile(preview.navigationTarget);
    } else {
      view.dispatch({
        selection: {
          anchor: preview.position,
          head: preview.selectionEnd
        },
        scrollIntoView: true
      });
      view.focus();
    }
  });
  content.className = 'cm-markdown-inline-link-preview__content';
  content.innerHTML = renderMarkdownPreview(preview.content);
  scrollbarHost.className = 'cm-markdown-inline-link-preview__scrollbar';
  header.append(title, navigateButton);
  scroller.append(header, content);
  dom.append(scroller, scrollbarHost);

  const scrollbarApp = createApp(WorkbenchVerticalScrollbar, {
    scrollerElement: scroller
  });
  scrollbarApp.mount(scrollbarHost);

  return {
    dom,
    /** tooltip 销毁时同步释放自定义滚动条观察器与事件。 */
    destroy() {
      scrollbarApp.unmount();
    }
  };
}

/** 将指定文档位置解析为链接预览 Tooltip。 */
async function resolveLinkPreviewTooltip(
  view: EditorView,
  position: number,
  options: MarkdownInlineLinkPreviewExtensionOptions
): Promise<Tooltip | null> {
  const link = collectMarkdownInlineLinkRanges(view.state.doc.toString()).find((candidate) => (
    position >= candidate.labelFrom && position <= candidate.labelTo
  ));

  if (!link) {
    return null;
  }

  const destination = view.state.sliceDoc(link.destinationFrom, link.destinationTo);
  const preview = await resolveMarkdownInlineLinkPreview({
    currentContent: view.state.doc.toString(),
    currentFilePath: options.getCurrentFilePath(),
    destination,
    workspaceFiles: options.getWorkspaceFiles(),
    readWorkspaceFile: options.readWorkspaceFile
  });

  if (!preview) {
    return null;
  }

  return {
    pos: link.labelFrom,
    end: link.labelTo,
    above: false,
    create() {
      return preview.kind === 'found'
        ? createFoundPreviewView(preview, view, options)
        : { dom: createMissingPreviewDom(preview) };
    }
  };
}

/** 创建 Ctrl 悬停行内标题链接预览扩展。 */
export function createMarkdownInlineLinkPreviewExtension(
  options: MarkdownInlineLinkPreviewExtensionOptions
) {
  let controlPressed = false;
  let hoverPosition: number | null = null;
  let activatedPosition: number | null = null;
  let pointerInsidePreview = false;
  const previewTooltip = hoverTooltip((view, position) => (
    controlPressed ? resolveLinkPreviewTooltip(view, position, options) : null
  ));

  const controlHoverPlugin = ViewPlugin.fromClass(class {
    /** 初始化全局修饰键与编辑器指针监听。 */
    constructor(private readonly view: EditorView) {
      window.addEventListener('keydown', this.handleKeyDown);
      window.addEventListener('keyup', this.handleKeyUp);
      window.addEventListener('blur', this.handleWindowBlur);
      window.addEventListener('mousemove', this.handleMouseMove);
    }

    /** 在编辑器内更新命中位置，进入预览面板时保持，离开两者后关闭。 */
    private readonly handleMouseMove = (event: MouseEvent): void => {
      const target = event.target;

      if (!(target instanceof Element)) {
        return;
      }

      if (target.closest('.cm-markdown-inline-link-preview')) {
        pointerInsidePreview = true;
        return;
      }

      pointerInsidePreview = false;

      if (!this.view.dom.contains(target)) {
        hoverPosition = null;
        this.closePreview();
        return;
      }

      try {
        hoverPosition = this.view.posAtCoords({
          x: event.clientX,
          y: event.clientY
        });
      } catch {
        // CodeMirror 重新布局块级 Widget 的瞬间可能暂时无法解析坐标。
        hoverPosition = null;
        this.closePreview();
        return;
      }

      if (!event.ctrlKey) {
        this.closePreview();
        return;
      }

      controlPressed = true;

      if (hoverPosition !== null) {
        this.activatePreview(hoverPosition);
      }
    };

    /** 按下 Ctrl 时立即激活当前指针位置的预览。 */
    private readonly handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Control' || event.repeat) {
        return;
      }

      controlPressed = true;

      if (hoverPosition !== null) {
        this.activatePreview(hoverPosition);
      }
    };

    /** 松开 Ctrl 时关闭链接预览。 */
    private readonly handleKeyUp = (event: KeyboardEvent): void => {
      if (event.key !== 'Control') {
        return;
      }

      controlPressed = false;

      if (!pointerInsidePreview) {
        this.closePreview();
      }
    };

    /** 窗口失焦时清理可能残留的 Ctrl 状态。 */
    private readonly handleWindowBlur = (): void => {
      this.closePreview();
    };

    /** 统一关闭当前扩展创建的 hover tooltip。 */
    private closePreview(): void {
      if (!controlPressed && activatedPosition === null) {
        return;
      }

      controlPressed = false;
      activatedPosition = null;
      this.view.dispatch({
        effects: [closeHoverTooltip(previewTooltip), setPreviewActiveLink.of(null)]
      });
    }

    /** 激活新的指针位置，并关闭上一个位置的固定预览。 */
    private activatePreview(position: number): void {
      const link = collectMarkdownInlineLinkRanges(this.view.state.doc.toString()).find((candidate) => (
        position >= candidate.labelFrom && position <= candidate.labelTo
      ));

      if (!link) {
        this.closePreview();
        return;
      }

      if (activatedPosition === position) {
        return;
      }

      if (activatedPosition !== null) {
        this.view.dispatch({
          effects: [
            closeHoverTooltip(previewTooltip),
            setPreviewActiveLink.of({ from: link.labelFrom, to: link.labelTo })
          ]
        });
      } else {
        this.view.dispatch({
          effects: setPreviewActiveLink.of({ from: link.labelFrom, to: link.labelTo })
        });
      }

      activatedPosition = position;
      activateHover(this.view, position, 1, { tooltip: previewTooltip });
    }

    /** 移除全局与编辑器 DOM 监听。 */
    destroy(): void {
      window.removeEventListener('keydown', this.handleKeyDown);
      window.removeEventListener('keyup', this.handleKeyUp);
      window.removeEventListener('blur', this.handleWindowBlur);
      window.removeEventListener('mousemove', this.handleMouseMove);
    }
  });

  return [previewActiveLinkField, previewTooltip, controlHoverPlugin];
}
