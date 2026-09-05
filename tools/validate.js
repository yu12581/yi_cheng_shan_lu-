#!/usr/bin/env node
"use strict";
/*
 * validate.js —— 《一程山路》剧情数据校验器（E2）
 * 零依赖，纯 node:fs。用法：
 *   node validate.js <storyJson路径> [更多json...]   校验并输出错误清单
 *   node validate.js --schema-only                   内置样例自检
 * 退出码：无错误 0；有错误或致命输入 1。任何输入都不崩溃。
 * 契约依据：game/design/_e1-schema.md v1.0
 */

const fs = require("fs");
const path = require("path");

// ---------- 常量（与 _e1-schema.md v1.0 同步） ----------
const CONTAINER_KEYS = ["all", "any", "not"];
const LEAF_SOURCES = ["res", "npc", "flag", "week", "day", "card"];
const RES_KEYS = ["stamina", "integration", "deviation"];
const OPS = [">=", "<=", "==", "<", ">"];
const NODE_TYPES = ["story", "choice", "night", "settle", "event", "diary", "card_portal"];
const PHASES = ["FREE", "WEEK_START", "DAY_START", "DAY_ACTION", "NIGHT_CHOICE", "WEEK_SETTLE"];
const SLOTS = ["aggressive", "steady", "conservative"];
const EFFECT_NUM_KEYS = ["stamina", "integration", "deviation", "confidence"];
const REWARD_KEYS = ["confidence", "approval", "integration", "stamina", "deviation"];
const TASK_KINDS = ["main", "side", "teaching"]; // teaching 为迁移期旧值容忍项
const WEEKDAYS = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
const MAX_DEPTH = 48;
const CHOICE_TEXT_MAX = 20; // 内容军规：仅警告不判错

// ---------- 报告收集 ----------
const report = [];
function err(file, nodeId, where, msg) { report.push({ level: "error", file, nodeId, where, msg }); }
function warn(file, nodeId, where, msg) { report.push({ level: "warn", file, nodeId, where, msg }); }
function clearReport() { report.length = 0; }

// ---------- 工具 ----------
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function dayToNum(v) {
  if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 7) return v;
  if (typeof v === "string" && Object.prototype.hasOwnProperty.call(WEEKDAYS, v)) return WEEKDAYS[v];
  return null;
}
function relPath(file) {
  let abs;
  try { abs = path.resolve(file); } catch (e) { return String(file); }
  const rel = path.relative(process.cwd(), abs);
  return rel && !rel.startsWith("..") ? rel : abs;
}

// ---------- 条件对象校验（契约 §3） ----------
function validateCondition(cond, ctx, where) {
  ctx.depth++;
  try {
    if (ctx.depth > MAX_DEPTH) {
      err(ctx.file, ctx.nodeId, where, `条件嵌套超过 ${MAX_DEPTH} 层，疑似写错结构`);
      return;
    }
    if (!isPlainObject(cond)) {
      err(ctx.file, ctx.nodeId, where, `条件必须是对象，实际为 ${Array.isArray(cond) ? "数组" : typeof cond}`);
      return;
    }
    const keys = Object.keys(cond);
    const containers = keys.filter((k) => CONTAINER_KEYS.includes(k));
    if (containers.length > 0) {
      if (containers.length > 1) {
        err(ctx.file, ctx.nodeId, where, `一个条件对象只能有一个容器键，实际出现: ${containers.join(", ")}`);
        return;
      }
      const key = containers[0];
      if (keys.length > 1) {
        err(ctx.file, ctx.nodeId, where, `容器 "${key}" 的对象里混入了非容器键: ${keys.filter((k) => k !== key).join(", ")}`);
        return;
      }
      const val = cond[key];
      if (!Array.isArray(val)) {
        err(ctx.file, ctx.nodeId, where, `容器 "${key}" 的值必须是数组（可嵌套），实际为 ${typeof val}`);
        return;
      }
      if (val.length === 0) warn(ctx.file, ctx.nodeId, where, `容器 "${key}" 为空数组（求值恒真/恒空，请确认）`);
      if (key === "not" && val.length > 1) {
        warn(ctx.file, ctx.nodeId, where, `"not" 容器建议恰好包含 1 个条件（多个时按 all 语义取反处理）`);
      }
      for (let i = 0; i < val.length; i++) {
        validateCondition(val[i], ctx, `${where}.${key}[${i}]`);
      }
      return;
    }
    // 叶子
    const sources = keys.filter((k) => LEAF_SOURCES.includes(k));
    if (sources.length === 0) {
      err(ctx.file, ctx.nodeId, where, `叶子缺少来源键（合法: res/npc/flag/week/day/card），实际键: ${keys.join(", ") || "(空)"}`);
      return;
    }
    if (sources.length > 1) {
      err(ctx.file, ctx.nodeId, where, `一个叶子只能有一个来源键，实际有: ${sources.join(", ")}`);
      return;
    }
    const src = sources[0];
    if (src === "res") {
      if (!RES_KEYS.includes(cond.res)) {
        err(ctx.file, ctx.nodeId, where, `res 来源只允许 stamina/integration/deviation，实际为 ${JSON.stringify(cond.res)}`);
      }
      checkOpValue(cond, ctx, where);
    } else if (src === "npc") {
      const id = cond.npc;
      if (typeof id !== "string" || !id) {
        err(ctx.file, ctx.nodeId, where, `npc 叶子的 npc 必须是非空字符串`);
      } else if (ctx.npcIds && !ctx.npcIds.has(id)) {
        err(ctx.file, ctx.nodeId, where, `引用了未知的 NPC id: "${id}"（npcs.json 中不存在）`);
      }
      checkOpValue(cond, ctx, where);
    } else if (src === "flag") {
      if (typeof cond.flag !== "string" || !cond.flag) {
        err(ctx.file, ctx.nodeId, where, `flag 叶子的 flag 必须是非空字符串`);
      }
    } else if (src === "week") {
      if (!Number.isInteger(cond.week) || cond.week < 1) {
        err(ctx.file, ctx.nodeId, where, `week 叶子必须是 >=1 的整数，实际为 ${JSON.stringify(cond.week)}`);
      }
    } else if (src === "day") {
      if (dayToNum(cond.day) === null) {
        err(ctx.file, ctx.nodeId, where, `day 叶子必须是 1-7 的整数或缩写 mon..sun，实际为 ${JSON.stringify(cond.day)}`);
      }
    } else if (src === "card") {
      const cid = cond.card;
      if (typeof cid !== "string" || !cid) {
        err(ctx.file, ctx.nodeId, where, `card 叶子的 card 必须是非空字符串`);
      } else if (ctx.cardIds && !ctx.cardIds.has(cid)) {
        warn(ctx.file, ctx.nodeId, where, `条件引用的卡 "${cid}" 不在本次加载的卡池中（若卡定义在别处请忽略）`);
      }
    }
  } finally {
    ctx.depth--;
  }
}

