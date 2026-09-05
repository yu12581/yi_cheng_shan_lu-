#!/usr/bin/env node
/**
 * E2 内容数据校验器（零依赖 Node）
 * 用法：node e2_validate.js [json路径...]   缺省扫描 ../data/*.json + 本目录骨架周
 * 按结构自动识别类型：story / cards / tasks / npcs / params
 * 退出码：0=无错误（可有警告）；1=有错误。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PHASES = ['WEEK_START','DAY_START','DAY_ACTION','NIGHT_CHOICE','WEEK_SETTLE'];
const ATTRS = ['integration','deviation','stamina'];
const SPECIAL_KEYS = ['taskId','taskProgress','exploreTags'];
const NIGHTS = ['rest','overtime','talk'];
const DAYS = ['mon','tue','wed','thu','fri','sat','sun'];
const OP_RE = /^(>=|<=|==|!=|=|>|<)\s*-?\d+(\.\d+)?$/;

let errors = 0, warnings = 0;
const err = m => { errors++; console.error(`  ✗ [E] ${m}`); };
const warn = m => { warnings++; console.warn(`  ▲ [W] ${m}`); };
const info = m => console.log(`  · ${m}`);

// 跨文件登记表
const ctx = {
    nodeIds: new Set(),      // 所有故事节点 id
    allCardIds: new Set(),
    allNpcIds: new Set(['chen','zhao','liu','wang','zhang','li']), // 内置六人
    cardGoto: [],            // [{cardId,target}]
    npcFirstMeet: [],        // [{npcId,node}]
    taskDefs: [],            // 任务定义（含 progressFrom）
    usedTags: []             // choices 里用到的 progressTags
};

function detectKind(d) {
    if (!d || typeof d !== 'object') return 'unknown';
    if (d.nodes && typeof d.nodes === 'object') return 'story';
    if (Array.isArray(d.cards)) return 'cards';
    if (Array.isArray(d.tasks)) return 'tasks';
    if (Array.isArray(d.events)) return 'night'; // schema §12 夜谈/夜遇事件
    const vs = Object.values(d);
    if (vs.some(v => v && typeof v === 'object' && (v.firstMeetNode || v.affinity))) return 'npcs';
    if (d.weeks && (d.stamina || d.deviation)) return 'params';
    if (vs.some(v => v && typeof v === 'object' && ('text' in v || 'narrative' in v))) return 'story';
    return 'unknown';
}

function checkCondition(cond, where) {
    if (cond == null || typeof cond !== 'object') {
        if (cond === false) return;
        if (cond !== undefined && cond !== null) err(`${where}: 条件应为对象`);
        return;
    }
    if (Array.isArray(cond)) { cond.forEach((c,i)=>checkCondition(c,`${where}[${i}]`)); return; }
    for (const [key, spec] of Object.entries(cond)) {
        if (key==='all'||key==='any') (Array.isArray(spec)?spec:[spec]).forEach((c,i)=>checkCondition(c,`${where}.${key}[${i}]`));
        else if (key==='not') checkCondition(spec, `${where}.not`);
        else if (key==='res') {
            for (const [a,e] of Object.entries(spec)) {
                if (!ATTRS.includes(a)) err(`${where}.res: 未知属性 "${a}"`);
                if (typeof e==='string' && !OP_RE.test(e.trim())) err(`${where}.res.${a}: 非法比较式 "${e}"`);
            }
        } else if (key==='npc') {
            for (const [id,e] of Object.entries(spec)) {
                if (!ctx.allNpcIds.has(id)) warn(`${where}.npc: NPC "${id}" 未注册`);
                if (typeof e==='string' && !OP_RE.test(e.trim())) err(`${where}.npc.${id}: 非法比较式`);
            }
        } else if (key==='flag') {
            if (typeof spec!=='string' && !(spec&&spec.name)) err(`${where}.flag: 应为字符串或{name,value}`);
        } else if (key==='week'||key==='day') {
            if (typeof spec!=='number' && !(typeof spec==='string'&&OP_RE.test(spec.trim()))) err(`${where}.${key}: 应为数字或比较式`);
        } else if (key==='card') {
            for (const id of (Array.isArray(spec)?spec:[spec])) {
                if (typeof id!=='string') err(`${where}.card: 卡id应为字符串`);
                else if (!ctx.allCardIds.has(id)) warn(`${where}.card: 卡"${id}"未登记`);
            }
        } else err(`${where}: 未知条件来源 "${key}"（res/npc/flag/week/day/card/all/any/not）`);
    }
}

function validateStory(d) {
    const nodes = d.nodes || d;
    const localIds = new Set();
    for (const id of Object.keys(nodes)) if (!id.startsWith('__')) { ctx.nodeIds.add(id); localIds.add(id); }
    const referenced = new Set();

    for (const [id, n] of Object.entries(nodes)) {
        if (id.startsWith('__')) continue;
        const at = `节点 ${id}`;
        if (n.phase !== undefined && n.phase !== 'FREE' && !PHASES.includes(n.phase))
            err(`${at}: 非法 phase "${n.phase}"`);

        const autoNext = n.autoNext ?? n.goto;
        if (autoNext !== undefined) {
            if (!localIds.has(autoNext) && !ctx.nodeIds.has(autoNext)) err(`${at}: 去向 "${autoNext}" 不存在`);
            referenced.add(autoNext);
        }

        if (n.effects) for (const k of Object.keys(n.effects))
            if (!SPECIAL_KEYS.includes(k) && !ATTRS.includes(k)) err(`${at}.effects: 未知属性 "${k}"`);

        const chs = Array.isArray(n.choices) ? n.choices : [];
        chs.forEach((c, i) => {
            const cat = `${at}.choices[${i}]`;
            if (!c.text || typeof c.text !== 'string' || !c.text.trim()) err(`${cat}: 缺少 text`);
            const next = c.nextNode ?? c.goto;
            if (next !== undefined) {
                if (!localIds.has(next) && !ctx.nodeIds.has(next)) err(`${cat}: 去向 "${next}" 不存在`);
                referenced.add(next);
            } else if (chs.length > 1) warn(`${cat}: 缺少去向（多选项节点）`);

            if (c.effects) {
                for (const [k,v] of Object.entries(c.effects)) {
                    if (SPECIAL_KEYS.includes(k)) {
                        if (k==='taskId' && typeof v!=='string') err(`${cat}.effects.taskId: 应为字符串`);
                        if (k==='taskProgress' && typeof v!=='number') err(`${cat}.effects.taskProgress: 应为数字`);
                    } else if (k==='npc') {
                        // 内容线允许 effects.npc 内嵌好感映射
                        if (!v || typeof v!=='object' || Array.isArray(v)) err(`${cat}.effects.npc: 应为 {npcId:增量} 对象`);
                        else for (const nid of Object.keys(v))
                            if (!ctx.allNpcIds.has(nid)) warn(`${cat}.effects.npc: NPC "${nid}" 未注册`);
                    } else if (!ATTRS.includes(k)) err(`${cat}.effects: 未知属性 "${k}"`);
                }
                if ('taskId' in c.effects && !('taskProgress' in c.effects))
                    warn(`${cat}.effects: 有 taskId 无 taskProgress，进度不生效`);
            }
            const npcMap = c.npcChanges ?? c.npc;
            if (npcMap) for (const nid of Object.keys(npcMap))
                if (!ctx.allNpcIds.has(nid)) warn(`${cat}.npc: NPC "${nid}" 未注册`);

            if (c.flags !== undefined && !Array.isArray(c.flags)) err(`${cat}: flags 应为数组`);
            if (c.costAP !== undefined && (typeof c.costAP!=='number'||c.costAP<0)) err(`${cat}: costAP 应非负数`);
            if (c.dayAdvance !== undefined && typeof c.dayAdvance!=='boolean') err(`${cat}: dayAdvance 应布尔`);
            if (c.work !== undefined && typeof c.work!=='boolean') err(`${cat}: work 应布尔`);
            if (c.night !== undefined && !NIGHTS.includes(c.night)) info(`${cat}: night="${c.night}" 仅 overtime 有机制`);
            for (const t of (c.progressTags||[])) {
                if (typeof t!=='string') err(`${cat}.progressTags: 标签应为字符串`);
                else ctx.usedTags.push({ tag:t, at:`${cat}` });
            }
            if (c.condition !== undefined) checkCondition(c.condition, `${cat}.condition`);
        });

        if (!chs.length && autoNext===undefined && !/end|ending/i.test(id))
            warn(`${at}: 死端节点（无选项无去向；结局建议命名含 end）`);
    }
    for (const id of localIds)
        if (!referenced.has(id)) info(`孤立节点（无入边）：${id} —— 序章/调试可忽略`);
}

function validateCards(d) {
    const seen = new Set();
    (d.cards||[]).forEach((c,i)=>{
        const at=`cards[${i}] (${c.id||'?'} )`;
        if (!c.id) { err(`${at}: 缺少 id`); return; }
        if (seen.has(c.id)) err(`${at}: 卡id重复`); seen.add(c.id);
        ctx.allCardIds.add(c.id);
        if (!c.name && !c.title) warn(`${at}: 缺少 name/title`);
        const w=c.window;
        if (w) {
            if (w.fromWeek!==undefined && w.toWeek!==undefined && w.fromWeek>w.toWeek)
                err(`${at}: window fromWeek>toWeek`);
            for (const dn of [w.fromDay,w.toDay])
                if (dn!==undefined && !DAYS.includes(dn)) err(`${at}: 日名"${dn}"非法`);
        }
        if (!c.onPlay) { warn(`${at}: 缺少 onPlay`); return; }
        const target=c.onPlay.goto||c.goto;
        if (c.onPlay.mode==='portal' && !target) err(`${at}: portal 模式缺 onPlay.goto`);
        if (target) ctx.cardGoto.push({cardId:c.id,target});
        if (c.onSeal) for (const k of ['confidence',...ATTRS])
            if (c.onSeal[k]!==undefined && typeof c.onSeal[k]!=='number') err(`${at}.onSeal.${k}: 应为数字`);
    });
}

function validateTasks(d) {
    const seen=new Set();
    (d.tasks||[]).forEach((t,i)=>{
        const at=`tasks[${i}] (${t.id||'?'} )`;
        if (!t.id){err(`${at}: 缺少 id`);return;}
        if (seen.has(t.id)) err(`${at}: 任务id重复`); seen.add(t.id);
        if (typeof t.target!=='number'||t.target<=0) err(`${at}: target 必须正数`);
        if (t.week!==undefined && isNaN(parseInt(t.week))) err(`${at}: week 应为数字`);
        for (const pk of ['rewards','onMiss']) {
            const pack=t[pk]; if(!pack) continue;
            for (const [k,v] of Object.entries(pack)) {
                // 特殊键：confidence=团队参数；crisisChain=危机旗标名（字符串）或布尔
                if (k==='confidence') { if (typeof v!=='number') err(`${at}.${pk}.confidence: 应为数字`); continue; }
                if (k==='crisisChain') {
                    if (typeof v!=='string' && typeof v!=='boolean') err(`${at}.${pk}.crisisChain: 应为旗标名字符串或布尔`);
                    continue;
                }
                if (!ATTRS.includes(k)) err(`${at}.${pk}: 未知属性 "${k}"`);
            }
        }
        if (Array.isArray(t.progressFrom)) {
            if (t.progressFrom.some(x=>typeof x!=='string')) err(`${at}.progressFrom: 标签应为字符串`);
        } else if (t.progressFrom!==undefined) err(`${at}: progressFrom 应为数组`);
        ctx.taskDefs.push(t);
    });
}

function validateNPCs(d) {
    for (const [id,n] of Object.entries(d)) {
        if (!ctx.allNpcIds.has(id)) ctx.allNpcIds.add(id);
        const af=n&&n.affinity;
        if (af) {
            // 阶段制：thresholds 数 = stages 数 - 1，严格递增（阶段数可变：2~4 阶段均合法）
            if (!Array.isArray(af.stages)||af.stages.length<2)
                err(`npc "${id}": stages 至少两阶段`);
            else if (!Array.isArray(af.stageThresholds)||af.stageThresholds.length!==af.stages.length-1)
                err(`npc "${id}": stageThresholds 数应等于 stages 数-1`);
            else if (af.stageThresholds.some((v,i)=>typeof v!=='number'||(i>0&&v<=af.stageThresholds[i-1])))
                err(`npc "${id}": stageThresholds 应严格递增数字`);
        }
        if (n.firstMeetNode) ctx.npcFirstMeet.push({npcId:id,node:n.firstMeetNode});
    }
}

function validateParams(d) {
    if (d.weeks) for (const [k,p] of Object.entries(d.weeks))
        if (p.apPerDay!==undefined && (typeof p.apPerDay!=='number'||p.apPerDay<0)) err(`weeks.${k}.apPerDay 应非负数`);
    if (d.stamina) {
        if (typeof d.stamina.max!=='number'||d.stamina.max<=0) err('stamina.max 应为正数');
        if (d.stamina.morningRecovery!==undefined && typeof d.stamina.morningRecovery!=='number') err('stamina.morningRecovery 应为数字');
    }
    info(`参数段：weeks(${Object.keys(d.weeks||{}).join('/')}) stamina(${d.stamina?'✓':'✗'}) deviation(${d.deviation?'✓':'✗'})`);
}

/* ================= night_events（schema §12） ================= */
function validateNightEvents(d) {
    if (!Array.isArray(d.events)) { err('night_events: 缺少 events 数组'); return; }
    const seen = new Set();
    d.events.forEach((ev, i) => {
        const at = `events[${i}] (${ev.id || '?'} )`;
        if (!ev.id) { err(`${at}: 缺少 id`); return; }
        if (seen.has(ev.id)) err(`${at}: 事件 id 重复`); seen.add(ev.id);
        if (!/^ne_/.test(ev.id)) info(`${at}: 建议事件 id 以 ne_ 开头`);

        if (typeof ev.week !== 'number') err(`${at}: week 必须为数字`);
        if (ev.day !== null && ev.day !== undefined && !DAYS.includes(ev.day))
            err(`${at}: day "${ev.day}" 非法（null=任意日 或 ${DAYS.join('/')}）`);

        // 归属/对象 NPC
        for (const k of ['talkTo', 'npcOwner']) {
            if (ev[k] !== undefined && ev[k] !== null && !ctx.allNpcIds.has(ev[k]))
                err(`${at}.${k}: NPC "${ev[k]}" 未注册`);
        }
        // 注意：内容线曾把归属者写成顶层 "npc" 并与效果增量 "npc" 撞键——
        // 解析器已对重复键报错；此处校验最终形态的 effects.npc。
        const npcFx = typeof ev.npc === 'object' && ev.npc !== null && !Array.isArray(ev.npc) ? ev.npc : null;
        if (ev.npc !== undefined && ev.npc !== null && !npcFx && !ctx.allNpcIds.has(ev.npc))
            warn(`${at}.npc: 单值形式视为归属NPC "${ev.npc}"，未注册`);

        // showIf：{flag} 或 {npc,op,v} 或 null
        const si = ev.showIf;
        if (si !== null && si !== undefined) {
            if (typeof si !== 'object' || Array.isArray(si)) err(`${at}.showIf: 应为对象或 null`);
            else if (si.flag !== undefined) {
                if (typeof si.flag !== 'string') err(`${at}.showIf.flag: 应为字符串`);
            } else if (si.npc !== undefined) {
                if (!ctx.allNpcIds.has(si.npc)) err(`${at}.showIf.npc: NPC "${si.npc}" 未注册`);
                if (!['>=','<=','>','<','==','!='].includes(si.op)) err(`${at}.showIf.op: 非法比较符 "${si.op}"`);
                if (typeof si.v !== 'number') err(`${at}.showIf.v: 应为数字`);
            } else err(`${at}.showIf: 需要 flag 或 npc/op/v 三元组`);
        }

        if (ev.priority !== undefined && typeof ev.priority !== 'number') err(`${at}: priority 应为数字`);
        if (ev.once !== undefined && typeof ev.once !== 'boolean') err(`${at}: once 应为布尔`);
        if (!ev.title || typeof ev.title !== 'string') warn(`${at}: 缺少 title`);
        if (!ev.text || typeof ev.text !== 'string') err(`${at}: 缺少 text（夜谈正文）`);

        if (ev.effects) {
            for (const [k, v] of Object.entries(ev.effects)) {
                if (SPECIAL_KEYS.includes(k)) {
                    if (k === 'exploreTags' && !Array.isArray(v)) err(`${at}.effects.exploreTags: 应为数组`);
                } else if (!ATTRS.includes(k)) err(`${at}.effects: 未知属性 "${k}"`);
            }
        }
        const npcMap = ev.npcChanges ?? (npcFx || undefined);
        if (npcMap) for (const nid of Object.keys(npcMap))
            if (!ctx.allNpcIds.has(nid)) err(`${at}.npc增量: NPC "${nid}" 未注册`);
        if (ev.flags !== undefined && !Array.isArray(ev.flags)) err(`${at}: flags 应为数组`);
    });
}

