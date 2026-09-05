/**
 * 无头回归测试（Node 原生，零依赖）
 * 覆盖完成定义：骨架周从 WEEK_START 跑到 WEEK_SETTLE → 自动存档 →
 * 读档后 history 无重复。
 *
 * 运行：node game/test/harness.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');

// ---------- 环境桩 ----------
class LocalStorageStub {
    constructor() { this.map = {}; }
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.map, k) ? this.map[k] : null; }
    setItem(k, v) { this.map[k] = String(v); }
    removeItem(k) { delete this.map[k]; }
}

// ---------- 加载 core 模块（不含 DOM 依赖的 DebugPanel/UIManager） ----------
const files = [
    'core/AttributeManager.js',
    'core/ConditionEvaluator.js',
    'core/SaveManager.js',
    'core/LoopController.js',
    'core/CardManager.js',
    'core/ContentLoader.js',
    'core/StoryEngine.js',
    'core/SlideRuleGame.js'
];
let src = files.map(f => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n;\n');
src += '; this.__exports = { AttributeManager, ConditionEvaluator, SaveManager, LoopController, CardManager, StoryEngine, ContentLoader, SlideRuleGame };';

const storage = new LocalStorageStub();
const sandbox = {
    window: {},
    console,
    localStorage: storage,
    setTimeout, clearTimeout
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'core-bundle.js' });
const { AttributeManager, ConditionEvaluator, SaveManager, LoopController, CardManager, StoryEngine, ContentLoader, SlideRuleGame } = sandbox.__exports;

// ---------- 测试工具 ----------
let passed = 0, failed = 0;
async function t(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✔ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ✘ ${name}\n    ${e.message}`);
    }
}
function freshSystem() {
    const am = new AttributeManager();
    const sm = new SaveManager();
    const se = new StoryEngine(am);
    const lc = new LoopController(am);
    const cm = new CardManager(am);
    se.attachSystems({ loopController: lc, cardManager: cm });
    lc.attach({ storyEngine: se, saveManager: sm, cardManager: cm });
    cm.attach({ storyEngine: se });
    return { am, sm, se, lc, cm };
}
function step(sys, idx) {
    const node = sys.se.currentNode;
    assert(node && node.choices && node.choices[idx], `step(${idx}) 于 ${sys.se.currentNodeId}`);
    const choice = node.choices[idx];
    sys.se.makeChoice(idx);
    assert(sys.se.goToNode(choice.nextNode), `goToNode(${choice.nextNode}) 应成功`);
    return choice;
}
/** 读档重复bug的判定口径：history 不得出现相邻重复（合法剧情重访允许非相邻重现） */
function noDupHistory(arr) {
    for (let i = 1; i < arr.length; i++) if (arr[i] === arr[i - 1]) return false;
    return true;
}
/** 跨 vm realm 安全的数组/对象深度相等（沙箱内 Array 原型与宿主不同） */
function jseq(a, b, msg) {
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);
}

// ---------- 数据 ----------
const skeleton = JSON.parse(fs.readFileSync(path.join(__dirname, 'skeleton_week.json'), 'utf8'));

