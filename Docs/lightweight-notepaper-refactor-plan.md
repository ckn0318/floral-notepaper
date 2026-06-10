# 轻量便签改造需求与执行计划

## 目标范围

将当前项目改造成只面向快速记录的小型便签软件：

1. 保留小窗与磁贴
   - 保留小窗的新建、打开、编辑、保存、清空、钉为磁贴等能力。
   - 保留磁贴显示、右键菜单、转回小窗、关闭磁贴等能力。
   - 小窗关闭后进入托盘，应用仍在后台运行。

2. 移除主编辑器与设置入口
   - 默认路由不再进入主编辑器，启动主窗口时直接打开小窗。
   - 删除小窗“打开”列表里的“在编辑器中打开”按钮与命令。
   - 托盘菜单不再提供“显示主窗口/设置”类入口，只保留快速记录、退出，以及必要的窗口唤起能力。
   - 清理前端中只服务主编辑器的 UI：主编辑器、设置面板、导入导出、背景图设置、编辑器 Markdown 预览等。

3. 固化默认设置
   - 主题默认深色。
   - 磁贴颜色使用默认磁贴色。
   - 笔记目录默认使用安装目录下的 `notes`，例如 `D:\花笺便签\notes`。
   - 小窗笔记默认自动保存。
   - 小窗尺寸和位置默认记忆，下次打开沿用上次状态。
   - 小窗与磁贴默认字号为 `16px`。

## 交互规则

快捷键统一为 `Ctrl+Space`：

1. 没有小窗/磁贴时
   - `Ctrl+Space` 打开快速记录小窗。

2. 已打开小窗时
   - `Ctrl+Space` 不触发任何行为。
   - 小窗多开能力暂时移除，后续如需要再单独添加。

3. 已打开磁贴时
   - `Ctrl+Space` 将磁贴转为小窗。
   - 小窗多开移除后，磁贴转小窗时会复用唯一小窗入口。

字号调整：

1. 小窗编辑区支持 `Ctrl + 鼠标滚轮` 调整字号。
2. 磁贴支持 `Ctrl + 鼠标滚轮` 调整字号。
3. 字号范围限制为 `10px` 到 `25px`，调整后写入配置，后续小窗和磁贴共用该字号。

## 代码改动计划

### 阶段一：收口应用入口

- 修改 `src/features/windows/windowRoutes.ts`
  - 默认路由从 `main` 改为 `notepad`。
  - 保留 `notepad`、`tile` 路由。
  - 移除或废弃 `main` 路由。

- 修改 `src/App.tsx`
  - 去掉 `MainWindow` 渲染分支。
  - 默认渲染 `NotePad`。
  - 保留 `TileShowcase` 或改成直接渲染 `Tile`，以继续支持磁贴窗口。

- 修改 Tauri 窗口启动逻辑
  - 默认主窗口加载小窗路由。
  - 托盘“快速记录”继续打开小窗。
  - 主窗口关闭行为固定为隐藏到托盘。

### 阶段二：删除主编辑器关联能力

- 修改 `src/components/NotePad.tsx`
  - 删除 `openNoteInEditor` import、按钮和 tooltip。
  - 打开列表仅保留点击条目打开小窗笔记。

- 修改 `src/features/windows/api.ts`
  - 移除 `openNoteInEditor` 前端 API。

- 修改 `src-tauri/src/lib.rs`
  - 移除 `open_note_in_editor` command。

- 修改 `src-tauri/src/desktop.rs`
  - 移除或废弃打开主编辑器窗口的函数。
  - 托盘菜单不再调用主编辑器。

- 后续可删除的文件
  - `src/components/MainWindow.tsx`
  - `src/components/SettingsPanel.tsx`
  - 主编辑器专用测试与 API
  - 未被小窗/磁贴使用的导入导出、背景图、编辑器 Markdown 相关代码

### 阶段三：默认配置与存储位置

- 修改 `src-tauri/src/services/notes.rs`
  - `theme` 默认值改为 `dark`。
  - `surface_font_size` 默认值改为 `16`。
  - `font_size` 如仍保留，默认也改为 `16`。
  - `note_surface_auto_save` 固定默认 `true`。
  - `remember_surface_size` 固定默认 `true`。
  - `close_to_tray` 固定默认 `true`。
  - `global_shortcut` 默认 `Ctrl+Space`。
  - `toggle_visibility_shortcut` 清空或停止使用，避免与 `global_shortcut` 重复冲突。

- 笔记目录改为安装目录下 `notes`
  - 优先使用当前可执行文件所在目录作为安装目录。
  - 开发模式下可回退到项目目录或当前工作目录，保证 `npm.cmd run tauri dev` 可用。
  - 需要处理已有配置：如果用户已有自定义 `notesDir`，是否迁移到安装目录 `notes` 需要确认；建议新安装默认走安装目录，已有配置暂不强制迁移。

### 阶段四：快捷键状态机

- 修改 `src-tauri/src/desktop.rs`
  - 将 `Ctrl+Space` 绑定为单一全局快捷键。
  - 快捷键触发时按窗口状态分派：
    - 有可见磁贴：磁贴转为小窗。
    - 没有磁贴但有小窗：不触发任何行为。
    - 没有小窗：创建快速记录小窗。
  - 删除“两个快捷键不能重复”的校验路径，或移除第二快捷键配置。

- 调整相关测试
  - 覆盖 `Ctrl+Space` 单快捷键行为。
  - 覆盖有磁贴时快捷键转为小窗。
  - 覆盖没有窗口时快捷键打开小窗。

### 阶段五：字号控制

- 修改 `src/components/NotePad.tsx`
  - 在编辑区监听 `Ctrl + wheel`。
  - 字号按步长 `1px` 调整，限制 `10-25px`。
  - 保存到配置字段 `surfaceFontSize`。

- 修改 `src/components/Tile.tsx` 或磁贴容器
  - 在磁贴窗口监听 `Ctrl + wheel`。
  - 与小窗共用 `surfaceFontSize`。
  - 调整后即时刷新当前窗口字号。

### 阶段六：清理与验证

- 清理未使用 import、类型、翻译字段和命令注册。
- 更新测试：
  - `npm.cmd run build`
  - `npm.cmd run test`
  - `cargo test`
  - `cargo build`
- 手动验证：
  - 启动后进入小窗。
  - 新建笔记自动保存到安装目录 `notes`。
  - 小窗关闭后托盘仍在。
  - 再次打开记住尺寸和位置。
  - “打开”列表没有“在编辑器中打开”。
  - 磁贴可打开、可关闭、可转小窗。
  - `Ctrl+Space` 在不同窗口状态下符合预期。
  - 小窗和磁贴 `Ctrl + wheel` 字号范围为 `10-25px`。

## 需要确认的问题

1. 多个磁贴同时打开时，`Ctrl+Space` 如何处理？
   - 已确认：去掉小窗多开后，不再保留多个磁贴的快捷键分派逻辑。

2. 小窗已打开时再次按 `Ctrl+Space` 的行为？
   - 已确认：不触发任何行为。

3. 已有用户配置中的 `notesDir` 是否强制迁移到安装目录 `notes`？
   - 已确认：新安装默认使用安装目录，已有配置不强制迁移，避免移动用户文件。

4. 是否保留托盘菜单里的“关闭到托盘/开机自启”开关？
   - 已确认：关闭到托盘固定开启；开机自启、快速记录保留开关。
