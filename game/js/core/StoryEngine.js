/**
 * 故事引擎 - 核心剧情控制
 *
 * 职责：节点跳转（含循环相位白名单校验）、选项结算、
 * 全量状态快照（引擎+属性+循环+卡牌）供存档使用。
 */
class StoryEngine {
    constructor(attributeManager) {
        this.attributeManager = attributeManager;
        this.nodes = null;  // 所有节点数据
        this.currentNode = null;  // 当前节点
        this.currentNodeId = 'node_101_timetravel';  // 当前节点ID
        this.history = [];  // 历史记录

        // 可选系统：LoopController / CardManager（由 main.js 装配）
        this.loopController = null;
        this.cardManager = null;

        // 元数据
        this.currentDate = '1958年7月10日';
        this.currentTime = '凌晨03:20';
        this.currentLocation = '北航平房教研室';
    }

    /**
     * 装配可选系统（避免构造函数循环依赖）
     */
    attachSystems({ loopController = null, cardManager = null } = {}) {
        this.loopController = loopController;
        this.cardManager = cardManager;
    }

    /**
     * 加载剧情数据
     * @param {string} dataPath - 数据文件路径
     */
    async loadStoryData(dataPath) {
        try {
            const response = await fetch(dataPath);
            const data = await response.json();
            return this.setStoryData(data);
        } catch (error) {
            console.error('加载剧情数据失败:', error);
            return false;
        }
    }

    /**
     * 解析剧情 JSON：
     * - 顶层为节点表（id -> node）
     * - `__cards__` 数组注册预知卡（内容线可随剧情文件携带）
     * - `__loopConfig__` 对象合并进 LoopController 分周配置
     */
    setStoryData(data) {
        if (data.__cards__ && this.cardManager) {
            this.cardManager.registerCards(data.__cards__);
        }
        if (data.__loopConfig__ && this.loopController) {
            this.loopController.mergeConfig(data.__loopConfig__);
        }
        this.nodes = data;
        console.log('剧情数据加载成功', Object.keys(this.nodes).length, '个节点');
        return true;
    }

    /**
     * 跳转到指定节点
     * @param {string} nodeId - 节点ID
     * @param {boolean} recordHistory - 是否把当前节点压入历史（读档恢复态传 false）
     * @param {object} opts - { force: true 跳过相位白名单校验（调试用） }
     * @returns {boolean} 是否跳转成功
     */
    goToNode(nodeId, recordHistory = true, opts = {}) {
        const node = this.nodes ? this.nodes[nodeId] : null;
        if (!node) {
            console.error(`节点 ${nodeId} 不存在`);
            return false;
        }

        // 循环相位白名单校验（LoopController 未装配或 freeNode 节点直接放行；
        // 传入当前节点——从自由场景离开不受旧相位审判）
        if (this.loopController && !opts.force
            && !this.loopController.canEnterNode(nodeId, node, this.currentNode)) {
            console.warn(`[LoopController] 相位 ${this.loopController.state.phase} 不允许进入节点 ${nodeId}`);
            return false;
        }

        // 保存历史（恢复态 recordHistory=false 不压栈；同节点重入不压栈；
        // 栈顶已是该节点时也不压栈——防卡牌场景静默返回等模式产生相邻重复）
        if (recordHistory && this.currentNodeId && this.currentNodeId !== nodeId
            && this.history[this.history.length - 1] !== this.currentNodeId) {
            this.history.push(this.currentNodeId);
        }

        // 更新当前节点
        this.currentNodeId = nodeId;
        this.currentNode = node;

        // 更新元数据
        if (node.date) this.currentDate = node.date;
        if (node.time) this.currentTime = node.time;
        if (node.location) this.currentLocation = node.location;

        // 节点级入场效果（内容线慎用：每次进入都生效；读档恢复不触发）
        if (!opts.restore && node.effects && this.attributeManager) {
            for (const [attr, v] of Object.entries(node.effects)) {
                if (['taskId', 'taskProgress', 'exploreTags'].includes(attr)) continue;
                this.attributeManager.changeAttribute(attr, v);
            }
        }

        // 通知循环控制器节点进入（驱动相位流转/周结算等）
        if (this.loopController) {
            this.loopController.enterNode(node, nodeId, opts.restore === true);
        }

        return true;
    }

    /**
     * 获取当前节点
     */
    getCurrentNode() {
        return this.currentNode;
    }

    /**
     * 构建条件求值快照（供 ConditionEvaluator 纯函数消费）
     */
    getSnapshot() {
        const attrs = this.attributeManager.attributes;
        const relations = this.attributeManager.npcRelations;
        const npcValues = {};
        for (const [id, npc] of Object.entries(relations)) {
            npcValues[id] = npc.value;
        }
        const snap = {
            attributes: {
                stamina: attrs.stamina.value,
                integration: attrs.integration.value,
                deviation: attrs.deviation.value
            },
            npcRelations: npcValues,
            flags: { ...this.attributeManager.flags },
            week: null,
            day: null,
            loop: null,
            cards: null
        };
        if (this.loopController) {
            const ls = this.loopController.getState();
            snap.week = ls.week;
            snap.day = ls.day;
            snap.loop = ls;
        }
        if (this.cardManager) {
            snap.cards = this.cardManager.getSnapshot();
        }
        return snap;
    }

