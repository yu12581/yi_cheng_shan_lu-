/**
 * LoopController - 周循环相位机（决策书 D2）
 *
 * 相位枚举：WEEK_START → DAY_START ⇄ DAY_ACTION → NIGHT_CHOICE → … → WEEK_SETTLE ↺
 * LoopState：{ week, day, phase, ap, taskProgress, tasks, settledWeek }
 *
 * 职责：
 * 1. 相位流转合法性由代码保证：StoryEngine.goToNode 仅允许进入
 *    「当前相位白名单」（同相位 ∪ 允许的下一相位）内声明的节点；
 *    未声明 phase 的节点视为自由节点（序章等），freeNode:true 强制放行。
 * 2. 行动点经济：白天行动默认耗 1 AP（choice.costAP 可覆盖，0=不耗）；
 *    夜选结算后推进到次日晨或周结算。
 * 3. 任务牌生命周期 issued → active → settled（target/rewards/onMiss/进度）。
 * 4. 周结算：任务验收 → 奖励/逾期惩罚 → 主线逾期触发「修正危机」flag
 *    （教学档关闭）→ 自动槽存档。
 *
 * 分周参数可配置（mergeConfig / __loopConfig__）：
 *   第1周残周教学档：apPerDay=1、无夜选、无修正危机链；
 *   第2周起全速档：apPerDay=2、夜选开启、主线牌时限启用。
 */
class LoopController {

    static PHASES = ['WEEK_START', 'DAY_START', 'DAY_ACTION', 'NIGHT_CHOICE', 'WEEK_SETTLE'];

    constructor(attributeManager) {
        this.attributeManager = attributeManager;
        this.storyEngine = null;
        this.saveManager = null;
        this.cardManager = null;

        // 默认分周参数（可被 __loopConfig__ / mergeConfig 覆盖）
        this.config = {
            totalWeeks: 11,
            daysPerWeek: 5,
            morningRecovery: 1,      // 晨起自然恢复体力
            defaultApPerDay: 2,      // 全速档每日行动点
            weekDefaults: {
                nightChoice: true,      // 夜晚三选一
                deadlineEnabled: true,  // 主线牌时限
                crisisChain: true       // 主线逾期→修正危机链
            },
            weeks: {
                // 残周教学档：上手引导，失败不致死
                1: {
                    label: '残周·教学',
                    apPerDay: 1,
                    nightChoice: false,
                    deadlineEnabled: false,
                    crisisChain: false
                }
            },
            tasks: {},       // week -> [任务牌]
            nodePatterns: [] // [{ match: '^w1_', phase: 'WEEK_START' }] 可选兜底
        };

        this.state = this.freshState();
        this.pendingPhase = null; // 夜选结算后的预期落点（瞬态，不入存档）
        this.listeners = [];
    }

    freshState() {
        return {
            week: 0,
            day: 1,
            phase: null,
            ap: 0,
            taskProgress: {},   // taskId -> progress
            tasks: {},          // taskId -> {id,title,target,status,issuedWeek,...}
            settledWeek: 0,     // 已结算的周号（防重复结算）
            workStamp: '',      // 最近干活日戳（first-work-today 判定）
            lastExploreTags: [],// 最近探索标签（探索系统最小内核）
            firedNightEvents: [] // 已触发的夜谈事件 id（once 判定，入存档）
        };
    }

    /**
     * 装配协作系统（main.js 调用）
     */
    attach({ storyEngine = null, saveManager = null, cardManager = null } = {}) {
        this.storyEngine = storyEngine;
        this.saveManager = saveManager;
        this.cardManager = cardManager;
    }

    /** 订阅状态变化（UI/调试面板刷新） */
    onChange(cb) { this.listeners.push(cb); }
    emitChange() { this.listeners.forEach(cb => { try { cb(this.state); } catch (e) { console.error(e); } }); }

