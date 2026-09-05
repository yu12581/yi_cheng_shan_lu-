/**
 * ContentLoader - 内容线创作格式 → 运行时结构 适配层
 *
 * 内容线数据文件（data/*.json，04 领地，本模块只读适配不改写文件）：
 *   story_act1.json  { weeks:{N:{label,days[],apPerDay,nightFromDay,mainCard,overdueCrisis}},
 *                      nodes:{id:{text,phase:'FREE'|五相位,goto,effects,choices:[...]}} }
 *   cards_act1.json  { cards:[{id,name,tier,window:{fromWeek,fromDay,toWeek,toDay},
 *                              consumable,onPlay:{mode:'portal',goto},onSeal:{witnessFlag,confidence,historyText}}] }
 *   tasks_act1.json  { tasks:[{id,week,kind,name,target,progressFrom[],deadline,rewards:{扁平属性}}] }
 *   npcs.json        { id:{name,role,line,affinity:{stageThresholds,stages},firstMeetNode} }
 *   params.json      { weeks:{tutorial,full}, stamina:{max,morningRecovery,restBonus,overtimeStaminaCost},
 *                      deviation:{thresholds,naturalDecay,cardCostLight,cardCostDeep}, workProgressBase, ... }
 *
 * 双端复用：浏览器传 fetch reader；Node 测试注入 fs reader。
 */
class ContentLoader {

    static DAY_GENERIC = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

    /** 可直接进 AttributeManager 的属性键 */
    static get ATTR_KEYS() { return /^(stamina|integration|deviation)$/; }

    /**
     * @param {object} systems - { storyEngine, loopController, cardManager, attributeManager }
     */
    constructor(systems) {
        this.systems = systems;
    }

