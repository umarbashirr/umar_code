/* The Agents tab: the active chat's subagents, and what the chosen one did.

   The list is on top and the transcript fills the rest, the same split as the
   Changes view. The chat keeps one row per agent, and clicking that row, or its
   chip in the running strip, lands here with that agent chosen. With nothing
   chosen the newest agent shows, since it is the one most likely still going.

   A finished agent's transcript stays for as long as the chat does. Reading
   what an agent did after it failed is most of the reason to open one. */
import { useEffect, useSyncExternalStore } from 'react';
import { BotIcon } from 'lucide-react';

import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { MessageResponse } from '@/components/ai-elements/message';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { AgentActions, AgentDot, AgentMeta, agentLine, isLive } from '@/components/agent-row';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { cn } from '@/lib/utils';
import { Items } from '../App';
import { onProject, project } from '../../project.js';
import { agentsState, getAgentsVersion, selectAgent, subscribeAgents } from './agents-store';
import { useLayout } from './Shell';
import { activeKind, subscribeTabs } from './tabs-store';

// Whether this tab is the one on screen, asked the way FilesView asks.
const subscribeTop = (fn) => {
  const offTabs = subscribeTabs(fn);
  const offFocus = onProject(fn);
  return () => { offTabs(); offFocus(); };
};
const onTop = () => activeKind(project.focused) === 'agents';

const PEEK_MS = 3000;

const whatOf = (item) => item.description || item.input?.description || 'Agent';

function AgentList({ agents, current }) {
  return (
    <div className="max-h-[35%] shrink-0 overflow-y-auto border-b p-1.5">
      {agents.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => selectAgent(a.id)}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-secondary/60',
            a.id === current?.id && 'bg-secondary',
          )}>
          <AgentDot item={a} />
          <span className={cn('min-w-0 flex-1 truncate', a.status === 'failed' && 'text-destructive')}>
            {whatOf(a)}
          </span>
          <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground/75">
            <AgentMeta item={a} />
          </span>
        </button>
      ))}
    </div>
  );
}

function AgentDetail({ item, agent }) {
  const under = agentLine(item);
  const prompt = item.input?.prompt;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-2 border-b px-3 py-2">
        <BotIcon className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13px]">{whatOf(item)}</span>
            <span className="shrink-0 text-muted-foreground text-xs">{item.agentType || 'agent'}</span>
          </span>
          {under && (
            <span className="truncate text-muted-foreground text-xs">
              {isLive(item) ? <Shimmer as="span">{under}</Shimmer> : under}
            </span>
          )}
        </div>
        <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground/75">
          <AgentActions item={item} onStop={agent.stopAgent} onBackground={agent.backgroundAgent} />
        </span>
      </div>

      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="gap-3 p-3">
          {prompt && (
            <details className="rounded-md bg-muted/45 px-2.5 py-2 text-[12.5px]">
              <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-muted-foreground/75">
                what it was asked
              </summary>
              <div className="mt-1.5 whitespace-pre-wrap leading-relaxed">{prompt}</div>
            </details>
          )}
          {item.loaded === 'loading' && (
            <Shimmer as="div" className="px-2 py-1 font-mono text-[11px]">reading its transcript…</Shimmer>
          )}
          <Items items={item.children?.length ? item.children : item.peek || []} agent={agent} />
          {isLive(item) && item.background && !item.children?.length && (
            <div className="px-2 text-muted-foreground text-xs">
              {item.peek?.length
                ? 'Running in the background. Read from its transcript every few seconds.'
                : 'Running in the background. Its steps show up here once it writes its first one.'}
            </div>
          )}
          {item.report && (
            <div className="tandem-in rounded-md bg-muted/45 px-2.5 py-2 text-[12.5px] leading-relaxed">
              <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground/75">
                what it came back with
              </span>
              <MessageResponse>{item.report}</MessageResponse>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </div>
  );
}

export default function AgentsView() {
  useSyncExternalStore(subscribeAgents, getAgentsVersion, getAgentsVersion);
  const { rightOpen } = useLayout();
  const top = useSyncExternalStore(subscribeTop, onTop, onTop);
  const showing = rightOpen && top;

  const { agent, agents, selected } = agentsState();
  const current = agents.find((a) => a.id === selected) || agents[agents.length - 1] || null;

  // A replayed chat has the rows but reads a transcript only when one is
  // opened. Being on screen here is opening it.
  const pending = showing && current?.loaded === false ? current : null;
  useEffect(() => {
    if (pending) agent.openAgent(pending);
  }, [pending?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A background agent streams nothing until it is done, so while one is on
  // screen its transcript is read again every few seconds, and once more when
  // it stops being watched so the steps it finished on are not left out.
  const watching = showing && current && isLive(current) && current.background && !current.children?.length ? current : null;
  useEffect(() => {
    if (!watching) return undefined;
    agent.peekAgent(watching);
    const timer = setInterval(() => agent.peekAgent(watching), PEEK_MS);
    return () => { clearInterval(timer); agent.peekAgent(watching); };
  }, [watching?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div id="agents-view" className="flex h-full min-h-0 flex-col" hidden={!showing || undefined}>
      {current ? (
        <>
          <AgentList agents={agents} current={current} />
          {/* Keyed, so switching agents starts the next one scrolled to its end
              rather than wherever the last one was left. */}
          <AgentDetail key={current.id} item={current} agent={agent} />
        </>
      ) : (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon"><BotIcon /></EmptyMedia>
            <EmptyTitle>No agents in this chat</EmptyTitle>
            <EmptyDescription>When the agent hands work to a subagent, it shows up here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