// 全部测试在异步块内运行（内容加载为 IO）
const __run = (async () => {

// ================= 1. ConditionEvaluator 单元测试 =================
console.log('\n[1] ConditionEvaluator');
await t('res 比较符字符串 / 数字相等', () => {
    const snap = { attributes: { stamina: 15, integration: 50, deviation: 3 }, npcRelations: {}, flags: {}, week: 2, day: 3 };
    assert.strictEqual(ConditionEvaluator.eval({ res: { stamina: '<=20' } }, snap), true);
    assert.strictEqual(ConditionEvaluator.eval({ res: { stamina: '>20' } }, snap), false);
    assert.strictEqual(ConditionEvaluator.eval({ res: { deviation: 3 } }, snap), true);
});
await t('npc/flag/week/day/card 叶子', () => {
    const snap = { attributes: {}, npcRelations: { chen: 35 }, flags: { path_factory: true },
        week: 2, day: 5, cards: { hand: ['card_a', 'card_b'] } };
    assert.strictEqual(ConditionEvaluator.eval({ npc: { chen: '>=30' } }, snap), true);
    assert.strictEqual(ConditionEvaluator.eval({ flag: 'path_factory' }, snap), true);
    assert.strictEqual(ConditionEvaluator.eval({ flag: { name: 'path_factory', value: false } }, snap), false);
    assert.strictEqual(ConditionEvaluator.eval({ week: '>=2' }, snap), true);
    assert.strictEqual(ConditionEvaluator.eval({ day: '<=5' }, snap), true);
    assert.strictEqual(ConditionEvaluator.eval({ card: 'card_b' }, snap), true);
    assert.strictEqual(ConditionEvaluator.eval({ card: ['x', 'card_a'] }, snap), true);
    assert.strictEqual(ConditionEvaluator.eval({ card: 'card_z' }, snap), false);
});
await t('容器 all/any/not + 隐式all + 未知键fail-safe', () => {
    const snap = { attributes: { stamina: 10 }, npcRelations: {}, flags: {}, week: 3, day: 1, cards: { hand: [] } };
    assert.strictEqual(ConditionEvaluator.eval({ all: [{ res: { stamina: '<=20' } }, { week: 3 }] }, snap), true);
    assert.strictEqual(ConditionEvaluator.eval({ any: [{ res: { stamina: '>20' } }, { week: '>=2' }] }, snap), true);
    assert.strictEqual(ConditionEvaluator.eval({ not: { res: { stamina: '>20' } } }, snap), true);
    assert.strictEqual(ConditionEvaluator.eval([{ res: { stamina: '<=20' } }, { week: '>=3' }], snap), true);
    assert.strictEqual(ConditionEvaluator.eval({ unknownKey: 1 }, snap), false);
    assert.strictEqual(ConditionEvaluator.eval(null, snap), true);
});
await t('classify：资源门槛 vs 叙事门槛', () => {
    assert.strictEqual(ConditionEvaluator.classify({ res: { stamina: '<=20' } }), 'resource');
    assert.strictEqual(ConditionEvaluator.classify({ card: 'c1' }), 'resource');
    assert.strictEqual(ConditionEvaluator.classify({ flag: 'f' }), 'narrative');
    assert.strictEqual(ConditionEvaluator.classify({ npc: { chen: '>=30' } }), 'narrative');
    assert.strictEqual(ConditionEvaluator.classify({ all: [{ flag: 'f' }, { res: { stamina: '<=5' } }] }), 'resource');
});
await t('describeBlockReason 输出原因', () => {
    const snap = { attributes: { stamina: 80 }, cards: { hand: [] } };
    const reason = ConditionEvaluator.describeBlockReason({ res: { stamina: '<=20' } }, snap);
    assert.ok(reason.includes('体力'), reason);
});

// ================= 2. 主链路：WEEK_START → WEEK_SETTLE → 自动存档 =================
console.log('\n[2] 骨架周主链路');
const sys = freshSystem();
assert.strictEqual(sys.se.setStoryData(skeleton), true);

// 初始进入 W1 WEEK_START
sys.se.currentNodeId = null;
assert.strictEqual(sys.se.goToNode('w1_start'), true);

await t('进入 WEEK_START 相位并发放任务牌', () => {
    assert.strictEqual(sys.lc.state.phase, 'WEEK_START');
    assert.strictEqual(sys.lc.state.week, 1);
    const tasks = sys.lc.getActiveTasks();
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].id, 't_w1_main');
    assert.strictEqual(tasks[0].status, 'active');
});

step(sys, 0); // → w1_d1_morning
step(sys, 0); // → w1_d1_work（开工，DAY_START→DAY_ACTION）
step(sys, 0); // 干活：progress+1 / AP 1→0 / 落点 w1_d1_work2

await t('教学档 AP=1：干活后 AP 清零', () => {
    assert.strictEqual(sys.lc.state.phase, 'DAY_ACTION');
    assert.strictEqual(sys.lc.state.ap, 0);
    assert.strictEqual(sys.lc.state.taskProgress.t_w1_main, 1);
});

await t('重卡时间窗校验：W1 打不出 from:2 的卡', () => {
    sys.cm.addCard('card_test_heavy');
    const r = sys.cm.play('card_test_heavy');
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes('时间窗'));
});

await t('相位白名单：DAY_ACTION 不允许直跳下周节点', () => {
    assert.strictEqual(sys.se.goToNode('w2_start'), false);
});

step(sys, 0); // 收工入睡（dayAdvance）→ w1_d2_morning

await t('无夜选日 dayAdvance：推进到次日晨并重置 AP', () => {
    assert.strictEqual(sys.lc.state.day, 2);
    assert.strictEqual(sys.lc.state.phase, 'DAY_START');
    assert.strictEqual(sys.lc.state.ap, 1);
});

step(sys, 0); // 开工 → w1_d2_work
step(sys, 0); // 直接结算 → w1_settle ← 触发结算+自动存档#1

await t('WEEK_SETTLE 结算：任务达成、无危机flag、自动槽已写入', () => {
    assert.strictEqual(sys.lc.state.phase, 'WEEK_SETTLE');
    assert.strictEqual(sys.lc.state.day, 2);
    const task = sys.lc.state.tasks.t_w1_main;
    assert.strictEqual(task.status, 'settled');
    assert.strictEqual(task.result, 'success');
    assert.strictEqual(sys.am.getAttribute('integration'), 57, '50 基础 +2 干活 +5 结算奖励');
    assert.strictEqual(sys.am.getFlag('crisis_w1_t_w1_main'), false);
    const store = JSON.parse(storage.getItem('yichengshanlugame_save'));
    assert.strictEqual(store.version, 1, '顶层 version 字段');
    assert.ok(store.slots.auto, '自动槽存在');
    assert.strictEqual(store.slots.auto.loop.week, 1);
});

