/**
 * SlideRule.js —— 算尺快滑组件（步骤06 / planning04 D4-B档）
 *
 * 每天第一次干活触发：Canvas 程序化绘制的计算尺（对数刻度=几何线条，零贴图），
 * 玩家拖动游标对齐红色目标刻线，松手校准 → 精度三档（完美/合格/失手）。
 * 完美档的进度加成由 UIManager.applySlideRuleBonus 落账（读 params.json
 * 的 slideRulePerfectBonus），本组件只做判定，不碰任务数据。
 *
 * 契约（UIManager 已接线，勿改签名）：
 *   new window.game.SlideRuleGame({ onFinish: (res) => {} })
 *   res = { precision: 'perfect'|'good'|'miss', offsetPx: number }
 *
 * 设计约束：
 * - 判定纯函数（同一落点必出同档），满足验收"稳定可复现"
 * - Pointer Events 统一 mouse/touch；整条尺即拖拽热区（≥44px）；
 *   touch-action:none 防微信 H5 页面滚动劫持
 * - 颜色/字体全部取自 tokens.css 变量 → 三模式自动换装
 * - 音效守卫调用 AudioManager.playSlideRuleClick（07 前静默降级）
 */
(function () {
    'use strict';

    /* 判定阈值：占内刻度宽的比例（触屏可完成的难度） */
    var PERFECT_RATIO = 0.012;   // ≈6px @500px
    var GOOD_RATIO = 0.032;      // ≈16px @500px
    var TAP_IGNORE_MS = 180;     // 误触快速点按不判定
    var TAP_IGNORE_PX = 6;
    var AUTO_JUDGE_MS = 12000;   // 迟迟不松手：按当前位置校准

    /** 纯函数判定（供测试）：dx=游标与目标距离px */
    function judgePrecision(dx, innerW) {
        if (dx <= Math.max(4, innerW * PERFECT_RATIO)) return 'perfect';
        if (dx <= innerW * GOOD_RATIO) return 'good';
        return 'miss';
    }

    /* ---------- 样式注入（一次） ---------- */
    var STYLE_ID = 'slide-rule-style';
    var CSS =
        '#' + STYLE_ID + '{position:fixed;inset:0;z-index:1500;display:flex;' +
        'align-items:center;justify-content:center;background:rgba(31,26,20,.55);' +
        'font-family:var(--font-song)}' +
        '.sr-card{position:relative;width:min(560px,92vw);border-radius:8px;' +
        'padding:18px 20px 14px;transform:rotate(var(--tilt-a))}' +
        '.sr-head{font-family:var(--font-kai);font-size:18px;letter-spacing:.35em;' +
        'color:var(--accent);text-align:center;border-bottom:1px solid var(--frame);' +
        'padding-bottom:8px;margin-bottom:6px}' +
        '.sr-target{font-family:var(--font-wenkai);color:var(--ink-pencil);' +
        'font-size:15px;letter-spacing:.15em;text-align:center;margin-bottom:2px;' +
        'transform:rotate(-1.2deg)}' +
        '.sr-canvas{display:block;width:100%;touch-action:none;cursor:ew-resize;' +
        'border-radius:4px}' +
        '.sr-hint{font-family:var(--font-fangsong);font-size:12.5px;color:var(--fg-faint);' +
        'text-align:center;letter-spacing:.2em;margin-top:6px}' +
        '.sr-result{position:absolute;left:50%;top:42%;transform:translate(-50%,-50%) ' +
        'rotate(-8deg) scale(1);opacity:0;pointer-events:none;font-size:30px;' +
        'letter-spacing:.2em;padding:8px 22px;white-space:nowrap;' +
        'transition:opacity .18s ease,transform .18s ease}' +
        '.sr-result.show{opacity:1;transform:translate(-50%,-50%) rotate(-8deg) scale(1.06)}' +
        '.sr-result.miss{border:none;filter:none;opacity:0;color:var(--ink-pencil);' +
        'font-family:var(--font-wenkai);font-size:26px;transform:translate(-50%,-50%) rotate(4deg)}' +
        '.sr-result.miss.show{opacity:.9;transform:translate(-50%,-50%) rotate(4deg) scale(1)}';

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = CSS;
        document.head.appendChild(s);
    }

    /* ---------- 令牌读取 ---------- */
    function tokens() {
        var cs = getComputedStyle(document.body);
        function v(name, fallback) {
            var val = cs.getPropertyValue(name).trim();
            return val || fallback;
        }
        return {
            paper: v('--paper-bright', '#f9f3e4'),
            ink: v('--ink', '#292420'),
            inkFaint: v('--ink-faint', '#857968'),
            red: v('--stamp-red', '#bf3528'),
            pencil: v('--ink-pencil', '#6b655c'),
            fangsong: v('--font-fangsong', '"FangSong",serif')
        };
    }

    /* ---------- 组件 ---------- */
    var _active = null; // 防重复实例

    function SlideRuleGame(opts) {
        opts = opts || {};
        this.onFinish = typeof opts.onFinish === 'function' ? opts.onFinish : function () {};
        this._done = false;

        if (_active) _active.destroy(); // 上一次未收尾则强制回收
        _active = this;

        injectStyle();
        this.t = tokens();
        this._build();
        this._draw();
    }

    SlideRuleGame.prototype._build = function () {
        var self = this;
        var doc = document;

        this.overlay = doc.createElement('div');
        this.overlay.id = STYLE_ID;
        this.overlay.innerHTML =
            '<div class="sr-card paper diegetic">' +
            '<div class="sr-head">校准计算尺</div>' +
            '<div class="sr-target"></div>' +
            '<canvas class="sr-canvas"></canvas>' +
            '<div class="sr-hint">拖动游标对齐红色刻线 · 松手校准</div>' +
            '<div class="sr-result stamp stamp--fresh"></div>' +
            '</div>';
        doc.body.appendChild(this.overlay);

        this.card = this.overlay.querySelector('.sr-card');
        this.targetLabel = this.overlay.querySelector('.sr-target');
        this.canvas = this.overlay.querySelector('canvas');
        this.resultEl = this.overlay.querySelector('.sr-result');

        /* 画布尺寸：DPR 适配 */
        var cssW = Math.min(520, doc.documentElement.clientWidth - 56);
        var cssH = 168;
        var dpr = Math.max(1, window.devicePixelRatio || 1);
        this.canvas.width = Math.round(cssW * dpr);
        this.canvas.height = Math.round(cssH * dpr);
        this.canvas.style.height = cssH + 'px';
        this.ctx = this.canvas.getContext('2d');
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.cssW = cssW;
        this.cssH = cssH;
        this.pad = 22;                    // 刻度左右内边距
        this.innerW = cssW - this.pad * 2;

        /* 目标：对数域均匀取值 1.2~9.8（几何线条上的随机落点） */
        var t = 0.079 + Math.random() * 0.912;          // log10(1.2)≈.079, log10(9.8)≈.991
        this.targetX = this.pad + t * this.innerW;
        this.targetV = Math.pow(10, t);
        this.targetLabel.textContent = '对齐 ' + this.targetV.toFixed(2);

        this.cursorX = this.pad + this.innerW * 0.5;    // 游标初始居中

        /* 指针交互（Pointer Events 统一鼠标/触摸） */
        this._dragging = false;
        this._downAt = 0;
        this._downX = 0;
        this._lastTickX = 0;
        this._autoTimer = setTimeout(function () { self._judge(); }, AUTO_JUDGE_MS);

        this.canvas.addEventListener('pointerdown', function (e) {
            if (self._done) return;
            self._dragging = true;
            self._downAt = Date.now();
            self._downX = e.clientX;
            self._lastTickX = self.cursorX;
            self.canvas.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        this.canvas.addEventListener('pointermove', function (e) {
            if (!self._dragging || self._done) return;
            var rect = self.canvas.getBoundingClientRect();
            var x = e.clientX - rect.left;
            self.cursorX = Math.max(self.pad, Math.min(self.pad + self.innerW, x));
            /* 咔哒声：每移动 26px 一响（守卫调用，07 前静默） */
            if (Math.abs(self.cursorX - self._lastTickX) > 26) {
                self._lastTickX = self.cursorX;
                try {
                    if (typeof audioManager !== 'undefined' && audioManager.playSlideRuleClick) {
                        audioManager.playSlideRuleClick(false);
                    }
                } catch (err) { /* 音频未就绪则静默 */ }
            }
            self._draw();
        });
        this.canvas.addEventListener('pointerup', function (e) {
            if (!self._dragging || self._done) return;
            self._dragging = false;
            var quickTap = (Date.now() - self._downAt < TAP_IGNORE_MS) &&
                (Math.abs(e.clientX - self._downX) < TAP_IGNORE_PX);
            if (quickTap) return;          // 误触：不判定，可继续拖
            self._judge();
        });
        this.canvas.addEventListener('pointercancel', function () {
            self._dragging = false;
        });
    };

    /* ---------- 渲染 ---------- */
    SlideRuleGame.prototype._draw = function () {
        var ctx = this.ctx, t = this.t;
        var W = this.cssW, H = this.cssH, pad = this.pad, innerW = this.innerW;
        ctx.clearRect(0, 0, W, H);

        /* 尺体 */
        ctx.fillStyle = t.paper;
        ctx.strokeStyle = t.inkFaint;
        ctx.lineWidth = 1;
        _roundRect(ctx, 2, 14, W - 4, H - 34, 5);
        ctx.fill();
        ctx.stroke();

        /* 上下刻度带基线 */
        var dTop = 30, dBot = 78;      // D 尺（上）
        var cTop = 92, cBot = 140;     // C 尺（下）
        ctx.strokeStyle = t.ink;
        ctx.beginPath();
        ctx.moveTo(pad, dBot); ctx.lineTo(pad + innerW, dBot);
        ctx.moveTo(pad, cTop); ctx.lineTo(pad + innerW, cTop);
        ctx.stroke();

        /* 对数刻度 ×2（D/C）：1-2 每.02、2-5 每.05、5-10 每.1（实尺疏密） */
        var segs = [
            { from: 1, to: 2, step: 0.02, med: 0.1 },
            { from: 2, to: 5, step: 0.05, med: 0.1 },
            { from: 5, to: 10, step: 0.1, med: 0.5 }
        ];
        var bands = [[dTop, dBot], [cTop, cBot]];
        for (var b = 0; b < 2; b++) {
            var sTop = bands[b][0], sBot = bands[b][1];
            ctx.strokeStyle = t.ink;
            for (var s = 0; s < segs.length; s++) {
                var seg = segs[s];
                for (var v = seg.from; v <= seg.to + 1e-9; v += seg.step) {
                    var x = pad + (Math.log(v) / Math.LN10) * innerW;
                    var isMajor = Math.abs(v - Math.round(v)) < 1e-9;
                    var isMed = Math.abs(v / seg.med - Math.round(v / seg.med)) < 1e-6;
                    var h = isMajor ? 14 : (isMed ? 8 : 4);
                    if (!isMajor && isMed && seg.step === 0.05) h = 8;
                    if (!isMajor && !isMed && v * 10 % 5 === 0 && seg.step === 0.02) h = 4;
                    ctx.beginPath();
                    ctx.moveTo(x, sBot);
                    ctx.lineTo(x, sBot - h);
                    ctx.lineWidth = isMajor ? 1.4 : (isMed ? 1 : 0.6);
                    ctx.stroke();
                }
            }
            /* 数字标注：主刻度 1..10 */
            ctx.fillStyle = t.ink;
            ctx.font = '11px ' + t.fangsong;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            for (var n = 1; n <= 10; n++) {
                var xn = pad + (Math.log(n) / Math.LN10) * innerW;
                ctx.fillText(String(n), xn, sBot - 28);
            }
        }

        /* 目标刻线（印泥红）贯穿两尺刻度带 + 铅笔小三角 */
        ctx.strokeStyle = t.red;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(this.targetX, 26);
        ctx.lineTo(this.targetX, cBot);
        ctx.stroke();
        ctx.fillStyle = t.red;
        ctx.beginPath();
        ctx.moveTo(this.targetX - 5, 16);
        ctx.lineTo(this.targetX + 5, 16);
        ctx.lineTo(this.targetX, 24);
        ctx.closePath();
        ctx.fill();

        /* 游标：玻璃框 + 墨线 + 上下指针 */
        var cx = this.cursorX;
        ctx.fillStyle = 'rgba(255,252,240,.22)';
        ctx.strokeStyle = t.ink;
        ctx.lineWidth = 1.4;
        ctx.fillRect(cx - 13, dTop - 4, 26, (cBot - dTop) + 12);
        ctx.strokeRect(cx - 13, dTop - 4, 26, (cBot - dTop) + 12);
        ctx.beginPath();
        ctx.moveTo(cx, dBot - 18); ctx.lineTo(cx, cTop + 18);
        ctx.lineWidth = 2;
        ctx.stroke();
        /* 捏持把手 */
        ctx.fillStyle = t.ink;
        ctx.beginPath();
        ctx.moveTo(cx - 9, H - 18); ctx.lineTo(cx + 9, H - 18);
        ctx.lineTo(cx, H - 26);
        ctx.closePath();
        ctx.fill();
    };

    function _roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    /* ---------- 判定与收尾 ---------- */
    SlideRuleGame.prototype._judge = function () {
        if (this._done) return;
        this._done = true;
        clearTimeout(this._autoTimer);

        var dx = Math.abs(this.cursorX - this.targetX);
        var precision = judgePrecision(dx, this.innerW);
        var t = this.t;
        var self = this;

        /* 结果章：完美=印泥红章 / 合格=淡章 / 失手=铅笔字 */
        if (precision === 'perfect') {
            this.resultEl.textContent = '完美校准';
            this.resultEl.classList.remove('miss');
        } else if (precision === 'good') {
            this.resultEl.textContent = '校准合格';
            this.resultEl.classList.remove('miss');
            this.resultEl.style.opacity = '';
            this.resultEl.classList.add('stamp--worn');
        } else {
            this.resultEl.textContent = '失手了';
            this.resultEl.classList.add('miss');
        }
        /* 强制重排以触发 transition */
        void this.resultEl.offsetWidth;
        this.resultEl.classList.add('show');

        /* 音效：完美双咔哒+图章咚 / 合格单咔哒 / 失手铅笔沙沙（守卫降级） */
        try {
            if (typeof audioManager !== 'undefined' && audioManager.playSlideRuleClick) {
                if (precision === 'perfect') {
                    audioManager.playSlideRuleClick(true);
                    if (audioManager.playStampThud) audioManager.playStampThud();
                } else if (precision === 'good') {
                    audioManager.playSlideRuleClick(false);
                } else if (audioManager.playPencilScratch) {
                    audioManager.playPencilScratch(0.3);
                }
            }
        } catch (err) { /* 静默 */ }

        setTimeout(function () {
            var onFinish = self.onFinish;
            self.destroy();
            onFinish({ precision: precision, offsetPx: Math.round(dx * 10) / 10 });
        }, 950);
    };

    SlideRuleGame.prototype.destroy = function () {
        clearTimeout(this._autoTimer);
        if (this.overlay && this.overlay.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
        this.overlay = this.canvas = this.ctx = null;
        if (_active === this) _active = null;
    };

    /* 静态暴露：单测用纯判定 */
    SlideRuleGame.judgePrecision = judgePrecision;

    window.game = window.game || {};
    window.game.SlideRuleGame = SlideRuleGame;
})();
