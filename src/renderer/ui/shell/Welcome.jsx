/* Shown over the chat pane until a folder has been chosen. The agent, the
   shells and the chat history are all scoped to one folder, so there is nothing
   useful to draw before that choice is made. */
import { useEffect, useState } from 'react';
import { FolderIcon, FolderOpenIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { onProject, openFolder, openRecent, project, shortPath } from '../../project.js';

export default function Welcome() {
  const [, bump] = useState(0);
  useEffect(() => onProject(() => bump((n) => n + 1)), []);

  if (project.chosen) return null;

  const recents = project.recents.slice(0, 6);

  return (
    <Empty className="absolute inset-0 bg-background">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderOpenIcon />
        </EmptyMedia>
        <EmptyTitle>Open a folder to start</EmptyTitle>
        <EmptyDescription>
          The agent, the shells and the chat history are all scoped to one project folder.
          Pick the one you want to work in.
        </EmptyDescription>
      </EmptyHeader>

      <EmptyContent>
        <div className="flex gap-2">
          <Button onClick={() => openFolder()}>Open folder…</Button>
          <Button variant="outline" onClick={() => openFolder({ newWindow: true })}>New window…</Button>
        </div>

        {recents.length > 0 && (
          <div className="flex w-full max-w-sm flex-col gap-0.5">
            <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Recent</div>
            {recents.map((r) => (
              <Button
                key={r.path}
                variant="ghost"
                className="h-auto justify-start gap-2 px-2 py-1.5 font-normal"
                onClick={() => openRecent(r.path)}>
                <FolderIcon />
                <span className="truncate">{r.name}</span>
                {/* A path is clipped from the left, which is the end you can
                    throw away. */}
                <span
                  dir="rtl"
                  className="ml-auto min-w-0 truncate font-mono text-[11px] text-muted-foreground [unicode-bidi:plaintext]">
                  {shortPath(r.path)}
                </span>
              </Button>
            ))}
          </div>
        )}

        <Button variant="link" className="text-muted-foreground" onClick={() => openFolder({ dir: project.home })}>
          {`Work in ${shortPath(project.home)} instead`}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
