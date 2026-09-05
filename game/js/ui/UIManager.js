/**
 * UI管理器 - 处理所有UI更新和交互
 */
class UIManager {
    constructor(storyEngine, attributeManager, saveManager, audioManager, musicManager = null) {
        this.storyEngine = storyEngine;
        this.attributeManager = attributeManager;
        this.saveManager = saveManager;
        this.audioManager = audioManager;
        this.musicManager = musicManager;
        this.typeTimer = null;
        // 打字机两态：'typing' 进行中 / 'done' 已完毕
        this.typeState = 'idle';
        this.typeFullText = '';
        this.typeOnComplete = null;

        // 场景呼吸感：转场代币（重入保护）+ 场景键（场景戳判定）
        this._renderToken = 0;
        this._lastSceneKey = null;
        this._crisisBriefSeen = new Set();

        // 点击叙事区：进行中→立即补全；已完毕→尝试前进
        const storySection = document.getElementById('story-section');
        if (storySection) {
            storySection.addEventListener('click', () => this.onStoryClick());
        }

        // DOM元素引用
        this.elements = {
            currentDate: document.getElementById('current-date'),
            currentTime: document.getElementById('current-time'),
            currentLocation: document.getElementById('current-location'),
            sceneDescription: document.getElementById('scene-description'),
            narrativeText: document.getElementById('narrative-text'),
            choicesSection: document.getElementById('choices-section'),
            feedbackCard: document.getElementById('feedback-card'),
            
            // 属性条
            staminaBar: document.getElementById('stamina-bar'),
            staminaText: document.getElementById('stamina-text'),
            integrationBar: document.getElementById('integration-bar'),
            integrationText: document.getElementById('integration-text'),
            deviationBar: document.getElementById('deviation-bar'),
            deviationText: document.getElementById('deviation-text'),
            
            // NPC关系
            npcRelations: document.getElementById('npc-relations'),
            
            // 控制按钮
            saveBtn: document.getElementById('save-btn'),
            loadBtn: document.getElementById('load-btn'),
            menuBtn: document.getElementById('menu-btn'),
            muteBtn: document.getElementById('mute-btn'),
            
            // 模态框
            saveModal: document.getElementById('save-modal'),
            modalTitle: document.getElementById('modal-title'),
            modalClose: document.getElementById('modal-close'),
            startMenu: document.getElementById('start-menu'),
            newGameBtn: document.getElementById('new-game-btn'),
            continueGameBtn: document.getElementById('continue-game-btn')
        };
        
        this.bindEvents();
        this.ensureSceneVisual();
        this.updateNPCDisplay();
        this.ensureHandUI();
        this.ensurePacingUI();
    }

    /**
     * 场景视觉层：剧情只声明 visual key，素材可独立替换。
     * 现阶段复用 design/ref 中的历史参考图，后续 AI 图生成后只改这里。
     */
    ensureSceneVisual() {
        if (document.getElementById('scene-visual')) return;
        const style = document.createElement('style');
        style.id = 'scene-visual-style';
        style.textContent = `
#scene-visual{position:relative;min-height:220px;margin:0 0 24px;overflow:hidden;
  border:1px solid var(--frame);background:#191714;box-shadow:var(--shadow-paper);
  transition:background .25s ease,filter .25s ease}
#scene-visual img{display:block;width:100%;height:clamp(220px,30vh,340px);object-fit:cover;
  filter:sepia(.18) saturate(.72) contrast(1.05);opacity:.86;transition:opacity .45s ease,filter .25s ease}
#scene-visual::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(12,10,8,.04),rgba(12,10,8,.66));pointer-events:none}
#scene-visual .scene-visual-label{position:absolute;left:16px;bottom:14px;z-index:1;color:#f5ead8;
  font:14px/1.5 var(--font-fangsong);letter-spacing:.12em;text-shadow:0 1px 3px #000}
#scene-visual .scene-visual-label small{display:block;margin-top:3px;color:#d6c4a5;font-size:12px;letter-spacing:.06em}
#scene-visual.visual-notebook img{filter:sepia(.28) saturate(.62) contrast(1.08)}
#scene-visual.visual-engine img{filter:sepia(.12) saturate(.86) contrast(1.18)}
#scene-visual.visual-launch img{filter:sepia(.2) saturate(.62) contrast(1.2)}
#scene-visual.visual-danger img{filter:sepia(.1) saturate(1.2) contrast(1.28);opacity:.96}
/* 结局专属色调：同一场景图按收束情绪调色（只动场景图，正文保持可读） */
#scene-visual.visual-faded img{filter:grayscale(.68) contrast(.9) brightness(1.1);opacity:.72}
#scene-visual.visual-dawn img{filter:sepia(.16) saturate(1.15) contrast(1.08) brightness(1.07);opacity:.94}
#scene-visual.visual-dusk img{filter:sepia(.24) saturate(.6) contrast(1.02) brightness(.92);opacity:.8}
.demo-short-story #scene-visual{min-height:190px;margin-bottom:18px}
.demo-short-story #scene-visual img{height:clamp(190px,25vh,280px)}
@media (max-width:680px){#scene-visual{min-height:170px}#scene-visual img{height:220px}}
        `;
        document.head.appendChild(style);
        const visual = document.createElement('figure');
        visual.id = 'scene-visual';
        visual.innerHTML = '<img alt=""><figcaption class="scene-visual-label"></figcaption>';
        this.elements.storySection = document.getElementById('story-section');
        this.elements.storySection.insertBefore(visual, this.elements.storySection.firstChild);
        this.sceneVisual = visual;
    }

    updateSceneVisual(node) {
        if (!this.sceneVisual) return;
        const assets = {
            notebook: {
                src: UIManager.SCENE_SRC.notebook, fallback: 'design/ref/工作证正面.jpg', label: '未编号工作笔记', note: '校史馆修复记录 · 1958'
            },
            workshop: {
                src: UIManager.SCENE_SRC.workshop, fallback: 'design/ref/2a58bfffa449e3847d3ccad277edd333.jpg', label: '机身试制现场', note: '北京航空学院 · 试制车间'
            },
            workshopAlert: {
                src: UIManager.SCENE_SRC.workshopAlert, fallback: 'design/ref/2a58bfffa449e3847d3ccad277edd333.jpg', label: '工艺问题复核', note: '放样与铆接 · 风险显影'
            },
            engine: {
                src: UIManager.SCENE_SRC.engine, fallback: 'design/ref/2732850.jpg', label: '试车台记录', note: '发动机与测控工序'
            },
            assembly: {
                src: UIManager.SCENE_SRC.assembly, fallback: 'design/ref/40339879.jpg', label: '装配工段', note: '铆接、校准与返工'
            },
            launch: {
                src: UIManager.SCENE_SRC.launch, fallback: 'design/ref/56045334.jpg', label: '北京一号 · 首飞日', note: '跑道记录 · 1958年8月'
            },
            launchNight: {
                src: UIManager.SCENE_SRC.launchNight, fallback: 'design/ref/56045334.jpg', label: '首飞前夜', note: '测控线路 · 最后复核'
            }
        };
        let assetKey = node.visual;
        if (/^c1_(search|decide)$/.test(node.id) || /^c3_(search|decide)$/.test(node.id)) {
            assetKey = 'workshopAlert';
        } else if (node.id.startsWith('c4_')) {
            assetKey = 'launchNight';
        }
        const asset = assets[assetKey] || assets.workshop;
        this._visitedVisuals = this._visitedVisuals || new Set();
        this._visitedVisuals.add(assetKey);
        // 结局专属色调：同一张场景图用 CSS 滤镜区分四种收束情绪
        let endMod = '';
        if (/^demo_07_erased/.test(node.id)) endMod = ' visual-faded';
        else if (/^demo_07_best/.test(node.id)) endMod = ' visual-dawn';
        else if (/^demo_07_delay/.test(node.id)) endMod = ' visual-dusk';
        const image = this.sceneVisual.querySelector('img');
        image.alt = asset.label;
        image.onerror = () => {
            if (image.dataset.fallbackUsed !== '1' && asset.fallback) {
                image.dataset.fallbackUsed = '1';
                image.src = asset.fallback;
                return;
            }
            this.sceneVisual.classList.add('scene-visual-missing');
            image.style.display = 'none';
        };
        image.dataset.fallbackUsed = '0';
        image.style.display = 'block';
        // 换景交叉淡化：先隐后显，避免图片瞬间跳变
        image.style.opacity = '0';
        image.onload = () => { requestAnimationFrame(() => { image.style.opacity = ''; }); };
        image.src = asset.src;
        this.sceneVisual.className = `visual-${node.visual || 'workshop'}${endMod}`;
        this.sceneVisual.querySelector('.scene-visual-label').innerHTML =
            `${asset.label}<small>${asset.note}</small>`;
    }

    /**
     * 结局大印章：demo_07_* 收束节点在正文右上角盖一方章
     * 讫=提前首飞（青绿）／延·缓=延期（铅笔灰）／忘=被抹除（印泥红褪色）
     */
    renderEndStamp(node) {
        const sec = this.elements.storySection;
        if (!sec) return;
        sec.querySelector('.end-stamp')?.remove();
        const map = {
            demo_07_best:        { ch: '讫', cls: 'end-stamp--best',   label: '提前首飞 · 深藏功名' },
            demo_07_delay:       { ch: '延', cls: 'end-stamp--delay',  label: '首飞延期 · 问题留在地上' },
            demo_07_delay_grace: { ch: '缓', cls: 'end-stamp--delay',  label: '首飞延期 · 做得都对，只是太慢了' },
            demo_07_erased:      { ch: '忘', cls: 'end-stamp--erased', label: '被历史抹除' }
        };
        const m = map[node.id];
        if (!m) return;
        const el = document.createElement('div');
        el.className = `stamp stamp--rect end-stamp ${m.cls}`;
        el.textContent = m.ch;
        el.title = m.label;
        sec.appendChild(el);
    }

    /* ==================== 场景呼吸感：幕间卡 / 场景戳 / 转场节奏 ==================== */

