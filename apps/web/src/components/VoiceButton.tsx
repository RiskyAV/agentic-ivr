import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Mic, MicOff, Settings2, Square } from 'lucide-react';
import { useStore, type VoiceState } from '../store';
import { loadPtt, savePtt, voice } from '../voice/controller';

const LABEL: Record<VoiceState, string> = {
  off: 'Start voice', connecting: 'Connecting…', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking',
};

const RING: Record<VoiceState, string> = {
  off: '', connecting: 'border-slate-300 animate-pulse', listening: 'border-teal-500', thinking: 'border-amber-400 animate-pulse', speaking: 'border-indigo-500',
};

export function VoiceButton() {
  const state = useStore((s) => s.voice.state);
  const connected = useStore((s) => s.connection === 'open');
  const [ptt, setPtt] = useState(loadPtt);
  const [open, setOpen] = useState(false);
  const [held, setHeld] = useState(false);
  const meter = useRef<HTMLSpanElement>(null);
  const on = state !== 'off';

  useEffect(() => voice.onLevel((v) => {
    const el = meter.current;
    if (el) el.style.transform = `scale(${1 + Math.min(1, v * 6) * 0.45})`;
  }), []);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);

  const pttSession = on && ptt;
  const release = () => { if (voice.pttHeld) { voice.setPtt(false); setHeld(false); } };
  const onDown = (e: PointerEvent) => {
    if (!pttSession) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    voice.setPtt(true);
    setHeld(true);
  };
  const onClick = () => {
    if (pttSession) return; // holding talks; the stop button ends the session
    if (on) voice.stop(); else void voice.start(ptt);
  };
  const changePtt = (v: boolean) => { setPtt(v); savePtt(v); };
  useEffect(() => { if (!on) setHeld(false); }, [on]);

  const talking = pttSession && held;
  const title = !on ? 'Talk to Northstar' : pttSession ? 'Hold to talk (or hold Space)' : 'Stop voice';

  return (
    <div className="relative flex items-center gap-1.5" data-testid="voice">
      {pttSession && (
        <button type="button" onClick={() => voice.stop()} aria-label="End voice" title="End voice"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 text-slate-500 hover:bg-slate-100">
          <Square className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        type="button" data-voice-button data-testid="voice-button" data-state={state}
        disabled={!connected && !on}
        aria-label={on ? `${LABEL[state]}. ${title}` : 'Start voice'} aria-pressed={on} title={title}
        onClick={onClick} onPointerDown={onDown} onPointerUp={release} onPointerCancel={release}
        onContextMenu={(e) => e.preventDefault()}
        className={`relative flex h-10 w-10 shrink-0 touch-none select-none items-center justify-center rounded-full border transition disabled:cursor-not-allowed disabled:text-slate-300 ${
          on ? 'border-transparent bg-teal-600 text-white' : 'border-slate-200 text-slate-600 hover:bg-slate-100'} ${talking ? 'bg-teal-700' : ''}`}
      >
        {on && <span ref={meter} aria-hidden="true" className="pointer-events-none absolute -inset-1 rounded-full bg-teal-500/20 transition-transform duration-75" />}
        {on && <span aria-hidden="true" className={`pointer-events-none absolute -inset-1 rounded-full border-2 ${RING[state]}`} />}
        {state === 'speaking' && <span aria-hidden="true" className="pointer-events-none absolute -inset-1 rounded-full border-2 border-indigo-400 animate-ping opacity-40" />}
        {pttSession && !talking ? <MicOff className="relative h-[18px] w-[18px]" /> : <Mic className="relative h-[18px] w-[18px]" />}
      </button>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-label="Voice settings" aria-expanded={open} data-testid="voice-settings"
        className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600">
        <Settings2 className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute bottom-12 right-0 z-30 w-64 rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-xl" role="dialog" aria-label="Voice settings">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input type="checkbox" checked={ptt} disabled={on} onChange={(e) => changePtt(e.target.checked)} data-testid="ptt-toggle" className="mt-0.5 h-4 w-4 accent-teal-600" />
            <span>
              <span className="font-medium text-slate-900">Push-to-talk</span>
              <span className="mt-0.5 block text-xs text-slate-500">Hold the mic button or the Space bar while you speak. Best on speakers.</span>
              {on && <span className="mt-1 block text-xs text-amber-600">End voice to change this.</span>}
            </span>
          </label>
        </div>
      )}
      <span className="sr-only" aria-live="polite">{on ? LABEL[state] : ''}</span>
    </div>
  );
}
