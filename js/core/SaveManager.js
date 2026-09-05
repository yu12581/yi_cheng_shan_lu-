/**
 * 存档管理器 - 3 手动槽 + 1 自动槽
 *
 * 存储格式（localStorage 单键）：
 * {
 *   version: 1,            // 存档格式版本号（留迁移路）
 *   slots: { "1": {...}, "2": {...}, "3": {...}, auto: {...} }
 * }
 * 兼容旧格式 { "1": {...} }：读取时自动迁移包裹。
 */
class SaveManager {
    constructor() {
        this.storageKey = 'yichengshanlugame_save';
        this.maxSlots = 3;      // 手动槽 1-3
        this.autoSlot = 'auto'; // 自动槽（周结算写入）
        this.version = 1;       // 存档格式版本
    }

    /**
     * 校验槽位：1-3 手动 或 'auto'
     */
    isValidSlot(slotId) {
        return slotId === this.autoSlot ||
               (Number.isInteger(slotId) && slotId >= 1 && slotId <= this.maxSlots);
    }

    /**
     * 保存游戏到指定槽位
     * @param {number|'auto'} slotId - 槽位ID (1-3 或 'auto')
     * @param {object} gameState - 游戏状态
     * @returns {boolean} 是否成功
     */
    saveGame(slotId, gameState) {
        if (!this.isValidSlot(slotId)) {
            console.error('无效的存档槽位:', slotId);
            return false;
        }

        try {
            const store = this.getStore();
            store.slots[slotId] = {
                ...gameState,
                timestamp: Date.now(),
                date: new Date().toLocaleString('zh-CN')
            };
            localStorage.setItem(this.storageKey, JSON.stringify(store));
            return true;
        } catch (error) {
            console.error('存档失败:', error);
            return false;
        }
    }

    /**
     * 从指定槽位读档
     * @param {number|'auto'} slotId - 槽位ID (1-3 或 'auto')
     * @returns {object|null} 游戏状态
     */
    loadGame(slotId) {
        if (!this.isValidSlot(slotId)) {
            console.error('无效的存档槽位:', slotId);
            return null;
        }

        try {
            const store = this.getStore();
            return store.slots[slotId] || null;
        } catch (error) {
            console.error('读档失败:', error);
            return null;
        }
    }

    /**
     * 获取存储容器（含旧格式迁移）
     * @returns {object} { version, slots }
     */
    getStore() {
        let raw = null;
        try {
            raw = localStorage.getItem(this.storageKey);
        } catch (error) {
            console.error('读取存档列表失败:', error);
        }
        if (!raw) return { version: this.version, slots: {} };

        try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.slots && typeof parsed.slots === 'object') {
                return { version: parsed.version || 1, slots: parsed.slots };
            }
            // 旧格式：顶层即槽位映射 → 迁移包裹
            const migrated = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (!isNaN(parseInt(k))) migrated[parseInt(k)] = v;
            }
            return { version: 0, slots: migrated };
        } catch (error) {
            console.error('存档数据损坏，已重置:', error);
            return { version: this.version, slots: {} };
        }
    }

    /**
     * 获取所有存档（仅槽位数据，不含 version 元信息）
     * @returns {object} 所有存档数据
     */
    getAllSaves() {
        return this.getStore().slots;
    }

    /**
     * 删除指定槽位的存档
     */
    deleteSave(slotId) {
        if (!this.isValidSlot(slotId)) {
            console.error('无效的存档槽位:', slotId);
            return false;
        }

        try {
            const store = this.getStore();
            delete store.slots[slotId];
            localStorage.setItem(this.storageKey, JSON.stringify(store));
            return true;
        } catch (error) {
            console.error('删除存档失败:', error);
            return false;
        }
    }

    /**
     * 检查槽位是否有存档
     */
    hasSave(slotId) {
        return !!this.loadGame(slotId);
    }

    /**
     * 获取存档摘要信息
     */
    getSaveSummary(slotId) {
        const save = this.loadGame(slotId);
        if (!save) return null;

        return {
            date: save.date,
            currentNode: save.currentNodeId,
            location: save.currentLocation,
            gameDate: save.currentDate,
            week: save.loop ? save.loop.week : null,
            isAuto: slotId === this.autoSlot
        };
    }

    /**
     * 清空所有存档
     */
    clearAllSaves() {
        try {
            localStorage.removeItem(this.storageKey);
            return true;
        } catch (error) {
            console.error('清空存档失败:', error);
            return false;
        }
    }
}