    /**
     * 注入转场样式与幕间卡覆盖层（一次性，样式内联注入不依赖 css/ 目录）
     */
    ensurePacingUI() {
        if (document.getElementById('pacing-style')) return;

        const style = document.createElement('style');
        style.id = 'pacing-style';
        style.textContent = `
#narrative-text{transition:opacity .18s ease}
#narrative-text.scene-fade-out{opacity:0}

/* 场景戳：红色档案图章，跨场景时重重盖下 */
.scene-stamp{position:relative;margin:6px auto 20px;width:max-content;max-width:100%;
  color:#a4321f;border:2.5px solid currentColor;border-radius:6px;
  padding:9px 22px;text-align:center;
  opacity:0;transform:rotate(-2.5deg) scale(1.6);
  animation:stampHit .38s cubic-bezier(.2,1.4,.4,1) forwards}
.scene-stamp::before{content:'';position:absolute;inset:3px;
  border:1px solid currentColor;border-radius:3px;opacity:.55;pointer-events:none}
.scene-stamp .stamp-date{font-size:14px;font-weight:700;letter-spacing:.22em}
.scene-stamp .stamp-place{font-size:12px;letter-spacing:.3em;margin-top:3px;opacity:.9}
@keyframes stampHit{
  0%{opacity:0;transform:rotate(-2.5deg) scale(1.6)}
  62%{opacity:.95;transform:rotate(-2.5deg) scale(.96)}
  100%{opacity:.92;transform:rotate(-2.5deg) scale(1)}}

/* 幕间卡：老式日历翻页 + 红铅笔圈日期 */
#act-card-overlay{position:fixed;inset:0;z-index:2000;
  background:rgba(12,10,8,.94);display:flex;align-items:center;justify-content:center;
  perspective:900px;
  opacity:0;pointer-events:none;transition:opacity .3s ease}
#act-card-overlay.show{opacity:1;pointer-events:auto;cursor:pointer}
.cal-card{position:relative;width:min(320px,82vw);background:#f4efe4;color:#2b2620;
  box-shadow:0 18px 50px rgba(0,0,0,.6);transform-origin:top center;opacity:0}
.cal-card.cal-in{animation:calFlipIn .6s cubic-bezier(.2,.7,.3,1) forwards}
.cal-card.cal-out{animation:calFlipOut .3s ease-in forwards}
@keyframes calFlipIn{from{opacity:0;transform:rotateX(-78deg)}
  to{opacity:1;transform:rotateX(0)}}
@keyframes calFlipOut{from{opacity:1;transform:rotateX(0)}
  to{opacity:0;transform:rotateX(72deg)}}
.cal-topbar{background:#a4321f;color:#f4e9d8;text-align:center;padding:9px 0;
  font-size:14px;font-weight:700;letter-spacing:.5em;text-indent:.5em}
.cal-body{position:relative;padding:36px 20px 30px;text-align:center}
.cal-week{font-size:30px;font-weight:700;letter-spacing:.28em;text-indent:.28em}
.cal-range{margin-top:12px;font-size:13px;letter-spacing:.2em;color:#6b6152}
.cal-circle{position:absolute;left:50%;top:50%;width:86%;height:78%;
  transform:translate(-50%,-52%) rotate(-2deg);pointer-events:none;overflow:visible}
.cal-circle ellipse{fill:none;stroke:#a4321f;stroke-width:3.2;stroke-linecap:round;
  opacity:.85;stroke-dasharray:100;stroke-dashoffset:100}
.cal-circle.cal-circle-go ellipse{animation:circleDraw .7s ease-out forwards}
@keyframes circleDraw{to{stroke-dashoffset:0}}
.cal-hint{padding:0 0 18px;text-align:center;font-size:11px;
  letter-spacing:.4em;text-indent:.4em;color:#8a7f6c;
  animation:hintBlink 2.2s ease-in-out infinite}
@keyframes hintBlink{0%,100%{opacity:.35}50%{opacity:.9}}
`;
        document.head.appendChild(style);

        const overlay = document.createElement('div');
        overlay.id = 'act-card-overlay';
        overlay.innerHTML = `
<div class="cal-card">
  <div class="cal-topbar">一九五八年 · 七月</div>
  <div class="cal-body">
    <div class="cal-week"></div>
    <div class="cal-range"></div>
    <svg class="cal-circle" viewBox="0 0 220 96" preserveAspectRatio="none">
      <ellipse cx="110" cy="48" rx="100" ry="38" pathLength="100"/>
    </svg>
  </div>
  <div class="cal-hint">点击任意处继续</div>
</div>
`;
        document.body.appendChild(overlay);
    }

    static WEEKDAY_NAMES = {
        mon: '星期一', tue: '星期二', wed: '星期三', thu: '星期四',
        fri: '星期五', sat: '星期六', sun: '星期日'
    };

    /**
     * 幕间卡：老式日历翻页 + 红铅笔圈出本周日期范围，点击继续
     */
    showActCard(node, onContinue) {
        const loop = this.storyEngine.loopController;
        const week = Number(node.week) || (loop ? loop.state.week : 0);
        const cfg = loop ? loop.getWeekConfig(week) : null;
        const label = (cfg && cfg.label) ? cfg.label : `第 ${week} 周`;

        const overlay = document.getElementById('act-card-overlay');
        const card = overlay.querySelector('.cal-card');
        const circle = overlay.querySelector('.cal-circle');
        // 年代行跟随节点日期（长线 1958 年内各月、短篇混合年代都正确）
        const ym = /(\d+)年(\d+)月/.exec(node.date || '');
        overlay.querySelector('.cal-topbar').textContent = ym ? `${ym[1]}年 · ${ym[2]}月` : '一九五八年';
        overlay.querySelector('.cal-week').textContent = label;
        overlay.querySelector('.cal-range').textContent = this.weekRangeText(node.date);

        // 重置动画状态（二次进入也能重放）
        card.classList.remove('cal-in', 'cal-out');
        circle.classList.remove('cal-circle-go');
        void card.offsetWidth; // 强制 reflow 重启动画

        overlay.classList.add('show');
        card.classList.add('cal-in');
        if (this.audioManager) this.audioManager.playPaperFlip();

        // 日历落定后红铅笔圈日期
        setTimeout(() => {
            circle.classList.add('cal-circle-go');
            if (this.audioManager) this.audioManager.playPencilScratch(0.55);
        }, 620);

        const dismiss = () => {
            overlay.removeEventListener('click', dismiss);
            card.classList.remove('cal-in');
            card.classList.add('cal-out');
            if (this.audioManager) this.audioManager.playPaperFlip();
            setTimeout(() => {
                overlay.classList.remove('show');
                onContinue();
            }, 300);
        };
        // 稍作延迟再接受点击，避免上一节点的连点误关
        setTimeout(() => overlay.addEventListener('click', dismiss), 400);
    }

    /**
     * 周日期范围文本："1958年7月14日" → "7月14日 —— 7月20日"
     */
    weekRangeText(dateStr) {
        const m = /(\d+)月(\d+)日/.exec(dateStr || '');
        if (!m) return dateStr || '';
        const start = new Date(1958, Number(m[1]) - 1, Number(m[2]));
        const end = new Date(start.getTime() + 6 * 86400000);
        return `${m[1]}月${m[2]}日 —— ${end.getMonth() + 1}月${end.getDate()}日`;
    }

    /**
     * 场景戳：跨场景（日期/地点变化）时在正文前插入居中标记
     */
    showSceneStamp(node) {
        const old = document.getElementById('scene-stamp');
        if (old) old.remove();

        const parts = [];
        if (node.date) parts.push(node.date);
        const wd = node.day && UIManager.WEEKDAY_NAMES[node.day];
        const dateLine = parts.join('') + (wd ? ` · ${wd}` : '');
        const placeLine = [node.location, node.time].filter(Boolean).join(' · ');
        if (!dateLine && !placeLine) return;

        const stamp = document.createElement('div');
        stamp.id = 'scene-stamp';
        stamp.className = 'scene-stamp';
        stamp.innerHTML = `
${dateLine ? `<div class="stamp-date"><span>${dateLine}</span></div>` : ''}
${placeLine ? `<div class="stamp-place">${placeLine}</div>` : ''}
`;
        const narr = this.elements.narrativeText;
        narr.parentElement.insertBefore(stamp, narr);
        if (this.audioManager) this.audioManager.playStampThud();
    }

    /**
     * 打字机逐字延迟：标点自适应停顿（句末长停、句中短停、换行中停）
     */
    charDelay(ch, baseSpeed) {
        if ('。！？…'.indexOf(ch) !== -1) return 320;
        if ('，、；：,;'.indexOf(ch) !== -1) return 140;
        if (ch === '\n') return 220;
        return baseSpeed;
    }

    /* ==================== 预知手牌 HUD ==================== */

    /**
     * 注入手牌 HUD（样式内联注入，不依赖 css/ 目录）
     */
    ensureHandUI() {
        if (document.getElementById('hand-hud-style')) return;

        const style = document.createElement('style');
        style.id = 'hand-hud-style';
        style.textContent = `
#hand-hud{position:fixed;left:12px;bottom:12px;width:250px;z-index:900;
  font:13px/1.5 "Microsoft YaHei",sans-serif;display:none}
#hand-hud.has-cards{display:block}
#hand-hud .hud-header{display:flex;justify-content:space-between;align-items:center;
  background:#2a2320;color:#e8d5b0;padding:4px 10px;border-radius:6px 6px 0 0;
  border:1px solid #4a3f35;border-bottom:none;font-weight:600}
#hand-hud .witness-badge{color:#ffd700}
#hand-hud .hand-list{max-height:42vh;overflow:auto;background:#1e1a16ee;
  border:1px solid #4a3f35;border-radius:0 0 6px 6px;padding:6px}
.hand-card{background:#2a2420;border:1px solid #55483c;border-radius:5px;
  padding:6px 8px;margin-bottom:6px;color:#d9cdbb}
.hand-card .card-title{font-weight:600;color:#f0e3c8;margin-bottom:2px}
.hand-card .card-desc{font-size:11px;opacity:.75;margin-bottom:4px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.hand-card .card-window{font-size:10px;color:#8fae8f;margin-bottom:4px}
.hand-card .card-btns{display:flex;gap:5px}
.hand-card button{flex:1;font-size:12px;padding:2px 0;border-radius:3px;cursor:pointer;
  border:1px solid #6a5a45;background:#3a322a;color:#e8d5b0}
.hand-card button:hover:not(:disabled){background:#4a4034}
.hand-card button:disabled{opacity:.4;cursor:not-allowed}
.hand-card button.armed{background:#7a3020;border-color:#a04a30;color:#ffe8d0}
.hand-card .block-reason{font-size:10px;color:#c98;margin-top:3px}
`;
        document.head.appendChild(style);

        const hud = document.createElement('div');
        hud.id = 'hand-hud';
        hud.innerHTML = `
<div class="hud-header">
  <span>🔮 预知手牌 <span id="hand-count"></span></span>
  <span class="witness-badge" id="witness-badge" title="见证标记（封存不打，真结局计数）"></span>
</div>
<div class="hand-list" id="hand-list"></div>
`;
        document.body.appendChild(hud);
        this.handHud = hud;
    }

    /**
     * 周结算蒙太奇：消费 LoopController.lastSettleReport（一次性）
     */
    renderSettleReport() {
        const lc = this.storyEngine.loopController;
        if (!lc || !lc.lastSettleReport) return;
        const report = lc.lastSettleReport;
        lc.lastSettleReport = null; // 消费即焚，读档恢复不重放

        if (!report.items.length && !report.crisis.length) return;

        const wrap = document.createElement('div');
        wrap.className = 'settle-report';

        let html = '<div class="settle-title">📋 本周结算 · 第' + report.week + '周</div>';

        for (const it of report.items) {
            const okCls = it.result === 'success' ? 'ok' : 'miss';
            const mark = it.result === 'success' ? '✓ 验收通过' : (it.grace ? '△ 逾期·教学免罚' : '✗ 逾期');
            html += `<div class="settle-item ${okCls}">
                <span class="s-mark">${mark}</span>
                <span class="s-name">${it.title}</span>
                <span class="s-prog">${it.progress}/${it.target}</span>
                ${it.summary ? `<span class="s-fx">${it.summary}</span>` : ''}
            </div>`;
        }

        for (const c of report.crisis) {
            html += `<div class="settle-crisis">⚠ 修正危机启动：「${c.title}」逾期 —— 历史正在偏离（${c.flag}）</div>`;
        }

        if (report.autosave) {
            html += '<div class="settle-save">💾 已自动存档</div>';
        }

        wrap.innerHTML = html;

        // 注入样式（一次性）
        if (!document.getElementById('settle-report-style')) {
            const st = document.createElement('style');
            st.id = 'settle-report-style';
            st.textContent = `
.settle-report{background:#1e1a16;border:1px solid #4a3f35;border-radius:8px;
  padding:10px 12px;margin-bottom:10px;font-size:13px}
.settle-title{color:#f0e3c8;font-weight:700;margin-bottom:8px}
.settle-item{display:flex;gap:8px;align-items:baseline;padding:4px 6px;
  border-left:3px solid #555;border-radius:3px;margin-bottom:5px;background:#26211c}
.settle-item.ok{border-color:#7a9a5a}
.settle-item.miss{border-color:#b0563c}
.s-mark{font-weight:700;color:#9dbb7f;width:9.5em}
.settle-item.miss .s-mark{color:#d98a6e}
.s-name{color:#d9cdbb;flex:1}
.s-prog{color:#8fae8f}
.s-fx{color:#ffd28a;font-size:12px}
.settle-crisis{margin-top:8px;padding:8px 10px;border:1px solid #a03a2a;
  background:#3a1712;color:#ffb0a0;border-radius:5px;font-weight:600;
  animation:srPulse 1.2s ease-in-out infinite alternate}
@keyframes srPulse{from{box-shadow:0 0 0 rgba(200,60,40,0)}to{box-shadow:0 0 14px rgba(200,60,40,.55)}}
.settle-save{margin-top:8px;color:#8fae8f;font-size:12px;text-align:right}
`;
            document.head.appendChild(st);
        }

        this.elements.choicesSection.appendChild(wrap);
    }

