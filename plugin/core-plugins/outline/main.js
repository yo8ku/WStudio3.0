/**
 * 文件说明：通过公开 Editor SDK 渲染当前 Markdown 文档的大纲树并提供标题定位。
 */

const MARKDOWN_PATH_PATTERN = /\.(?:md|markdown)$/iu;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/u;
const ATX_HEADING_PATTERN = /^ {0,3}(#{1,6})(?:[\t ]+|$)(.*)$/u;
const SETEXT_HEADING_PATTERN = /^ {0,3}(=+|-+)[\t ]*$/u;
const SCROLLBAR_ANIMATION_STEP_MS = 16;

/** 将文档拆分为保留原始偏移量的行。 */
function readLines(content) {
  const lines = [];
  const pattern = /[^\r\n]*(?:\r\n|\r|\n|$)/gu;
  let match;

  while ((match = pattern.exec(content)) && match[0].length > 0) {
    const raw = match[0];
    lines.push({
      text: raw.replace(/(?:\r\n|\r|\n)$/u, ''),
      start: match.index,
      end: match.index + raw.replace(/(?:\r\n|\r|\n)$/u, '').length
    });
  }

  return lines;
}

/** 标记围栏代码块中的行，避免把示例代码解析为标题。 */
function resolveFencedLines(lines) {
  const fenced = new Set();
  let marker;
  let markerLength = 0;

  lines.forEach((line, index) => {
    const match = FENCE_PATTERN.exec(line.text);
    if (!marker) {
      if (!match) return;
      marker = match[1][0];
      markerLength = match[1].length;
      fenced.add(index);
      return;
    }

    fenced.add(index);
    const closingPattern = new RegExp(`^ {0,3}${marker}{${markerLength},}[\\t ]*$`, 'u');
    if (closingPattern.test(line.text)) {
      marker = undefined;
      markerLength = 0;
    }
  });

  return fenced;
}

/** 清除 ATX 标题末尾可选的闭合井号。 */
function normalizeAtxLabel(value) {
  return value.replace(/[\t ]+#+[\t ]*$/u, '').trim();
}

/** 解析 Markdown ATX 与 Setext 标题，并保留可用于编辑器定位的范围。 */
function parseHeadings(content) {
  const lines = readLines(content);
  const fenced = resolveFencedLines(lines);
  const headings = [];

  lines.forEach((line, index) => {
    if (fenced.has(index)) return;
    const atx = ATX_HEADING_PATTERN.exec(line.text);
    if (atx) {
      const label = normalizeAtxLabel(atx[2]);
      if (label) headings.push({ label, level: atx[1].length, start: line.start, end: line.end });
      return;
    }

    const underline = lines[index + 1];
    if (!line.text.trim() || !underline || fenced.has(index + 1)) return;
    const setext = SETEXT_HEADING_PATTERN.exec(underline.text);
    if (setext) {
      headings.push({
        label: line.text.trim(),
        level: setext[1][0] === '=' ? 1 : 2,
        start: line.start,
        end: line.end
      });
    }
  });

  return headings;
}

/** 将扁平标题列表转换为可折叠的父子树。 */
function buildHeadingTree(headings) {
  const root = { level: 0, children: [] };
  const stack = [root];

  headings.forEach(heading => {
    while (stack.length > 1 && stack[stack.length - 1].level >= heading.level) stack.pop();
    const node = { ...heading, key: `${heading.level}:${heading.start}`, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  });

  return root.children;
}

/** 创建宿主注册图标并附加无障碍标签。 */
function createIcon(state, name) {
  const icon = document.createElement('span');
  icon.className = 'outline-icon';
  icon.setAttribute('aria-hidden', 'true');
  state.context.icons.setIcon(icon, name);
  return icon;
}

/** 使用指定路径或圆形构造用户提供的工具栏 SVG 图标。 */
function createToolbarIcon(shapes) {
  const namespace = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(namespace, 'svg');
  icon.classList.add('outline-toolbar__icon');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');
  shapes.forEach(shape => {
    const element = typeof shape === 'string'
      ? document.createElementNS(namespace, 'path')
      : document.createElementNS(namespace, shape.type);
    const attributes = typeof shape === 'string' ? { d: shape } : shape.attributes;
    Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
    icon.append(element);
  });
  return icon;
}

/** 创建工具栏纯图标按钮并绑定无障碍名称。 */
function createToolbarButton(label, icon, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'outline-toolbar__button';
  button.setAttribute('aria-label', label);
  button.append(icon);
  button.addEventListener('click', action);
  return button;
}

/** 更新合并折叠按钮当前呈现的操作与图标。 */
function syncToggleAllButton(button, shouldExpand) {
  const action = shouldExpand ? 'expand' : 'collapse';
  if (button.dataset.action === action) return;
  const label = shouldExpand ? '全部展开' : '全部折叠';
  const shapes = shouldExpand
    ? ['m7 15 5 5 5-5', 'm7 9 5-5 5 5']
    : ['m7 20 5-5 5 5', 'm7 4 5 5 5-5'];
  button.dataset.action = action;
  button.setAttribute('aria-label', label);
  button.replaceChildren(createToolbarIcon(shapes));
}

/** 创建仅覆盖大纲正文的主题化自定义滚动区域。 */
function createOutlineScrollArea(scroller, interactionElement) {
  const container = document.createElement('div');
  const scrollbar = document.createElement('div');
  const thumb = document.createElement('button');
  let resizeObserver;
  let mutationObserver;
  let scheduledSyncFrame = 0;
  let hideScrollbarTimeout = 0;
  let opacityAnimationTimeout = 0;
  let scrollbarOpacity = 0;
  let isPointerInside = false;
  let isPointerInsideThumb = false;
  let activePointerId;
  let dragStartY = 0;
  let dragStartScrollTop = 0;

  container.className = 'outline-scroll-area';
  scrollbar.className = 'outline-scrollbar';
  scrollbar.setAttribute('aria-hidden', 'true');
  thumb.type = 'button';
  thumb.tabIndex = -1;
  thumb.className = 'outline-scrollbar__thumb';
  scrollbar.append(thumb);
  container.append(scroller, scrollbar);

  /** 将 CSS 时间值转换为毫秒。 */
  const readTime = property => {
    const time = getComputedStyle(scrollbar).getPropertyValue(property).trim();
    const value = Number.parseFloat(time);
    if (Number.isNaN(value)) return 0;
    if (time.endsWith('ms')) return value;
    if (time.endsWith('s')) return value * 1000;
    return value;
  };

  /** 读取文件列表同款滚动条可见透明度。 */
  const readVisibleOpacity = () => {
    const value = Number.parseFloat(
      getComputedStyle(scrollbar).getPropertyValue('--outline-scrollbar-thumb-opacity')
    );
    return Number.isNaN(value) ? 0 : value;
  };

  /** 清理等待淡出的计时器。 */
  const clearHideTimeout = () => {
    if (hideScrollbarTimeout === 0) return;
    window.clearTimeout(hideScrollbarTimeout);
    hideScrollbarTimeout = 0;
  };

  /** 清理正在进行的透明度动画。 */
  const clearOpacityAnimation = () => {
    if (opacityAnimationTimeout === 0) return;
    window.clearTimeout(opacityAnimationTimeout);
    opacityAnimationTimeout = 0;
  };

  /** 以文件列表相同的逐帧方式改变滑块透明度。 */
  const animateOpacity = nextOpacity => {
    clearOpacityAnimation();
    const duration = readTime('--outline-scrollbar-fade-duration');
    if (duration <= 0) {
      scrollbarOpacity = nextOpacity;
      thumb.style.opacity = String(nextOpacity);
      scrollbar.classList.toggle('is-interactive', nextOpacity > 0.01);
      return;
    }
    const startOpacity = scrollbarOpacity;
    const deltaOpacity = nextOpacity - startOpacity;
    const steps = Math.max(1, Math.round(duration / SCROLLBAR_ANIMATION_STEP_MS));
    let currentStep = 0;
    const tick = () => {
      currentStep += 1;
      const progress = Math.min(currentStep / steps, 1);
      scrollbarOpacity = Number((startOpacity + deltaOpacity * progress).toFixed(3));
      thumb.style.opacity = scrollbarOpacity.toFixed(3);
      scrollbar.classList.toggle('is-interactive', scrollbarOpacity > 0.01);
      if (progress >= 1) {
        opacityAnimationTimeout = 0;
        return;
      }
      opacityAnimationTimeout = window.setTimeout(tick, SCROLLBAR_ANIMATION_STEP_MS);
    };
    tick();
  };

  /** 立即开始显示滚动条。 */
  const showScrollbar = () => {
    clearHideTimeout();
    if (!scrollbar.classList.contains('is-visible')) return;
    animateOpacity(readVisibleOpacity());
  };

  /** 在鼠标离开后按文件列表节奏延迟淡出。 */
  const scheduleHideScrollbar = () => {
    if (activePointerId !== undefined || isPointerInside || isPointerInsideThumb) return;
    clearHideTimeout();
    hideScrollbarTimeout = window.setTimeout(() => {
      hideScrollbarTimeout = 0;
      animateOpacity(0);
    }, readTime('--outline-scrollbar-fade-out-delay'));
  };

  /** 根据正文尺寸和滚动位置刷新滑块。 */
  const sync = () => {
    const trackHeight = scrollbar.clientHeight;
    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
    const isScrollable = maxScrollTop > 1 && trackHeight > 0;
    scrollbar.classList.toggle('is-visible', isScrollable);
    if (!isScrollable) {
      clearHideTimeout();
      clearOpacityAnimation();
      scrollbarOpacity = 0;
      thumb.style.opacity = '0';
      scrollbar.classList.remove('is-interactive');
      thumb.style.height = '0px';
      thumb.style.transform = 'translateY(0)';
      return;
    }
    thumb.style.height = `${(scroller.clientHeight / scroller.scrollHeight) * trackHeight}px`;
    const thumbHeight = Math.min(trackHeight, thumb.offsetHeight);
    const maxThumbOffset = trackHeight - thumbHeight;
    const thumbOffset = maxThumbOffset <= 0 ? 0 : (scroller.scrollTop / maxScrollTop) * maxThumbOffset;
    thumb.style.transform = `translateY(${thumbOffset}px)`;
  };

  /** 合并同一帧内的滚动条同步请求。 */
  const scheduleSync = () => {
    if (scheduledSyncFrame !== 0) window.cancelAnimationFrame(scheduledSyncFrame);
    scheduledSyncFrame = window.requestAnimationFrame(() => {
      scheduledSyncFrame = 0;
      sync();
    });
  };

  /** 响应正文滚动并刷新淡出计时。 */
  const handleScroll = () => {
    sync();
    showScrollbar();
    if (!isPointerInside) scheduleHideScrollbar();
  };

  /** 鼠标进入大纲时显示滚动条。 */
  const handlePointerEnter = () => {
    isPointerInside = true;
    showScrollbar();
  };

  /** 鼠标离开大纲时启动延迟淡出。 */
  const handlePointerLeave = () => {
    isPointerInside = false;
    scheduleHideScrollbar();
  };

  /** 鼠标进入滑块时保持可见。 */
  const handleThumbPointerEnter = () => {
    isPointerInsideThumb = true;
    showScrollbar();
  };

  /** 鼠标离开滑块时恢复淡出调度。 */
  const handleThumbPointerLeave = () => {
    isPointerInsideThumb = false;
    scheduleHideScrollbar();
  };

  /** 结束滑块拖动并释放窗口级指针监听。 */
  const stopDragging = event => {
    if (event && activePointerId !== event.pointerId) return;
    activePointerId = undefined;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', stopDragging);
    window.removeEventListener('pointercancel', stopDragging);
    if (isPointerInside || isPointerInsideThumb) showScrollbar();
    else scheduleHideScrollbar();
  };

  /** 将滑块拖动距离转换为正文滚动距离。 */
  function handlePointerMove(event) {
    if (activePointerId !== event.pointerId) return;
    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
    const maxThumbOffset = scrollbar.clientHeight - thumb.offsetHeight;
    if (maxScrollTop <= 0 || maxThumbOffset <= 0) return;
    const nextScrollTop = dragStartScrollTop
      + ((event.clientY - dragStartY) / maxThumbOffset) * maxScrollTop;
    scroller.scrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
    sync();
  }

  /** 开始拖动自定义滚动条滑块。 */
  const startDragging = event => {
    event.preventDefault();
    event.stopPropagation();
    activePointerId = event.pointerId;
    dragStartY = event.clientY;
    dragStartScrollTop = scroller.scrollTop;
    showScrollbar();
    thumb.setPointerCapture?.(event.pointerId);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopDragging);
    window.addEventListener('pointercancel', stopDragging);
  };

  /** 窗口失焦时清理指针状态并安排淡出。 */
  const handleWindowBlur = () => {
    isPointerInside = false;
    isPointerInsideThumb = false;
    stopDragging();
    scheduleHideScrollbar();
  };

  scroller.addEventListener('scroll', handleScroll, { passive: true });
  interactionElement.addEventListener('pointerenter', handlePointerEnter);
  interactionElement.addEventListener('pointerleave', handlePointerLeave);
  thumb.addEventListener('pointerenter', handleThumbPointerEnter);
  thumb.addEventListener('pointerleave', handleThumbPointerLeave);
  thumb.addEventListener('pointerdown', startDragging);
  window.addEventListener('blur', handleWindowBlur);
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(scheduleSync);
    resizeObserver.observe(scroller);
    resizeObserver.observe(container);
  }
  if (typeof MutationObserver !== 'undefined') {
    mutationObserver = new MutationObserver(scheduleSync);
    mutationObserver.observe(scroller, { childList: true, subtree: true, characterData: true });
  }
  scheduleSync();

  return {
    element: container,
    /** 释放自定义滚动条持有的观察器和事件。 */
    dispose() {
      stopDragging();
      if (scheduledSyncFrame !== 0) window.cancelAnimationFrame(scheduledSyncFrame);
      clearHideTimeout();
      clearOpacityAnimation();
      scheduledSyncFrame = 0;
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      scroller.removeEventListener('scroll', handleScroll);
      interactionElement.removeEventListener('pointerenter', handlePointerEnter);
      interactionElement.removeEventListener('pointerleave', handlePointerLeave);
      thumb.removeEventListener('pointerenter', handleThumbPointerEnter);
      thumb.removeEventListener('pointerleave', handleThumbPointerLeave);
      thumb.removeEventListener('pointerdown', startDragging);
      window.removeEventListener('blur', handleWindowBlur);
    }
  };
}

/** 收集当前树中真正可以折叠的父标题键。 */
function collectCollapsibleKeys(headings, keys = new Set()) {
  headings.forEach(heading => {
    if (heading.children.length === 0) return;
    keys.add(heading.key);
    collectCollapsibleKeys(heading.children, keys);
  });
  return keys;
}

/** 根据当前折叠状态执行全部展开或全部折叠。 */
function toggleAllHeadings(state) {
  const keys = collectCollapsibleKeys(buildHeadingTree(state.headings));
  const shouldExpand = [...keys].some(key => state.collapsed.has(key));
  if (shouldExpand) state.collapsed.clear();
  else keys.forEach(key => state.collapsed.add(key));
  render(state);
}

/** 根据当前树与折叠集合更新工具栏按钮可用状态。 */
function syncToolbarState(state, headingTree) {
  const keys = collectCollapsibleKeys(headingTree);
  state.collapsed.forEach(key => {
    if (!keys.has(key)) state.collapsed.delete(key);
  });
  const collapsedCount = [...keys].filter(key => state.collapsed.has(key)).length;
  state.toggleAllButton.disabled = keys.size === 0;
  syncToggleAllButton(state.toggleAllButton, collapsedCount > 0);
  state.searchButton.disabled = state.headings.length === 0;
  syncActiveHeadingControl(state);
}

/** 按查询文本保留匹配标题及其祖先路径。 */
function filterHeadingTree(headings, query) {
  if (!query) return headings;
  return headings.flatMap(heading => {
    const children = filterHeadingTree(heading.children, query);
    return heading.label.toLocaleLowerCase().includes(query) || children.length > 0
      ? [{ ...heading, children }]
      : [];
  });
}

/** 返回目标标题的全部祖先键，供滚动前展开路径。 */
function findHeadingAncestorKeys(headings, targetStart, ancestors = []) {
  for (const heading of headings) {
    if (heading.start === targetStart) return ancestors;
    const result = findHeadingAncestorKeys(
      heading.children,
      targetStart,
      [...ancestors, heading.key]
    );
    if (result) return result;
  }
  return undefined;
}

/** 同步搜索框显隐与搜索按钮状态。 */
function syncSearchControl(state) {
  state.searchBox.hidden = !state.searchVisible;
  state.searchButton.classList.toggle('is-active', state.searchVisible);
  state.searchButton.setAttribute('aria-expanded', String(state.searchVisible));
}

/** 切换搜索框；关闭时清除过滤并恢复完整树。 */
function toggleSearch(state) {
  state.searchVisible = !state.searchVisible;
  if (!state.searchVisible) {
    state.searchInput.value = '';
    state.searchQuery = '';
    render(state);
  }
  syncSearchControl(state);
  if (state.searchVisible) queueMicrotask(() => state.searchInput.focus());
}

/** 展开活动标题路径并将其大纲行滚动到列表中央。 */
function scrollToCurrentHeading(state) {
  const active = resolveActiveHeading(state);
  if (!active) return;
  const headingTree = buildHeadingTree(state.headings);
  findHeadingAncestorKeys(headingTree, active.start)?.forEach(key => state.collapsed.delete(key));
  state.searchVisible = false;
  state.searchInput.value = '';
  state.searchQuery = '';
  syncSearchControl(state);
  render(state);
  queueMicrotask(() => {
    state.tree
      ?.querySelector('.outline-item__label.is-active')
      ?.closest('.outline-item__row')
      ?.scrollIntoView({ block: 'center' });
  });
}

/** 根据当前光标位置返回所在标题；标题后的正文归属于最近的前置标题。 */
function resolveActiveHeading(state) {
  if (state.headings.length === 0) return undefined;
  const position = state.document?.selection?.start;
  if (!Number.isSafeInteger(position)) return state.headings[0];
  let active = state.headings[0];
  for (const heading of state.headings) {
    if (heading.start > position) break;
    active = heading;
  }
  return active;
}

/** 解析活动标题并立即同步当前章节定位按钮。 */
function syncActiveHeadingControl(state) {
  const active = resolveActiveHeading(state);
  state.revealCurrentButton.disabled = !active;
  return active;
}

/** 更新已渲染标题的活动状态。 */
function updateActiveHeading(state) {
  const active = syncActiveHeadingControl(state);
  state.tree?.querySelectorAll('.outline-item__label').forEach(element => {
    const isActive = Number(element.dataset.start) === active?.start;
    element.closest('.outline-item__row')?.classList.toggle('is-active', isActive);
    element.classList.toggle('is-active', isActive);
    if (isActive) element.setAttribute('aria-current', 'location');
    else element.removeAttribute('aria-current');
  });
}

/** 调用公开 SDK 将编辑器选区定位到指定标题。 */
async function revealHeading(state, heading) {
  const path = state.document?.path;
  if (!path) return;

  try {
    await state.context.editor.revealRange(
      path,
      { start: heading.start, end: heading.end },
      { verticalAlignment: 'upper-center' }
    );
  } catch (error) {
    state.context.logger.warn('无法定位大纲标题。', {
      code: typeof error?.code === 'string' ? error.code : 'PLUGIN_EDITOR_REVEAL_FAILED'
    });
  }
}

/** 创建单个标题节点及其递归子树。 */
function renderHeadingNode(state, heading, depth) {
  const item = document.createElement('li');
  const row = document.createElement('span');
  const label = document.createElement('button');
  const hasChildren = heading.children.length > 0;
  item.className = 'outline-item';
  item.setAttribute('role', 'treeitem');
  item.setAttribute('aria-level', String(depth + 1));
  row.className = 'outline-item__row';
  row.style.setProperty('--outline-depth', String(depth));
  label.type = 'button';
  label.className = 'outline-item__label';
  label.dataset.start = String(heading.start);
  label.textContent = heading.label;
  label.addEventListener('click', () => void revealHeading(state, heading));

  if (hasChildren) {
    const toggle = document.createElement('button');
    const isCollapsed = !state.searchQuery && state.collapsed.has(heading.key);
    toggle.type = 'button';
    toggle.className = 'outline-item__toggle';
    const toggleLabel = isCollapsed ? '展开' : '折叠';
    toggle.setAttribute('aria-label', toggleLabel);
    toggle.setAttribute('aria-expanded', String(!isCollapsed));
    toggle.append(createIcon(state, 'arrow-forward'));
    toggle.classList.toggle('is-expanded', !isCollapsed);
    toggle.addEventListener('click', () => {
      if (state.collapsed.has(heading.key)) state.collapsed.delete(heading.key);
      else state.collapsed.add(heading.key);
      render(state);
    });
    row.append(toggle, label);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'outline-item__spacer';
    spacer.setAttribute('aria-hidden', 'true');
    row.append(spacer, label);
  }

  item.append(row);
  if (hasChildren && (state.searchQuery || !state.collapsed.has(heading.key))) {
    const group = document.createElement('ul');
    group.className = 'outline-tree outline-tree--nested';
    group.setAttribute('role', 'group');
    heading.children.forEach(child => group.append(renderHeadingNode(state, child, depth + 1)));
    item.append(group);
  }
  return item;
}

/** 根据当前文档状态渲染大纲树或对应空态。 */
function render(state) {
  state.body.replaceChildren();
  state.tree = undefined;
  const headingTree = buildHeadingTree(state.headings);
  const visibleHeadingTree = filterHeadingTree(headingTree, state.searchQuery);
  syncToolbarState(state, headingTree);
  const documentSnapshot = state.document;
  if (!documentSnapshot || !MARKDOWN_PATH_PATTERN.test(documentSnapshot.path)) {
    const empty = document.createElement('p');
    empty.className = 'outline-empty';
    empty.textContent = '当前没有活动的 Markdown 文档';
    state.body.append(empty);
    return;
  }

  if (state.headings.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'outline-empty';
    empty.textContent = '此文档没有标题';
    state.body.append(empty);
    return;
  }

  if (visibleHeadingTree.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'outline-empty';
    empty.textContent = '未找到匹配标题';
    state.body.append(empty);
    return;
  }

  const tree = document.createElement('ul');
  tree.className = 'outline-tree';
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', '文档大纲');
  visibleHeadingTree.forEach(heading => tree.append(renderHeadingNode(state, heading, 0)));
  state.tree = tree;
  state.body.append(tree);
  updateActiveHeading(state);
}

/** 接收活动文档事件，只在正文变化时重新解析标题树。 */
function updateDocument(state, documentSnapshot) {
  const pathChanged = state.document?.path !== documentSnapshot?.path;
  const contentChanged = state.document?.path !== documentSnapshot?.path
    || state.document?.content !== documentSnapshot?.content;
  if (pathChanged) {
    state.searchVisible = false;
    state.searchInput.value = '';
    state.searchQuery = '';
    syncSearchControl(state);
  }
  state.document = documentSnapshot;
  if (contentChanged) {
    state.headings = documentSnapshot && MARKDOWN_PATH_PATTERN.test(documentSnapshot.path)
      ? parseHeadings(documentSnapshot.content)
      : [];
    render(state);
    return;
  }
  updateActiveHeading(state);
}

/** 挂载右侧边栏大纲视图并绑定视图级文档订阅。 */
export async function mountView(context) {
  const shell = document.createElement('section');
  const toolbar = document.createElement('header');
  const searchBox = document.createElement('div');
  const searchInput = document.createElement('input');
  const body = document.createElement('nav');
  shell.className = 'outline-panel';
  toolbar.className = 'outline-toolbar';
  searchBox.className = 'outline-search';
  searchBox.setAttribute('role', 'search');
  searchBox.hidden = true;
  searchInput.type = 'search';
  searchInput.className = 'outline-search__input';
  searchInput.placeholder = '搜索大纲';
  searchInput.setAttribute('aria-label', '搜索大纲');
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;
  searchBox.append(searchInput);
  body.className = 'outline-body';
  body.setAttribute('aria-label', '当前文档大纲');
  const scrollArea = createOutlineScrollArea(body, shell);
  const state = {
    context,
    body,
    collapsed: new Set(),
    document: undefined,
    headings: [],
    revealCurrentButton: undefined,
    searchBox,
    searchButton: undefined,
    searchInput,
    searchQuery: '',
    searchVisible: false,
    toggleAllButton: undefined,
    tree: undefined
  };
  state.searchButton = createToolbarButton(
    '搜索大纲',
    createToolbarIcon([
      'm21 21-4.34-4.34',
      { type: 'circle', attributes: { cx: '11', cy: '11', r: '8' } }
    ]),
    () => toggleSearch(state)
  );
  state.searchButton.setAttribute('aria-expanded', 'false');
  state.revealCurrentButton = createToolbarButton(
    '滚到当前章节',
    createToolbarIcon([
      { type: 'circle', attributes: { cx: '12', cy: '12', r: '3' } },
      'M3 7V5a2 2 0 0 1 2-2h2',
      'M17 3h2a2 2 0 0 1 2 2v2',
      'M21 17v2a2 2 0 0 1-2 2h-2',
      'M7 21H5a2 2 0 0 1-2-2v-2'
    ]),
    () => scrollToCurrentHeading(state)
  );
  state.toggleAllButton = createToolbarButton(
    '全部折叠',
    createToolbarIcon(['m7 20 5-5 5 5', 'm7 4 5 5 5-5']),
    () => toggleAllHeadings(state)
  );
  state.toggleAllButton.dataset.action = 'collapse';
  searchInput.addEventListener('input', () => {
    state.searchQuery = searchInput.value.trim().toLocaleLowerCase();
    render(state);
  });
  searchInput.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    toggleSearch(state);
    state.searchButton.focus();
  });
  toolbar.append(
    state.searchButton,
    state.revealCurrentButton,
    state.toggleAllButton
  );
  shell.append(toolbar, searchBox, scrollArea.element);
  context.view.root.append(shell);

  render(state);
  context.editor.onDidChangeActiveDocument(documentSnapshot => {
    updateDocument(state, documentSnapshot);
  });
  try {
    updateDocument(state, await context.editor.getActiveDocument());
  } catch (error) {
    context.logger.error('读取活动文档失败。', {
      code: typeof error?.code === 'string' ? error.code : 'PLUGIN_EDITOR_READ_FAILED'
    });
    throw error;
  }
  context.subscriptions.add({
    dispose() {
      scrollArea.dispose();
      shell.remove();
    }
  });
}

/** 插件级激活无需注册私有命令，视图完全由 manifest 声明。 */
export function activate() {}

/** 插件级资源由宿主 DisposableStore 统一释放。 */
export function deactivate() {}
