"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { AsyncLocalStorage } = require('node:async_hooks');
const { normalizeRequestClass } = require('./request-priority');
const storage = new AsyncLocalStorage();
/** 把 fn 跑在指定班次里；班次非法时原样执行，不额外包一层。 */
function runWithRequestClass(requestClass, fn) {
    const normalized = normalizeRequestClass(requestClass);
    if (!normalized)
        return fn();
    return storage.run({ requestClass: normalized }, fn);
}
function getAmbientRequestClass() {
    const store = storage.getStore();
    return store && store.requestClass ? store.requestClass : null;
}
/**
 * 调度器命名空间 → 请求班次。
 *
 * - network / ace / worker_manager 是基础设施：它们自己会显式声明 criticalLane 或
 *   由具体业务再包一层，这里返回 null 表示「不注入班次」；
 * - worker 命名空间的统一 tick 同时驱动农场和好友两种任务，所以只能给它一个保守的
 *   默认值（farm），真正的区分由 checkFarm / checkFriends / runFriendPetSync 三个入口
 *   各自显式包裹完成。
 */
function classForSchedulerNamespace(namespace) {
    const name = String(namespace || '').trim();
    if (!name)
        return null;
    if (name === 'network' || name === 'ace' || name === 'worker_manager')
        return null;
    if (name === 'friend-pet-sync')
        return 'background';
    if (name.startsWith('friend'))
        return 'friend';
    return 'farm';
}
module.exports = {
    runWithRequestClass,
    getAmbientRequestClass,
    classForSchedulerNamespace,
};
//# sourceMappingURL=request-context.js.map