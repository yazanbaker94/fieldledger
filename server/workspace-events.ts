import type { Response } from 'express';

type Change = { workspaceId: string; retiredWorkspaceId?: string };

export function createWorkspaceEvents(shutdownSignal?: AbortSignal) {
  const listeners = new Map<string, Set<Response>>();
  let count = 0;

  function send(response: Response, change: Change) {
    if (!response.writableEnded && !response.destroyed && !response.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`)) {
      response.end();
    }
  }

  shutdownSignal?.addEventListener('abort', () => {
    for (const group of listeners.values()) for (const response of group) response.end();
  }, { once: true });

  return {
    subscribe(session: string, response: Response, initial: Change, expiresAt: Date) {
      const group = listeners.get(session) ?? new Set<Response>();
      if (shutdownSignal?.aborted || count >= 256 || group.size >= 4) return false;
      group.add(response);
      listeners.set(session, group);
      count += 1;
      response.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const heartbeat = setInterval(() => {
        if (response.destroyed || response.writableEnded) return;
        if (expiresAt.getTime() <= Date.now() || !response.write(': keep-alive\n\n')) response.end();
      }, 20_000);
      heartbeat.unref();
      response.once('error', () => response.destroy());
      response.once('close', () => {
        clearInterval(heartbeat);
        group.delete(response);
        if (!group.size) listeners.delete(session);
        count -= 1;
      });
      send(response, initial);
      return true;
    },
    publish(session: string, change: Change) {
      for (const response of listeners.get(session) ?? []) send(response, change);
    },
  };
}
