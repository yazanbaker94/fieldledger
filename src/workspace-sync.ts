type WorkspaceTransition = 'resetting' | 'retired'

const resetPrefix = 'fieldledger.workspace-reset.v1.'
const retiredPrefix = 'fieldledger.workspace-retired.v1.'
const fallback = new Map<string, string>()
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('fieldledger-workspace-sync') : undefined

function read(key: string) {
  try {
    return localStorage.getItem(key) ?? fallback.get(key)
  } catch {
    return fallback.get(key)
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    if (value === null) fallback.delete(key)
    else fallback.set(key, value)
    channel?.postMessage({ key, value })
  }
}

function expires(value: string | undefined | null) {
  return Number(value?.split(':', 1)[0]) || 0
}

export function workspaceTransition(id: string): WorkspaceTransition | null {
  if (expires(read(retiredPrefix + id)) > Date.now()) return 'retired'
  const marker = `${location.protocol === 'https:' ? '__Host-' : ''}fieldledger-retired-${id}=1`
  if (document.cookie.split(';').some((cookie) => cookie.trim() === marker)) return 'retired'
  if (expires(read(resetPrefix + id)) > Date.now()) return 'resetting'
  return null
}

export function beginWorkspaceReset(id: string) {
  const key = resetPrefix + id
  const claim = `${Date.now() + 30_000}:${crypto.randomUUID()}`
  write(key, claim)
  return () => { if (read(key) === claim) write(key, null) }
}

export function retireWorkspace(id: string) {
  const key = retiredPrefix + id
  if (expires(read(key)) > Date.now()) return
  const now = Date.now()
  try {
    for (const stored of Object.keys(localStorage)) {
      if ((stored.startsWith(resetPrefix) || stored.startsWith(retiredPrefix)) && expires(localStorage.getItem(stored)) <= now) {
        localStorage.removeItem(stored)
      }
    }
  } catch {
    // An unavailable store can still notify other open tabs through BroadcastChannel.
  }
  write(key, String(now + 86_400_000))
}

export function onWorkspaceTransition(change: (id: string) => void) {
  function notify(key: string | null) {
    for (const prefix of [resetPrefix, retiredPrefix]) {
      if (key?.startsWith(prefix)) change(key.slice(prefix.length))
    }
  }
  function receive(event: StorageEvent) {
    notify(event.key)
  }
  function receiveFallback(event: MessageEvent<{ key?: string; value?: string | null }>) {
    const { key, value } = event.data ?? {}
    if (typeof key !== 'string' || (!key.startsWith(resetPrefix) && !key.startsWith(retiredPrefix))) return
    if (typeof value === 'string') fallback.set(key, value)
    else fallback.delete(key)
    notify(key)
  }
  window.addEventListener('storage', receive)
  channel?.addEventListener('message', receiveFallback)
  return () => {
    window.removeEventListener('storage', receive)
    channel?.removeEventListener('message', receiveFallback)
  }
}