    /**
     * 渲染手牌（节点切换/打出/封存后调用）
     */
    renderHand() {
        const cm = this.storyEngine && this.storyEngine.cardManager;
        if (!cm || !this.handHud) return;

        const hand = cm.state.hand;
        const registry = cm.registry;
        this.handHud.classList.toggle('has-cards', hand.length > 0);
        if (hand.length === 0) return;

        this.handHud.querySelector('#hand-count').textContent = `(${hand.length})`;
        this.handHud.querySelector('#witness-badge').textContent =
            cm.state.witness > 0 ? `★${cm.state.witness}` : '';

        // 当前是否处于可打窗口（周/日）
        const loop = this.storyEngine.loopController;
        const week = loop ? loop.state.week : null;
        const day = loop ? loop.state.day : null;

        const list = this.handHud.querySelector('#hand-list');
        list.innerHTML = '';

        for (const cardId of hand) {
            const card = registry[cardId] || { id: cardId, title: cardId, desc: '' };
            const item = document.createElement('div');
            item.className = 'hand-card';
            item.dataset.cardId = cardId;

            const win = card.window
                ? `⏳ 第${card.window.from ?? '?'}-${card.window.to ?? '?'}周` + (card.window.fromDay ? ` · 第${card.window.fromDay}-${card.window.toDay ?? '?'}天` : '')
                : '⏳ 无时限';
            const gate = cm.canPlay(cardId);

            item.innerHTML = `
<div class="card-title">${card.title}</div>
<div class="card-desc">${card.desc || ''}</div>
<div class="card-window">${win}${card.consumable === false ? ' · ♻ 可重复' : ''}</div>
<div class="card-btns">
  <button class="play-btn" ${gate.ok ? '' : 'disabled'}>打出</button>
  <button class="seal-btn">封存</button>
</div>
${gate.ok ? '' : `<div class="block-reason">${gate.reason}</div>`}
`;

            const playBtn = item.querySelector('.play-btn');
            playBtn.addEventListener('click', () => {
                // 二次确认防误触（消耗卡不可逆）
                if (!playBtn.dataset.armed) {
                    playBtn.dataset.armed = '1';
                    playBtn.classList.add('armed');
                    playBtn.textContent = '确认打出？';
                    setTimeout(() => {
                        if (playBtn.isConnected) {
                            playBtn.dataset.armed = '';
                            playBtn.classList.remove('armed');
                            playBtn.textContent = '打出';
                        }
                    }, 3000);
                    return;
                }
                this.onPlayCard(cardId);
            });

            item.querySelector('.seal-btn').addEventListener('click', () => this.onSealCard(cardId));

            list.appendChild(item);
        }
    }

    /**
     * 打出一张卡（双形态：重卡跳场景 / 轻卡即时结算）
     */
    onPlayCard(cardId) {
        const cm = this.storyEngine.cardManager;
        const r = cm.play(cardId);
        if (!r.ok) {
            this.showFeedback(`无法打出：${r.reason}`, []);
            this.renderHand();
            return;
        }
        const changes = [...r.attributeChanges, ...r.npcChanges];
        if (r.jumped) {
            // 重卡：已进入专属抉择节点
            this.showFeedback(`🔮 已打出「${r.card.title}」——干预的代价由你的选择决定`, changes);
            this.renderNode();
        } else {
            this.showFeedback(`🔮 「${r.card.title}」生效`, changes);
        }
        this.renderHand();
        this.updateAllAttributes();
    }

    /**
     * 封存一张卡（不干预历史 → 见证标记+1）
     */
    onSealCard(cardId) {
        const cm = this.storyEngine.cardManager;
        const card = cm.registry[cardId];
        const r = cm.seal(cardId);
        if (!r.ok) {
            this.showFeedback(`无法封存：${r.reason}`, []);
            return;
        }
        this.showFeedback(
            `📜 「${(card && card.title) || cardId}」已封存——历史将按史实发生（见证标记 ★${r.witness}）`,
            []
        );
        this.renderHand();
    }
    
