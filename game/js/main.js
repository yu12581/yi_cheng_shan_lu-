/**
 * 主入口 - 初始化游戏并串联所有模块
 *
 * 装配顺序：AttributeManager → SaveManager → StoryEngine →
 *           LoopController / CardManager（attach 互相引用）→ UIManager → DebugPanel
 *
 * 支持 ?story=<path> 指定剧情 JSON（默认 data/story_act1.json），
 * 供测试骨架周（test/skeleton_week.json）与内容线并行验证。
 */
(function () {
    'use strict';

    // 全局游戏实例
    let attributeManager;
    let saveManager;
    let storyEngine;
    let loopController;
    let cardManager;
    let uiManager;
    let audioManager;

    /**
     * 初始化游戏
     */
    async function initGame() {
        // 创建核心模块
        attributeManager = new AttributeManager();
        saveManager = new SaveManager();
        storyEngine = new StoryEngine(attributeManager);
        loopController = new LoopController(attributeManager);
        cardManager = new CardManager(attributeManager);
        audioManager = new AudioManager();

        // 相互装配（避免构造循环依赖）
        storyEngine.attachSystems({ loopController, cardManager });
        loopController.attach({ storyEngine, saveManager, cardManager });
        cardManager.attach({ storyEngine });

        // 加载内容数据：故事主文件 + 卡牌/任务/NPC/参数（缺失文件静默跳过）
        // ?story= 可覆盖故事主文件（骨架周测试档）
        // 注意：headless 浏览器对 alert 会挂起，一切启动期提示走 BootNotice
        if (location.protocol === 'file:') {
            window.bootNotice('无法加载剧情数据',
                '双击打开会被浏览器拦截本地文件请求。\n\n请在 game 目录运行：\n  python -m http.server 8000\n然后访问：\n  http://localhost:8000/index.html');
            return;
        }
        const params = new URLSearchParams(location.search);
        const demoMode = params.get('demo') === '1';
        const storyPath = demoMode ? 'data/story_demo.json' : (params.get('story') || 'data/story_act1.json');
        const contentLoader = new ContentLoader({ storyEngine, loopController, cardManager, attributeManager });
        const contentPaths = demoMode ? [storyPath] : [
            storyPath,
            'data/cards_act1.json',
            'data/tasks_act1.json',
            'data/npcs.json',
            'data/params.json',
            'data/night_events.json'
        ];
        const loadedOk = await contentLoader.load(contentPaths);
        if (!loadedOk.story) {
            window.bootNotice('剧情数据加载失败',
                `路径：${storyPath}\n请确认已通过本地服务器访问\n（如 http://localhost:8000/index.html）。`);
            return;
        }

        if (demoMode) {
            // Demo 状态独立于正式版存档，固定为三格资源与两名现场角色。
            for (const [name, value] of Object.entries({ stamina: 3, integration: 1, deviation: 0 })) {
                attributeManager.attributes[name].max = 3;
                attributeManager.attributes[name].value = value;
            }
            attributeManager.npcRelations = {
                jiwen: { name: '李文', value: 0, max: 100 },
                wang: { name: '王师傅', value: 0, max: 100 }
            };
        }

        // 设置初始节点（序章为自由节点，不受相位白名单限制）
        // 先清空默认 currentNodeId，避免幽灵节点混入 history
        const nodes = storyEngine.nodes;
        const startId = demoMode ? 'demo_00_start' : (nodes['node_101_timetravel']
            ? 'node_101_timetravel'
            : Object.keys(nodes).find(k => !k.startsWith('__')));
        storyEngine.currentNodeId = null;
        storyEngine.goToNode(startId);

        // 创建UI管理器
        uiManager = new UIManager(storyEngine, attributeManager, saveManager, audioManager);

        // ?skipMenu=1：跳过开始菜单直达（皮肤线/自动化测试/调试用）
        if (params.get('skipMenu') === '1') {
            uiManager.hideStartMenu();
            uiManager.renderNode();
        } else {
            uiManager.showStartMenu();
        }

        // F1 调试面板三件套
        const debugPanel = new DebugPanel();

        // 暴露到全局便于调试（spread 保留 core 模块已挂载的类与纯函数）
        window.game = {
            ...window.game,
            attributeManager,
            saveManager,
            storyEngine,
            loopController,
            cardManager,
            uiManager,
            audioManager,
            debugPanel
        };

        console.log('《一程山路》初始化完成 | 剧情:', storyPath);
    }

    // DOM加载完成后启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initGame);
    } else {
        initGame();
    }
})();
