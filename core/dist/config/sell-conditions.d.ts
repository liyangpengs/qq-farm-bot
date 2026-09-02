export interface ActivityWindow {
    id: string;
    name?: string;
    beginTime: number;
    endTime: number;
}
export interface SellConditionContext {
    nowSec: number;
    expireTime?: number;
    activityWindows?: ReadonlyMap<string, ActivityWindow>;
    activityWindowsLoaded?: boolean;
}
//# sourceMappingURL=sell-conditions.d.ts.map