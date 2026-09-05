# 一程山路 · 内容数据字段规范

> 版本：2026-08-25 ｜ 面向：内容线（04）｜ 引擎侧对接人：引擎开发
> 自检命令：`node game/test/e2_validate.js`（提交前必跑，0 错误方可合入）

## 一、数据文件与加载

| 文件 | 类型 | 职责 | 缺失时 |
|---|---|---|---|
| `data/story_act1.json` | story | 分周配置 + 全部节点 | 必需，缺失无法开局 |
| `data/cards_act1.json` | cards | 预知卡池 | 可选，无手牌系统 |
| `data/tasks_act1.json` | tasks | 周任务牌池 | 可选 |
| `data/npcs.json` | npcs | NPC 名册（好感阶段元数据） | 可选，仅内置六人 |
| `data/params.json` | params | 全局参数（体力/偏离/周预设） | 可选，用引擎默认 |

引擎启动按上表顺序加载；`*legacy*` 文件不加载也不校验。
校验器按**结构自动识别类型**，无需在文件内声明。

## 二、story_act1.json

```json
{
  "weeks": { "1": { "label": "残周", "days": ["thu","fri","sat","sun"],
                     "apPerDay": 1, "nightFromDay": "fri",
                     "mainCard": false, "overdueCrisis": false } },
  "nodes": { "<node_id>": { ...节点对象... } }
}
```

### weeks[N]
| 字段 | 类型 | 说明 |
|---|---|---|
| `days` | string[] | **决定该周天数与日序**（`nightFromDay` 按此解析）；未定义的周继承 params 预设（W1=tutorial，其余=full） |
| `apPerDay` | number | 每日行动点 |
| `nightFromDay` | string | 从哪个日名起有夜选；早于该日的白天行动只能 `dayAdvance` 入睡或直落结算 |
| `mainCard` | bool | 是否启用主线牌时限（→ deadlineEnabled） |
| `overdueCrisis` | bool | 主线逾期是否接修正危机链 |

### 节点对象
| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | string | 正文（引擎映射为 narrative；`\n\n` 分段） |
| `phase` | string | 五相位之一：`WEEK_START/DAY_START/DAY_ACTION/NIGHT_CHOICE/WEEK_SETTLE`；**序章/自由场景写 `"FREE"`**（会被剥离为自由节点，任意相位可进） |
| `date/time/location/cast/env` | - | 纯展示元数据（env 留给 05 视听） |
| `goto` | string | 无选项续接（引擎映射为 autoNext；点击正文或"继续"按钮前进） |
| `effects` | object | **节点级入场效果**——每次进入都生效，慎用！键限三属性 |
| `choices` | array | 见下表 |

### choice 对象
| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | string | 必填 |
| `goto` | string | 目标节点 id（多选项节点每项都必须有去向） |
| `slot` | string | UI 提示位（aggressive/steady/…），暂仅展示 |
| `costHint` | string | 代价显影文案，渲染在按钮下方（如"偏离+2·留下破绽"） |
| `effects` | object | 属性键：`stamina/integration/deviation`（数值）；特殊键见下 |
| `npc` | object | 好感增量 `{ "fang": 1, "niu": 1 }`；也允许写在 effects.npc 内 |
| `flags` | string[] | 批量设旗标（旗标名建议 `f_` 前缀） |
| `progressTags` | string[] | 标签制任务进度：命中任务牌 `progressFrom` 即 +workProgressBase |
| `condition` | object | 显隐条件（见 §五）；叙事门槛隐藏、资源门槛置灰 |

#### effects 特殊键（由循环系统路由，不进属性）
| 键 | 形状 | 行为 |
|---|---|---|
| `taskId` + `taskProgress` | string + number | 直连指定任务牌进度（两者须成对出现） |
| `exploreTags` | string[] | 记录探索标签（支线池消费） |
| `npc` | object | 同顶层 npc 字段 |

#### 白天行动的隐式规则
- `DAY_ACTION` 相位的选项**默认耗 1 AP**；免费动作显式写 `"costAP": 0`
- AP 不足时选项整体否决（UI 置灰显示"行动点不足"）

## 三、cards_act1.json / night_events.json

### cards_act1.json
```json
{ "cards": [{
    "id": "card_chentao_xujing",
    "name": "衬套虚惊",              // → title
    "tier": "heavy",                 // heavy=portal / light=即时效果
    "window": { "fromWeek": 3, "fromDay": "mon", "toWeek": 3, "toDay": "wed" },
    "consumable": true,              // false=可重复打出
    "acquire": { "exploreTag": "explore_inspect_station" },   // 获得途径（展示）
    "onPlay": {
      "mode": "portal",
      "goto": "card_chentao_xujing_portal"   // ★目标节点必须存在且建议 freeNode:true
    },
    "onSeal": {                      // 封存（不打）结局
      "witnessFlag": "f_witness_chentao",   // 设旗标
      "confidence": -1,                     // 团队信心变化（隐藏参数）
      "historyText": "……按史实发生。"        // 史实文本入封存日志
    }
}]}
```
- 轻卡省略 onPlay.goto、直接给 `onPlay.effects`（同 choice.effects 键规则）
- 打出 = 干预历史（分支选项里计偏离代价）；封存 = 见证标记★+1

