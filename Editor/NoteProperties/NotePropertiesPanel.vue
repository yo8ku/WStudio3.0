<script setup lang="ts">
/**
 * 文件说明：展示和编辑 Markdown 笔记属性，并将交互结果回写为完整 Frontmatter 文档。
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch
} from 'vue';

const addIcon = '<span class="icon icon-add"></span>';
const aliasesIcon = '<span class="icon icon-corner-down-left"></span>';
const arrowForwardIcon = '<span class="icon icon-arrow-forward"></span>';
const calendarIcon = '<span class="icon icon-calendar"></span>';
const checkboxIcon = '<span class="icon icon-check"></span>';
const checkboxSelectedIcon = '<span class="icon icon-check-gou-xuan"></span>';
const closeIcon = '<span class="icon icon-close"></span>';
const cssClassesIcon = '<span class="icon icon-list"></span>';
const linkIcon = '<span class="icon icon-link"></span>';
const listIcon = '<span class="icon icon-list"></span>';
const numberIcon = '<span class="icon icon-number1"></span>';
const tagsIcon = '<span class="icon icon-tags"></span>';
const textIcon = '<span class="icon icon-text"></span>';
const timeIcon = '<span class="icon icon-time"></span>';
import { announceOverlayOpen, registerOverlay } from '@/utils/contextMenuCoordinator';
import { WORKBENCH_TOOLTIP_OPEN_DELAY } from '@/utils/workbenchTooltip';
import { useNotePropertyTypesStore } from '@/store/notePropertyTypes';
import NotePropertyActionMenu from '@editor/NoteProperties/NotePropertyActionMenu.vue';
import NotePropertyDateInput from '@editor/NoteProperties/NotePropertyDateInput.vue';
import {
  NOTE_PROPERTY_DATE_SEPARATOR,
  NOTE_PROPERTY_DATE_TIME_GAP,
  type NotePropertyDateMode
} from '@editor/NoteProperties/notePropertyDateTime';
import NotePropertyNameEditor from '@editor/NoteProperties/NotePropertyNameEditor.vue';
import {
  createNotePropertyClipboardPayload,
  readNotePropertyClipboardPayload,
  type NotePropertyClipboardPayload,
  writeNotePropertyClipboardPayload
} from '@editor/NoteProperties/notePropertyClipboard';
import {
  normalizeNotePropertyName,
  type NotePropertyDefinition,
  type NotePropertyKey
} from '@editor/NoteProperties/notePropertyDefinitions';
import {
  clearNoteProperties,
  parseNoteDocument,
  removeNoteProperty,
  renameNoteProperty,
  sortNoteProperties,
  updateNotePropertyBoolean,
  updateNotePropertyText,
  updateNotePropertyValues,
  type NotePropertySortDirection
} from '@editor/NoteProperties/noteProperties';
import {
  convertNotePropertyValues,
  normalizeNotePropertyNumber,
  sanitizeNotePropertyNumberInput,
  type NotePropertyType
} from '@editor/NoteProperties/notePropertyTypes';

interface NotePropertiesPanelProps {
  dateNoteCreationPending?: boolean;
  expanded?: boolean;
  menuRequestId?: number;
  modelValue: string;
}

interface NotePropertyValueTarget {
  key: NotePropertyKey;
  valueIndex: number;
}

const props = withDefaults(defineProps<NotePropertiesPanelProps>(), {
  dateNoteCreationPending: false,
  expanded: true,
  menuRequestId: 0
});
const emit = defineEmits<{
  'create-date-note': [date: string];
  'exit-properties': [];
  'request-expand': [];
  'request-hide': [];
  'update:modelValue': [value: string];
}>();
const notePropertyTypesStore = useNotePropertyTypesStore();

const propertiesExpanded = computed(() => props.expanded);
const selectedPropertyValue = ref<NotePropertyValueTarget>();
const editingPropertyValue = ref<NotePropertyValueTarget>();
const editingPropertyValueDraft = ref('');
const clipboardPayload = ref<NotePropertyClipboardPayload>();
const inputValues = reactive<Partial<Record<NotePropertyKey, string>>>(Object.create(null));
const pendingPropertyName = ref<string>();
const headerContextMenuVisible = ref(false);
const headerContextSubmenuVisible = ref(false);
const headerContextMenuTarget = ref<[number, number]>([0, 0]);
const headerContextMenuOwner = {};
let disposeHeaderContextMenuRegistration: (() => void) | undefined;

/** 属性输入组件对外提供的最小聚焦能力。 */
interface NotePropertyInputHandle {
  focus: () => void;
  open?: (activator?: HTMLElement) => void | Promise<void>;
}

const inputHandles: Partial<Record<NotePropertyKey, NotePropertyInputHandle>> = Object.create(null);
const inputValueUpdateSequences: Partial<Record<NotePropertyKey, number>> = Object.create(null);
const editingInputHandle = ref<NotePropertyInputHandle>();
const pendingPropertyInputHandle = ref<NotePropertyInputHandle>();

const valueInputProps = {
  density: 'compact',
  hideDetails: true,
  singleLine: true,
  variant: 'plain'
} as const;
const numberInputRules = [
  (value: unknown): true | string => {
    const inputValue = String(value ?? '').trim();
    return !inputValue || normalizeNotePropertyNumber(inputValue) !== undefined || '请输入有效数字';
  }
] as const;
const numberValueInputProps = {
  ...valueInputProps,
  inputmode: 'decimal',
  rules: numberInputRules
} as const;
/** 文本属性达到该可见行数后保持高度并启用内容滚动。 */
const NOTE_PROPERTY_TEXT_MAX_ROWS = 7;
const textValueInputProps = {
  autoGrow: true,
  density: 'compact',
  hideDetails: true,
  maxRows: NOTE_PROPERTY_TEXT_MAX_ROWS,
  noResize: true,
  rows: 1,
  variant: 'plain',
  wrap: 'soft'
} as const;
const chipProps = {
  closable: true,
  density: 'compact',
  ripple: false,
  size: 'small',
  variant: 'flat'
} as const;
const addButtonProps = {
  density: 'compact',
  ripple: false,
  variant: 'text'
} as const;
const propertyCheckboxProps = {
  density: 'compact',
  hideDetails: true,
  ripple: false
} as const;
const dateLinkButtonProps = {
  density: 'compact',
  icon: true,
  ripple: false,
  variant: 'text'
} as const;
const dateNoteTooltipProps = {
  contentClass: 'workbench-tooltip',
  location: 'bottom',
  openDelay: WORKBENCH_TOOLTIP_OPEN_DELAY,
  text: '创建笔记'
} as const;
const headerContextMenuProps = {
  closeOnContentClick: false,
  contentClass: 'ws-menu note-properties-panel__header-context-menu',
  locationStrategy: 'connected',
  location: 'bottom start',
  openOnClick: false,
  origin: 'top left',
  scrim: false,
  transition: false
} as const;
const headerContextSubmenuProps = {
  closeDelay: 120,
  contentClass: 'ws-menu note-properties-panel__header-context-submenu',
  openDelay: 0,
  openOnHover: true,
  submenu: true,
  transition: false
} as const;
const headerContextMenuListProps = {
  density: 'compact',
  nav: false
} as const;
const headerContextMenuItemProps = {
  ripple: false
} as const;
const propertyIcons: Readonly<Record<string, string>> = {
  aliases: aliasesIcon,
  cssclasses: cssClassesIcon,
  tags: tagsIcon
};
const propertyTypeIcons: Readonly<Partial<Record<NotePropertyType, string>>> = {
  checkbox: checkboxIcon,
  date: calendarIcon,
  datetime: timeIcon,
  list: listIcon,
  number: numberIcon,
  text: textIcon
};

