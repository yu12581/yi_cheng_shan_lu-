/**
 * CardManager - 预知卡运行时（决策书 D3 双形态卡）
 *
 * 卡结构（内容线经 __cards__ 注册或代码注入）：
 * {
 *   id: 'card_liwen_acid',
 *   title: '李文的硫酸',
 *   desc: '你知道这批料有问题。',
 *   consumable: true,                  // 一次性；false=可重复打出
 *   window: { from: 2, to: 3, fromDay: 1, toDay: 5 },  // 时间窗（周必校验，日可选）
 *   onPlay: {
 *     goto: 'card_scene_liwen',        // 【重卡】传送门→专属抉择节点（节点须标 freeNode:true）
 *     effects: { deviation: 5 },       // 【轻卡】即时结算效果（重卡亦可带基础代价）
 *     npcChanges: { li: -5 }
 *   }
 * }
 *
 * 双结局：打出=干预历史（偏离上涨，计价在分支选项 effects）；
 *         封存 seal()=按史实自然发生 + 见证标记(witness)+1（真结局计数器）。
 *
 * 见证标记计数器随 getState()/loadState() 入存档。
 */
class CardManager {

    constructor(attributeManager) {
        this.attributeManager = attributeManager;
        this.storyEngine = null;
        this.registry = {};   // id -> 卡定义
        this.state = {
            hand: [],         // 手牌 id 列表
            used: [],         // 已消耗
            sealed: [],       // 已封存
            witness: 0,       // ★见证标记计数器（真结局门槛）
            sealLog: []       // 封存日志 {cardId,historyText,week,day}
        };
    }

    attach({ storyEngine = null } = {}) {
        this.storyEngine = storyEngine;
    }

    /** 注册卡池（数组或映射均可） */
    registerCards(cards) {
        const list = Array.isArray(cards) ? cards : Object.values(cards || {});
        for (const card of list) {
            if (!card.id) {
                console.warn('[CardManager] 卡缺少 id:', card);
                continue;
            }
            this.registry[card.id] = card;
        }
    }

    /** 发牌入手 */
    addCard(cardId) {
        if (!this.registry[cardId]) {
            console.warn(`[CardManager] 未注册的卡 ${cardId}，已自动登记占位`);
            this.registry[cardId] = { id: cardId, title: cardId, desc: '' };
        }
        if (!this.state.hand.includes(cardId)) {
            this.state.hand.push(cardId);
        }
    }

    /**
     * 时间窗校验：
     * - window.from/to 为周界（数字）
     * - window.fromDayName/toDayName 为内容线日名（mon/tue/...），按所在周日序解析
     */
    inWindow(card, week, day) {
        if (!card.window) return true;
        const w = week ?? 0;
        const d = day ?? 1;
        if (card.window.from !== undefined && w < card.window.from) return false;
        if (card.window.to !== undefined && w > card.window.to) return false;
        if (card.window.fromDay !== undefined && d < card.window.fromDay) return false;
        if (card.window.toDay !== undefined && d > card.window.toDay) return false;

        // 内容线日名窗口（依赖 LoopController 的周日历）
        const lc = this.storyEngine ? this.storyEngine.loopController : null;
        if (card.window.fromDayName !== undefined && typeof ContentLoader !== 'undefined') {
            const idx = ContentLoader.dayIndex(lc, w, card.window.fromDayName);
            if (idx !== null && d < idx) return false;
        }
        if (card.window.toDayName !== undefined && typeof ContentLoader !== 'undefined') {
            const idx = ContentLoader.dayIndex(lc, w, card.window.toDayName);
            if (idx !== null && d > idx) return false;
        }
        return true;
    }

    canPlay(cardId) {
        const card = this.registry[cardId];
        if (!card) return { ok: false, reason: `未知的卡 ${cardId}` };
        if (!this.state.hand.includes(cardId)) return { ok: false, reason: '不在手牌中' };

        let week = null, day = null;
        if (this.storyEngine && this.storyEngine.loopController) {
            const ls = this.storyEngine.loopController.state;
            week = ls.week;
            day = ls.day;
        }
        if (!this.inWindow(card, week, day)) {
            const w = card.window;
            return { ok: false, reason: `时间窗未开（需第${w.from ?? '?'}-${w.to ?? '?'}周${w.fromDay ? `，第${w.fromDay}-${w.toDay ?? '?'}天` : ''}）` };
        }
        return { ok: true };
    }

