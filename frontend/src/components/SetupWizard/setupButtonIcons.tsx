type SetupButtonIconName =
  | 'arrow-left'
  | 'arrow-right'
  | 'check'
  | 'folder'
  | 'key'
  | 'plug'
  | 'refresh'
  | 'sparkles';

const ICON_PATHS: Record<SetupButtonIconName, string> = {
  'arrow-left': 'M19 12H5m0 0 6-6m-6 6 6 6',
  'arrow-right': 'M5 12h14m0 0-6-6m6 6-6 6',
  check: 'M20 6 9 17l-5-5',
  folder: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z',
  key: 'M15 7a4 4 0 1 1-2.8 6.8L9 17H7v2H4v-3l4.2-4.2A4 4 0 0 1 15 7Zm0 0h.01',
  plug: 'M9 7V3m6 4V3M7 11h10v2a5 5 0 0 1-10 0v-2Zm5 7v3',
  refresh: 'M20 12a8 8 0 0 1-13.66 5.66M4 12A8 8 0 0 1 17.66 6.34M18 3v4h-4M6 21v-4h4',
  sparkles: 'M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3Z',
};

export function SetupButtonIcon({
  name,
  size = 16,
}: {
  name: SetupButtonIconName;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
