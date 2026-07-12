'use strict';

const MAX_ENTRIES = 500;

function projectId(context) {
  return context.project && context.project.id;
}

function projectState(context, api) {
  const id = projectId(context);
  return id ? api.state.get('project', id) : {};
}

exports.hooks = {
  'task.statusChanged'(context, api) {
    const id = projectId(context);
    if (!id || !context.task || !context.previous) return;
    const state = projectState(context, api);
    api.state.set('project', id, {
      statusTransitions: Number(state.statusTransitions || 0) + 1,
      lastStatusChange: {
        taskId: context.task.id,
        from: context.previous.status,
        to: context.task.status,
        at: context.task.updated_at || new Date().toISOString(),
        provider: context.provider && context.provider.id,
      },
    });
  },

  'task.completed'(context, api) {
    const id = projectId(context);
    if (!id || !context.task) return;
    const state = projectState(context, api);
    const entries = Array.isArray(state.entries) ? state.entries.slice() : [];
    if (!entries.some((entry) => entry.taskId === context.task.id)) {
      entries.push({
        taskId: context.task.id,
        title: context.task.title,
        completedAt: context.task.ended_at || new Date().toISOString(),
        provider: context.provider && context.provider.id,
      });
    }
    api.state.set('project', id, { entries: entries.slice(-MAX_ENTRIES) });
  },

  'project.metadata'(context, api) {
    const state = projectState(context, api);
    const entries = Array.isArray(state.entries) ? state.entries : [];
    const checkpointAt = state.checkpointAt || null;
    const pending = checkpointAt
      ? entries.filter((entry) => String(entry.completedAt || '') > checkpointAt)
      : entries;
    return {
      pendingCount: pending.length,
      completedCount: entries.length,
      checkpointAt,
      manualCheckpoints: !!state.manualCheckpoints,
      lastCompletedAt: entries.length ? entries[entries.length - 1].completedAt : null,
    };
  },

  'git.autoCommitPolicy'(context, api) {
    const state = projectState(context, api);
    if (!state.manualCheckpoints) return { decision: 'abstain' };
    return {
      decision: 'deny',
      reason: 'Task Journal manual checkpoints are enabled for this project',
    };
  },
};
