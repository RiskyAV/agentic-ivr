import { CheckCircle2, Info, ShieldAlert, XCircle } from 'lucide-react';
import type { ChatItem } from '../store';
import { BrandMark } from './Brand';
import { DataTable } from './DataTable';
import { RichText } from './RichText';
import { SourceChips } from './SourceChips';

type Item<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>;

export function UserMessage({ item }: { item: Item<'user'> }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-navy-900 px-4 py-2.5 text-[15px] leading-relaxed text-white shadow-sm sm:max-w-[75%]">
        <p className="whitespace-pre-wrap break-words">{item.text}</p>
      </div>
    </div>
  );
}

export function AssistantAvatar() {
  return <div className="mt-0.5 hidden h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy-900 sm:flex"><BrandMark className="h-6 w-6" /></div>;
}

export function AssistantMessage({ item }: { item: Item<'assistant'> }) {
  return (
    <div className="flex gap-3" data-testid="assistant-message" data-streaming={item.streaming ? 'true' : 'false'}>
      <AssistantAvatar />
      <div className="min-w-0 max-w-full flex-1 sm:max-w-[88%]">
        <div className={`rounded-2xl rounded-tl-md border bg-white px-4 py-3 text-[15px] leading-relaxed text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${item.retracted ? 'border-amber-200' : 'border-slate-200'}`}>
          <RichText text={item.text} caret={item.streaming && !item.retracted} />
          {item.retracted && (
            <p className="mt-2.5 flex items-center gap-1.5 border-t border-amber-100 pt-2 text-xs text-amber-700"><ShieldAlert className="h-3.5 w-3.5" />Earlier reply withdrawn by safety check</p>
          )}
          {item.interrupted && <p className="mt-2 text-[11px] italic text-slate-400" data-testid="interrupted">interrupted</p>}
          {item.tables?.map((t, i) => <DataTable key={i} table={t} />)}
          {!item.streaming && <SourceChips sources={item.sources} />}
        </div>
      </div>
    </div>
  );
}

export function NoticeMessage({ item }: { item: Item<'notice'> }) {
  const Icon = item.tone === 'success' ? CheckCircle2 : item.tone === 'error' ? XCircle : Info;
  return (
    <div className="flex justify-center">
      <p className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ${item.tone === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
        <Icon className="h-3.5 w-3.5" />{item.text}
      </p>
    </div>
  );
}