step(sys, 0); // w2_start（全速档）

await t('第2周 DAY_START：AP 重置为 2（全速档）', () => {
    step(sys, 0); // w2_d1_morning
    assert.strictEqual(sys.lc.state.week, 2);
    assert.strictEqual(sys.lc.state.day, 1);
    assert.strictEqual(sys.lc.state.ap, 2);
    assert.strictEqual(sys.lc.getWeekConfig(2).nightChoice, true);
    assert.strictEqual(sys.lc.getWeekConfig(2).crisisChain, true);
});

await t('相位白名单：DAY_START 不允许跳 WEEK_SETTLE', () => {
    assert.strictEqual(sys.se.goToNode('w2_settle'), false);
});

await t('自由节点 freeNode 任意相位放行', () => {
    assert.strictEqual(sys.se.goToNode('card_scene_test'), true);
    // 新语义：从自由场景离开不受旧相位审判（作者链路可信），FREE → DAY_START 放行
    assert.strictEqual(sys.se.goToNode('w2_d1_morning'), true, '自由节点出口放行');
    // 回到 work 流：从 DAY_START 声明节点跳 DAY_ACTION 同样放行
    sys.se.currentNodeId = null;
    assert.strictEqual(sys.se.goToNode('w2_d1_work', false), true, '同相位迁移放行');
    sys.se.currentNodeId = null;
    assert.strictEqual(sys.se.goToNode('w2_d1_work2', false), true);
});

await t('重卡打出：传送门进专属抉择节点 + consumable 离手', () => {
    const r = sys.cm.play('card_test_heavy');
    assert.strictEqual(r.ok, true, r.reason || '');
    assert.strictEqual(r.jumped, true);
    assert.strictEqual(sys.se.currentNodeId, 'card_scene_test');
    jseq(sys.cm.state.hand, [], '手牌清空');
    jseq(sys.cm.state.used, ['card_test_heavy'], 'consumable 入 used');
    // 干预深度计价在分支选项
    const devBefore = sys.am.getAttribute('deviation');
    sys.se.makeChoice(0); // 深度干预 deviation+10
    assert.strictEqual(sys.am.getAttribute('deviation'), devBefore + 10);
    sys.se.currentNodeId = null;
    assert.strictEqual(sys.se.goToNode('w2_d1_work2', false), true);
});

await t('轻卡即时结算 + 封存获见证标记', () => {
    sys.cm.addCard('card_test_light');
    const intBefore = sys.am.getAttribute('integration');
    const r = sys.cm.play('card_test_light'); // 轻卡：effects 即时应用
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.jumped, false);
    assert.strictEqual(sys.am.getAttribute('integration'), intBefore + 3);
    jseq(sys.cm.state.used, ['card_test_heavy', 'card_test_light']);
    sys.cm.addCard('card_test_light'); // 再入手一张用于封存
    const s = sys.cm.seal('card_test_light');
    assert.strictEqual(s.ok, true);
    assert.strictEqual(sys.cm.state.witness, 1);
});

step(sys, 0); // 收工入夜 w2_d1_night

await t('夜选-休息：推进次日晨，晨起回体，AP 重置', () => {
    const staBefore = sys.am.getAttribute('stamina');
    const c = step(sys, 0); // rest
    assert.strictEqual(c.night, 'rest');
    assert.strictEqual(sys.lc.state.day, 2);
    assert.strictEqual(sys.lc.state.phase, 'DAY_START');
    assert.strictEqual(sys.am.getAttribute('stamina'), Math.min(100, staBefore + 3 + 1), '夜休+3 与晨起+1');
    assert.strictEqual(sys.lc.state.ap, 2);
});

step(sys, 0); // 开工 → w2_d2_work
step(sys, 0); // 冲刺复核（主线进度+1）→ w2_d2_night

await t('夜选-熬夜加班：体力-2 且本周任务进度+1', () => {
    const staBefore = sys.am.getAttribute('stamina');
    const c = step(sys, 1); // overtime
    assert.strictEqual(c.night, 'overtime');
    assert.strictEqual(sys.lc.state.taskProgress.t_w2_main, 1);
    assert.strictEqual(sys.am.getAttribute('stamina'), staBefore - 2);
    assert.strictEqual(sys.lc.state.phase, 'WEEK_SETTLE');
});

await t('W2 结算：主线捷报 + 自动槽覆盖写入 version=1', () => {
    const task = sys.lc.state.tasks.t_w2_main;
    assert.strictEqual(task.result, 'success');
    assert.strictEqual(sys.am.getNPCRelation('chen'), 5, '奖励好感+5');
    const store = JSON.parse(storage.getItem('yichengshanlugame_save'));
    assert.strictEqual(store.slots.auto.loop.week, 2);
    assert.ok(store.slots.auto.cards.witness === 1, '见证标记入存档');
});

