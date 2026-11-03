/**
 * 待处理队列（审批 / 计划确认）。
 *
 * 这个模块只回答一件事：「现在屏幕上应该闪什么」。它不代答、不决定、不保存历史：
 * 审批的最终答案永远在 DSH 官方页面里给出，这里仅仅在等待期间让边缘红闪亮着。
 */

export class AlertStore {
  constructor(options = {}) {
    this.pendingTtlMs = Number.isFinite(options.pendingTtlMs) ? options.pendingTtlMs : 300_000
    this.readOnlyTtlMs = Number.isFinite(options.readOnlyTtlMs) ? options.readOnlyTtlMs : 600_000
    this.pending = new Map()
    this.seq = 0
  }

  nextId(prefix) {
    this.seq += 1
    return `${prefix}-${this.seq.toString(36)}`
  }

  /** 一条待审批：只用于红闪，用户答复由官方卡片负责。 */
  addApproval(view) {
    const id = this.nextId('p')
    const now = Date.now()
    const item = {
      id,
      kind: 'approval',
      sessionId: view.sessionId ?? '',
      sessionTitle: view.sessionTitle ?? '',
      cwd: view.cwd ?? '',
      toolName: view.toolName ?? '',
      summary: view.summary ?? '',
      reason: view.reason ?? '',
      createdAt: now,
      expiresAt: now + this.pendingTtlMs,
      canDecide: true,
    }
    this.pending.set(id, item)
    return item
  }

  /** 只读项（计划待确认）：同样只用于红闪，颜色不同。 */
  addReadOnly(view) {
    const id = this.nextId('p')
    const now = Date.now()
    const item = {
      id,
      kind: view.kind === 'plan-review' ? 'plan-review' : (view.kind ?? 'plan-review'),
      sessionId: view.sessionId ?? '',
      sessionTitle: view.sessionTitle ?? '',
      cwd: view.cwd ?? '',
      toolName: view.toolName ?? '',
      summary: view.summary ?? '',
      reason: view.reason ?? '',
      createdAt: now,
      expiresAt: now + this.readOnlyTtlMs,
      canDecide: false,
    }
    this.pending.set(id, item)
    return item
  }

  /** 移除一条（已答复、已过期或请求被中断）。 */
  drop(id) {
    return this.pending.delete(id)
  }

  pruneExpired(now = Date.now()) {
    for (const [id, item] of this.pending) {
      if (item.expiresAt <= now) this.pending.delete(id)
    }
  }

  snapshot(extra) {
    this.pruneExpired()
    const pending = [...this.pending.values()]
      .sort((a, b) => (a.kind === b.kind ? a.createdAt - b.createdAt : a.kind === 'approval' ? -1 : 1))
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        sessionId: item.sessionId,
        sessionTitle: item.sessionTitle,
        cwd: item.cwd,
        toolName: item.toolName,
        summary: item.summary,
        reason: item.reason,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
        canDecide: item.canDecide,
      }))
    return {
      version: 2,
      now: Date.now(),
      pending,
      ...extra,
    }
  }
}