function checkOpValue(cond, ctx, where) {
  if (!OPS.includes(cond.op)) {
    err(ctx.file, ctx.nodeId, where, `op 只允许 >=/<=/==/</> ，实际为 ${JSON.stringify(cond.op)}`);
  }
  if (typeof cond.value !== "number" || Number.isNaN(cond.value)) {
    err(ctx.file, ctx.nodeId, where, `value 必须是数字，实际为 ${JSON.stringify(cond.value)}`);
  }
}

// ---------- effects 校验（契约 §2.3） ----------
function validateEffects(effects, ctx, where) {
  if (!isPlainObject(effects)) {
    err(ctx.file, ctx.nodeId, where, `effects 必须是对象，实际为 ${typeof effects}`);
    return;
  }
  let hasTaskId = false;
  let hasTaskProgress = false;
  for (const k of Object.keys(effects)) {
    const v = effects[k];
    if (k === "taskId") {
      hasTaskId = true;
      if (typeof v !== "string" || !v) err(ctx.file, ctx.nodeId, `${where}.taskId`, `必须是任务牌 id 字符串`);
      continue;
    }
    if (k === "taskProgress") {
      hasTaskProgress = true;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        err(ctx.file, ctx.nodeId, `${where}.taskProgress`, `必须是数字，实际为 ${JSON.stringify(v)}`);
      }
      continue;
    }
    if (EFFECT_NUM_KEYS.includes(k)) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        err(ctx.file, ctx.nodeId, `${where}.${k}`, `效果值必须是数字，实际为 ${JSON.stringify(v)}`);
      }
      continue;
    }
    if (k === "exploreTags") {
      if (!Array.isArray(v) || v.some((t) => typeof t !== "string" || !t)) {
        err(ctx.file, ctx.nodeId, `${where}.exploreTags`, `exploreTags 必须是非空字符串数组`);
      }
      continue;
    }
    if (k === "npc") {
      validateNpcMap(v, ctx, `${where}.npc`);
      continue;
    }
    err(ctx.file, ctx.nodeId, `${where}.${k}`, `未知的效果键（合法: ${EFFECT_NUM_KEYS.join("/")} + taskId/taskProgress 成对）`);
  }
  if (hasTaskId !== hasTaskProgress) {
    warn(ctx.file, ctx.nodeId, where, `"taskId 与 taskProgress 应成对出现在 effects 中"`);
  }
}

// ---------- npc 增减表校验 ----------
function validateNpcMap(map, ctx, where) {
  if (!isPlainObject(map)) {
    err(ctx.file, ctx.nodeId, where, `NPC 增减表必须是对象 { "<npcId>": ±整数 }`);
    return;
  }
  for (const k of Object.keys(map)) {
    const v = map[k];
    if (typeof v !== "number" || !Number.isInteger(v)) {
      err(ctx.file, ctx.nodeId, `${where}.${k}`, `好感增减必须是整数，实际为 ${JSON.stringify(v)}`);
    }
    if (ctx.npcIds && !ctx.npcIds.has(k)) {
      err(ctx.file, ctx.nodeId, `${where}.${k}`, `引用了未知的 NPC id: "${k}"（npcs.json 中不存在）`);
    }
  }
}

