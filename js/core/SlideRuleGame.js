/**
 * SlideRuleGame - 算尺快滑小游戏（决策书 04 D4）
 *
 * 触发时机：每天第一次干活（LoopController 发出 first-work-today 事件且 choice.work）。
 * 玩法：Canvas 程序化绘制简化算尺，拖动游标对准红色标线，
 *       倒计时结束（或点击「判定」）按偏差给三档精度：
 *         perfect（完美）→ 任务进度加成 slideRulePerfectBonus（params.json）
 *         good（合格）/ poor（失手）→ 无加成，仅演出
 *
 * 引擎无关：构造后自绘自毁，经 onFinish 回调交还控制权。
 */
class SlideRuleGame {

    /** 精度阈值（相对宽度误差比） */
    static THRESH = { perfect: 0.018, good: 0.05 };

    /** 纯函数：按误差比评分（可单测） */
    static score(errorRatio) {
        if (errorRatio <= SlideRuleGame.THRESH.perfect) return 'perfect';
        if (errorRatio <= SlideRuleGame.THRESH.good) return 'good';
        return 'poor';
    }

    constructor(opts = {}) {
        this.onFinish = opts.onFinish || (() => {});
        this.duration = opts.duration || 4200;   // 判定倒计时
        this.width = Math.min(520, Math.max(280, (window.innerWidth || 800) * 0.86));
        this.height = 240;

        // 单例防重叠
        if (window.__slideRuleActive) window.__slideRuleActive.destroy();
        window.__slideRuleActive = this;

        this.targetRatio = 0.22 + Math.random() * 0.56;   // 标线位置（20%~78%）
        this.cursorRatio = 0.06 + Math.random() * 0.12;   // 游标初始位置（远端）
        this.startAt = performance.now();
        this.finished = false;

        this._build();
        this._loop = this._loop.bind(this);
        this.rafId = requestAnimationFrame(this._loop);
    }

    /* ================= 构建 ================= */
    _build() {
        if (!document.getElementById('sliderule-style')) {
            const st = document.createElement('style');
            st.id = 'sliderule-style';
            st.textContent = `
#srg-overlay{position:fixed;inset:0;background:#000a;z-index:950;display:flex;
  align-items:center;justify-content:center;font:"Microsoft YaHei",sans-serif}
#srg-panel{background:#f2e8d5;border:3px solid #6b5236;border-radius:10px;
  box-shadow:0 10px 40px #000c;padding:14px 16px;user-select:none}
#srg-title{color:#4a3820;font-weight:700;font-size:14px;margin-bottom:8px;
  display:flex;justify-content:space-between;gap:16px}
#srg-hint{color:#7a6848;font-size:11px;margin-top:8px;text-align:center}
#srg-btn{display:block;margin:10px auto 0;padding:4px 26px;border-radius:5px;
  border:1px solid #6b5236;background:#8b6f47;color:#f7eeda;cursor:pointer;font-size:13px}
#srg-btn:hover{background:#9c7e54}
`;
            document.head.appendChild(st);
        }

        this.overlay = document.createElement('div');
        this.overlay.id = 'srg-overlay';
        this.overlay.innerHTML = `
<div id="srg-panel">
  <div id="srg-title"><span>📐 算尺快校</span><span id="srg-clock"></span></div>
  <canvas id="srg-canvas"></canvas>
  <div id="srg-hint">按住并拖动游标 ▼ 对准红色标线 —— 对得越准，进度加成越高</div>
  <button id="srg-btn">判 定</button>
</div>`;
        document.body.appendChild(this.overlay);

        const dpr = window.devicePixelRatio || 1;
        this.canvas = this.overlay.querySelector('#srg-canvas');
        this.canvas.width = this.width * dpr;
        this.canvas.height = this.height * dpr;
        this.canvas.style.width = this.width + 'px';
        this.canvas.style.height = this.height + 'px';
        this.ctx = this.canvas.getContext('2d');
        this.ctx.scale(dpr, dpr);

        this.clockEl = this.overlay.querySelector('#srg-clock');

        // 指针事件（鼠标/触摸统一 Pointer Events）
        this._onDown = (e) => { this.dragging = true; this._moveTo(e); e.preventDefault(); };
        this._onMove = (e) => { if (this.dragging) { this._moveTo(e); e.preventDefault(); } };
        this._onUp = () => { this.dragging = false; };
        this.canvas.addEventListener('pointerdown', this._onDown);
        this.canvas.addEventListener('pointermove', this._onMove);
        window.addEventListener('pointerup', this._onUp);
        this.overlay.querySelector('#srg-btn').addEventListener('click', () => this.finish('button'));
    }

    _eventX(e) {
        const rect = this.canvas.getBoundingClientRect();
        return (e.clientX - rect.left) / rect.width;
    }
    _moveTo(e) {
        this.cursorRatio = Math.min(0.97, Math.max(0.03, this._eventX(e)));
    }

