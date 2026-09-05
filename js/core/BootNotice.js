/**
 * BootNotice - 非阻塞页面通知（替代 window.alert）
 *
 * 背景：headless Edge/Chrome 对未处理的 window.alert 会无限期挂起
 * （等待对话框事件），导致自动化测试/截图全部卡死。
 * 本模块以 DOM 遮罩卡片替代：可点击关闭、自动留痕 console.error，
 * 且不依赖任何其他模块（启动早期可用）。
 */
class BootNotice {

    /** 确保样式与容器存在（幂等） */
    static ensure() {
        if (window.__bootNoticeRoot) return window.__bootNoticeRoot;
        if (!document.getElementById('bootnotice-style')) {
            const st = document.createElement('style');
            st.id = 'bootnotice-style';
            st.textContent = `
#bootnotice-overlay{position:fixed;inset:0;background:#000a;z-index:10000;
  display:flex;align-items:center;justify-content:center;padding:20px}
#bootnotice-card{max-width:520px;width:100%;background:#f2e8d5;color:#4a3820;
  border:3px solid #6b5236;border-radius:10px;padding:18px 20px;
  box-shadow:0 12px 48px #000d;font:14px/1.7 "Microsoft YaHei",sans-serif}
#bootnotice-card h3{margin:0 0 8px;font-size:15px}
#bootnotice-card .bn-msg{white-space:pre-wrap;word-break:break-all;margin-bottom:14px}
#bootnote-card,#bootnotice-card button{padding:6px 30px;border-radius:6px;
  border:1px solid #6b5236;background:#8b6f47;color:#f7eeda;cursor:pointer;font-size:13px}
#bootnotice-card button:hover{background:#9c7e54}
`;
            document.head.appendChild(st);
        }
        const root = document.createElement('div');
        root.id = 'bootnotice-overlay';
        root.innerHTML = `<div id="bootnotice-card"><h3>提示</h3><div class="bn-msg"></div><button>知道了</button></div>`;
        root.querySelector('button').addEventListener('click', () => root.remove());
        document.body.appendChild(root);
        window.__bootNoticeRoot = root;
        return root;
    }

    /**
     * 显示非阻塞通知
     * @param {string} title 标题
     * @param {string} msg 正文（支持 \n）
     */
    static show(title, msg) {
        try {
            const root = BootNotice.ensure();
            root.querySelector('h3').textContent = title || '提示';
            root.querySelector('.bn-msg').textContent = msg || '';
            console.error('[BootNotice]', title, '|', msg);
        } catch (e) {
            // DOM 不可用（极早期/headless dump 场景）至少留痕
            console.error('[BootNotice]', title, '|', msg, '| fallback:', e.message);
        }
    }
}

// 全局便捷入口（供各模块零依赖调用）
window.game = window.game || {};
window.game.BootNotice = BootNotice;
window.bootNotice = (title, msg) => BootNotice.show(title, msg);
