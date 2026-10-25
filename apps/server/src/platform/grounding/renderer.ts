import type { Channel } from '@app/shared';
import { formatBound, type BoundValue } from './values.js';

export interface Segment { text: string; bound: boolean }

const KEY = /^[a-z0-9_]+(?:\.[A-Za-z0-9_-]+)+$/;
/** Text after `{{` that could still grow into a valid placeholder. */
const PARTIAL = /^\{\{ *[a-z0-9_]*(?:\.[A-Za-z0-9_-]*)* *\}?$/;
const MAX_HOLD = 80;

/**
 * Streams LLM text, replacing `{{key}}` placeholders with code-formatted values (D-015).
 * Holds back only a trailing fragment that might still become a placeholder.
 * Unresolved keys fail closed ("[unverified]" / spoken equivalent).
 */
export class PlaceholderRenderer {
  readonly unresolved: string[] = [];
  private buf = '';
  private segs: Segment[] = [];

  constructor(private readonly values: () => Record<string, BoundValue>, private readonly channel: Channel) {}

  segments(): Segment[] {
    return this.segs.map((s) => ({ ...s }));
  }

  push(chunk: string): string {
    this.buf += chunk;
    let out = '';
    for (;;) {
      const i = this.buf.indexOf('{');
      if (i < 0) { out += this.lit(this.buf); this.buf = ''; break; }
      out += this.lit(this.buf.slice(0, i));
      const rest = this.buf.slice(i);
      if (rest === '{') { this.buf = rest; break; }
      if (!rest.startsWith('{{')) { out += this.lit('{'); this.buf = rest.slice(1); continue; }
      const close = rest.indexOf('}}');
      if (close >= 0) {
        const key = rest.slice(2, close).trim();
        if (close <= MAX_HOLD && /^ *\S+ *$/.test(rest.slice(2, close)) && KEY.test(key)) {
          out += this.bind(key);
          this.buf = rest.slice(close + 2);
        } else {
          out += this.lit('{{');
          this.buf = rest.slice(2);
        }
        continue;
      }
      if (rest.length <= MAX_HOLD && PARTIAL.test(rest)) { this.buf = rest; break; }
      out += this.lit('{{');
      this.buf = rest.slice(2);
    }
    return out;
  }

  /** Flush anything held; an unterminated `{{...` is plain text, not an unresolved placeholder. */
  end(): string {
    const out = this.lit(this.buf);
    this.buf = '';
    return out;
  }

  private lit(t: string): string {
    if (t) this.add(t, false);
    return t;
  }

  private bind(key: string): string {
    const v = this.values()[key];
    let t: string;
    if (v === undefined) {
      if (!this.unresolved.includes(key)) this.unresolved.push(key);
      t = this.channel === 'voice' ? "a figure I couldn't verify" : '[unverified]';
    } else {
      t = formatBound(v, this.channel);
    }
    this.add(t, true);
    return t;
  }

  private add(text: string, bound: boolean): void {
    const last = this.segs[this.segs.length - 1];
    if (last && last.bound === bound) last.text += text;
    else this.segs.push({ text, bound });
  }
}
