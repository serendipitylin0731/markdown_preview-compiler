# Markdown Preview & Compiler

以 Markdown 文件为中心的 VS Code 编辑扩展。提供原生源码编辑、只读分屏预览、独立所见即所得编辑、PDF 对照预览与导出。

## 安装

从仓库的构建产物下载 `markdown-preview-compiler-*.vsix`，在 VS Code 中运行 **Extensions: Install from VSIX...**。本地构建可运行：

```bash
npm ci
npm run package
```

生成的 VSIX 位于项目根目录。扩展运行时不需要网络，渲染库和 PDF 引擎均随安装包提供。

## 使用

打开 `.md` 文件后，可从编辑器标题按钮或命令面板使用：

仓库中的 [演示文档](examples/demo.md) 可直接用于体验完整流程。

| 命令 | 效果 |
| --- | --- |
| `Markdown Compiler: 源码编辑` | 返回 VS Code 原生 Markdown 编辑器 |
| `Markdown Compiler: 分屏预览` | 左侧源码，右侧只读预览 |
| `Markdown Compiler: 所见即所得编辑` | 直接编辑渲染后的段落、标题、列表和表格 |
| `Markdown Compiler: PDF 对照预览` | 边编辑边查看实际生成的 PDF |
| `Markdown Compiler: 导出 PDF` | 预览并选择 PDF 保存位置 |

常用快捷键：`Ctrl+Alt+M` 分屏、`Ctrl+Alt+V` 所见即所得、`Ctrl+Alt+P` PDF；macOS 使用 `Cmd` 代替 `Ctrl`。所见即所得模式内可用 `Ctrl/Cmd+B`、`Ctrl/Cmd+I` 和 Tab / Shift+Tab。

可在所见即所得工具栏插入链接、图片、表格、代码、公式、Mermaid 图表和手动分页符。复杂代码块、公式、图表及 HTML 区块提供对应源码编辑入口，避免可视化编辑时破坏原始内容。编辑以块为单位写回 VS Code 的 `TextDocument`；文件的未保存状态、保存和撤销由 VS Code 管理。

PDF 工具栏可设置纸张、方向、边距、字体、字号、行距、首行缩进、标题、页眉、页脚、封面和目录。正文模板是位于 `assets/templates` 的 SVG 图片；可导入 PNG、JPEG、WebP 或 SVG 作为自定义模板，也可导出已导入的模板。模板只影响 PDF，不改动 Markdown 正文。

手动分页符保存在文件中：

```md
<!-- pagebreak -->
```

PDF 预览和最终导出使用同一份 PDF 字节，因此切换模板或排版参数后，预览更新结果与随后导出的文件一致。PDF 预览可翻页、缩放、适合宽度、适合页面、单独查看，并在更新后尽量保留原页码。

## 支持的语法

CommonMark、GFM 表格与任务列表、脚注、标题锚点、行内和块级 KaTeX 公式、代码高亮、Mermaid 图表以及经过清理的 HTML。相对路径图片按当前 Markdown 文件目录解析；无法加载的图片和图表会显示错误提示。

## 当前限制

- PDF 页面以图像方式写入。超链接仍可点击，但导出 PDF 中的正文不可搜索或选择。
- 很长的单个段落会跨页连续裁切；在极端排版下，一行文字可能落在两页边界。长表格按行拆分，长代码块按行拆分。
- 不受支持的 Markdown 扩展和复杂 HTML 请在源码模式编辑。编辑一个可视化块时会规范化该块的 Markdown 写法；其他块保持原样。
- 自定义模板图片作为页面背景使用，应在中部留出正文空间。导入大小上限为 20 MB。

## 开发和验证

```bash
npm ci
npx playwright install chromium
npm run check
npm test
npm run package
```

测试会在 Chromium 中检查块级写回、表格编辑、公式与图表、脚注、自动与手动分页，以及实际 PDF 字节。扩展入口使用 VS Code API，Webview 使用严格 CSP 和 DOM 清理。Windows、macOS 和 Linux 均使用相同的 JavaScript 实现；构建工作流分别在三个平台运行。完整的 VS Code 图形界面操作仍需在目标平台人工验收。