// ---------- choice 校验（契约 §2） ----------
function validateChoice(choice, ctx, where) {
  if (!isPlainObject(choice)) {
    err(ctx.file, ctx.nodeId, where, `选项必须是对象，实际为 ${typeof choice}`);
    return;
  }
  if (typeof choice.text !== "string" || !choice.text.trim()) {
    err(ctx.file, ctx.nodeId, `${where}.text`, `选项缺少非空 text`);
  } else if ([...choice.text].length > CHOICE_TEXT_MAX) {
    warn(ctx.file, ctx.nodeId, `${where}.text`, `选项文本超过 ${CHOICE_TEXT_MAX} 字（内容军规≤20字·动词开头，仅提醒）`);
  }
  // 硬检查②：choice.goto 目标存在
  if (typeof choice.goto !== "string" || !choice.goto) {
    err(ctx.file, ctx.nodeId, `${where}.goto`, `选项缺少 goto 目标节点`);
  } else if (!ctx.nodeIds.has(choice.goto)) {
    err(ctx.file, ctx.nodeId, `${where}.goto`, `goto 目标节点不存在: "${choice.goto}"`);
  }
  if (choice.conditions !== undefined) validateCondition(choice.conditions, ctx, `${where}.conditions`);
  if (choice.effects !== undefined) validateEffects(choice.effects, ctx, `${where}.effects`);
  if (choice.npcChanges !== undefined) validateNpcMap(choice.npcChanges, ctx, `${where}.npcChanges`);
  if (choice.npc !== undefined) validateNpcMap(choice.npc, ctx, `${where}.npc(旧字段)`);
  if (choice.setFlag !== undefined) collectSetFlags(choice.setFlag, ctx, `${where}.setFlag`);
  if (choice.flags !== undefined) collectSetFlags(choice.flags, ctx, `${where}.flags(旧字段)`);
  if (choice.slot !== undefined && !SLOTS.includes(choice.slot)) {
    warn(ctx.file, ctx.nodeId, `${where}.slot`, `非常规槽位 "${choice.slot}"（常规: aggressive/steady/conservative）`);
  }
  for (const tagKey of ["progressTags", "exploreTags"]) {
    const tags = choice[tagKey];
    if (tags !== undefined) {
      if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) {
        err(ctx.file, ctx.nodeId, `${where}.${tagKey}`, `必须是字符串数组`);
      } else {
        tags.forEach((t) => ctx.progressTags.add(t));
      }
    }
  }
}

function collectSetFlags(v, ctx, where) {
  const arr = Array.isArray(v) ? v : [v];
  for (const f of arr) {
    if (typeof f !== "string" || !f) {
      err(ctx.file, ctx.nodeId, where, `setFlag 元素必须是非空字符串`);
    } else {
      ctx.definedFlags.add(f);
    }
  }
}