const documentSnapshot = computed(() => parseNoteDocument(props.modelValue));
const visiblePropertyDefinitions = computed<readonly NotePropertyDefinition[]>(() => (
  documentSnapshot.value.propertyKeys.map(key => ({ key, label: key }))
));
const propertyNames = computed(() => (
  visiblePropertyDefinitions.value.map(definition => definition.key)
));
const pasteEnabled = computed(() => Boolean(clipboardPayload.value));

/** 返回属性行图标；自定义属性沿用列表属性图标。 */
function getPropertyIcon(key: NotePropertyKey): string {
  if (notePropertyTypesStore.hasExplicitPropertyType(key)) {
    return propertyTypeIcons[getPropertyType(key)] ?? cssClassesIcon;
  }

  return propertyIcons[key] ?? cssClassesIcon;
}

/** 返回 Store 中持久化的属性类型；未设置属性默认按列表展示。 */
function getPropertyType(key: NotePropertyKey): NotePropertyType {
  return notePropertyTypesStore.getPropertyType(key);
}

/** 判断属性是否使用统一日期输入控件。 */
function isDatePropertyType(key: NotePropertyKey): boolean {
  const type = getPropertyType(key);
  return type === 'date' || type === 'datetime';
}

/** 返回日期输入控件所需的精度模式。 */
function getDatePropertyMode(key: NotePropertyKey): NotePropertyDateMode {
  return getPropertyType(key) === 'datetime' ? 'datetime' : 'date';
}

/** 从当前文档读取指定属性唯一的布尔状态。 */
function isPropertyChecked(key: NotePropertyKey): boolean {
  return documentSnapshot.value.properties[key]?.[0]?.trim().toLowerCase() === 'true';
}

/** 将指定属性的唯一布尔状态写回 Frontmatter。 */
function setPropertyChecked(key: NotePropertyKey, checked: boolean | null): void {
  emit(
    'update:modelValue',
    updateNotePropertyBoolean(props.modelValue, key, Boolean(checked))
  );
}

/** 提交属性输入值；数字和文本覆盖唯一值，其他类型追加为可重复标签。 */
function commitInputValue(key: NotePropertyKey): void {
  const type = getPropertyType(key);
  const currentValue = documentSnapshot.value.properties[key]?.[0] ?? '';
  const inputValue = inputValues[key] ?? (type === 'number' || type === 'text' ? currentValue : '');
  const isNumber = type === 'number';
  const value = isNumber ? normalizeNotePropertyNumber(inputValue) : inputValue;
  if (isNumber) {
    emit(
      'update:modelValue',
      updateNotePropertyValues(props.modelValue, key, value ? [value] : [])
    );
    inputValues[key] = value ?? '';
    return;
  }

  if (type === 'text') {
    emit('update:modelValue', updateNotePropertyText(props.modelValue, key, inputValue));
    inputValues[key] = inputValue;
    return;
  }

  if (!inputValue.trim()) {
    return;
  }

  emit(
    'update:modelValue',
    updateNotePropertyValues(props.modelValue, key, [
      ...(documentSnapshot.value.properties[key] ?? []),
      inputValue.trim()
    ])
  );
  inputValues[key] = '';
}

/** 判断目标是否指向指定属性标签。 */
function isSamePropertyValueTarget(
  target: NotePropertyValueTarget | undefined,
  key: NotePropertyKey,
  valueIndex: number
): boolean {
  return target?.key === key && target.valueIndex === valueIndex;
}

/** 判断指定属性标签当前是否处于单击选中状态。 */
function isPropertyValueSelected(key: NotePropertyKey, valueIndex: number): boolean {
  return isSamePropertyValueTarget(selectedPropertyValue.value, key, valueIndex);
}

/** 判断指定属性标签当前是否处于双击编辑状态。 */
function isPropertyValueEditing(key: NotePropertyKey, valueIndex: number): boolean {
  return isSamePropertyValueTarget(editingPropertyValue.value, key, valueIndex);
}

/** 单击属性标签时切换当前边框选中目标。 */
function selectPropertyValue(key: NotePropertyKey, valueIndex: number): void {
  selectedPropertyValue.value = { key, valueIndex };
}

/** 双击属性标签后切换为原位置输入框并聚焦。 */
async function beginPropertyValueEditing(
  key: NotePropertyKey,
  valueIndex: number,
  value: string,
  shouldFocus = true
): Promise<void> {
  selectedPropertyValue.value = { key, valueIndex };
  editingPropertyValue.value = { key, valueIndex };
  editingPropertyValueDraft.value = value;
  await nextTick();
  if (shouldFocus) {
    editingInputHandle.value?.focus();
  }
}

/** 单击日期图标时进入编辑态并直接打开日期选择面板。 */
async function openDatePropertyPicker(
  event: Event,
  key: NotePropertyKey,
  valueIndex: number,
  value: string
): Promise<void> {
  const activator = event.currentTarget instanceof HTMLElement
    ? event.currentTarget
    : undefined;
  if (!isPropertyValueEditing(key, valueIndex)) {
    await beginPropertyValueEditing(key, valueIndex, value, false);
  }
  await editingInputHandle.value?.open?.(activator);
}

