(function registerProjectFlags() {
  const api = window.ControlCenterExtensions.register('project-flags', {
    projectFields: {
      'important-project': {
        render(ctx) {
          const input = ctx.h('input', {
            type: 'checkbox',
            'data-project-flags-field': 'important',
          });
          if (ctx.project && ctx.project.id) {
            ctx.api.getState('project', ctx.project.id).then((state) => {
              input.checked = !!state.important;
            }).catch(() => {});
          }
          return ctx.h('label', {
            class: 'checkbox yolo-line project-flags-field',
            title: 'Example extension setting stored outside core project columns.',
          }, input, ' Important ', ctx.h('span', { class: 'hint' }, '(example extension state)'));
        },
        async save(ctx) {
          const input = ctx.form.querySelector('[data-project-flags-field="important"]');
          if (!input || !ctx.project || !ctx.project.id) return;
          await ctx.api.setState('project', ctx.project.id, { important: !!input.checked });
        },
      },
    },
    projectBadges: {
      'important-badge': {
        render(ctx) {
          if (!ctx.project) return null;
          const pill = ctx.h('span', {
            class: 'graphify-pill project-flags-pill',
            hidden: 'hidden',
            title: 'Marked by the Project Flags example extension',
          }, 'Important');
          ctx.api.getState('project', ctx.project.id).then((state) => {
            pill.hidden = !state.important;
          }).catch(() => {});
          return pill;
        },
      },
    },
    projectActions: {
      'open-project-note': {
        render(ctx) {
          if (!ctx.project) return null;
          return ctx.h('button', {
            type: 'button',
            class: 'btn btn-sm',
            onclick: () => openProjectNote(ctx),
          }, 'Open note');
        },
      },
    },
    taskBadges: {
      'project-flag': {
        render(ctx) {
          const project = (ctx.projects || []).find((item) => item.path === ctx.task.project_path);
          if (!project) return null;
          const badge = ctx.h('span', { class: 'tag project-flags-task-badge', hidden: 'hidden' }, 'Important');
          ctx.api.getState('project', project.id).then((state) => {
            badge.hidden = !state.important;
          }).catch(() => {});
          return badge;
        },
      },
    },
  });

  function openProjectNote(ctx) {
    const project = ctx.project || {};
    const body = ctx.h('div', { class: 'project-flags-modal' },
      ctx.h('p', {}, 'This neutral example modal is rendered by an extension asset declared in extension.json.'),
      ctx.h('code', {}, project.path || 'No project selected'),
    );
    const actions = [
      ctx.h('button', {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        onclick: () => api.closeModal(),
      }, 'Close'),
    ];
    api.openModal({
      title: 'Project Flags',
      subtitle: project.name || '',
      body,
      actions,
    });
  }
}());
