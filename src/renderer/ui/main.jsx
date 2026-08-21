import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import App from './App';
import './index.css';

const host = document.getElementById('agent-root');
if (host) {
  createRoot(host).render(
    <TooltipProvider delayDuration={400}>
      <App />
    </TooltipProvider>,
  );
}