// ================= 3. 读档：history 无重复 =================
console.log('\n[3] 读档回归');
await t('loadState 后 history 与存档完全一致且无重复', () => {
    const saved = JSON.parse(JSON.stringify(sys.sm.loadGame('auto')));
    // 存档内先验证一遍
    assert.ok(noDupHistory(saved.history), '存档 history 本身无重复');

    const sys2 = freshSystem();
    sys2.se.setStoryData(skeleton);
    sys2.se.loadState(saved);

    jseq(sys2.se.history, saved.history, '恢复后不压栈、不丢栈');
    assert.strictEqual(sys2.se.currentNodeId, saved.currentNodeId);
    assert.strictEqual(sys2.lc.state.phase, 'WEEK_SETTLE');
    assert.strictEqual(sys2.lc.state.ap, saved.loop.ap, 'AP 随快照恢复（不被 beginDay 重置）');
    assert.strictEqual(sys2.cm.state.witness, 1);
    // 相位白名单在读档后依然生效
    assert.strictEqual(sys2.se.goToNode('w2_d1_morning'), false);
});

await t('周目快进器：fastForward(1) 直达 W1 WEEK_START 并重新发牌', () => {
    const sys3 = freshSystem();
    sys3.se.setStoryData(skeleton);
    sys3.se.currentNodeId = null;
    sys3.se.goToNode('w2_start');
    assert.strictEqual(sys3.lc.fastForward(1), true);
    assert.strictEqual(sys3.lc.state.week, 1);
    assert.strictEqual(sys3.lc.state.phase, 'WEEK_START');
    assert.strictEqual(sys3.se.currentNodeId, 'w1_start');
    assert.strictEqual(sys3.lc.getActiveTasks().length, 1, '任务重新发放');
});

await t('危机链：全速档逾期 → crisis flag + onMiss 生效；教学档免罚', () => {
    const sys4 = freshSystem();
    sys4.se.setStoryData(skeleton);
    // 全速档（W2 默认 crisisChain=true）
    sys4.lc.loadState({ week: 2, day: 1, phase: 'WEEK_SETTLE', ap: 0, taskProgress: {}, tasks: {}, settledWeek: 0 });
    sys4.lc.issueTasks(2);
    const devBefore = sys4.am.getAttribute('deviation');
    const events = sys4.lc.settleWeek();
    assert.ok(events.some(e => e.type === 'crisis-triggered'));
    assert.strictEqual(sys4.am.getFlag('crisis_w2_t_w2_main'), true);
    assert.strictEqual(sys4.am.getAttribute('deviation'), devBefore + 12);
    // 教学档（W1 crisisChain=false）
    const sys5 = freshSystem();
    sys5.se.setStoryData(skeleton);
    sys5.lc.loadState({ week: 1, day: 1, phase: 'WEEK_SETTLE', ap: 0, taskProgress: {}, tasks: {}, settledWeek: 0 });
    sys5.lc.issueTasks(1);
    const events5 = sys5.lc.settleWeek();
    assert.ok(events5.some(e => e.type === 'miss-grace'));
    assert.ok(!events5.some(e => e.type === 'crisis-triggered'));
});

await t('AP不足否决选项：效果不生效、AP不变', () => {
    const s6 = freshSystem();
    s6.se.setStoryData(skeleton);
    s6.se.currentNodeId = null;
    s6.se.goToNode('w1_start');
    step(s6, 0); step(s6, 0); // → w1_d1_work
    const intBefore = s6.am.getAttribute('integration');
    const r1 = s6.se.makeChoice(0); // 干活：AP 1→0
    assert.ok(r1, '第一次干活应成功');
    assert.ok(r1.loopEvents.some(e => e.type === 'first-work-today'), '首次干活触发 first-work-today');
    s6.se.goToNode('w1_d1_work2');
    // 静默回到同相位节点（AP 已耗尽）
    s6.se.currentNodeId = null;
    s6.se.goToNode('w1_d1_work', false);
    const r2 = s6.se.makeChoice(0); // 再干活：应被否决
    assert.strictEqual(r2, null, 'AP不足时 makeChoice 返回 null');
    assert.strictEqual(s6.lc.state.ap, 0);
    assert.strictEqual(s6.am.getAttribute('integration'), intBefore + 2, '被否决选项不生效');
});

