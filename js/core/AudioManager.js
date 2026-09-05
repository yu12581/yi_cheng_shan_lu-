/**
 * AudioManager - 全程序化合成声音层（07 audio-layer / 05 D4·D5）
 *
 * 四层结构（无旋律 BGM，Demo 允许环境床+静默）：
 *   1. 环境音床：昼=车间金属声浪（拟声词系统：嗡嗡呜呜车床/叮当锉击/嘶拉嘶拉锯床/
 *      嗒嗒嗒铆枪/滋滋电焊/哎—哎—哎插齿机）；夜=虫鸣+远犬。随 LoopController
 *      相位自动淡入淡出（WEEK_SETTLE 归夜床并触发开炉电铃）。
 *   2. UI 反馈：翻纸/图章咚/铅笔沙沙/算尺咔哒/图纸展开摩擦（打字机与 blip 保留）。
 *   3. 循环结算：开炉电铃（每周仅一次，读档恢复不重放）。
 *   4. 机制联动：偏离度≥warning 起全局 lowpass 渐闷；≥drift 起 12kHz 耳鸣渐入；
 *      剧情节点可用 playTinnitusBurst() 手动触发耳鸣（绕过全局低通——声音在颅内）。
 *
 * 信号链：
 *   bus(Gain) → globalLowpass(BiquadFilter) → masterGain(静音/总闸) → destination
 *   耳鸣直接接 masterGain（不经过全局低通）
 *
 * 移动端适配（微信 H5）：
 *   - 构造时自装一次性手势监听（touchend/click/keydown），首次交互解锁 AudioContext；
 *   - 解锁时自动从 window.game.loopController 订阅 onChange（相位+偏离度快照），
 *     引擎侧零改动、零装配；
 *   - visibilitychange 隐藏即 suspend 省电防 iOS 挂起错乱；
 *   - iOS 静音键为系统级硬开关，WebAudio 无法检测也无法绕过（详见 design/INTEGRATION-NOTES.md），
 *     兜底 = 所有声音均可缺席不影响游玩 + 静音状态 localStorage 持久化。
 */
class AudioManager {
    constructor() {
        this.ctx = null;
        this.muted = false;
        try {
            this.muted = localStorage.getItem('ycsl_audio_muted') === '1';
        } catch (e) { /* 隐私模式等 */ }

        // 主链路节点
        this.bus = null;          // 一切声音汇入点（受偏离低通影响）
        this.globalLowpass = null;
        this.masterGain = null;

        // 打字机 blip 节流（保留原逻辑）
        this.lastBlipTime = 0;
        this.speakerPitch = {
            chen: 420, zhang: 200, li: 360, zhao: 240, liu: 300, wang: 320,
            narrator: 0, default: 300
        };

        // 音床状态：'day' | 'night' | null；beds 存两张床的节点与调度器
        this.currentBed = null;
        this.desiredBed = null;   // 解锁前请求的床，解锁后补启
        this.beds = { day: null, night: null };
        // Seed Audio 生成的高保真环境音（Higgsfield）；缺文件时自动回退合成床
        this.ambFiles = {
            day: 'assets/audio/amb-workshop.mp3',
            night: 'assets/audio/amb-testcell.mp3',
            testcell: 'assets/audio/amb-testcell.mp3',
            airfield: 'assets/audio/amb-airfield.mp3',
            archive: 'assets/audio/amb-archive.mp3'
        };
        this._ambEls = {};
        this._ambNodes = {};
        this._ambBroken = {};

        // 噪声缓冲复用（省 CPU）
        this._noise2s = null;     // 白噪声 2s
        this._brown2s = null;     // 布朗噪声 2s

        // 偏离度联动（阈值默认镜像 params.json，attachLoop 后被 gameParams 覆盖）
        this.thresholds = { warning: 3, drift: 6, check: 9, erase: 10 };
        this.deviation = 0;
        this._loopAttached = false;
        this._phaseSeen = false;  // 首次 onChange 只记录相位不触发副作用（读档安全）
        this._lastBellWeek = null;

        // 耳鸣常驻层（12kHz 正弦，增益平时为 0）+ 剧情突发层计数
        this.tinnitusOsc = null;
        this.tinnitusGain = null;
        this._tinnitusBurstCount = 0;

        // 偏离联动参数去抖缓存
        this._lastCutoff = -1;
        this._lastTin = -1;

        // 厂房混响发送总线（昼床金属事件与电铃共用）
        this.reverbSend = null;

        // 微信 H5 / iOS：首次用户手势解锁
        const gesture = () => { this.activate(); };
        ['touchend', 'click', 'keydown'].forEach(ev => {
            document.addEventListener(ev, gesture, { passive: true });
        });
    }

    /* ==================== 生命周期 ==================== */

