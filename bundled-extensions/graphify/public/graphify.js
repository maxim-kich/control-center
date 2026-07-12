'use strict';

(function registerGraphifyExtension() {
  const runtime = window.ControlCenterExtensions;
  if (!runtime) return;

  const labels = {
    pending: 'Graphify pending',
    queued: 'Graphify working',
    running: 'Graphify working',
    current: 'Graphify up to date',
    stale: 'Graphify needs update',
    missing: 'Graphify missing',
    error: 'Graphify error',
    disabled: 'Graphify off',
  };

  function state(project) {
    if (project && project.graphify_enabled === 0) return 'disabled';
    const status = project && project.graphify_status || 'pending';
    if (status === 'queued' || status === 'running') return 'working';
    if (status === 'current') return 'current';
    if (status === 'stale') return 'stale';
    if (status === 'missing') return 'missing';
    if (status === 'error') return 'error';
    if (status === 'disabled') return 'disabled';
    return 'pending';
  }

  function details(project) {
    const raw = project && project.graphify_status || 'pending';
    const items = [project && project.graphify_enabled === 0 ? labels.disabled : labels[raw] || labels.pending];
    if (project && project.graphify_last_success_at) items.push('Last success: ' + project.graphify_last_success_at);
    if (project && project.graphify_hook_status) items.push('Hook: ' + project.graphify_hook_status);
    if (project && project.graphify_last_error) items.push(project.graphify_last_error);
    return items.join('\n');
  }

  runtime.register('graphify', {
    projectBadges: {
      'graphify-status'({ project, h, api, toast, loadProjects }) {
        if (!project) return null;
        const raw = project.graphify_status || 'pending';
        const working = raw === 'queued' || raw === 'running';
        const cls = 'graphify-pill gf-' + state(project);
        if (working) return h('span', { class: cls, title: details(project) }, 'Graphify');
        return h('button', {
          type: 'button',
          class: cls + ' graphify-pill-btn',
          title: details(project),
          onclick: async () => {
            try {
              await api.send('POST', `projects/${project.id}/queue`);
              await loadProjects();
              toast((project.graphify_enabled === 0 ? 'Graphify added for ' : 'Graphify queued for ') + (project.name || project.path));
            } catch (error) {
              toast('Graphify failed: ' + (error.message || error), { err: true });
            }
          },
        }, 'Graphify');
      },
    },
    projectFields: {
      enabled: {
        render({ project, h }) {
          const input = h('input', {
            type: 'checkbox',
            'data-graphify-enabled': '1',
          });
          input.checked = project ? project.graphify_enabled !== 0 : true;
          return h('label', {
            class: 'checkbox yolo-line',
            title: 'Install project-scoped Graphify and refresh the code graph automatically.',
          }, input, ' Graphify ', h('span', { class: 'hint' }, '(auto-update code graph)'));
        },
        async save({ project, form, api }) {
          if (!project || !form) return;
          const input = form.querySelector('[data-graphify-enabled]');
          if (!input) return;
          const enabled = !!input.checked;
          const current = project.graphify_enabled !== 0;
          if (enabled === current) {
            if (enabled) await api.send('POST', `projects/${project.id}/queue`);
            return;
          }
          if (enabled) await api.send('POST', `projects/${project.id}/queue`);
          else await api.send('DELETE', `projects/${project.id}`);
        },
      },
    },
  });
}());
