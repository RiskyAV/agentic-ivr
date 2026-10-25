export function BrandMark({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#14b8a6" fillOpacity="0.14" />
      <path d="M16 5l2.8 8.2L27 16l-8.2 2.8L16 27l-2.8-8.2L5 16l8.2-2.8z" fill="#2dd4bf" />
      <circle cx="16" cy="16" r="2.2" fill="#0b1f3a" />
    </svg>
  );
}

export function Wordmark({ tone = 'light' }: { tone?: 'light' | 'dark' }) {
  return (
    <div className="flex items-center gap-2.5">
      <BrandMark />
      <div className="leading-none">
        <div className={`text-[15px] font-semibold tracking-tight ${tone === 'light' ? 'text-white' : 'text-navy-900'}`}>Northstar</div>
        <div className={`mt-0.5 text-[10px] font-medium uppercase tracking-[0.18em] ${tone === 'light' ? 'text-teal-300/90' : 'text-teal-700'}`}>Finance</div>
      </div>
    </div>
  );
}