    /**
     * 合并外部配置（剧情 JSON 的 __loopConfig__ 或调试注入）
     */
    mergeConfig(partial) {
        const c = this.config;
        if (!partial || typeof partial !== 'object') return;
        if (partial.totalWeeks !== undefined) c.totalWeeks = partial.totalWeeks;
        if (partial.daysPerWeek !== undefined) c.daysPerWeek = partial.daysPerWeek;
        if (partial.morningRecovery !== undefined) c.morningRecovery = partial.morningRecovery;
        if (partial.defaultApPerDay !== undefined) c.defaultApPerDay = partial.defaultApPerDay;
        if (partial.weekDefaults) Object.assign(c.weekDefaults, partial.weekDefaults);
        if (partial.weeks) {
            for (const [w, wc] of Object.entries(partial.weeks)) {
                // 键级 undefined 过滤：显式缺省不遮蔽已有配置
                // （归一化产物会带 undefined 键；优先级 = 故事显式 > params 预设 > 内置默认）
                const clean = {};
                for (const [k, v] of Object.entries(wc)) {
                    if (v !== undefined) clean[k] = v;
                }
                c.weeks[w] = { ...(c.weeks[w] || {}), ...clean };
            }
        }
        if (partial.tasks) {
            for (const [w, list] of Object.entries(partial.tasks)) {
                c.tasks[w] = [...(c.tasks[w] || []), ...list];
            }
        }
        if (partial.nodePatterns) c.nodePatterns.push(...partial.nodePatterns);
    }

    /**
     * 应用内容线故事 weeks 配置（ContentLoader 归一化产物）
     * - 不允许收缩 totalWeeks（第一幕只定义前几周，后续周仍可配置）
     * - 未显式定义的周用 params 预设兜底（W1=tutorial，其余=full）
     */
    applyContentWeeks(norm) {
        const c = this.config;
        if (norm.totalWeeks && norm.totalWeeks > c.totalWeeks) c.totalWeeks = norm.totalWeeks;
        delete norm.totalWeeks;

        const maxW = Math.max(c.totalWeeks, ...Object.keys(norm.weeks).map(Number), 0);
        for (let w = 1; w <= maxW; w++) {
            if (!norm.weeks[w] && !c.weeks[w]) {
                const preset = (w === 1 && c._presetTutorial) ? c._presetTutorial : c._presetFull;
                if (preset) c.weeks[w] = { ...preset };
            }
        }
        this.mergeConfig(norm);
    }

    /** 日名（mon/tue/...）→ 当前周内的日序号；未知返回 null */
    resolveDayIndex(dayName, week = this.state.week) {
        if (typeof ContentLoader !== 'undefined') {
            return ContentLoader.dayIndex(this, week, dayName);
        }
        return null;
    }

    /** 记录探索标签（探索系统的最小内核，供后续支线池消费） */
    recordExplore(tags) {
        this.state.lastExploreTags = Array.isArray(tags) ? [...tags] : [tags];
        this.emitChange();
    }

    /* ================= 夜谈/夜遇事件（night_events.json，schema §12） ================= */

    /** 注册事件池（ContentLoader 调用） */
    registerNightEvents(events) {
        this.config.nightEvents = Array.isArray(events) ? events : [];
        this.emitChange();
    }

    static CMP = {
        '>=': (a, b) => a >= b, '<=': (a, b) => a <= b,
        '>': (a, b) => a > b, '<': (a, b) => a < b,
        '==': (a, b) => a === b, '!=': (a, b) => a !== b
    };

    /**
     * 筛选当前可触发的夜谈事件（按 priority 降序）
     * @param {object} opts { week?, dayName?, talkTo? } —— talkTo=null 匹配无对象的夜遇事件
     */
    eligibleNightEvents(opts = {}) {
        const am = this.attributeManager;
        const week = opts.week !== undefined ? opts.week : this.state.week;
        const fired = this.state.firedNightEvents || [];
        const dayIdx = opts.dayName != null ? this.resolveDayIndex(opts.dayName) : null;

        const list = (this.config.nightEvents || []).filter(ev => {
            if (Number(ev.week) !== Number(week)) return false;
            if (ev.day != null) {
                const idx = this.resolveDayIndex(ev.day);
                if (idx === null || dayIdx === null || idx !== dayIdx) return false;
            }
            if (opts.talkTo !== undefined && String(ev.talkTo ?? '') !== String(opts.talkTo ?? '')) return false;
            if (ev.once !== false && fired.includes(ev.id)) return false;

            const si = ev.showIf;
            if (si && typeof si === 'object') {
                if (si.flag !== undefined && am && !am.getFlag(si.flag)) return false;
                if (si.npc !== undefined && am) {
                    const cur = am.getNPCRelation(si.npc) ?? 0;
                    const op = LoopController.CMP[si.op] || LoopController.CMP['>='];
                    if (!op(cur, si.v)) return false;
                }
            }
            return true;
        });

        return list.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    }

