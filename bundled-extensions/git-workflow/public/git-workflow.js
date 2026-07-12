'use strict';

(function registerGitWorkflowExtension() {
  const runtime = window.ControlCenterExtensions;
  if (!runtime) return;

  function badge({ project, h }) {
    if (!project) return null;
    if (project.git_initialized) {
      return h('span', {
        class: 'project-git-badge project-git-badge-lg',
        title: 'Project Git repository\n' + (project.git_repo_root || project.path || ''),
      }, 'Git');
    }
    if (project.git_repo_kind === 'parent') {
      return h('span', {
        class: 'project-git-badge project-git-badge-lg project-git-badge-warn',
        title: project.git_warning || ('Parent Git repository: ' + project.git_parent_repo_root),
      }, 'Parent Git');
    }
    return null;
  }

  runtime.register('git-workflow', {
    projectBadges: {
      'git-status': badge,
    },
    projectFields: {
      init: {
        render({ project, h }) {
          const input = h('input', {
            type: 'checkbox',
            'data-git-workflow-init': '1',
          });
          input.checked = project ? !!project.git_initialized : false;
          input.disabled = project ? !!project.git_initialized : false;
          return h('label', {
            class: 'checkbox yolo-line' + (input.disabled ? ' disabled' : ''),
            title: 'Initialize a Git repository in the project folder when saved.',
          }, input, ' Git ', h('span', { class: 'hint' }, '(create repository)'));
        },
        async save({ project, form, api, toast, loadProjects }) {
          if (!project || !form || project.git_initialized) return;
          const input = form.querySelector('[data-git-workflow-init]');
          if (!input || !input.checked) return;
          try {
            await api.send('POST', `projects/${project.id}/init`);
            await loadProjects();
          } catch (error) {
            toast('Git setup failed: ' + (error.message || error), { err: true });
          }
        },
      },
    },
  });
}());