await t('first-work-today 每天仅一次', () => {
    const s7 = freshSystem();
    s7.lc.loadState({ week: 2, day: 3, phase: 'DAY_ACTION', ap: 9, taskProgress: {}, tasks: {}, settledWeek: 1 });
    const a = s7.lc.onChoiceMade({ work: true });
    const b = s7.lc.onChoiceMade({ work: true });
    assert.ok(a.some(e => e.type === 'first-work-today'));
    assert.ok(!b.some(e => e.type === 'first-work-today'), '同一天第二次干活不再触发');
    s7.lc.state.day = 4;
    const c = s7.lc.onChoiceMade({ work: true });
    assert.ok(c.some(e => e.type === 'first-work-today'), '次日重新触发');
});

await t('nightFromDay 分天夜选门控 + 每周天数覆盖', () => {
    const s8 = freshSystem();
    s8.se.setStoryData(skeleton);
    // 用 W2（nightChoice 默认 true）验证分天门控与周天数覆盖
    s8.lc.mergeConfig({ weeks: { 2: { daysPerWeek: 6, nightFromDay: 3 } } });
    s8.lc.loadState({ week: 2, day: 1, phase: 'DAY_ACTION', ap: 1, taskProgress: {}, tasks: {}, settledWeek: 1 });
    jseq(s8.lc.allowedNextPhases(), ['WEEK_SETTLE'], 'D1-D2 无夜选：白天直落周结算');
    assert.strictEqual(s8.lc.getWeekConfig(2).daysPerWeek, 6, '每周天数可覆盖');
    const nightNode = s8.se.nodes['w2_d1_night'];
    assert.strictEqual(s8.lc.canEnterNode('w2_d1_night', nightNode), false, 'D1 夜选节点不可进入');
    s8.lc.state.day = 3;
    jseq(s8.lc.allowedNextPhases(), ['NIGHT_CHOICE'], 'D3 起解锁夜选');
    assert.strictEqual(s8.lc.canEnterNode('w2_d1_night', nightNode), true);
});

// ================= 4. SaveManager 兼容与槽位 =================
console.log('\n[4] SaveManager');
await t('旧格式自动迁移包裹', () => {
    storage.setItem('yichengshanlugame_save', JSON.stringify({ 1: { currentNodeId: 'legacy' } }));
    const sm = new SaveManager();
    const store = sm.getStore();
    assert.ok(store.slots['1']);
    assert.strictEqual(sm.hasSave(1), true);
    assert.strictEqual(sm.hasSave('auto'), false);
});
await t('手动槽 1-3 合法、auto 合法、越界拒绝', () => {
    const sm = new SaveManager();
    assert.strictEqual(sm.saveGame(4, {}), false);
    assert.strictEqual(sm.saveGame(-1, {}), false);
    assert.strictEqual(sm.isValidSlot('auto'), true);
});

