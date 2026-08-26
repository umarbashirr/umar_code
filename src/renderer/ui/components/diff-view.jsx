// File edits read as diffs, not as JSON with two long strings in it.

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// A diff is content rather than a step, which is what keeps these out of a
// folded run of tool calls.
export const isEditTool = (name) => EDIT_TOOLS.has(name);

// A file that ends in a newline would otherwise diff as an extra blank line.
const lines = (text) => {
  if (!text) return [];
  const rows = text.split('\n');
  if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
  return rows;
};

// Small LCS line diff. Edits are short; anything huge falls back to blocks.
function lineDiff(before, after) {
  const a = lines(before);
  const b = lines(after);
  if (a.length * b.length > 160000) {
    return [...a.map((l) => ['-', l]), ...b.map((l) => ['+', l])];
  }
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push([' ', a[i]]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { rows.push(['-', a[i]]); i++; }
    else { rows.push(['+', b[j]]); j++; }
  }
  while (i < n) rows.push(['-', a[i++]]);
  while (j < m) rows.push(['+', b[j++]]);
  return rows;
}

// Collapse long runs of untouched lines the way a patch does.
function trimContext(rows, keep = 3) {
  const changed = rows.map((r) => r[0] !== ' ');
  const near = rows.map((_, i) =>
    changed.slice(Math.max(0, i - keep), i + keep + 1).some(Boolean));
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (near[i]) out.push(rows[i]);
    else if (out.length && out[out.length - 1][0] !== '~') out.push(['~', '']);
  }
  return out;
}

export function editHunks(name, input = {}) {
  if (!EDIT_TOOLS.has(name)) return null;
  if (name === 'Write') return [{ before: '', after: input.content ?? '' }];
  if (Array.isArray(input.edits)) {
    return input.edits.map((e) => ({ before: e.old_string ?? '', after: e.new_string ?? '' }));
  }
  if (input.old_string !== undefined || input.new_string !== undefined) {
    return [{ before: input.old_string ?? '', after: input.new_string ?? '' }];
  }
  if (input.new_source !== undefined) {
    return [{ before: input.old_source ?? '', after: input.new_source ?? '' }];
  }
  return null;
}

export function hunkStats(hunks) {
  let added = 0;
  let removed = 0;
  for (const h of hunks || []) {
    for (const [kind] of lineDiff(h.before ?? '', h.after ?? '')) {
      if (kind === '+') added++;
      else if (kind === '-') removed++;
    }
  }
  return { added, removed };
}

const ROW = {
  '+': 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  '-': 'bg-rose-500/10 text-rose-700 dark:text-rose-300',
  ' ': 'text-muted-foreground',
  '~': 'text-muted-foreground/50 select-none',
};

export function DiffView({ hunks, max = 400 }) {
  return (
    <div className="space-y-2">
      {hunks.map((h, hi) => {
        const rows = trimContext(lineDiff(h.before ?? '', h.after ?? ''));
        const shown = rows.slice(0, max);
        return (
          <div key={hi} className="overflow-x-auto rounded-md bg-muted/40 py-1 font-mono text-[11px] leading-relaxed">
            {shown.map(([kind, text], i) => (
              <div key={i} className={`flex ${ROW[kind]}`}>
                <span className="w-6 shrink-0 select-none pl-2 opacity-60">
                  {kind === '~' ? '' : kind === ' ' ? '' : kind}
                </span>
                <span className="whitespace-pre pr-3">{kind === '~' ? '⋯' : text || ' '}</span>
              </div>
            ))}
            {rows.length > max && (
              <div className="px-3 py-1 text-muted-foreground/60">
                {rows.length - max} more lines
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