    /**
     * 选择一个选项
     * @param {number|object} choiceOrIndex - 选项索引或选项对象（卡牌分支复用）
     * @returns {object|null} 选择结果
     */
    makeChoice(choiceOrIndex) {
        let choice, choiceIndex = null;
        if (!this.currentNode || !this.currentNode.choices) {
            console.error('当前节点无效或没有选项');
            return null;
        }
        if (typeof choiceOrIndex === 'number') {
            choiceIndex = choiceOrIndex;
            choice = this.currentNode.choices[choiceIndex];
        } else {
            choice = choiceOrIndex;
        }
        if (!choice) {
            console.error(`选项 ${choiceIndex} 不存在`);
            return null;
        }

        // 条件复核（防绕过 UI 直接调用）
        if (choice.condition && window.game && window.game.evalCondition) {
            if (!window.game.evalCondition(choice.condition, this.getSnapshot())) {
                console.warn('选项条件不满足，已拦截');
                return null;
            }
        }

        // 行动点预检：白天行动默认耗 1 AP，不足则整体否决（效果不生效）
        if (this.loopController && this.loopController.state.phase === 'DAY_ACTION') {
            const cost = choice.costAP !== undefined ? choice.costAP : 1;
            if (cost > this.loopController.state.ap) {
                console.warn(`[LoopController] AP不足，选项已否决（需${cost}/余${this.loopController.state.ap}）`);
                return null;
            }
        }

        const result = {
            choice: choice,
            attributeChanges: [],
            npcChanges: [],
            achievements: []
        };

        // 应用属性变化（特殊键路由：taskId/taskProgress/exploreTags→循环系统；npc→好感）
        if (choice.effects) {
            for (const [attr, value] of Object.entries(choice.effects)) {
                if (attr === 'taskId' || attr === 'taskProgress' || attr === 'exploreTags') continue;
                if (attr === 'npc' && value && typeof value === 'object') {
                    for (const [npcId, dv] of Object.entries(value)) {
                        const change = this.attributeManager.changeNPCRelation(npcId, dv);
                        if (change) result.npcChanges.push(change);
                    }
                    continue;
                }
                const change = this.attributeManager.changeAttribute(attr, value);
                if (change) result.attributeChanges.push(change);
            }
        }

        // 应用NPC关系变化
        if (choice.npcChanges) {
            for (const [npcId, value] of Object.entries(choice.npcChanges)) {
                const change = this.attributeManager.changeNPCRelation(npcId, value);
                if (change) result.npcChanges.push(change);
            }
        }

        // 解锁成就
        if (choice.unlockAchievement) {
            const added = this.attributeManager.addAchievement(choice.unlockAchievement);
            if (added) result.achievements.push(choice.unlockAchievement);
        }

        // 设置标志位（内容线数组形式 setFlags / 运行时单数 setFlag）
        if (Array.isArray(choice.setFlags)) {
            choice.setFlags.forEach(f => this.attributeManager.setFlag(f, true));
        }
        if (choice.setFlag) {
            this.attributeManager.setFlag(choice.setFlag, true);
        }

        // 通知循环控制器（行动点扣减 / 夜选推进 / 周任务进度）
        if (this.loopController) {
            result.loopEvents = this.loopController.onChoiceMade(choice, this.currentNode);
        }

        return result;
    }

    /**
     * 获取游戏状态（用于存档）：引擎+属性+循环+卡牌 全量快照
     */
    getState() {
        return {
            currentNodeId: this.currentNodeId,
            history: [...this.history],
            currentDate: this.currentDate,
            currentTime: this.currentTime,
            currentLocation: this.currentLocation,
            attributes: this.attributeManager.getState(),
            loop: this.loopController ? this.loopController.getState() : null,
            cards: this.cardManager ? this.cardManager.getState() : null
        };
    }

    /**
     * 加载游戏状态（用于读档）
     * 注意：恢复当前节点时 recordHistory=false，history 不重复压栈
     */
    loadState(state) {
        this.currentNodeId = state.currentNodeId;
        this.history = [...(state.history || [])];
        this.currentDate = state.currentDate;
        this.currentTime = state.currentTime;
        this.currentLocation = state.currentLocation;
        if (state.attributes) {
            this.attributeManager.loadState(state.attributes);
        }
        if (state.loop && this.loopController) {
            this.loopController.loadState(state.loop);
        }
        if (state.cards && this.cardManager) {
            this.cardManager.loadState(state.cards);
        }

        // 重新加载当前节点（不压历史、不触发相位推进副作用）
        this.goToNode(this.currentNodeId, false, { restore: true });
    }
}

// 挂载命名空间（若 main.js 尚未创建则先行占位）
window.game = window.game || {};
