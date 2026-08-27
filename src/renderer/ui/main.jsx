/* React owns the window. app.js still reaches for a few nodes directly, the
   terminal host among them, so the shell has to be on screen before boot()
   runs. render() on its own schedules that work rather than doing it, so flush
   it first. */
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { boot } from '../app.js';
import Shell from './shell/Shell';
import './index.css';

const root = createRoot(document.getElementById('root'));

flushSync(() => {
  root.render(
    <TooltipProvider delayDuration={400}>
      <Shell />
    </TooltipProvider>,
  );
});

boot();