// ---------- node 校验（契约 §1） ----------
function validateNode(node, key, ctx) {
  if (!isPlainObject(node)) {
    err(ctx.file, key, "", `节点必须是对象，实际为 ${typeof node}`);
    return;
  }
  // 硬检查①：必填字段
  if (typeof node.id !== "string" || !node.id) {
    err(ctx.file, key, "id", `节点缺少 id 字段`);
  } else if (node.id !== key) {
    warn(ctx.file, key, "id", `id "${node.id}" 与所在 nodes 映射的键 "${key}" 不一致`);
  }
  if (typeof node.text !== "string" || !node.text.trim()) {
    err(ctx.file, key, "text", `节点缺少非空 text 正文`);
  }
  const type = node.type || "story";
  if (!NODE_TYPES.includes(type)) {
    err(ctx.file, key, "type", `未知节点类型 "${type}"（合法: ${NODE_TYPES.join("/")}）`);
  }
  for (const f of ["date", "time", "location"]) {
    if (typeof node[f] !== "string" || !node[f].trim()) {
      err(ctx.file, key, f, `展示字段缺失或为空（契约 §1.2 要求必备）`);
    }
  }
  if (node.act !== undefined && !Number.isInteger(node.act)) {
    err(ctx.file, key, "act", `act 必须是整数，实际为 ${JSON.stringify(node.act)}`);
  }
  if (node.week !== undefined && !Number.isInteger(node.week)) {
    err(ctx.file, key, "week", `week 必须是整数，实际为 ${JSON.stringify(node.week)}`);
  }
  if (node.day !== undefined && dayToNum(node.day) === null) {
    err(ctx.file, key, "day", `day 必须是 1-7 整数或缩写 mon..sun，实际为 ${JSON.stringify(node.day)}`);
  }
  if (node.phase !== undefined && !PHASES.includes(node.phase)) {
    warn(ctx.file, key, "phase", `非常规相位 "${node.phase}"（常规: ${PHASES.join("/")}）`);
  }
  if (node.wordBudget !== undefined && typeof node.wordBudget !== "number") {
    err(ctx.file, key, "wordBudget", `wordBudget 必须是数字，实际为 ${JSON.stringify(node.wordBudget)}`);
  }

  let hasChoices = false;
  if (node.choices !== undefined) {
    if (!Array.isArray(node.choices)) {
      err(ctx.file, key, "choices", `choices 必须是数组`);
    } else if (node.choices.length === 0) {
      warn(ctx.file, key, "choices", `choices 为空数组（选择节点没有任何选项）`);
    } else {
      hasChoices = true;
      node.choices.forEach((c, i) => validateChoice(c, ctx, `choices[${i}]`));
    }
  }
  if (node.goto !== undefined && node.goto !== null) {
    if (typeof node.goto !== "string" || !node.goto) {
      err(ctx.file, key, "goto", `goto 必须是非空目标节点 id 或 null`);
    } else if (!ctx.nodeIds.has(node.goto)) {
      err(ctx.file, key, "goto", `goto 目标节点不存在: "${node.goto}"`);
    }
  }
  if (!hasChoices && (node.goto === undefined || node.goto === null)) {
    warn(ctx.file, key, "", `死端节点（无 goto 也无 choices）；若为章节/周目终点可忽略此警告`);
  }
  if (node.conditions !== undefined) validateCondition(node.conditions, ctx, "conditions");
  if (node.effects !== undefined) validateEffects(node.effects, ctx, "effects");
  if (node.nightOptions !== undefined) {
    if (!Array.isArray(node.nightOptions) || node.nightOptions.length === 0) {
      err(ctx.file, key, "nightOptions", `night 节点的 nightOptions 必须是非空数组`);
    } else {
      node.nightOptions.forEach((opt, i) => {
        const w = `nightOptions[${i}]`;
        if (!isPlainObject(opt)) {
          err(ctx.file, key, w, `夜间选项必须是对象`);
          return;
        }
        if (typeof opt.key !== "string" || !opt.key) err(ctx.file, key, `${w}.key`, `缺少 key（rest/overtime/talk）`);
        if (typeof opt.text !== "string" || !opt.text.trim()) err(ctx.file, key, `${w}.text`, `缺少非空 text`);
        if (typeof opt.result !== "string" || !opt.result.trim()) warn(ctx.file, key, `${w}.result`, `缺少 result 反馈文案`);
        if (opt.effects !== undefined) validateEffects(opt.effects, ctx, `${w}.effects`);
        if (opt.npc !== undefined) validateNpcMap(opt.npc, ctx, `${w}.npc`);
        if (opt.progressTags !== undefined) {
          if (!Array.isArray(opt.progressTags)) {
            err(ctx.file, key, `${w}.progressTags`, `必须是字符串数组`);
          } else opt.progressTags.forEach((t) => ctx.progressTags.add(t));
        }
      });
    }
  }
}

// ---------- 卡片校验（契约 §5） ----------
function validateWindowPoint(pt, ctx, where) {
  if (!isPlainObject(pt)) {
    err(ctx.file, ctx.nodeId, where, `窗口端点必须是 { week, day } 对象`);
    return null;
  }
  if (!Number.isInteger(pt.week) || pt.week < 1) {
    err(ctx.file, ctx.nodeId, `${where}.week`, `week 必须是 >=1 的整数，实际为 ${JSON.stringify(pt.week)}`);
  }
  const d = dayToNum(pt.day);
  if (d === null) {
    err(ctx.file, ctx.nodeId, `${where}.day`, `day 必须是 1-7 整数或缩写 mon..sun，实际为 ${JSON.stringify(pt.day)}`);
  }
  return { week: pt.week, day: d };
}

