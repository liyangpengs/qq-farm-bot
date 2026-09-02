export {};

const { AsyncLocalStorage } = require('node:async_hooks');
const { normalizeRequestClass } = require('./request-priority');

/**
 * 请求班次的环境上下文。
 *
 * 项目里绝大多数 API 封装（friend/api.ts、gid-manager.ts 等）默认传 priority:'normal'，
 * 调用方是前台面板还是后台定时任务，在发请求那一层完全看不出来。与其把班次参数一路
 * 手工透传到每个 API，不如用 AsyncLocalStorage 在「任务入口」处打一次标记：
 * 定时任务的回调整体跑在对应班次里，它内部发的所有请求自动继承这个班次。
 *
 * 没有环境班次时（HTTP 面板请求、Socket.IO 事件等）默认按前台处理，
 * 因为那些路径上确实有人在等结果。
 */

interface RequestContextStore {
    requestClass: string;
}

const storage: any = new AsyncLocalStorage();

/** 把 fn 跑在指定班次里；班次非法时原样执行，不额外包一层。 */
function runWithRequestClass<T>(requestClass: any, fn: () => T): T {
    const normalized = normalizeRequestClass(requestClass);
    if (!normalized) return fn();
    return storage.run({ requestClass: normalized } as RequestContextStore, fn);
}

function getAmbientRequestClass(): string | null {
    const store: RequestContextStore | undefined = storage.getStore();
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
function classForSchedulerNamespace(namespace: any): string | null {
    const name = String(namespace || '').trim();
    if (!name) return null;
    if (name === 'network' || name === 'ace' || name === 'worker_manager') return null;
    if (name === 'friend-pet-sync') return 'background';
    if (name.startsWith('friend')) return 'friend';
    return 'farm';
}

module.exports = {
    runWithRequestClass,
    getAmbientRequestClass,
    classForSchedulerNamespace,
};