    /** 浏览器默认 reader（fetch） */
    static async fetchReader(path) {
        const res = await fetch(path);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    /**
     * 加载一组内容文件（缺失的文件静默跳过）
     * @param {string[]} paths - 数据路径列表
     * @param {Function} reader - async (path) => object
     */
    async load(paths, reader = ContentLoader.fetchReader) {
        const loaded = {};
        for (const p of paths) {
            try {
                loaded[pathKey(p)] = await reader(p);
            } catch (e) {
                console.info(`[ContentLoader] 跳过 ${p}（${e.message}）`);
            }
        }
        if (loaded.story) this.loadStory(loaded.story);
        if (loaded.params) this.loadParams(loaded.params);
        if (loaded.npcs) this.loadNPCs(loaded.npcs);
        if (loaded.tasks) this.loadTasks(loaded.tasks);
        if (loaded.cards) this.loadCards(loaded.cards);
        if (loaded.night) this.loadNightEvents(loaded.night);
        return loaded;
    }

    /** 故事主文件：节点表归一化 + 分周配置映射 */
    loadStory(data) {
        const se = this.systems.storyEngine;
        if (!se) return;
        const rawNodes = data.nodes || data; // 兼容旧版平铺格式
        const nodes = {};
        for (const [id, raw] of Object.entries(rawNodes)) {
            if (id.startsWith('__')) { nodes[id] = raw; continue; }
            nodes[id] = ContentLoader.normalizeNode(id, raw);
        }
        if (data.weeks) {
            this.systems.loopController &&
                this.systems.loopController.applyContentWeeks(ContentLoader.normalizeWeeks(data.weeks));
        }
        // 直接装配（__cards__/__loopConfig__ 兼容旧机制）
        if (data.__cards__ && this.systems.cardManager) this.systems.cardManager.registerCards(data.__cards__);
        if (data.__loopConfig__ && this.systems.loopController) this.systems.loopController.mergeConfig(data.__loopConfig__);
        se.nodes = nodes;
        console.log('[ContentLoader] 故事节点:', Object.keys(nodes).length);
    }

    /** 全局参数（params.json）：体力上限/晨起恢复/偏离阈值等入引擎配置 */
    loadParams(params) {
        const lc = this.systems.loopController;
        const am = this.systems.attributeManager;
        if (!lc) return;

        // 周预设（tutorial/full）作为兜底：未被故事 weeks 显式定义的周继承 full，
        // 第 1 周若故事未定义则继承 tutorial。
        if (params.weeks && lc.config._presetDefaults === undefined) {
            const mapPreset = (p) => ({
                apPerDay: p.apPerDay,
                nightChoice: !!p.nightChoiceUnlocked,
                crisisChain: !!p.crisisChainEnabled,
                deadlineEnabled: !!p.mainTaskEnabled
            });
            lc.config._presetTutorial = params.weeks.tutorial ? mapPreset(params.weeks.tutorial) : null;
            lc.config._presetFull = params.weeks.full ? mapPreset(params.weeks.full) : null;
        }

        if (params.stamina) {
            if (am && am.attributes.stamina) {
                am.attributes.stamina.max = params.stamina.max;
                am.attributes.stamina.value = Math.min(am.attributes.stamina.value, params.stamina.max);
            }
            lc.config.morningRecovery = params.stamina.morningRecovery ?? lc.config.morningRecovery;
        }
        // 其余参数存档于 gameParams 供 UI/小游戏消费（算尺加成/偏离阈值/夜选成本…）
        lc.config.gameParams = JSON.parse(JSON.stringify(params));
        console.log('[ContentLoader] 参数已应用');
    }

    /** NPC 名册：动态注册进 AttributeManager（保留内置六人） */
    loadNPCs(npcs) {
        const am = this.systems.attributeManager;
        if (!am || typeof am.registerContentNPCs !== 'function') return;
        am.registerContentNPCs(npcs);
        console.log('[ContentLoader] NPC 注册:', Object.keys(npcs).length);
    }

    /** 任务牌：content 扁平 rewards → 运行时 {effects} 结构 */
    loadTasks(data) {
        const lc = this.systems.loopController;
        if (!lc || !data.tasks) return;
        const tasksByWeek = {};
        for (const raw of data.tasks) {
            const t = ContentLoader.normalizeTask(raw);
            (tasksByWeek[t._week] = tasksByWeek[t._week] || []).push(t);
        }
        lc.mergeConfig({ tasks: tasksByWeek });
        console.log('[ContentLoader] 任务牌:', data.tasks.length);
    }

    /** 预知卡：content 卡结构 → 运行时卡结构 */
    loadCards(data) {
        const cm = this.systems.cardManager;
        if (!cm || !data.cards) return;
        cm.registerCards(data.cards.map(ContentLoader.normalizeCard));
        console.log('[ContentLoader] 预知卡:', data.cards.length);
    }

    /** 夜谈/夜遇事件池（night_events.json，schema §12） */
    loadNightEvents(data) {
        const lc = this.systems.loopController;
        if (!lc || !data.events) return;
        lc.registerNightEvents(data.events.map(ContentLoader.normalizeNightEvent));
        console.log('[ContentLoader] 夜谈事件:', data.events.length);
    }

    /**
     * 夜谈事件归一化：
     * - 已知数据缺陷：部分事件顶层 "npc" 键重复（归属者 vs 增量映射），JSON.parse
     *   取后者——归属者以 talkTo 兜底；E2 校验器会对重复键报错，内容线修复后此兜底可移除。
     * - effects.exploreTags 等特殊键由 LoopController.applyNightEvent 运行期路由。
     */
    static normalizeNightEvent(ev) {
        const e = { ...ev };
        if (typeof e.npc === 'string' || e.npc === null) {
            // 归属者单值形态（无增量撞键的规范写法）
            if (e.talkTo === undefined) e.talkTo = e.npc ?? null;
            e.npc = null;
        }
        return e;
    }

    /* ==================== 归一化纯函数 ==================== */

    /**
     * 节点归一化：
     * - text → narrative
     * - phase:'FREE' 剥离（自由节点）
     * - goto → autoNext（无选项续接）
     * - choices：goto→nextNode、flags数组展开、npc→npcChanges（原样保留 costHint/slot 等供 UI）
     * - effects/node.effects 原样保留（运行期由 makeChoice/goToNode 路由特殊键）
     */
    static normalizeNode(id, raw) {
        const node = { ...raw, id };
        if (node.text !== undefined && node.narrative === undefined) node.narrative = node.text;
        if (node.phase === 'FREE') delete node.phase;
        if (node.goto !== undefined && node.autoNext === undefined) node.autoNext = node.goto;

        if (Array.isArray(node.choices)) {
            node.choices = node.choices.map(c => {
                const ch = { ...c };
                if (ch.goto !== undefined && ch.nextNode === undefined) ch.nextNode = ch.goto;
                if (Array.isArray(ch.flags)) {
                    ch.setFlags = [...ch.flags];           // 多旗标
                    if (!ch.setFlag) ch.setFlag = ch.flags[0]; // 兼容单旗标读取方
                }
                if (ch.npc !== undefined && ch.npcChanges === undefined) ch.npcChanges = ch.npc;
                return ch;
            });
        }
        return node;
    }

    /**
     * 分周配置归一化：days 数组定周长与日序；nightFromDay 日名 → 序号
     * mainCard→deadlineEnabled；overdueCrisis→crisisChain
     */
    static normalizeWeeks(storyWeeks) {
        const out = { weeks: {} };
        let maxWeek = 0;
        for (const [wk, w] of Object.entries(storyWeeks)) {
            const weekNum = parseInt(wk);
            if (isNaN(weekNum)) continue;
            maxWeek = Math.max(maxWeek, weekNum);
            const days = Array.isArray(w.days) ? w.days : [];
            const nightIdx = w.nightFromDay ? days.indexOf(w.nightFromDay) : -1;
            const preset = weekNum === 1 ? '_presetTutorial' : '_presetFull';
            const base = {}; // 预设值先落位（normalizeWeeks 时 presets 尚未写入则忽略）
            out.weeks[weekNum] = {
                ...base,
                label: w.label || '',
                dayNames: [...days],
                daysPerWeek: days.length || undefined,
                apPerDay: w.apPerDay,
                nightFromDay: nightIdx >= 0 ? nightIdx + 1 : undefined,
                nightChoice: nightIdx >= 0 ? true : undefined,
                deadlineEnabled: w.mainCard,
                crisisChain: w.overdueCrisis
            };
        }
        out.totalWeeks = maxWeek || undefined;
        return out;
    }

    /** 任务牌归一化：rewards 扁平属性 → {effects}；记录 _week 与 progressFrom 标签
     *  特殊键映射：confidence→团队参数；crisisChain(字符串)→危机旗标名 */
    static normalizeTask(raw) {
        const t = { ...raw };
        t.title = raw.name || raw.id;
        const packMap = (pack) => {
            if (!pack) return undefined;
            const out = { effects: {} };
            for (const [k, v] of Object.entries(pack)) {
                if (ContentLoader.ATTR_KEYS.test(k)) out.effects[k] = v;
                else if (k === 'confidence') out.effects.confidence = v;
                else if (k === 'witnessFlag') out.witnessFlag = v;
                else if (k === 'crisisChain') out.crisisFlag = typeof v === 'string' ? v : true;
                else out.effects[k] = v; // 未知键保留，运行期告警兜底
            }
            return out;
        };
        t.rewards = packMap(raw.rewards);
        t.onMiss = packMap(raw.onMiss);
        t.progressFrom = Array.isArray(raw.progressFrom) ? [...raw.progressFrom] : [];
        t._week = raw.week;
        return t;
    }

    /** 预知卡归一化：name→title、mode:'portal'⇔goto、窗口日名保留待解析 */
    static normalizeCard(raw) {
        const c = { ...raw };
        if (raw.name && !raw.title) c.title = raw.name;
        if (raw.onPlay && raw.onPlay.mode === 'portal' && !raw.onPlay.goto) {
            c.onPlay = { ...raw.onPlay, goto: raw.onPlay.target || raw.goto };
        }
        const w = raw.window;
        if (w && (w.fromWeek !== undefined || w.toWeek !== undefined)) {
            c.window = {
                from: w.fromWeek,
                to: w.toWeek,
                fromDayName: w.fromDay,
                toDayName: w.toDay
            };
        }
        // onSeal 映射：confidence/witnessFlag/historyText
        if (raw.onSeal) {
            c.onSeal = { ...raw.onSeal };
        }
        return c;
    }

    /** 日名 → 某周内的日序号（未知周用通用周一~周日次序） */
    static dayIndex(loopController, week, dayName) {
        if (!dayName) return null;
        const cfg = loopController ? loopController.getWeekConfig(week) : null;
        if (cfg && Array.isArray(cfg.dayNames) && cfg.dayNames.length) {
            const i = cfg.dayNames.indexOf(String(dayName).toLowerCase());
            return i >= 0 ? i + 1 : null;
        }
        return ContentLoader.DAY_GENERIC[String(dayName).toLowerCase()] || null;
    }
}

function pathKey(p) {
    if (/cards/.test(p)) return 'cards';
    if (/tasks/.test(p)) return 'tasks';
    if (/night/.test(p)) return 'night';
    if (/npcs?/.test(p)) return 'npcs';
    if (/params/.test(p)) return 'params';
    return 'story';
}

// 命名空间挂载
window.game = window.game || {};
window.game.ContentLoader = ContentLoader;