/** 请求工作台为指定日期创建并打开 Markdown 笔记。 */
function requestDateNoteCreation(date: string): void {
  if (props.dateNoteCreationPending) return;
  emit('create-date-note', date);
}

/** 保存属性标签编辑值；空内容恢复原标签。 */
function commitPropertyValueEditing(committedValue?: string): void {
  const target = editingPropertyValue.value;
  if (!target) {
    return;
  }

  const nextValue = (committedValue ?? editingPropertyValueDraft.value).trim();
  editingPropertyValue.value = undefined;
  editingPropertyValueDraft.value = '';

  if (!nextValue) {
    return;
  }

  const nextValues = [...(documentSnapshot.value.properties[target.key] ?? [])];
  if (target.valueIndex >= nextValues.length) {
    selectedPropertyValue.value = undefined;
    return;
  }

  nextValues[target.valueIndex] = nextValue;
  emit(
    'update:modelValue',
    updateNotePropertyValues(props.modelValue, target.key, nextValues)
  );
}

/** 返回当前属性输入框配置；数字类型启用数字键盘和统一校验。 */
function getValueInputProps(key: NotePropertyKey): typeof valueInputProps | typeof numberValueInputProps {
  return getPropertyType(key) === 'number' ? numberValueInputProps : valueInputProps;
}

/** 更新新增值输入；数字类型会在 Vuetify 接收原始值后强制写回过滤结果。 */
async function updateInputValue(key: NotePropertyKey, value: unknown): Promise<void> {
  const inputValue = String(value ?? '');
  if (getPropertyType(key) !== 'number') {
    inputValues[key] = inputValue;
    return;
  }

  const updateSequence = (inputValueUpdateSequences[key] ?? 0) + 1;
  const sanitizedValue = sanitizeNotePropertyNumberInput(inputValue);
  inputValueUpdateSequences[key] = updateSequence;
  inputValues[key] = inputValue;
  if (sanitizedValue === inputValue) {
    return;
  }

  await nextTick();
  if (inputValueUpdateSequences[key] === updateSequence && getPropertyType(key) === 'number') {
    inputValues[key] = sanitizedValue;
  }
}

/** 更新通用标签编辑框中的草稿值。 */
function updateEditingPropertyValue(value: unknown): void {
  editingPropertyValueDraft.value = String(value ?? '');
}

/** 在字符进入输入框前拒绝不符合数字格式的键盘输入。 */
function handleNumberInputKeydown(event: KeyboardEvent, key: NotePropertyKey): void {
  if (
    getPropertyType(key) !== 'number'
    || event.ctrlKey
    || event.metaKey
    || event.altKey
    || event.key.length !== 1
  ) {
    return;
  }

  const input = event.target;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }

  const selectionStart = input.selectionStart ?? input.value.length;
  const selectionEnd = input.selectionEnd ?? selectionStart;
  const candidateValue = `${input.value.slice(0, selectionStart)}${event.key}${input.value.slice(selectionEnd)}`;
  if (sanitizeNotePropertyNumberInput(candidateValue) !== candidateValue) {
    event.preventDefault();
  }
}

/** 返回空属性输入框的类型化占位文案。 */
function getPropertyInputPlaceholder(key: NotePropertyKey): string | undefined {
  if ((documentSnapshot.value.properties[key]?.length ?? 0) > 0) {
    return undefined;
  }

  return '内容为空';
}

/** 取消属性标签编辑并恢复原标签。 */
function cancelPropertyValueEditing(): void {
  editingPropertyValue.value = undefined;
  editingPropertyValueDraft.value = '';
}

/** 编辑输入框失去焦点时自动保存标签内容。 */
function handlePropertyValueEditorFocusUpdate(focused: boolean): void {
  if (!focused) {
    commitPropertyValueEditing();
  }
}

/** 收集标签编辑输入组件的公开聚焦句柄。 */
function setEditingInputHandle(instance: unknown): void {
  if (
    instance
    && typeof instance === 'object'
    && 'focus' in instance
    && typeof instance.focus === 'function'
  ) {
    editingInputHandle.value = instance as NotePropertyInputHandle;
    return;
  }

  editingInputHandle.value = undefined;
}

/** 收集每个属性输入组件的公开聚焦句柄。 */
function setInputHandle(key: NotePropertyKey, instance: unknown): void {
  if (
    instance
    && typeof instance === 'object'
    && 'focus' in instance
    && typeof instance.focus === 'function'
  ) {
    inputHandles[key] = instance as NotePropertyInputHandle;
    return;
  }

  delete inputHandles[key];
}

/** 等待浏览器完成一次布局与绘制调度。 */
function waitForAnimationFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

/** 在父级文档更新和 Vuetify 重排完成后恢复属性输入焦点。 */
async function restoreInputFocus(key: NotePropertyKey, eventTarget: EventTarget | null): Promise<void> {
  await nextTick();
  await waitForAnimationFrame();
  await waitForAnimationFrame();

  if (eventTarget instanceof HTMLInputElement && eventTarget.isConnected) {
    eventTarget.focus();
    return;
  }

  inputHandles[key]?.focus();
}

/**
 * 普通回车提交标签并保持当前输入焦点；Shift+Enter 提交后退出属性区域。
 */
async function handleInputEnter(event: KeyboardEvent, key: NotePropertyKey): Promise<void> {
  if (isInputMethodComposition(event)) {
    return;
  }

  event.stopPropagation();
  event.preventDefault();
  commitInputValue(key);

  if (event.shiftKey) {
    await nextTick();
    emit('exit-properties');
    return;
  }

  await restoreInputFocus(key, event.target);
}

