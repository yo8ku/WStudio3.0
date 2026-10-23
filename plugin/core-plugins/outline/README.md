<!-- 文件说明：介绍大纲核心插件的能力边界与公开 SDK 依赖。 -->

# 大纲插件

大纲插件通过公开 `context.editor` 接口读取当前活动 Markdown 文档，解析 ATX 与 Setext 标题，并在右侧边栏展示可折叠层级。

插件不访问宿主 Store、CodeMirror、DockingThree、Electron 或其他私有实现。点击标题时只调用 `context.editor.revealRange(..., { verticalAlignment: 'upper-center' })`，文档与选区变化通过 `context.editor.onDidChangeActiveDocument(...)` 订阅，并由视图级 `context.subscriptions` 自动释放。
