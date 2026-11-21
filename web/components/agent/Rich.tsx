'use client';
// Formatted, word-by-word replies for the assistant.
//   <Rich text>   a small, safe Markdown subset (no HTML injection): paragraphs, "- " / "1." lists, **bold**,
//                 *italic*, `code`, and "Label: value" lines kept on their own line.
//   useTyped()    reveals a reply word by word once it arrives (faster for long replies), with a caret.
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';

function inline(s: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith('**') ? <strong key={`${key}-${i++}`}>{t.slice(2, -2)}</strong>
      : t.startsWith('`') ? <code key={`${key}-${i++}`}>{t.slice(1, -1)}</code>
      : <em key={`${key}-${i++}`}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last).replace(/\*\*$|\*$|`$/, ''));   // a half-typed marker is not shown
  return out;
}

type Block = { kind: 'p' | 'ul' | 'ol'; lines: string[] };
function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const ul = /^\s*(?:[-*•])\s+(.*)$/.exec(line), ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const kind = ul ? 'ul' : ol ? 'ol' : 'p';
    const body = ul?.[1] ?? ol?.[1] ?? line.replace(/^#{1,6}\s+/, '');
    if (!line.trim()) { out.push({ kind: 'p', lines: [] }); continue; }
    const prev = out[out.length - 1];
    if (prev && prev.kind === kind && (kind !== 'p' || prev.lines.length)) prev.lines.push(body);
    else out.push({ kind, lines: [body] });
  }
  return out.filter(b => b.lines.length);
}

export function Rich({ text, caret }: { text: string; caret?: boolean }) {
  const bs = blocks(text);
  return (
    <div className="rich">
      {bs.map((b, i) => {
        const end = caret && i === bs.length - 1 ? <span className="caret" /> : null;
        if (b.kind === 'p') return <p key={i}>{b.lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l, `${i}.${j}`)}</Fragment>)}{end}</p>;
        const L = b.kind === 'ul' ? 'ul' : 'ol';
        return <L key={i}>{b.lines.map((l, j) => <li key={j}>{inline(l, `${i}.${j}`)}{j === b.lines.length - 1 ? end : null}</li>)}</L>;
      })}
      {!bs.length && caret && <span className="caret" />}
    </div>
  );
}

/** The part of `text` to show now: word by word after it arrives, all of it when `animate` is false. */
export function useTyped(text: string, animate: boolean) {
  const words = text.split(/(\s+)/);
  const [n, setN] = useState(animate ? 0 : words.length);
  const total = useRef(words.length); total.current = words.length;
  useEffect(() => {
    if (!animate) { setN(total.current); return; }
    const step = Math.max(1, Math.round(total.current / 120));          // long replies finish in about 2.5 s
    const t = setInterval(() => setN(x => { if (x >= total.current) { clearInterval(t); return x; } return Math.min(total.current, x + step * 2); }), 22);
    return () => clearInterval(t);
  }, [animate, text]);
  const shown = words.slice(0, n).join('');
  return { shown, typing: n < words.length };
}
