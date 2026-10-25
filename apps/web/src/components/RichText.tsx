import { Fragment, type ReactNode } from 'react';

/** Minimal, safe formatting for assistant text: paragraphs, "-"/"1." lists and **bold**. No HTML is ever interpreted. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4
      ? <strong key={i} className="font-semibold text-slate-900">{part.slice(2, -2)}</strong>
      : <Fragment key={i}>{part}</Fragment>,
  );
}

export function RichText({ text, caret }: { text: string; caret?: boolean }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="space-y-2.5">
      {blocks.map((block, bi) => {
        const lines = block.split('\n');
        const last = bi === blocks.length - 1;
        const isList = lines.length > 0 && lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l) || l.trim() === '');
        if (isList) {
          const ordered = /^\s*\d+[.)]/.test(lines[0] ?? '');
          const items = lines.filter((l) => l.trim() !== '').map((l) => l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
          const Tag = ordered ? 'ol' : 'ul';
          return (
            <Tag key={bi} className={`space-y-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-slate-400`}>
              {items.map((it, ii) => <li key={ii}>{inline(it)}{caret && last && ii === items.length - 1 && <Caret />}</li>)}
            </Tag>
          );
        }
        return (
          <p key={bi} className="whitespace-pre-line">
            {inline(block)}{caret && last && <Caret />}
          </p>
        );
      })}
    </div>
  );
}

function Caret() {
  return <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] animate-pulse bg-teal-600" aria-hidden="true" />;
}
