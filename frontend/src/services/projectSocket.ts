import { io, type Socket } from 'socket.io-client';
import { getApiBaseUrl, getSocketAuth } from '@/services/api';

type ProjectSocketEventHandler = (payload?: any) => void;

type ProjectSocketEntry = {
  socket: Socket;
  subscriberCount: number;
  handlersByEvent: Map<string, Set<ProjectSocketEventHandler>>;
  dispatchersByEvent: Map<string, ProjectSocketEventHandler>;
};

const projectSocketEntries = new Map<string, ProjectSocketEntry>();

function getSocketUrl(): string {
  return getApiBaseUrl().replace(/\/api$/, '');
}

function createProjectSocketEntry(projectId: string): ProjectSocketEntry {
  const socket = io(getSocketUrl(), {
    transports: ['websocket'],
    auth: getSocketAuth(),
  });
  const entry: ProjectSocketEntry = {
    socket,
    subscriberCount: 0,
    handlersByEvent: new Map(),
    dispatchersByEvent: new Map(),
  };

  socket.on('connect', () => {
    socket.emit('join-project', projectId);
  });

  return entry;
}

function getOrCreateProjectSocketEntry(projectId: string): ProjectSocketEntry {
  let entry = projectSocketEntries.get(projectId);
  if (!entry) {
    entry = createProjectSocketEntry(projectId);
    projectSocketEntries.set(projectId, entry);
  }
  return entry;
}

export function subscribeProjectSocket(
  projectId: string,
  handlers: Record<string, ProjectSocketEventHandler>
): () => void {
  const normalizedProjectId = String(projectId || '').trim();
  if (!normalizedProjectId) {
    return () => {};
  }

  const entry = getOrCreateProjectSocketEntry(normalizedProjectId);
  entry.subscriberCount += 1;

  for (const [eventName, handler] of Object.entries(handlers)) {
    if (typeof handler !== 'function') continue;

    let handlerSet = entry.handlersByEvent.get(eventName);
    if (!handlerSet) {
      handlerSet = new Set();
      entry.handlersByEvent.set(eventName, handlerSet);

      const dispatcher: ProjectSocketEventHandler = (payload) => {
        for (const eventHandler of Array.from(handlerSet || [])) {
          try {
            eventHandler(payload);
          } catch (error) {
            console.error('[projectSocket] event handler failed', {
              projectId: normalizedProjectId,
              eventName,
              error,
            });
          }
        }
      };

      entry.dispatchersByEvent.set(eventName, dispatcher);
      entry.socket.on(eventName, dispatcher);
    }

    handlerSet.add(handler);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;

    for (const [eventName, handler] of Object.entries(handlers)) {
      const handlerSet = entry.handlersByEvent.get(eventName);
      if (!handlerSet) continue;

      handlerSet.delete(handler);
      if (handlerSet.size > 0) continue;

      const dispatcher = entry.dispatchersByEvent.get(eventName);
      if (dispatcher) {
        entry.socket.off(eventName, dispatcher);
      }
      entry.dispatchersByEvent.delete(eventName);
      entry.handlersByEvent.delete(eventName);
    }

    entry.subscriberCount = Math.max(0, entry.subscriberCount - 1);
    if (entry.subscriberCount > 0) return;

    entry.socket.emit('leave-project', normalizedProjectId);
    entry.socket.disconnect();
    projectSocketEntries.delete(normalizedProjectId);
  };
}

export function emitProjectSocketEvent(
  projectId: string,
  eventName: string,
  payload?: unknown
): void {
  const normalizedProjectId = String(projectId || '').trim();
  const normalizedEventName = String(eventName || '').trim();
  if (!normalizedProjectId || !normalizedEventName) {
    return;
  }

  const entry = getOrCreateProjectSocketEntry(normalizedProjectId);
  entry.socket.emit(normalizedEventName, payload);
}

export function emitProjectSocketEventWithAck<T = any>(
  projectId: string,
  eventName: string,
  payload?: unknown,
  timeoutMs = 5000
): Promise<T> {
  const normalizedProjectId = String(projectId || '').trim();
  const normalizedEventName = String(eventName || '').trim();
  if (!normalizedProjectId || !normalizedEventName) {
    return Promise.reject(new Error('projectId and eventName are required'));
  }

  const entry = getOrCreateProjectSocketEntry(normalizedProjectId);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      entry.socket.off('disconnect', handleDisconnect);
    };
    const handleDisconnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Socket disconnected before ack for ${normalizedEventName}`));
    };
    const timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Socket ack timed out for ${normalizedEventName}`));
    }, Math.max(1000, timeoutMs));

    entry.socket.on('disconnect', handleDisconnect);
    entry.socket.emit(normalizedEventName, payload, (response: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    });
  });
}
