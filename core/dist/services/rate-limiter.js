"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 请求队列与并发控制模块
 * 解决批量操作无并发限制的问题，防止触发服务端限流
 */
const { createModuleLogger } = require('./logger');
const logger = createModuleLogger('rate-limiter');
const DEFAULT_CONFIG = {
    maxConcurrent: 3,
    minInterval: 100,
    maxRetries: 2,
    retryDelay: 500,
    enableBurst: false,
    burstSize: 5,
};
class TokenBucket {
    capacity;
    tokens;
    refillRate;
    lastRefill;
    maxWait;
    constructor(options = {}) {
        this.capacity = options.capacity || DEFAULT_CONFIG.maxConcurrent;
        this.tokens = this.capacity;
        this.refillRate = options.refillRate || 1000;
        this.lastRefill = Date.now();
        this.maxWait = options.maxWait || 5000;
    }
    refill() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        const tokensToAdd = (elapsed / this.refillRate) * this.capacity;
        this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
        this.lastRefill = now;
    }
    async acquire(tokens = 1) {
        const startWait = Date.now();
        while (this.tokens < tokens) {
            if (Date.now() - startWait > this.maxWait) {
                throw new Error('请求等待超时');
            }
            this.refill();
            await sleep(50);
        }
        this.tokens -= tokens;
        return true;
    }
    release(tokens = 1) {
        this.tokens = Math.min(this.capacity, this.tokens + tokens);
    }
}
class PriorityQueue {
    queue;
    constructor() {
        this.queue = [];
    }
    enqueue(item, priority = 0) {
        const entry = { item, priority, addedAt: Date.now() };
        const index = this.queue.findIndex(e => e.priority < priority);
        if (index === -1) {
            this.queue.push(entry);
        }
        else {
            this.queue.splice(index, 0, entry);
        }
    }
    dequeue() {
        return this.queue.shift()?.item;
    }
    peek() {
        return this.queue[0]?.item;
    }
    size() {
        return this.queue.length;
    }
    clear() {
        this.queue = [];
    }
}
class RequestQueue {
    bucket;
    queue;
    processing;
    config;
    constructor(options = {}) {
        this.bucket = new TokenBucket({
            capacity: options.maxConcurrent || DEFAULT_CONFIG.maxConcurrent,
            refillRate: options.minInterval || DEFAULT_CONFIG.minInterval,
        });
        this.queue = new PriorityQueue();
        this.processing = false;
        this.config = { ...DEFAULT_CONFIG, ...options };
    }
    async addRequest(fn, options = {}) {
        const { priority = 0, retries = DEFAULT_CONFIG.maxRetries, label = 'request' } = options;
        return new Promise((resolve, reject) => {
            const task = { fn, resolve, reject, retries, label, attempts: 0 };
            this.queue.enqueue(task, -priority);
            this.processQueue();
        });
    }
    async processQueue() {
        if (this.processing || this.queue.size() === 0)
            return;
        this.processing = true;
        while (this.queue.size() > 0) {
            const task = this.queue.dequeue();
            if (!task)
                break;
            try {
                await this.bucket.acquire();
                const result = await this.executeTask(task);
                this.bucket.release();
                task.resolve(result);
            }
            catch (error) {
                this.bucket.release();
                if (task.attempts < task.retries) {
                    task.attempts++;
                    logger.info(`[${task.label}] 请求失败，${task.retries - task.attempts + 1}次重试中...`, {
                        error: error.message,
                    });
                    await sleep(DEFAULT_CONFIG.retryDelay * task.attempts);
                    this.queue.enqueue(task, -task.priority || 0);
                }
                else {
                    task.reject(error);
                }
            }
        }
        this.processing = false;
    }
    async executeTask(task) {
        return await task.fn();
    }
    setConcurrency(concurrency) {
        this.bucket.capacity = Math.max(1, Math.min(concurrency, 20));
    }
    getStatus() {
        return {
            queueSize: this.queue.size(),
            availableTokens: Math.floor(this.bucket.tokens),
            capacity: this.bucket.capacity,
        };
    }
    clear() {
        this.queue.clear();
    }
}
const serviceQueues = new Map();
function getServiceQueue(serviceName, options = {}) {
    if (!serviceQueues.has(serviceName)) {
        const config = getServiceConfig(serviceName);
        serviceQueues.set(serviceName, new RequestQueue({ ...config, ...options }));
    }
    return serviceQueues.get(serviceName);
}
function getServiceConfig(serviceName) {
    const configs = {
        'PlantService': { maxConcurrent: 2, minInterval: 200 },
        'FriendService': { maxConcurrent: 1, minInterval: 500 },
        'VisitService': { maxConcurrent: 1, minInterval: 500 },
        'TaskService': { maxConcurrent: 3, minInterval: 100 },
        'MallService': { maxConcurrent: 2, minInterval: 200 },
        'default': { maxConcurrent: 3, minInterval: 100 },
    };
    return configs[serviceName] || configs.default;
}
async function sendWithRetry(serviceName, methodName, sendFn, options = {}) {
    const queue = getServiceQueue(serviceName);
    const { retries = DEFAULT_CONFIG.maxRetries, timeout = 10000 } = options;
    return queue.addRequest(async () => {
        return withTimeout(sendFn(), timeout, `${serviceName}.${methodName} 请求超时`);
    }, {
        label: `${serviceName}.${methodName}`,
        retries,
        priority: options.priority || 0,
    });
}
function withTimeout(promise, ms, errorMessage) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(errorMessage)), ms)),
    ]);
}
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
class BatchOperationOptimizer {
    queue;
    constructor(options = {}) {
        this.queue = new RequestQueue(options);
    }
    async batchFarmOperations(operations) {
        const results = [];
        const grouped = {
            weed: [],
            bug: [],
            water: [],
        };
        for (const op of operations) {
            if (grouped[op.type]) {
                grouped[op.type].push(op);
            }
        }
        const tasks = [];
        if (grouped.weed.length > 0) {
            tasks.push(this.queue.addRequest(async () => {
                return await grouped.weed[0].fn(grouped.weed.map((op) => op.landId));
            }, { priority: 2, label: 'batch_weed' }));
        }
        if (grouped.bug.length > 0) {
            tasks.push(this.queue.addRequest(async () => {
                return await grouped.bug[0].fn(grouped.bug.map((op) => op.landId));
            }, { priority: 2, label: 'batch_bug' }));
        }
        if (grouped.water.length > 0) {
            tasks.push(this.queue.addRequest(async () => {
                return await grouped.water[0].fn(grouped.water.map((op) => op.landId));
            }, { priority: 2, label: 'batch_water' }));
        }
        const settled = await Promise.allSettled(tasks);
        for (const result of settled) {
            if (result.status === 'fulfilled') {
                results.push({ success: true, data: result.value });
            }
            else {
                results.push({ success: false, error: result.reason.message });
            }
        }
        return results;
    }
    async batchFriendOperations(operations, options = {}) {
        const { maxConcurrent = 1 } = options;
        this.queue.setConcurrency(maxConcurrent);
        const results = [];
        for (const op of operations) {
            const result = await this.queue.addRequest(async () => {
                return await op.fn(op.params);
            }, {
                priority: op.priority || 0,
                label: op.label || 'friend_op',
            });
            results.push({
                friendId: op.friendId,
                success: true,
                data: result,
            });
        }
        return results;
    }
    getStatus() {
        return this.queue.getStatus();
    }
}
let globalFarmOptimizer = null;
let globalFriendOptimizer = null;
function getFarmOptimizer() {
    if (!globalFarmOptimizer) {
        globalFarmOptimizer = new BatchOperationOptimizer({
            maxConcurrent: 3,
            minInterval: 100,
        });
    }
    return globalFarmOptimizer;
}
function getFriendOptimizer() {
    if (!globalFriendOptimizer) {
        globalFriendOptimizer = new BatchOperationOptimizer({
            maxConcurrent: 1,
            minInterval: 500,
        });
    }
    return globalFriendOptimizer;
}
module.exports = {
    RequestQueue,
    TokenBucket,
    PriorityQueue,
    sendWithRetry,
    getServiceQueue,
    BatchOperationOptimizer,
    getFarmOptimizer,
    getFriendOptimizer,
    DEFAULT_CONFIG,
};
//# sourceMappingURL=rate-limiter.js.map