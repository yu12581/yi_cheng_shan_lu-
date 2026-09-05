/**
 * DebugPanel - F1 调试面板三件套（决策书 D6）
 * ① 变量查看器：属性/好感/LoopState/手牌 实时表（500ms 自动刷新）
 * ② 节点跳转器：任意节点直达，可勾选"强制"绕过相位白名单
 * ③ 周目快进器：直接置为第N周 WEEK_START 相位
 *
 * 样式由本模块注入 <style>，不依赖 css/ 目录。
 */
class DebugPanel {

    constructor() {
        this.visible = false;
        this.refreshTimer = null;
        this.root = null;
        this.build();
        document.addEventListener('keydown', (e) => {
            if (e.key === 'F1') {
                e.preventDefault();
                this.toggle();
            }
        });
        console.log('%c[Debug] 按 F1 唤出调试面板', 'color:#8f8;background:#222;padding:2px 6px');
    }

    get game() { return window.game || {}; }

    build() {
        const style = document.createElement('style');
        style.textContent = `
#ycsl-debug{position:fixed;right:12px;bottom:12px;width:340px;max-height:78vh;
  overflow:auto;background:#14171c;color:#cfe3cf;border:1px solid #3a4a3a;
  border-radius:8px;font:12px/1.5 Consolas,monospace;z-index:9999;
  box-shadow:0 6px 24px rgba(0,0,0,.5);display:none}
#ycsl-debug.visible{display:block}
#ycsl-debug h3{margin:0;padding:6px 10px;background:#1d2430;color:#9fd49f;
  font-size:12px;display:flex;justify-content:space-between;align-items:center;
  position:sticky;top:0}
#ycsl-debug h3 .dbg-close{cursor:pointer;color:#e88;user-select:none}
#ycsl-debug section{padding:8px 10px;border-top:1px solid #263043}
#ycsl-debug h4{margin:0 0 6px;color:#7fbf7f;font-size:12px;font-weight:600}
#ycsl-debug table{width:100%;border-collapse:collapse}
#ycsl-debug td{padding:1px 4px;border-bottom:1px dashed #223;vertical-align:top}
#ycsl-debug td.k{color:#8ab4ff;white-space:nowrap}
#ycsl-debug td.v{color:#ffd28a;text-align:right;word-break:break-all}
#ycsl-debug input[type=text],#ycsl-debug input[type=number]{width:100%;
  background:#0d1015;border:1px solid #334455;color:#cfe3cf;
  padding:3px 6px;border-radius:4px;font:12px Consolas,monospace;box-sizing:border-box}
#ycsl-debug button{background:#2b3a2b;border:1px solid #4a6a4a;color:#cfe3cf;
  padding:3px 10px;border-radius:4px;cursor:pointer;margin-top:6px;width:100%;
  font-size:12px}
#ycsl-debug button:hover{background:#3a523a}
#ycsl-debug label.chk{display:flex;gap:6px;align-items:center;color:#99a;margin-top:6px}
#ycsl-debug .row2{display:flex;gap:6px}
#ycsl-debug .warn{color:#e88}
`;
        document.head.appendChild(style);

        const root = document.createElement('div');
        root.id = 'ycsl-debug';
        root.innerHTML = `
<h3><span>⚙ 一程山路 · 调试面板</span><span class="dbg-close" title="关闭">✕</span></h3>
<section>
  <h4>① 变量查看器</h4>
  <div id="dbg-vars"></div>
</section>
<section>
  <h4>② 节点跳转器</h4>
  <input type="text" id="dbg-node-input" placeholder="node_id" list="dbg-node-list">
  <datalist id="dbg-node-list"></datalist>
  <label class="chk"><input type="checkbox" id="dbg-force"> 强制跳转（绕过相位白名单）</label>
  <button id="dbg-go">跳转</button>
</section>
<section>
  <h4>③ 周目快进器</h4>
  <div class="row2">
    <input type="number" id="dbg-week-input" min="1" max="11" value="1" placeholder="周">
    <input type="number" id="dbg-day-input" min="1" max="7" value="1" placeholder="天">
  </div>
  <button id="dbg-ff">快进到第 N 周 WEEK_START</button>
  <button id="dbg-settle">直接执行本周结算（测试自动存档）</button>
</section>
`;
        document.body.appendChild(root);
        this.root = root;

        root.querySelector('.dbg-close').addEventListener('click', () => this.toggle(false));
        root.querySelector('#dbg-go').addEventListener('click', () => this.jumpTo());
        root.querySelector('#dbg-node-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.jumpTo();
        });
        root.querySelector('#dbg-ff').addEventListener('click', () => this.fastForward());
        root.querySelector('#dbg-settle').addEventListener('click', () => {
            const loop = this.game.loopController;
            if (!loop) return window.bootNotice('调试', 'LoopController 未装配');
            const events = loop.settleWeek();
            console.log('[Debug] 结算事件:', events);
            this.refreshVars(true);
        });
    }

    toggle(force) {
        this.visible = force !== undefined ? force : !this.visible;
        this.root.classList.toggle('visible', this.visible);
        if (this.visible) {
            this.fillNodeList();
            this.refreshVars(true);
            clearInterval(this.refreshTimer);
            this.refreshTimer = setInterval(() => this.refreshVars(), 500);
        } else {
            clearInterval(this.refreshTimer);
        }
    }

    fillNodeList() {
        const dl = this.root.querySelector('#dbg-node-list');
        const nodes = (this.game.storyEngine && this.game.storyEngine.nodes) || {};
        dl.innerHTML = Object.keys(nodes)
            .filter(id => !id.startsWith('__'))
            .map(id => `<option value="${id}"></option>`).join('');
    }

    /** ② 节点跳转 */
    jumpTo() {
        const input = this.root.querySelector('#dbg-node-input');
        const force = this.root.querySelector('#dbg-force').checked;
        const id = input.value.trim();
        const engine = this.game.storyEngine;
        if (!engine || !engine.nodes || !engine.nodes[id]) {
            window.bootNotice('调试', `节点不存在: ${id}`);
            return;
        }
        const ok = engine.goToNode(id, true, { force });
        if (ok) {
            if (this.game.uiManager) this.game.uiManager.renderNode();
            this.refreshVars(true);
        } else {
            window.bootNotice('调试', `跳转被相位规则阻止（当前 ${engine.loopController?.state?.phase}），可勾选强制`);
        }
    }

    /** ③ 周目快进 */
    fastForward() {
        const week = parseInt(this.root.querySelector('#dbg-week-input').value, 10);
        const day = parseInt(this.root.querySelector('#dbg-day-input').value, 10);
        const loop = this.game.loopController;
        if (!loop) return window.bootNotice('调试', 'LoopController 未装配');
        if (loop.fastForward(week)) {
            if (day > 1) loop.state.day = day;
            if (this.game.uiManager) this.game.uiManager.renderNode();
            this.refreshVars(true);
            console.log(`[Debug] 快进至第${week}周 第${loop.state.day}天 相位${loop.state.phase}`);
        } else {
            window.bootNotice('调试', '快进失败：找不到 WEEK_START 相位节点');
        }
    }

    /** ① 变量查看器实时表 */
    refreshVars(force = false) {
        if (!this.visible && !force) return;
        const box = this.root.querySelector('#dbg-vars');
        if (!box) return;
        const g = this.game;
        const rows = [];
        const row = (k, v, cls = '') => rows.push(`<tr><td class="k">${k}</td><td class="v ${cls}">${v}</td></tr>`);

        // 属性
        if (g.attributeManager) {
            for (const [name, a] of Object.entries(g.attributeManager.attributes)) {
                row(`res.${name}`, `${a.value}/${a.max}`, name === 'deviation' && a.value >= 50 ? 'warn' : '');
            }
        }
        // NPC 好感
        if (g.attributeManager) {
            for (const [id, n] of Object.entries(g.attributeManager.npcRelations)) {
                row(`npc.${id}`, `${n.value}/${n.max}`);
            }
        }
        // LoopState
        const loop = g.loopController;
        if (loop) {
            const s = loop.state;
            const cfg = loop.getWeekConfig(s.week);
            row('loop.phase', s.phase ?? '-');
            row('loop.week/day', `W${s.week} · D${s.day}`);
            row('loop.ap', s.ap, s.ap === 0 ? 'warn' : '');
            row('loop.apPerDay', cfg.apPerDay);
            row('loop.nightChoice', cfg.nightChoice ? '开' : '关');
            row('loop.crisisChain', cfg.crisisChain ? '开' : '关');
            const active = loop.getActiveTasks();
            row('tasks.active', active.length ? active.map(t => `${t.id}(${t.progress}/${t.target})`).join(', ') : '无');
        }
        // 手牌 / 卡牌
        const cards = g.cardManager;
        if (cards) {
            row('cards.hand', cards.state.hand.join(', ') || '空');
            row('cards.used', cards.state.used.length);
            row('cards.sealed', cards.state.sealed.length);
            row('cards.witness ★', cards.state.witness);
        }
        // 引擎位置与 flags 概览
        if (g.storyEngine) {
            row('node', g.storyEngine.currentNodeId);
            const flagKeys = Object.keys(g.storyEngine.attributeManager.flags || {});
            row('flags', flagKeys.length ? flagKeys.join(', ') : '无');
        }
        box.innerHTML = `<table>${rows.join('')}</table>`;
    }
}

// 命名空间挂载
window.game = window.game || {};
window.game.DebugPanel = DebugPanel;
