<script setup lang="ts">
/**
 * 文件说明：渲染工作台原生标题栏，并承载窗口控制按钮与拖拽区域。 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { CSSProperties } from 'vue';

const closeWindowIcon = 'icon icon-close';
const checkedIconMarkup = 'icon icon-check-gou-xuan';
const arrowForwardIcon = 'icon icon-arrow-forward';
const maximizeWindowIcon = 'icon icon-max';
const minimizeWindowIcon = 'icon icon-min';
const restoreWindowIcon = 'icon icon-huan-yuan';
const searchIcon = 'icon icon-search';
const settingsMenuIcon = 'icon icon-settings1';
import { windowApi } from '@/api/window';
import { isMacOS } from '@/utils/platform';
import { getWindowMode } from '@/utils/windowMode';
import ProjectColorPicker from '@/components/workbench/ProjectColorPicker.vue';
import WindowControlButton from '@/components/workbench/WindowControlButton.vue';
import WsMenu from '@/components/WsMenu/WsMenu.vue';
import WsSettingsIcon from '@/components/WsSettingsIcon/WsSettingsIcon.vue';
import { useThemeStore } from '@/store/theme';
import {
  DEFAULT_CUSTOM_PROJECT_COLOR,
  recordColorHistory
} from '@/utils/colorPalette';
import { announceContextMenuOpen, registerContextMenu } from '@/utils/contextMenuCoordinator';
import type {
  ProjectColorId,
  ProjectGradientPresentation,
  ProjectGradientStyle
} from '@/types/projectGradient';

const isWindowMaximized = ref(false);
const isMainWorkbench = getWindowMode() === 'workbench';
const themeStore = useThemeStore();
const titleBarMenuVisible = ref(false);
const settingsMenuVisible = ref(false);
const settingsMenuTarget = ref<HTMLElement | null>(null);
const projectColorMenuVisible = ref(false);
const customColorMenuVisible = ref(false);
const projectGradientTarget = ref<HTMLElement | null>(null);
const customProjectColor = ref(DEFAULT_CUSTOM_PROJECT_COLOR);
const customProjectColors = ref<string[]>([]);
const showProjectGradient = ref(true);
const titleBarMenuTarget = ref<[number, number]>([0, 0]);
const titleBarMenuOwner = {};
let disposeTitleBarMenuRegistration: (() => void) | undefined;
let pendingDragPointerId: number | undefined;
let dragAnimationFrame: number | undefined;

interface TitleBarDragState {
  pointerId: number;
  pointerScreenX: number;
  pointerScreenY: number;
  windowX: number;
  windowY: number;
  nextWindowX: number;
  nextWindowY: number;
}

interface ProjectColorOption {
  id: ProjectColorId;
  label: string;
}

let titleBarDragState: TitleBarDragState | undefined;
const selectedProjectColor = ref<ProjectColorId>('grass-green');

defineSlots<{ after: () => unknown; account: () => unknown }>();

const projectColorOptions: readonly ProjectColorOption[] = [
  { id: 'amber', label: '琥珀色' },
  { id: 'olive', label: '橄榄色' },
  { id: 'grass-green', label: '草绿色' },
  { id: 'sea-blue', label: '海蓝色' },
  { id: 'sky-blue', label: '天蓝色' },
  { id: 'cobalt-blue', label: '钴蓝色' },
  { id: 'purple', label: '紫色' },
  { id: 'magenta', label: '紫红色' }
] as const;

const emit = defineEmits<{
  'open-search': [];
  'open-settings': [navigationId?: string];
  'open-repository-manager': [];
  'customize-toolbar': [];
  'add-to-toolbar': [];
  'change-project-color': [];
  'update:project-gradient': [presentation: ProjectGradientPresentation];
}>();

const props = withDefaults(defineProps<{
  minimal?: boolean;
  showWindowControls?: boolean;
  disableMaximize?: boolean;
  controlsDisabled?: boolean;
  title?: string;
  titleClass?: string;
}>(), {
  minimal: false,
  showWindowControls: false,
  disableMaximize: false,
  controlsDisabled: false,
  title: 'WStudio'
});

const titleBarMenuListProps = {
  density: 'compact',
  nav: false
} as const;
const projectColorMenuProps = {
  contentClass: 'ws-menu workbench-title-bar__color-submenu',
  location: 'end',
  openOnClick: true,
  openOnHover: true,
  transition: false
} as const;
const customColorMenuProps = {
  closeOnContentClick: false,
  contentClass: 'workbench-title-bar__color-picker-menu',
  location: 'bottom center',
  transition: false
} as const;
const maximizeButtonLabel = computed(() =>
  (isWindowMaximized.value ? '还原窗口' : '最大化窗口')
);

const maximizeButtonIcon = computed(() =>
  (isWindowMaximized.value ? restoreWindowIcon : maximizeWindowIcon)
);

const projectColorClass = computed(() =>
  `ws-project-gradient--${selectedProjectColor.value}`
);

const projectColorStyle = computed<ProjectGradientStyle | undefined>(() => (
  selectedProjectColor.value === 'custom'
    ? { '--ws-project-color': customProjectColor.value }
    : undefined
));

const customColorSwatchStyle = computed<CSSProperties>(() => ({
  backgroundColor: customProjectColor.value
}));

const customColorMenuTarget = computed(() => projectGradientTarget.value ?? undefined);

/** 色板关闭时记录最终颜色，供后续从色块列表快速复用。 */
watch(customColorMenuVisible, (visible, previousVisible) => {
  if (visible || !previousVisible) return;
  customProjectColors.value = recordColorHistory(customProjectColors.value, customProjectColor.value);
});