    /** 取最高优先级的可触发事件；无则 null */
    pickNightEvent(opts) {
        return this.eligibleNightEvents(opts)[0] || null;
    }

    /** 结算夜谈事件：effects/npc 增量/旗标 + once 标记；返回变化供 UI 反馈 */
    applyNightEvent(ev) {
        const out = { attributeChanges: [], npcChanges: [], flags: [] };
        const am = this.attributeManager;
        if (!ev) return out;

        if (am && ev.effects) {
            for (const [k, v] of Object.entries(ev.effects)) {
                if (k === 'exploreTags') { this.recordExplore(v); continue; }
                const c = am.changeAttribute(k, v);
                if (c) out.attributeChanges.push(c);
            }
        }
        // 内容线增量映射在顶层 npc 键（对象形态）；talkTo 为归属者
        const npcMap = (ev.npc && typeof ev.npc === 'object' && !Array.isArray(ev.npc))
            ? ev.npc : (ev.npcChanges || null);
        if (am && npcMap) {
            for (const [id, v] of Object.entries(npcMap)) {
                const c = am.changeNPCRelation(id, v);
                if (c) out.npcChanges.push(c);
            }
        }
        if (Array.isArray(ev.flags) && am) {
            ev.flags.forEach(f => { am.setFlag(f, true); out.flags.push(f); });
        }
        if (!this.state.firedNightEvents.includes(ev.id)) this.state.firedNightEvents.push(ev.id);
        this.emitChange();
        return out;
    }

    /**
     * 取某周生效配置 = weekDefaults ⊕ weeks[N]
     */
    getWeekConfig(week) {
        const c = this.config;
        const override = c.weeks[week] || {};
        return {
            ...c.weekDefaults,
            apPerDay: override.apPerDay !== undefined ? override.apPerDay : c.defaultApPerDay,
            label: override.label || '',
            // 该周日名序（dayIndex/日名校准依赖；无定义则空数组走通用映射）
            dayNames: Array.isArray(override.dayNames) ? override.dayNames : [],
            // 该周天数（04 D1：残周4天，常规周5天）
            daysPerWeek: override.daysPerWeek !== undefined ? override.daysPerWeek : c.daysPerWeek,
            // 该周从第几天起有夜选（04 D2：残周D1仅白天，D2起解锁夜选）
            nightFromDay: override.nightFromDay !== undefined ? override.nightFromDay : 1,
            nightChoice: override.nightChoice !== undefined ? override.nightChoice : c.weekDefaults.nightChoice,
            deadlineEnabled: override.deadlineEnabled !== undefined ? override.deadlineEnabled : c.weekDefaults.deadlineEnabled,
            crisisChain: override.crisisChain !== undefined ? override.crisisChain : c.weekDefaults.crisisChain
        };
    }

    /** 该天是否有夜选 */
    hasNightToday() {
        const cfg = this.getWeekConfig(this.state.week);
        return cfg.nightChoice && this.state.day >= cfg.nightFromDay;
    }

    /**
     * 当前相位下允许的下一相位集合
     * pendingPhase 优先：选项已承诺落点（夜选入睡/无夜选日的 dayAdvance 推进）
     */
    allowedNextPhases() {
        if (this.pendingPhase) return [this.pendingPhase];
        const cfg = this.getWeekConfig(this.state.week);
        switch (this.state.phase) {
            case 'WEEK_START': return ['DAY_START'];
            case 'DAY_START': return ['DAY_ACTION'];
            case 'DAY_ACTION':
                return this.hasNightToday() ? ['NIGHT_CHOICE'] : ['WEEK_SETTLE'];
            case 'NIGHT_CHOICE':
                // 夜选后：次日晨（日号由 DAY_START 节点的 day 字段校准）或直落周结算（作者链路）
                return ['DAY_START', 'WEEK_SETTLE'];
            case 'WEEK_SETTLE': return ['WEEK_START'];
            default:
                // 尚未进入循环（如序章）：放行任意循环入口
                return LoopController.PHASES.slice();
        }
    }

