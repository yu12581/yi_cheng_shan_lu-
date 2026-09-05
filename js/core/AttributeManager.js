/**
 * 属性管理器 - 管理游戏中的所有属性
 */
class AttributeManager {
    constructor() {
        // 核心属性（简化后的3个）
        this.attributes = {
            stamina: { value: 100, max: 100, min: 0 },      // 体力值
            integration: { value: 50, max: 100, min: 0 },   // 融入度（合并了认可度和知识融合度）
            deviation: { value: 0, max: 100, min: 0 }       // 偏离度
        };
        
        // NPC关系值
        this.npcRelations = {
            chen: { name: '陈建国', value: 0, max: 100 },
            zhao: { name: '赵师傅', value: 0, max: 100 },
            liu: { name: '刘工程师', value: 0, max: 100 },
            wang: { name: '王设计师', value: 0, max: 100 },
            zhang: { name: '张总师', value: 0, max: 100 },
            li: { name: '李档案员', value: 0, max: 100 }
        };
        
        // 解锁的成就
        this.achievements = [];

        // 触发的标志位
        this.flags = {};

        // 隐藏团队参数（01 D6：信心，影响主线检定难度）
        this.teamParams = { confidence: 50 };
    }

    /**
     * 注册内容线 NPC（npcs.json）：保留内置六人，动态并入新角色
     * 携带阶段制好感元数据（stageThresholds/stages）供 UI 呈现
     */
    registerContentNPCs(defs) {
        for (const [id, d] of Object.entries(defs || {})) {
            if (!this.npcRelations[id]) {
                this.npcRelations[id] = { name: d.name || id, value: 0, max: 100 };
            } else if (d.name) {
                this.npcRelations[id].name = d.name;
            }
            const rel = this.npcRelations[id];
            if (d.affinity && Array.isArray(d.affinity.stageThresholds)) {
                rel.stageThresholds = [...d.affinity.stageThresholds];
            }
            if (d.affinity && Array.isArray(d.affinity.stages)) {
                rel.stages = [...d.affinity.stages];
            }
            rel.role = d.role || rel.role || '';
            rel.line = d.line || rel.line || '';
        }
    }

    /**
     * 修改隐藏团队参数（信心等），0-100 夹取
     */
    changeTeamParam(name, delta) {
        if (!(name in this.teamParams)) {
            console.warn(`团队参数 ${name} 不存在`);
            return null;
        }
        const old = this.teamParams[name];
        this.teamParams[name] = Math.max(0, Math.min(100, old + delta));
        return { name, oldValue: old, newValue: this.teamParams[name], change: this.teamParams[name] - old };
    }

    /** 快捷入口 */
    changeConfidence(delta) { return this.changeTeamParam('confidence', delta); }
    
    /**
     * 修改属性值
     * @param {string} attrName - 属性名称
     * @param {number} change - 变化量（可正可负）
     * @returns {object} 变化信息
     */
    changeAttribute(attrName, change) {
        if (!this.attributes[attrName]) {
            console.error(`属性 ${attrName} 不存在`);
            return null;
        }
        
        const attr = this.attributes[attrName];
        const oldValue = attr.value;
        attr.value = Math.max(attr.min, Math.min(attr.max, attr.value + change));
        const newValue = attr.value;
        
        return {
            name: attrName,
            oldValue,
            newValue,
            change: newValue - oldValue
        };
    }
    
    /**
     * 修改NPC关系值
     * @param {string} npcId - NPC ID
     * @param {number} change - 变化量
     * @returns {object} 变化信息
     */
    changeNPCRelation(npcId, change) {
        if (!this.npcRelations[npcId]) {
            console.error(`NPC ${npcId} 不存在`);
            return null;
        }
        
        const npc = this.npcRelations[npcId];
        const oldValue = npc.value;
        npc.value = Math.max(0, Math.min(npc.max, npc.value + change));
        const newValue = npc.value;
        
        return {
            id: npcId,
            name: npc.name,
            oldValue,
            newValue,
            change: newValue - oldValue
        };
    }
    
    /**
     * 获取属性值
     */
    getAttribute(attrName) {
        return this.attributes[attrName]?.value;
    }
    
    /**
     * 获取NPC关系值
     */
    getNPCRelation(npcId) {
        return this.npcRelations[npcId]?.value;
    }
    
    /**
     * 检查属性是否达到阈值
     */
    checkThreshold(attrName, threshold, operator = '>=') {
        const value = this.getAttribute(attrName);
        switch(operator) {
            case '>=': return value >= threshold;
            case '<=': return value <= threshold;
            case '>': return value > threshold;
            case '<': return value < threshold;
            case '==': return value === threshold;
            default: return false;
        }
    }
    
    /**
     * 添加成就
     */
    addAchievement(achievementId) {
        if (!this.achievements.includes(achievementId)) {
            this.achievements.push(achievementId);
            return true;
        }
        return false;
    }
    
    /**
     * 设置标志位
     */
    setFlag(flagName, value = true) {
        this.flags[flagName] = value;
    }
    
    /**
     * 获取标志位
     */
    getFlag(flagName) {
        return this.flags[flagName] || false;
    }
    
    /**
     * 获取所有状态（用于存档）
     */
    getState() {
        return {
            attributes: JSON.parse(JSON.stringify(this.attributes)),
            npcRelations: JSON.parse(JSON.stringify(this.npcRelations)),
            achievements: [...this.achievements],
            flags: { ...this.flags },
            teamParams: { ...this.teamParams }
        };
    }

    /**
     * 加载状态（用于读档）；旧存档缺 teamParams 时保留默认
     */
    loadState(state) {
        this.attributes = JSON.parse(JSON.stringify(state.attributes));
        this.npcRelations = JSON.parse(JSON.stringify(state.npcRelations));
        this.achievements = [...state.achievements];
        this.flags = { ...(state.flags || {}) };
        if (state.teamParams) {
            this.teamParams = { ...this.teamParams, ...state.teamParams };
        }
    }
}