    /**
     * 打出一张卡：
     * - 重卡（onPlay.goto）：跳转专属抉择节点（干预深度计价由分支选项承担）
     * - 轻卡（无 goto）：直接应用 onPlay.effects / npcChanges 即时结算
     * - consumable!==false 的卡打出后离手入 used
     */
    play(cardId, recordHistory = true) {
        const gate = this.canPlay(cardId);
        if (!gate.ok) {
            console.warn('[CardManager] 无法打出:', gate.reason);
            return { ok: false, reason: gate.reason };
        }
        const card = this.registry[cardId];
        const result = { ok: true, card, jumped: false, attributeChanges: [], npcChanges: [] };

        // 消耗判定（先记录，跳转后统一处理）
        const consume = card.consumable !== false;

        if (card.onPlay && card.onPlay.goto) {
            // —— 重卡：传送门 ——
            const targetId = card.onPlay.goto;
            const targetNode = this.storyEngine ? this.storyEngine.nodes[targetId] : null;
            if (!targetNode) {
                console.error(`[CardManager] 卡 ${cardId} 的目标节点 ${targetId} 不存在`);
                return { ok: false, reason: `目标节点 ${targetId} 不存在` };
            }
            // 自由节点强制放行；否则走相位白名单
            const ok = targetNode.freeNode
                ? this.storyEngine.goToNode(targetId, recordHistory, { force: true })
                : this.storyEngine.goToNode(targetId, recordHistory);
            if (!ok) return { ok: false, reason: `跳转 ${targetId} 被循环规则阻止` };
            result.jumped = true;
        }

        // 即时效果（轻卡主效果 / 重卡基础代价）
        if (card.onPlay && card.onPlay.effects && this.attributeManager) {
            for (const [attr, v] of Object.entries(card.onPlay.effects)) {
                const change = this.attributeManager.changeAttribute(attr, v);
                if (change) result.attributeChanges.push(change);
            }
        }
        if (card.onPlay && card.onPlay.npcChanges && this.attributeManager) {
            for (const [npc, v] of Object.entries(card.onPlay.npcChanges)) {
                const change = this.attributeManager.changeNPCRelation(npc, v);
                if (change) result.npcChanges.push(change);
            }
        }

        if (consume) {
            this.state.hand = this.state.hand.filter(id => id !== cardId);
            if (!this.state.used.includes(cardId)) this.state.used.push(cardId);
        }

        return result;
    }

    /**
     * 封存一张卡：不干预历史 → 自然周事件按史实发生 + 见证标记+1
     * 内容线 onSeal 扩展：{ witnessFlag, confidence, historyText }
     */
    seal(cardId) {
        if (!this.state.hand.includes(cardId)) {
            return { ok: false, reason: '不在手牌中' };
        }
        const card = this.registry[cardId] || {};
        this.state.hand = this.state.hand.filter(id => id !== cardId);
        this.state.sealed.push(cardId);
        this.state.witness += 1;   // ★真结局计数器

        // onSeal 结算
        let flagSet = null;
        if (card.onSeal) {
            const s = card.onSeal;
            if (s.witnessFlag && this.attributeManager) {
                this.attributeManager.setFlag(s.witnessFlag, true);
                flagSet = s.witnessFlag;
            }
            if (s.confidence !== undefined && this.attributeManager) {
                if (typeof this.attributeManager.changeConfidence === 'function') {
                    this.attributeManager.changeConfidence(s.confidence);
                } else {
                    this.attributeManager.changeAttribute('confidence', s.confidence);
                }
            }
        }
        // 封存日志（史实文本入存档，供幕间日记/结局引用）
        const lc = this.storyEngine ? this.storyEngine.loopController : null;
        this.state.sealLog = this.state.sealLog || [];
        this.state.sealLog.push({
            cardId,
            historyText: (card.onSeal && card.onSeal.historyText) || '',
            week: lc ? lc.state.week : null,
            day: lc ? lc.state.day : null
        });

        return { ok: true, witness: this.state.witness, flagSet };
    }

    /** 条件求值用快照 */
    getSnapshot() {
        return {
            hand: [...this.state.hand],
            sealed: [...this.state.sealed],
            used: [...this.state.used],
            witness: this.state.witness
        };
    }

    /** 存档快照（含见证标记计数器） */
    getState() {
        return JSON.parse(JSON.stringify(this.state));
    }

    /** 读档恢复 */
    loadState(snap) {
        this.state = {
            hand: [...(snap.hand || [])],
            used: [...(snap.used || [])],
            sealed: [...(snap.sealed || [])],
            witness: snap.witness || 0,
            sealLog: [...(snap.sealLog || [])]
        };
    }
}

// 命名空间挂载
window.game = window.game || {};
window.game.CardManager = CardManager;