/**
 * 严格 JSON 解析：对象内重复键逐个记入 dups 收集器（JSON.parse 会静默取后者，
 * 曾导致 night_events 的归属者字段被增量映射覆盖）；结构性错误仍抛出。
 */
function parseNoDup(text, fileLabel, dups) {
    let i = 0;
    const lineCol = () => {
        let line = 1, col = 1;
        for (let j = 0; j < i && j < text.length; j++) {
            if (text[j] === '\n') { line++; col = 1; } else col++;
        }
        return `第${line}行第${col}列`;
    };
    const fail = (msg) => { throw new Error(`${fileLabel} ${lineCol()}: ${msg}`); };
    const ws = () => { while (i < text.length && /[\s]/.test(text[i])) i++; };
    function str() {
        if (text[i] !== '"') fail('期望字符串');
        i++;
        let out = '';
        while (i < text.length) {
            const c = text[i];
            if (c === '"') { i++; return out; }
            if (c === '\\') {
                i++;
                const e = text[i];
                if (e === 'u') { out += String.fromCharCode(parseInt(text.substr(i + 1, 4), 16)); i += 5; continue; }
                const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
                if (!(e in map)) fail(`非法转义 \\${e}`);
                out += map[e]; i++; continue;
            }
            out += c; i++;
        }
        fail('字符串未闭合');
    }
    function num() {
        const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
        if (!m) fail('非法值');
        i += m[0].length;
        return parseFloat(m[0]);
    }
    function obj() {
        i++; const o = {}; ws();
        if (text[i] === '}') { i++; return o; }
        while (true) {
            ws();
            const k = str(); ws();
            if (text[i] !== ':') fail('缺少冒号'); i++;
            if (Object.prototype.hasOwnProperty.call(o, k)) {
                // 记录后按 JSON.parse 语义取后者，继续解析
                dups.push(`重复键 "${k}"（${lineCol()}）—— 引擎实际只保留最后一个`);
            }
            o[k] = val(); ws();
            if (text[i] === ',') { i++; continue; }
            if (text[i] === '}') { i++; return o; }
            fail('对象内缺少 , 或 }');
        }
    }
    function arr() {
        i++; const a = []; ws();
        if (text[i] === ']') { i++; return a; }
        while (true) {
            a.push(val()); ws();
            if (text[i] === ',') { i++; continue; }
            if (text[i] === ']') { i++; return a; }
            fail('数组内缺少 , 或 ]');
        }
    }
    function val() {
        ws();
        const c = text[i];
        if (c === '{') return obj();
        if (c === '[') return arr();
        if (c === '"') return str();
        if (text.startsWith('true', i)) { i += 4; return true; }
        if (text.startsWith('false', i)) { i += 5; return false; }
        if (text.startsWith('null', i)) { i += 4; return null; }
        return num();
    }
    const out = val(); ws();
    if (i < text.length) fail('末尾有多余字符');
    return out;
}