/** 识别输入法候选确认事件，避免将候选确认误判为标签提交。 */
function isInputMethodComposition(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** 阻止普通 Enter 的 keyup 继续传播，同时保留输入法候选确认。 */
function handleInputEnterKeyup(event: KeyboardEvent): void {
  if (isInputMethodComposition(event)) {
    return;
  }

  event.stopPropagation();
  event.preventDefault();
}

/** 处理标签编辑框回车，仅在输入法组合结束后保存。 */
function handlePropertyValueEditorEnter(event: KeyboardEvent): void {
  if (isInputMethodComposition(event)) {
    return;
  }

  event.stopPropagation();
  event.preventDefault();
  commitPropertyValueEditing();
}

/** 处理标签编辑框取消操作，输入法组合期间由输入法自行消费 Escape。 */
function handlePropertyValueEditorEscape(event: KeyboardEvent): void {
  if (isInputMethodComposition(event)) {
    return;
  }

  event.stopPropagation();
  event.preventDefault();
  cancelPropertyValueEditing();
}

/** 输入框失去焦点时，将尚未确认的内容自动转换为标签。 */
function handleInputFocusUpdate(focused: boolean, key: NotePropertyKey): void {
  if (focused) {
    selectedPropertyValue.value = undefined;
    return;
  }

  commitInputValue(key);
}

/** 从指定属性中移除一个标签值。 */
function removePropertyValue(key: NotePropertyKey, valueIndex: number): void {
  selectedPropertyValue.value = undefined;
  editingPropertyValue.value = undefined;
  editingPropertyValueDraft.value = '';
  emit(
    'update:modelValue',
    updateNotePropertyValues(
      props.modelValue,
      key,
      (documentSnapshot.value.properties[key] ?? []).filter((_, index) => index !== valueIndex)
    )
  );
}

/** 清理与指定属性关联的临时输入、选中和编辑状态。 */
function resetPropertyInteraction(key: NotePropertyKey): void {
  inputValues[key] = '';

  if (selectedPropertyValue.value?.key === key) {
    selectedPropertyValue.value = undefined;
  }

  if (editingPropertyValue.value?.key === key) {
    editingPropertyValue.value = undefined;
    editingPropertyValueDraft.value = '';
  }
}

/** 重命名属性并迁移类型和输入状态。 */
function renameProperty(key: NotePropertyKey, nextKey: NotePropertyKey): void {
  const normalizedNextKey = normalizeNotePropertyName(nextKey);
  if (
    !normalizedNextKey
    || normalizedNextKey === key
    || propertyNames.value.some(name => name !== key && name === normalizedNextKey)
  ) {
    return;
  }

  resetPropertyInteraction(key);
  notePropertyTypesStore.copyPropertyType(key, normalizedNextKey);
  inputValues[normalizedNextKey] = inputValues[key] ?? '';
  delete inputValues[key];
  emit(
    'update:modelValue',
    renameNoteProperty(props.modelValue, key, normalizedNextKey)
  );
}

/** 判断临时属性名称是否可写入当前 Frontmatter。 */
function isPendingPropertyNameValid(): boolean {
  const name = normalizeNotePropertyName(pendingPropertyName.value ?? '');
  return Boolean(name) && !propertyNames.value.includes(name);
}

/** 收集临时属性名称输入组件的聚焦句柄。 */
function setPendingPropertyInputHandle(instance: unknown): void {
  if (
    instance
    && typeof instance === 'object'
    && 'focus' in instance
    && typeof instance.focus === 'function'
  ) {
    pendingPropertyInputHandle.value = instance as NotePropertyInputHandle;
    return;
  }

  pendingPropertyInputHandle.value = undefined;
}

/** 点击底部按钮后创建临时空属性行并自动聚焦名称输入框。 */
async function addEmptyProperty(): Promise<void> {
  if (!propertiesExpanded.value) {
    emit('request-expand');
    await nextTick();
  }

  pendingPropertyName.value = '';
  await nextTick();
  pendingPropertyInputHandle.value?.focus();
}

/** 保存临时属性名称并创建空属性值数组。 */
function commitPendingPropertyName(): void {
  if (!isPendingPropertyNameValid()) {
    pendingPropertyInputHandle.value?.focus();
    return;
  }

  const key = normalizeNotePropertyName(pendingPropertyName.value ?? '');
  pendingPropertyName.value = undefined;
  emit('update:modelValue', updateNotePropertyValues(props.modelValue, key, []));
}

/** 取消临时属性行，不写入文档。 */
function cancelPendingPropertyName(): void {
  pendingPropertyName.value = undefined;
}

/** 处理临时属性名称输入的回车和失焦。 */
function handlePendingPropertyNameKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    commitPendingPropertyName();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    cancelPendingPropertyName();
  }
}

/** 临时名称失焦时保存合法名称，空内容则取消。 */
function handlePendingPropertyNameFocusUpdate(focused: boolean): void {
  if (!focused && pendingPropertyName.value !== undefined) {
    if (isPendingPropertyNameValid()) {
      commitPendingPropertyName();
    } else {
      cancelPendingPropertyName();
    }
  }
}

/** 属性菜单打开时读取系统剪贴板中的合法属性载荷。 */
async function refreshPropertyClipboard(): Promise<void> {
  clipboardPayload.value = await readNotePropertyClipboardPayload();
}

/** 将当前属性及其会话类型写入属性剪贴板。 */
async function copyProperty(key: NotePropertyKey): Promise<void> {
  const payload = createNotePropertyClipboardPayload(
    key,
    getPropertyType(key),
    documentSnapshot.value.properties[key] ?? []
  );
  clipboardPayload.value = payload;
  await writeNotePropertyClipboardPayload(payload);
}

/** 剪切当前属性：先可靠写入剪贴板，再从 Frontmatter 移除。 */
async function cutProperty(key: NotePropertyKey): Promise<void> {
  await copyProperty(key);
  removeProperty(key);
}

/** 使用剪贴板载荷覆盖当前属性值和当前会话中的属性类型。 */
async function pasteProperty(key: NotePropertyKey): Promise<void> {
  const payload = await readNotePropertyClipboardPayload();
  clipboardPayload.value = payload;

  if (!payload) {
    return;
  }

  resetPropertyInteraction(key);
  notePropertyTypesStore.setPropertyType(key, payload.type);
  emit(
    'update:modelValue',
    payload.type === 'checkbox'
      ? updateNotePropertyBoolean(
        props.modelValue,
        key,
        payload.values[0]?.trim().toLowerCase() === 'true'
      )
      : payload.type === 'text'
        ? updateNotePropertyText(props.modelValue, key, payload.values.join('\n'))
        : updateNotePropertyValues(props.modelValue, key, payload.values)
  );
}

/** 从 Frontmatter 中完整移除指定属性行。 */
function removeProperty(key: NotePropertyKey): void {
  resetPropertyInteraction(key);
  emit('update:modelValue', removeNoteProperty(props.modelValue, key));
}