### night_events.json（schema §12，夜谈/夜遇事件池）
```json
{ "events": [{
    "id": "ne_w2_zhao_whip",         // 建议 ne_ 前缀，全局唯一
    "week": 2,
    "day": null,                     // null=本周任意夜；否则日名 mon..sun
    "talkTo": "zhao",                // 夜谈对象；null/缺省=无对象的环境夜遇
    "showIf": { "npc": "zhao", "op": ">=", "v": 1 },  // 或 {"flag":"f_xxx"} 或 null
    "priority": 20,                  // 同刻多事件时取最高者
    "once": true,                    // 缺省视为 true（一次性）；false 可重复触发
    "title": "四十皮鞭",
    "text": "……",                    // 正文
    "result": "……",                  // 结尾示意（展示层用）
    "effects": { "integration": 1, "exploreTags": ["explore_dispatch"] },
    "npc": { "zhao": 1 },            // ★增量映射。不要与归属者字段撞键——
                                     // 归属者只写 talkTo；同一对象内重复键会被 E2 报错，
                                     // JSON.parse 静默取后者会导致归属信息丢失
    "flags": ["f_knew_old_rules"]
}]}
```
引擎运行时 API（供 UI 接入）：`loopController.pickNightEvent({talkTo})` → 事件或 null；
`applyNightEvent(ev)` 结算 effects/npc/flags 并记录 fired（随存档持久化）。

## 四、tasks_act1.json / npcs.json / params.json

**tasks**：
```json
{ "tasks": [{ "id": "task_w2_main_weiduankuang", "week": 2, "kind": "main",
  "name": "苦战五昼夜·尾段框", "target": 6,
  "progressFrom": ["work_frame","overtime_default"],
  "rewards":   { "integration": 1, "confidence": 1 },
  "onMiss":    { "crisisChain": "crisis_w2_main", "deviation": 12 } }]}
```
- `rewards/onMiss` 键：三属性 / `confidence`（团队信心）/ `crisisChain`（字符串=逾期要设的危机旗标名，仅 onMiss 有意义）
- `deadline` 字段当前为纯展示；结算发生在每周最后一个夜晚之后

**npcs**：`stageThresholds 数 = stages 数 − 1`（阶段数可变：两阶段 `[8]+["戒备","信任"]` 与四阶段均合法，阈值严格递增）；`firstMeetNode` 必须指向存在的节点。

**params**：`weeks.tutorial/full` 为未显式定义周的兜底预设；`stamina.max/morningRecovery` 直接生效；`deviation.thresholds/slideRulePerfectBonus/overtimeStaminaCost` 存入 `loopController.config.gameParams` 供 UI/小游戏读取。

## 五、条件表达式（choice.condition）

```json
{ "res":  { "stamina": "<=20", "deviation": "<10" } },   // 三属性门槛 → 置灰+原因
{ "npc":  { "fang": ">=30" } },                          // 好感阶段 → 隐藏
{ "flag": "f_fang_shield" },                             // 旗标 → 隐藏
{ "week": ">=2", "day": "<=5" },                         // 时间窗 → 隐藏
{ "card": "card_chentao_xujing" },                       // 手牌持有 → 置灰+原因
{ "all": [ ... ] }, { "any": [ ... ] }, { "not": { ... } }
```
比较符：`>= <= > < == !=` + 数字。混合条件按资源门槛处理（置灰优先）。

## 六、相位白名单（引擎强制，内容线必须遵守）

```
WEEK_START → DAY_START → DAY_ACTION ⇄(耗AP) → NIGHT_CHOICE → 次日 DAY_START …
                                    └→（无夜选日）WEEK_SETTLE
NIGHT_CHOICE（末日）→ WEEK_SETTLE → WEEK_START ↺
```
- 节点的 `phase` 决定它能在哪个相位被进入；跨相位跳转会被拒绝并在控制台告警
- 不属于循环的场景（序章/卡牌传送门/过场）写 `phase:"FREE"` 或加 `"freeNode": true`

## 七、分周配置优先级（已验证，harness §[7]）

```
故事 weeks[N] 显式键  >  params 预设（W1=tutorial，其余=full）  >  引擎内置默认
```
- 三层按键合并；**显式 undefined 不遮蔽**已有值
- 故事未定义第 N 周时：整周落入预设档（W1 兜底 tutorial，其余兜底 full）
- 当前 story_act1 与 params 预设数值一致，冲突时以故事为准（测试覆盖了人为冲突场景）

## 八、已知待办（E2 当前警告/错误项，内容线认领）

1. **【错误×7】night_events.json 每个事件顶层 `"npc"` 键重复**（归属者 vs 增量映射撞键，行16/32/48/64/79/94/109）。修复：归属者只写 `talkTo`，增量保留在 `npc:{...}`。当前引擎靠 JSON.parse 后者覆盖语义 + talkTo 兜底才能工作
2. `card_chentao_xujing_portal` 的三个选项缺 `goto` —— W3 衬套卡打出后会卡在该节点
3. `diary_act1` 死端无出口 —— 若为幕间日记展示，建议补 autoNext 或命名含 end