    /**
     * 用户手势路径入口（UIManager 新开局/读档按钮也会调用，保持幂等）
     */
    activate() {
        if (this.ctx) { this._syncCtxPower(); return; }
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { console.warn('浏览器不支持 Web Audio API'); return; }
        try { this.ctx = new AC(); } catch (e) { console.warn('AudioContext 创建失败', e); return; }

        // 主链路：bus → 全局低通（偏离联动）→ 总闸 → 限制器（防电铃+图章叠爆）→ 输出
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = this.muted ? 0 : 1;
        let tail = this.masterGain;
        try {
            const limiter = this.ctx.createDynamicsCompressor();
            limiter.threshold.value = -6;
            limiter.knee.value = 12;
            limiter.ratio.value = 12;
            limiter.attack.value = 0.003;
            limiter.release.value = 0.22;
            this.masterGain.connect(limiter);
            limiter.connect(this.ctx.destination);
            tail = null; // 已接限器
        } catch (e) { /* 老webview无限器则直连 */ }
        if (tail) this.masterGain.connect(this.ctx.destination);
        this.globalLowpass = this.ctx.createBiquadFilter();
        this.globalLowpass.type = 'lowpass';
        this.globalLowpass.frequency.value = 19500;
        this.globalLowpass.Q.value = 0.0001;
        this.bus = this.ctx.createGain();
        this.bus.gain.value = 1;
        this.bus.connect(this.globalLowpass);
        this.globalLowpass.connect(this.masterGain);

        // 厂房混响：程序化脉冲响应（指数衰减噪声，1.6s），昼床/电铃发送用
        try {
            const conv = this.ctx.createConvolver();
            conv.buffer = this._makeIR(1.6, 2.6);
            const wet = this.ctx.createGain();
            wet.gain.value = 0.45;
            this.reverbSend = this.ctx.createGain();
            this.reverbSend.gain.value = 1;
            this.reverbSend.connect(conv);
            conv.connect(wet);
            wet.connect(this.bus);
        } catch (e) { this.reverbSend = null; }

        // 常驻耳鸣层（增益 0 待命）
        this.tinnitusOsc = this.ctx.createOscillator();
        this.tinnitusOsc.type = 'sine';
        this.tinnitusOsc.frequency.value = 12000;
        this.tinnitusGain = this.ctx.createGain();
        this.tinnitusGain.gain.value = 0;
        this.tinnitusOsc.connect(this.tinnitusGain);
        this.tinnitusGain.connect(this.masterGain); // 颅内声，绕过全局低通
        try { this.tinnitusOsc.start(); } catch (e) {}

        // iOS 解锁踢一脚：播放极短零样本 buffer
        try {
            const silent = this.ctx.createBuffer(1, 256, this.ctx.sampleRate);
            const s = this.ctx.createBufferSource();
            s.buffer = silent;
            s.connect(this.ctx.destination);
            s.start(0);
        } catch (e) {}

        // 电源状态集中管理：切后台/静音/被系统中断（iOS interrupted）统一挂起省电
        document.addEventListener('visibilitychange', () => this._syncCtxPower());
        try { this.ctx.onstatechange = () => this._syncCtxPower(); } catch (e) {}

        this._autoAttachLoop();

        // 补启解锁前请求的音床
        if (this.desiredBed) {
            const want = this.desiredBed;
            this.desiredBed = null;
            this.setBed(want);
        }
        this.updateDeviation(this.deviation);
        this._syncCtxPower();
    }

    /**
     * 统一电源策略：仅在「非静音且页面可见」时保持运行。
     * 静音/切后台/iOS 电话或闹钟中断 → suspend 省电；恢复条件满足 → resume。
     * 幂等无环路（resume/suspend 触发的 statechange 再进来时条件已不满足）。
     */
    _syncCtxPower() {
        if (!this.ctx) return;
        const wantRun = !this.muted && !document.hidden;
        try {
            const s = this.ctx.state;
            if (wantRun && s !== 'running') this.ctx.resume();
            else if (!wantRun && s === 'running') this.ctx.suspend();
        } catch (e) {}
        const curBed = this.currentBed && this.beds[this.currentBed];
        if (curBed && curBed.audioEl) {
            try { if (wantRun) curBed.audioEl.play().catch(() => {}); else curBed.audioEl.pause(); } catch (e) {}
        }
    }

    /**
     * 自动挂钩 LoopController（window.game 由 main.js initGame 尾部装配，
     * 首次用户手势到达时必然已就绪）。引擎侧零改动。
     */
    _autoAttachLoop() {
        if (this._loopAttached) return;
        const loop = window.game && window.game.loopController;
        if (!loop || typeof loop.onChange !== 'function') return;
        this.attachLoop(loop);
    }

    /**
     * 显式挂钩（测试/调试用；生产走 _autoAttachLoop）
     * @param {LoopController} loopController
     */
    attachLoop(loopController) {
        if (this._loopAttached || !loopController) return;
        this._loopAttached = true;

        // 阈值从 params.json 注入的 gameParams 读取（ContentLoader.js 写入 lc.config.gameParams）
        const gp = loopController.config && loopController.config.gameParams;
        if (gp && gp.deviation && gp.deviation.thresholds) {
            this.thresholds = { ...this.thresholds, ...gp.deviation.thresholds };
        }

        loopController.onChange((state) => {
            // 相位切换 → 昼/夜音床 + WEEK_SETTLE 电铃
            if (state.phase !== this._seenPhase) {
                const prevPhase = this._seenPhase;
                this._seenPhase = state.phase;
                if (this._phaseSeen && state.phase === 'WEEK_SETTLE'
                    && prevPhase !== null && state.week !== this._lastBellWeek) {
                    this.playSettleBell();
                    this._lastBellWeek = state.week;
                }
                this.applyPhase(state.phase);
                this._phaseSeen = true;
            }
            // 偏离度快照 → 低通 + 耳鸣联动
            const am = window.game && window.game.attributeManager;
            if (am && typeof am.getAttribute === 'function') {
                const dev = am.getAttribute('deviation');
                if (typeof dev === 'number') this.updateDeviation(dev);
            }
        });
        // 挂钩瞬间先同步一次当前相位（读档恢复场景不触发电铃/切床花活）
        if (loopController.state) {
            this._seenPhase = loopController.state.phase;
            this.applyPhase(loopController.state.phase);
            this._phaseSeen = false;
        }
    }

    /* ==================== 静音 ==================== */

    toggleMute() {
        this.muted = !this.muted;
        try { localStorage.setItem('ycsl_audio_muted', this.muted ? '1' : '0'); } catch (e) {}
        if (this.masterGain) {
            const now = this.ctx.currentTime;
            this.masterGain.gain.cancelScheduledValues(now);
            this.masterGain.gain.setTargetAtTime(this.muted ? 0 : 1, now, 0.05);
        }
        // 静音→等 90ms 淡完再挂起（省电）；取消静音→立即恢复
        if (this.ctx) {
            if (this.muted) setTimeout(() => { if (this.muted) this._syncCtxPower(); }, 90);
            else this._syncCtxPower();
        }
        return this.muted;
    }

    /* ==================== 相位音床（05 D5 第①层） ==================== */

    static BED_MAP = {
        WEEK_START: 'day', DAY_START: 'day', DAY_ACTION: 'day',
        NIGHT_CHOICE: 'night', WEEK_SETTLE: 'night'
    };

    /** LoopController 相位 → 音床（null/序章自由节点 = 静默） */
    applyPhase(phase) {
        const bed = phase ? AudioManager.BED_MAP[phase] || null : null;
        this.setBed(bed);
    }