    /**
     * 静音按钮图标（墨线喇叭 SVG，与纸质美术统一）
     */
    setMuteIcon(muted) {
        const btn = this.elements.muteBtn;
        if (!btn) return;
        const wave = muted ? '' :
            '<path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
        const slash = muted ? '<line x1="4" y1="20" x2="20" y2="4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' : '';
        btn.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" style="vertical-align:-3px">
            <path d="M3.5 9.5v5H7l4.5 3.8V5.7L7 9.5H3.5z" fill="currentColor"/>${wave}${slash}
        </svg>`;
        btn.title = muted ? '已静音' : '声音开启';
    }

    /**
     * 绑定事件
     */
    bindEvents() {
        // 控制按钮
        this.elements.saveBtn.addEventListener('click', () => this.showSaveModal(true));
        this.elements.loadBtn.addEventListener('click', () => this.showSaveModal(false));
        this.elements.modalClose.addEventListener('click', () => this.hideModal());
         this.elements.menuBtn.addEventListener('click', () => {
             if (document.body.classList.contains('demo-short-story')) {
                 location.reload();
             } else {
                 this.showStartMenu();
             }
         });

        // 静音开关（纸风 SVG 图标，替代 emoji）
        if (this.elements.muteBtn) {
            this.setMuteIcon(this.audioManager ? this.audioManager.muted : false);
            this.elements.muteBtn.addEventListener('click', () => {
                const muted = this.audioManager ? this.audioManager.toggleMute() : true;
                if (this.musicManager) this.musicManager.setMuted(muted);
                this.setMuteIcon(muted);
            });
        }

        // 键盘操作：数字键选选项/热区，空格/Enter 补全或继续（翻页笔/键盘演示）
        document.addEventListener('keydown', (e) => {
            if (e.repeat) return;
            if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
            // 弹层不抢：开始菜单、存档模态、算尺、启动通知
            const startMenu = this.elements.startMenu;
            if (startMenu && !startMenu.classList.contains('hidden')) return;
            if (document.querySelector('.modal:not(.hidden), .sr-card, #bootnotice-overlay, #prophecy-overlay, #crisis-brief-overlay, #intervention-confirm-overlay, #ending-film-overlay')) return;

            // 数字键 1-9：先普通选项，后解锁热区
            if (/^[1-9]$/.test(e.key)) {
                const idx = Number(e.key) - 1;
                const btns = [...this.elements.choicesSection
                    .querySelectorAll('.choice-btn:not(.continue-btn):not(:disabled)')];
                if (btns[idx]) { btns[idx].click(); return; }
                const hs = [...document.querySelectorAll('.hotspot:not(.locked)')];
                if (hs[idx]) { hs[idx].click(); }
                return;
            }
            // 空格 / Enter：补全打字 → 继续按钮 → 无选项正文推进
            if (e.key === ' ' || e.key === 'Enter') {
                if (document.activeElement && document.activeElement.tagName === 'BUTTON') return; // 让原生点击接管，防双触发
                e.preventDefault();
                if (this.typeState === 'typing') { this.finishTyping(); return; }
                const cont = this.elements.choicesSection.querySelector('.continue-btn:not(:disabled)');
                if (cont) { cont.click(); return; }
                if (this.typeState === 'done') this.onStoryClick();
            }
        });

        // 开始菜单
        this.elements.newGameBtn.addEventListener('click', () => {
            // 用户手势：激活音频并启动背景音
            if (this.audioManager) {
                this.audioManager.activate();
                this.audioManager.startBackground();
            }
            this.hideStartMenu();
            this.renderNode();
        });
        
        this.elements.continueGameBtn.addEventListener('click', () => {
            this.showSaveModal(false);
        });
        
        // 存档槽点击
        document.querySelectorAll('.save-slot').forEach(slot => {
            slot.addEventListener('click', (e) => {
                const slotId = parseInt(e.currentTarget.dataset.slot);
                this.handleSlotClick(slotId);
            });
        });
    }
    
    /**
     * 显示开始菜单
     */
    showStartMenu() {
        this.elements.startMenu.classList.remove('hidden');
        
        // 检查是否有存档
        const hasSave = this.saveManager.getAllSaves();
        if (Object.keys(hasSave).length === 0) {
            this.elements.continueGameBtn.disabled = true;
            this.elements.continueGameBtn.style.opacity = '0.5';
        }
    }
    
    /**
     * 隐藏开始菜单
     */
    hideStartMenu() {
        this.elements.startMenu.classList.add('hidden');
    }
    
    /**
     * 显示存档/读档模态框
     */
    showSaveModal(isSave) {
        this.isSaveMode = isSave;
        this.elements.modalTitle.textContent = isSave ? '存档' : '读档';
        this.elements.saveModal.classList.remove('hidden');
        this.updateSaveSlots();
    }
    
    /**
     * 隐藏模态框
     */
    hideModal() {
        this.elements.saveModal.classList.add('hidden');
        this.elements.startMenu.classList.add('hidden');
    }
    
    /**
     * 更新存档槽显示（含 auto 槽周目信息）
     */
    updateSaveSlots() {
        document.querySelectorAll('.save-slot').forEach(slot => {
            const raw = slot.dataset.slot;
            const slotId = raw === 'auto' ? 'auto' : parseInt(raw);
            const summary = this.saveManager.getSaveSummary(slotId);
            const infoEl = slot.querySelector('.slot-info');

            if (summary) {
                const weekInfo = summary.week ? `第${summary.week}周 · ` : '';
                infoEl.innerHTML = `
                    <div>${weekInfo}${summary.gameDate} ${summary.location}</div>
                    <div class="text-muted">${summary.date}</div>
                `;
            } else {
                infoEl.textContent = '空';
            }
        });
    }
    
    /**
     * 处理存档槽点击（槽位：1-3 手动 / auto 自动）
     */
    handleSlotClick(slotId) {
        // 归一化：'auto' 字符串或数字
        const slot = slotId === 'auto' ? 'auto' : parseInt(slotId);
        if (this.isSaveMode) {
            if (slot === this.saveManager.autoSlot) {
                this.showFeedback('自动存档由周结算写入，不可手动覆盖', []);
                return;
            }
            // 存档
            const state = this.storyEngine.getState();
            if (this.saveManager.saveGame(slot, state)) {
                this.showFeedback('存档成功', []);
                this.hideModal();
            }
        } else {
            // 读档
            const state = this.saveManager.loadGame(slot);
            if (state) {
                // 用户手势：激活音频并启动背景音
                if (this.audioManager) {
                    this.audioManager.activate();
                    this.audioManager.startBackground();
                }
                this.storyEngine.loadState(state);
                this.renderNode();
                this.updateAllAttributes();
                this.hideModal();
                this.hideStartMenu();
            }
        }
    }

    /**
     * 渲染当前节点（含转场呼吸：淡出 → 幕间卡/场景戳 → 打字）
     */
    renderNode() {
        const node = this.storyEngine.getCurrentNode();
        if (!node) {
            console.error('无法获取当前节点');
            return;
        }
        this.applyVisualMode(node);
        const token = ++this._renderToken;
        const narr = this.elements.narrativeText;

        const proceed = () => {
            if (token !== this._renderToken) return; // 已被更新的渲染取代
            if (document.body.classList.contains('demo-short-story')
                && UIManager.CRISIS_BRIEFS[node.id]
                && !this._crisisBriefSeen.has(node.id)) {
                this._crisisBriefSeen.add(node.id);
                this.showCrisisBrief(node, () => {
                    if (token === this._renderToken) this.renderNodeInner(node, token);
                });
            } else if (node.phase === 'WEEK_START') {
                this.showActCard(node, () => {
                    if (token === this._renderToken) this.renderNodeInner(node, token);
                });
            } else {
                this.renderNodeInner(node, token);
            }
        };

        // 旧文淡出一拍再清场（首节点无旧文，直落）
        if (narr.textContent) {
            narr.classList.add('scene-fade-out');
            setTimeout(() => {
                if (token !== this._renderToken) return;
                narr.classList.remove('scene-fade-out');
                proceed();
            }, 180);
        } else {
            proceed();
        }
    }

    /**
     * renderNode 第二段：场景戳判定 + 元数据 + 打字机 + 选项回调
     */
    renderNodeInner(node, token) {
        document.querySelectorAll('.hotspot-layer, .flight-report').forEach(el => el.remove()); // 换节点先清残留热区/结算单
        if (document.body.classList.contains('demo-short-story') && node.id === 'c3_question' && !this._badgeShown) {
            this._badgeShown = true;
            this.showPropCard('assets/props/work-badge.jpg', '你的工作证 —— 季文盯了很久的那一本');   // 盘问：工作证证据卡
        }
        if (document.body.classList.contains('demo-short-story') && node.id === 'demo_07_best' && !this._takeoffShown) {
            this._takeoffShown = true;
            this.showEndingFilm('assets/video/ending-takeoff.mp4');   // 最佳结局：起飞影片（可灵3.0 生成）
        }
        if (this.musicManager) this.musicManager.setNode(node);
        if (this.audioManager && document.body.classList.contains('demo-short-story')) {
            // 环境床分区制：现代/结算/结局 = 静（音乐层接管），
            // 试车台与测控(c2/c4) = 夜班床，其余游戏段 = 车间日床
            const isModern = node.id === 'demo_00_start'
                || node.id === 'demo_08_end'
                || node.id === 'demo_09_end';
            const isEnding = node.id === 'demo_06_settle' || node.id.startsWith('demo_07_');
            let zone = 'day';
            if (node.visual === 'engine' && !node.id.startsWith('c4_')) zone = 'testcell';
            else if (node.id.startsWith('c4_')) zone = 'airfield';
            if (isEnding) zone = null;
            else if (isModern) zone = 'archive';
            this.audioManager.setBed(zone);
            if (node.type === 'card_portal' && node.id === 'demo_00_start') {
                this.audioManager.playBlueprintUnroll(1.15);
            } else if (node.type === 'settle') {
                this.audioManager.playSettleBell();
            } else if (/^c[1-4]_open$/.test(node.id)) {
                this.audioManager.playPaperFlip();
            }
        }
        this.updateSceneVisual(node);
        this.renderEndStamp(node);
        if (node.type === 'card_portal' && this.audioManager) {
            this.audioManager.playBlueprintUnroll();
        }
        // 场景键：日期+地点变化 → 盖场景戳
        const sceneKey = `${node.date || ''}|${node.location || ''}`;
        const sceneChanged = sceneKey !== this._lastSceneKey;
        this._lastSceneKey = sceneKey;

        const startTyping = () => {
            if (token !== this._renderToken) return;

            // 更新元数据显示
            this.elements.currentDate.textContent = this.storyEngine.currentDate;
            this.elements.currentTime.textContent = this.storyEngine.currentTime;
            this.elements.currentLocation.textContent = this.storyEngine.currentLocation;

            // 更新场景描述
            if (node.description) {
                this.elements.sceneDescription.textContent = node.description;
                this.elements.sceneDescription.style.display = 'block';
            } else {
                this.elements.sceneDescription.style.display = 'none';
            }

            // 清空选项区（选项在打字完毕后渲染）
            this.elements.choicesSection.innerHTML = '';

            // 渲染叙事文本（打字机效果）；选项在打字完毕后显示
            this.typewriterEffect(node.narrative, 30, node.speaker || 'narrator', () => {
                // 周结算蒙太奇（在选项之前插入）
                if (node.type === 'settle' && document.body.classList.contains('demo-short-story')) {
                    this.renderFlightReport(node);   // 首飞验收单
                }
                if (node.phase === 'WEEK_SETTLE') {
                    this.renderSettleReport();
                }
                if (!node.choices || node.choices.length === 0) {
                    this.renderEnding(node);
                } else if (UIManager.SEARCH_HOTSPOTS[node.id]) {
                    this.renderHotspots(node);          // 调查阶段：在画面里找证据
                } else {
                    this.renderChoices(node.choices);
                }
            });

            // 幕间自动存档（demo）：每幕开场与结算前静默写 auto 槽，误刷新可从「继续记录」恢复
            if (document.body.classList.contains('demo-short-story')
                && this.saveManager
                && /^(c[1-4]_open|demo_06_settle)$/.test(node.id)) {
                try { this.saveManager.saveGame('auto', this.storyEngine.getState()); } catch (e) {}
            }

            // 更新属性显示
            this.updateAllAttributes();

            // 刷新手牌 HUD（窗口状态随周/日变化）
            this.renderHand();
        };

        if (sceneChanged) {
            this.showSceneStamp(node);
             setTimeout(startTyping,
                 document.body.classList.contains('demo-short-story') ? 140 : 700);
        } else {
            const old = document.getElementById('scene-stamp');
            if (old) old.remove();
            startTyping();
        }
    }

    /**
     * 点击叙事区：两态区分
     * - 'typing'：立即补完全文
     * - 'done'：仅当节点无选项且声明了 autoNext/nextNode 时前进
     */
    onStoryClick() {
        if (this.typeState === 'typing') {
            this.finishTyping();
            return;
        }
        if (this.typeState === 'done') {
            const node = this.storyEngine.getCurrentNode();
            if (node && (!node.choices || node.choices.length === 0)) {
                const next = node.autoNext || node.nextNode;
                if (next) {
                    if (this.storyEngine.goToNode(next)) {
                        this.renderNode();
                    } else {
                        this.showFeedback(`节点 ${next} 不存在或被循环规则阻止`, []);
                    }
                }
            }
        }
    }

    /**
     * 立即补全打字机文本
     */
    finishTyping() {
        if (this.typeTimer) {
            clearTimeout(this.typeTimer);
            this.typeTimer = null;
        }
        if (this.typeState !== 'typing') return;

        this.elements.narrativeText.textContent = this.typeFullText;
        this.typeState = 'done';
        const cb = this.typeOnComplete;
        this.typeOnComplete = null;
        if (cb) cb();
    }

    /**
     * 打字机效果
     * @param {string} text 文本
     * @param {number} speed 每字间隔ms
     * @param {string} speaker 当前节点说话人（用于引号内人物发声音高）
     * @param {Function} onComplete 打字完毕（或被点击补全）后的回调（用于渲染选项）
     */
    typewriterEffect(text, speed = 30, speaker = 'narrator', onComplete = null) {
        const container = this.elements.narrativeText;
        container.textContent = '';

        // 中断上一次未完成的打字
        if (this.typeTimer) {
            clearTimeout(this.typeTimer);
            this.typeTimer = null;
        }

        this.typeFullText = text || '';
        this.typeOnComplete = onComplete;
        this.typeState = text ? 'typing' : 'done';
        if (!text) {
            const cb = this.typeOnComplete;
            this.typeOnComplete = null;
            if (cb) cb();
            return;
        }

        // 引号（中英文）判定：进入引号内视为"人物说话"
        const openQuotes = '"「『';
        const closeQuotes = '"」』';
        let inQuote = false;

        let index = 0;
        const type = () => {
            if (index < text.length) {
                const ch = text.charAt(index);
                container.textContent += ch;

                if (openQuotes.indexOf(ch) !== -1) {
                    inQuote = true;
                } else if (closeQuotes.indexOf(ch) !== -1) {
                    inQuote = false;
                }

                this.playCharSound(ch, inQuote, speaker);

                index++;
                // 标点自适应停顿：句末长停、句中短停，营造讲述节奏
                this.typeTimer = setTimeout(type, this.charDelay(ch, speed));
            } else {
                this.typeTimer = null;
                this.typeState = 'done';
                const cb = this.typeOnComplete;
                this.typeOnComplete = null;
                if (cb) cb();
            }
        };

        type();
    }

    /**
     * 根据字符与上下文播放音效
     * - 引号内的可见字符：人物发声 blip
     * - 引号外的可见字符：打字机 click
     * - 标点/空白：不发声
     */
    playCharSound(ch, inQuote, speaker) {
        if (!this.audioManager) return;
        // 跳过空白与常见标点，避免噪音过密
        if (/[\s，。！？、；：,.!?;:…—\-()（）\n"「」『』""]/.test(ch)) return;

        if (inQuote) {
            this.audioManager.playBlip(speaker);
        } else {
            this.audioManager.playType();
        }
    }

    /**
     * 渲染选项（含 D1 分场景显隐）
     * - 资源门槛（res/card）→ 置灰 + 一行原因
     * - 叙事门槛（flag/npc/week/day）→ 直接隐藏
     */
    /**
     * 双模式视觉切换（05 D1：每个视觉模式绑定一个机制）
     * - card_portal 节点 → mode-blueprint（预知=蓝晒图纸）
     * - WEEK_SETTLE/settle → mode-redbullet（周结算=捷报红黑套印）
     * - 其余 → mode-archive（日常档案卷宗）
     */
    applyVisualMode(node) {
        const body = document.body;
        let mode = 'mode-archive';
        if (node.type === 'card_portal' || String(node.id || '').startsWith('card_')) {
            mode = 'mode-blueprint';
        } else if (node.type === 'settle' || node.phase === 'WEEK_SETTLE') {
            mode = 'mode-redbullet';
        }
        body.classList.remove('mode-archive', 'mode-blueprint', 'mode-redbullet');
        body.classList.add(mode);
    }

    /**
     * 修正征兆·视觉档（05 D1 预留）：偏离度≥警告阈值时主纸页泛黄加剧
     */
    applyDecayAging(deviationValue) {
        const main = document.getElementById('game-main');
        if (!main) return;
        const lc = this.storyEngine && this.storyEngine.loopController;
        let th = lc && lc.config && lc.config.gameParams && lc.config.gameParams.deviation
            ? lc.config.gameParams.deviation.thresholds.warning : 3;
        // 短篇 demo 的偏离量程是 0-4（抹除阈值 3），泛黄与临界警告同步从 2 开始
        if (document.body.classList.contains('demo-short-story')) th = 2;
        main.classList.toggle('paper--aged', Number(deviationValue) >= Number(th));
    }

    static PROPHECY = {
        c1_open: '今天午后，第一批机身铝板会因尺寸错误全部报废。',
        c2_open: '查回油，不要查进油。',
        c3_open: '别只看板，看看递工具的人。',
        c4_open: '备用线在旧器材库东架第三层。'
    };

    static CRISIS_BRIEFS = {
        c1_open: { act: '危机 1 / 4', title: '机身放样', prophecy: '今天午后，第一批机身铝板会因尺寸错误全部报废。' },
        c2_open: { act: '危机 2 / 4', title: '发动机试车', prophecy: '查回油，不要查进油。' },
        c3_gate: { act: '危机 3 / 4', title: '蒙皮铆接', prophecy: '别只看板，看看递工具的人。' },
        c4_open: { act: '危机 4 / 4', title: '测控电缆', prophecy: '备用线在旧器材库东架第三层。' }
    };

    static SCENE_SRC = {
        "notebook": "assets/scenes/notebook.jpg",
        "workshop": "assets/scenes/workshop.jpg",
        "workshopAlert": "assets/scenes/workshop-alert.jpg",
        "engine": "assets/scenes/engine.jpg",
        "assembly": "assets/scenes/assembly.jpg",
        "launch": "assets/scenes/launch.jpg",
        "launchNight": "assets/scenes/launch-night.jpg"
    }

    /**
     * 调查阶段热区表：把"读选项"变成"在画面里找证据"。
     * 坐标为场景图容器百分比；condition 不过的热区显示为锁定，
     * 点击给信任提示；命中即走原 handleChoice（效果/旗标/跳转零改动）。
     */
    static SEARCH_HOTSPOTS = {
        c1_search: [
            { choiceId: 'c1_find_overlay',  label: '桌上的旧晒图', x: 50, y: 26, w: 28, h: 36 },
            { choiceId: 'c1_trace_chalk',   label: '地上的粉线',   x: 6,  y: 56, w: 32, h: 32, lockHint: '粉线在别人脚下——你得先取得小牛的信任，才有人替你拦住来往的人。' },
            { choiceId: 'c1_read_notebook', label: '怀里的笔记本', x: 74, y: 62, w: 22, h: 30 }
        ],
        c2_search: [
            { choiceId: 'c2_compare_log', label: '仪表盘与停机记录', x: 72, y: 14, w: 26, h: 42 },
            { choiceId: 'c2_ask_niu',     label: '回油管弯头',       x: 20, y: 40, w: 28, h: 36, lockHint: '弯头烫手，接油要人搭手——小牛还没信过你。' },
            { choiceId: 'c2_touch_pipe',  label: '怀里的笔记本',     x: 3,  y: 62, w: 22, h: 30 }
        ],
        c3_search: [
            { choiceId: 'c3_check_gauge',  label: '工具台上的定位规', x: 60, y: 58, w: 32, h: 34 },
            { choiceId: 'c3_ask_xiaolin',  label: '铆接的工位',       x: 36, y: 26, w: 30, h: 42, lockHint: '小林不会让生人碰工序——让小牛陪你去才说得通。' },
            { choiceId: 'c3_read_solution',label: '怀里的笔记本',     x: 5,  y: 60, w: 22, h: 30 }
        ],
        c4_search: [
            { choiceId: 'c4_call_team',      label: '蹲着接线的人', x: 10, y: 50, w: 26, h: 36, lockHint: '你叫不动他们——小牛和小林都得先信你。' },
            { choiceId: 'c4_ask_fang',       label: '测试准备室',   x: 1,  y: 16, w: 20, h: 44, lockHint: '库房钥匙在方岩手里——第一、二幕得有人替你说过话。' },
            { choiceId: 'c4_use_old_cable',  label: '电缆木盘',     x: 32, y: 62, w: 28, h: 32 },
            { choiceId: 'c4_follow_notebook',label: '机翼下的暗处', x: 58, y: 22, w: 32, h: 42 }
        ]
    };

    /**
     * 渲染调查热区：线索按钮叠在场景图上，命中即原路结算
     */
    renderHotspots(node) {
        const defs = UIManager.SEARCH_HOTSPOTS[node.id] || [];
        const sec = this.elements.choicesSection;
        sec.innerHTML = '';
        const hint = document.createElement('div');
        hint.className = 'hotspot-hint';
        hint.textContent = '依据就在眼前 —— 点开画面里的它';
        sec.appendChild(hint);
        const layer = document.createElement('div');
        layer.className = 'hotspot-layer';
        const firstTime = !this._hotspotSeen;   // 首次调查：热区脉动引导
        this._hotspotSeen = true;
        if (firstTime) layer.classList.add('first-time');
        const evaluator = window.game && window.game.evalCondition;
        const snap = this.storyEngine.getSnapshot();
        for (const def of defs) {
            const index = node.choices.findIndex(c => c.id === def.choiceId);
            if (index < 0) continue;
            const choice = node.choices[index];
            const ok = !choice.condition || evaluator(choice.condition, snap);
            const btn = document.createElement('button');
            btn.type = 'button';
            const highIntervention = this.isHighInterventionChoice(choice);
            btn.className = 'hotspot' + (ok ? '' : ' locked') + (highIntervention ? ' high-intervention' : '');
            btn.style.left = def.x + '%';
            btn.style.top = def.y + '%';
            btn.style.width = def.w + '%';
            btn.style.height = def.h + '%';
            const label = document.createElement('span');
            label.className = 'hotspot-label';
            label.textContent = (ok ? '🔎 ' : '🔒 ') + (highIntervention ? '高干预 · ' : '') + def.label;
            btn.appendChild(label);
            btn.addEventListener('click', () => {
                if (layer.classList.contains('spent')) return;
                if (!ok) {
                    this.showFeedback(def.lockHint || '你还没有取得这条线索需要的信任。', []);
                    return;
                }
                this.handleChoice(index, choice);
            });
            layer.appendChild(btn);
        }
        this.sceneVisual.appendChild(layer);
    }

    renderChoices(choices) {
        if (!choices || choices.length === 0) {
            return;
        }

        const evaluator = window.game && window.game.evalCondition;
        const snapshot = this.storyEngine.getSnapshot();
        const loop = this.storyEngine.loopController;

        const visible = [];
        for (const choice of choices) {
            // 行动点置灰（白天行动默认耗1AP）
            let apBlock = false;
            if (loop && loop.state.phase === 'DAY_ACTION') {
                const cost = choice.costAP !== undefined ? choice.costAP : 1;
                if (cost > loop.state.ap) apBlock = true;
            }

            if (!choice.condition || !evaluator) {
                visible.push({ choice, disabled: apBlock, reason: apBlock ? '行动点不足' : '' });
                continue;
            }
            if (evaluator.call(window.game.ConditionEvaluator, choice.condition, snapshot)) {
                visible.push({ choice, disabled: apBlock, reason: apBlock ? '行动点不足' : '' });
                continue;
            }
            if (choice.hideWhenBlocked) continue;
            const kind = window.game.ConditionEvaluator.classify(choice.condition);
            if (kind === 'narrative') continue; // 隐藏
            const reason = window.game.ConditionEvaluator.describeBlockReason(choice.condition, snapshot);
            visible.push({ choice, disabled: true, reason: reason || '条件未满足' });
        }

        visible.forEach(({ choice, disabled, reason }, i) => {
            const btn = document.createElement('button');
            const highIntervention = this.isHighInterventionChoice(choice);
            btn.className = 'choice-btn' + (highIntervention ? ' high-intervention' : '');
            // 代价显影（02 哲学：看得见的墙才是真墙）——正常态也渲染
            const costLine = choice.costHint
                ? `<span style="display:block;font-size:0.85em;opacity:0.8;">${choice.costHint}</span>`
                : '';
            const blockLine = disabled ? `<span style="display:block;font-size:0.85em;opacity:0.85;">（${reason}）</span>` : '';
            const riskTag = highIntervention ? '<span class="intervention-tag">高干预</span>' : '';
            btn.innerHTML = `${riskTag}${choice.text}${costLine}${blockLine}`;
            if (disabled) {
                btn.disabled = true;
                btn.style.opacity = '0.45';
                btn.style.cursor = 'not-allowed';
            } else {
                const index = choices.indexOf(choice);
                btn.addEventListener('click', () => this.handleChoice(index, choice));
            }
            this.elements.choicesSection.appendChild(btn);
        });

        // 全灰死锁兜底：DAY_ACTION 下 AP 耗尽且没有任何可点选项时，
        // 提供"收工"推进，绝不把玩家关在节点里
        if (loop && loop.state.phase === 'DAY_ACTION' && visible.length > 0) {
            const anyEnabled = visible.some(v => !v.disabled);
            const allApBlocked = visible.every(v => v.disabled && v.reason === '行动点不足');
            if (!anyEnabled && allApBlocked) {
                const btn = document.createElement('button');
                btn.className = 'choice-btn';
                btn.innerHTML = '今天的力气使完了——收工，明天再来<span style="display:block;font-size:0.85em;opacity:0.85;">（推进到下一天）</span>';
                btn.addEventListener('click', () => this.dayAdvanceFallback());
                this.elements.choicesSection.appendChild(btn);
            }
        }
    }

    /**
     * 收工兜底：推进循环到下一天/周结算，并导航到次日 DAY_START 节点。
     * 查找顺序：命名约定 → 全节点扫描（phase=DAY_START 且 week/day 匹配）。
     */
    dayAdvanceFallback() {
        const loop = this.storyEngine.loopController;
        const events = loop.forceDayAdvance();
        const week = loop.state.week;
        const day = loop.state.day;
        const cfg = loop.getWeekConfig(week);
        const dayName = cfg.dayNames && cfg.dayNames.length ? cfg.dayNames[day - 1] : null;

        const nodes = this.storyEngine.nodes || {};
        const candidates = [];
        if (dayName) {
            candidates.push(`n_${week}${dayName}_010_daystart`);
            candidates.push(`n_${week}_${dayName}_daystart`);
        }
        let target = candidates.find(id => nodes[id]);
        if (!target) {
            for (const [id, node] of Object.entries(nodes)) {
                const declared = loop.resolvePhase ? loop.resolvePhase(node, id) : node.phase;
                if (declared === 'DAY_START' && Number(node.week) === Number(week)) {
                    const nodeDay = typeof node.day === 'number' ? node.day : (cfg.days ? cfg.days.indexOf(node.day) + 1 : day);
                    if (Number(nodeDay) === Number(day)) { target = id; break; }
                }
            }
        }

        if (target && this.storyEngine.goToNode(target)) {
            this.renderNode();
        } else {
            console.warn('[UIManager] 收工兜底未找到次日节点，停留在当前节点（循环状态已推进）');
        }
        return events;
    }


    /**
     * 结局旅程回顾：本局到访过的场景缩图条（demo）
     */
    appendJourneyStrip(wrap) {
        if (!document.body.classList.contains('demo-short-story')) return;
        if (!this._visitedVisuals || this._visitedVisuals.size < 2) return;
        const order = ['notebook', 'workshop', 'workshopAlert', 'engine', 'assembly', 'launchNight', 'launch'];
        const hit = order.filter(k => this._visitedVisuals.has(k));
        if (hit.length < 2) return;
        const strip = document.createElement('div');
        strip.className = 'journey-strip';
        strip.innerHTML = '<div class="journey-title">· 这 一 程 ·</div>';
        const row = document.createElement('div');
        row.className = 'journey-row';
        hit.forEach(k => {
            const img = document.createElement('img');
            img.src = UIManager.SCENE_SRC[k];
            img.alt = k;
            row.appendChild(img);
        });
        strip.appendChild(row);
        wrap.appendChild(strip);
    }

    /**
     * 人物态度名牌（demo）：旗标驱动，让跨幕信任/怀疑可见
     */
    updateNpcChips() {
        const container = this.elements.npcRelations;
        if (!container) return;
        const f = this.attributeManager.flags;
        const defs = [
            { name: '小牛', state: f.trust_niu ? ['信任', 'good'] : (f.claimed_inspector ? ['戒备', 'warn'] : ['生疏', 'faint']) },
            { name: '赵师傅', state: f.support_zhao ? ['支持', 'good'] : ['观望', 'faint'] },
            { name: '季文', state: f.trust_jiwen ? ['认可', 'good'] : (f.under_watch ? ['看管', 'bad'] : (f.suspicion_jiwen ? ['疑心', 'bad'] : (f.jiwen_saw_notebook ? ['知情', 'bad'] : (f.jiwen_checked ? ['核验', 'mid'] : ['审视', 'faint'])))) },
            { name: '方岩', state: f.trust_fang ? ['认可', 'good'] : ['公事', 'faint'] },
            { name: '小林', state: f.trust_xiaolin ? ['信任', 'good'] : ['怯生', 'faint'] }
        ];
        this._npcPrev = this._npcPrev || {};
        container.innerHTML = '';
        for (const d of defs) {
            const [label, tone] = d.state;
            const changed = this._npcPrev[d.name] !== undefined && this._npcPrev[d.name] !== label;
            this._npcPrev[d.name] = label;
            const item = document.createElement('div');
            item.className = 'npc-chip' + (changed ? ' npc-chip--changed' : '');
            item.innerHTML = `<span class="npc-chip-name">${d.name}</span><span class="npc-chip-state tone-${tone}">${label}</span>`;
            container.appendChild(item);
        }
    }

    /**
     * 首飞验收单（demo settle）：四幕结果 + 工艺遗留 + 三轴数字，盖「验」章
     */
    renderFlightReport(node) {
        const sec = this.elements.storySection;
        sec.querySelector('.flight-report')?.remove();
        const f = this.attributeManager.flags;
        const a = this.attributeManager.attributes;
        const acts = [
            ['第一幕', '机身放样', f.crisis_1_done, f.crisis_1_missed],
            ['第二幕', '发动机试车', f.crisis_2_done, f.crisis_2_missed],
            ['第三幕', '蒙皮铆接', f.crisis_3_done, f.crisis_3_missed],
            ['第四幕', '测控电缆', f.crisis_4_done, f.crisis_4_missed]
        ];
        const rows = acts.map(([ord, name, done, missed]) => {
            if (done) return `<div class="fr-row ok">✓ ${ord} · ${name} —— 验收通过</div>`;
            if (missed) return `<div class="fr-row miss">✗ ${ord} · ${name} —— 逾期返工</div>`;
            return `<div class="fr-row">○ ${ord} · ${name} —— 未经手</div>`;
        });
        const flaws = [];
        if (f.hidden_flaw) flaws.push('垫片隐患未除');
        if (f.old_cable) flaws.push('旧测试线未换');
        const decisions = [
            f.c1_overlay ? '第一幕：用旧晒图复核尺寸' : f.c1_chalk ? '第一幕：与小牛重拉基准线' : f.c1_exact ? '第一幕：采用笔记本中的数字' : '第一幕：等待完整图纸',
            f.c2_pressure ? '第二幕：用三轮数据申请停机' : f.c2_debris ? '第二幕：用回油铁屑证明故障' : f.c2_exact ? '第二幕：直接按下急停' : '第二幕：让试车继续',
            f.c3_worn_gauge ? '第三幕：封存磨损定位规' : f.c3_process ? '第三幕：陪小林重走工序' : f.c3_shim ? '第三幕：用垫片绕过检验' : '第三幕：报废蒙皮',
            f.c4_team ? '第四幕：召集同伴连夜重做' : f.c4_authorized ? '第四幕：按领料单重做线路' : f.c4_spare ? '第四幕：安装笔记本指出的备用线' : f.c4_old_line ? '第四幕：接上老化测试线' : '第四幕：封存设备等待报告'
        ];
        const el = document.createElement('div');
        el.className = 'flight-report';
        el.innerHTML = `
            <div class="fr-title">北京一号首飞准备 · 验收记录</div>
            ${rows.join("")}
            <div class="fr-row flaw">工艺遗留 —— ${flaws.length ? flaws.join('；') : '无'}</div>
            <div class="fr-decisions"><strong>本程关键决定</strong>${decisions.map(text => `<span>${text}</span>`).join('')}</div>
            <div class="fr-nums">工期余量 ${a.stamina.value}/4 · 危机完成 ${a.integration.value}/4 · 历史偏离 ${a.deviation.value}/4</div>
            <div class="stamp stamp--rect fr-stamp">验</div>`;
        sec.appendChild(el);
    }

    /** 危机开场：把预知、当前资源和前序因果合并在同一张蓝晒简报里。 */
    showCrisisBrief(node, onContinue) {
        const cfg = UIManager.CRISIS_BRIEFS[node.id];
        if (!cfg) return onContinue();
        const attrs = this.attributeManager.attributes;
        const values = [
            ['工期余量', attrs.stamina.value, '工期耗尽将延期'],
            ['危机完成', attrs.integration.value, '完成四项才可能提前首飞'],
            ['历史偏离', attrs.deviation.value, attrs.deviation.value >= 2 ? '临界：再干预可能无法返回' : '当前仍可控']
        ];
        const echoes = this.getCrisisEchoes(node.id);
        const overlay = document.createElement('div');
        overlay.id = 'crisis-brief-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.innerHTML = `
            <section class="crisis-brief" aria-label="${cfg.title}当前局势">
                <div class="cb-kicker">${cfg.act} · 当前局势</div>
                <h2>${cfg.title}</h2>
                <div class="cb-prophecy">${cfg.prophecy}</div>
                <div class="cb-status">${values.map(([label, value, note]) => `
                    <div class="cb-stat ${label === '历史偏离' && value >= 2 ? 'is-danger' : ''}">
                        <div><span>${label}</span><b>${value}/4</b></div>
                        <div class="cb-track"><i style="width:${Math.max(0, Math.min(100, value * 25))}%"></i></div>
                        <small>${note}</small>
                    </div>`).join('')}</div>
                <div class="cb-echoes"><strong>前序决策正在影响现在</strong>${echoes.map(item => `
                    <div class="cb-echo ${item.tone}"><span>${item.tone === 'unlocked' ? '已解锁' : item.tone === 'warn' ? '警告' : '已封锁'}</span>${item.text}</div>`).join('')}</div>
                <button type="button">查看现场资料</button>
            </section>`;
        const dismiss = () => {
            overlay.classList.add('gone');
            setTimeout(() => overlay.remove(), 260);
            if (this.audioManager) this.audioManager.playPaperFlip();
            onContinue();
        };
        overlay.querySelector('button').addEventListener('click', dismiss, { once: true });
        document.body.appendChild(overlay);
        overlay.querySelector('button').focus();
        if (this.audioManager) this.audioManager.playBlueprintUnroll();
    }

    getCrisisEchoes(nodeId) {
        const f = this.attributeManager.flags;
        const deviation = this.attributeManager.getAttribute('deviation');
        if (nodeId === 'c1_open') {
            return [f.trust_niu
                ? { tone: 'unlocked', text: '你先帮了小牛，他愿意配合现场复测。' }
                : { tone: 'locked', text: '你直接介入工作，小牛仍在戒备，协作复测受限。' }];
        }
        if (nodeId === 'c2_open') {
            return [f.trust_niu
                ? { tone: 'unlocked', text: '小牛信任你，可以替你取得回油样本。' }
                : { tone: 'locked', text: '未取得小牛信任，回油取样路径不可用。' }];
        }
        if (nodeId === 'c3_gate') {
            const help = f.support_zhao
                ? { tone: 'unlocked', text: '赵师傅愿意替你说明来路。' }
                : f.trust_niu
                    ? { tone: 'unlocked', text: '小牛留下的见证签名可以证明你参与过工作。' }
                    : { tone: 'locked', text: '没人能替你说明来路，盘问时只能自己承担代价。' };
            return [deviation >= 2
                ? { tone: 'warn', text: '前两幕干预过深，季文已经开始追查你的身份。' }
                : { tone: 'unlocked', text: '历史偏离仍低，季文暂时没有理由拦下你。' }, help];
        }
        return [
            f.trust_niu && f.trust_xiaolin
                ? { tone: 'unlocked', text: '小牛与小林都信任你，可以召集完整夜班小组。' }
                : { tone: 'locked', text: '同伴信任不足，连夜协作方案不可用。' },
            f.trust_fang
                ? { tone: 'unlocked', text: '方岩认可你此前的判断，愿意按程序开库房。' }
                : { tone: 'locked', text: '没有方岩的认可，正式领料方案不可用。' }
        ];
    }

    isHighInterventionChoice(choice) {
        return document.body.classList.contains('demo-short-story')
            && Number(choice && choice.effects && choice.effects.deviation) > 0;
    }

    showInterventionConfirm(choice, onConfirm) {
        const current = this.attributeManager.getAttribute('deviation');
        const projected = current + Number(choice.effects.deviation || 0);
        const overlay = document.createElement('div');
        overlay.id = 'intervention-confirm-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.innerHTML = `
            <section class="intervention-confirm">
                <div class="ic-kicker">高干预行动</div>
                <h2>这会把历史偏离推到 ${projected}/4</h2>
                <p>你正绕过当时能够验证的证据与流程。再往前一步，可能失去返回现代的机会。</p>
                <div class="ic-actions"><button class="ic-back" type="button">重新考虑</button><button class="ic-confirm" type="button">确认行动</button></div>
            </section>`;
        const close = () => overlay.remove();
        overlay.querySelector('.ic-back').addEventListener('click', close);
        overlay.querySelector('.ic-confirm').addEventListener('click', () => { close(); onConfirm(); });
        document.body.appendChild(overlay);
        overlay.querySelector('.ic-back').focus();
        if (this.audioManager) this.audioManager.playTinnitusBurst({ attack: 0.12, hold: 0.18, release: 0.7, level: 0.012 });
    }

    /**
     * 幕间预言：笔记本翻页（蓝晒纸片，点击合上）
     */
    showProphecy(text) {
        if (document.getElementById('prophecy-overlay')) return;
        if (!document.getElementById('prophecy-style')) {
            const st = document.createElement('style');
            st.id = 'prophecy-style';
            st.textContent = `
#prophecy-overlay{position:fixed;inset:0;z-index:1500;background:rgba(20,42,71,.55);display:flex;align-items:center;justify-content:center;cursor:pointer;animation:hotspotFadeIn .35s ease both}
#prophecy-overlay.gone{opacity:0;transition:opacity .35s ease}
.prophecy-slip{width:min(430px,86vw);background:linear-gradient(rgba(17,38,66,.78),rgba(17,38,66,.78)),url('assets/scenes/prophecy-page.jpg') center/cover;border:1px solid var(--blueprint-bright);outline:1px solid rgba(215,230,244,.25);outline-offset:4px;border-radius:3px;padding:26px 26px 18px;color:var(--blueprint-line);text-align:center;box-shadow:0 14px 48px rgba(0,10,22,.5);transform:rotate(var(--tilt-a));animation:prophecyIn .55s cubic-bezier(.2,.7,.3,1.15) both}
@keyframes prophecyIn{from{opacity:0;transform:rotate(var(--tilt-a)) translateY(26px) scale(.94)}to{opacity:1;transform:rotate(var(--tilt-a)) translateY(0) scale(1)}}
.prophecy-kicker{font-family:var(--font-fangsong);font-size:12px;letter-spacing:.4em;text-indent:.4em;color:#a8c4dd;margin-bottom:16px}
.prophecy-text{font-family:var(--font-kai);font-size:22px;line-height:1.9;letter-spacing:.12em;margin-bottom:20px;padding:0 6px}
.prophecy-hint{font-family:var(--font-fangsong);font-size:11px;letter-spacing:.3em;text-indent:.3em;color:#6f8dab;animation:hintBlink 2.2s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.prophecy-slip{animation:none}.prophecy-hint{animation:none}}
`;
            document.head.appendChild(st);
        }
        const ov = document.createElement('div');
        ov.id = 'prophecy-overlay';
        ov.innerHTML = `<div class="prophecy-slip"><div class="prophecy-kicker">笔记本翻到新的一页</div><div class="prophecy-text">${text}</div><div class="prophecy-hint">点击合上笔记</div></div>`;
        const dismiss = () => {
            ov.classList.add('gone');
            setTimeout(() => ov.remove(), 400);
            if (this.audioManager) this.audioManager.playPaperFlip();
        };
        ov.addEventListener('click', dismiss, { once: true });
        document.body.appendChild(ov);
        if (this.audioManager) this.audioManager.playPaperFlip();
    }

    /**
     * 最佳结局起飞影片：全屏播放一次，点击跳过；播完淡出继续叙事
     */
    showEndingFilm(src) {
        if (document.getElementById('ending-film-overlay')) return;
        if (!document.getElementById('ending-film-style')) {
            const st = document.createElement('style');
            st.id = 'ending-film-style';
            st.textContent = `
#ending-film-overlay{position:fixed;inset:0;z-index:1600;background:#000;display:flex;align-items:center;justify-content:center;cursor:pointer;animation:hotspotFadeIn .4s ease both}
#ending-film-overlay.gone{opacity:0;transition:opacity .6s ease}
#ending-film-overlay video{width:100%;height:100%;object-fit:contain;background:#000}
.ef-skip{position:absolute;right:16px;bottom:14px;z-index:2;padding:8px 18px;background:#211d18cc;color:#f4ead8;border:1px solid #b8a88c;cursor:pointer;font-size:14px;font-family:var(--font-fangsong);letter-spacing:.1em}
.ef-skip:hover{background:#4b3028}
`;
            document.head.appendChild(st);
        }
        const ov = document.createElement('div');
        ov.id = 'ending-film-overlay';
        const v = document.createElement('video');
        v.src = src;
        v.autoplay = true;
        v.volume = 0.75;
        v.playsInline = true;
        const skip = document.createElement('button');
        skip.className = 'ef-skip';
        skip.textContent = '跳过 · 点击任意处继续';
        ov.appendChild(v);
        ov.appendChild(skip);
        const close = () => {
            if (ov.classList.contains('gone')) return;
            ov.classList.add('gone');
            try { v.pause(); } catch (e) {}
            setTimeout(() => ov.remove(), 650);
            if (this.audioManager) this.audioManager.playPaperFlip();
        };
        v.addEventListener('ended', close, { once: true });
        ov.addEventListener('click', close, { once: true });
        const p = v.play();
        if (p && p.catch) p.catch(() => close());
        document.body.appendChild(ov);
    }

    /**
     * 道具证据卡：剧情节点的关键道具特写（点击收起，7 秒自动收起）
     */
    showPropCard(src, caption) {
        if (document.getElementById('prop-card-overlay')) return;
        if (!document.getElementById('prop-card-style')) {
            const st = document.createElement('style');
            st.id = 'prop-card-style';
            st.textContent = `
#prop-card-overlay{position:fixed;right:24px;bottom:90px;z-index:1450;width:min(300px,60vw);cursor:pointer;animation:hotspotFadeIn .4s ease both}
#prop-card-overlay.gone{opacity:0;transform:translateY(12px);transition:opacity .3s ease,transform .3s ease}
.prop-card{position:relative;background:var(--paper-bright);background-image:var(--tex-paper);border:1px solid var(--frame);border-radius:3px;padding:10px;box-shadow:var(--shadow-paper-lift);transform:rotate(var(--tilt-b))}
.prop-card img{width:100%;display:block;border:1px solid var(--frame);border-radius:2px}
.prop-card-caption{font-family:var(--font-fangsong);font-size:12px;letter-spacing:.1em;color:var(--fg-muted);padding:8px 2px 2px}
.prop-card-hint{font-size:10px;letter-spacing:.3em;color:var(--fg-faint);text-align:center;padding-bottom:2px}
@media (prefers-reduced-motion:reduce){#prop-card-overlay{animation:none}}
`;
            document.head.appendChild(st);
        }
        const ov = document.createElement('div');
        ov.id = 'prop-card-overlay';
        ov.innerHTML = `<div class="prop-card"><img src="${src}" alt=""><div class="prop-card-caption">${caption}</div><div class="prop-card-hint">点击收起</div></div>`;
        const dismiss = () => {
            ov.classList.add('gone');
            setTimeout(() => ov.remove(), 350);
        };
        ov.addEventListener('click', dismiss, { once: true });
        setTimeout(() => { if (ov.parentNode) dismiss(); }, 7000);
        document.body.appendChild(ov);
    }

    /**
     * 渲染结局（无选项节点）
     * 若节点声明 autoNext/nextNode 则显示"继续"按钮而非结局
     */
    renderEnding(node = null) {
        const wrap = document.createElement('div');
        wrap.className = 'ending-section';
        this.appendJourneyStrip(wrap);   // 本局走过的场景，一屏回顾

        const next = node ? (node.autoNext || node.nextNode) : null;
        if (next) {
            this.elements.choicesSection.appendChild(wrap);
            const btn = document.createElement('button');
            btn.className = 'choice-btn continue-btn';
            btn.textContent = '▼ 继续';
            btn.addEventListener('click', () => {
                if (this.storyEngine.goToNode(next)) this.renderNode();
            });
            this.elements.choicesSection.appendChild(btn);
            return;
        }

        const achievements = this.attributeManager.achievements;

        let html = '<div class="ending-title">本章结束</div>';
        if (achievements.length > 0) {
            html += '<div class="ending-achievements"><div class="ending-subtitle">已解锁成就</div>';
            achievements.forEach(name => {
                html += `<div class="ending-achievement">🏅 ${name}</div>`;
            });
            html += '</div>';
        }
        wrap.innerHTML = html;

        const btn = document.createElement('button');
        btn.className = 'choice-btn';
        btn.textContent = '重新开始';
        btn.addEventListener('click', () => location.reload());
        wrap.appendChild(btn);

        this.elements.choicesSection.appendChild(wrap);
    }

    /**
     * 处理选项点击
     */
    handleChoice(index, choice, confirmed = false) {
        const deviationDelta = Number(choice && choice.effects && choice.effects.deviation) || 0;
        const projectedDeviation = this.attributeManager.getAttribute('deviation') + deviationDelta;
        if (!confirmed && this.isHighInterventionChoice(choice) && projectedDeviation >= 2) {
            this.showInterventionConfirm(choice, () => this.handleChoice(index, choice, true));
            return;
        }

        document.querySelector('.hotspot-layer')?.classList.add('spent');
        // 禁用所有选项按钮
        const buttons = this.elements.choicesSection.querySelectorAll('.choice-btn');
        buttons.forEach(btn => btn.disabled = true);

        // 执行选择（被条件/AP否决时返回 null，重绘恢复交互）
        const prevDeviation = this.attributeManager.getAttribute('deviation');
        const result = this.storyEngine.makeChoice(index);
        if (!result) {
            this.showFeedback('当前无法执行该行动', []);
            this.renderNode();
            return;
        }

        // 选择确认与反馈分开：图章确认选择，铅笔记录后果。
        if (this.audioManager && document.body.classList.contains('demo-short-story')) {
            this.audioManager.playStampThud();
            if (result.attributeChanges.some(change => change.change > 0)) {
                this.audioManager.playPencilScratch(0.28);
            }
            if (result.attributeChanges.some(change => change.name === 'deviation' && change.change > 0)) {
                this.audioManager.updateDeviation(this.attributeManager.getAttribute('deviation'));
                this.audioManager.playTinnitusBurst({ attack: 0.18, hold: 0.35, release: 1.2, level: 0.022 });
            }
        }

        // 反馈文案：干活首日接算尺演出，其余显示 AP 摘要
        const firstWork = (result.loopEvents || []).some(e => e.type === 'first-work-today');
        const extra = (result.loopEvents || [])
            .filter(e => e.type === 'ap-spent')
            .map(e => `AP -${e.cost}（余${e.remaining}）`);
        let msg = choice.feedback || '';
        if (!msg) {
            if (choice.work && firstWork) msg = '开工——先校一下算尺';
            else if (choice.work) msg = '继续干活 · 算尺检定合格';
            else msg = '选择已做出' + (extra.length ? ` · ${extra.join('，')}` : '');
        }
        // 偏离度首次逼近临界（>=2）：在反馈卡内做一次性前馈警告
        const nowDeviation = this.attributeManager.getAttribute('deviation');
        if (prevDeviation < 2 && nowDeviation >= 2) {
            msg += '<div class="feedback-deviation-warn">⚠ 偏离逼近临界——再偏离一次，历史将抹去你的名字</div>';
        }
        this.showFeedback(msg, result.attributeChanges, result.npcChanges, result.achievements);

        const navigate = () => {
            if (!choice.nextNode) return;
            if (this.storyEngine.goToNode(choice.nextNode)) {
                this.renderNode();
            } else {
                // 相位白名单等规则拦截：给出反馈并重绘当前节点恢复可交互
                this.showFeedback('该去向暂不可达（循环规则限制）', []);
                this.renderNode();
            }
        };

        // ★ 算尺快滑：每天首次干活触发（04 D4），判定完成后再前进
        if (choice.work && firstWork && window.game.SlideRuleGame) {
            new window.game.SlideRuleGame({
                onFinish: (res) => {
                    if (res.precision === 'perfect') {
                        const n = this.applySlideRuleBonus(choice);
                        this.showFeedback(`📐 算尺·完美对齐！${n ? `任务进度+${n}` : ''}`, []);
                    } else if (res.precision === 'good') {
                        this.showFeedback('📐 算尺·合格', []);
                    } else {
                        this.showFeedback('📐 算尺·失手了', []);
                    }
                    navigate();
                }
            });
            return;
        }

        // ★ 夜谈事件（night_events.json）：夜选"夜谈"命中事件池时插播卡片
        if (choice.night === 'talk' && window.game.LoopController) {
            const lc = this.storyEngine.loopController;
            if (lc) {
                const ev = lc.pickNightEvent({ talkTo: choice.talkTo ?? null });
                if (ev) {
                    // 先标记+结算，展示时携带变化反馈；随后再前进
                    const applied = lc.applyNightEvent(ev);
                    this.showNightEventCard(ev, applied, navigate);
                    return;
                }
            }
        }

        // ★ 短篇交互点：量规校验触发算尺快滑（纯演出，不改数值与路线）
        if (choice.id === 'c3_check_gauge'
            && document.body.classList.contains('demo-short-story')
            && window.game.SlideRuleGame) {
            new window.game.SlideRuleGame({
                onFinish: (res) => {
                    if (res.precision === 'perfect') this.showFeedback('📐 标准块严丝合缝——磨损量坐实了', []);
                    else if (res.precision === 'good') this.showFeedback('📐 读数对上了，磨损量基本坐实', []);
                    else this.showFeedback('📐 手一抖，再看一眼读数', []);
                    navigate();
                }
            });
            return;
        }

         setTimeout(navigate,
             document.body.classList.contains('demo-short-story') ? 260 : 2000);
    }

    /**
     * 夜谈/夜遇事件卡片：标题 + 正文 + 结尾句 + 变化摘要，点击继续后回调
     */
    showNightEventCard(ev, applied, onDone) {
        if (!document.getElementById('nightevent-style')) {
            const st = document.createElement('style');
            st.id = 'nightevent-style';
            st.textContent = `
#ne-overlay{position:fixed;inset:0;background:#000c;z-index:940;display:flex;
  align-items:center;justify-content:center;padding:20px}
#ne-card{max-width:560px;width:100%;max-height:80vh;overflow:auto;
  background:#171a21;color:#d9cdbb;border:1px solid #4a3f35;border-radius:10px;
  padding:20px 22px;font:"Microsoft YaHei",sans-serif;box-shadow:0 12px 48px #000d}
#ne-card .ne-title{color:#ffd28a;font-weight:700;font-size:15px;margin-bottom:10px}
#ne-card .ne-text{white-space:pre-wrap;line-height:1.8;margin-bottom:12px}
#ne-card .ne-result{color:#8fae8f;border-left:3px solid #4a6a4a;
  padding-left:10px;margin-bottom:14px;white-space:pre-wrap}
#ne-card .ne-fx{font-size:12px;color:#ffd28a;margin-bottom:12px}
#ne-card button{padding:6px 34px;border-radius:6px;border:1px solid #4a6a4a;
  background:#2b3a2b;color:#cfe3cf;cursor:pointer;font-size:13px}
#ne-card button:hover{background:#3a523a}
`;
            document.head.appendChild(st);
        }

        const overlay = document.createElement('div');
        overlay.id = 'ne-overlay';
        const fxLines = [...applied.attributeChanges, ...applied.npcChanges]
            .map(c => `${c.name}${c.change > 0 ? '+' : ''}${c.change}`)
            .join('　');
        overlay.innerHTML = `
<div id="ne-card">
  <div class="ne-title">🌙 ${ev.title || ''}</div>
  <div class="ne-text">${ev.text || ''}</div>
  ${ev.result ? `<div class="ne-result">${ev.result}</div>` : ''}
  ${fxLines ? `<div class="ne-fx">${fxLines}</div>` : ''}
  <button>继续</button>
</div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('button').addEventListener('click', () => {
            overlay.remove();
            onDone();
        });
    }

    /**
     * 算尺完美加成：给本次选项推进的任务追加 slideRulePerfectBonus
     * @returns {number} 实际生效的任务数
     */
    applySlideRuleBonus(choice) {
        const lc = this.storyEngine.loopController;
        if (!lc) return 0;
        const bonus = (lc.config.gameParams && lc.config.gameParams.slideRulePerfectBonus) || 1;
        const ids = new Set();
        if (choice.effects && choice.effects.taskId) ids.add(choice.effects.taskId);
        for (const tag of (choice.progressTags || [])) {
            for (const t of lc.getActiveTasks()) {
                if ((t.progressFrom || []).includes(tag)) ids.add(t.id);
            }
        }
        let n = 0;
        for (const id of ids) {
            if (lc.addProgress(id, bonus)) n++;
        }
        return n;
    }

    /**
     * 显示反馈卡片
     */
    showFeedback(message, attributeChanges = [], npcChanges = [], achievements = []) {
        const card = this.elements.feedbackCard;
        const content = card.querySelector('.feedback-content');

        let html = `<div style="margin-bottom: 12px; font-weight: 500;">${message}</div>`;

        // 属性变化
        attributeChanges.forEach(change => {
            const isPositive = change.change > 0;
            const className = isPositive ? 'positive' : 'negative';
            const sign = isPositive ? '+' : '';
            const label = this.getAttributeLabel(change.name);
            html += `<div class="attr-change ${className}">
                <span>${label}</span>
                <span>${sign}${change.change}</span>
            </div>`;
        });

        // NPC关系变化
        npcChanges.forEach(change => {
            const isPositive = change.change > 0;
            const className = isPositive ? 'positive' : 'negative';
            const sign = isPositive ? '+' : '';
            html += `<div class="attr-change ${className}">
                <span>${change.name}</span>
                <span>${sign}${change.change}</span>
            </div>`;
        });

        // 成就解锁
        achievements.forEach(name => {
            html += `<div class="attr-change positive">
                <span>🏅 解锁成就</span>
                <span>${name}</span>
            </div>`;
        });

        content.innerHTML = html;
        card.classList.remove('hidden');
        card.classList.add('show');

        // 点击反馈卡立即收起，避免打断阅读节奏
        if (!card.dataset.clickBound) {
            card.dataset.clickBound = '1';
            card.addEventListener('click', () => this.hideFeedbackCard());
        }

        // 自动隐藏（清掉上一张卡的计时器，防止连续反馈互相踩）
        if (this._feedbackHideTimer) clearTimeout(this._feedbackHideTimer);
        if (this._feedbackHiddenTimer) clearTimeout(this._feedbackHiddenTimer);
        this._feedbackHideTimer = setTimeout(() => {
            card.classList.remove('show');
            this._feedbackHiddenTimer = setTimeout(() => {
                card.classList.add('hidden');
            }, 300);
        }, 1800);
    }

    /** 立即收起反馈卡（点击跳过用） */
    hideFeedbackCard() {
        if (this._feedbackHideTimer) clearTimeout(this._feedbackHideTimer);
        if (this._feedbackHiddenTimer) clearTimeout(this._feedbackHiddenTimer);
        const card = this.elements.feedbackCard;
        if (!card) return;
        card.classList.remove('show');
        card.classList.add('hidden');
    }

    /**
     * 获取属性中文标签
     */
    getAttributeLabel(attrName) {
        const labels = {
            stamina: document.body.classList.contains('demo-short-story') ? '工期余量' : '体力值',
            integration: document.body.classList.contains('demo-short-story') ? '危机完成' : '融入度',
            deviation: '偏离度'
        };
        return labels[attrName] || attrName;
    }

    /**
     * 更新所有属性显示
     */
    updateAllAttributes() {
        // 更新核心属性
        const attrs = this.attributeManager.attributes;

        // 体力值
        this.updateProgressBar(
            this.elements.staminaBar,
            this.elements.staminaText,
            attrs.stamina.value,
            attrs.stamina.max
        );

        // 融入度
        this.updateProgressBar(
            this.elements.integrationBar,
            this.elements.integrationText,
            attrs.integration.value,
            attrs.integration.max
        );

        // 偏离度（高值预警：与体力/危机的低值预警方向相反）
        this.updateProgressBar(
            this.elements.deviationBar,
            this.elements.deviationText,
            attrs.deviation.value,
            attrs.deviation.max,
            { inverse: true }
        );

        // 今日行动点（出勤表·极简版）：让"行动点不足"可见可预期
        const loop = this.storyEngine && this.storyEngine.loopController;
        if (loop && loop.state && typeof loop.getWeekConfig === 'function') {
            let apEl = document.getElementById('ap-status-line');
            if (!apEl) {
                apEl = document.createElement('div');
                apEl.id = 'ap-status-line';
                apEl.style.cssText = 'margin:12px 0 2px 0;padding-top:10px;border-top:1px solid rgba(0,0,0,0.08);font-size:0.92em;';
                const devBar = this.elements.deviationBar;
                const group = devBar ? devBar.parentElement : null;
                const panel = group && group.parentElement ? group.parentElement.parentElement || group.parentElement : null;
                (panel || document.body).appendChild(apEl);
            }
            const cfg = loop.getWeekConfig(loop.state.week);
            const total = cfg.apPerDay || 0;
            const ap = loop.state.ap || 0;
            let dots = '';
            for (let i = 0; i < total; i++) dots += (i < ap ? '●' : '○');
            const tutorialNote = Number(loop.state.week) === 1
                ? '　<span style="font-size:.85em;color:#a4321f;">教学周 · 每日1点</span>' : '';
            apEl.innerHTML = `<strong>行动点</strong>　${dots}　${ap}/${total}${tutorialNote}`;
        }

        // 修正征兆·视觉档：偏离度越高，主纸页泛黄越重
        this.applyDecayAging(attrs.deviation ? attrs.deviation.value : 0);

        // 更新NPC关系
        this.updateNPCDisplay();
    }

    /**
     * 更新进度条
     * @param {object} opts - { inverse: true } 高值预警（偏离度），默认低值预警（体力/危机）
     */
    updateProgressBar(barElement, textElement, value, max, opts = {}) {
        const percentage = (value / max) * 100;
        barElement.style.width = `${percentage}%`;
        textElement.textContent = `${value}/${max}`;

        // 预警颜色
        const parent = barElement.parentElement;
        const warn = opts.inverse ? value >= max * 0.5 : value <= max * 0.2;
        parent.classList.toggle('warning', warn);
        if (opts.inverse) parent.classList.toggle('dev-near', warn);
    }

    /**
     * 更新NPC关系显示
     */
    updateNPCDisplay() {
        // 短篇：人物态度名牌（旗标驱动）
        if (document.body.classList.contains('demo-short-story')) {
            this.updateNpcChips();
            return;
        }
        const container = this.elements.npcRelations;
        container.innerHTML = '';

        const relations = this.attributeManager.npcRelations;

        for (const npc of Object.values(relations)) {
            // 只显示有关系值的NPC
            if (npc.value > 0) {
                const item = document.createElement('div');
                item.className = 'npc-item';

                const relationClass = npc.value >= 60 ? 'high' : (npc.value >= 30 ? 'medium' : '');

                item.innerHTML = `
                    <div class="npc-name">${npc.name}</div>
                    <div class="npc-relation-bar ${relationClass}">
                        <div class="npc-relation-fill" style="width: ${npc.value}%"></div>
                        <span class="npc-relation-text">${npc.value}</span>
                    </div>
                `;

                container.appendChild(item);
            }
        }

        if (container.children.length === 0) {
            container.innerHTML = '<div class="text-muted" style="text-align: center;">暂无关系</div>';
        }
    }
}