/** 在颜色、开关或自定义色值变化时把渐变展示状态同步给工作台父级。 */
watch(
  [showProjectGradient, selectedProjectColor, customProjectColor],
  publishProjectGradientPresentation
);

/**
 * 初始化窗口最大化状态，确保标题栏按钮图标与系统窗口同步。 */
onMounted(async () => {
  if (!props.minimal) {
    publishProjectGradientPresentation();
    disposeTitleBarMenuRegistration = registerContextMenu(titleBarMenuOwner, () => {
      titleBarMenuVisible.value = false;
      settingsMenuVisible.value = false;
      projectColorMenuVisible.value = false;
      customColorMenuVisible.value = false;
    });
  }
  isWindowMaximized.value = await windowApi.isMaximized();
});

/** 向工作台父级发布当前项目渐变的开关、颜色类与自定义色值。 */
function publishProjectGradientPresentation(): void {
  emit('update:project-gradient', {
    enabled: showProjectGradient.value,
    colorClass: projectColorClass.value,
    style: projectColorStyle.value
  });
}

/** 释放标题栏上下文菜单注册，避免窗口重复挂载时残留监听。 */
onBeforeUnmount(() => {
  disposeTitleBarMenuRegistration?.();
  if (dragAnimationFrame !== undefined) cancelAnimationFrame(dragAnimationFrame);
});

/** 判断指针是否来自标题栏中的交互控件。 */
function isInteractiveTitleBarTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest('button, input, [role="button"], [role="menuitem"]') !== null;
}

/** 将当前帧最后一次拖动坐标提交给主进程。 */
function flushWindowMove(): void {
  dragAnimationFrame = undefined;
  if (!titleBarDragState) return;
  void windowApi.moveTo(titleBarDragState.nextWindowX, titleBarDragState.nextWindowY);
}

/** 在标题栏空白区域按下左键时开始窗口拖动。 */
async function beginTitleBarDrag(event: PointerEvent): Promise<void> {
  if (isMacOS) return;
  if (event.button !== 0 || isInteractiveTitleBarTarget(event.target)) return;

  pendingDragPointerId = event.pointerId;
  event.currentTarget instanceof Element && event.currentTarget.setPointerCapture(event.pointerId);
  const [windowX, windowY] = await windowApi.getPosition();
  if (pendingDragPointerId !== event.pointerId) return;

  titleBarDragState = {
    pointerId: event.pointerId,
    pointerScreenX: event.screenX,
    pointerScreenY: event.screenY,
    windowX,
    windowY,
    nextWindowX: windowX,
    nextWindowY: windowY
  };
}

/** 根据指针位移更新窗口目标坐标。 */
function moveTitleBarDrag(event: PointerEvent): void {
  const dragState = titleBarDragState;
  if (!dragState || dragState.pointerId !== event.pointerId) return;

  dragState.nextWindowX = dragState.windowX + event.screenX - dragState.pointerScreenX;
  dragState.nextWindowY = dragState.windowY + event.screenY - dragState.pointerScreenY;
  if (dragAnimationFrame === undefined) {
    dragAnimationFrame = requestAnimationFrame(flushWindowMove);
  }
}