/** 更新指定属性在当前文档会话中的展示类型。 */
function selectPropertyType(key: NotePropertyKey, type: NotePropertyType): void {
  resetPropertyInteraction(key);
  notePropertyTypesStore.setPropertyType(key, type);

  const currentValues = documentSnapshot.value.properties[key] ?? [];
  if (type === 'checkbox') {
    const checked = currentValues[0]?.trim().toLowerCase() === 'true';
    emit('update:modelValue', updateNotePropertyBoolean(props.modelValue, key, checked));
    return;
  }

  const convertedValues = convertNotePropertyValues(type, currentValues);
  emit(
    'update:modelValue',
    type === 'text'
      ? updateNotePropertyText(props.modelValue, key, convertedValues[0] ?? '')
      : updateNotePropertyValues(props.modelValue, key, convertedValues)
  );
}

/** 响应 Store 发出的添加属性请求，直接创建临时空属性行。 */
async function openRequestedMenu(): Promise<void> {
  await addEmptyProperty();
}

/** 打开笔记属性头部右键菜单，并关闭其他工作台浮层。 */
function openHeaderContextMenu(event: MouseEvent): void {
  event.preventDefault();
  announceOverlayOpen(headerContextMenuOwner);
  headerContextSubmenuVisible.value = false;
  headerContextMenuTarget.value = [event.clientX, event.clientY];
  headerContextMenuVisible.value = true;
}

/** 关闭笔记属性头部菜单及其排序二级菜单。 */
function closeHeaderContextMenu(): void {
  headerContextSubmenuVisible.value = false;
  headerContextMenuVisible.value = false;
}

/** 从头部右键菜单新增空属性，并将焦点交给名称输入框。 */
async function addPropertyFromHeaderContextMenu(): Promise<void> {
  closeHeaderContextMenu();
  await addEmptyProperty();
}

/** 按指定方向持久化属性名称顺序并关闭头部菜单。 */
function sortPropertiesFromHeaderContextMenu(direction: NotePropertySortDirection): void {
  closeHeaderContextMenu();
  emit('update:modelValue', sortNoteProperties(props.modelValue, direction));
}

/** 清除完整属性块，并请求编辑器隐藏对应 CodeMirror 块。 */
function clearPropertiesFromHeaderContextMenu(): void {
  closeHeaderContextMenu();
  emit('update:modelValue', clearNoteProperties(props.modelValue));
  emit('request-hide');
}

/** 维护头部菜单和排序二级菜单的联动可见状态。 */
function handleHeaderContextMenuVisibility(visible: boolean): void {
  headerContextMenuVisible.value = visible;
  if (!visible) {
    headerContextSubmenuVisible.value = false;
  }
}

onMounted(() => {
  disposeHeaderContextMenuRegistration = registerOverlay(
    headerContextMenuOwner,
    closeHeaderContextMenu
  );
});

onBeforeUnmount(() => {
  disposeHeaderContextMenuRegistration?.();
  disposeHeaderContextMenuRegistration = undefined;
});

watch(() => props.menuRequestId, (requestId) => {
  if (requestId > 0) {
    void openRequestedMenu();
  }
}, { immediate: true });

/** 块从 gutter 折叠时清理仅属于展开视图的临时交互状态。 */
watch(() => props.expanded, (expanded) => {
  if (expanded) {
    return;
  }

  pendingPropertyName.value = undefined;
  selectedPropertyValue.value = undefined;
  editingPropertyValue.value = undefined;
  editingPropertyValueDraft.value = '';
});

</script>

