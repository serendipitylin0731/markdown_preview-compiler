# 上海交通大学校标组合素材来源

`sjtu-wordmark-red.svg` 从 [SJTUTeX 的横式校标矢量 PDF](https://mirrors.ctan.org/macros/latex/contrib/sjtutex/sjtu-vi-logo-std-h-cor-red.pdf) 提取 SVG 路径，未嵌入位图。`sjtu-wordmark-blue.svg` 保留相同路径，将填充色改为交大模板蓝色 `#17618d`。原始 SJTUTeX 包采用 [LPPL 1.3c](https://ctan.org/pkg/sjtutex)；校标组合的使用参照[上海交通大学视觉形象识别系统](https://vi.sjtu.edu.cn/index.php/articles/base/4)。

运行 `npm run render:sjtu` 可以从这两个 SVG 重新生成各纸张和方向的 300 dpi 模板背景。