    /**
     * 切换音床（带交叉淡化）。同床幂等。
     * @param {'day'|'night'|null} which
     */
    setBed(which) {
        if (!this.ctx) { this.desiredBed = which; return; }
        if (which === this.currentBed) return;
        const now = this.ctx.currentTime;
        if (this.beds[this.currentBed]) this._stopBed(this.currentBed, now, 1.8);
        this.currentBed = which;
        if (which) this._startBed(which, now);
    }

    /** 兼容旧契约：UIManager 新开局/读档调用。按当前相位起床；序章(phase=null)保持静默 */
    startBackground() {
        if (!this.ctx) { this.desiredBed = this.desiredBed || 'day'; return; }
        const phase = this._seenPhase !== undefined
            ? this._seenPhase
            : window.game?.loopController?.state?.phase;
        if (phase === undefined) { this.setBed('day'); return; } // 引擎未挂钩的兜底
        this.applyPhase(phase);
    }

    /** 兼容旧契约：全部停掉归于静默 */
    stopBackground() {
        this.desiredBed = null;
        if (!this.ctx) return;
        if (this.beds[this.currentBed]) this._stopBed(this.currentBed, this.ctx.currentTime, 1.0);
        this.currentBed = null;
    }

    _noiseBuffer(kind) {
        if (kind === 'brown' && this._brown2s) return this._brown2s;
        if (kind !== 'brown' && this._noise2s) return this._noise2s;
        const len = Math.floor(this.ctx.sampleRate * 2);
        const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = buf.getChannelData(0);
        if (kind === 'brown') {
            let last = 0;
            for (let i = 0; i < len; i++) {
                const w = Math.random() * 2 - 1;
                last = (last + 0.02 * w) / 1.02;
                d[i] = last * 3.5;
            }
            this._brown2s = buf;
        } else {
            for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
            this._noise2s = buf;
        }
        return buf;
    }

    /** 声像节点工厂：调用方负责 .connect(目的地)；老 webview 无 pan 时给透明增益 */
    _pan(v) {
        if (this.ctx.createStereoPanner) {
            const p = this.ctx.createStereoPanner();
            p.pan.value = v;
            return p;
        }
        return this.ctx.createGain();
    }