    /**
     * 解析节点所属相位：显式 node.phase 优先，其次正则模式表，未命中=null（自由节点）
     */
    resolvePhase(node) {
        if (!node) return null;
        if (node.phase) return node.phase;
        const id = arguments[1];
        for (const p of this.config.nodePatterns) {
            try {
                if (new RegExp(p.match).test(id)) return p.phase;
            } catch (e) { /* 非法正则忽略 */ }
        }
        return null;
    }

    /**
     * goToNode 白名单校验：仅允许当前相位白名单内的节点迁移
     * 自由节点（未声明 phase 或 freeNode:true）始终放行；
     * 从自由节点离开同样放行——自由场景是作者可信锚点，链路由内容决定
     */
    canEnterNode(nodeId, node, fromNode = null) {
        const declared = this.resolvePhase(node, nodeId);
        if (!declared || node.freeNode) return true;
        if (!this.state.phase) return true; // 循环未启动（序章阶段）
        if (fromNode) {
            const fromDeclared = this.resolvePhase(fromNode, fromNode.id);
            if (!fromDeclared || fromNode.freeNode) return true; // 自由场景出口不受限
        }
        if (!LoopController.PHASES.includes(declared)) {
            console.warn(`[LoopController] 节点 ${nodeId} 声明了未知相位 ${declared}`);
            return false;
        }
        const allowed = [this.state.phase, ...this.allowedNextPhases()];
        if (!allowed.includes(declared)) {
            return false;
        }
        // 夜选节点：仅当该天有夜选时可进入
        if (declared === 'NIGHT_CHOICE' && !this.hasNightToday()) {
            return false;
        }
        return true;
    }

    /**
     * 节点进入后的钩子（goToNode 成功后调用；读档恢复时 restore=true 跳过副作用）
     */
    enterNode(node, nodeId, restore = false) {
        const declared = this.resolvePhase(node, nodeId);
        if (restore) {
            if (declared) this.state.phase = declared;
            this.emitChange();
            return;
        }
        const prevPhase = this.state.phase;
        if (declared && declared !== prevPhase) {
            this.state.phase = declared;
        } else if (!declared && this.pendingPhase) {
            // 自由节点提交待定相位（如夜选后进入次日自由场景，保持相位连贯）
            this.state.phase = this.pendingPhase;
        }
        this.pendingPhase = null;

        // 周号校准：内容节点自带 week 字段（沿链路单调递增）。
        // 修正"首周无 WEEK_START 节点"导致的整体错位一周问题。
        const nodeWeek = Number(node && node.week);
        if (Number.isFinite(nodeWeek) && nodeWeek > 0 && declared !== 'WEEK_START'
            && nodeWeek > this.state.week) {
            this.state.week = nodeWeek;
        }

        switch (declared) {
            case 'WEEK_START': this.beginWeek(prevPhase, node); break;
            case 'DAY_START': this.syncDayFromNode(node); this.beginDay(); break;
            case 'DAY_ACTION': this.ensureDayBudget(); break;
            case 'WEEK_SETTLE': this.settleWeek(); break;
        }
        this.emitChange();
    }

    /**
     * 日号校准：DAY_START 节点自带 day 字段（如 'fri'），
     * 作者链路跨日直跳（如周四晚→周五晨）时对齐日计数
     */
    syncDayFromNode(node) {
        if (node && node.day) {
            const idx = this.resolveDayIndex(node.day);
            if (idx && idx !== this.state.day) this.state.day = idx;
        }
    }

    /**
     * 周开始：推进周计数（节点声明 week 用绝对值；否则首次进入 +1）
     * 发牌 + 初始化日计数
     */
    beginWeek(prevPhase = null, node = null) {
        const declaredWeek = node ? Number(node.week) : NaN;
        if (Number.isFinite(declaredWeek) && declaredWeek > 0) {
            this.state.week = declaredWeek; // 内容声明绝对周号（如 w2_start → 2）
        } else if (prevPhase !== 'WEEK_START') {
            this.state.week += 1;
        }
        this.state.day = 1;
        this.issueTasks(this.state.week);
    }

