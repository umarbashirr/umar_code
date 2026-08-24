'use client';
// What the agent gets instead of an Allow/Deny card when it calls
// AskUserQuestion. One question on screen at a time; nothing is sent until the
// last one is answered, so every earlier answer stays open to a change of mind.
// The answers ride back as updatedInput.answers, keyed by the question text,
// which is the shape the tool itself returns: see AskUserQuestionInput in the
// SDK's sdk-tools.d.ts.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeftIcon, MessageCircleQuestionIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';

const OTHER = '__other__';

// Multi-select answers go back as one comma-separated string, which is what the
// tool's own output type promises the model.
const answerFor = (pick, typed) => {
  const chosen = Array.isArray(pick) ? pick : [pick];
  return chosen
    .filter(Boolean)
    .map((label) => (label === OTHER ? typed.trim() : label))
    .filter(Boolean)
    .join(', ');
};

function Option({ multi, option, checked, onPick, id }) {
  const Control = multi ? Checkbox : RadioGroupItem;
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 transition-colors',
        checked ? 'border-primary/50 bg-accent/40' : 'border-transparent hover:bg-accent/40',
      )}>
      <Control
        id={id}
        aria-label={option.label}
        className="mt-0.5"
        {...(multi
          ? { checked, onCheckedChange: () => onPick(option.value) }
          : { value: option.value })} />
      <span className="min-w-0">
        <span className="block text-[13px] leading-snug">{option.label}</span>
        {option.description && (
          <span className="block text-muted-foreground text-xs leading-snug">{option.description}</span>
        )}
      </span>
    </label>
  );
}

export function QuestionCard({ input, onAnswer, onSkip }) {
  const uid = useId();
  const questions = useMemo(() => (Array.isArray(input?.questions) ? input.questions : []), [input]);
  const [step, setStep] = useState(0);
  // question text -> chosen label, or an array of them when multiSelect is on
  const [picked, setPicked] = useState({});
  // question text -> whatever was typed into Other
  const [typed, setTyped] = useState({});

  // Picking the answer to a single-choice question moves on by itself, after
  // just long enough to see what got picked.
  const timer = useRef(null);
  const cancelAdvance = () => { clearTimeout(timer.current); timer.current = null; };
  useEffect(() => cancelAdvance, []);

  const goTo = useCallback((i) => { cancelAdvance(); setStep(i); }, []);

  const answers = useMemo(() => {
    const out = {};
    for (const q of questions) {
      const a = answerFor(picked[q.question], typed[q.question] || '');
      if (a) out[q.question] = a;
    }
    return out;
  }, [questions, picked, typed]);

  const choose = useCallback((question, value, multi, isLast) => {
    setPicked((cur) => {
      if (!multi) return { ...cur, [question]: value };
      const had = cur[question] || [];
      return { ...cur, [question]: had.includes(value) ? had.filter((v) => v !== value) : [...had, value] };
    });
    cancelAdvance();
    // Other has nothing to move on from until it is typed into.
    if (!multi && value !== OTHER && !isLast) {
      timer.current = setTimeout(() => setStep((s) => s + 1), 200);
    }
  }, []);

  // Previews are the one thing the tool wants handed back alongside the answer,
  // so whatever the human settled on travels with it.
  const annotations = useMemo(() => {
    const out = {};
    for (const q of questions) {
      const chosen = [].concat(picked[q.question] || []);
      const preview = q.options?.find((o) => chosen.includes(o.label) && o.preview)?.preview;
      if (preview) out[q.question] = { preview };
    }
    return Object.keys(out).length ? out : undefined;
  }, [questions, picked]);

  if (!questions.length) return null;

  const at = Math.min(step, questions.length - 1);
  const q = questions[at];
  const last = at === questions.length - 1;
  const multi = !!q.multiSelect;
  const chosen = [].concat(picked[q.question] || []);
  const answered = !!answers[q.question];
  const allAnswered = questions.every((one) => answers[one.question]);

  const options = [
    ...(q.options || []).map((o) => ({ ...o, value: o.label })),
    { label: 'Other', description: 'Answer in your own words', value: OTHER },
  ];

  const rows = options.map((option, oi) => (
    <Option
      key={option.value}
      multi={multi}
      option={option}
      id={`${uid}-${at}-${oi}`}
      checked={chosen.includes(option.value)}
      onPick={(v) => choose(q.question, v, multi, last)} />
  ));

  return (
    <div className="rounded-md border bg-card px-3 py-3">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <MessageCircleQuestionIcon className="size-3.5" />
        <span>The agent is asking</span>
        {questions.length > 1 && <span className="ml-auto">{at + 1} of {questions.length}</span>}
      </div>

      {/* Every question already answered, one click away. Nothing is sent until
          the last one is done, so changing an earlier answer costs nothing. */}
      {questions.length > 1 && (
        <div className="flex flex-wrap gap-1 pt-2">
          {questions.map((one, i) => {
            const done = !!answers[one.question];
            return (
              <button
                key={one.question}
                type="button"
                disabled={!done && i !== at}
                onClick={() => goTo(i)}
                className={cn(
                  'max-w-[16rem] truncate rounded-full border px-2 py-0.5 text-xs transition-colors',
                  i === at
                    ? 'border-primary/50 bg-accent/40 text-foreground'
                    : done
                      ? 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
                      : 'border-dashed border-border/60 text-muted-foreground/50',
                )}>
                {one.header || `Question ${i + 1}`}
                {done && i !== at && <span className="opacity-60"> · {answers[one.question]}</span>}
              </button>
            );
          })}
        </div>
      )}

      <div className="pt-3">
        {/* With several questions the row above already names this one. */}
        {q.header && questions.length === 1 && (
          <Badge variant="outline" className="mb-1.5">{q.header}</Badge>
        )}
        <p className="pb-2 text-[13px] leading-snug">{q.question}</p>

        {multi ? (
          <div className="grid gap-1">{rows}</div>
        ) : (
          <RadioGroup
            className="gap-1"
            value={chosen[0] || ''}
            onValueChange={(v) => choose(q.question, v, false, last)}>
            {rows}
          </RadioGroup>
        )}

        {chosen.includes(OTHER) && (
          <Input
            autoFocus
            className="mt-2 h-8 text-[13px]"
            placeholder="Your answer"
            value={typed[q.question] || ''}
            onChange={(e) => setTyped((cur) => ({ ...cur, [q.question]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !answers[q.question]) return;
              e.preventDefault();
              if (last) { if (allAnswered) onAnswer(answers, annotations); } else goTo(at + 1);
            }} />
        )}
      </div>

      <div className="flex items-center gap-1.5 pt-3">
        {at > 0 && (
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => goTo(at - 1)}>
            <ArrowLeftIcon className="size-3.5" />
            Back
          </Button>
        )}

        {last ? (
          <Button size="sm" className="h-7" disabled={!allAnswered} onClick={() => onAnswer(answers, annotations)}>
            {questions.length > 1 ? 'Send answers' : 'Send answer'}
          </Button>
        ) : (
          <Button size="sm" className="h-7" disabled={!answered} onClick={() => goTo(at + 1)}>
            Next
          </Button>
        )}

        <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={onSkip}>
          Skip
        </Button>
      </div>
    </div>
  );
}
