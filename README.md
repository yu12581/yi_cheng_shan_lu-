# 一程山路

北航 1958 ·「北京一号」短篇探索叙事游戏。

你在校史馆修复室发现一本没有编号的「北京一号」工作人员笔记本，被它带回 1958 年。
首飞前，四个危机正在逼近：机身放样、发动机试车、蒙皮铆接、测控电缆。每一幕，你先决定
调查什么证据，再决定怎样说服现场的人行动——早先建立的信任或怀疑，会改变后面可用的选项。

- **体验时长**：约 12-15 分钟一局
- **三档结局**：提前首飞（深藏功名，含现代反转）／首飞延期／被历史抹除
- **技术形态**：纯前端 Web 游戏（原生 JS + Canvas 无依赖），Node 静态服务器

## 运行

```bash
node server.cjs
```

浏览器打开 <http://localhost:8321>（默认进入演示入口 `demo.html`）。

> 必须通过 HTTP 访问，直接双击 HTML 会被浏览器拦截本地数据请求。

## 玩法机制

| 侧栏记录 | 含义 | 后果 |
|---------|------|------|
| 工期余量 4/4 | 拖延类决断 -1；最彻底的稳妥查证也 -1 | 耗尽后首飞强制延期 |
| 危机完成 0/4 | 每幕妥善收尾 +1 | 不足 4 幕无法提前首飞 |
| 历史偏离 0/4 | 抄捷径/直接报答案等越过时代常识的行为 +1 | 达到 3，主角被历史抹除 |

每幕两段式选择：**调查**（查证最稳，但花时间）→ **决断**（说服、干预或旁观）。
信任小牛、取得赵师傅支持、消除季文怀疑，都会在后续幕里解锁原本不存在的选项。
结算同时检查偏离度、工艺口碑与工期余量，产生三个互斥结局。

## 目录结构

```
game/
  demo.html          演示入口（课程展示用，12-15 分钟垂直切片）
  index.html         长线版本入口（开发中）
  js/
    demo_main.js     演示版装配入口：只加载短篇剧本
    main.js          正式版装配入口
    core/
      StoryEngine.js        节点跳转、选项结算、状态快照
      AttributeManager.js   三维属性 + NPC 关系 + 旗标
      ConditionEvaluator.js 纯函数条件求值（旗标/属性/组合逻辑）
      ContentLoader.js      剧本 JSON 装载与校验
      LoopController.js     周循环/相位控制（正式版）
      CardManager.js        预知卡牌（正式版）
      SaveManager.js        localStorage 三槽位存档（带版本号）
      UIManager.js          渲染、打字机、反馈卡、侧栏
      AudioManager.js       Web Audio 程序化音效
      DebugPanel.js         F1 调试面板（课程现场跳结局用）
      SlideRule*.js         计算尺小游戏（正式版）
  data/
    story_demo.json  演示剧本：34 节点 / 41 选项 / 三档结局
    story_act1.json  正式版第一幕剧本
    params.json / npcs.json / cards_act1.json / tasks_act1.json / night_events.json
  test/
    demo_routes.js   四条完整路线的自动化回归（稳妥/工期耗尽/延期/抹除）
    e2_validate.js   全部剧本 JSON 的图完整性校验
  assets/            场景图（scenes/，GPT Image 2 生成）、开场视频（video/）、
                     环境音（audio/，Seed Audio 生成）、本地字体（fonts/）
server.cjs           开发服务器（根路径默认指向演示入口）
启动服务器.cmd        Windows 双击启动
```

## 测试

```bash
node test/demo_routes.js   # 三条结局路线回归
node test/e2_validate.js   # 剧本数据完整性（断链、孤立节点、类型检查）
```

## 设计与剧本文档

| 文件 | 内容 |
|------|------|
| [MINUTE_DEMO_EXPLANATION.md](MINUTE_DEMO_EXPLANATION.md) | Demo 一页讲解稿（MDA 分析 + 答辩重点） |
| [game/DEMO_GUIDE.md](game/DEMO_GUIDE.md) | 演出执行手册：8 分钟讲稿、应急预案、节点速查 |
| [storyline.txt](storyline.txt) | 原始世界观与系统设计 |
| [game_script_act1.md](game_script_act1.md) | 第一幕完整剧本（正式版） |
| [game_script_act2_factory.md](game_script_act2_factory.md) | 第二幕车间线剧本（正式版） |
| [game_design_analysis.md](game_design_analysis.md) | 设计理论分析（MDA / 心流 / SDT） |
| [code_review_issues.md](code_review_issues.md) | 三轮代码审查台账 |
| [docs/design_analysis_report_2024.md](docs/design_analysis_report_2024.md) | 早期分析报告存档 |

## 背景

「北京一号」是北京航空学院 1958 年师生用 100 天设计制造的新中国第一架轻型旅客机，
同年 8 月 1 日试飞成功。本游戏为课程作业，取材于这段校史
（史料：《"北京一号"上天记》，北京航空学院"北京一号"文学组著）。
