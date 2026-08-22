import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'

export interface PetInfo {
  id: number
  name: string
  image: string
  rarity: number
  rarityLabel: string
  skills: PetSkillInfo[]
  skillDescription: string
  obtainCondition: string
  price: number
  level: number
  status: number
  owned: boolean
  active: boolean
}

export interface PetSkillInfo {
  skillId?: number
  name: string
  description: string
  triggerRate?: number
  dailyLimit?: number
  usedCount?: number
  remainingCount?: number
  source: 'game-config' | 'client-static'
}

export interface DogFoodInfo {
  id: number
  name: string
  image: string
  duration: number
  count: number
}

export interface PetSnapshot {
  dogs: PetInfo[]
  foods: DogFoodInfo[]
  protectDuration: number
  maxProtectDuration: number
  remainingDuration: number
  pendingGiftCount: number
  activeDogId: number
  activeControlSupported: boolean
  guardianRecordsSupported: boolean
  skillCatalog: {
    source: 'client-static'
    requestVerified: boolean
    requestMethod: null
    skillsByPetId: Record<number, PetSkillInfo[]>
  }
}

export interface PetProtectLog {
  id: string
  friendGid: number
  friendName: string
  friendAvatar: string
  timestamp: number
  stolenCount: number
  protectedGold: number
  dogId: number
  dogName: string
}

export const usePetStore = defineStore('pet', () => {
  const snapshot = ref<PetSnapshot | null>(null)
  const loading = ref(false)
  const usingFood = ref(false)
  const operatingDogId = ref(0)
  const protectLogs = ref<PetProtectLog[]>([])
  const protectLogsTotal = ref(0)
  const protectLogsLoading = ref(false)
  const error = ref('')
  const accountId = ref('')
  let requestSequence = 0

  const dogs = computed(() => snapshot.value?.dogs || [])
  const foods = computed(() => snapshot.value?.foods || [])
  const activeDog = computed(() => dogs.value.find(dog => dog.active) || null)

  function clear() {
    requestSequence++
    snapshot.value = null
    loading.value = false
    usingFood.value = false
    operatingDogId.value = 0
    protectLogs.value = []
    protectLogsTotal.value = 0
    protectLogsLoading.value = false
    error.value = ''
    accountId.value = ''
  }

  async function fetchProtectLogs(requestedAccountId: string) {
    const id = String(requestedAccountId || '').trim()
    if (!id || protectLogsLoading.value)
      return false
    protectLogsLoading.value = true
    error.value = ''
    try {
      const res = await api.get('/api/pets/protect-logs', {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (!res.data?.ok) {
        error.value = String(res.data?.error || '获取守护记录失败')
        return false
      }
      if (accountId.value === id) {
        protectLogs.value = (res.data.data?.logs || []) as PetProtectLog[]
        protectLogsTotal.value = Number(res.data.data?.total || protectLogs.value.length)
      }
      return true
    }
    catch (cause: any) {
      error.value = String(cause?.response?.data?.error || cause?.message || '获取守护记录失败')
      return false
    }
    finally {
      protectLogsLoading.value = false
    }
  }

  async function fetchPetInfo(requestedAccountId: string) {
    const id = String(requestedAccountId || '').trim()
    if (!id)
      return false

    const sequence = ++requestSequence
    accountId.value = id
    loading.value = true
    error.value = ''
    try {
      const res = await api.get('/api/pets', {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (sequence !== requestSequence || accountId.value !== id)
        return false
      if (!res.data?.ok) {
        error.value = String(res.data?.error || '无法读取宠物信息')
        return false
      }
      snapshot.value = res.data.data as PetSnapshot
      return true
    }
    catch (cause: any) {
      if (sequence !== requestSequence || accountId.value !== id)
        return false
      error.value = String(cause?.response?.data?.error || cause?.message || '无法读取宠物信息')
      return false
    }
    finally {
      if (sequence === requestSequence && accountId.value === id)
        loading.value = false
    }
  }

  async function useDogFood(requestedAccountId: string, itemId: number, count = 1, uid = 0) {
    const id = String(requestedAccountId || '').trim()
    if (!id || usingFood.value)
      return null

    usingFood.value = true
    error.value = ''
    try {
      const res = await api.post('/api/pets/food/use', { itemId, count, uid }, {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (!res.data?.ok) {
        error.value = String(res.data?.error || '使用狗粮失败')
        return null
      }
      if (accountId.value === id && res.data?.data)
        snapshot.value = res.data.data as PetSnapshot
      return res.data.data
    }
    catch (cause: any) {
      error.value = String(cause?.response?.data?.error || cause?.message || '使用狗粮失败')
      return null
    }
    finally {
      usingFood.value = false
    }
  }

  async function deployDog(requestedAccountId: string, dogId: number) {
    const id = String(requestedAccountId || '').trim()
    if (!id || operatingDogId.value)
      return null
    operatingDogId.value = dogId
    error.value = ''
    try {
      const res = await api.post('/api/pets/deploy', { dogId }, { headers: { 'x-account-id': id }, skipErrorToast: true } as any)
      if (!res.data?.ok) {
        error.value = String(res.data?.error || '宠物上场失败')
        return null
      }
      if (accountId.value === id)
        snapshot.value = res.data.data as PetSnapshot
      return res.data.data
    }
    catch (cause: any) {
      error.value = String(cause?.response?.data?.error || cause?.message || '宠物上场失败')
      return null
    }
    finally {
      operatingDogId.value = 0
    }
  }

  async function withdrawDog(requestedAccountId: string, dogId: number) {
    const id = String(requestedAccountId || '').trim()
    if (!id || operatingDogId.value)
      return null
    operatingDogId.value = dogId
    error.value = ''
    try {
      const res = await api.post('/api/pets/withdraw', {}, { headers: { 'x-account-id': id }, skipErrorToast: true } as any)
      if (!res.data?.ok) {
        error.value = String(res.data?.error || '宠物收回失败')
        return null
      }
      if (accountId.value === id)
        snapshot.value = res.data.data as PetSnapshot
      return res.data.data
    }
    catch (cause: any) {
      error.value = String(cause?.response?.data?.error || cause?.message || '宠物收回失败')
      return null
    }
    finally {
      operatingDogId.value = 0
    }
  }

  return {
    snapshot,
    dogs,
    foods,
    activeDog,
    loading,
    usingFood,
    operatingDogId,
    protectLogs,
    protectLogsTotal,
    protectLogsLoading,
    error,
    accountId,
    fetchPetInfo,
    fetchProtectLogs,
    useDogFood,
    deployDog,
    withdrawDog,
    clear,
  }
})
