/** 文件说明：定义设置窗口展示的内置命令快捷键列表。 */

/** 单条快捷键设置展示数据。 */
export interface ShortcutDefinition {
  command: string;
  keybinding: string;
  description: string;
  implemented?: boolean;
}

/** 工作台内置命令的快捷键展示数据。 */
export const shortcutDefinitions: readonly ShortcutDefinition[] = [
  { command: '保存当前文件', keybinding: 'Ctrl+S', description: '将当前编辑器中已修改的 Markdown 文件保存到工作区。', implemented: true },
  { command: '打开文件', keybinding: 'Ctrl+P', description: '快速打开一个文件并在当前编辑区中聚焦。' },
  { command: '新建文件', keybinding: 'Ctrl+N', description: '在当前编辑器组中创建一个新的空白标签页。' },
  { command: '打开文件夹', keybinding: 'Ctrl+K Ctrl+O', description: '选择一个目录并在工作台中加载它的资源结构。' },
  { command: '全部保存', keybinding: 'Ctrl+K S', description: '保存当前工作区中所有已修改的文件。' },
  { command: '切换左侧边栏', keybinding: 'Ctrl+B', description: '展开或收起左侧侧边栏区域。' },
  { command: '切换右侧边栏', keybinding: 'Ctrl+Alt+B', description: '展开或收起右侧侧边栏区域。' },
  { command: '拆分编辑器', keybinding: 'Ctrl+\\', description: '在主编辑区中创建新的编辑器标签组。' },
  { command: '向下拆分编辑器', keybinding: 'Ctrl+K Ctrl+Down', description: '在当前编辑器组下方创建新的编辑器标签组。' },
  { command: '切换专注模式', keybinding: 'Ctrl+K Z', description: '隐藏多余界面元素，只保留核心编辑区域。' },
  { command: '打开设置', keybinding: 'Ctrl+,', description: '进入工作台设置与偏好配置入口。' },
  { command: '重新加载窗口', keybinding: 'Ctrl+R', description: '刷新当前工作台窗口并重新装载界面。' },
  { command: '打开命令中心', keybinding: 'F1', description: '显示命令中心并聚焦到命令输入框。', implemented: true },
  { command: '内联聊天发送消息', keybinding: 'Enter', description: '发送当前内联聊天输入框中的消息。', implemented: true },
  { command: '内联聊天消息换行', keybinding: 'Shift+Enter', description: '在内联聊天输入框中插入换行。', implemented: true },
  { command: '重新打开已关闭编辑器', keybinding: 'Ctrl+Shift+T', description: '恢复最近一个被关闭的编辑器标签页。' },
  { command: '关闭编辑器组', keybinding: 'Ctrl+K W', description: '关闭当前编辑器标签组并释放该区域。' },
  { command: '聚焦右侧编辑器组', keybinding: 'Ctrl+K Ctrl+Right', description: '把焦点切换到右侧相邻的编辑器组。' },
  { command: '聚焦左侧编辑器组', keybinding: 'Ctrl+K Ctrl+Left', description: '把焦点切换到左侧相邻的编辑器组。' },
  { command: '切换终端面板', keybinding: 'Ctrl+`', description: '显示或隐藏内置终端面板区域。' },
  { command: '新建终端', keybinding: 'Ctrl+Shift+`', description: '创建一个新的终端会话标签页。' },
  { command: '运行任务', keybinding: 'Ctrl+Shift+B', description: '打开任务列表并执行预定义任务。' },
  { command: '启动调试', keybinding: 'F5', description: '开始当前工作区的调试流程。' },
  { command: '停止调试', keybinding: 'Shift+F5', description: '终止当前调试会话。' },
  { command: '查看问题', keybinding: 'Ctrl+Shift+M', description: '打开问题列表并聚焦到错误与警告。' },
  { command: '聚焦资源管理器', keybinding: 'Ctrl+Shift+E', description: '切换到左侧资源管理器面板。' },
  { command: '聚焦搜索', keybinding: 'Ctrl+Shift+F', description: '切换到全局搜索面板。' },
  { command: '聚焦源代码管理', keybinding: 'Ctrl+Shift+G', description: '切换到源代码管理面板。' },
  { command: '打开最近项目', keybinding: 'Ctrl+R', description: '显示最近访问过的项目与工作区列表。' },
  { command: '复制当前标签页', keybinding: 'Ctrl+K Ctrl+D', description: '在当前组中复制一个新的编辑器标签页。' },
  { command: '格式化文档', keybinding: 'Shift+Alt+F', description: '按照当前格式化规则重新整理文档内容。' },
  { command: '重命名符号', keybinding: 'F2', description: '在当前文件或工作区内重命名光标所在符号。' },
  { command: '切换自动换行', keybinding: 'Alt+Z', description: '为当前编辑器开启或关闭自动换行。' },
  { command: '转到行', keybinding: 'Ctrl+G', description: '根据行号快速跳转到目标位置。' },
  { command: '转到文件内符号', keybinding: 'Ctrl+Shift+O', description: '在当前文件的符号列表中快速跳转。' },
  { command: '转到定义', keybinding: 'F12', description: '跳转到当前符号的定义位置。' },
  { command: '预览定义', keybinding: 'Alt+F12', description: '以内联方式查看当前符号定义。' },
  { command: '在资源管理器中定位文件', keybinding: 'Ctrl+K R', description: '让左侧资源管理器定位到当前活动文件。' },
  { command: '复制相对路径', keybinding: 'Alt+Shift+C', description: '复制当前文件相对于工作区的路径。' },
  { command: '打开键盘快捷方式', keybinding: 'Ctrl+K Ctrl+S', description: '查看并搜索所有快捷键绑定。' },
  { command: '切换开发者工具', keybinding: 'Ctrl+Shift+I', description: '显示或隐藏开发者工具窗口。' }
] as const;
