import { parse } from '@/lib/tokens';
import { TokenBadge } from '@/components/token-badge';

// A sent message, drawn from the same parse the composer uses. Nothing here is
// editable, so unlike the box this side can afford the icon.
//
// The wrapper carries its weight. The transcript drops these into a flex
// column, and a badge handed straight to one is a flex item: the inline-flex
// blockifies, stretch pulls it across the row, and the pill comes out 30ch of
// empty with the label alone at the left end. A span puts the badges back in
// the sentence they were typed in.
export function TokenText({ text }) {
  const nodes = parse(text);
  return (
    <span>
      {nodes.map((n, i) => (n.type === 'text'
        ? <span key={i}>{n.text}</span>
        : <TokenBadge key={i} kind={n.kind} label={n.label} title={n.title} />))}
    </span>
  );
}
