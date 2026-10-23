# WStudio

WStudio 是一个基于 Vue 3、TypeScript、Vite、Pinia 和 CodeMirror 6 的桌面编辑器。
桌面宿主使用 Tauri 2 + Rust：前端继续使用 Vue + TypeScript，文件系统、SQLite、窗口、插件、WebViewer 和 AI 等宿主能力由 Rust 提供。

## 开发

```powershell
npm ci
npm run dev
```

使用 pnpm 11 时也可以执行：

```powershell
pnpm install
pnpm run dev
```

根目录的 `pnpm-workspace.yaml` 使用 `allowBuilds` 批准 `@parcel/watcher` 和 `esbuild` 的安装脚本，需随源码一起提交，避免新拉取项目安装时出现 `ERR_PNPM_IGNORED_BUILDS`。已经遇到该错误的目录，更新配置后重新执行 `pnpm install`。

常用检查：

```powershell
npm run typecheck:all
npm test
npm run build:tauri
```

日常使用先执行一次 `npm run build:tauri`，之后使用 `npm start` 直接打开 release 程序，启动时不执行 Vite 或 Cargo。源码变更后需要重新构建才能更新 release；开发和热更新继续使用 `npm run dev`，其中的编译时间不属于应用运行时启动时间。

`dev`、`build`、`start` 和完整类型检查统一使用 Vue + Rust/Tauri。Electron 启动、Preload、兼容桥接、npm 运行依赖、旧宿主参照代码和编译产物已清理。`scripts/` 保留当前 Tauri 启动工具、发布烟测及其测试。

## 架构

Google 登录已接入 Go 后端：桌面宿主调用 `/api/v1/auth/oauth/google/start`，用系统浏览器授权，接收 `wstudio://auth/callback` 后调用 `/api/v1/auth/oauth/exchange`。Google Client ID 和 Client Secret 只在服务端配置；桌面端配置后端地址：

```powershell
npm run dev
```

开发环境的后端地址配置在 `src-tauri/.env`，Cargo 构建脚本会将它写入原生程序；命令行中的 `WSTUDIO_SERVER_URL` 优先，可用于临时覆盖。发布时将 `src-tauri/.env` 改为实际 HTTPS 服务域名，或在构建环境中设置同名变量后重新构建，用户安装后无需配置。Google OAuth 的 Client ID 和 Client Secret 均只在 Go 后端配置，桌面端不读取或保存任何 Google 客户端凭据。Go 后端使用 Google **Web application** OAuth 客户端，回调登记为 `http://localhost:8080/api/v1/auth/oauth/google/callback`（生产环境使用 HTTPS）。平台会话默认五年（1825 天），桌面端保存到系统凭据库，重启后自动恢复并向后端验证；旧一小时会话需重新登录取得长期会话。OAuth 流程和一次性兑换码仍短期过期。详细 Google 控制台、数据库、启动、故障处理步骤位于服务端项目 `docs/google-login.md`。

Token 只保存到系统凭据库，渲染端接收非敏感会话元数据；恢复时宿主调用 `/auth/me` 校验。Tauri deep-link 插件注册 wstudio 协议；开发时须启动原生 `npm run dev`，单独 Vite 页面仅用于界面预览。Windows 复用单实例转交回跳。测试/构建尚不代表真实 Google 浏览器授权已验收。

```text
Vue 3 + TypeScript + CodeMirror
              |
       src/api/native.ts
              |
       Tauri invoke/events
              |
       src-tauri/src/*.rs
```

插件只能使用 `plugin/sdk` 的公开接口。Rust 网关负责插件身份、权限、scope、截止时间、限流和生命周期校验；带有 sidecar 声明的插件使用独立 Host。

## 构建产物

Windows release 构建会生成：

- `src-tauri/target/release/wstudio.exe`
- `src-tauri/target/release/bundle/nsis/WStudio_0.1.0_x64-setup.exe`

当前构建记录和验收边界见 [Tauri 发布说明](docs/release-tauri.md) 与 [迁移计划](docs/rust-tauri-migration-plan.md)。真实桌面交互、跨平台实机和干净机器安装按发布清单单独记录。