    /** 程序化混响脉冲响应：指数衰减立体声噪声（大厂房空间感，无音频文件） */
    _makeIR(seconds, decayPow) {
        const sr = this.ctx.sampleRate;
        const len = Math.floor(sr * seconds);
        const buf = this.ctx.createBuffer(2, len, sr);
        for (let ch = 0; ch < 2; ch++) {
            const d = buf.getChannelData(ch);
            for (let i = 0; i < len; i++) {
                d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decayPow);
            }
        }
        return buf;
    }

    /** 把节点按 amount 比例送进厂房混响 */
    _reverbTap(node, amount) {
        if (!this.reverbSend) return;
        const g = this.ctx.createGain();
        g.gain.value = amount;
        node.connect(g);
        g.connect(this.reverbSend);
    }

    _src(buf, rate) {
        const s = this.ctx.createBufferSource();
        s.buffer = buf;
        s.loop = true;
        if (rate) s.playbackRate.value = rate;
        return s;
    }

    /* ---------- 昼床：车间金属敲击声浪（圣经§二第6条拟声词清单） ---------- */

    _startBed(which, t) {
        if (this.beds[which]) return;
        const bed = { gain: null, sources: [], timer: null };
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(which === 'day' ? 1 : 0.9, t + 2.5);
        g.connect(this.bus);
        bed.gain = g;
        this.beds[which] = bed;

        if (this.ambFiles[which] && !this._ambBroken[which]) this._buildFileBed(bed, which);
        else if (which === 'day') this._buildDayBed(bed, t);
        else this._buildNightBed(bed, t);
    }

    /**
     * 文件环境床：Seed Audio 生成的真实环境音，循环播放（缺文件/加载失败回退合成床）
     */
    _buildFileBed(bed, which) {
        const src = this.ambFiles[which];
        let el = this._ambEls[which];
        if (!el) {
            el = new Audio(src);
            el.loop = true;
            el.preload = 'auto';
            el.volume = 0.45;
            el.addEventListener('error', () => { this._ambBroken[which] = true; });
            this._ambEls[which] = el;
        }
        try {
            if (!this._ambNodes[which]) this._ambNodes[which] = this.ctx.createMediaElementSource(el);
            this._ambNodes[which].connect(bed.gain);
        } catch (e) {
            this._ambBroken[which] = true;
            if (which === 'day') this._buildDayBed(bed, this.ctx.currentTime);
            else this._buildNightBed(bed, this.ctx.currentTime);
            return;
        }
        bed.audioEl = el;
        const p = el.play();
        if (p && p.catch) p.catch(() => {});
    }

    _buildDayBed(bed, t) {
        // 层1：车床嗡嗡——纯同音+纯八度（严禁失谐：55/55.8Hz 拍频=0.8Hz 低频扑动，听久致晕）
        const humG = this.ctx.createGain();
        humG.gain.value = 0.028;
        const humLP = this.ctx.createBiquadFilter();
        humLP.type = 'lowpass';
        humLP.frequency.value = 140;
        [55, 110, 165].forEach((f, i) => {
            const o = this.ctx.createOscillator();
            o.type = i === 0 ? 'sawtooth' : 'sine';
            o.frequency.value = f;
            o.connect(humLP);
            o.start(t);
            bed.sources.push(o);
        });
        humLP.connect(humG);
        const breath = this.ctx.createOscillator();
        breath.type = 'sine';
        breath.frequency.value = 0.09;               // 呜……呜……慢起伏
        const breathG = this.ctx.createGain();
        breathG.gain.value = 0.008;
        breath.connect(breathG);
        breathG.connect(humG.gain);
        breath.start(t);
        bed.sources.push(breath);
        humG.connect(bed.gain);

        // 层2：极轻室内底噪
        const room = this._src(this._noiseBuffer('white'));
        const roomF = this.ctx.createBiquadFilter();
        roomF.type = 'lowpass';
        roomF.frequency.value = 420;
        const roomG = this.ctx.createGain();
        roomG.gain.value = 0.008;
        room.connect(roomF).connect(roomG).connect(bed.gain);
        room.start(t);
        bed.sources.push(room);

        // 层2.5：远处人声嗡嗡——压到只剩"有人在场"的暗示（持续含混人声=压抑源）
        const vox = this._src(this._noiseBuffer('white'));
        const vF1 = this.ctx.createBiquadFilter();
        vF1.type = 'bandpass'; vF1.frequency.value = 480; vF1.Q.value = 4;    // 元音腔A
        const vF2 = this.ctx.createBiquadFilter();
        vF2.type = 'bandpass'; vF2.frequency.value = 1150; vF2.Q.value = 5;   // 元音腔B
        const vG = this.ctx.createGain();
        vG.gain.value = 0.007;
        [[4.3, 0.002], [3.1, 0.002], [0.47, 0.002]].forEach(([fr, dp]) => {   // 音节律动减半
            const lfo = this.ctx.createOscillator();
            lfo.type = 'sine'; lfo.frequency.value = fr;
            const lg = this.ctx.createGain();
            lg.gain.value = dp;
            lfo.connect(lg); lg.connect(vG.gain);
            lfo.start(t);
            bed.sources.push(lfo);
        });
        vox.connect(vF1).connect(vG);
        vox.connect(vF2).connect(vG);
        vG.connect(this._pan(0.18)).connect(bed.gain);
        vox.start(t);
        bed.sources.push(vox);

        // 层3：随机金属事件调度器（前视式 lookahead，避免生硬循环感）
        const events = [
            { w: 30, fn: (tt) => this._fxClank(bed, tt) },        // 叮当锉击/敲击
            { w: 18, fn: (tt) => this._fxRivet(bed, tt) },        // 嗒嗒嗒铆枪
            { w: 16, fn: (tt) => this._fxSaw(bed, tt) },          // 嘶拉嘶拉锯床
            { w: 14, fn: (tt) => this._fxFile(bed, tt) },         // 锉刀刷刷
            { w: 12, fn: (tt) => this._fxWeld(bed, tt) },         // 滋滋电焊
            { w: 10, fn: (tt) => this._fxSqueal(bed, tt) },       // 哎—哎—哎插齿机
            { w: 10, fn: (tt) => this._fxShout(bed, tt) }         // 远处吆喝/招呼
        ];
        const totalW = events.reduce((s, e) => s + e.w, 0);
        let nextAt = t + 0.8 + Math.random() * 1.2;

        // 整床送入厂房混响（金属瞬态与人声在空间里展开）
        this._reverbTap(bed.gain, 0.35);

        const scheduleAhead = () => {
            if (this.beds.day !== bed || !this.ctx) return;
            const horizon = this.ctx.currentTime + 0.6;
            while (nextAt < horizon) {
                let r = Math.random() * totalW;
                for (const e of events) { r -= e.w; if (r <= 0) { e.fn(Math.max(nextAt, this.ctx.currentTime + 0.02)); break; } }
                nextAt += 2.2 + Math.random() * 3.0;   // 平均每 ~3.7 秒一件车间事（原 2 秒过密致疲劳）
            }
            bed.timer = setTimeout(scheduleAhead, 250);
        };
        scheduleAhead();
    }

    /* 车间单事件合成器们（全部短命节点，播完自灭） */

    _fxClank(bed, t) { // 叮当——bandpass 噪声瞬态 + 两枚失谐金属泛音
        const f = 1300 + Math.random() * 2600;
        const n = this.ctx.createBufferSource();
        n.buffer = this._noiseBuffer('white');
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 9;
        const ng = this.ctx.createGain();
        ng.gain.setValueAtTime(0.0001, t);
        ng.gain.linearRampToValueAtTime(0.07 + Math.random() * 0.06, t + 0.003);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
        n.connect(bp).connect(ng).connect(this._pan(Math.random() * 1.6 - 0.8)).connect(bed.gain);
        n.start(t, Math.random()); n.stop(t + 0.08);
        [1, 2.51].forEach((ratio, i) => {
            const o = this.ctx.createOscillator();
            o.type = 'sine';
            o.frequency.value = f * ratio * (0.995 + Math.random() * 0.01);
            const og = this.ctx.createGain();
            const peak = (i === 0 ? 0.05 : 0.02) + Math.random() * 0.03;
            og.gain.setValueAtTime(peak, t);
            og.gain.exponentialRampToValueAtTime(0.0001, t + 0.12 + Math.random() * 0.15);
            o.connect(og).connect(this._pan(Math.random() * 1.2 - 0.6)).connect(bed.gain);
            o.start(t); o.stop(t + 0.35);
        });
    }

    _fxRivet(bed, t) { // 嗒嗒嗒——连发钢钉
        const shots = 7 + Math.floor(Math.random() * 8);
        const gap = 0.048 + Math.random() * 0.022;
        const pan = this._pan(Math.random() * 1.4 - 0.7);
        pan.connect(bed.gain);
        for (let i = 0; i < shots; i++) {
            const tt = t + i * gap;
            const n = this.ctx.createBufferSource();
            n.buffer = this._noiseBuffer('white');
            const hp = this.ctx.createBiquadFilter();
            hp.type = 'highpass'; hp.frequency.value = 3200;
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0.075, tt);
            g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.018);
            n.connect(hp).connect(g).connect(pan);
            n.start(tt, Math.random()); n.stop(tt + 0.03);
            const body = this.ctx.createOscillator();
            body.type = 'sine'; body.frequency.value = 210;
            const bg = this.ctx.createGain();
            bg.gain.setValueAtTime(0.028, tt);
            bg.gain.exponentialRampToValueAtTime(0.0001, tt + 0.03);
            body.connect(bg).connect(pan);
            body.start(tt); body.stop(tt + 0.04);
        }
    }

    _fxSaw(bed, t) { // 嘶拉嘶拉——AM 方波描摹往复锯程
        const dur = 0.7 + Math.random() * 0.7;
        const n = this._src(this._noiseBuffer('white'));
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 1000 + Math.random() * 500; bp.Q.value = 1.2;
        const g = this.ctx.createGain();
        g.gain.value = 0.0001;
        const lfo = this.ctx.createOscillator();
        lfo.type = 'square'; lfo.frequency.value = 8 + Math.random() * 4; // 每秒 8-12 个来回
        const lfoG = this.ctx.createGain();
        lfoG.gain.value = 0.022;
        lfo.connect(lfoG).connect(g.gain);
        g.gain.setValueAtTime(0.026, t);
        g.gain.setValueAtTime(0.026, t + dur - 0.08);
        g.gain.linearRampToValueAtTime(0.0001, t + dur);
        n.connect(bp).connect(g).connect(this._pan(Math.random() * 1.2 - 0.6)).connect(bed.gain);
        n.start(t, Math.random()); n.stop(t + dur + 0.05);
        lfo.start(t); lfo.stop(t + dur + 0.05);
    }

    _fxFile(bed, t) { // 锉刀——4~6 下短促刷擦
        const strokes = 4 + Math.floor(Math.random() * 3);
        const pan = this._pan(Math.random() * 1.2 - 0.6);
        pan.connect(bed.gain);
        for (let i = 0; i < strokes; i++) {
            const tt = t + i * (0.11 + Math.random() * 0.05);
            const n = this.ctx.createBufferSource();
            n.buffer = this._noiseBuffer('white');
            const bp = this.ctx.createBiquadFilter();
            bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 2;
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0.0001, tt);
            g.gain.linearRampToValueAtTime(0.045, tt + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.09);
            n.connect(bp).connect(g).connect(pan);
            n.start(tt, Math.random()); n.stop(tt + 0.1);
        }
    }

    _fxWeld(bed, t) { // 滋滋——高频噪声 + 随机爆点阶跃
        const dur = 0.9 + Math.random() * 1.1;
        const n = this._src(this._noiseBuffer('white'));
        const hp = this.ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 4800;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.014, t);
        let cur = t + 0.05;
        while (cur < t + dur) {                       // 电弧噼啪：随机微爆
            g.gain.setValueAtTime(0.008 + Math.random() * 0.05, cur);
            cur += 0.03 + Math.random() * 0.09;
        }
        g.gain.setValueAtTime(0.014, t + dur);
        g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.1);
        n.connect(hp).connect(g).connect(this._pan(Math.random() * 1.2 - 0.6)).connect(bed.gain);
        n.start(t, Math.random()); n.stop(t + dur + 0.15);
    }

    _fxSqueal(bed, t) { // 哎—哎—哎——插齿机三连下滑呻吟
        const pan = this._pan(Math.random() * 1.0 - 0.5);
        pan.connect(bed.gain);
        for (let i = 0; i < 3; i++) {
            const tt = t + i * 0.52;
            const o = this.ctx.createOscillator();
            o.type = 'sawtooth';
            const f = 330 + Math.random() * 60;
            o.frequency.setValueAtTime(f, tt);
            o.frequency.exponentialRampToValueAtTime(f * 0.82, tt + 0.34);
            const bp = this.ctx.createBiquadFilter();
            bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 6;
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0.0001, tt);
            g.gain.linearRampToValueAtTime(0.024, tt + 0.05);
            g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.38);
            o.connect(bp).connect(g).connect(pan);
            o.start(tt); o.stop(tt + 0.42);
        }
    }

    _fxShout(bed, t) { // 远处吆喝/招呼——短语形包络+语调上扬，重混响送出厂房空间感
        const dur = 0.45 + Math.random() * 0.35;
        const n = this._src(this._noiseBuffer('white'));
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.Q.value = 2.2;
        bp.frequency.setValueAtTime(520, t);
        bp.frequency.exponentialRampToValueAtTime(760 + Math.random() * 220, t + dur); // 上扬
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.042, t + 0.05);
        const sylls = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < sylls; i++) {                  // 音节起伏
            const st = t + 0.08 + i * (dur - 0.15) / sylls;
            g.gain.setValueAtTime(0.055, st);
            g.gain.linearRampToValueAtTime(0.028, st + 0.07);
        }
        g.gain.setValueAtTime(0.03, t + dur - 0.06);
        g.gain.linearRampToValueAtTime(0.0001, t + dur);
        const pan = this._pan(Math.random() * 1.4 - 0.7);
        pan.connect(bed.gain);
        n.connect(bp).connect(g).connect(pan);
        this._reverbTap(g, 0.8);
        n.start(t, Math.random()); n.stop(t + dur + 0.05);
    }

    /* ---------- 夜床：虫鸣 + 远犬 ---------- */

    _buildNightBed(bed, t) {
        // 夜气底噪：布朗噪声缓动
        const air = this._src(this._noiseBuffer('brown'));
        const airF = this.ctx.createBiquadFilter();
        airF.type = 'lowpass'; airF.frequency.value = 240;
        const airG = this.ctx.createGain();
        airG.gain.value = 0.012;
        air.connect(airF).connect(airG).connect(bed.gain);
        air.start(t);
        bed.sources.push(air);

        /* ---- 蝉鸣层：三组窄共振噪声带模拟满树蝉的振翅颤音 ----
           噪声过窄带=有音高的"嘶"底；快LFO(30-60Hz)=振翅颗粒感；
           慢LFO=各自涨落不同步；总闸极慢呼吸=蝉声整体偶尔落下去再起 */
        const cicBreath = this.ctx.createGain();
        cicBreath.gain.value = 1;
        const breathL = this.ctx.createOscillator();
        breathL.type = 'sine'; breathL.frequency.value = 0.031;
        const breathG = this.ctx.createGain();
        breathG.gain.value = 0.32;
        breathL.connect(breathG); breathG.connect(cicBreath.gain);
        breathL.start(t);
        bed.sources.push(breathL);
        cicBreath.connect(bed.gain);

        [4200, 5150, 6350].forEach((f, i) => {
            const n = this._src(this._noiseBuffer('white'));
            const bp = this.ctx.createBiquadFilter();
            bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 14;
            const g = this.ctx.createGain();
            const base = 0.0052 + i * 0.0013;
            g.gain.value = base;
            const fl = this.ctx.createOscillator();          // 振翅颤音
            fl.type = 'sine'; fl.frequency.value = 34 + i * 13;
            const flg = this.ctx.createGain();
            flg.gain.value = base * 0.5;                     // 保证增益恒为正
            fl.connect(flg); flg.connect(g.gain);
            fl.start(t);
            const sw = this.ctx.createOscillator();          // 个体慢涨落
            sw.type = 'sine'; sw.frequency.value = 0.05 + i * 0.021;
            const swg = this.ctx.createGain();
            swg.gain.value = base * 0.4;
            sw.connect(swg); swg.connect(g.gain);
            sw.start(t);
            n.connect(bp).connect(g).connect(cicBreath);
            n.start(t);
            bed.sources.push(n, fl, sw);
        });

        /* ---- 风两层：低频阵风(布朗噪声低通游走) + 高频风哨；阵风调度器统一驱动 ---- */
        const wLow = this._src(this._noiseBuffer('brown'));
        const wLP = this.ctx.createBiquadFilter();
        wLP.type = 'lowpass'; wLP.frequency.value = 210;
        const wG = this.ctx.createGain();
        wG.gain.value = 0.009;
        wLow.connect(wLP).connect(wG).connect(bed.gain);
        wLow.start(t);
        bed.sources.push(wLow);

        const wHi = this._src(this._noiseBuffer('white'));
        const wBP = this.ctx.createBiquadFilter();
        wBP.type = 'bandpass'; wBP.frequency.value = 880; wBP.Q.value = 0.7;
        const wHG = this.ctx.createGain();
        wHG.gain.value = 0.0035;
        wHi.connect(wBP).connect(wHG).connect(bed.gain);
        wHi.start(t);
        bed.sources.push(wHi);

        bed.windTimer = null;
        const gust = () => {                              // 一阵阵的风：起→停随机间隔
            if (this.beds.night !== bed || !this.ctx) return;
            const nowT = this.ctx.currentTime;
            const r = Math.random();
            wG.gain.setTargetAtTime(0.016 + r * 0.022, nowT, 1.2 + r * 1.4);
            wHG.gain.setTargetAtTime(0.007 + r * 0.008, nowT, 1.0);
            wLP.frequency.setTargetAtTime(250 + r * 260, nowT, 1.6);
            setTimeout(() => {
                if (this.beds.night !== bed || !this.ctx) return;
                const backT = this.ctx.currentTime;
                wG.gain.setTargetAtTime(0.009, backT, 2.2);
                wHG.gain.setTargetAtTime(0.0035, backT, 2.0);
                wLP.frequency.setTargetAtTime(210, backT, 2.4);
            }, 2600 + r * 2800);
            bed.windTimer = setTimeout(gust, 6500 + Math.random() * 10000);
        };
        bed.windTimer = setTimeout(gust, 1800 + Math.random() * 2500);

        /* ---- 蛐蛐：一近一远两只（远的被夜气滤掉高频），节奏各自独立 ---- */
        bed.cricketTimers = [];
        [{ panV: -0.55, far: false, lo: 900, hi: 3200 },
         { panV: 0.75, far: true, lo: 1500, hi: 4300 }].forEach((c, i) => {
            const chirp = () => {
                if (this.beds.night !== bed || !this.ctx) return;
                this._fxCricket(bed, this.ctx.currentTime + 0.02, c.panV, c.far);
                bed.cricketTimers[i] = setTimeout(chirp, c.lo + Math.random() * (c.hi - c.lo));
            };
            bed.cricketTimers[i] = setTimeout(chirp, 500 + i * 900 + Math.random() * 1200);
        });

        // 远犬：14~34 秒一声，带回声距离感
        const bark = () => {
            if (this.beds.night !== bed || !this.ctx) return;
            this._fxBark(bed, this.ctx.currentTime + 0.05);
            bed.dogTimer = setTimeout(bark, 14000 + Math.random() * 20000);
        };
        bed.dogTimer = setTimeout(bark, 5000 + Math.random() * 8000);
    }

    _fxCricket(bed, t, panV, far) { // 蛐蛐：脉冲串，每下带轻微下滑更接近真虫；far=远处个体
        const pulses = 4 + Math.floor(Math.random() * 5);
        const f = 3800 + Math.random() * 1400;
        const pan = this._pan(panV + Math.random() * 0.2 - 0.1);
        if (far) {
            const lpF = this.ctx.createBiquadFilter();
            lpF.type = 'lowpass'; lpF.frequency.value = 2600;
            pan.connect(lpF); lpF.connect(bed.gain);
        } else {
            pan.connect(bed.gain);
        }
        const peak = far ? 0.02 : 0.04;
        for (let i = 0; i < pulses; i++) {
            const tt = t + i * 0.036;
            const o = this.ctx.createOscillator();
            o.type = 'sine';
            o.frequency.setValueAtTime(f * (1.02 + Math.random() * 0.03), tt);
            o.frequency.exponentialRampToValueAtTime(f * 0.93, tt + 0.024);   // 每下微微下滑
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0.0001, tt);
            g.gain.linearRampToValueAtTime(peak * (0.8 + Math.random() * 0.4), tt + 0.004);
            g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.027);
            o.connect(g).connect(pan);
            o.start(tt); o.stop(tt + 0.035);
        }
    }

    _fxBark(bed, t) { // 远犬：1~3 声低闷吠 + 反馈延迟做距离
        const woofs = 1 + Math.floor(Math.random() * 3);
        const panV = Math.random() * 1.6 - 0.8;
        // 汇入点：有立体声能力时经声像，否则直连
        const srcBus = this.ctx.createGain();
        let head = srcBus;
        if (this.ctx.createStereoPanner) {
            head = this.ctx.createStereoPanner();
            head.pan.value = panV;
            srcBus.connect(head);
        }
        // 干声（近）+ 延迟反馈湿声（远处的回响）
        const dry = this.ctx.createGain(); dry.gain.value = 0.5;
        head.connect(dry); dry.connect(bed.gain);
        const delay = this.ctx.createDelay(1); delay.delayTime.value = 0.27;
        const fb = this.ctx.createGain(); fb.gain.value = 0.38;
        const wetF = this.ctx.createBiquadFilter();
        wetF.type = 'lowpass'; wetF.frequency.value = 800;
        const wet = this.ctx.createGain(); wet.gain.value = 0.45;
        head.connect(delay); delay.connect(fb); fb.connect(delay);
        delay.connect(wetF); wetF.connect(wet); wet.connect(bed.gain);

        for (let i = 0; i < woofs; i++) {
            const tt = t + i * 0.36;
            const o = this.ctx.createOscillator();
            o.type = 'sawtooth';
            o.frequency.setValueAtTime(270, tt);
            o.frequency.exponentialRampToValueAtTime(150, tt + 0.09);
            const lp = this.ctx.createBiquadFilter();
            lp.type = 'lowpass'; lp.frequency.value = 650;
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0.0001, tt);
            g.gain.linearRampToValueAtTime(0.09, tt + 0.015);
            g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.13);
            o.connect(lp).connect(g).connect(srcBus);
            o.start(tt); o.stop(tt + 0.16);
        }
        setTimeout(() => {
            [srcBus, dry, delay, fb, wetF, wet].forEach(n => { try { n.disconnect(); } catch (e) {} });
            if (head !== srcBus) { try { head.disconnect(); } catch (e) {} }
        }, woofs * 360 + 1800);
    }

    _stopBed(which, t, fadeSec) {
        const bed = this.beds[which];
        if (!bed) return;
        delete this.beds[which];
        if (bed.timer) clearTimeout(bed.timer);
        if (bed.dogTimer) clearTimeout(bed.dogTimer);
        if (bed.windTimer) clearTimeout(bed.windTimer);
        (bed.cricketTimers || []).forEach(id => clearTimeout(id));
        const g = bed.gain;
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + fadeSec);
        bed.sources.forEach(s => { try { s.stop(t + fadeSec + 0.1); } catch (e) {} });
        setTimeout(() => { try { g.disconnect(); } catch (e) {} }, (fadeSec + 0.3) * 1000);
        if (bed.audioEl) { const el = bed.audioEl; setTimeout(() => { try { el.pause(); } catch (e) {} }, fadeSec * 1000); }
    }

    /* ==================== UI 反馈音（05 D5 第②层） ==================== */

    playPaperFlip() { // 翻纸沙沙——节点推进
        if (!this.ready()) return;
        const t = this.ctx.currentTime;
        const n = this.ctx.createBufferSource();
        n.buffer = this._noiseBuffer('white');
        const hp = this.ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 1100;
        const g = this.ctx.createGain();
        // sha-sha 双峰
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.11, t + 0.02);
        g.gain.linearRampToValueAtTime(0.03, t + 0.06);
        g.gain.linearRampToValueAtTime(0.09, t + 0.09);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
        n.connect(hp).connect(g).connect(this._pan(Math.random() * 0.5 - 0.25)).connect(this.bus);
        n.start(t, Math.random()); n.stop(t + 0.2);
    }

    playStampThud() { // 图章咚——选择确认，与震屏同帧调用
        if (!this.ready()) return;
        const t = this.ctx.currentTime;
        // 主体：低频砸落
        const o = this.ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(165, t);
        o.frequency.exponentialRampToValueAtTime(52, t + 0.09);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.55, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
        o.connect(g).connect(this.bus);
        o.start(t); o.stop(t + 0.22);
        // 印泥接触瞬态 + 纸面拍击尾
        const n = this.ctx.createBufferSource();
        n.buffer = this._noiseBuffer('white');
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 1.5;
        const ng = this.ctx.createGain();
        ng.gain.setValueAtTime(0.18, t);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
        n.connect(bp).connect(ng).connect(this.bus);
        n.start(t, Math.random()); n.stop(t + 0.08);
    }

    playPencilScratch(duration = 0.5) { // 铅笔沙沙——书写/标注
        if (!this.ready()) return;
        const t = this.ctx.currentTime;
        const dur = Math.max(0.15, Math.min(2, duration));
        const n = this._src(this._noiseBuffer('white'));
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 1.1;
        const grit = this.ctx.createBiquadFilter();
        grit.type = 'highpass'; grit.frequency.value = 5200;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        // 笔画轻重随机游走
        let cur = t;
        while (cur < t + dur) {
            const seg = 0.04 + Math.random() * 0.08;
            g.gain.linearRampToValueAtTime(0.02 + Math.random() * 0.075, cur + seg);
            cur += seg;
        }
        g.gain.linearRampToValueAtTime(0.0001, cur + 0.05);
        n.connect(bp).connect(g).connect(this.bus);
        n.connect(grit).connect(g);
        n.start(t, Math.random()); n.stop(cur + 0.1);
    }

    playSlideRuleClick(double = false) { // 算尺咔哒——滑尺对位（double=长滑三连）
        if (!this.ready()) return;
        const times = double ? [0, 0.07, 0.13] : [0];
        const t0 = this.ctx.currentTime;
        times.forEach((off, i) => {
            const t = t0 + off;
            const n = this.ctx.createBufferSource();
            n.buffer = this._noiseBuffer('white');
            const hp = this.ctx.createBiquadFilter();
            hp.type = 'highpass'; hp.frequency.value = 3000;
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0.13 - i * 0.02, t);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.014);
            n.connect(hp).connect(g).connect(this.bus);
            n.start(t, Math.random()); n.stop(t + 0.02);
            const blip = this.ctx.createOscillator();
            blip.type = 'square'; blip.frequency.value = 1400;
            const bg = this.ctx.createGain();
            bg.gain.setValueAtTime(0.02, t);
            bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
            blip.connect(bg).connect(this.bus);
            blip.start(t); blip.stop(t + 0.015);
        });
    }

    playBlueprintUnroll(duration = 0.85) { // 图纸展开摩擦——预知卡抽出
        if (!this.ready()) return;
        const t = this.ctx.currentTime;
        const dur = Math.max(0.4, Math.min(1.6, duration));
        const n = this._src(this._noiseBuffer('white'));
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(500, t);          // 卷着的纸：闷
        lp.frequency.exponentialRampToValueAtTime(3600, t + dur); // 展开渐亮
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.12, t + 0.06);
        // 中途两三下纸纹脆响
        const crinkles = 2 + Math.floor(Math.random() * 2);
        for (let i = 0; i < crinkles; i++) {
            const ct = t + dur * (0.25 + Math.random() * 0.6);
            g.gain.setValueAtTime(0.19 + Math.random() * 0.06, ct);
            g.gain.linearRampToValueAtTime(0.09, ct + 0.05);
        }
        g.gain.setValueAtTime(0.08, t + dur - 0.04);
        g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.06);
        n.connect(lp).connect(g).connect(this._pan(Math.random() * 0.4 - 0.2)).connect(this.bus);
        n.start(t, Math.random()); n.stop(t + dur + 0.12);
    }

    /* ==================== 循环结算：开炉电铃（05 D5 第③层） ==================== */

    /**
     * 史实开炉电铃：铃串六击 + 电机嗡底。WEEK_SETTLE 自动触发（每周期一次），
     * 读档恢复不重放。也可手动调用。
     */
    playSettleBell() {
        if (!this.ready()) return;
        const t0 = this.ctx.currentTime + 0.02;
        // 汇入总线 + 厂房混响（车间里的电铃）
        const out = this.ctx.createGain();
        out.gain.value = 1;
        out.connect(this.bus);
        this._reverbTap(out, 0.55);
        // 铃体泛音组（非整数倍频=金属钟感）
        const partials = [
            { r: 1.000, g: 0.32, d: 1.35 },
            { r: 2.756, g: 0.17, d: 0.95 },
            { r: 5.404, g: 0.09, d: 0.62 },
            { r: 8.933, g: 0.05, d: 0.40 }
        ];
        const strikes = 6, gap = 0.42;
        for (let s = 0; s < strikes; s++) {
            const t = t0 + s * gap;
            const detune = 0.996 + Math.random() * 0.008; // 机械敲击的微小不一致
            partials.forEach(p => {
                const o = this.ctx.createOscillator();
                o.type = 'sine';
                o.frequency.value = 1080 * p.r * detune;
                const g = this.ctx.createGain();
                g.gain.setValueAtTime(0.0001, t);
                g.gain.linearRampToValueAtTime(p.g, t + 0.004);
                g.gain.exponentialRampToValueAtTime(0.0001, t + p.d);
                o.connect(g).connect(out);
                o.start(t); o.stop(t + p.d + 0.05);
            });
        }
        // 电机嗡底（电铃是电动的）
        const motor = this.ctx.createOscillator();
        motor.type = 'sawtooth'; motor.frequency.value = 100;
        const mg = this.ctx.createGain();
        mg.gain.setValueAtTime(0.0001, t0);
        mg.gain.linearRampToValueAtTime(0.018, t0 + 0.1);
        mg.gain.setValueAtTime(0.018, t0 + strikes * gap - 0.1);
        mg.gain.exponentialRampToValueAtTime(0.0001, t0 + strikes * gap + 0.3);
        motor.connect(mg).connect(out);
        motor.start(t0); motor.stop(t0 + strikes * gap + 0.35);
    }

    /* ==================== 机制联动（05 D5 ①②） ==================== */

    ready() { return !!(this.ctx && !this.muted); }

    /**
     * 偏离度快照 → 两条联动。由 attachLoop 的 onChange 自动喂；
     * 测试/调试可手动调。
     * @param {number} dev 偏离度 0-100
     */
    updateDeviation(dev) {
        if (typeof dev !== 'number' || isNaN(dev)) return;
        this.deviation = Math.max(0, Math.min(100, dev));
        const { warning, erase, drift } = this.thresholds;
        if (!this.ctx) return;
        const now = this.ctx.currentTime;

        // ① 全局低通：≥warning 开始收窄，到 erase 收至 ~650Hz（值不变则跳过，防高频调度抖动）
        let cutoff = 19500;
        if (this.deviation >= warning) {
            const t = Math.min(1, (this.deviation - warning) / Math.max(1, erase - warning));
            cutoff = 19500 * Math.exp(t * Math.log(650 / 19500));
        }
        if (Math.abs(cutoff - this._lastCutoff) > 1) {
            this.globalLowpass.frequency.cancelScheduledValues(now);
            this.globalLowpass.frequency.setTargetAtTime(cutoff, now, 0.4);
            this._lastCutoff = cutoff;
        }

        // ② 耳鸣常驻层：≥drift 渐入，向 erase 渐强（封顶很轻——12k 很刺耳）
        let tin = 0;
        if (this.deviation >= drift) {
            tin = Math.min(1, (this.deviation - drift) / Math.max(1, erase - drift)) * 0.022;
        }
        if (Math.abs(tin - this._lastTin) > 0.0004) {
            this.tinnitusGain.gain.setTargetAtTime(tin, now, 0.8);
            this._lastTin = tin;
        }
    }

    /**
     * 剧情节点耳鸣接口（05 D5②「绑定剧情节点」）：一次性渐入-保持-渐出。
     * 直接接 masterGain 绕过全局低通——世界越来越闷，但颅内的鸣响始终清晰。
     * 内容线在剧情 JSON 的效果脚本里调用：
     *   window.game.audioManager.playTinnitusBurst({ attack: 2, hold: 1.5, release: 4 })
     * @param {object} opts { attack=1.5, hold=0.8, release=3, level=0.03 }
     */
    playTinnitusBurst(opts = {}) {
        if (!this.ctx) return;
        const attack = opts.attack ?? 1.5;
        const hold = opts.hold ?? 0.8;
        const release = opts.release ?? 3;
        const level = Math.min(0.05, opts.level ?? 0.03);
        const t = this.ctx.currentTime;
        const o = this.ctx.createOscillator();
        o.type = 'sine'; o.frequency.value = 12000;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(level, t + attack);
        g.gain.setValueAtTime(level, t + attack + hold);
        g.gain.linearRampToValueAtTime(0.0001, t + attack + hold + release);
        o.connect(g).connect(this.masterGain);
        o.start(t); o.stop(t + attack + hold + release + 0.1);
        this._tinnitusBurstCount++;
    }

    /* ==================== 打字机 & blip（保留原契约，改接总线受全局低通影响） ==================== */

    playType() {
        if (!this.ready()) return;
        const now = this.ctx.currentTime;
        const bufferSize = Math.floor(this.ctx.sampleRate * 0.03);
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
        }
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 1800;
        filter.Q.value = 0.8;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
        src.connect(filter).connect(gain).connect(this.bus);
        src.start(now);
        src.stop(now + 0.04);
    }

    playBlip(speaker = 'default') {
        if (!this.ready()) return;
        const now = this.ctx.currentTime;
        if (now - this.lastBlipTime < 0.045) return;
        this.lastBlipTime = now;
        let base = this.speakerPitch[speaker] ?? this.speakerPitch.default;
        if (!base) base = this.speakerPitch.default;
        const freq = base * (0.94 + Math.random() * 0.12);
        const osc = this.ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = freq;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.09, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
        osc.connect(gain).connect(this.bus);
        osc.start(now);
        osc.stop(now + 0.07);
    }
}

// 命名空间挂载
window.game = window.game || {};
window.game.AudioManager = AudioManager;
