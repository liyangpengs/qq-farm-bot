import type { ActivityRouteContext } from './types';

export function mountActivityOverviewRoutes({ mountGet }: ActivityRouteContext): void {
    mountGet('/api/activity-center/activities', 'getActivityDirectorySnapshot');
    mountGet('/api/activity-center/ranch-activities', 'getRanchActivityDirectorySnapshot');
    mountGet('/api/activity-center/snapshot', 'getActivityCenterSnapshot');
}
