#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const sourceFiles = [
    'core/AttributeManager.js',
    'core/ConditionEvaluator.js',
    'core/LoopController.js',
    'core/CardManager.js',
    'core/StoryEngine.js',
    'core/ContentLoader.js'
];

let source = sourceFiles
    .map(file => fs.readFileSync(path.join(ROOT, 'js', file), 'utf8'))
    .join('\n;\n');
source += ';this.__exports={AttributeManager,LoopController,CardManager,StoryEngine,ContentLoader};';

const sandbox = { window: {}, console, setTimeout, clearTimeout };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'demo-route-bundle.js' });

const { AttributeManager, LoopController, CardManager, StoryEngine, ContentLoader } = sandbox.__exports;
const storyData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'story_demo.json'), 'utf8'));

function createGame() {
    const attributes = new AttributeManager();
    attributes.attributes.stamina = { value: 4, max: 4, min: 0 };
    attributes.attributes.integration = { value: 0, max: 4, min: 0 };
    attributes.attributes.deviation = { value: 0, max: 4, min: 0 };

    const story = new StoryEngine(attributes);
    const loop = new LoopController(attributes);
    const cards = new CardManager(attributes);
    story.attachSystems({ loopController: loop, cardManager: cards });
    loop.attach({ storyEngine: story, cardManager: cards });
    cards.attach({ storyEngine: story });
    new ContentLoader({ storyEngine: story, loopController: loop, cardManager: cards, attributeManager: attributes })
        .loadStory(storyData);
    story.goToNode('demo_00_start');
    return { story, attributes };
}

function availableChoices(story) {
    const node = story.getCurrentNode();
    return (node.choices || []).filter(choice =>
        !choice.condition || sandbox.window.game.evalCondition(choice.condition, story.getSnapshot()));
}

function advanceStory(story) {
    const node = story.getCurrentNode();
    const next = node.autoNext || node.nextNode;
    if (!next || !story.goToNode(next)) throw new Error(`无法从 ${node.id} 前进`);
}

function pick(story, choiceId) {
    const node = story.getCurrentNode();
    const index = (node.choices || []).findIndex(choice => choice.id === choiceId);
    if (index < 0) throw new Error(`${node.id} 不存在选项 ${choiceId}`);
    const choice = node.choices[index];
    const available = availableChoices(story);
    if (!available.includes(choice)) throw new Error(`${node.id} 的 ${choiceId} 条件未满足`);
    if (!story.makeChoice(index)) throw new Error(`${node.id} 的 ${choiceId} 结算失败`);
    if (!story.goToNode(choice.nextNode)) throw new Error(`${choiceId} 无法进入 ${choice.nextNode}`);
}

function runRoute(name, decisions, expectedEnding, expectedState) {
    const { story, attributes } = createGame();
    advanceStory(story);
    for (const choiceId of decisions) {
        while (!(story.getCurrentNode().choices || []).length) advanceStory(story);
        pick(story, choiceId);
    }
    while (story.currentNodeId !== 'demo_06_settle') advanceStory(story);

    const endings = availableChoices(story).map(choice => choice.id);
    if (endings.length !== 1 || endings[0] !== expectedEnding) {
        throw new Error(`${name} 结局错误，实际为 ${endings.join(', ') || '无可用结局'}`);
    }
    for (const [key, value] of Object.entries(expectedState)) {
        const actual = attributes.getAttribute(key);
        if (actual !== value) throw new Error(`${name} 的 ${key} 应为 ${value}，实际为 ${actual}`);
    }
    console.log(`PASS ${name}: ${expectedEnding}`);
}

runRoute('最优路线', [
    'arrival_help',
    'c1_find_overlay', 'c1_use_overlay',
    'c2_compare_log', 'c2_use_pressure',
    'c3_enter_clear', 'c3_check_gauge', 'c3_replace_gauge',
    'c4_call_team', 'c4_rebuild_team'
], 'ending_best', { integration: 4, deviation: 0, stamina: 3 });

runRoute('全稳慢路线（工期耗尽）', [
    'arrival_help',
    'c1_trace_chalk', 'c1_use_chalk',
    'c2_compare_log', 'c2_use_pressure',
    'c3_enter_clear', 'c3_ask_xiaolin', 'c3_fix_process',
    'c4_ask_fang', 'c4_rebuild_authorized'
], 'ending_delay_grace', { integration: 4, deviation: 0, stamina: 0 });

runRoute('延期路线', [
    'arrival_help',
    'c1_find_overlay', 'c1_delay',
    'c2_compare_log', 'c2_wait',
    'c3_enter_clear', 'c3_check_gauge', 'c3_scrap',
    'c4_use_old_cable', 'c4_report_morning'
], 'ending_delay', { integration: 0, deviation: 0, stamina: 0 });

runRoute('高偏离路线', [
    'arrival_claim',
    'c1_read_notebook', 'c1_use_exact',
    'c2_touch_pipe', 'c2_emergency_stop',
    'c3_face_question', 'c3_show_notebook',
    'c3_read_solution', 'c3_use_shim',
    'c4_follow_notebook', 'c4_install_spare'
], 'ending_erased', { integration: 4, deviation: 4, stamina: 4 });

console.log('Demo routes: 4 passed');
