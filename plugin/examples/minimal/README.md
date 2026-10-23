<!-- 文件说明：说明最小 WStudio 插件示例的开发文件和最终分发文件。 -->

# Minimal WStudio Plugin

这是一个只注册命令的最小插件示例。

## 文件说明

- `manifest.json`：插件包清单。
- `main.js`：插件包根入口。
- `styles.css`：插件包根样式入口。

## 生命周期

宿主在命中 `onCommand:com.example.word-count.show` 时加载根 `main.js`，调用 `activate(context)`。命令注册返回的 `Disposable` 会加入 `context.subscriptions`，插件停用时由宿主统一释放。

## 打包结果

发布时将 `manifest.json`、`main.js`、`styles.css` 和插件自有资源放入 `.wstudio-plugin` 压缩包。
