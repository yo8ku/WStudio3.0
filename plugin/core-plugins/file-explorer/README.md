<!-- 文件说明：说明文件列表核心插件包的根文件和运行边界。 -->

# 文件列表

这是一个按第三方插件规则安装和运行的核心插件。必要文件是根目录的 `manifest.json`、`main.js` 和 `styles.css`；`assets/` 等其他目录均为插件自有资源。

插件通过 `mountView(context)` 渲染自己的文件列表，通过公开 SDK 访问文件系统、工作区、编辑器、窗口、通知和宿主 SVG 图标能力。宿主不渲染文件树业务 DOM，也不提供核心插件专用 IPC。宿主通用图标通过 `context.icons.setIcon()` 插入真实 `<svg>`，插件专用图标由插件创建内联 SVG。

## 默认支持的文件类型

文件列表只显示和打开下列默认文件类型，扩展名比较不区分大小写：

| 类别 | 扩展名 | 打开方式 |
| --- | --- | --- |
| 纯文本 | `.txt`、`.text`、`.log`、`.out` | WStudio 文本编辑器 |
| Markdown/文档标记 | `.md`、`.markdown`、`.mdown`、`.mkdn`、`.mkd`、`.mdwn`、`.rst`、`.adoc`、`.asciidoc`、`.tex`、`.html`、`.htm`、`.xhtml`、`.xml`、`.xsl`、`.xsd` | WStudio 文本编辑器 |
| 配置文件 | `.json`、`.jsonc`、`.yaml`、`.yml`、`.toml`、`.ini`、`.cfg`、`.conf`、`.config`、`.properties` | WStudio 文本编辑器 |
| 数据文件 | `.csv`、`.tsv`、`.jsonl`、`.ndjson` | WStudio 文本编辑器 |
| 图片 | `.avif`、`.bmp`、`.gif`、`.jpeg`、`.jpg`、`.png`、`.svg`、`.webp` | 图片预览标签 |
| 视频 | `.avi`、`.m4v`、`.mkv`、`.mov`、`.mp4`、`.ogv`、`.webm` | 视频预览标签 |
| 音频 | `.aac`、`.flac`、`.m4a`、`.mp3`、`.ogg`、`.opus`、`.wav` | 音频预览标签 |

PDF 和编程语言、脚本、样式及组件格式目前不属于默认支持格式，文件列表不会将其列为可打开文件。完整的文件类型协议与扩展点说明见 [`docs/plugin/fileTypes.md`](../../../docs/plugin/fileTypes.md)。

名称以 `.` 开头的隐藏文件或目录，以及未在上表列出的扩展名，不会显示在文件列表中；筛选不会删除或修改工作区文件。

文件树支持使用 `Ctrl`（macOS 为 `Command`）配合鼠标左键切换多选。右键删除和 Pointer Events 拖拽会作用于当前多选集合；父目录与其子项同时选中时只处理父目录，避免重复删除或移动。

打开文件或切换到编辑器后，文件树保留当前选中状态；点击文件列表留白或切换仓库时才重置选择。
