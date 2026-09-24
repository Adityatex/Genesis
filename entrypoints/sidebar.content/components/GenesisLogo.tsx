// entrypoints/sidebar.content/components/GenesisLogo.tsx
export default function GenesisLogo({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" width={size} height={size}>
      <defs>
        <linearGradient id="nexusGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style={{ stopColor: '#6366f1', stopOpacity: 1 }} />
          <stop offset="100%" style={{ stopColor: '#3b82f6', stopOpacity: 1 }} />
        </linearGradient>
        <filter id="coreGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>
      <path d="M50 8 L88 30 V70 L50 92 L12 70 V30 L50 8Z" stroke="url(#nexusGrad)" strokeWidth="7" strokeLinejoin="round" />
      <path d="M50 8 V35" stroke="url(#nexusGrad)" strokeWidth="5" strokeLinecap="round" />
      <path d="M12 70 L35 57" stroke="url(#nexusGrad)" strokeWidth="5" strokeLinecap="round" />
      <path d="M88 70 L65 57" stroke="url(#nexusGrad)" strokeWidth="5" strokeLinecap="round" />
      <circle cx="50" cy="50" r="14" fill="white" filter="url(#coreGlow)" />
      <circle cx="50" cy="50" r="8" fill="url(#nexusGrad)" />
    </svg>
  );
}
