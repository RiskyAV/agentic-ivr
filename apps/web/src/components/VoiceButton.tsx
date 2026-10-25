import { Mic } from 'lucide-react';

/** Placeholder: voice capture and playback are wired in Task 19. */
export function VoiceButton() {
  return (
    <button
      type="button" disabled title="Voice is coming soon" aria-label="Voice (coming soon)"
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-200 text-slate-400 disabled:cursor-not-allowed"
    >
      <Mic className="h-[18px] w-[18px]" />
    </button>
  );
}
