'use client';
// Formatted, word-by-word replies for the assistant.
//   <Rich text onAsk>  a safe Markdown subset (no HTML injection) plus the assistant's own conventions:
//     paragraphs, "- " / "1." lists, tables (| a | b |), **bold**, *italic*, `code` (click to copy),
//     links: [text](url), bare https://… and site paths like /guest/abc (open in a new tab),
//     PIN / OTP / codes: "PIN: 123456" becomes a large code you can copy,
//     [[a request]]: a button that sends that request to the assistant and runs it.
//   useTyped()  reveals a reply word by word once it arrives (faster for long replies), with a caret.
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';

type Ask = ((q: string) => void) | undefined;

function Copy({ value, big }: { value: string; big?: boolean }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" className={`rc-code ${big ? 'big' : ''} ${ok ? 'copied' : ''}`} title="Copy"
      onClick={() => { navigator.clipboard?.writeText(value).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); }).catch(() => {}); }}>
      <span>{value}</span><i>{ok ? '✓' : '⧉'}</i>
    </button>
  );
}

const isUrl = (u: string) => /^(https?:\/\/|\/[a-z])/i.test(u);
function Link({ href, children }: { href: string; children: ReactNode }) {
  return <a className="rc-link" href={href} target="_blank" rel="noopener noreferrer">{children}<i>↗</i></a>;
}

// one pattern for every inline element; the first group that matches decides what it is
const INLINE_SRC = [
  String.raw`\[\[([^\]]{1,160})\]\]`,                                   // 1  [[request]]
  String.raw`\[([^\]]{1,120})\]\(((?:https?:\/\/|\/)[^\s)]+)\)`,       // 2,3 [text](url)
  String.raw`\b((?:PIN|OTP|code|passcode|password)\s*[:=]?\s*)(\d{4,8})\b`, // 4,5 PIN: 123456
  String.raw`(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])`,                 // 6  bare url
  String.raw`(?<![\w/])(\/(?:guest|here|tech|story|integrations)\/?[\w\-./?=&]*)`, // 7 site path
  String.raw`\*\*([^*]+)\*\*`,                                          // 8  bold
  String.raw`\x60([^\x60]+)\x60`,                                       // 9  code
  String.raw`\*([^*\s][^*]*)\*`,                                        // 10 italic
].join('|');

function inline(s: string, key: string, onAsk: Ask): ReactNode[] {
  const out: ReactNode[] = [];
  // a fresh pattern per call: bold text is rendered recursively, and a shared /g pattern's position would be reset
  const INLINE = new RegExp(INLINE_SRC, 'gi');
  let last = 0, i = 0, m: RegExpExecArray | null;
  while ((m = INLINE.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(onAsk ? <button type="button" key={k} className="rc-act" onClick={() => onAsk(m![1])}>{m[1]}<i>›</i></button> : <b key={k}>{m[1]}</b>);
    else if (m[2]) out.push(<Link key={k} href={m[3]}>{m[2]}</Link>);
    else if (m[5]) out.push(<Fragment key={k}>{m[4]}<Copy value={m[5]} big /></Fragment>);
    else if (m[6]) out.push(<Link key={k} href={m[6]}>{m[6].replace(/^https?:\/\//, '').slice(0, 48)}{m[6].length > 56 ? '…' : ''}</Link>);
    else if (m[7]) out.push(<Link key={k} href={m[7]}>{m[7].length > 40 ? m[7].slice(0, 38) + '…' : m[7]}</Link>);
    else if (m[8]) out.push(<strong key={k}>{inline(m[8], k, onAsk)}</strong>);
    else if (m[9]) out.push(/^[A-Za-z0-9_\-.:/]{4,}$/.test(m[9]) && /\d/.test(m[9]) ? <Copy key={k} value={m[9]} /> : <code key={k}>{m[9]}</code>);   // copy codes and ids, not names
    else if (m[10]) out.push(<em key={k}>{m[10]}</em>);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last).replace(/\*\*$|\*$|`$|\[\[[^\]]*$/, ''));   // a half-typed marker is not shown
  return out;
}

type Block = { kind: 'p' | 'ul' | 'ol' | 'table'; lines: string[]; start?: number };
function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { out.push({ kind: 'p', lines: [] }); continue; }
    const ul = /^\s*(?:[-*•])\s+(.*)$/.exec(line), ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line), tb = /^\s*\|.*\|\s*$/.test(line);
    const kind = tb ? 'table' : ul ? 'ul' : ol ? 'ol' : 'p';
    const body = tb ? line.trim() : ul?.[1] ?? ol?.[2] ?? line.replace(/^#{1,6}\s+/, '');
    const prev = out[out.length - 1];
    if (prev && prev.kind === kind && (kind !== 'p' || prev.lines.length)) prev.lines.push(body);
    else out.push({ kind, lines: [body], ...(ol ? { start: Number(ol[1]) } : {}) });   // a numbered list keeps its numbers across paragraphs
  }
  return out.filter(b => b.lines.length);
}

function Table({ lines, k, onAsk }: { lines: string[]; k: string; onAsk: Ask }) {
  const rows = lines.filter(l => !/^\|[\s:|-]+\|$/.test(l)).map(l => l.slice(1, -1).split('|').map(c => c.trim()));
  if (!rows.length) return null;
  const [head, ...body] = rows;
  return (
    <div className="rc-table"><table>
      <thead><tr>{head.map((c, i) => <th key={i}>{inline(c, `${k}h${i}`, onAsk)}</th>)}</tr></thead>
      <tbody>{body.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{inline(c, `${k}${i}.${j}`, onAsk)}</td>)}</tr>)}</tbody>
    </table></div>
  );
}

export function Rich({ text, caret, onAsk }: { text: string; caret?: boolean; onAsk?: (q: string) => void }) {
  const bs = blocks(text);
  return (
    <div className="rich">
      {bs.map((b, i) => {
        const end = caret && i === bs.length - 1 ? <span className="caret" /> : null;
        if (b.kind === 'table') return <Fragment key={i}><Table lines={b.lines} k={`t${i}`} onAsk={onAsk} />{end}</Fragment>;
        if (b.kind === 'p') return <p key={i}>{b.lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l, `${i}.${j}`, onAsk)}</Fragment>)}{end}</p>;
        const L = b.kind === 'ul' ? 'ul' : 'ol';
        return <L key={i} {...(b.kind === 'ol' && b.start && b.start > 1 ? { start: b.start } : {})}>{b.lines.map((l, j) => <li key={j}>{inline(l, `${i}.${j}`, onAsk)}{j === b.lines.length - 1 ? end : null}</li>)}</L>;
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
  return { shown: words.slice(0, n).join(''), typing: n < words.length };
}