// ================= 5. 内容格式适配（真实 data/ 文件，只读） =================
console.log('\n[5] 内容适配层');
{
    const sysC = freshSystem();
    const loader = new ContentLoader({
        storyEngine: sysC.se, loopController: sysC.lc,
        cardManager: sysC.cm, attributeManager: sysC.am
    });
    const rd = async (p) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', path.basename(p)), 'utf8'));
    var gotContent = await loader.load([
        'data/story_act1.json', 'data/cards_act1.json',
        'data/tasks_act1.json', 'data/npcs.json', 'data/params.json'
    ], rd);

    await t('故事加载：FREE 剥离 / text→narrative / goto→autoNext', () => {
        assert.ok(gotContent.story, 'story 已加载');
        const open = sysC.se.nodes['n_000_open'];
        assert.ok(open && open.narrative && open.narrative.length > 50);
        assert.strictEqual(open.phase, undefined, 'FREE 已剥离');
        const withGoto = Object.values(sysC.se.nodes).find(n => n.autoNext);
        assert.ok(withGoto, '存在 goto→autoNext 归一化节点');
    });

    await t('分周配置：残周4天/fri起夜选；第二周7天全速；W3 预设兜底', () => {
        const c1 = sysC.lc.getWeekConfig(1);
        assert.strictEqual(c1.daysPerWeek, 4, '残周四天');
        assert.strictEqual(c1.nightFromDay, 2, 'fri=[thu,fri,sat,sun] 序号2');
        assert.strictEqual(c1.apPerDay, 1);
        assert.strictEqual(c1.crisisChain, false);
        assert.strictEqual(c1.deadlineEnabled, false, 'mainCard:false 映射');
        const c2 = sysC.lc.getWeekConfig(2);
        assert.strictEqual(c2.daysPerWeek, 7);
        assert.strictEqual(c2.nightFromDay, 1);
        assert.strictEqual(c2.crisisChain, true);
        const c3 = sysC.lc.getWeekConfig(3);
        assert.strictEqual(c3.apPerDay, 2, 'full 预设兜底');
        assert.strictEqual(c3.nightChoice, true);
    });

    await t('参数应用：体力上限10/晨起恢复/偏离阈值入 gameParams', () => {
        assert.strictEqual(sysC.am.attributes.stamina.max, 10);
        assert.strictEqual(sysC.am.attributes.stamina.value, 10, '初值夹到新上限');
        assert.strictEqual(sysC.lc.config.morningRecovery, 1);
        assert.strictEqual(sysC.lc.config.gameParams.deviation.thresholds.warning, 3);
        assert.strictEqual(sysC.lc.config.gameParams.slideRulePerfectBonus, 1);
    });

    await t('NPC 注册：动态并入+阶段元数据保留', () => {
        const niu = sysC.am.npcRelations.niu;
        assert.ok(niu, 'niu 已注册');
        assert.strictEqual(niu.name, '小牛');
        jseq(niu.stageThresholds, [4, 10, 18]);
        assert.strictEqual(niu.stages.length, 4);
        assert.ok(sysC.am.npcRelations.chen, '内置 NPC 保留');
    });

    await t('卡牌归一化与日名窗口：衬套虚惊 W3 mon-wed', () => {
        const card = sysC.cm.registry['card_chentao_xujing'];
        assert.ok(card, '卡已注册');
        assert.strictEqual(card.title, '衬套虚惊');
        assert.strictEqual(card.window.from, 3);
        assert.strictEqual(card.window.to, 3);
        assert.strictEqual(card.window.fromDayName, 'mon');
        sysC.cm.addCard('card_chentao_xujing');
        sysC.lc.loadState({ week: 1, day: 1, phase: 'DAY_ACTION', ap: 9, taskProgress: {}, tasks: {}, settledWeek: 0 });
        assert.strictEqual(sysC.cm.canPlay('card_chentao_xujing').ok, false, 'W1 打不出');
        sysC.lc.loadState({ week: 3, day: 1, phase: 'DAY_ACTION', ap: 9, taskProgress: {}, tasks: {}, settledWeek: 2 });
        assert.strictEqual(sysC.cm.canPlay('card_chentao_xujing').ok, true, 'W3D1(mon) 可打');
        sysC.lc.state.day = 4;
        assert.strictEqual(sysC.cm.canPlay('card_chentao_xujing').ok, false, 'W3D4(thu) 过窗');
    });

    await t('封存 onSeal：witnessFlag/confidence/史实文本入日志', () => {
        const confBefore = sysC.am.teamParams.confidence;
        const r = sysC.cm.seal('card_chentao_xujing');
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.witness, 1);
        assert.strictEqual(sysC.am.getFlag('f_witness_chentao'), true, '见证旗标');
        assert.strictEqual(sysC.am.teamParams.confidence, confBefore - 1, '信心-1');
        assert.ok(sysC.cm.state.sealLog[0].historyText.includes('史实'), '史实文本入日志');
    });

    await t('标签制任务进度 + effects 内嵌进度路由', () => {
        sysC.lc.loadState({ week: 2, day: 1, phase: 'DAY_ACTION', ap: 9, taskProgress: {}, tasks: {}, settledWeek: 1 });
        sysC.lc.issueTasks(2);
        const ev = sysC.lc.onChoiceMade({ effects: {}, progressTags: ['work_frame'] });
        assert.ok(ev.some(e => e.type === 'task-progress-tag'), '标签命中发事件');
        const mainTask = Object.values(sysC.lc.state.tasks).find(t => (t.progressFrom || []).includes('work_frame'));
        assert.strictEqual(mainTask.progress, 1, 'workProgressBase=1 计入');

        sysC.lc.loadState({ week: 1, day: 1, phase: 'DAY_ACTION', ap: 9, taskProgress: {}, tasks: {}, settledWeek: 0 });
        sysC.lc.issueTasks(1);
        const ev2 = sysC.lc.onChoiceMade({ effects: { taskId: 'task_w1_teach_frame', taskProgress: 2 } });
        assert.ok(ev2.some(e => e.type === 'task-progress' && e.delta === 2));
        const t1 = sysC.lc.state.tasks['task_w1_teach_frame'];
        assert.strictEqual(t1.progress, 2);
    });

    await t('真实节点选项结算：flags 数组展开 / npc 映射 / costHint 保留', () => {
        const nodeId = 'n_1thu_020_identity';
        if (!sysC.se.nodes[nodeId]) { console.log('    · 跳过（内容线尚未提交该节点）'); return; }
        sysC.se.currentNodeId = null;
        assert.strictEqual(sysC.se.goToNode(nodeId), true);
        const idx = sysC.se.currentNode.choices.findIndex(c => c.setFlags && c.setFlags.length);
        assert.ok(idx >= 0, '存在 setFlags 选项');
        assert.ok(typeof sysC.se.currentNode.choices[idx].costHint === 'string', 'costHint 供 UI 显影');
        const r = sysC.se.makeChoice(idx);
        assert.ok(r, '选项结算成功');
        assert.strictEqual(sysC.am.getFlag(sysC.se.currentNode.choices[idx].setFlags[0]), true);
    });
}