/* ================= 主流程 ================= */
/** 第一遍：登记跨文件 id 池（NPC/卡/节点），保证后续校验顺序无关 */
function collectPass(d, kind) {
    if (kind === 'npcs') {
        for (const id of Object.keys(d)) ctx.allNpcIds.add(id);
    } else if (kind === 'cards') {
        (d.cards || []).forEach(c => { if (c.id) ctx.allCardIds.add(c.id); });
    } else if (kind === 'story') {
        const nodes = d.nodes || d;
        for (const id of Object.keys(nodes)) if (!id.startsWith('__')) ctx.nodeIds.add(id);
    }
}

function validateParsed(fp, d, kind) {
    console.log(`\n📄 ${fp}`);
    info(`类型识别: ${kind}`);
    switch (kind) {
        case 'story': validateStory(d); break;
        case 'cards': validateCards(d); break;
        case 'tasks': validateTasks(d); break;
        case 'npcs': validateNPCs(d); break;
        case 'params': validateParams(d); break;
        case 'night': validateNightEvents(d); break;
        default: warn('无法识别类型，仅做 JSON 解析检查');
    }
}

function crossCheck() {
    console.log('\n🔗 跨文件引用');
    for (const {cardId,target} of ctx.cardGoto)
        if (!ctx.nodeIds.has(target)) err(`卡 "${cardId}" 的 goto 目标节点 "${target}" 不存在（内容线尚未提交？）`);
    for (const {npcId,node} of ctx.npcFirstMeet)
        if (!ctx.nodeIds.has(node)) warn(`NPC "${npcId}" firstMeetNode "${node}" 不存在`);
    const pool=new Set();
    ctx.taskDefs.forEach(t=>(t.progressFrom||[]).forEach(tag=>pool.add(tag)));
    for (const {tag,at} of ctx.usedTags)
        if (pool.size>0 && !pool.has(tag)) warn(`${at}: 进度标签 "${tag}" 不在任何任务 progressFrom 中`);
}

