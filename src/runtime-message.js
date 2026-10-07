// A worker that disappears without calling back must not leave the popup
// showing "connecting" forever. This deadline does not retry signing requests.
export function sendRuntimeMessageWithDeadline(callbackApi, promiseApi, message, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bark background request timed out. Try again.')), timeoutMs)
    const finish = (err, result) => {
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(result)
    }
    try {
      if (callbackApi?.runtime?.sendMessage) {
        callbackApi.runtime.sendMessage(message, result => {
          const err = callbackApi.runtime.lastError
          finish(err ? new Error(err.message) : null, result)
        })
      } else if (promiseApi?.runtime?.sendMessage) {
        Promise.resolve(promiseApi.runtime.sendMessage(message)).then(
          result => finish(null, result), err => finish(err),
        )
      } else finish(new Error('Extension runtime unavailable.'))
    } catch (err) { finish(err) }
  })
}

export function isSignerRefusal(error) {
  const message = typeof error === 'string' ? error : error?.message || ''
  return /unauthori[sz]ed|unauthorised|not approved|denied|rejected|bad .*secret|wrong .*pubkey/i.test(message)
}
