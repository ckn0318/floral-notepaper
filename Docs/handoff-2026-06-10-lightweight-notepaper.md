# 轻量便签改造交接说明（2026-06-10）

## 当前目标

项目正在从原来的完整编辑器型应用，收敛为轻量便签软件。当前保留的核心能力是：

1. 小窗便签：新建、打开、编辑、保存、清空、钉为磁贴。
2. 磁贴便签：显示、关闭、转回小窗。
3. 托盘和快捷键：应用关闭后留在托盘，`Ctrl+Space` 负责唤起或切换轻量便签界面。

主编辑器和设置面板相关入口已经从当前运行路径中移除或停用，但部分旧组件文件仍留在代码库里，后续可以继续清理。

## 已完成改动

### 应用入口与窗口

- `src/features/windows/windowRoutes.ts`
  - `AppView` 收敛为 `"notepad" | "tile"`。
  - 默认路由改为 `notepad`。
- `src/App.tsx`
  - 默认渲染 `NotePad`。
  - 不再渲染主编辑器 `MainWindow` 分支。
- `src-tauri/tauri.conf.json`
  - 预配置窗口从原主窗口改为 `notepad`。
  - 默认尺寸为 `416 x 433`。
  - 小窗启用置顶、隐藏任务栏、无边框。
- `src-tauri/capabilities/default.json`
  - 已允许前端窗口能力作用于 `notepad`。

### 主编辑器入口移除

- `src/components/NotePad.tsx`
  - 打开列表中已移除“在编辑器中打开”按钮。
  - 不再调用 `openNoteInEditor`。
- `src/features/windows/api.ts`
  - 移除了前端 `openNoteInEditor` API。
- `src-tauri/src/lib.rs`
  - 移除了后端 `open_note_in_editor` 命令注册。
- `src-tauri/src/desktop.rs`
  - `show_main_window()` 当前会打开小窗，不再恢复主编辑器窗口。
  - 托盘点击和“快速记录”都进入小窗。

### 托盘和关闭行为

- 关闭到托盘固定开启：`close_to_tray_enabled()` 目前直接返回 `true`。
- 托盘菜单已精简，当前保留：
  - 快速记录
  - 开机自启
  - 退出
- 小窗关闭走 `recycle_notepad_window()`，当前行为是隐藏 `notepad` 窗口。

### 快捷键状态机

当前全局快捷键使用 `Ctrl+Space`，逻辑在 `src-tauri/src/desktop.rs`：

1. 有可见磁贴：向磁贴发送 `surface-action: "switchToPad"`，磁贴转回小窗。
2. 有可见小窗：当前也会发送 `surface-action: "switchToPad"`，实际表现接近无动作。
3. 没有可见小窗/磁贴：打开 `notepad` 小窗。

用户原始确认过的目标是“小窗已打开时再次按 `Ctrl+Space` 不触发行为”。当前实现能基本满足体验，但代码上仍会 emit 一次事件；后续如需严格实现，可在检测到可见小窗时直接 `return`。

### 小窗尺寸和位置

这是最近一次修复后的临时稳定策略：

- 小窗每次打开都使用固定默认尺寸：`416 x 433`。
- 小窗每次打开都定位到主屏工作区右上角，边距 `24px`。
- 关闭小窗时不再保存尺寸和位置。
- 旧配置字段 `surfaceWidth`、`surfaceHeight`、`surfaceX`、`surfaceY` 仍存在，但当前打开小窗时不再读取它们。

相关代码：

- `notepad_window_specs()`：默认尺寸。
- `fixed_notepad_bounds()`：右上角固定位置。
- `open_notepad_window_now()`：打开或复用小窗时使用完整 bounds。
- `recycle_notepad_window()`：隐藏小窗，不写回尺寸位置。

后续如果恢复“记住尺寸和位置”，建议一次性设置完整 bounds，避免先 `set_size()` 再 `set_position()` 造成 Windows/Tauri 的尺寸换算累积误差。

### 默认配置

`src-tauri/src/services/notes.rs` 已调整默认配置：

- 主题默认深色：`theme = "dark"`。
- 小窗/磁贴字号默认 `16px`。
- 小窗笔记自动保存默认开启。
- 关闭到托盘默认开启。
- 快捷键默认 `Ctrl+Space`。
- 新安装的默认笔记目录倾向安装目录下的 `notes`；开发模式下保留可运行的回退路径。
- 已有配置不强制迁移，避免移动用户已有笔记目录。

### 字号调整

- `src/components/NotePad.tsx`
  - 支持 `Ctrl + 鼠标滚轮` 调整小窗编辑字号。
  - 范围为 `10px` 到 `25px`。
  - 调整后写入 `surfaceFontSize`，并同步 `fontSize`。
- `src/components/Tile.tsx`
  - 默认字号为 `16px`。

### 视觉修复

- `src/App.css`
  - 应用根背景改为 `var(--color-cloud)`，用于修复透明圆角外出现白角的问题。

## 当前已知状态

- 当前工作区有未提交修改。
- `Docs/lightweight-notepaper-refactor-plan.md` 是本轮改造的需求与计划文档。
- `Docs/handoff-2026-06-10-lightweight-notepaper.md` 是本交接文档。
- `dist/` 和 `node_modules/` 当前存在于本地工作区，属于构建/依赖产物。

## 已验证命令

以下命令已在 2026-06-08 的改造过程中通过：

```powershell
npm.cmd run test
npm.cmd run build
cargo test
cargo build
```

`npm.cmd run build` 仍有 Vite 包体积 warning，构建本身成功。

## 下一步建议

1. 先让用户运行 `npm.cmd run tauri dev` 验证固定右上角和固定尺寸是否稳定。
2. 验证稳定后，再设计动态尺寸/位置恢复：
   - 关闭或隐藏前读取完整 outer/inner bounds。
   - 恢复时一次性构造完整 `WindowBounds`。
   - 避免连续调用 `set_size()` 和 `set_position()`。
3. 严格修正快捷键小窗分支：
   - 有可见小窗时 `Ctrl+Space` 直接无动作。
   - 有可见磁贴时才发送 `switchToPad`。
4. 继续清理旧主编辑器和设置相关代码：
   - `MainWindow`、`SettingsPanel`、主编辑器专用 API、未使用翻译字段和测试。
   - 清理前先用 `rg` 查引用，避免误删仍被小窗或磁贴复用的逻辑。

## 关键文件清单

- `src-tauri/src/desktop.rs`：窗口、托盘、快捷键、固定 bounds 的核心逻辑。
- `src-tauri/src/services/notes.rs`：默认配置和笔记存储路径。
- `src-tauri/src/lib.rs`：Tauri 命令注册。
- `src-tauri/tauri.conf.json`：预配置窗口。
- `src/components/NotePad.tsx`：小窗 UI 和自动保存、字号调整、事件监听。
- `src/components/Tile.tsx`：磁贴 UI。
- `src/features/windows/windowRoutes.ts`：前端路由视图。
- `src/features/windows/api.ts`：前端窗口 API。
- `src/App.tsx`：应用入口渲染。