    /** 日开始：晨起自然回体 + 重置行动点 */
    beginDay() {
        const cfg = this.getWeekConfig(this.state.week);
        this.state.ap = cfg.apPerDay;
        this.state.apGrantKey = this.state.week + '_' + this.state.day;
        if (this.attributeManager && this.config.morningRecovery > 0) {
            this.attributeManager.changeAttribute('stamina', this.config.morningRecovery);
        }
    }

    /**
     * 当日行动点懒发放：FREE 序章直落 DAY_ACTION 时（未经 DAY_START），
     * 保证当日预算只发一次（apGrantKey 随存档持久化，读档不重复发放）
     */
    ensureDayBudget() {
        const key = this.state.week + '_' + this.state.day;
        if (this.state.apGrantKey === key) return;
        this.state.apGrantKey = key;
        const cfg = this.getWeekConfig(this.state.week);
        this.state.ap = cfg.apPerDay;
    }

    /**
     * 强制收工推进（全灰死锁兜底）：推进到下一天或周结算。
     * 节点导航由调用方完成（UI 找到次日 DAY_START 节点后 goToNode）。
     */
    forceDayAdvance() {
        const events = [];
        const cfg = this.getWeekConfig(this.state.week);
        if (this.state.day < cfg.daysPerWeek) {
            this.state.day += 1;
            this.pendingPhase = 'DAY_START';
            events.push({ type: 'next-day', day: this.state.day });
        } else {
            this.pendingPhase = 'WEEK_SETTLE';
            events.push({ type: 'week-end' });
        }
        this.emitChange();
        return events;
    }

    /** 是否还能执行白天行动 */
    canAct() {
        return this.state.phase === 'DAY_ACTION' && this.state.ap > 0;
    }

    /**
     * 扣减行动点
     * @returns {boolean} 是否成功
     */
    spendAP(n = 1) {
        if (n <= 0) return true;
        if (this.state.ap < n) {
            console.warn(`[LoopController] AP不足（${this.state.ap}/${n}）`);
            return false;
        }
        this.state.ap -= n;
        this.emitChange();
        return true;
    }

    /**
     * 选项结算钩子（StoryEngine.makeChoice 内调用）
     * @returns {Array} 事件列表（供 UI 反馈/测试断言）
     */
    onChoiceMade(choice) {
        const events = [];
        if (this.state.phase === 'DAY_ACTION') {
            // 白天行动默认耗 1 AP；costAP 显式声明可覆盖（0=免费）
            const cost = choice.costAP !== undefined ? choice.costAP : 1;
            if (cost > 0) {
                if (this.spendAP(cost)) {
                    events.push({ type: 'ap-spent', cost, remaining: this.state.ap });
                } else {
                    events.push({ type: 'ap-insufficient', cost });
                }
            }
        }

        // 任务牌进度（运行时直连格式 choice.progress = { taskId: 数量 })
        if (choice.progress) {
            for (const [taskId, n] of Object.entries(choice.progress)) {
                if (this.addProgress(taskId, n)) {
                    events.push({ type: 'task-progress', taskId, delta: n });
                }
            }
        }

        // 内容线 effects 内嵌进度：{ taskId, taskProgress }
        const fx = choice.effects || {};
        if (fx.taskId && fx.taskProgress !== undefined) {
            if (this.addProgress(fx.taskId, fx.taskProgress)) {
                events.push({ type: 'task-progress', taskId: fx.taskId, delta: fx.taskProgress });
            }
        }

        // 探索标签
        if (Array.isArray(fx.exploreTags)) {
            this.recordExplore(fx.exploreTags);
            events.push({ type: 'explore', tags: [...fx.exploreTags] });
        }

        // 标签制任务进度（内容线 progressTags 命中任务的 progressFrom）
        if (Array.isArray(choice.progressTags) && choice.progressTags.length) {
            const base = (this.config.gameParams && this.config.gameParams.workProgressBase) || 1;
            for (const tag of choice.progressTags) {
                for (const task of this.getActiveTasks()) {
                    if ((task.progressFrom || []).includes(tag) && this.addProgress(task.id, base)) {
                        events.push({ type: 'task-progress-tag', taskId: task.id, tag, delta: base });
                    }
                }
            }
        }

        // 熬夜加班：本周任务进度+1（01 D2），choice.night='overtime' 时自动计入
        // 日终推进：夜选结束 或 无夜选日的 dayAdvance 入睡（04 D2 残周D1）
        const isNightEnd = this.state.phase === 'NIGHT_CHOICE' || choice.dayAdvance === true;
        if (isNightEnd) {
            if (this.state.phase === 'NIGHT_CHOICE' && choice.night === 'overtime') {
                for (const task of this.getActiveTasks()) {
                    this.addProgress(task.id, 1);
                }
                events.push({ type: 'overtime-progress' });
            }
            // 推进到次日晨或周结算（相位由下一节点的声明驱动）
            const cfg = this.getWeekConfig(this.state.week);
            if (this.state.day < cfg.daysPerWeek) {
                this.state.day += 1;
                this.pendingPhase = 'DAY_START';
                events.push({ type: 'next-day', day: this.state.day });
            } else {
                this.pendingPhase = 'WEEK_SETTLE';
                events.push({ type: 'week-end' });
            }
        }

        // 干活标记（04 D4：每天第一次干活触发算尺快滑，事件供 UI 挂小游戏）
        if (choice.work === true) {
            const stamp = `${this.state.week}_${this.state.day}`;
            if (this.state.workStamp !== stamp) {
                this.state.workStamp = stamp;
                events.push({ type: 'first-work-today', week: this.state.week, day: this.state.day });
            }
        }

        this.emitChange();
        return events;
    }

