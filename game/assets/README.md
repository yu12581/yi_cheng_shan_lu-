# 短篇外部资源目录

资源命名和生成要求见 `game/design/AUDIO_VISUAL_ASSET_BRIEF.md`。

所有外部资源均为可选增强：

- `scenes/` 缺图时自动回退到 `design/ref/` 中的现有参考图。
- `music/` 缺音乐时保留现有 Web Audio 程序化环境声。
- `video/bj1-opening.mp4` 缺失时开始菜单直接显示，不出现空视频框。
- `portraits/` 与 `props/` 当前只列制作规格，后续接入时不要改剧情 JSON。