/** 结束标题栏窗口拖动并释放指针捕获。 */
function endTitleBarDrag(event: PointerEvent): void {
  if (pendingDragPointerId !== event.pointerId) return;
  pendingDragPointerId = undefined;
  titleBarDragState = undefined;
  if (event.currentTarget instanceof Element && event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
}

/** 双击标题栏非交互区域时切换窗口最大化状态。 */
function handleTitleBarDoubleClick(event: MouseEvent): void {
  if (isMacOS) return;
  if (props.minimal) return;
  if (event.button !== 0 || isInteractiveTitleBarTarget(event.target)) return;

  pendingDragPointerId = undefined;
  titleBarDragState = undefined;
  if (dragAnimationFrame !== undefined) {
    cancelAnimationFrame(dragAnimationFrame);
    dragAnimationFrame = undefined;
  }
  void toggleWindowMaximize();
}

/** 在鼠标位置打开标题栏上下文菜单。 */
function openTitleBarContextMenu(event: MouseEvent): void {
  if (props.minimal) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  settingsMenuVisible.value = false;
  announceContextMenuOpen(titleBarMenuOwner);
  titleBarMenuTarget.value = [event.clientX, event.clientY];
  titleBarMenuVisible.value = true;
}

/** 执行标题栏上下文菜单动作并关闭菜单。 */
function handleTitleBarMenuAction(action: 'customize-toolbar' | 'add-to-toolbar' | 'change-project-color'): void {
  titleBarMenuVisible.value = false;
  if (action === 'customize-toolbar') {
    emit('customize-toolbar');
  } else if (action === 'add-to-toolbar') {
    emit('add-to-toolbar');
  } else {
    emit('change-project-color');
  }
}

/** 打开标题栏设置菜单。 */
function openSettingsMenu(): void {
  if (props.controlsDisabled) return;

  titleBarMenuVisible.value = false;
  projectColorMenuVisible.value = false;
  customColorMenuVisible.value = false;
  settingsMenuVisible.value = !settingsMenuVisible.value;
  if (settingsMenuVisible.value) announceContextMenuOpen(titleBarMenuOwner);
}

/** 执行标题栏设置菜单动作并关闭菜单。 */
function handleSettingsMenuAction(action: 'settings' | 'plugins' | 'theme' | 'shortcuts' | 'repositories'): void {
  settingsMenuVisible.value = false;
  if (action === 'settings') emit('open-settings');
  else if (action === 'plugins') emit('open-settings', 'plugin-manager');
  else if (action === 'theme') emit('open-settings', 'appearance');
  else if (action === 'shortcuts') emit('open-settings', 'shortcuts');
  else emit('open-repository-manager');
}

/** 切换项目渐变显示状态。 */
function toggleProjectGradient(): void {
  showProjectGradient.value = !showProjectGradient.value;
}

/** 选择项目颜色并关闭标题栏菜单。 */
function selectProjectColor(color: ProjectColorId): void {
  selectedProjectColor.value = color;
  projectColorMenuVisible.value = false;
  titleBarMenuVisible.value = false;
  emit('change-project-color');
}

/** 关闭项目颜色菜单，并在标题栏渐变区域打开自定义色板。 */
async function openCustomColorPicker(): Promise<void> {
  selectedProjectColor.value = 'custom';
  projectColorMenuVisible.value = false;
  titleBarMenuVisible.value = false;
  emit('change-project-color');
  await nextTick();
  customColorMenuVisible.value = true;
}

/** 应用色板输出的自定义颜色并通知工作台颜色发生变化。 */
function updateCustomProjectColor(color: string): void {
  customProjectColor.value = color;
  emit('change-project-color');
}

/**
 * 触发窗口最小化。 */
async function minimizeWindow(): Promise<void> {
  await windowApi.minimize();
}

/**
 * 切换窗口最大化与还原状态，并刷新按钮图标。 */
async function toggleWindowMaximize(): Promise<void> {
  isWindowMaximized.value = await windowApi.toggleMaximize();
}

/**
 * 关闭当前窗口。 */
async function closeWindow(): Promise<void> {
  await windowApi.close();
}
</script>

<template>
 
  <v-sheet
    class="workbench-title-bar"
    :class="[
      { 'workbench-title-bar--minimal': props.minimal },
      { 'workbench-title-bar--modern': themeStore.modernUiEnabled },
      { 'workbench-title-bar--macos': isMacOS },
      props.titleClass
    ]"
    :data-tauri-drag-region="isMacOS ? 'deep' : undefined"
    @contextmenu="openTitleBarContextMenu"
    @pointerdown="beginTitleBarDrag"
    @pointermove="moveTitleBarDrag"
    @pointerup="endTitleBarDrag"
    @pointercancel="endTitleBarDrag"
    @dblclick="handleTitleBarDoubleClick"
  >
    <img v-if="isMainWorkbench && !props.minimal" class="wstudio-log" src="/wslog2.png" />
    <span>{{ props.title }}</span>
    <v-spacer />

    <div
      v-if="!props.minimal"
      class="workbench-title-bar__settings"
    >
      <WindowControlButton
        v-if="!props.minimal"
        label="打开搜索"
        :icon="searchIcon"
        :disabled="props.controlsDisabled"
        @click="emit('open-search')"
      />
      <span ref="settingsMenuTarget" class="workbench-title-bar__settings-trigger">
        <WindowControlButton
          v-if="!props.minimal"
          label="打开设置菜单"
          :disabled="props.controlsDisabled"
          :class="{ 'window-control-button--active': settingsMenuVisible }"
          @click="openSettingsMenu"
        >
          <template #icon>
            <WsSettingsIcon />
          </template>
        </WindowControlButton>
      </span>
    </div>

    <slot v-if="!props.minimal" name="account" />

    <div v-if="!isMacOS" class="workbench-title-bar__controls">
      <WindowControlButton
        label="最小化窗口"
        v-if="!props.minimal || props.showWindowControls"
        :icon="minimizeWindowIcon"
        @click="minimizeWindow"
      />
      <WindowControlButton
        :label="maximizeButtonLabel"
        v-if="!props.minimal || props.showWindowControls"
        :icon="maximizeButtonIcon"
        :disabled="props.disableMaximize"
        @click="toggleWindowMaximize"
      />
      <WindowControlButton
        label="关闭窗口"
        danger
        :icon="closeWindowIcon"
        @click="closeWindow"
        class="window-close"
      />
    </div>

    <WsMenu
      v-if="!props.minimal"
      v-model:open="settingsMenuVisible"
      content-class="workbench-title-bar__settings-menu"
      :target="settingsMenuTarget"
    >
      <v-list v-bind="titleBarMenuListProps">
        <v-list-item title="设置" @click="handleSettingsMenuAction('settings')">
          <template #prepend>
            <span class="workbench-title-bar__menu-icon" aria-hidden="true" :class="settingsMenuIcon" />
          </template>
          <template #append>
            <span class="workbench-title-bar__shortcut">Ctrl + Alt + S</span>
          </template>
        </v-list-item>
        <v-list-item title="插件" @click="handleSettingsMenuAction('plugins')">
          <template #prepend>
            <span class="workbench-title-bar__menu-icon" aria-hidden="true" />
          </template>
        </v-list-item>
        <v-divider />
        <v-list-item title="主题" @click="handleSettingsMenuAction('theme')">
          <template #prepend>
            <span class="workbench-title-bar__menu-icon" aria-hidden="true" />
          </template>
        </v-list-item>
        <v-list-item title="按键映射" @click="handleSettingsMenuAction('shortcuts')">
          <template #prepend>
            <span class="workbench-title-bar__menu-icon" aria-hidden="true" />
          </template>
        </v-list-item>
        <v-divider />
        <v-list-item title="管理仓库" @click="handleSettingsMenuAction('repositories')">
          <template #prepend>
            <span class="workbench-title-bar__menu-icon" aria-hidden="true" />
          </template>
        </v-list-item>
      </v-list>
    </WsMenu>

    <WsMenu
      v-if="!props.minimal"
      v-model:open="titleBarMenuVisible"
      content-class="workbench-title-bar__context-menu"
      :target="titleBarMenuTarget"
    >
      <v-list v-bind="titleBarMenuListProps">
        <v-list-item
          title="自定义工具栏"
          @click="handleTitleBarMenuAction('customize-toolbar')"
        >
          <template #prepend>
            <span
            class="workbench-title-bar__menu-icon"
            aria-hidden="true"
          >
            <WsSettingsIcon />
          </span>
          </template>
        </v-list-item>
        <v-list-item
          title="将操作添加到工具栏"
          @click="handleTitleBarMenuAction('add-to-toolbar')"
        >
          <template #prepend>
            <span class="workbench-title-bar__menu-icon" aria-hidden="true" />
          </template>
        </v-list-item>
        <v-menu v-model="projectColorMenuVisible" v-bind="projectColorMenuProps">
          <template #activator="{ props: submenuProps }">
            <v-list-item
              v-bind="submenuProps"
              title="更换项目颜色"
              :active="projectColorMenuVisible"
            >
              <template #prepend>
                <span class="workbench-title-bar__menu-icon" aria-hidden="true">
                  <span
                    class="workbench-title-bar__color-swatch"
                    :class="[
                      `workbench-title-bar__color-swatch--${selectedProjectColor}`
                    ]"
                    :style="selectedProjectColor === 'custom' ? customColorSwatchStyle : undefined"
                  />
                </span>
              </template>
              <template #append>
                <span
                  class="workbench-title-bar__menu-arrow"
                  aria-hidden="true"
                  :class="arrowForwardIcon"
                />
              </template>
            </v-list-item>
          </template>

          <v-list v-bind="titleBarMenuListProps">
            <v-list-item
              v-for="color in projectColorOptions"
              :key="color.id"
              :title="color.label"
              @click="selectProjectColor(color.id)"
            >
              <template #prepend>
                <span
                  class="workbench-title-bar__color-swatch"
                  :class="`workbench-title-bar__color-swatch--${color.id}`"
                  aria-hidden="true"
                />
              </template>
              <template #append>
                <span class="workbench-title-bar__color-check" aria-hidden="true">
                  <span
                    v-if="selectedProjectColor === color.id"
                    :class="checkedIconMarkup"
                  />
                </span>
              </template>
            </v-list-item>
            <v-divider />
            <v-list-item
              title="自定义颜色"
              @click="openCustomColorPicker"
            >
              <template #prepend>
                <span
                  class="workbench-title-bar__color-swatch"
                  :style="customColorSwatchStyle"
                  aria-hidden="true"
                />
              </template>
            </v-list-item>
          </v-list>
        </v-menu>
        <v-divider />
        <v-list-item
          title="显示项目渐变"
          role="checkbox"
          :aria-checked="showProjectGradient"
          @click="toggleProjectGradient"
        >
          <template #prepend>
            <span
              class="workbench-title-bar__checked-icon"
              aria-hidden="true"
            >
              <span v-if="showProjectGradient" :class="checkedIconMarkup" />
            </span>
          </template>
        </v-list-item>
      </v-list>
    </WsMenu>

    <v-menu
      v-if="!props.minimal"
      v-model="customColorMenuVisible"
      v-bind="customColorMenuProps"
      :target="customColorMenuTarget"
    >
      <ProjectColorPicker
        :custom-colors="customProjectColors"
        :model-value="customProjectColor"
        @update:model-value="updateCustomProjectColor"
      />
    </v-menu>
  </v-sheet>
  <slot
    name="after"
  />
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;
@use '@/assets/styles/mixins' as *;
@use '@/UIStyles/Default/titleBar' as default-title-bar;