function validateCard(card, idx, ctx) {
  const where = `cards[${idx}]`;
  if (!isPlainObject(card)) {
    err(ctx.file, `card#${idx}`, where, `卡必须是对象，实际为 ${typeof card}`);
    return;
  }
  const nid = typeof card.id === "string" && card.id ? card.id : `card#${idx}`;
  if (typeof card.id !== "string" || !card.id) {
    err(ctx.file, nid, `${where}.id`, `卡缺少非空 id`);
  } else if (ctx.seenCardIds.has(card.id)) {
    err(ctx.file, nid, `${where}.id`, `卡 id 重复: "${card.id}"`);
  }
  ctx.seenCardIds.add(card.id);
  ctx.cardIds.add(card.id);

  if (typeof card.name !== "string" || !card.name.trim()) err(ctx.file, nid, `${where}.name`, `卡缺少非空 name`);
  if (typeof card.ref !== "string" || !card.ref.trim()) {
    warn(ctx.file, nid, `${where}.ref`, `缺少史实锚点 ref（契约要求可溯源）`);
  }
  if (typeof card.consumable !== "boolean") {
    err(ctx.file, nid, `${where}.consumable`, `consumable 必须是 boolean（03 D3：窗口制+一次性）`);
  }
  if (!isPlainObject(card.window)) {
    err(ctx.file, nid, `${where}.window`, `缺少 window 窗口 { from:{week,day}, to:{week,day} }`);
  } else {
    const from = validateWindowPoint(card.window.from, ctx, `${where}.window.from`);
    const to = validateWindowPoint(card.window.to, ctx, `${where}.window.to`);
    if (from && to && from.day !== null && to.day !== null) {
      if (from.week > to.week || (from.week === to.week && from.day > to.day)) {
        err(ctx.file, nid, `${where}.window`, `窗口 from 晚于 to`);
      }
    }
  }
  // 双形态判定 + 硬检查④
  const hasHeavy = isPlainObject(card.onPlay) && typeof card.onPlay.goto === "string" && !!card.onPlay.goto;
  const hasLight = card.effects !== undefined && card.effects !== null;
  if (hasHeavy) {
    if (!ctx.nodeIds.has(card.onPlay.goto)) {
      err(ctx.file, nid, `${where}.onPlay.goto`, `重卡通传送门的目标节点不存在: "${card.onPlay.goto}"`);
    }
    if (card.onPlay.deviationBase !== undefined && typeof card.onPlay.deviationBase !== "number") {
      err(ctx.file, nid, `${where}.onPlay.deviationBase`, `deviationBase 必须是数字，实际为 ${JSON.stringify(card.onPlay.deviationBase)}`);
    }
    if (hasLight) {
      warn(ctx.file, nid, `${where}`, `重卡不应有顶层 effects（计价应放在分支选项的 effects.deviation）`);
    }
  } else if (hasLight) {
    validateEffects(card.effects, ctx, `${where}.effects`);
  } else {
    err(ctx.file, nid, `${where}`, `卡片双形态缺失：必须有 onPlay{goto}(重卡) 或 effects(轻卡) 之一`);
  }
  // 硬检查⑤
  if (!isPlainObject(card.ifSealed)) {
    warn(ctx.file, nid, `${where}.ifSealed`, `缺少封存结局 ifSealed{witness,confidence,goto}（03 D3 每张卡双结局）`);
  } else {
    const s = card.ifSealed;
    if (s.witness !== undefined && typeof s.witness !== "boolean") {
      err(ctx.file, nid, `${where}.ifSealed.witness`, `witness 必须是 boolean`);
    }
    if (s.confidence !== undefined && typeof s.confidence !== "number") {
      err(ctx.file, nid, `${where}.ifSealed.confidence`, `confidence 必须是数字，实际为 ${JSON.stringify(s.confidence)}`);
    }
    if (s.goto !== undefined && s.goto !== null) {
      if (typeof s.goto !== "string" || !s.goto) {
        err(ctx.file, nid, `${where}.ifSealed.goto`, `goto 必须是非空节点 id 或 null`);
      } else if (!ctx.nodeIds.has(s.goto)) {
        err(ctx.file, nid, `${where}.ifSealed.goto`, `封存结局跳转的目标节点不存在: "${s.goto}"`);
      }
    }
  }
}