<template>
  <v-sheet class="note-properties-panel">
    <header
      class="note-properties-panel__header"
      @contextmenu.stop.prevent="openHeaderContextMenu"
    >
      笔记属性
    </header>

    <!-- S = 笔记属性头部右键菜单 -->
    <v-menu
      v-model="headerContextMenuVisible"
      v-bind="headerContextMenuProps"
      :target="headerContextMenuTarget"
      @update:model-value="handleHeaderContextMenuVisibility"
    >
      <v-list v-bind="headerContextMenuListProps">
        <v-list-item
          v-bind="headerContextMenuItemProps"
          title="增加笔记属性"
          @click="addPropertyFromHeaderContextMenu"
        />

        <v-divider />

        <v-menu
          v-model="headerContextSubmenuVisible"
          v-bind="headerContextSubmenuProps"
        >
          <template #activator="{ props: submenuProps }">
            <v-list-item
              v-bind="{ ...submenuProps, ...headerContextMenuItemProps }"
              :active="headerContextSubmenuVisible"
              title="排序"
            >
              <template #append>
                <span
                  class="note-properties-panel__header-context-arrow"
                  aria-hidden="true"
                  v-html="arrowForwardIcon"
                />
              </template>
            </v-list-item>
          </template>

          <v-list v-bind="headerContextMenuListProps">
            <v-list-item
              v-bind="headerContextMenuItemProps"
              title="名称 (A-Z)"
              @click="sortPropertiesFromHeaderContextMenu('ascending')"
            />
            <v-list-item
              v-bind="headerContextMenuItemProps"
              title="名称 (Z-A)"
              @click="sortPropertiesFromHeaderContextMenu('descending')"
            />
          </v-list>
        </v-menu>

        <v-divider />

        <v-list-item
          v-bind="headerContextMenuItemProps"
          title="清除笔记属性"
          @click="clearPropertiesFromHeaderContextMenu"
        />
      </v-list>
    </v-menu>
    <!-- E = 笔记属性头部右键菜单 -->

    <section
      v-for="definition in visiblePropertyDefinitions"
      :key="definition.key"
      v-show="propertiesExpanded"
      class="note-properties-panel__row"
    >
      <!-- S = 属性操作菜单 -->
      <NotePropertyActionMenu
        :icon="getPropertyIcon(definition.key)"
        :label="definition.label"
        :paste-enabled="pasteEnabled"
        :property-type="getPropertyType(definition.key)"
        @copy="copyProperty(definition.key)"
        @cut="cutProperty(definition.key)"
        @menu-open="refreshPropertyClipboard"
        @paste="pasteProperty(definition.key)"
        @remove="removeProperty(definition.key)"
        @select-type="selectPropertyType(definition.key, $event)"
      />
      <!-- E = 属性操作菜单 -->
      <!-- S = 属性名称编辑器 -->
      <NotePropertyNameEditor
        :existing-names="propertyNames"
        :model-value="definition.key"
        @save="renameProperty(definition.key, $event)"
      />
      <!-- E = 属性名称编辑器 -->
      <span class="note-properties-panel__values">
        <v-checkbox-btn
          v-if="getPropertyType(definition.key) === 'checkbox'"
          v-bind="propertyCheckboxProps"
          class="note-properties-panel__checkbox"
          :model-value="isPropertyChecked(definition.key)"
          :aria-label="`${definition.label}选择框`"
          @click.stop
          @update:model-value="setPropertyChecked(definition.key, $event)"
        >
          <template #input="{ inputNode }">
            <component :is="inputNode" />
            <span
              v-if="isPropertyChecked(definition.key)"
              class="note-properties-panel__checkbox-selected-icon"
              aria-hidden="true"
              v-html="checkboxSelectedIcon"
            />
          </template>
        </v-checkbox-btn>
        <v-text-field
          v-else-if="getPropertyType(definition.key) === 'number'"
          :ref="instance => setInputHandle(definition.key, instance)"
          :model-value="inputValues[definition.key] ?? documentSnapshot.properties[definition.key]?.[0] ?? ''"
          v-bind="getValueInputProps(definition.key)"
          class="note-properties-panel__input"
          placeholder="没有值"
          @keydown="handleNumberInputKeydown($event, definition.key)"
          @keydown.enter="handleInputEnter($event, definition.key)"
          @keyup.enter="handleInputEnterKeyup"
          @update:model-value="updateInputValue(definition.key, $event)"
          @update:focused="handleInputFocusUpdate($event, definition.key)"
        />
        <v-textarea
          v-else-if="getPropertyType(definition.key) === 'text'"
          :ref="instance => setInputHandle(definition.key, instance)"
          :model-value="inputValues[definition.key] ?? documentSnapshot.properties[definition.key]?.[0] ?? ''"
          v-bind="textValueInputProps"
          class="note-properties-panel__input note-properties-panel__text-input"
          placeholder="内容为空"
          @update:model-value="updateInputValue(definition.key, $event)"
          @update:focused="handleInputFocusUpdate($event, definition.key)"
        />
        <template
          v-else
          v-for="(value, valueIndex) in documentSnapshot.properties[definition.key]"
          :key="`${definition.key}-${value}-${valueIndex}`"
        >
          <span
            v-if="isDatePropertyType(definition.key)"
            class="note-properties-panel__date-control"
            :class="{
              'note-properties-panel__date-control--datetime': getPropertyType(definition.key) === 'datetime'
            }"
          >
            <span
              class="note-properties-panel__date-icon"
              role="button"
              tabindex="0"
              aria-label="打开日期选择器"
              v-html="calendarIcon"
              @click.stop="openDatePropertyPicker(
                $event,
                definition.key,
                valueIndex,
                value
              )"
              @keydown.enter.stop.prevent="openDatePropertyPicker(
                $event,
                definition.key,
                valueIndex,
                value
              )"
            />
            <NotePropertyDateInput
              v-if="isPropertyValueEditing(definition.key, valueIndex)"
              :ref="setEditingInputHandle"
              v-model="editingPropertyValueDraft"
              :mode="getDatePropertyMode(definition.key)"
              @cancel="cancelPropertyValueEditing"
              @save="commitPropertyValueEditing"
            />
            <span
              v-else
              class="note-properties-panel__date"
              @click.stop="selectPropertyValue(definition.key, valueIndex)"
              @dblclick.stop.prevent="beginPropertyValueEditing(
                definition.key,
                valueIndex,
                value
              )"
            >
              <span
                class="note-properties-panel__date-year"
                @click.stop="beginPropertyValueEditing(
                  definition.key,
                  valueIndex,
                  value
                )"
              >{{ value.slice(0, 4) }}</span>
              <span class="note-properties-panel__date-separator">{{ NOTE_PROPERTY_DATE_SEPARATOR }}</span>
              <span class="note-properties-panel__date-value">{{ value.slice(5, 7) }}</span>
              <span class="note-properties-panel__date-separator">{{ NOTE_PROPERTY_DATE_SEPARATOR }}</span>
              <span class="note-properties-panel__date-value">{{ value.slice(8, 10) }}</span>
              <template v-if="getPropertyType(definition.key) === 'datetime'">
                <span class="note-properties-panel__date-value note-properties-panel__date-value--time">{{ `${NOTE_PROPERTY_DATE_TIME_GAP}${value.slice(11, 13)}` }}</span>
                <span class="note-properties-panel__date-time-separator">:</span>
                <span class="note-properties-panel__date-value">{{ value.slice(14, 16) }}</span>
              </template>
            </span>
            <v-tooltip
              v-if="getPropertyType(definition.key) === 'date'"
              v-bind="dateNoteTooltipProps"
            >
              <template #activator="{ props: tooltipProps }">
                <v-btn
                  v-bind="{ ...tooltipProps, ...dateLinkButtonProps }"
                  class="note-properties-panel__date-link"
                  :disabled="dateNoteCreationPending"
                  aria-label="创建笔记"
                  @click.stop="requestDateNoteCreation(value)"
                >
                  <span
                    class="note-properties-panel__date-link-icon"
                    aria-hidden="true"
                    v-html="linkIcon"
                  />
                </v-btn>
              </template>
            </v-tooltip>
          </span>
          <v-text-field
            v-if="isPropertyValueEditing(definition.key, valueIndex)
              && !isDatePropertyType(definition.key)"
            :ref="setEditingInputHandle"
            :model-value="editingPropertyValueDraft"
            v-bind="getValueInputProps(definition.key)"
            class="note-properties-panel__chip-editor"
            @keydown.enter="handlePropertyValueEditorEnter"
            @keydown.esc="handlePropertyValueEditorEscape"
            @keyup.enter="handleInputEnterKeyup"
            @update:model-value="updateEditingPropertyValue"
            @update:focused="handlePropertyValueEditorFocusUpdate"
          />
          <v-chip
            v-if="!isPropertyValueEditing(definition.key, valueIndex)
              && !isDatePropertyType(definition.key)"
            v-bind="chipProps"
            class="note-properties-panel__chip"
            :class="{
              'note-properties-panel__chip--selected': isPropertyValueSelected(
                definition.key,
                valueIndex
              )
            }"
            :aria-pressed="isPropertyValueSelected(definition.key, valueIndex)"
            @click.stop="selectPropertyValue(definition.key, valueIndex)"
            @dblclick.stop.prevent="beginPropertyValueEditing(
              definition.key,
              valueIndex,
              value
            )"
            @click:close.stop="removePropertyValue(definition.key, valueIndex)"
          >
            {{ value }}
            <template #close>
              <span
                class="note-properties-panel__chip-close"
                v-html="closeIcon"
              />
            </template>
          </v-chip>
        </template>
        <NotePropertyDateInput
          v-if="isDatePropertyType(definition.key)"
          :model-value="inputValues[definition.key] ?? ''"
          :mode="getDatePropertyMode(definition.key)"
          @update:model-value="inputValues[definition.key] = $event"
          @save="commitInputValue(definition.key)"
        />
        <v-text-field
          v-else-if="getPropertyType(definition.key) !== 'checkbox'
            && getPropertyType(definition.key) !== 'number'
            && getPropertyType(definition.key) !== 'text'"
          :ref="instance => setInputHandle(definition.key, instance)"
          :model-value="inputValues[definition.key]"
          v-bind="getValueInputProps(definition.key)"
          class="note-properties-panel__input"
          :placeholder="getPropertyInputPlaceholder(definition.key)"
          @keydown="handleNumberInputKeydown($event, definition.key)"
          @keydown.enter="handleInputEnter($event, definition.key)"
          @keyup.enter="handleInputEnterKeyup"
          @update:model-value="updateInputValue(definition.key, $event)"
          @update:focused="handleInputFocusUpdate($event, definition.key)"
        />
      </span>
    </section>

    <section
      v-if="pendingPropertyName !== undefined"
      v-show="propertiesExpanded"
      class="note-properties-panel__row note-properties-panel__row--pending"
    >
      <span
        class="note-properties-panel__pending-icon"
        aria-hidden="true"
        v-html="cssClassesIcon"
      />
      <v-text-field
        :ref="setPendingPropertyInputHandle"
        v-model="pendingPropertyName"
        v-bind="valueInputProps"
        class="note-properties-panel__pending-name"
        aria-label="属性名称"
        placeholder="属性名称"
        @keydown="handlePendingPropertyNameKeydown"
        @update:focused="handlePendingPropertyNameFocusUpdate"
      />
      <span class="note-properties-panel__values" aria-hidden="true" />
    </section>

    <v-btn
      v-show="propertiesExpanded"
      v-bind="addButtonProps"
      class="note-properties-panel__add"
      @click="addEmptyProperty"
    >
      <span class="note-properties-panel__add-icon" v-html="addIcon" />
      添加笔记属性
    </v-btn>
  </v-sheet>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;