function main(){
    const files=process.argv.slice(2);
    if (!files.length){
        const dataDir=path.join(__dirname,'..','data');
        if (fs.existsSync(dataDir))
            files.push(...fs.readdirSync(dataDir)
                .filter(f=>f.endsWith('.json') && !/legacy|backup|bak/i.test(f)) // 归档文件默认跳过
                .map(f=>path.join(dataDir,f)));
        const skel=path.join(__dirname,'skeleton_week.json');
        if (fs.existsSync(skel)) files.push(skel);
    }
    if (!files.length){ console.error('没有待校验文件'); process.exit(1); }

    console.log('E2 内容数据校验\n================');

    // Pass1 解析 + 收集 id 池
    const parsed=[];
    for (const fp of files){
        let d;
        const dups=[];
        try { d=parseNoDup(fs.readFileSync(fp,'utf8'), path.basename(fp), dups); }
        catch(e){ err(`JSON 解析失败: ${e.message}`); continue; }
        const kind=detectKind(d);
        parsed.push({fp,d,kind,dups});
        collectPass(d,kind);
    }
    // Pass2 分类型校验
    for (const {fp,d,kind,dups} of parsed){
        console.log(`\n📄 ${fp}`);
        info(`类型识别: ${kind}`);
        dups.forEach(m => err(`${path.basename(fp)}: ${m}`));
        switch(kind){
            case 'story': validateStory(d); break;
            case 'cards': validateCards(d); break;
            case 'tasks': validateTasks(d); break;
            case 'npcs': validateNPCs(d); break;
            case 'params': validateParams(d); break;
            case 'night': validateNightEvents(d); break;
            default: warn('无法识别类型，仅做 JSON 解析检查');
        }
    }
    // Pass3 跨文件引用
    crossCheck();
    console.log(`\n================\n结果：${errors} 个错误，${warnings} 个警告`);
    process.exit(errors>0?1:0);
}
main();
