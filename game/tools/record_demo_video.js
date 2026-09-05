const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const OUT_DIR = path.resolve(__dirname, '..', 'recordings');
const RAW = path.join(OUT_DIR, '一程山路_2分钟因果演示_无声.webm');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function caption(page, kicker, title, detail = '') {
    await page.evaluate(({ kicker, title, detail }) => {
        document.getElementById('record-caption')?.remove();
        const el = document.createElement('div');
        el.id = 'record-caption';
        el.innerHTML = `<small>${kicker}</small><strong>${title}</strong>${detail ? `<span>${detail}</span>` : ''}`;
        document.body.appendChild(el);
    }, { kicker, title, detail });
}

async function jump(page, nodeId, state = {}) {
    const data = { stamina: 4, integration: 0, deviation: 0, flags: {}, ...state, nodeId };
    await page.evaluate(({ nodeId, stamina, integration, deviation, flags }) => {
        ['crisis-brief-overlay', 'intervention-confirm-overlay', 'record-intro'].forEach(id => document.getElementById(id)?.remove());
        document.querySelectorAll('.feedback-overlay,.choice-feedback-overlay').forEach(el => el.remove());
        const { attributeManager: am, storyEngine: se, uiManager: ui } = window.game;
        am.attributes.stamina.value = stamina;
        am.attributes.integration.value = integration;
        am.attributes.deviation.value = deviation;
        am.flags = { ...flags };
        ui._crisisBriefSeen.add(nodeId);
        ui.hideStartMenu();
        se.goToNode(nodeId);
        ui.renderNode();
        ui.updateAllAttributes();
        setTimeout(() => ui.finishTyping(), 500);
    }, data);
    await wait(850);
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const browser = await chromium.launch({ headless: true, executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 720 } } });
    await context.addInitScript(() => sessionStorage.setItem('ycsl_opening_seen', '1'));
    const page = await context.newPage();
    await page.goto(process.env.DEMO_URL || 'http://localhost:8321/demo.html', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.game?.uiManager);
    await page.addStyleTag({ content: `
        #record-caption{position:fixed;z-index:99999;left:42px;bottom:34px;width:min(760px,70vw);padding:16px 22px;background:rgba(20,25,20,.9);border-left:5px solid #bd4b34;color:#f3ead6;box-shadow:0 12px 38px rgba(0,0,0,.38);pointer-events:none;font-family:"Noto Serif SC","Microsoft YaHei",serif}
        #record-caption small{display:block;color:#d9ad72;font-size:15px;letter-spacing:.18em;margin-bottom:5px} #record-caption strong{display:block;font-size:29px;line-height:1.22} #record-caption span{display:block;margin-top:7px;font-size:17px;color:#eee1ca}
        #record-intro{position:fixed;inset:0;z-index:99990;background:#111;overflow:hidden} #record-intro video{width:100%;height:100%;object-fit:cover;filter:sepia(.18) contrast(1.04)}
        #record-intro:after{content:"校史馆  →  修复笔记本  →  1958  →  北京一号研发现场";position:absolute;left:0;right:0;bottom:48px;text-align:center;color:#f5ead1;font:600 25px "Microsoft YaHei";letter-spacing:.08em;text-shadow:0 2px 12px #000;background:linear-gradient(90deg,transparent,rgba(0,0,0,.65),transparent);padding:15px}
    `});

    await caption(page, '北京航空航天大学 · 软件学院', '《一程山路》', '作者：马子钰');
    await wait(7000);
    await page.evaluate(() => { document.getElementById('record-caption')?.remove(); const el = document.createElement('div'); el.id = 'record-intro'; el.innerHTML = '<video src="assets/video/bj1-opening.mp4" autoplay muted playsinline></video>'; document.body.appendChild(el); });
    await wait(11000);

    await jump(page, 'c1_search');
    await caption(page, '调查阶段', '玩家先观察信息，再决定如何介入', '旧晒图、地面粉线与未来笔记给出不同证据');
    await wait(13000);

    await jump(page, 'demo_01_arrival');
    await caption(page, '前序决策', '先帮小牛把铝板推进去', '这次选择不会立刻解决危机，却会改变之后的可能性');
    await wait(4000);
    await page.getByRole('button', { name: /先帮小牛/ }).click();
    await wait(3000);
    await caption(page, '即时反馈', '小牛：生疏 → 信任', '新的决策路径已解锁');
    await wait(7000);

    await jump(page, 'c2_search', { integration: 1 });
    await caption(page, '后续节点 · 对照', '如果此前没有帮助小牛', '“让小牛取白布接回油”因信任不足而锁定');
    await wait(10000);

    await jump(page, 'c2_search', { integration: 1, flags: { trust_niu: true } });
    await caption(page, '因果显影', '此前的信任，让同一方案变得可选', '系统用真实的解锁状态证明前一次选择改变了后一次选择');
    await wait(15000);

    await jump(page, 'c2_open', { stamina: 3, integration: 1, deviation: 3, flags: { trust_niu: true, c1_exact: true } });
    await caption(page, '另一条路线 · 后果累积', '你已多次照抄未来答案，历史偏离达到 3/4', '试车台温度继续上升；眼前仍有当时的人能够验证的证据');
    await wait(7000);
    await jump(page, 'c2_search', { stamina: 3, integration: 1, deviation: 3, flags: { trust_niu: true, c1_exact: true } });
    await caption(page, '危险选择', '笔记本最快，却会让偏离达到 4/4', '油压记录与小牛取样仍可选；继续高干预需要再次确认');
    await wait(3500);
    await page.getByRole('button', { name: /高干预/ }).click();
    await wait(4000);
    await page.getByRole('button', { name: '确认行动' }).click();
    await wait(1500);
    await caption(page, '不可逆后果', '历史偏离 4/4', '环境声被压低，耳鸣盖过试车台');
    await wait(4500);
    await jump(page, 'demo_07_erased', { stamina: 2, integration: 2, deviation: 4, flags: { c1_exact: true, c2_exact: true } });
    await caption(page, '失败路线', '你改变了太多本不属于你的历史', '1958，成为了你的现在');
    await wait(9000);

    await jump(page, 'demo_07_delay', { stamina: 1, integration: 3, deviation: 1 });
    await caption(page, '结局之一', '历史照常进行', '安全优先，但首飞没有提前');
    await wait(5500);
    await jump(page, 'demo_07_best', { stamina: 2, integration: 4, deviation: 1, flags: { c1_overlay: true, c2_debris: true, c3_worn_gauge: true, c4_team: true } });
    await caption(page, '结局之二', '首飞提前', '证据、关系与工期共同导向最佳结果');
    await wait(5500);
    await jump(page, 'demo_07_erased', { stamina: 2, integration: 3, deviation: 4 });
    await caption(page, '结局之三', '永远留在 1958', '未来知识也有无法撤回的代价');
    await wait(5000);

    await page.evaluate(() => { document.body.innerHTML = `<main style="position:fixed;inset:0;display:grid;place-items:center;background:#18201b url('assets/scenes/start-poster.jpg') center/cover;color:#f2e7cc;text-align:center;font-family:'Noto Serif SC','Microsoft YaHei',serif"><div style="padding:52px 84px;background:rgba(19,25,20,.88);border:1px solid #a88d61;box-shadow:0 20px 60px #0008"><div style="font-size:18px;letter-spacing:.35em;color:#d2ad76">北京一号短篇探索</div><h1 style="font-size:62px;letter-spacing:.18em;margin:18px 0 12px">一程山路</h1><div style="font-size:18px;letter-spacing:.12em">每一次介入，都会改变下一次选择</div></div></main>`; });
    await wait(6000);

    const video = page.video();
    await context.close();
    await video.saveAs(RAW);
    await browser.close();
    console.log(RAW);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
