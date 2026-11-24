export interface NotificationTypes {
    offline: boolean;
    mysteryArrival: boolean;
    mysteryPurchase: boolean;
}

export interface PushNotification {
    type: keyof NotificationTypes;
    title: string;
    content: string;
}

// 旧配置只在账号内选择商人提醒，全局默认放行以保留原有选择。
export function normalizeNotificationTypes(input?: Partial<NotificationTypes>): NotificationTypes {
    return {
        offline: input?.offline !== false,
        mysteryArrival: input?.mysteryArrival !== false,
        mysteryPurchase: input?.mysteryPurchase !== false,
    };
}