    /**
     * 周开始发放任务牌（config.tasks[week]，生命周期 issued→active）
     */
    issueTasks(week) {
        const list = this.config.tasks[week] || [];
        for (const t of list) {
            if (this.state.tasks[t.id] && this.state.tasks[t.id].status !== 'settled') continue;
            this.state.tasks[t.id] = {
                ...JSON.parse(JSON.stringify(t)),
                status: 'active',
                issuedWeek: week,
                progress: 0
            };
            this.state.taskProgress[t.id] = 0;
        }
    }

    addProgress(taskId, n = 1) {
        const task = this.state.tasks[taskId];
        if (!task || task.status !== 'active') return false;
        task.progress = Math.min(task.target, (task.progress || 0) + n);
        this.state.taskProgress[taskId] = task.progress;
        return true;
    }

    getActiveTasks() {
        return Object.values(this.state.tasks).filter(t => t.status === 'active');
    }

    /**
     * 周结算：验收任务牌 → 奖励/惩罚 → 危机链 → 自动存档
     * 同时产出 lastSettleReport（UI 蒙太奇消费，读档恢复不产生）
     */
    static EFFECT_LABELS = { stamina: '体力', integration: '融入', deviation: '偏离', confidence: '信心' };

    settleWeek() {
        if (this.state.settledWeek === this.state.week) return []; // 读档防重入
        const cfg = this.getWeekConfig(this.state.week);
        const events = [];
        this.lastSettleReport = { week: this.state.week, items: [], crisis: [], autosave: false };

        for (const task of Object.values(this.state.tasks)) {
            if (task.status !== 'active' || task.issuedWeek !== this.state.week) continue;

            const met = (task.progress || 0) >= task.target;
            task.status = 'settled';
            task.result = met ? 'success' : 'miss';

            const pack = met ? task.rewards : task.onMiss;
            const summary = [];
            if (pack && this.attributeManager) {
                const fx = pack.effects || {};
                for (const [attr, v] of Object.entries(fx)) {
                    let change = null;
                    if (attr === 'confidence') {
                        change = this.attributeManager.changeConfidence(v);
                    } else {
                        change = this.attributeManager.changeAttribute(attr, v);
                    }
                    if (change) {
                        const label = LoopController.EFFECT_LABELS[change.name] || change.name;
                        summary.push(`${label}${v > 0 ? '+' : ''}${v}`);
                    }
                }
                if (pack.npcChanges) {
                    for (const [npc, v] of Object.entries(pack.npcChanges)) {
                        this.attributeManager.changeNPCRelation(npc, v);
                        summary.push('好感变化');
                    }
                }
            }

            // 危机判定：周配置开启 或 任务级显式指定危机旗标名（onMiss.crisisChain:"f_xxx"）
            const explicitFlag = !met && task.onMiss && typeof task.onMiss.crisisFlag === 'string'
                ? task.onMiss.crisisFlag : null;
            if (!met && cfg.deadlineEnabled && (cfg.crisisChain || explicitFlag)) {
                // 「修正危机」事件链（内容线读取该 flag 展开）
                const flag = explicitFlag || `crisis_w${this.state.week}_${task.id}`;
                this.attributeManager.setFlag(flag, true);
                events.push({ type: 'crisis-triggered', taskId: task.id, week: this.state.week, flag });
                this.lastSettleReport.crisis.push({ taskId: task.id, title: task.title || task.id, flag });
            } else if (!met && !cfg.crisisChain && !explicitFlag) {
                events.push({ type: 'miss-grace', taskId: task.id, note: '教学档免罚' });
            }
            events.push({ type: 'task-settled', taskId: task.id, result: task.result });
            this.lastSettleReport.items.push({
                id: task.id,
                title: task.title || task.id,
                result: task.result,
                progress: task.progress || 0,
                target: task.target,
                summary: summary.join('　'),
                grace: !met && !explicitFlag && !cfg.crisisChain
            });
        }

        this.state.settledWeek = this.state.week;

        // ★ 自动槽存档（决策书 01 D5 / 03 D5：每周期开始自动存档落点=周结算后）
        if (this.saveManager && this.storyEngine) {
            const ok = this.saveManager.saveGame(this.saveManager.autoSlot, this.storyEngine.getState());
            events.push(ok
                ? { type: 'autosave', slot: 'auto', week: this.state.week }
                : { type: 'autosave-failed' });
            this.lastSettleReport.autosave = ok;
        }

        this.emitChange();
        return events;
    }

