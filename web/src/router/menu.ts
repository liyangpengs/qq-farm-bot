export interface MenuItem {
  path: string
  name: string
  label: string
  icon: string
  component: () => Promise<any>
  meta?: {
    fullBleed?: boolean
  }
}

export const menuRoutes: MenuItem[] = [
  {
    path: '',
    name: 'dashboard',
    label: '概览',
    icon: 'i-carbon-dashboard',
    component: () => import('@/views/Dashboard.vue'),
  },
  {
    path: 'personal',
    name: 'personal',
    label: '个人',
    icon: 'i-carbon-sprout',
    component: () => import('@/views/Personal.vue'),
  },
  {
    path: 'illustrated',
    name: 'illustrated',
    label: '图鉴',
    icon: 'i-carbon-book',
    component: () => import('@/views/Illustrated.vue'),
  },
  {
    path: 'activity',
    name: 'activity-center',
    label: '活动',
    icon: 'i-carbon-events',
    component: () => import('@/views/ActivityCenter.vue'),
  },
  {
    path: 'friends',
    name: 'friends',
    label: '好友',
    icon: 'i-carbon-user-multiple',
    component: () => import('@/views/Friends.vue'),
  },
  {
    path: 'analytics',
    name: 'analytics',
    label: '分析',
    icon: 'i-carbon-chart-line',
    component: () => import('@/views/Analytics.vue'),
  },
  {
    path: 'solar-calendar',
    name: 'solar-calendar',
    label: '节令日历',
    icon: 'i-carbon-calendar',
    component: () => import('@/views/SolarCalendar.vue'),
  },
  {
    path: 'game-mall',
    name: 'game-mall',
    label: '游戏商城',
    icon: 'i-carbon-shopping-cart',
    component: () => import('@/views/GameMall.vue'),
  },
  {
    path: 'settings',
    name: 'Settings',
    label: '设置',
    icon: 'i-carbon-settings',
    component: () => import('@/views/Settings.vue'),
  },
]
