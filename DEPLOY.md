# 《一程山路》Demo 部署指南（Track A · 09）

## 手机试玩（同一 WiFi）

1. 以**管理员身份**打开 PowerShell，执行一次（放行 8321 端口入站）：
   ```
   netsh advfirewall firewall add rule name="YiChengShanLu Dev 8321" dir=in action=allow protocol=TCP localport=8321
   ```
2. 确保开发服务器在跑（本机已启动，重启电脑后需重开）：
   ```
   node <服务器脚本>
   ```
   或任意静态服务器，如 `python -m http.server 8321 --directory game`（在仓库根目录）
3. 手机连同一 WiFi，浏览器打开：`http://10.137.145.20:8321`
   （IP 变了就用 `ipconfig` 查当前 IPv4）

## 正式发布（发同学不用开你电脑）

纯静态零构建，任选其一：

| 方式 | 步骤 |
|------|------|
| **GitHub Pages**（推荐） | 仓库上传 `game/` 目录 → Settings → Pages → main 分支 /root → 得到 `https://<用户名>.github.io/<仓库名>/` |
| **Vercel / Netlify** | 拖拽 `game/` 文件夹到 dashboard 即可 |
| **内网穿透** | `npx serve game` + cpolar/natapp 临时链接（微信里直接点开） |

微信内打开注意：音频需首次点击屏幕后才解锁（已适配）；若被微信内置浏览器拦
截可点右上角"在浏览器打开"。

## 验收清单（09 Acceptance）

- [x] 首屏体积 398.5 KB < 2MB 预算
- [x] 移动端断点（1024/767px）+ 点击目标 ≥44px（--tap-min）
- [ ] 真机全流程试玩（放行防火墙后自测）
- [ ] 发 3-5 个同学收集"紧迫感/代入感"反馈（Track A 验收标准）

## 已知边界

- 文楷字体走 CDN，离线/弱网回退系统楷体不破版
- 旋律 BGM 未做（Demo 允许环境音床+静默）
- 修正征兆的 mode-decay 视觉档为预留（tokens.css 已留接口）
