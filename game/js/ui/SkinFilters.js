/**
 * SkinFilters.js —— 皮肤线：SVG 滤镜库注入 + 排版工具（步骤05）
 *
 * 职责：
 * 1. 向 <body> 注入全局 SVG <defs>（feTurbulence 滤镜库）。
 *    内联注入而非外部 .svg 文件——file:// 直开与微信 H5 下
 *    Chrome 内核对 filter:url(外部文件#id) 支持不稳，内联最可靠。
 *    tokens.css 的 --filter-* 变量引用此处 id（skin- 前缀防冲突）。
 * 2. window.SkinFormat.dateCN() —— 阿拉伯日期 → 汉字日期（D3 排版语法）。
 * 3. window.SkinMode —— 档案/蓝晒/捷报三模式切换助手（D1）。
 *
 * 本文件属皮肤线所有物（js/ui 皮肤相关部分）；不依赖任何引擎模块，
 * 不修改引擎文件；引擎侧如需模式联动，经 SkinMode API 订阅即可。
 */
(function () {
    'use strict';

    /* ---------------- SVG 滤镜库（注入一次） ---------------- */

    var FILTER_DEFS =
        '<svg class="skin-filter-defs" aria-hidden="true" focusable="false" ' +
        'style="position:absolute;width:0;height:0;overflow:hidden">' +
        '<defs>' +

        /* 印章残边：低频湍流位移，让章缘出现断续缺口 */
        '<filter id="skin-stamp-rough" x="-8%" y="-8%" width="116%" height="116%">' +
        '<feTurbulence type="fractalNoise" baseFrequency="0.11" numOctaves="3" seed="7" result="n"/>' +
        '<feDisplacementMap in="SourceGraphic" in2="n" scale="2.6" xChannelSelector="R" yChannelSelector="G"/>' +
        '</filter>' +

        /* 铅字洇墨：高频微位移，模拟油墨渗透不匀 */
        '<filter id="skin-ink-bleed" x="-4%" y="-4%" width="108%" height="108%">' +
        '<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" result="n"/>' +
        '<feDisplacementMap in="SourceGraphic" in2="n" scale="1.1" xChannelSelector="R" yChannelSelector="G"/>' +
        '</filter>' +

        /* 蓝晒涂布感：湍流+光照，药膜不匀的高光 */
        '<filter id="skin-blueprint-coat">' +
        '<feTurbulence type="fractalNoise" baseFrequency="0.32" numOctaves="3" seed="11" result="n"/>' +
        '<feDiffuseLighting in="n" lighting-color="#ffffff" surfaceScale="0.8" diffuseConstant="1.1" result="l">' +
        '<feDistantLight azimuth="235" elevation="62"/>' +
        '</feDiffuseLighting>' +
        '<feComposite in="l" in2="SourceGraphic" operator="arithmetic" k1="0.9" k2="0" k3="0.15" k4="0"/>' +
        '</filter>' +

        /* 毛边裁切：供 SVG mask 场景复用（元素级毛边见 tokens.css .deckle） */
        '<filter id="skin-deckle" x="-3%" y="-3%" width="106%" height="106%">' +
        '<feTurbulence type="fractalNoise" baseFrequency="0.12" numOctaves="2" seed="7" result="n"/>' +
        '<feDisplacementMap in="SourceGraphic" in2="n" scale="6" xChannelSelector="R" yChannelSelector="G"/>' +
        '</filter>' +

        '</defs></svg>';

    function injectFilters() {
        if (document.querySelector('.skin-filter-defs')) return;
        var holder = document.createElement('div');
        holder.innerHTML = FILTER_DEFS;
        document.body.appendChild(holder.firstChild);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectFilters, { once: true });
    } else {
        injectFilters();
    }

    /* ---------------- 排版工具：汉字日期（D3 排版语法） ---------------- */

    var CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

    /** 1-31 日 → 十日/十四日/二十日/二十一日 … */
    function cnDay(n) {
        if (n <= 10) return n === 10 ? '十' : CN_DIGITS[n];
        var tens = Math.floor(n / 10), ones = n % 10;
        return (tens > 1 ? CN_DIGITS[tens] : '') + '十' + (ones ? CN_DIGITS[ones] : '');
    }

    var SkinFormat = {
        /**
         * 1958, 7, 10 → "一九五八年七月十日"
         * @returns {string} 入参非法返回 null（调用方自行回退原样显示）
         */
        dateCN: function (year, month, day) {
            year = +year; month = +month; day = +day;
            if (!(year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
            var y = String(year).split('').map(function (d) { return CN_DIGITS[+d]; }).join('');
            var m = month <= 10 ? (month === 10 ? '十' : CN_DIGITS[month]) : '十' + CN_DIGITS[month - 10];
            return y + '年' + m + '月' + cnDay(day) + '日';
        }
    };

    /* ---------------- 模式切换助手（D1 双模式体系） ---------------- */

    var MODES = ['archive', 'blueprint', 'redbullet'];
    var listeners = [];

    var SkinMode = {
        MODES: MODES.slice(),
        /** 当前模式名；无类 = 'archive' */
        get: function () {
            var b = document.body;
            for (var i = 0; i < MODES.length; i++) {
                if (b.classList.contains('mode-' + MODES[i])) return MODES[i];
            }
            return 'archive';
        },
        /**
         * 切换模式：body.mode-* 换类（tokens.css 变量重映射随之生效）
         * @param {'archive'|'blueprint'|'redbullet'} name
         */
        set: function (name) {
            if (MODES.indexOf(name) < 0) return false;
            MODES.forEach(function (m) { document.body.classList.remove('mode-' + m); });
            document.body.classList.add('mode-' + name);
            listeners.forEach(function (cb) { try { cb(name); } catch (e) { console.error(e); } });
            return true;
        },
        /** 循环切换（演示用） */
        cycle: function () {
            var next = MODES[(MODES.indexOf(this.get()) + 1) % MODES.length];
            this.set(next);
            return next;
        },
        /** 订阅模式变更（步骤07 音床联动等） */
        onChange: function (cb) { listeners.push(cb); }
    };

    window.SkinFormat = SkinFormat;
    window.SkinMode = SkinMode;
})();
