export function getBrowserDefaultApiBaseUrl(): string {
  if (typeof window === 'undefined') {
    return 'http://localhost:3000/api';
  }
  const { protocol, hostname } = window.location;
  const normalizedProtocol = protocol === 'https:' ? 'https:' : 'http:';
  const normalizedHost = hostname || 'localhost';
  return `${normalizedProtocol}//${normalizedHost}:3000/api`;
}
