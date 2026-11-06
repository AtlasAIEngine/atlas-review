export const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

export function getSocketUserId(socket) {
  return socket?.request?.user?.id || socket?.user?.id || null;
}

export function canAccessProjectFromSocket(project, socket) {
  if (!project) return false;
  if (project.user_id === ANONYMOUS_USER_ID) return true;
  const socketUserId = getSocketUserId(socket);
  return Boolean(socketUserId && project.user_id === socketUserId);
}