    /* ================= 绘制 ================= */
    _loop(now) {
        if (this.finished) return;
        const left = Math.max(0, this.duration - (now - this.startAt));
        if (this.clockEl) this.clockEl.textContent = (left / 1000).toFixed(1) + 's';
        if (left <= 0) { this.finish('timeout'); return; }
        this._draw();
        this.rafId = requestAnimationFrame(this._loop);
    }

    _draw() {
        const g = this.ctx, W = this.width, H = this.height;
        g.clearRect(0, 0, W, H);

        // 尺身（木质渐变）
        const bodyY = 60, bodyH = 110;
        const grad = g.createLinearGradient(0, bodyY, 0, bodyY + bodyH);
        grad.addColorStop(0, '#d9c39a');
        grad.addColorStop(1, '#c2a878');
        g.fillStyle = grad;
        g.fillRect(10, bodyY, W - 20, bodyH);
        g.strokeStyle = '#8a7048'; g.lineWidth = 2;
        g.strokeRect(10, bodyY, W - 20, bodyH);

        // 对数感刻度：上排密集中排稀疏（视觉示意即可）
        const pad = 24, usable = W - pad * 2;
        g.strokeStyle = '#5a4630';
        for (let row = 0; row < 3; row++) {
            const y = bodyY + 18 + row * 32;
            const count = [60, 30, 12][row];
            for (let i = 0; i <= count; i++) {
                const t = i / count;
                const x = pad + usable * t;
                const h = i % 10 === 0 ? 14 : (i % 5 === 0 ? 9 : 5);
                g.beginPath();
                g.moveTo(x, y); g.lineTo(x, y + h);
                g.globalAlpha = 0.55 + row * 0.15;
                g.stroke();
            }
        }
        g.globalAlpha = 1;

        // 红色标线（目标）
        const tx = pad + usable * this.targetRatio;
        g.strokeStyle = '#c0392b'; g.lineWidth = 3;
        g.beginPath();
        g.moveTo(tx, bodyY - 14); g.lineTo(tx, bodyY + bodyH + 14);
        g.stroke();
        g.fillStyle = '#c0392b';
        g.beginPath();
        g.moveTo(tx, bodyY - 20); g.lineTo(tx - 6, bodyY - 30); g.lineTo(tx + 6, bodyY - 30);
        g.closePath(); g.fill();

        // 游标（玻璃片）
        const cx = pad + usable * this.cursorRatio;
        g.fillStyle = 'rgba(120,160,190,.25)';
        g.fillRect(cx - 13, bodyY - 6, 26, bodyH + 12);
        g.strokeStyle = '#2c3e50'; g.lineWidth = 2;
        g.beginPath();
        g.moveTo(cx, bodyY - 10); g.lineTo(cx, bodyY + bodyH + 10);
        g.stroke();
        g.fillStyle = '#2c3e50';
        g.beginPath();
        g.moveTo(cx, bodyY + bodyH + 16); g.lineTo(cx - 7, bodyY + bodyH + 28); g.lineTo(cx + 7, bodyY + bodyH + 28);
        g.closePath(); g.fill();

        // 倒计时条
        const leftRatio = Math.max(0, (performance.now() - this.startAt) / this.duration);
        g.fillStyle = '#e0d5bd';
        g.fillRect(10, H - 22, W - 20, 8);
        g.fillStyle = leftRatio > 0.3 ? '#7a9a5a' : '#c0392b';
        g.fillRect(10, H - 22, (W - 20) * (1 - leftRatio), 8);
    }

    /* ================= 判定与销毁 ================= */
    finish(reason = 'manual') {
        if (this.finished) return;
        this.finished = true;
        cancelAnimationFrame(this.rafId);

        const pad = 24, usable = this.width - pad * 2;
        const pxErr = Math.abs(this.cursorRatio - this.targetRatio) * usable;
        const errorRatio = pxErr / usable;
        const precision = SlideRuleGame.score(errorRatio);

        // 清理
        this.canvas.removeEventListener('pointerdown', this._onDown);
        this.canvas.removeEventListener('pointermove', this._onMove);
        window.removeEventListener('pointerup', this._onUp);
        this.overlay.remove();
        if (window.__slideRuleActive === this) window.__slideRuleActive = null;

        this.onFinish({ precision, errorRatio, reason });
    }

    destroy() {
        if (this.finished) return;
        this.finished = true;
        cancelAnimationFrame(this.rafId);
        try {
            this.canvas.removeEventListener('pointerdown', this._onDown);
            this.canvas.removeEventListener('pointermove', this._onMove);
            window.removeEventListener('pointerup', this._onUp);
            this.overlay.remove();
        } catch (e) { /* 已销毁 */ }
        if (window.__slideRuleActive === this) window.__slideRuleActive = null;
    }
}

// 命名空间挂载
window.game = window.game || {};
window.game.SlideRuleGame = SlideRuleGame;