@include default-title-bar.apply;

@mixin project-swatch-color($color) {
  background: $color;
}

.wstudio-log {
  width: 28px;
  height: 28px;
}

.workbench-title-bar {
  @include no-drag;
  @include flex-align-center;
  position: relative;
  width: 100%;
  min-height: $title-bar-height;
  padding-inline: $spacing-xs 0;
  background: none;
  user-select: none;
  font-size: 13px;
}

.setting-title {
  background: var(--ws-titleBar-activeBackground);
  color: var(--ws-titleBar-activeForeground, var(--ws-foreground));
  border-bottom: 1px solid var(--ws-dialog-border,var(--ws-border,transparent));

}

.workbench-title-bar--macos {
  // Reserve the native traffic lights and keep trailing actions clear of the corner.
  flex-shrink: 0;
  min-height: max($title-bar-height, 32px);
  padding-inline: 84px 12px;
}

.workbench-title-bar__gradient-target {
  position: absolute;
  inset: 0 auto 0 0;
  width: min($project-color-gradient-width, 100%);
  transform: translateY($project-color-picker-arrow-height);
  pointer-events: none;
}

.workbench-title-bar__controls  {
  @include no-drag;
  display: flex;
  align-items: stretch;
  height: 100%;
  margin-inline-start: $spacing-md;
  :deep(.window-control-button){
    width: 2.75rem;
    height: 100%;
    border-radius: 0;
  }
  :deep(.window-close):hover{
    background-color: red;
    color: #FFF;
    border-top-right-radius: 4px;
  }

}



