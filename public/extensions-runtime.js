'use strict';

(function initExtensionRuntime() {
  let payload = { extensions: [], conflicts: [] };
  let hostApi = {};
  let renderVersion = 0;
  const registry = new Map();
  const loadedAssets = new Set();

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function enabledExtensions() {
    return asArray(payload.extensions).filter((extension) => extension && extension.enabled);
  }

  function extensionById(id) {
    return enabledExtensions().find((extension) => extension.id === id) || null;
  }

  function contributionList(kind, slot) {
    const out = [];
    for (const extension of enabledExtensions()) {
      const contributes = extension.contributes || {};
      for (const contribution of asArray(contributes[kind])) {
        if (slot && contribution.slot !== slot && contribution.mount !== slot) continue;
        out.push({ ...contribution, extensionId: extension.id, extension });
      }
    }
    return out.sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.title || '').localeCompare(String(b.title || '')));
  }

  function addRuntimeClass(node) {
    if (node && node.nodeType === 1) node.classList.add('extension-ui');
    return node;
  }

  function normalizeNodes(value) {
    if (value == null || value === false) return [];
    if (Array.isArray(value)) return value.flatMap(normalizeNodes);
    if (value.nodeType) return [addRuntimeClass(value)];
    return [document.createTextNode(String(value))];
  }

  async function request(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body == null ? undefined : { 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function extensionApi(extensionId) {
    return {
      get(url) {
        return request('GET', `/api/extensions/${extensionId}/${String(url || '').replace(/^\/+/, '')}`);
      },
      send(method, url, body) {
        return request(method, `/api/extensions/${extensionId}/${String(url || '').replace(/^\/+/, '')}`, body);
      },
      async getState(scopeType, scopeId) {
        const query = new URLSearchParams({ scope_type: scopeType || 'global', scope_id: scopeId || 'global' });
        const data = await request('GET', `/api/extensions/${extensionId}/state?${query.toString()}`);
        return data.state || {};
      },
      async setState(scopeType, scopeId, values) {
        const data = await request('PUT', `/api/extensions/${extensionId}/state`, {
          scope_type: scopeType || 'global',
          scope_id: scopeId || 'global',
          values: values || {},
        });
        return data.state || {};
      },
      async deleteState(scopeType, scopeId, key) {
        const query = new URLSearchParams({ scope_type: scopeType || 'global', scope_id: scopeId || 'global', key });
        const data = await request('DELETE', `/api/extensions/${extensionId}/state?${query.toString()}`);
        return data.state || {};
      },
      toast(message, opts) {
        if (hostApi.toast) hostApi.toast(message, opts);
      },
      refresh() {
        if (hostApi.refresh) return hostApi.refresh(true);
        return Promise.resolve();
      },
      loadProjects() {
        if (hostApi.loadProjects) return hostApi.loadProjects();
        return Promise.resolve();
      },
      openModal(opts) {
        if (hostApi.openModal) hostApi.openModal(opts || {});
      },
      closeModal() {
        if (hostApi.closeModal) hostApi.closeModal();
      },
    };
  }

  function handlerFor(item, kind) {
    const handlers = registry.get(item.extensionId);
    if (!handlers) return null;
    const collection = handlers[kind];
    if (!collection) return null;
    if (typeof collection === 'function') return collection;
    return collection[item.id] || null;
  }

  function contextFor(item, context) {
    const api = extensionApi(item.extensionId);
    return {
      ...(context || {}),
      extension: item.extension,
      contribution: item,
      api,
      h: hostApi.h,
      toast: hostApi.toast,
      openModal: api.openModal,
      closeModal: api.closeModal,
      refresh: api.refresh,
      loadProjects: api.loadProjects,
    };
  }

  function defaultContributionNode(item, kind) {
    if (!item.url) return null;
    if (kind === 'projectActions' || kind === 'taskActions') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm';
      button.textContent = item.label || item.title || item.id;
      button.addEventListener('click', () => window.open(item.url, '_blank', 'noopener,noreferrer'));
      return button;
    }
    const link = document.createElement('a');
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = item.label || item.title || item.id;
    return link;
  }

  function render(kind, context, slot) {
    const nodes = [];
    for (const item of contributionList(kind, slot || (context && context.slot))) {
      const handler = handlerFor(item, kind);
      try {
        let rendered = null;
        if (typeof handler === 'function') rendered = handler(contextFor(item, context));
        else if (handler && typeof handler.render === 'function') rendered = handler.render(contextFor(item, context));
        if (rendered == null) rendered = defaultContributionNode(item, kind);
        nodes.push(...normalizeNodes(rendered));
      } catch (error) {
        if (hostApi.toast) hostApi.toast(`${item.extensionId}: ${error.message || error}`, { err: true });
      }
    }
    return nodes;
  }

  async function invoke(kind, method, context, slot) {
    const results = [];
    for (const item of contributionList(kind, slot || (context && context.slot))) {
      const handler = handlerFor(item, kind);
      const fn = handler && typeof handler === 'object' ? handler[method] : null;
      if (typeof fn !== 'function') continue;
      results.push(await fn(contextFor(item, context)));
    }
    return results;
  }

  function versionedUrl(extension, asset) {
    const url = asset.url || '';
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}v=${encodeURIComponent(extension.version || 'dev')}`;
  }

  function loadStyle(extension, asset) {
    const key = `style:${extension.id}:${asset.path}:${extension.version || ''}`;
    if (loadedAssets.has(key)) return Promise.resolve();
    loadedAssets.add(key);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = versionedUrl(extension, asset);
    link.dataset.extensionAsset = extension.id;
    if (asset.media) link.media = asset.media;
    document.head.append(link);
    return Promise.resolve();
  }

  function loadScript(extension, asset) {
    const key = `script:${extension.id}:${asset.path}:${extension.version || ''}`;
    if (loadedAssets.has(key)) return Promise.resolve();
    loadedAssets.add(key);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = versionedUrl(extension, asset);
      script.dataset.extensionAsset = extension.id;
      if (asset.type === 'module') script.type = 'module';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`failed to load ${asset.path}`));
      document.head.append(script);
    });
  }

  async function configure(nextPayload) {
    payload = nextPayload || { extensions: [], conflicts: [] };
    renderVersion += 1;
    const loads = [];
    for (const extension of enabledExtensions()) {
      for (const style of asArray(extension.frontend && extension.frontend.styles)) loads.push(loadStyle(extension, style));
    }
    for (const extension of enabledExtensions()) {
      for (const script of asArray(extension.frontend && extension.frontend.scripts)) loads.push(loadScript(extension, script));
    }
    await Promise.all(loads);
    renderVersion += 1;
    window.dispatchEvent(new CustomEvent('control-center-extensions-ready', { detail: { renderVersion } }));
    return payload;
  }

  function register(extensionId, handlers) {
    const id = String(extensionId || '').trim();
    if (!id) throw new Error('extension id is required');
    if (!extensionById(id)) throw new Error(`extension ${id} is not enabled or not declared`);
    registry.set(id, handlers || {});
    renderVersion += 1;
    window.dispatchEvent(new CustomEvent('control-center-extension-registered', { detail: { extensionId: id, renderVersion } }));
    return extensionApi(id);
  }

  window.ControlCenterExtensions = {
    configure,
    register,
    render,
    invoke,
    contributions: contributionList,
    setHostApi(api) {
      hostApi = { ...(hostApi || {}), ...(api || {}) };
    },
    extensionApi,
    get payload() {
      return payload;
    },
    get renderVersion() {
      return renderVersion;
    },
  };
}());
