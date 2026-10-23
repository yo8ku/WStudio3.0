# WStudio 3.0 项目配置

## ⚠️ 强制要求

**每次任务开始前必须执行：**

1. **首先阅读** `E:\WStudio3.0\AGENTS.md`（规范入口和路由表）
2. **识别任务类型**，在 AGENTS.md 的路由表中查找需要的规范模块
3. **阅读匹配的规范**：从 `E:\WStudio3.0\.agents\` 目录读取对应的 `.md` 文件
4. **严格遵循**规范中定义的约束和流程

这不是可选的 — 所有代码修改、文件操作、测试任务都必须先加载规范。

## 规范路由快速参考

完整路由表在 `AGENTS.md` 中，常见任务映射：

| 任务类型 | 读取路径 |
|---------|---------|
| 文件结构/目录归属 | `E:\WStudio3.0\.agents\project-structure.md` |
| 样式/SCSS/主题 | `E:\WStudio3.0\.agents\scss.md` |
| Vue/Vuetify 组件 | `E:\WStudio3.0\.agents\vue-vuetify.md` + `scss.md` |
| Electron/IPC | `E:\WStudio3.0\.agents\electron-ipc.md` |
| CodeMirror 编辑器 | `E:\WStudio3.0\.agents\editor-codemirror.md` + `workflow.md` |
| DockingThree 布局 | `E:\WStudio3.0\.agents\docking-three.md` + `workflow.md` |
| 插件系统 | `E:\WStudio3.0\.agents\plugin-sdk.md` + `electron-ipc.md` |
| 测试/验证 | `E:\WStudio3.0\.agents\testing.md` |
| 任何代码修改 | `E:\WStudio3.0\.agents\workflow.md` |

## 技术栈

- Electron + Vue 3 + TypeScript + Vuetify 3
- Pinia（状态管理）
- SCSS（样式系统）
- CodeMirror 6（编辑器）
- DockingThree（自定义布局引擎）

## 全局约束（不可违反）

1. **严格禁止运行任何 Git 命令**
2. 保留用户已有的无关修改，不使用破坏性命令
3. 编辑文件使用 Edit 工具，保持 UTF-8 编码
4. 渲染进程不得直接引入 Electron/Node 模块
5. 禁止使用 `any` 类型，使用 `unknown` 并收窄类型
6. 新增宿主能力必须通过公开 SDK，不为核心插件增加特例

## 工作流要求

### 修改前
- 先读取规范，理解现有实现
- 检查是否可复用现有组件/服务/工具
- 明确状态管理方案

### 修改中
- 只修改任务相关文件
- 添加必要的功能注释
- 不保留失效代码和重复实现

### 修改后
- 运行类型检查和相关测试
- UI 改动需验证多种交互状态
- 清理临时测试文件
- 说明修改内容和验证结果

## 规范冲突优先级

用户当前请求 > `AGENTS.md` 全局规则 > 主题规范 > 其他文档

## 使用示例

```
用户："修改编辑器的缩进参考线颜色"

正确流程：
1. 读取 E:\WStudio3.0\AGENTS.md
2. 识别任务涉及：CodeMirror + SCSS
3. 读取 E:\WStudio3.0\.agents\editor-codemirror.md
4. 读取 E:\WStudio3.0\.agents\scss.md
5. 读取 E:\WStudio3.0\.agents\workflow.md
6. 按规范执行修改
7. 按 testing.md 验证
```

---

**重要提醒：** 本文件是自动化入口，实际规范内容在 `AGENTS.md` 和 `.agents/` 目录中。不要在此文件中复制规范细节，保持此文件简洁，仅作为加载指引。