.workbench-title-bar--minimal .workbench-title-bar__controls {
  margin-inline-start: auto;
}

.workbench-title-bar__settings {
  @include no-drag;
  @include flex-align-center;
  gap: $spacing-md;
  height: 100%;
}

.workbench-title-bar__settings :deep(.window-control-button) {
  width: $window-control-size;
  min-width: $window-control-size;
  border-radius: $radius-3rem;
  color: var(--ws-button-foreground);
}

.workbench-title-bar__settings :deep(.window-control-button:hover) {
  color: var(--ws-button-hoverForeground);
  //background: var(--ws-button-hoverBackground);
}

.workbench-title-bar__settings-trigger {
  display: inline-flex;
  align-items: center;
  height: 100%;
}

.workbench-title-bar :deep(.workbench-login-button.ws-icon-button) {
  width: $window-control-size;
  min-width: $window-control-size;
  height: 100%;
  min-height: 0;
  margin-inline-start: $spacing-md;
  padding: 0;
  border-radius: $radius-3rem;
  color: var(--ws-button-foreground);
  margin-left: $spacing-md;
  &:hover{
    background: transparent;
  }
  &:active{
    background: transparent;
  }
}


:global(.workbench-title-bar__context-menu) {
  min-width: $title-bar-context-menu-min-width;
}