.note-properties-panel {
  @include flex-column;
  flex: none;
  gap: $note-properties-row-gap;
  padding-block: $note-properties-padding-block;
  color: var(--ws-editor-foreground);
  background: transparent;
}

.note-properties-panel__header {
  @include flex-align-center;
  justify-content: flex-start;
  width: fit-content;
  max-width: 100%;
  height: $note-properties-header-height;
  min-height: $note-properties-header-height;
  margin-inline-start: $note-properties-title-content-offset;
  color: var(--ws-editor-foreground);
  font-size: $note-properties-title-font-size;
  letter-spacing: 0;
  line-height: $note-properties-header-height;
  pointer-events: auto;
  text-align: left;
}

.note-properties-panel__header-context-arrow {
  @include flex-center;
  width: $editor-context-menu-arrow-size;
  height: $editor-context-menu-arrow-size;
  color: inherit;
}

.note-properties-panel__header-context-arrow :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

:global(.note-properties-panel__header-context-menu),
:global(.note-properties-panel__header-context-submenu) {
  min-width: $note-properties-menu-min-width;
}

.note-properties-panel__row {
  display: grid;
  grid-template-columns: $note-properties-icon-size $note-properties-label-width minmax(0, 1fr);
  align-items: start;
  min-height: $note-properties-row-height;
  margin-inline-start: $note-properties-row-border-offset;
  padding: $note-properties-row-padding;
  padding-inline-start: $note-properties-row-icon-inset;
  border: $input-border-width solid transparent;
  border-radius: $input-border-radius;
  pointer-events: auto;
}

.note-properties-panel__row:hover {
  border-color: var(--ws-input-border);
}

.note-properties-panel__row:focus-within {
  border-color: var(--ws-input-focusBorder);
}

.note-properties-panel__pending-icon,
.note-properties-panel__add-icon {
  display: inline-flex;
  width: $note-properties-icon-size;
  height: $note-properties-icon-size;
  color: var(--ws-icon-foreground);
}

.note-properties-panel__pending-icon,
.note-properties-panel__pending-name {
  align-self: center;
}

.note-properties-panel__pending-name {
  min-width: 0;
  width: 100%;
  margin-inline-start: $note-properties-chip-gap;
}

.note-properties-panel__pending-name :deep(.v-field__input) {
  min-height: $note-properties-value-height;
  padding: 0;
  font-size: $note-properties-content-font-size;
  line-height: $note-properties-value-height;
}

.note-properties-panel__pending-name :deep(.v-field__overlay) {
  display: none;
}

.note-properties-panel__values {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: $note-properties-chip-gap;
  min-width: 0;
  min-height: $note-properties-value-height;
}

.note-properties-panel__checkbox {
  align-self: center;
  flex: none;
  width: $icon-size-width;
  min-width: $icon-size-width;
  height: $icon-size-height;
  min-height: $icon-size-height;
  margin-inline-end: $note-properties-chip-gap;
}

.note-properties-panel__checkbox :deep(.v-selection-control) {
  --v-selection-control-size: #{$icon-size-height};
  display: inline-flex;
  flex: none;
  width: $icon-size-width;
  height: $icon-size-height;
  min-height: $icon-size-height;
}

.note-properties-panel__checkbox :deep(.v-selection-control__wrapper),
.note-properties-panel__checkbox :deep(.v-selection-control__input) {
  width: $icon-size-width;
  height: $icon-size-height;
}

.note-properties-panel__checkbox :deep(.v-selection-control__input::before) {
  display: none;
}

.note-properties-panel__checkbox :deep(.v-selection-control__input input) {
  width: $icon-size-width;
  height: $icon-size-height;
  appearance: none;
  border: $input-border-width solid var(--ws-input-border);
  border-radius: $input-border-radius;
  background: transparent;
  opacity: 1;
}

.note-properties-panel__checkbox :deep(.v-selection-control__input input:checked) {
  border-color: var(--ws-focusBorder);
  background: var(--ws-focusBorder);
}

