import { parse } from '@/lib/tokens';
import { TokenBadge } from '@/components/token-badge';

// A sent message, drawn from the same parse the composer uses. Nothing here is
// editable, so unlike the box this side can afford the icon.
export function TokenText({ text }) {
  const nodes = parse(text);
  return nodes.map((n, i) => (n.type === 'text'
    ? <span key={i}>{n.text}</span>
    : <TokenBadge key={i} kind={n.kind} label={n.label} title={n.title} />));
}
