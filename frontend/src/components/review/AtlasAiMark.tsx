interface AtlasAiMarkProps {
  size?: number;
}

export function AtlasAiMark({ size = 18 }: AtlasAiMarkProps) {
  const innerSize = Math.max(8, Math.round(size * 0.52));
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        filter: 'var(--atlas-ai-mark-shadow)',
      }}
    >
      <span style={{
        position: 'absolute',
        inset: Math.max(1, Math.round(size * 0.08)),
        transform: 'rotate(45deg) skew(-4deg, -4deg)',
        borderRadius: Math.max(3, Math.round(size * 0.18)),
        background: 'linear-gradient(135deg, rgba(225, 245, 255, 0.98) 0%, rgba(106, 188, 255, 0.98) 42%, rgba(37, 117, 230, 0.98) 100%)',
        boxShadow: [
          'inset -2px -2px 4px rgba(5, 20, 52, 0.55)',
          'inset 2px 2px 4px rgba(255,255,255,0.72)',
          '0 0 18px rgba(var(--accent-blue-rgb), 0.52)',
        ].join(', '),
      }} />
      <span style={{
        position: 'absolute',
        width: innerSize,
        height: innerSize,
        transform: 'rotate(45deg)',
        borderRadius: Math.max(2, Math.round(size * 0.12)),
        background: 'linear-gradient(135deg, rgba(255,255,255,0.95), rgba(184,244,255,0.28) 48%, rgba(32,92,200,0.12))',
        opacity: 0.92,
        boxShadow: 'inset 1px 1px 2px rgba(255,255,255,0.72)',
      }} />
      <span style={{
        position: 'absolute',
        top: Math.max(1, Math.round(size * 0.12)),
        left: Math.max(2, Math.round(size * 0.2)),
        width: Math.max(4, Math.round(size * 0.28)),
        height: Math.max(2, Math.round(size * 0.1)),
        borderRadius: 999,
        transform: 'rotate(-28deg)',
        background: 'rgba(255,255,255,0.9)',
        filter: 'blur(0.2px)',
      }} />
    </span>
  );
}

export default AtlasAiMark;
