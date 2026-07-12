(function registerTaskJournal() {
  const api = window.ControlCenterExtensions.register('task-journal', {
    projectFields: {
      'manual-checkpoints': {
        render(ctx) {
          const input = ctx.h('input', { type: 'checkbox', 'data-task-journal-manual': '1' });
          if (ctx.project && ctx.project.id) {
            ctx.api.getState('project', ctx.project.id).then((state) => {
              input.checked = !!state.manualCheckpoints;
            }).catch(() => {});
          }
          return ctx.h('label', { class: 'checkbox task-journal-field' },
            input,
            ' Manual journal checkpoints',
          );
        },
        async save(ctx) {
          if (!ctx.project || !ctx.project.id) return;
          const input = ctx.form.querySelector('[data-task-journal-manual]');
          if (!input) return;
          await ctx.api.setState('project', ctx.project.id, { manualCheckpoints: !!input.checked });
        },
      },
    },
    projectBadges: {
      'pending-journal': {
        render(ctx) {
          const metadata = ctx.project && ctx.project.extension_metadata;
          const journal = metadata && metadata['task-journal'];
          if (!journal || !journal.pendingCount) return null;
          return ctx.h('span', {
            class: 'graphify-pill task-journal-pill',
            title: `${journal.pendingCount} completed task${journal.pendingCount === 1 ? '' : 's'} since the last checkpoint`,
          }, `Journal ${journal.pendingCount}`);
        },
      },
    },
    projectActions: {
      'open-journal': {
        render(ctx) {
          if (!ctx.project) return null;
          return ctx.h('button', {
            type: 'button',
            class: 'btn btn-sm',
            onclick: () => openJournal(ctx),
          }, 'Open journal');
        },
      },
    },
  });

  async function openJournal(ctx) {
    const state = await ctx.api.getState('project', ctx.project.id);
    const entries = Array.isArray(state.entries) ? state.entries : [];
    const checkpointAt = state.checkpointAt || null;
    const pending = checkpointAt
      ? entries.filter((entry) => String(entry.completedAt || '') > checkpointAt)
      : entries;
    const body = ctx.h('div', { class: 'task-journal-modal' },
      pending.length
        ? ctx.h('div', { class: 'task-journal-list' }, ...pending.map((entry) =>
            ctx.h('div', { class: 'task-journal-entry' },
              ctx.h('strong', {}, entry.title || entry.taskId),
              ctx.h('span', {}, `${entry.provider || 'unknown'} · ${formatDate(entry.completedAt)}`),
            )))
        : ctx.h('div', { class: 'empty-state' }, 'No completed tasks since the last checkpoint.'),
    );
    const actions = [
      ctx.h('button', {
        type: 'button',
        class: 'btn btn-sm',
        onclick: () => copyMarkdown(ctx, pending),
        disabled: pending.length ? null : 'disabled',
      }, 'Copy Markdown'),
      ctx.h('button', {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        onclick: async () => {
          await ctx.api.setState('project', ctx.project.id, { checkpointAt: new Date().toISOString() });
          api.closeModal();
          await api.loadProjects();
          api.toast('Task Journal checkpoint created');
        },
        disabled: pending.length ? null : 'disabled',
      }, 'Create checkpoint'),
    ];
    api.openModal({
      title: 'Task Journal',
      subtitle: ctx.project.name || ctx.project.path,
      body,
      actions,
    });
  }

  async function copyMarkdown(ctx, entries) {
    const lines = [`# ${ctx.project.name || 'Project'} task journal`, ''];
    for (const entry of entries) lines.push(`- ${entry.title || entry.taskId} (${entry.provider || 'unknown'})`);
    await navigator.clipboard.writeText(lines.join('\n'));
    api.toast('Task Journal Markdown copied');
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleString();
  }
}());