// ---------- 任务牌校验（契约 §4） ----------
function validateTask(task, idx, ctx) {
  const where = `tasks[${idx}]`;
  if (!isPlainObject(task)) {
    err(ctx.file, `task#${idx}`, where, `任务牌必须是对象，实际为 ${typeof task}`);
    return;
  }
  const nid = typeof task.id === "string" && task.id ? task.id : `task#${idx}`;
  if (typeof task.id !== "string" || !task.id) {
    err(ctx.file, nid, `${where}.id`, `任务牌缺少非空 id`);
  } else if (ctx.seenTaskIds.has(task.id)) {
    err(ctx.file, nid, `${where}.id`, `任务牌 id 重复: "${task.id}"`);
  }
  ctx.seenTaskIds.add(task.id);

  if (typeof task.name !== "string" || !task.name.trim()) err(ctx.file, nid, `${where}.name`, `缺少非空 name`);

  const kind = task.type !== undefined ? task.type : task.kind;
  if (kind === undefined) {
    err(ctx.file, nid, `${where}.type`, `缺少 type（main/side）`);
  } else if (!TASK_KINDS.includes(kind)) {
    err(ctx.file, nid, `${where}.type`, `type 只允许 main/side（teaching 为迁移期旧值），实际为 "${kind}"`);
  } else if (kind === "teaching") {
    warn(ctx.file, nid, `${where}.type`, `kind:"teaching" 为旧写法，规范值为 type:"side"（教学特例）`);
  } else if (task.kind !== undefined && task.type === undefined) {
    warn(ctx.file, nid, `${where}.type`, `使用旧字段 kind，规范字段名为 type`);
  }

  let targetNum = null;
  if (isPlainObject(task.target)) {
    if (typeof task.target.progress !== "number" || !Number.isFinite(task.target.progress)) {
      err(ctx.file, nid, `${where}.target.progress`, `必须是数字，实际为 ${JSON.stringify(task.target.progress)}`);
    } else targetNum = task.target.progress;
  } else if (typeof task.target === "number") {
    targetNum = task.target; // 迁移期裸数字容忍
  } else {
    err(ctx.file, nid, `${where}.target`, `target 必须是 { progress: N } 或迁移期裸数字`);
  }

  if (ctx.params && kind === "main") {
    const td = ctx.params.taskDefaults || {};
    if (targetNum !== null && typeof td.mainTargetMin === "number" && typeof td.mainTargetMax === "number") {
      if (targetNum < td.mainTargetMin || targetNum > td.mainTargetMax) {
        warn(ctx.file, nid, `${where}.target`, `主线牌进度 ${targetNum} 超出参数表区间 [${td.mainTargetMin},${td.mainTargetMax}]（params.json taskDefaults）`);
      }
    }
  }

  if (task.rewards !== undefined) {
    if (!isPlainObject(task.rewards)) {
      err(ctx.file, nid, `${where}.rewards`, `rewards 必须是对象`);
    } else {
      for (const k of Object.keys(task.rewards)) {
        const v = task.rewards[k];
        if (k === "npc") {
          validateNpcMap(v, ctx, `${where}.rewards.npc`);
        } else if (REWARD_KEYS.includes(k)) {
          if (typeof v !== "number" || !Number.isFinite(v)) {
            err(ctx.file, nid, `${where}.rewards.${k}`, `奖励值必须是数字，实际为 ${JSON.stringify(v)}`);
          }
        } else {
          err(ctx.file, nid, `${where}.rewards.${k}`, `未知的奖励键（合法: ${REWARD_KEYS.join("/")}/npc）`);
        }
      }
    }
  }

  if (task.onMiss === undefined) {
    err(ctx.file, nid, `${where}.onMiss`, `缺少 onMiss（逾期事件 id 或 null）`);
  } else if (task.onMiss !== null) {
    if (typeof task.onMiss === "string") {
      if (!task.onMiss) err(ctx.file, nid, `${where}.onMiss`, `onMiss 空字符串应为 null`);
    } else if (isPlainObject(task.onMiss) && typeof task.onMiss.crisisChain === "string") {
      warn(ctx.file, nid, `${where}.onMiss`, `{crisisChain} 为旧写法，规范值为事件 id 字符串或 null`);
    } else {
      err(ctx.file, nid, `${where}.onMiss`, `onMiss 必须是事件 id 字符串或 null`);
    }
  }

  if (task.progressFrom !== undefined) {
    if (!Array.isArray(task.progressFrom) || task.progressFrom.some((t) => typeof t !== "string" || !t)) {
      err(ctx.file, nid, `${where}.progressFrom`, `必须是字符串数组（actionId 标签）`);
    } else {
      for (const tag of task.progressFrom) {
        if (!ctx.progressTags.has(tag)) {
          warn(ctx.file, nid, `${where}.progressFrom`, `进度标签 "${tag}" 未被任何已加载的选项/夜选使用过（可能内容尚未写）`);
        }
      }
    }
  }
  if (task.deadline !== undefined && isPlainObject(task.deadline)) {
    if (!Number.isInteger(task.deadline.week) || task.deadline.week < 1) {
      err(ctx.file, nid, `${where}.deadline.week`, `必须是 >=1 的整数`);
    }
    if (dayToNum(task.deadline.day) === null) {
      err(ctx.file, nid, `${where}.deadline.day`, `day 必须是 1-7 整数或缩写 mon..sun`);
    }
  }
}

// ---------- 文件识别与装载 ----------
function detectKind(obj) {
  if (isPlainObject(obj) && isPlainObject(obj.nodes)) return "story";
  if (isPlainObject(obj) && Array.isArray(obj.cards)) return "cards";
  if (isPlainObject(obj) && Array.isArray(obj.tasks)) return "storyTasks";
  return null;
}

function loadJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { fatal: `无法读取文件: ${e.message}` };
  }
  try {
    return { data: JSON.parse(raw.replace(/^\uFEFF/, "")) };
  } catch (e) {
    return { fatal: `JSON 解析失败: ${e.message}` };
  }
}

function loadNpcIds(dir) {
  const p = path.join(dir, "npcs.json");
  if (!fs.existsSync(p)) return null;
  const r = loadJson(p);
  if (r.fatal || !isPlainObject(r.data)) return null;
  return new Set(Object.keys(r.data).filter((k) => isPlainObject(r.data[k])));
}

function loadParams(dir) {
  const p = path.join(dir, "params.json");
  if (!fs.existsSync(p)) return null;
  const r = loadJson(p);
  return r.fatal ? null : r.data;
}

