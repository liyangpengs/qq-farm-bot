/**
 * 请求守卫：同一份状态被多次并发拉取 / 写入时，只让「最新一次」的回包落地。
 *
 * 为什么要统一实现：切号竞态是本项目反复出现的缺陷类别。手写 `let seq = 0` 有四个
 * 容易漏的点——① 取票必须在 await 之前；② 回包落地前必须校验；③ 切号 / 重置必须
 * 作废在途请求；④ 校验时还要顺带确认账号没被切走。任写漏一处，症状都是「A 账号的
 * 数据写进了已切到 B 的面板」，而且不报错、只能靠肉眼发现。
 *
 * 这里把四件事收进一个对象：`next()` 取票并快照账号，`isStale()` 一次判完，`invalidate()`
 * 作废所有在途。新写 store 时照抄，就不会再各写一份、各漏一处。
 */

export interface RequestTicket {
  /** 单调递增的票号 */
  readonly seq: number
  /** 取票那一刻的账号快照；未绑定账号时为空串 */
  readonly account: string
}

export interface RequestGuardOptions {
  /**
   * 绑定账号：取票时记录，回包落地前重新读取并比较，不一致即视为过期。
   * 不绑定时只做票号比较（适合与账号无关的全局数据）。
   */
  accountId?: () => unknown
}

export interface RequestGuard {
  /** 取票。必须在 await 之前调用；`account` 用来覆盖本次请求的目标账号。 */
  next: (account?: unknown) => RequestTicket
  /** 不递增，只取当前时刻的票据：用于「轮到外部事件作废」的场景（切号、关闭弹窗）。 */
  snapshot: (account?: unknown) => RequestTicket
  /** 回包落地前校验：true 表示这次回包已过期（被更新的请求取代，或账号已切走） */
  isStale: (ticket: RequestTicket | null | undefined) => boolean
  /** 作废所有在途请求（切号 / 重置时调用） */
  invalidate: () => void
}

export function normalizeAccount(value: unknown): string {
  return String(value ?? '').trim()
}

export function createRequestGuard(options: RequestGuardOptions = {}): RequestGuard {
  let seq = 0
  const currentAccount = () => (options.accountId ? normalizeAccount(options.accountId()) : '')
  const makeTicket = (account: unknown) => ({
    seq,
    account: account === undefined ? currentAccount() : normalizeAccount(account),
  })

  return {
    next(account) {
      seq += 1
      return makeTicket(account)
    },
    snapshot(account) {
      return makeTicket(account)
    },
    isStale(ticket) {
      if (!ticket || ticket.seq !== seq)
        return true
      if (!options.accountId)
        return false
      return ticket.account !== currentAccount()
    },
    invalidate() {
      seq += 1
    },
  }
}
