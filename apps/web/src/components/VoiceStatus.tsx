import { useStore } from '../store';

const HINT: Record<string, string> = {
  connecting: 'Connecting the microphone…',
  thinking: 'Thinking…',
};

/** Live caption and state line above the composer while voice is on. */
export function VoiceStatus() {
  const state = useStore((s) => s.voice.state);
  const caption = useStore((s) => s.voice.caption);
  const ptt = useStore((s) => s.voice.ptt);
  if (state === 'off') return null;
  const hint = state === 'speaking' ? (ptt ? 'Speaking. Hold the mic button or Space to interrupt.' : 'Speaking. Talk to interrupt.') : state === 'listening' ? (ptt ? 'Hold the mic button or Space and speak' : 'Listening…') : HINT[state];
  return (
    <div className="mx-auto mb-2 max-w-3xl px-1" data-testid="voice-status" aria-live="polite">
      {caption ? (
        <p className="rounded-xl bg-teal-50 px-3.5 py-2 text-[15px] italic text-teal-900" data-testid="caption">“{caption}”</p>
      ) : (
        <p className="px-1 text-xs text-slate-500" data-testid="voice-hint">{hint}</p>
      )}
    </div>
  );
}