// ================= 6. P1 体验层 =================
console.log('\n[6] P1 体验层');

await t('算尺评分：三档精度阈值', () => {
    assert.strictEqual(SlideRuleGame.score(0.005), 'perfect');
    assert.strictEqual(SlideRuleGame.score(0.018), 'perfect', '边界含于档内');
    assert.strictEqual(SlideRuleGame.score(0.03), 'good');
    assert.strictEqual(SlideRuleGame.score(0.05), 'good');
    assert.strictEqual(SlideRuleGame.score(0.09), 'poor');
});

await t('结算报告：lastSettleReport 结构（items/crisis/autosave）', () => {
    const sysR = freshSystem();
    sysR.se.setStoryData(skeleton);
    sysR.lc.loadState({ week: 2, day: 2, phase: 'WEEK_SETTLE', ap: 0, taskProgress: {}, tasks: {}, settledWeek: 1 });
    // 两张测试牌：一张达标、一张逾期且显式危机旗标
    sysR.lc.state.tasks['t_x'] = { id:'t_x', title:'测试牌', target:1, status:'active', issuedWeek:2, progressFrom:[], progress:1,
        rewards:{effects:{integration:3}} };
    sysR.lc.state.tasks['t_y'] = { id:'t_y', title:'逾期牌', target:2, status:'active', issuedWeek:2, progressFrom:[],
        rewards:{effects:{}}, onMiss:{effects:{deviation:5}, crisisFlag:'f_crisis_test'} };
    const events = sysR.lc.settleWeek();
    assert.ok(events.some(e => e.type === 'autosave'), '自动存档事件');
    const rep = sysR.lc.lastSettleReport;
    assert.ok(rep, '报告已产出');
    assert.strictEqual(rep.week, 2);
    assert.strictEqual(rep.items.length, 2);
    const okItem = rep.items.find(i => i.id === 't_x');
    assert.strictEqual(okItem.result, 'success');
    assert.ok(okItem.summary.includes('融入'), '奖励摘要含中文标签');
    const missItem = rep.items.find(i => i.id === 't_y');
    assert.strictEqual(missItem.result, 'miss');
    assert.ok(rep.autosave === true);
    // 危机旗标（显式命名）
    const crisisEv = events.find(e => e.type === 'crisis-triggered');
    assert.ok(crisisEv, '显式 crisisFlag 触发危机');
    assert.strictEqual(crisisEv.flag, 'f_crisis_test');
    assert.strictEqual(sysR.am.getFlag('f_crisis_test'), true);
});

await t('快进器 tier②：内容 week 字段精确匹配（第2周→w2_start）', () => {
    const s9 = freshSystem();
    const loader9 = new ContentLoader({
        storyEngine: s9.se, loopController: s9.lc,
        cardManager: s9.cm, attributeManager: s9.am
    });
    const rd = async (p) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', path.basename(p)), 'utf8'));
    return loader9.load(['data/story_act1.json'], rd).then(() => {
        s9.se.currentNodeId = null;
        s9.se.goToNode('n_000_open');
        assert.strictEqual(s9.lc.fastForward(2), true);
        assert.strictEqual(s9.se.currentNodeId, 'w2_start', '命中 node.week===2 的周开始节点');
        assert.strictEqual(s9.lc.state.phase, 'WEEK_START');
        assert.strictEqual(s9.lc.state.week, 2);
    });
});

await t('快进器 tier③：骨架周命名约定匹配不受影响', () => {
    const sA = freshSystem();
    sA.se.setStoryData(skeleton);
    sA.se.currentNodeId = null;
    sA.se.goToNode('w1_start');
    sA.lc.state.week = 1;
    assert.strictEqual(sA.lc.fastForward(2), true);
    assert.strictEqual(sA.se.currentNodeId, 'w2_start');
});

// ================= 7. 配置优先级 + 夜谈事件 =================
console.log('\n[7] 优先级与夜谈');

await t('优先级：故事周显式配置 > params 预设 > 内置默认', () => {
    const sP = freshSystem();
    // 模拟 params.json 预设（ContentLoader.loadParams 的映射产物）
    sP.lc.config._presetTutorial = { apPerDay: 1, nightChoice: false, crisisChain: false, deadlineEnabled: false };
    sP.lc.config._presetFull = { apPerDay: 2, nightChoice: true, crisisChain: true, deadlineEnabled: true };

    const norm = ContentLoader.normalizeWeeks({
        1: { days: ['mon'], apPerDay: 3 }   // 与 tutorial(1) 冲突：故事必须赢
    });
    sP.lc.applyContentWeeks(norm);

    assert.strictEqual(sP.lc.getWeekConfig(1).apPerDay, 3, '故事显式覆盖预设');
    assert.strictEqual(sP.lc.getWeekConfig(5).apPerDay, 2, '未定义周走 full 预设');
    assert.strictEqual(sP.lc.getWeekConfig(5).crisisChain, true);
});

