/**
 * 文件说明：提供 CodeMirror 行内搜索面板的原生 Panel 实现与搜索交互。
 */
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  selectMatches,
  setSearchQuery
} from '@codemirror/search';
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view';

const arrowDownIcon = 'icon icon-arrow-down';
const arrowForwardIcon = 'icon icon-arrow-forward';
const caseSensitiveIcon = 'icon icon-aa';
const wholeWordIcon = 'icon icon-ab';
const regexpIcon = 'icon icon-regx';
const searchPreviousIcon = 'icon icon-search-toolbar-previous';
const searchNextIcon = 'icon icon-search-toolbar-next';
const selectMatchesIcon = 'icon icon-search2';
const closeSearchIcon = 'icon icon-close';
const replaceIcon = 'icon icon-replace';
const replaceAllIcon = 'icon icon-replace-all';

/** 创建带项目图标和匹配状态同步的 CodeMirror 搜索面板。 */
export function createWsEditorlineSearchPanel(view: EditorView): Panel {
  const query = getSearchQuery(view.state);
  let currentQuery = query;
  let replaceExpanded = false;

  const panel = document.createElement('div');
  panel.className = 'code-mirror-search-panel';

  const icon = (iconClass: string): HTMLSpanElement => {
    const element = document.createElement('span');
    element.className = `code-mirror-search-panel__icon ${iconClass}`;
    element.setAttribute('aria-hidden', 'true');
    return element;
  };

  const createButton = (
    name: string,
    label: string,
    iconClass: string,
    handler: () => void
  ): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.name = name;
    button.className = 'code-mirror-search-panel__button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.append(icon(iconClass));
    button.addEventListener('click', handler);
    return button;
  };

  const searchInput = document.createElement('input');
  searchInput.className = 'code-mirror-search-panel__input';
  searchInput.name = 'search';
  searchInput.type = 'search';
  searchInput.placeholder = '查找';
  searchInput.setAttribute('aria-label', '查找');
  searchInput.setAttribute('main-field', 'true');
  searchInput.value = query.search;

  const replaceInput = document.createElement('input');
  replaceInput.className = 'code-mirror-search-panel__replace-input';
  replaceInput.name = 'replace';
  replaceInput.type = 'text';
  replaceInput.placeholder = '替换';
  replaceInput.setAttribute('aria-label', '替换');
  replaceInput.value = query.replace;

  const matchCount = document.createElement('span');
  matchCount.className = 'code-mirror-search-panel__count';
  matchCount.setAttribute('aria-live', 'polite');

  const updateMatchCount = (): void => {
    if (!currentQuery.valid || !currentQuery.search) {
      matchCount.textContent = '无结果';
      matchCount.classList.remove('code-mirror-search-panel__count--empty');
      return;
    }

    const matches: Array<{ from: number; to: number }> = [];
    const cursor = currentQuery.getCursor(view.state);
    for (let match = cursor.next(); !match.done; match = cursor.next()) {
      matches.push(match.value);
    }
    const selection = view.state.selection.main;
    const activeIndex = matches.findIndex(match => match.from === selection.from && match.to === selection.to);
    if (matches.length === 0) {
      matchCount.textContent = '无结果';
      matchCount.classList.add('code-mirror-search-panel__count--empty');
      return;
    }

    matchCount.classList.remove('code-mirror-search-panel__count--empty');
    matchCount.textContent = `${activeIndex >= 0 ? activeIndex + 1 : 0} 项，共 ${matches.length} 项`;
  };

  const commit = (): void => {
    const nextQuery = new SearchQuery({
      search: searchInput.value,
      caseSensitive: caseSensitiveButton.getAttribute('aria-pressed') === 'true',
      wholeWord: wholeWordButton.getAttribute('aria-pressed') === 'true',
      regexp: regexpButton.getAttribute('aria-pressed') === 'true',
      replace: replaceInput.value
    });
    if (!nextQuery.eq(currentQuery)) {
      currentQuery = nextQuery;
      view.dispatch({ effects: setSearchQuery.of(nextQuery) });
    }
    updateMatchCount();
  };

  const modeButton = (
    name: string,
    label: string,
    iconClass: string,
    active: boolean
  ): HTMLButtonElement => {
    const button = createButton(name, label, iconClass, () => {
      button.setAttribute('aria-pressed', button.getAttribute('aria-pressed') !== 'true' ? 'true' : 'false');
      commit();
    });
    button.classList.add('code-mirror-search-panel__mode');
    button.setAttribute('aria-pressed', String(active));
    return button;
  };

  const caseSensitiveButton = modeButton('case', '区分大小写', caseSensitiveIcon, query.caseSensitive);
  const wholeWordButton = modeButton('word', '全字匹配', wholeWordIcon, query.wholeWord);
  const regexpButton = modeButton('regexp', '正则表达式', regexpIcon, query.regexp);

  searchInput.addEventListener('input', commit);
  replaceInput.addEventListener('input', commit);

  const searchField = document.createElement('div');
  searchField.className = 'code-mirror-search-panel__field';
  searchField.append(searchInput, caseSensitiveButton, wholeWordButton, regexpButton);

  const syncReplaceInputWidth = (): void => {
    replaceInput.style.width = `${searchField.getBoundingClientRect().width}px`;
  };
  const searchFieldResizeObserver = new ResizeObserver(syncReplaceInputWidth);
  searchFieldResizeObserver.observe(searchField);

  const replaceRow = document.createElement('div');
  replaceRow.className = 'code-mirror-search-panel__replace-row';
  replaceRow.hidden = true;
  const replaceButton = createButton('replace', '替换当前匹配', replaceIcon, () => replaceNext(view));
  const replaceAllButton = createButton('replaceAll', '替换全部匹配', replaceAllIcon, () => replaceAll(view));
  replaceRow.append(replaceInput, replaceButton, replaceAllButton);

  const toggleReplaceButton = createButton('toggle-replace', '展开替换', arrowForwardIcon, () => {
    replaceExpanded = !replaceExpanded;
    replaceRow.hidden = !replaceExpanded;
    toggleReplaceButton.replaceChildren(icon(replaceExpanded ? arrowDownIcon : arrowForwardIcon));
    toggleReplaceButton.setAttribute('aria-label', replaceExpanded ? '收起替换' : '展开替换');
    toggleReplaceButton.title = replaceExpanded ? '收起替换' : '展开替换';
    panel.classList.toggle('code-mirror-search-panel--expanded', replaceExpanded);
  });
  toggleReplaceButton.classList.add('code-mirror-search-panel__toggle');
  toggleReplaceButton.hidden = view.state.readOnly;

  let resizePointerId: number | undefined;
  let resizeStartX = 0;
  let resizeStartWidth = 0;
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'code-mirror-search-panel__resize-handle';
  resizeHandle.setAttribute('role', 'separator');
  resizeHandle.setAttribute('aria-orientation', 'vertical');
  resizeHandle.setAttribute('aria-label', '调整搜索面板宽度');


  const stopResize = (): void => {
    resizePointerId = undefined;
    resizeHandle.classList.remove('code-mirror-search-panel__resize-handle--active');
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');
    window.removeEventListener('pointermove', handleResizeMove);
    window.removeEventListener('pointerup', stopResize);
    window.removeEventListener('pointercancel', stopResize);
  };

  const handleResizeMove = (event: PointerEvent): void => {
    if (resizePointerId !== event.pointerId) return;
    const availableWidth = Math.max(260, view.dom.getBoundingClientRect().width - 16);
    const nextWidth = Math.min(
      Math.max(260, resizeStartWidth - (event.clientX - resizeStartX)),
      Math.min(640, availableWidth)
    );
    panel.style.width = `${nextWidth}px`;
  };

  resizeHandle.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizePointerId = event.pointerId;
    resizeStartX = event.clientX;
    resizeStartWidth = panel.getBoundingClientRect().width;
    resizeHandle.classList.add('code-mirror-search-panel__resize-handle--active');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handleResizeMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  });

  const toolbar = document.createElement('div');
  toolbar.className = 'code-mirror-search-panel__toolbar';
  const actions = document.createElement('div');
  actions.className = 'code-mirror-search-panel__actions';
  actions.append(
    createButton('previous', '上一个匹配项', searchPreviousIcon, () => findPrevious(view)),
    createButton('next', '下一个匹配项', searchNextIcon, () => findNext(view)),
    createButton('select', '选定内容中查找', selectMatchesIcon, () => selectMatches(view)),
    createButton('close', '关闭搜索', closeSearchIcon, () => closeSearchPanel(view))
  );
  toolbar.append(
    resizeHandle,
    toggleReplaceButton,
    searchField,
    matchCount,
    actions
  );
  panel.append(toolbar, replaceRow);

  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSearchPanel(view);
    } else if (event.key === 'Enter' && event.target === searchInput) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(view);
    } else if (event.key === 'Enter' && event.target === replaceInput) {
      event.preventDefault();
      replaceNext(view);
    }
  });

  const update = (update: ViewUpdate): void => {
    for (const transaction of update.transactions) {
      for (const effect of transaction.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(currentQuery)) {
          currentQuery = effect.value;
          searchInput.value = currentQuery.search;
          replaceInput.value = currentQuery.replace;
          caseSensitiveButton.setAttribute('aria-pressed', String(currentQuery.caseSensitive));
          wholeWordButton.setAttribute('aria-pressed', String(currentQuery.wholeWord));
          regexpButton.setAttribute('aria-pressed', String(currentQuery.regexp));
        }
      }
    }
    updateMatchCount();
  };

  return {
    dom: panel,
    top: true,
    mount: () => {
      searchInput.focus();
      searchInput.select();
      syncReplaceInputWidth();
      updateMatchCount();
    },
    update,
    destroy: () => {
      searchFieldResizeObserver.disconnect();
      stopResize();
    }
  };
}