:global(.workbench-title-bar__settings-menu) {
  min-width: $title-bar-context-menu-min-width;
}

:global(.workbench-title-bar__color-submenu) {
  min-width: $title-bar-context-menu-min-width;
}

:global(.workbench-title-bar__context-menu .v-list-item) {
  margin-inline: $spacing-2xs;
  border-radius: $radius-2px;
}

.workbench-title-bar__checked-icon,
.workbench-title-bar__color-check {
  @include flex-center;
  width: $font-size-md;
  height: $font-size-md;
  color: var(--ws-foreground);
}

.workbench-title-bar__checked-icon {
  margin-inline-end: $spacing-xs;
}

.workbench-title-bar__menu-icon {
  @include flex-center;
  width: $font-size-md;
  height: $font-size-md;
  margin-inline-end: $spacing-xs;
  color: var(--ws-foreground);
}

.workbench-title-bar__menu-icon .workbench-title-bar__color-swatch {
  margin-inline-end: 0;
}

.workbench-title-bar__menu-arrow {
  @include flex-center;
  width: $editor-context-menu-arrow-size;
  height: $editor-context-menu-arrow-size;
  color: var(--ws-foreground);
}

.workbench-title-bar__color-swatch {
  width: $project-color-swatch-size;
  height: $project-color-swatch-size;
  margin-inline-end: $spacing-xs;
  border-radius: $radius-2px;
}

.workbench-title-bar__color-swatch--amber {
  @include project-swatch-color($project-color-amber);
}

.workbench-title-bar__color-swatch--olive {
  @include project-swatch-color($project-color-olive);
}

.workbench-title-bar__color-swatch--grass-green {
  @include project-swatch-color($project-color-grass-green);
}

.workbench-title-bar__color-swatch--sea-blue {
  @include project-swatch-color($project-color-sea-blue);
}

.workbench-title-bar__color-swatch--sky-blue {
  @include project-swatch-color($project-color-sky-blue);
}

.workbench-title-bar__color-swatch--cobalt-blue {
  @include project-swatch-color($project-color-cobalt-blue);
}

.workbench-title-bar__color-swatch--purple {
  @include project-swatch-color($project-color-purple);
}

.workbench-title-bar__color-swatch--magenta {
  @include project-swatch-color($project-color-magenta);
}

.workbench-title-bar__checked-icon > span,
.workbench-title-bar__color-check > span {
  @include flex-center;
  width: 100%;
  height: 100%;
}

.workbench-title-bar__shortcut {
  color: var(--ws-descriptionForeground);
  font-size: $font-size-xs;
  white-space: nowrap;
}
</style>
