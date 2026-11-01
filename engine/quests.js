// Quest helper: each quest's state from the save, what its current step asks for, and whether a
// quest that hasn't started can be: its requirements are claimed quests (QuestComplete means
// claimed), and it's only shown once its display requirements are met too.

// Every quest `id` needs before it can start, directly or through the quests it needs.
function prerequisites(byId, id, seen = new Set()) {
  for (const r of byId.get(id)?.requires ?? []) {
    if (seen.has(r)) continue;
    seen.add(r);
    prerequisites(byId, r, seen);
  }
  return seen;
}

export function questStatus(gd, save, { stock = null } = {}) {
  const saved = save?.quests ?? {};
  const list = (gd.raw.quests ?? []).filter((q) => q.inGame);
  const byId = new Map(list.map((q) => [q.id, q]));
  const claimed = (id) => saved[id]?.state === 'claimed';
  return list.map((q) => {
    const s = saved[q.id];
    const state = s?.state ?? 'unstarted';
    const blockedBy = q.requires.filter((id) => !claimed(id));
    const hiddenBy = q.shownAfter.filter((id) => !claimed(id));
    // Hidden until a quest that itself needs this one is claimed: it can never be shown.
    const unreachable = hiddenBy.some((id) => id === q.id || prerequisites(byId, id).has(q.id));
    const stepIndex = state === 'inProgress' ? q.steps.findIndex((st) => s.steps?.[st.id]?.state !== 'complete') : -1;
    const step = stepIndex >= 0 ? q.steps[stepIndex] : null;
    const tasks = step
      ? step.tasks.map((t) => {
          const st = s.steps?.[step.id]?.tasks?.[t.id];
          return {
            task: t,
            state: st?.state ?? 'inactive',
            goals: t.goals.map((g) => {
              const sg = st?.goals?.[g.id];
              const max = Math.max(1, g.max);
              return { goal: g, max, done: !!sg?.complete, progress: sg?.complete ? max : Math.min(max, sg?.progress ?? 0) };
            }),
            costs: t.costs.map((c) => ({ ...c, have: stock?.[c.item] ?? 0 })),
            paid: !!st?.costsMet,
          };
        })
      : [];
    return {
      quest: q,
      state,
      canStart: state === 'unstarted' && !blockedBy.length && !hiddenBy.length,
      blockedBy,
      hiddenBy,
      unreachable,
      stepIndex,
      step,
      tasks,
    };
  });
}