await t('优先级：故事未定义第1周时兜底 tutorial 而非 full', () => {
    const sQ = freshSystem();
    sQ.lc.config._presetTutorial = { apPerDay: 1, nightChoice: false, crisisChain: false, deadlineEnabled: false };
    sQ.lc.config._presetFull = { apPerDay: 2, nightChoice: true, crisisChain: true, deadlineEnabled: true };
    sQ.lc.applyContentWeeks(ContentLoader.normalizeWeeks({ 2: { days: ['mon', 'tue'] } }));
    assert.strictEqual(sQ.lc.getWeekConfig(1).crisisChain, false, 'W1 兜底 tutorial');
    assert.strictEqual(sQ.lc.getWeekConfig(1).apPerDay, 1);
    assert.strictEqual(sQ.lc.getWeekConfig(2).crisisChain, true, 'W2 显式配置生效');
});

await t('键级 undefined 不遮蔽既有配置', () => {
    const sU = freshSystem();
    sU.lc.mergeConfig({ weeks: { 9: { apPerDay: 7, crisisChain: undefined } } });
    assert.strictEqual(sU.lc.getWeekConfig(9).apPerDay, 7);
    assert.strictEqual(sU.lc.getWeekConfig(9).crisisChain, true, 'undefined 不覆盖默认');
});

{
    // 夜谈事件：真实 night_events.json
    const sysN = freshSystem();
    const loaderN = new ContentLoader({
        storyEngine: sysN.se, loopController: sysN.lc,
        cardManager: sysN.cm, attributeManager: sysN.am
    });
    const rdN = async (p) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', path.basename(p)), 'utf8'));
    await loaderN.load(['data/story_act1.json', 'data/npcs.json', 'data/night_events.json'], rdN);

    await t('夜谈注册：事件全部入池（数量随内容动态对齐）', () => {
        const ne = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'night_events.json'), 'utf8'));
        assert.strictEqual(sysN.lc.config.nightEvents.length, ne.events.length);
    });

    await t('夜谈挑选：talkTo 匹配 + showIf 好感门槛', () => {
        sysN.lc.state.week = 2;
        sysN.am.changeNPCRelation('zhao', 1);   // 满足 >=1
        const ev = sysN.lc.pickNightEvent({ talkTo: 'zhao' });
        assert.ok(ev, '应命中赵师傅夜谈');
        assert.strictEqual(ev.id, 'ne_w2_zhao_whip');
        // 好感清零 → 门槛不满足
        sysN.am.changeNPCRelation('zhao', -1);
        assert.strictEqual(sysN.lc.pickNightEvent({ talkTo: 'zhao' }), null);
        sysN.am.changeNPCRelation('zhao', 1);
    });

    await t('夜谈结算：好感/旗标/once 标记，二次挑选排除', () => {
        const r = sysN.lc.applyNightEvent(sysN.lc.pickNightEvent({ talkTo: 'zhao' }));
        jseq(r.npcChanges.map(c => c.id), ['zhao']);
        assert.strictEqual(sysN.am.getFlag('f_knew_old_rules'), true);
        assert.ok(sysN.lc.state.firedNightEvents.includes('ne_w2_zhao_whip'), 'fired 已记录');
        assert.strictEqual(sysN.lc.pickNightEvent({ talkTo: 'zhao' }), null, 'once 排除已触发');
    });

    await t('夜遇事件：无 talkTo、flag 门槛、priority 降序', () => {
        sysN.am.setFlag('f_material_detail', true);
        const top = sysN.lc.pickNightEvent({ talkTo: null });
        assert.strictEqual(top.id, 'ne_w2_dispatch_intel', 'p15 高于查铺 p5');
        // 触发后回落到次高
        sysN.lc.applyNightEvent(top);
        assert.strictEqual(sysN.lc.pickNightEvent({ talkTo: null }).id, 'ne_w2_fang_blanket');
        assert.strictEqual(sysN.am.getFlag('f_knew_nationwide_hunt'), true);
        jseq(sysN.lc.state.lastExploreTags, ['explore_dispatch'], '探索标签已记录');
    });

    await t('夜谈 fired 列表随存档往返', () => {
        const snap = JSON.parse(JSON.stringify(sysN.lc.getState()));
        const sysO = freshSystem();
        sysO.lc.registerNightEvents(sysN.lc.config.nightEvents);
        sysO.lc.loadState(snap);
        jseq(sysO.lc.state.firedNightEvents, snap.firedNightEvents, '恢复一致');
        assert.strictEqual(sysO.lc.pickNightEvent({ talkTo: 'zhao' }), null, '读档后 once 仍排除');
    });
}

// ================= 结果 =================
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('测试块异常:', e); process.exit(1); });
