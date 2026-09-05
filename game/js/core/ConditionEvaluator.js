/**
 * ConditionEvaluator - 声明式条件求值（决策书 D1）
 *
 * 纯函数：evalCondition(condition, snapshot) → boolean
 *
 * 容器（三种）：{ all: [子条件...] } / { any: [...] } / { not: {...} }
 * 顶层多键并存时按隐式 all 处理。
 *
 * 叶子六来源：
 *   { res:  { stamina: "<=20", integration: ">=30", deviation: "<10" } }
 *   { npc:  { chen: ">=30" } }
 *   { flag: "path_factory" }            // 存在即真；或 { flag: { name, value } }
 *   { week: 3 }                          // 数字=相等；字符串支持比较符
 *   { day:  "<=5" }                      // day 为本周第几天(1-7)
 *   { card: "card_liwen_acid" }         // 手牌持有；数组=任一持有
 *
 * 比较符字符串格式：">=30" "<=20" ">10" "<5" "==50" "!=3"，纯数字串视为相等。
 * 未知键 fail-safe 返回 false 并告警（E2 校验脚本兜底）。
 */
const ConditionEvaluator = {

    /** 比较符表 */
    OPERATORS: {
        '>=': (a, b) => a >= b,
        '<=': (a, b) => a <= b,
        '>': (a, b) => a > b,
        '<': (a, b) => a < b,
        '==': (a, b) => a === b,
        '=': (a, b) => a === b,
        '!=': (a, b) => a !== b
    },

    /**
     * 单值比较：spec 可为 number（相等）/ string（比较符表达式）
     */
    compare(actual, spec) {
        if (typeof spec === 'number') return actual === spec;
        if (typeof spec === 'boolean') return !!actual === spec;
        if (typeof spec === 'string') {
            const m = spec.match(/^(>=|<=|==|!=|=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
            if (!m) {
                console.warn('[ConditionEvaluator] 非法比较表达式:', spec);
                return false;
            }
            const op = this.OPERATORS[m[1]];
            return op(actual, parseFloat(m[2]));
        }
        console.warn('[ConditionEvaluator] 不支持的比较类型:', typeof spec);
        return false;
    },

    /**
     * 叶子求值
     * @param {string} key - 来源类型 res/npc/flag/week/day/card
     * @param {*} spec - 条件载荷
     * @param {object} snap - 快照
     */
    evalLeaf(key, spec, snap) {
        switch (key) {
            case 'res': {
                for (const [attr, cond] of Object.entries(spec)) {
                    const actual = snap.attributes ? snap.attributes[attr] : undefined;
                    if (actual === undefined || !this.compare(actual, cond)) return false;
                }
                return true;
            }
            case 'npc': {
                for (const [npcId, cond] of Object.entries(spec)) {
                    const actual = snap.npcRelations ? snap.npcRelations[npcId] : undefined;
                    if (actual === undefined || !this.compare(actual, cond)) return false;
                }
                return true;
            }
            case 'flag': {
                if (typeof spec === 'string') return !!snap.flags[spec];
                if (spec && spec.name !== undefined) {
                    const actual = snap.flags[spec.name];
                    if (spec.value === undefined) return !!actual;
                    return actual === spec.value;
                }
                return false;
            }
            case 'week':
                return snap.week != null && this.compare(snap.week, spec);
            case 'day':
                return snap.day != null && this.compare(snap.day, spec);
            case 'card': {
                if (!snap.cards || !Array.isArray(snap.cards.hand)) return false;
                const ids = Array.isArray(spec) ? spec : [spec];
                return ids.some(id => snap.cards.hand.includes(id));
            }
            default:
                console.warn('[ConditionEvaluator] 未知条件来源:', key);
                return false;
        }
    },

    /**
     * 主入口：evalCondition(condition, snapshot) → boolean
     * condition 为 null/true 视为无条件通过；false 直接不通过。
     */
    eval(condition, snapshot) {
        if (condition == null || condition === true) return true;
        if (condition === false) return false;

        // 数组 = 隐式 all
        if (Array.isArray(condition)) {
            return condition.every(c => this.eval(c, snapshot));
        }

        if (typeof condition !== 'object') {
            console.warn('[ConditionEvaluator] 非法条件:', condition);
            return false;
        }

        // 显式容器
        if (condition.all !== undefined) {
            return (Array.isArray(condition.all) ? condition.all : [condition.all])
                .every(c => this.eval(c, snapshot));
        }
        if (condition.any !== undefined) {
            return (Array.isArray(condition.any) ? condition.any : [condition.any])
                .some(c => this.eval(c, snapshot));
        }
        if (condition.not !== undefined) {
            return !this.eval(condition.not, snapshot);
        }

        // 隐式 all：逐键叶子求值
        for (const [key, spec] of Object.entries(condition)) {
            if (!this.evalLeaf(key, spec, snapshot)) return false;
        }
        return true;
    },

    /**
     * D1 分场景显隐分类：
     * - 'resource' 资源门槛 → 置灰+原因（res/card/AP 类）
     * - 'narrative' 叙事门槛 → 直接隐藏（flag/npc/week/day 类）
     */
    classify(condition) {
        if (condition == null || condition === true) return null;
        let kind = null;
        const scan = (c) => {
            if (!c || typeof c !== 'object') return;
            if (Array.isArray(c)) { c.forEach(scan); return; }
            for (const key of Object.keys(c)) {
                if (key === 'all' || key === 'any') { c[key].forEach(scan); }
                else if (key === 'not') { scan(c[key]); }
                else if (key === 'res' || key === 'card') { kind = 'resource'; } // 资源门槛优先级最高
                else if (kind !== 'resource') { kind = kind || 'narrative'; }
            }
        };
        scan(condition);
        return kind; // 'resource' | 'narrative' | null
    },

    /**
     * 生成置灰选项的一行原因文案（仅 resource 类调用）
     */
    describeBlockReason(condition, snapshot) {
        const reasons = [];
        if (!condition || typeof condition !== 'object') return '';
        const labels = { stamina: '体力', integration: '融入度', deviation: '偏离度' };
        const scan = (c) => {
            if (!c || typeof c !== 'object') return;
            if (Array.isArray(c)) { c.forEach(scan); return; }
            for (const [key, spec] of Object.entries(c)) {
                if (key === 'all' || key === 'any') { spec.forEach(scan); continue; }
                if (key === 'not') { scan(spec); continue; }
                if (key === 'res' && snapshot.attributes) {
                    for (const [attr, expr] of Object.entries(spec)) {
                        if (!this.evalLeaf('res', { [attr]: expr }, snapshot)) {
                            reasons.push(`${labels[attr] || attr}不足`);
                        }
                    }
                } else if (key === 'card') {
                    reasons.push('缺少所需预知卡');
                }
            }
        };
        scan(condition);
        return reasons.join('，');
    }
};

// 命名空间挂载
window.game = window.game || {};
window.game.ConditionEvaluator = ConditionEvaluator;
window.game.evalCondition = (condition, snapshot) => ConditionEvaluator.eval(condition, snapshot);
