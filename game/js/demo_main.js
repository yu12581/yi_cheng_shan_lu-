/**
 * 演示版主入口（demo.html 专用，不影响 index.html 正式入口）
 *
 * 与 main.js 的差异：
 * 1. 剧本固定加载 data/story_demo.json（北京一号短篇探索切片）
 * 2. 只加载故事数据，避免周循环、任务牌和预知卡池抢走核心选择的注意力
 *
 * 其余装配顺序与 main.js 保持一致：
 * AttributeManager → SaveManager → StoryEngine →
 * LoopController / CardManager（attach 互相引用）→ UIManager → DebugPanel
 */
(function () {
    'use strict';

    let attributeManager;
    let saveManager;
    let storyEngine;
    let loopController;
    let cardManager;
    let uiManager;
    let audioManager;
    let musicManager;

    /**
     * 短篇程序化音乐引擎 —— 六段 Web Audio 合成音床，按剧情场景切换。
     *
     * 与环境音效层（AudioManager.setBed 的车床/人声/金属事件）分离：
     * 这里只负责"音调层"——每个场景一段克制的和声底色，音量刻意压在音效之下。
     *
     *   archive 校史馆：A2+E3 正弦低鸣，极慢呼吸，高频尘光
     *   day     车间：  C3+G3 三角波暖垫，缓慢起伏（衬在环境床之上）
     *   night   深夜：  G1+B♭1 低音小二度不安 + 每 2.8s 一次心跳闷响
     *   launch  首飞喜庆：140BPM 十六步音序器，唢呐式方波领奏吹五声旋律句 + 密集锣鼓（鼓/镲/木鱼哒）
     *   delay   延期：  A 大三和弦暖垫 + 黎明高频微光 + 稀疏软钟（不喜庆）
     *   erased  被抹除：A2+C4 小三度低鸣，近乎无声地淡去
     *
     * 接到 AudioManager.masterGain：静音/挂起/压限全部随现有链路联动。
     * 换段 2.2s 交叉淡化；ctx 未解锁（无手势）时静默待命，下次 setNode 重试。
     */
    class ShortStoryMusic {
        constructor(audioManager) {
            this.am = audioManager || null;
            this.desiredKey = null;
            this.muted = audioManager ? audioManager.muted : false;
            this.bed = null;   // { key, gain, sources: [], timer }
        }

        get ctx() { return this.am && this.am.ctx; }
        get out() { return (this.am && this.am.masterGain) || (this.ctx && this.ctx.destination) || null; }

        keyForNode(node) {
            if (!node) return null;
            if (node.id === 'demo_00_start' || node.id === 'demo_08_end' || node.id === 'demo_09_end') return 'archive';
            if (node.id === 'demo_06_settle' || node.id === 'demo_07_best') return 'launch';
            if (node.id === 'demo_07_delay' || node.id === 'demo_07_delay_grace') return 'delay';
            if (node.id === 'demo_07_erased') return 'erased';
            if (node.visual === 'engine' || node.id.startsWith('c4_')) return 'night';
            return 'day';
        }

        setNode(node) {
            this._syncMuted();
            this.desiredKey = this.keyForNode(node);
            this._apply();
        }

        setMuted(muted) {
            this.muted = muted;
            if (muted) this._teardown();
            else this._apply();
        }

        /* 以 AudioManager 实时静音态为准，防绕过按钮的切换导致两层脱钩 */
        _syncMuted() {
            if (this.am) this.muted = this.am.muted;
        }

        _apply() {
            this._syncMuted();
            if (!this.ctx || !this.out) return;            // 手势前无 ctx：待命
            if (this.bed && this.bed.key === this.desiredKey) return;
            this._teardown();
            if (!this.desiredKey || this.muted) return;
            const build = {
                archive: (b, t) => this._buildArchive(b, t),
                day:     (b, t) => this._buildDay(b, t),
                night:   (b, t) => this._buildNight(b, t),
                launch:  (b, t) => this._buildLaunch(b, t),
                delay:   (b, t) => this._buildDelay(b, t),
                erased:  (b, t) => this._buildErased(b, t)
            }[this.desiredKey];
            if (!build) return;
            const bed = { key: this.desiredKey, gain: this.ctx.createGain(), sources: [], timer: null };
            bed.gain.gain.value = 0;
            bed.gain.connect(this.out);
            build(bed, this.ctx.currentTime + 0.05);
            bed.gain.gain.linearRampToValueAtTime(1, this.ctx.currentTime + 2.5);
            this.bed = bed;
        }

        _teardown() {
            if (!this.bed || !this.ctx) { this.bed = null; return; }
            const old = this.bed;
            this.bed = null;
            const t = this.ctx.currentTime;
            old.gain.gain.cancelScheduledValues(t);
            old.gain.gain.setValueAtTime(old.gain.gain.value, t);
            old.gain.gain.linearRampToValueAtTime(0, t + 2.2);
            setTimeout(() => {
                if (old.timer) clearInterval(old.timer);
                old.sources.forEach(s => { try { s.stop(); } catch (e) {} });
                try { old.gain.disconnect(); } catch (e) {}
            }, 2400);
        }

        _osc(bed, type, freq, detune) {
            const o = this.ctx.createOscillator();
            o.type = type;
            o.frequency.value = freq;
            if (detune) o.detune.value = detune;
            o.start();
            bed.sources.push(o);
            return o;
        }

        _noise(bed) {
            const len = this.ctx.sampleRate * 2;
            const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
            const d = buf.getChannelData(0);
            for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
            const src = this.ctx.createBufferSource();
            src.buffer = buf;
            src.loop = true;
            src.start();
            bed.sources.push(src);
            return src;
        }

        _lfo(bed, freq, depth, target) {
            const o = this.ctx.createOscillator();
            o.frequency.value = freq;
            const g = this.ctx.createGain();
            g.gain.value = depth;
            o.connect(g).connect(target);
            o.start();
            bed.sources.push(o);
        }

        _filter(type, freq, q) {
            const f = this.ctx.createBiquadFilter();
            f.type = type;
            f.frequency.value = freq;
            if (q) f.Q.value = q;
            return f;
        }

        _gain(v) {
            const g = this.ctx.createGain();
            g.gain.value = v;
            return g;
        }

        /* 校史馆：低鸣 + 呼吸 + 尘光 */
        _buildArchive(bed, t) {
            const lp = this._filter('lowpass', 520);
            const g = this._gain(0.05);
            [110, 164.8].forEach((f, i) => {
                const o = this._osc(bed, 'sine', f, i ? 4 : -3);
                o.connect(lp);
            });
            lp.connect(g);
            this._lfo(bed, 0.06, 0.016, g.gain);
            const dust = this._filter('highpass', 6800);
            const dustG = this._gain(0.004);
            this._noise(bed).connect(dust).connect(dustG).connect(bed.gain);
            this._lfo(bed, 0.023, 0.002, dustG.gain);
            g.connect(bed.gain);
        }

        /* 车间日间：高八度暖和声垫（无慢 LFO——持续低音+呼吸起伏=致昏），衬在环境床之上 */
        _buildDay(bed, t) {
            const lp = this._filter('lowpass', 620);
            const g = this._gain(0.018);
            [261.6, 392.0].forEach((f, i) => {
                const o = this._osc(bed, 'triangle', f, i ? 5 : -4);
                o.connect(lp);
            });
            lp.connect(g);
            g.connect(bed.gain);
        }

        /* 深夜：低音小二度不安 + 心跳闷响 */
        _buildNight(bed, t) {
            const lp = this._filter('lowpass', 300);
            const g = this._gain(0.045);
            [49.0, 58.3].forEach((f, i) => {
                const o = this._osc(bed, 'sine', f, i ? 6 : -2);
                o.connect(lp);
            });
            lp.connect(g);
            this._lfo(bed, 0.043, 0.014, g.gain);
            g.connect(bed.gain);
            bed.timer = setInterval(() => {
                if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
                const tt = this.ctx.currentTime + 0.05;
                const o = this.ctx.createOscillator();
                o.type = 'sine';
                o.frequency.setValueAtTime(58, tt);
                o.frequency.exponentialRampToValueAtTime(38, tt + 0.28);
                const eg = this.ctx.createGain();
                eg.gain.setValueAtTime(0.0001, tt);
                eg.gain.exponentialRampToValueAtTime(0.05, tt + 0.02);
                eg.gain.exponentialRampToValueAtTime(0.0001, tt + 0.55);
                o.connect(eg).connect(this.out);
                o.start(tt);
                o.stop(tt + 0.6);
            }, 2800);
        }

        /* 首飞喜庆：140BPM 十六步音序器 —— 唢呐式领奏吹五声旋律句 + 密集锣鼓点 */
        _buildLaunch(bed, t) {
            const lp = this._filter('lowpass', 900);
            const g = this._gain(0.026);
            [[110, 'sine', -4], [164.8, 'sine', 5], [277.2, 'triangle', -6]].forEach(([f, w, d]) => {
                const o = this._osc(bed, w, f, d);
                const og = this._gain(f > 200 ? 0.3 : 1);
                o.connect(og).connect(lp);
            });
            lp.connect(g);
            g.connect(bed.gain);

            // 镲/哒共享噪声缓冲
            const cLen = this.ctx.sampleRate * 0.6;
            const cBuf = this.ctx.createBuffer(1, cLen, this.ctx.sampleRate);
            const cd = cBuf.getChannelData(0);
            for (let i = 0; i < cLen; i++) cd[i] = Math.random() * 2 - 1;

            // A 宫五声旋律句（欢快上行-回落，两小节一循环，偶数轮换尾句）
            const A4 = 440, B4 = 493.9, Cs5 = 554.4, E5 = 659.3, Fs5 = 740, A5 = 880;
            const melA = [A4, 0, Cs5, E5, A5, 0, Fs5, E5, Cs5, 0, E5, Cs5, B4, 0, A4, 0];
            const melB = [A4, 0, Cs5, E5, A5, 0, Fs5, E5, Cs5, 0, E5, Cs5, B4, Cs5, E5, 0];
            const drumSteps = new Set([0, 6, 8, 14]);        // 锣鼓低鼓位
            const cymSteps = new Set([4, 12]);               // 镲在反拍
            const tickSteps = new Set([2, 10]);              // 木鱼哒
            const stepDur = 214;                             // 140BPM 八分音符
            let step = 0;

            bed.timer = setInterval(() => {
                if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
                const tt = this.ctx.currentTime + 0.06;
                const cycle = Math.floor(step / 16);
                const i = step % 16;
                const pat = cycle % 2 === 0 ? melA : melB;
                const f = pat[i];

                // 领奏：方波双八度（唢呐感），跳音收尾干脆
                if (f) {
                    const p = this.ctx.createOscillator();
                    p.type = 'square';
                    p.frequency.value = f;
                    const pf = this._filter('lowpass', 3200);
                    const pg = this.ctx.createGain();
                    pg.gain.setValueAtTime(0.0001, tt);
                    pg.gain.exponentialRampToValueAtTime(0.03, tt + 0.008);
                    pg.gain.exponentialRampToValueAtTime(0.0001, tt + 0.24);
                    p.connect(pf).connect(pg).connect(this.out);
                    p.start(tt); p.stop(tt + 0.28);
                    const sub = this.ctx.createOscillator();   // 低八度垫厚度
                    sub.type = 'sine';
                    sub.frequency.value = f / 2;
                    const sg = this.ctx.createGain();
                    sg.gain.setValueAtTime(0.0001, tt);
                    sg.gain.exponentialRampToValueAtTime(0.014, tt + 0.01);
                    sg.gain.exponentialRampToValueAtTime(0.0001, tt + 0.3);
                    sub.connect(sg).connect(this.out);
                    sub.start(tt); sub.stop(tt + 0.32);
                }
                // 低鼓
                if (drumSteps.has(i)) {
                    const d = this.ctx.createOscillator();
                    d.type = 'sine';
                    d.frequency.setValueAtTime(150, tt);
                    d.frequency.exponentialRampToValueAtTime(62, tt + 0.16);
                    const dg = this.ctx.createGain();
                    dg.gain.setValueAtTime(0.0001, tt);
                    dg.gain.exponentialRampToValueAtTime(0.05, tt + 0.012);
                    dg.gain.exponentialRampToValueAtTime(0.0001, tt + 0.26);
                    d.connect(dg).connect(this.out);
                    d.start(tt); d.stop(tt + 0.3);
                }
                // 镲（反拍）+ 每 4 句一大片
                if (cymSteps.has(i) || (i === 0 && cycle % 4 === 0)) {
                    const big = i === 0 && cycle % 4 === 0;
                    const cs = this.ctx.createBufferSource();
                    cs.buffer = cBuf;
                    const cf = this._filter('highpass', 5800);
                    const cg = this.ctx.createGain();
                    cg.gain.setValueAtTime(0.0001, tt);
                    cg.gain.exponentialRampToValueAtTime(big ? 0.02 : 0.013, tt + 0.008);
                    cg.gain.exponentialRampToValueAtTime(0.0001, tt + (big ? 0.55 : 0.24));
                    cs.connect(cf).connect(cg).connect(this.out);
                    cs.start(tt); cs.stop(tt + 0.6);
                }
                // 木鱼哒（驱动感）
                if (tickSteps.has(i)) {
                    const tk = this.ctx.createBufferSource();
                    tk.buffer = cBuf;
                    const tf = this._filter('bandpass', 2100, 6);
                    const tg = this.ctx.createGain();
                    tg.gain.setValueAtTime(0.0001, tt);
                    tg.gain.exponentialRampToValueAtTime(0.006, tt + 0.004);
                    tg.gain.exponentialRampToValueAtTime(0.0001, tt + 0.09);
                    tk.connect(tf).connect(tg).connect(this.out);
                    tk.start(tt); tk.stop(tt + 0.1);
                }
                step++;
            }, stepDur);
        }

        /* 延期：原暖垫版（不喜庆）——黎明微光 + 稀疏软钟 */
        _buildDelay(bed, t) {
            const lp = this._filter('lowpass', 900);
            const g = this._gain(0.036);
            [[110, 'sine', -4], [164.8, 'sine', 5], [277.2, 'triangle', -6]].forEach(([f, w, d]) => {
                const o = this._osc(bed, w, f, d);
                const og = this._gain(f > 200 ? 0.35 : 1);
                o.connect(og).connect(lp);
            });
            lp.connect(g);
            this._lfo(bed, 0.038, 0.012, g.gain);
            const dawn = this._filter('highpass', 7200);
            const dawnG = this._gain(0.005);
            this._noise(bed).connect(dawn).connect(dawnG).connect(bed.gain);
            this._lfo(bed, 0.03, 0.003, dawnG.gain);
            g.connect(bed.gain);
            bed.timer = setInterval(() => {
                if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
                if (Math.random() < 0.4) return;
                const tt = this.ctx.currentTime + 0.05;
                const o = this.ctx.createOscillator();
                o.type = 'sine';
                o.frequency.value = [880, 1108.7, 1318.5][Math.floor(Math.random() * 3)];
                const eg = this.ctx.createGain();
                eg.gain.setValueAtTime(0.0001, tt);
                eg.gain.exponentialRampToValueAtTime(0.008, tt + 0.04);
                eg.gain.exponentialRampToValueAtTime(0.0001, tt + 2.2);
                o.connect(eg).connect(this.out);
                o.start(tt);
                o.stop(tt + 2.3);
            }, 9000);
        }

        /* 被抹除：小三度低鸣，近乎无声地淡去 */
        _buildErased(bed, t) {
            const lp = this._filter('lowpass', 420);
            const g = this._gain(0.04);
            [110, 261.6].forEach((f, i) => {
                const o = this._osc(bed, 'sine', f, i ? 3 : -5);
                const og = this._gain(f > 200 ? 0.22 : 1);
                o.connect(og).connect(lp);
            });
            lp.connect(g);
            this._lfo(bed, 0.021, 0.018, g.gain);
            g.connect(bed.gain);
        }
    }

    async function initGame() {
        document.body.classList.add('demo-short-story');
        attributeManager = new AttributeManager();
        attributeManager.attributes.stamina = { value: 4, max: 4, min: 0 };
        attributeManager.attributes.integration = { value: 0, max: 4, min: 0 };
        attributeManager.attributes.deviation = { value: 0, max: 4, min: 0 };
        saveManager = new SaveManager();
        storyEngine = new StoryEngine(attributeManager);
        loopController = new LoopController(attributeManager);
        cardManager = new CardManager(attributeManager);
        audioManager = new AudioManager();
        musicManager = new ShortStoryMusic(audioManager);
        musicManager.setMuted(audioManager.muted);

        storyEngine.attachSystems({ loopController, cardManager });
        loopController.attach({ storyEngine, saveManager, cardManager });
        cardManager.attach({ storyEngine });

        if (location.protocol === 'file:') {
            window.bootNotice('无法加载剧情数据',
                '双击打开会被浏览器拦截本地文件请求。\n\n请在 game 目录运行：\n  python -m http.server 8000\n然后访问：\n  http://localhost:8000/demo.html');
            return;
        }

        const contentLoader = new ContentLoader({ storyEngine, loopController, cardManager, attributeManager });
        const loadedOk = await contentLoader.load(['data/story_demo.json']);
        if (!loadedOk.story) {
            window.bootNotice('演示剧本加载失败',
                '路径：data/story_demo.json\n请确认已通过本地服务器访问\n（如 http://localhost:8000/demo.html）。');
            return;
        }

        // 启动短篇切片，不进入正式版的周循环入口。
        const nodes = storyEngine.nodes;
        const startId = nodes['demo_00_start']
            ? 'demo_00_start'
            : Object.keys(nodes).find(k => !k.startsWith('__'));
        storyEngine.currentNodeId = null;
        storyEngine.goToNode(startId);

        uiManager = new UIManager(storyEngine, attributeManager, saveManager, audioManager, musicManager);
        uiManager.showStartMenu();

        // 「继续记录」：auto 槽有幕间存档时点亮，一键直读（不经存档模态）
        const autoSave = saveManager.loadGame('auto');
        if (autoSave) {
            const btn = document.getElementById('continue-game-btn');
            if (btn) {
                btn.disabled = false;
                btn.style.opacity = '';
                const clone = btn.cloneNode(true);          // 摘掉原「打开存档模态」监听
                btn.replaceWith(clone);
                clone.addEventListener('click', () => {
                    audioManager.activate();
                    storyEngine.loadState(autoSave);
                    uiManager.hideStartMenu();
                    uiManager.renderNode();
                    uiManager.updateAllAttributes();
                }, { once: true });
            }
        }
        setupOpeningFilm();

        // F1 调试面板保留，便于课程现场快速重演三个结果。
        const debugPanel = new DebugPanel();

        window.game = {
            ...window.game,
            attributeManager,
            saveManager,
            storyEngine,
            loopController,
            cardManager,
            uiManager,
            audioManager,
            musicManager,
            debugPanel,
            isDemo: true
        };

        console.log('《一程山路》演示版初始化完成 | 剧情: data/story_demo.json');
    }

    function setupOpeningFilm() {
        const wrap = document.getElementById('opening-film');
        const video = document.getElementById('opening-film-video');
        const skip = document.getElementById('opening-film-skip');
        if (!wrap || !video) return;
        // 每次会话只播一次：重访/刷新直达菜单（23MB 视频，反复看很烦）
        let seen = false;
        try { seen = sessionStorage.getItem('ycsl_opening_seen') === '1'; } catch (e) {}
        if (seen) { wrap.classList.add('poster-mode'); return; }
        const markSeen = () => { try { sessionStorage.setItem('ycsl_opening_seen', '1'); } catch (e) {} };
        video.poster = 'assets/scenes/start-poster.jpg';
        // 开场视频缺失时直接显示开始菜单（error 回退保留给未来替换素材）。
        video.src = 'assets/video/bj1-opening.mp4';
        let started = false;
        const close = () => {
            if (!started) return;
            video.pause();
            wrap.classList.add('poster-mode');
        };
        video.addEventListener('canplay', () => {
            wrap.classList.remove('hidden');
            started = true;
            markSeen();
            const play = video.play();
            if (play && play.catch) play.catch(() => close());
        }, { once: true });
        video.addEventListener('ended', close, { once: true });
        video.addEventListener('error', () => {
            wrap.classList.add('hidden');
        });
        if (skip) skip.addEventListener('click', () => { markSeen(); close(); });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initGame);
    } else {
        initGame();
    }
})();
