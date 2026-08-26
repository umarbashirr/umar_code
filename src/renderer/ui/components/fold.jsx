// A row's body, opening and closing. Three places in the transcript disclose
// something and all three used to do it by dropping the body into the document
// at full height, which lands as a jolt and tells the reader nothing about
// where the new content came from.
//
// The body stays out of the document while it is shut. That is the whole
// reason this is a component rather than a class: a folded run can hold twenty
// tool calls, each with a diff and four thousand characters of output, and
// rendering all of it behind a closed chevron costs more than the animation is
// worth. So it mounts at zero height and grows on the next frame.
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

const MS = 180;

export function Fold({ open, className, children }) {
  // Two states, because they turn over at different times: `mounted` covers the
  // whole animation in both directions, `grown` is what the transition reads.
  const [mounted, setMounted] = useState(open);
  const [grown, setGrown] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // A frame between arriving at 0fr and being told to go to 1fr. Set both
      // in one go and the browser never sees the closed state, so there is
      // nothing to transition from.
      const f = requestAnimationFrame(() => setGrown(true));
      return () => cancelAnimationFrame(f);
    }
    setGrown(false);
    const t = setTimeout(() => setMounted(false), MS);
    return () => clearTimeout(t);
  }, [open]);

  if (!mounted) return null;

  return (
    <div className="tandem-fold" data-open={grown}>
      <div>
        <div className={cn(className)}>{children}</div>
      </div>
    </div>
  );
}
