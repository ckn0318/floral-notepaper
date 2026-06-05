# 导出 Markdown 图片附件改动思路

## 目标

应用内笔记包含 `![](images/<noteId>/xxx.png)` 时，导出 Markdown 需要同时带出图片附件，让导出的 `.md` 在其他 Markdown 工具中也能正常显示图片。

## 推荐方案

导出为 `.md + images/` 目录：

1. 用户选择导出路径，例如 `D:\export\note.md`。
2. 应用写出 Markdown 文件，并创建 `D:\export\images\<noteId>\`。
3. 复制正文中实际引用的图片到导出目录，保持引用路径不变。

最小结果：

```text
export/
  note.md
  images/
    <noteId>/
      xxx.png
```

## 不推荐第一版使用 base64

base64 会把图片内容写进 Markdown 文本。优点是单文件携带；代价是 Markdown 文件很大、可读性差、编辑器加载和 diff 体验差。当前场景更适合独立附件目录。

## 改动范围

### Rust 后端

- 扩展 `notes_export_markdown` 或新增命令。
- 解析笔记正文中的本地图片引用：`images/<noteId>/<file>`。
- 只复制当前笔记实际引用的图片。
- 跳过不存在的图片，不阻断 Markdown 导出；可返回缺失列表供前端提示。

### 前端

- 复用当前“导出 Markdown”入口。
- 导出成功后，如果有图片附件缺失，显示简短提示。
- 不改变正文内容中的图片路径。

## 验收标准

- 导出包含图片的笔记后，导出目录中存在 `.md` 和 `images/<noteId>/`。
- 用 Typora、Obsidian 或 VS Code 打开导出的 `.md`，图片能显示。
- 正文删除图片引用并保存后，再导出时不复制未使用图片。
- 没有图片的笔记导出行为保持不变。

## 后续增强

- 导出时可选“打包为 zip”。
- 导入 Markdown 时识别同级 `images/` 目录。
- 图片路径重写为更短的 `images/xxx.png`。