// ---------- 主流程 ----------
function main() {
  try {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
      printUsage();
      return;
    }
    if (args.includes("--schema-only")) {
      runSelfTest();
      return;
    }
    const files = args.filter((a) => !a.startsWith("--"));
    if (files.length === 0) {
      printUsage();
      process.exitCode = 1;
      return;
    }
    validateFiles(files);
    printReport();
  } catch (e) {
    // 兜底：校验器自身绝不允许崩溃
    console.error(`[致命] 校验器内部异常（已优雅终止而非崩溃）：${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  }
}

function validateFiles(files) {
  const loaded = [];
  for (const file of files) {
    const rp = relPath(file);
    const r = loadJson(file);
    if (r.fatal) {
      err(rp, "", "", r.fatal);
      continue;
    }
    const kind = detectKind(r.data);
    if (!kind) {
      err(rp, "", "", `无法识别的文件结构：顶层应含 "nodes"(剧情) / "cards"(预知卡) / "tasks"(任务牌) 之一`);
      continue;
    }
    loaded.push({ file: rp, kind, data: r.data });
  }
  if (!loaded.length) return;

  // 跨文件符号表：节点 id 汇总 + 去重
  const nodeIds = new Set();
  for (const l of loaded.filter((x) => x.kind === "story")) {
    for (const key of Object.keys(l.data.nodes)) {
      if (nodeIds.has(key)) err(l.file, key, "nodes 键", `节点 id 跨文件重复: "${key}"`);
      nodeIds.add(key);
    }
  }
  const firstDir = path.dirname(path.resolve(files[0]));
  const ctx = {
    file: "",
    nodeId: "",
    depth: 0,
    nodeIds,
    npcIds: loadNpcIds(firstDir),
    cardIds: new Set(),
    referencedFlags: new Set(),
    definedFlags: new Set(),
    progressTags: new Set(),
    seenCardIds: new Set(),
    seenTaskIds: new Set(),
    params: loadParams(firstDir),
  };

  for (const l of loaded.filter((x) => x.kind === "story")) {
    ctx.file = l.file;
    for (const [key, node] of Object.entries(l.data.nodes)) {
      ctx.nodeId = key;
      ctx.depth = 0;
      validateNode(node, key, ctx);
    }
    // 分周配置 vs params.json 一致性（数值以 params 为准）
    if (l.data.weeks && isPlainObject(ctx.params) && isPlainObject(ctx.params.weeks)) {
      const full = ctx.params.weeks.full || {};
      const tut = ctx.params.weeks.tutorial || {};
      for (const [wk, cfg] of Object.entries(l.data.weeks)) {
        if (!isPlainObject(cfg)) continue;
        const expectAp = cfg.mainCard ? full.apPerDay : tut.apPerDay;
        if (typeof expectAp === "number" && cfg.apPerDay !== expectAp) {
          warn(l.file, `weeks.${wk}`, "apPerDay", `剧情侧 apPerDay=${cfg.apPerDay} 与 params.json 期望(${expectAp})不一致，以 params.json 为准`);
        }
      }
    }
  }

  for (const l of loaded.filter((x) => x.kind === "cards")) {
    ctx.file = l.file;
    if (!nodeIds.size) {
      warn(l.file, "", "", `本次未加载剧情文件，卡的 goto 目标存在性无法校验`);
    }
    (l.data.cards || []).forEach((c, i) => {
      ctx.nodeId = c && c.id ? c.id : `card#${i}`;
      validateCard(c, i, ctx);
    });
  }

  for (const l of loaded.filter((x) => x.kind === "storyTasks")) {
    ctx.file = l.file;
    (l.data.tasks || []).forEach((t, i) => {
      ctx.nodeId = t && t.id ? t.id : `task#${i}`;
      validateTask(t, i, ctx);
    });
  }

  // 条件中引用的 flag 是否有出处（警告级）
  for (const l of loaded.filter((x) => x.kind === "story")) {
    ctx.file = l.file;
    for (const [key, node] of Object.entries(l.data.nodes)) {
      ctx.nodeId = key;
      if (!isPlainObject(node)) continue;
      const choices = Array.isArray(node.choices) ? node.choices : [];
      choices.forEach((c, i) => {
        if (!isPlainObject(c) || c.conditions === undefined) return;
        const refs = [];
        (function walk(cond, d) {
          if (d > MAX_DEPTH || !isPlainObject(cond)) return;
          const ck = CONTAINER_KEYS.find((k) => k in cond);
          if (ck) { (Array.isArray(cond[ck]) ? cond[ck] : []).forEach((e) => walk(e, d + 1)); return; }
          if (typeof cond.flag === "string") refs.push(cond.flag);
        })(c.conditions, 0);
        for (const f of refs) {
          if (!ctx.definedFlags.has(f)) {
            warn(l.file, key, `choices[${i}].conditions`, `条件引用的 flag "${f}" 未被任何选项设置过（可能由引擎设置，请确认）`);
          }
        }
      });
    }
  }
}

function printReport() {
  const errors = report.filter((r) => r.level === "error");
  const warnings = report.filter((r) => r.level === "warn");
  const fmt = (r) =>
    `[${r.level === "error" ? "错误" : "警告"}] ${r.file}${r.nodeId ? ` › ${r.nodeId}` : ""}${r.where ? ` › ${r.where}` : ""}\n         ${r.msg}`;
  for (const r of errors) console.log(fmt(r));
  for (const r of warnings) console.log(fmt(r));
  console.log("");
  console.log(`—— 校验完成 ————`);
  console.log(`${errors.length} errors, ${warnings.length} warnings`);
  process.exitCode = errors.length > 0 ? 1 : 0;
}

function printUsage() {
  console.log(
    `用法:
  node validate.js <storyJson路径> [更多json...]
      支持剧情(nodes)/卡池(cards)/任务(tasks)三类 JSON，可混合传入做交叉校验。
      自动读取同目录 npcs.json(NPC 名册) 与 params.json(参数表) 辅助校验。
  node validate.js --schema-only    内置样例自检（不读外部文件）
  退出码: 无错误=0, 有错误=1`
  );
}

