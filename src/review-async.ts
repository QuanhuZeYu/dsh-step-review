/** 等待边界统一响应取消；底层晚到结果仍有拒绝处理器。 */
export function abortable<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    const settled = () => {
      signal.removeEventListener('abort', abort)
      if (!signal.aborted) return true
      reject(signal.reason)
      return false
    }
    Promise.resolve(work).then(value => { if (settled()) resolve(value) }, error => { if (settled()) reject(error) })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

/** 延后启动清理，清理及日志异常均不能覆盖主流程原错。 */
export function cleanup(task: () => PromiseLike<unknown>, warn: (error: unknown) => void): void {
  void Promise.resolve().then(task).catch(error => { try { warn(error) } catch {} })
}
