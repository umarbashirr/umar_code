/* Toasts.

   The call shape is the one the rest of the shell already uses:

     toast('Local server detected', url, [
       { label: 'Open', primary: true, run },
       { label: 'Always', run },
       { label: 'Ignore' },
     ])

   sonner draws one action and one cancel, which covers most of these. Anything
   with more choices than that is rendered whole, because dropping a button
   would drop a decision somebody has to make. */
import { toast as sonner } from 'sonner';
import { Button } from '@/components/ui/button';

// An action with nothing to run is an acknowledgement, which is what a toast
// does by itself when it times out.
const isDismiss = (a) => !a.run;

function Card({ id, title, description, actions }) {
  return (
    <div className="flex w-full flex-col gap-2 rounded-(--radius) border bg-popover p-4 text-sm shadow-lg">
      <div className="font-medium">{title}</div>
      {description && (
        <div dir="rtl" className="truncate font-mono text-xs text-muted-foreground [unicode-bidi:plaintext]">
          {description}
        </div>
      )}
      <div className="flex justify-end gap-2">
        {actions.map((a) => (
          <Button
            key={a.label}
            size="sm"
            variant={a.primary ? 'default' : 'ghost'}
            onClick={() => { sonner.dismiss(id); a.run?.(); }}>
            {a.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function toast(title, description, actions = []) {
  const real = actions.filter((a) => !isDismiss(a));

  if (real.length === 0) return sonner(title, { description });

  if (real.length === 1) {
    const [only] = real;
    const cancel = actions.find(isDismiss);
    return sonner(title, {
      description,
      action: { label: only.label, onClick: () => only.run() },
      ...(cancel ? { cancel: { label: cancel.label, onClick: () => {} } } : {}),
    });
  }

  return sonner.custom(
    (id) => <Card id={id} title={title} description={description} actions={actions} />,
    { duration: 15000 },
  );
}