// ---------- --schema-only 内置自检 ----------
function runSelfTest() {
  const cases = [];
  function check(name, expectErrRegex, fn) {
    clearReport();
    let threw = null;
    try {
      fn();
    } catch (e) {
      threw = e;
    }
    if (threw) {
      cases.push({ name, ok: false, detail: `自检用例抛异常: ${threw.message}` });
      return;
    }
    if (expectErrRegex === null) {
      cases.push({
        name, ok: report.length === 0,
        detail: report.length ? `预期零报告，实得: ${JSON.stringify(report.map((r) => r.msg))}` : "",
      });
    } else {
      cases.push({
        name,
        ok: report.some((r) => expectErrRegex.test(r.msg)),
        detail: report.length ? `未匹配到预期报告；实得: ${JSON.stringify(report.map((r) => `[${r.level}] ${r.msg}`))}` : "未产生任何报告",
      });
    }
  }

  const mkCtx = () => ({
    file: "selftest",
    nodeId: "n_test",
    depth: 0,
    nodeIds: new Set(["n_ok"]),
    npcIds: new Set(["wang"]),
    cardIds: new Set(),
    referencedFlags: new Set(),
    definedFlags: new Set(["f_set"]),
    progressTags: new Set(["work_frame"]),
    seenCardIds: new Set(),
    seenTaskIds: new Set(),
    params: null,
  });

  check("合法组合条件 → 零报告", null, () => {
    const ctx = mkCtx();
    validateCondition(
      { all: [{ res: "stamina", op: ">=", value: 1 }, { not: [{ flag: "f_set" }] }, { any: [{ week: 2 }, { day: "mon" }] }] },
      ctx, "c0"
    );
  });
  check("非法 res 来源被捕获", /res 来源只允许/, () => {
    validateCondition({ res: "luck", op: ">=", value: 1 }, mkCtx(), "c1");
  });
  check("多来源键叶子被捕获", /只能有一个来源键/, () => {
    validateCondition({ res: "stamina", flag: "f_set", op: ">=", value: 1 }, mkCtx(), "c2");
  });
  check("容器值非数组被捕获", /必须是数组/, () => {
    validateCondition({ all: { res: "stamina", op: ">=", value: 1 } }, mkCtx(), "c3");
  });
  check("非法 op 被捕获", /op 只允许/, () => {
    validateCondition({ npc: "wang", op: "!=", value: 1 }, mkCtx(), "c4");
  });
  check("未知 NPC 被捕获", /未知的 NPC/, () => {
    validateCondition({ npc: "ghost", op: ">=", value: 1 }, mkCtx(), "c5");
  });
  check("choice 死 goto 被捕获", /goto 目标节点不存在/, () => {
    const ctx = mkCtx();
    validateChoice({ text: "测试选项", goto: "n_ghost" }, ctx, "choices[0]");
  });
  check("节点缺 text/date 被捕获", /缺少非空 text|展示字段缺失/, () => {
    const ctx = mkCtx();
    validateNode({ id: "n_b", type: "story", goto: "n_ok" }, "n_b", ctx);
  });
  check("effects 未知键被捕获", /未知的效果键/, () => {
    validateEffects({ mana: 5 }, mkCtx(), "e0");
  });
  check("taskId/taskProgress 不成对给警告", /应成对/, () => {
    validateEffects({ taskId: "task_x" }, mkCtx(), "e1");
  });
  check("重卡死传送门被捕获", /目标节点不存在/, () => {
    const ctx = mkCtx();
    validateCard(
      { id: "card_t", name: "t", ref: "r", consumable: true, window: { from: { week: 1, day: 1 }, to: { week: 2, day: 1 } },
        onPlay: { goto: "n_ghost", deviationBase: 1 }, ifSealed: { witness: true, confidence: -1, goto: null } },
      0, ctx
    );
  });
  check("ifSealed 死跳转被捕获", /封存结局.*不存在|ifSealed\.goto/, () => {
    const ctx = mkCtx();
    validateCard(
      { id: "card_t2", name: "t", ref: "r", consumable: true, window: { from: { week: 1, day: 1 }, to: { week: 1, day: 7 } },
        effects: { deviation: 1 }, ifSealed: { witness: true, confidence: -1, goto: "n_ghost" } },
      0, ctx
    );
  });
  check("双形态缺失被捕获", /双形态缺失/, () => {
    const ctx = mkCtx();
    validateCard(
      { id: "card_t3", name: "t", ref: "r", consumable: true, window: { from: { week: 1, day: 1 }, to: { week: 1, day: 7 } },
        ifSealed: { witness: true, confidence: -1, goto: null } },
      0, ctx
    );
  });

  clearReport();
  let failed = 0;
  for (const c of cases) {
    if (c.ok) console.log(`[PASS] ${c.name}`);
    else {
      failed++;
      console.log(`[FAIL] ${c.name} —— ${c.detail}`);
    }
  }
  console.log("");
  console.log(`—— schema 自检：${cases.length - failed}/${cases.length} 通过 ——`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
