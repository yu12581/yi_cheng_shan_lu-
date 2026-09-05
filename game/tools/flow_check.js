/**
 * flow_check.js - 剧情链路动态遍历器（开发诊断工具，零依赖）
 *
 * 用真实引擎（StoryEngine+LoopController）按"作者链路"走完 story_act1：
 *   - 每个节点取第一个条件通过的选项（spine），其余选项做静态可达性检查
 *   - 记录：被相位白名单拦截的跳转 / 夜选·周结算时剩余AP浪费 / 每日行动位缺口
 *
 * 运行：node game/tools/flow_check.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

class LocalStorageStub {
    constructor() { this.map = {}; }
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.map, k) ? this.map[k] : null; }
    setItem(k, v) { this.map[k] = String(v); }
    removeItem(k) { delete this.map[k]; }
}

const files = [
    'core/AttributeManager.js', 'core/ConditionEvaluator.js', 'core/SaveManager.js',
    'core/LoopController.js', 'core/CardManager.js', 'core/ContentLoader.js', 'core/StoryEngine.js'
];
let src = files.map(f => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n;\n');
src += '; this.__exports = { AttributeManager, ConditionEvaluator, SaveManager, LoopController, CardManager, StoryEngine, ContentLoader };';

const sandbox = { window: {}, console, localStorage: new LocalStorageStub(), setTimeout, clearTimeout };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'core-bundle.js' });
const { AttributeManager, SaveManager, LoopController, CardManager, StoryEngine, ContentLoader } = sandbox.__exports;

// ---------- 组装系统 ----------
const am = new AttributeManager();
const sm = new SaveManager();
const se = new StoryEngine(am);
const lc = new LoopController(am);
const cm = new CardManager(am);
se.attachSystems({ loopController: lc, cardManager: cm });
lc.attach({ storyEngine: se, saveManager: sm, cardManager: cm });
cm.attach({ storyEngine: se });

const DATA = path.join(ROOT, 'data');
const reader = async (p) => JSON.parse(fs.readFileSync(path.join(DATA, p), 'utf8'));
const evalCond = sandbox.window.game.evalCondition;

// ---------- 遍历 ----------
const issues = [];      // {type, where, detail}
const dayActions = {};  // 'w{week}d{day}' -> 行动位计数（消耗AP的节点数）
let steps = 0;
const visited = new Set();

function issue(type, where, detail) {
    issues.push({ type, where, detail });
}

function stateDump() {
    return JSON.stringify({ week: lc.state.week, day: lc.state.day, phase: lc.state.phase, ap: lc.state.ap });
}

function checkChoiceStatic(nodeId, node, choice, idx) {
    // 条件不可过 → 跳过静态检查（正常隐藏/置灰）
    if (choice.condition && !evalCond(choice.condition, se.getSnapshot())) return;
    const target = choice.nextNode || choice.goto;
    if (!target) { issue('无去向', nodeId, `选项${idx}（${choice.text}）没有 nextNode/goto`); return; }
    const tnode = se.nodes[target];
    if (!tnode) { issue('死链', nodeId, `选项${idx} → ${target} 不存在`); return; }
    // AP 预检（DAY_ACTION 下默认耗1）
    if (lc.state.phase === 'DAY_ACTION') {
        const cost = choice.costAP !== undefined ? choice.costAP : 1;
        if (cost > lc.state.ap) {
            issue('AP不足选项', nodeId, `选项${idx}（${choice.text}）需${cost}AP/余${lc.state.ap}——玩家会看到置灰或收工兜底`);
        }
    }
    // 静态白名单检查：模拟"如果点这个选项"（从自由节点离开不受限）
    const fromDeclared = lc.resolvePhase(node, nodeId);
    if (!( !fromDeclared || node.freeNode)) {
        const declared = lc.resolvePhase(tnode, target);
        if (declared && !tnode.freeNode) {
            const allowed = [lc.state.phase, ...lc.allowedNextPhases()];
            if (!allowed.includes(declared)) {
                issue('相位拦截(静态)', nodeId, `选项${idx}（${choice.text}）→ ${target} [${declared}]，当前相位 ${lc.state.phase} 允许 [${allowed.join(',')}]`);
            }
        }
    }
}

(async () => {
    await new ContentLoader({ storyEngine: se, loopController: lc, cardManager: cm, attributeManager: am })
        .load(['story_act1.json', 'params.json', 'npcs.json', 'tasks_act1.json', 'cards_act1.json', 'night_events.json'], reader);

    console.log(`节点总数: ${Object.keys(se.nodes).length - 1}`); // 减去 __meta__ 类
    console.log('── 开始按作者链路遍历（每个节点取第一个条件通过的选项）──\n');

    let ok = se.goToNode('n_000_open');
    if (!ok) { console.error('入口节点进入失败'); process.exit(1); }

    while (steps < 500) {
        steps++;
        const node = se.currentNode;
        const id = se.currentNodeId;
        if (!node) break;

        // 周结算/夜选进入时的 AP 浪费检查
        if (node.phase === 'NIGHT_CHOICE' && lc.state.ap > 0) {
            issue('AP浪费', `${id}（周${lc.state.week}日${lc.state.day}）`, `进入夜选时剩余 ${lc.state.ap}AP 未消耗——玩家会疑惑"点数去哪了"`);
        }
        if (node.phase === 'WEEK_SETTLE' && lc.state.ap > 0) {
            issue('AP浪费', id, `进入周结算时剩余 ${lc.state.ap}AP`);
        }
        // 行动位计数：消耗AP的选项节点
        if (node.phase === 'DAY_ACTION' && node.choices && node.choices.length) {
            const key = `w${lc.state.week}d${lc.state.day}`;
            dayActions[key] = (dayActions[key] || 0) + 1;
        }

        visited.add(id);

        // 无选项节点：autoNext 续接
        if (!node.choices || node.choices.length === 0) {
            const next = node.autoNext || node.nextNode;
            if (!next) { issue('终点', id, '无选项无去向（结局？）'); break; }
            const tnode = se.nodes[next];
            if (!tnode) { issue('死链', id, `autoNext → ${next} 不存在`); break; }
            const before = lc.state.phase;
            if (!se.goToNode(next)) {
                issue('相位拦截(autoNext)', id, `→ ${next} [${tnode.phase || 'FREE'}] 被拦，当前状态 ${stateDump()}`);
                break;
            }
            continue;
        }

        // 取第一个条件通过且AP够的选项
        let picked = -1;
        for (let i = 0; i < node.choices.length; i++) {
            const c = node.choices[i];
            if (c.condition && !evalCond(c.condition, se.getSnapshot())) continue;
            const cost = lc.state.phase === 'DAY_ACTION' ? (c.costAP !== undefined ? c.costAP : 1) : 0;
            if (cost > lc.state.ap) continue;
            picked = i; break;
        }

        // 其余选项静态检查
        node.choices.forEach((c, i) => { if (i !== picked) checkChoiceStatic(id, node, c, i); });

        if (picked < 0) {
            issue('无可用选项', id, `相位${lc.state.phase} AP${lc.state.ap}——所有选项被条件/AP拦死（游戏内会出现收工兜底或卡死）`);
            break;
        }

        const choice = node.choices[picked];
        const target = choice.nextNode || choice.goto;
        se.makeChoice(picked);
        if (!target || !se.goToNode(target)) {
            issue('相位拦截(实走)', id, `选项${picked}（${choice.text}）→ ${target} 跳转失败，当前状态 ${stateDump()}`);
            break;
        }
    }

    // 汇总每日行动位 vs apPerDay
    console.log('\n── 每日行动位（消耗AP的节点数）vs 每日AP ──');
    for (const [key, count] of Object.entries(dayActions).sort()) {
        const w = Number(key[1]), d = Number(key[3]);
        const ap = lc.getWeekConfig(w).apPerDay;
        const flag = count < ap ? ' ← 缺口：内容只提供' + count + '个行动位，AP给' + ap + '点' : '';
        console.log(`  ${key}: ${count}行动位 / ${ap}AP${flag}`);
    }

    console.log(`\n── 问题清单（${issues.length}项，遍历${steps}步，访问${visited.size}节点）──`);
    for (const it of issues) console.log(`[${it.type}] ${it.where}\n    ${it.detail}`);
    if (!issues.length) console.log('  （无）');
})();