.note-properties-panel__checkbox-selected-icon {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: inline-flex;
  width: $icon-size-width;
  height: $icon-size-height;
  margin: auto;
  color: var(--ws-editor-background);
  pointer-events: none;
}

.note-properties-panel__checkbox-selected-icon :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

.note-properties-panel__date-control {
  display: inline-flex;
  align-items: center;
  width: $note-properties-date-control-width;
  min-width: $note-properties-date-control-width;
  min-height: $note-properties-value-height;
  gap: $note-properties-chip-gap;
}

.note-properties-panel__date-control--datetime {
  width: $note-properties-datetime-control-width;
  min-width: $note-properties-datetime-control-width;
}

.note-properties-panel__date-control--datetime .note-properties-panel__date {
  width: $note-properties-datetime-content-width;
  min-width: $note-properties-datetime-content-width;
}

.note-properties-panel__date {
  display: inline-flex;
  align-items: center;
  width: $note-properties-date-content-width;
  min-width: $note-properties-date-content-width;
  min-height: $note-properties-value-height;
  color: var(--ws-textLink-foreground);
  font-family: inherit;
  font-size: $note-properties-content-font-size;
  font-weight: inherit;
  letter-spacing: 0;
  white-space: pre;
  cursor: default;
}

.note-properties-panel__date-separator,
.note-properties-panel__date-time-separator {
  color: var(--ws-descriptionForeground);
}

.note-properties-panel__date-icon {
  display: inline-flex;
  flex: none;
  width: $icon-size-width;
  height: $icon-size-height;
  color: var(--ws-descriptionForeground);
  cursor: pointer;
}

.v-btn.note-properties-panel__date-link {
  display: inline-flex;
  flex: none;
  width: $icon-size-width;
  min-width: $icon-size-width;
  height: $icon-size-height;
  padding: 0;
  color: var(--ws-icon-foreground);
  border-radius: $input-border-radius;
}

.note-properties-panel__date-link-icon {
  display: inline-flex;
  width: $icon-size-width;
  height: $icon-size-height;
  color: var(--ws-descriptionForeground);
  &:hover{
     color: var(--ws-focusBorder);
  }
}

.note-properties-panel__date-link-icon :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}

.note-properties-panel__date-year,
.note-properties-panel__date-value {
  cursor: default;
}

.note-properties-panel__chip {
  box-sizing: border-box;
  height: $note-properties-value-height;
  padding-inline-start: $spacing-none;
  color: var(--ws-editor-foreground);
  border: $note-properties-chip-border-width solid transparent;
  border-radius: $note-properties-chip-radius;
  font-size: $note-properties-content-font-size;
  cursor: default;
}

.note-properties-panel__chip--selected {
  border-color: var(--ws-border);
}

.note-properties-panel__chip :deep(.v-chip__overlay) {
  display: none;
}

.note-properties-panel__chip :deep(.v-chip__close) {
  color: var(--ws-icon-foreground);
}

.note-properties-panel__chip :deep(.v-chip__close:hover) {
  color: var(--ws-icon-hoverForeground);
}

.note-properties-panel__chip-close {
  display: inline-flex;
  width: $note-properties-close-icon-size;
  height: $note-properties-close-icon-size;
}

.note-properties-panel__input {
  flex: 1 1 $note-properties-input-min-width;
  min-width: $note-properties-input-min-width;
}

.note-properties-panel__chip-editor {
  flex: 0 1 $note-properties-input-min-width;
  min-width: $note-properties-input-min-width;
}

.note-properties-panel__input:not(.note-properties-panel__text-input) :deep(.v-field__input),
.note-properties-panel__chip-editor :deep(.v-field__input) {
  min-height: $note-properties-value-height;
  padding: 0;
  font-size: $note-properties-content-font-size;
}

.note-properties-panel__text-input :deep(textarea.v-field__input) {
  padding-block: $note-properties-text-padding-block;
  padding-inline: 0;
  font-size: $note-properties-content-font-size;
  letter-spacing: $spacing-none;
  line-height: $note-properties-text-line-height;
  overflow-wrap: anywhere;
  scrollbar-color: var(--ws-editor-scrollbarSlider-background) transparent;
  scrollbar-width: thin;
  white-space: pre-wrap;
  word-break: break-word;
}

.note-properties-panel__text-input :deep(textarea.v-textarea__sizer) {
  overflow: hidden;
  scrollbar-width: none;
}

.note-properties-panel__text-input :deep(.v-field) {
  --v-input-control-height: #{$note-properties-value-height};
  --v-input-padding-top: #{$spacing-none};
}

.note-properties-panel__text-input :deep(textarea.v-field__input::-webkit-scrollbar) {
  width: $scrollbar-hit-width;
}

.note-properties-panel__text-input :deep(textarea.v-field__input::-webkit-scrollbar-track) {
  background: transparent;
}

.note-properties-panel__text-input :deep(textarea.v-field__input::-webkit-scrollbar-button) {
  display: none;
  width: 0;
  height: 0;
}

.note-properties-panel__text-input :deep(textarea.v-field__input::-webkit-scrollbar-thumb) {
  border-radius: $input-border-radius;
  background: var(--ws-editor-scrollbarSlider-background);
}

.note-properties-panel__text-input :deep(textarea.v-field__input::-webkit-scrollbar-thumb:hover) {
  background: var(--ws-editor-scrollbarSlider-hoverBackground);
}

.note-properties-panel__input :deep(.v-field__overlay),
.note-properties-panel__chip-editor :deep(.v-field__overlay) {
  display: none;
}

.note-properties-panel__add {
  align-self: flex-start;
  background: transparent;
  min-height: $note-properties-row-height;
  padding-inline: $note-properties-row-padding;
  padding-inline-start: $note-properties-leading-content-offset;
  color: var(--ws-descriptionForeground);
  font-size: $note-properties-content-font-size;
  letter-spacing: 0;
  pointer-events: auto;
  text-transform: none;
}

.note-properties-panel__add:hover,
.note-properties-panel__add:focus-visible {
  color: var(--ws-icon-hoverForeground);
  background: transparent;
}

.note-properties-panel__add :deep(.v-btn__overlay),
.note-properties-panel__add :deep(.v-btn__underlay) {
  display: none;
}

.note-properties-panel__add-icon {
  margin-inline-end: $note-properties-chip-gap;
}

</style>