    /**
     * 【调试】周目快进：直接置为第 N 周 WEEK_START 相位并跳转到对应节点
     * 匹配优先级：
     *   ① config.fastForwardMap[N] 显式映射
     *   ② 相位 WEEK_START 且 node.week === N（内容线节点自带 week 字段）
     *   ③ 命名约定 w{N}（骨架/测试档）
     *   ④ 兜底：第一个 WEEK_START 节点
     */
    fastForward(weekN, recordHistory = true) {
        const week = Math.max(1, Math.min(this.config.totalWeeks, weekN | 0));
        const saved = this.state;
        this.state = this.freshState();
        this.pendingPhase = null;
        this.state.week = week;
        this.state.phase = 'WEEK_START';
        this.state.settledWeek = week - 1; // 视为之前各周已了结

        if (!this.storyEngine || !this.storyEngine.nodes) {
            this.state = saved;
            console.warn('[LoopController] 快进失败：未加载剧情');
            return false;
        }

        let targetId = null;
        const weekStarts = []; // 所有 WEEK_START 相位候选

        for (const [id, node] of Object.entries(this.storyEngine.nodes)) {
            if (id.startsWith('__')) continue;
            if (this.resolvePhase(node, id) !== 'WEEK_START') continue;
            weekStarts.push(id);
            // ① 显式映射
            const map = this.config.fastForwardMap;
            if (map && map[week] === id) { targetId = id; break; }
            // ② week 字段精确匹配
            if (targetId === null && Number(node.week) === week) targetId = id;
        }

        if (!targetId) {
            // ③ 命名约定 w{N}
            targetId = weekStarts.find(id => new RegExp(`(^|[^\\d])w?${week}([^\\d]|$)`).test(id)
                || new RegExp(`w${week}`).test(id)) || null;
        }
        if (!targetId && weekStarts.length) {
            // ④ 兜底
            targetId = weekStarts[0];
            console.warn(`[LoopController] 未找到第${week}周的专属开始节点，回退到 ${targetId}`);
        }

        if (!targetId) {
            this.state = saved;
            console.warn('[LoopController] 快进失败：找不到 WEEK_START 相位节点');
            return false;
        }
        return this.storyEngine.goToNode(targetId, recordHistory, {});
    }

    /** 存档快照 */
    getState() {
        return JSON.parse(JSON.stringify(this.state));
    }

    /** 读档恢复（不触发结算副作用） */
    loadState(snap) {
        this.state = { ...this.freshState(), ...JSON.parse(JSON.stringify(snap)) };
        this.pendingPhase = null;
        this.emitChange();
    }
}

// 命名空间挂载
window.game = window.game || {};
window.game.LoopController = LoopController;
