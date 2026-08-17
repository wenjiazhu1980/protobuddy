// EdgeOne Makers mounts the Express Cloud Function at /express (framework mode),
// so the deployed build must use /express/api. Local dev keeps the default /api
// (proxied to the backend by Vite).
export const API_BASE = import.meta.env.VITE_API_BASE || '/api';

async function request(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const opts = {
    headers: {},
    ...options
  };

  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  return data;
}

export const api = {
  // Projects
  listProjects: () => request('/projects'),
  getProject: (id) => request(`/projects/${id}`),
  createProject: (data) => request('/projects', { method: 'POST', body: data }),
  updateProject: (id, data) => request(`/projects/${id}`, { method: 'PUT', body: data }),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }),
  uploadPrototype: (id, file) => {
    const formData = new FormData();
    formData.append('type', 'zip');
    formData.append('file', file);
    return request(`/projects/${id}/upload`, { method: 'POST', body: formData });
  },
  /**
   * Upload a prototype via three supported methods:
   *   type='zip'    - single ZIP package (File)
   *   type='html'   - single index.html (File)
   *   type='folder' - multiple files with relative paths (Array<{file, relPath}>)
   */
  uploadPrototypeFiles: (id, type, payload) => {
    const formData = new FormData();
    formData.append('type', type);
    if (type === 'folder') {
      for (const item of payload) {
        formData.append('files', item.file);
        formData.append('paths', item.relPath);
      }
    } else {
      formData.append('file', payload);
    }
    return request(`/projects/${id}/upload`, { method: 'POST', body: formData });
  },

  // Files
  listFiles: (id) => request(`/projects/${id}/files`),
  readFile: (id, filePath) => request(`/projects/${id}/files/${filePath}`),
  writeFile: (id, path, content) => request(`/projects/${id}/files`, { method: 'POST', body: { path, content } }),
  deleteFile: (id, filePath) => request(`/projects/${id}/files/${filePath}`, { method: 'DELETE' }),

  // Deploy
  deploy: (id) => request(`/projects/${id}/deploy`, { method: 'POST' }),
  deployStatus: (id, depId) => request(`/projects/${id}/deploy-status${depId ? `?dep=${depId}` : ''}`),
  listDeployments: (id) => request(`/projects/${id}/deployments`),
  setPreviewUrl: (id, url) => request(`/projects/${id}/preview-url`, { method: 'POST', body: { url } }),

  // Annotations
  listAnnotations: (id, params = {}) => {
    const query = new URLSearchParams(params).toString();
    return request(`/projects/${id}/annotations${query ? '?' + query : ''}`);
  },
  createAnnotation: (id, data) => request(`/projects/${id}/annotations`, { method: 'POST', body: data }),
  updateAnnotation: (id, annId, data) => request(`/projects/${id}/annotations/${annId}`, { method: 'PUT', body: data }),
  deleteAnnotation: (id, annId) => request(`/projects/${id}/annotations/${annId}`, { method: 'DELETE' }),

  // Plans
  generatePlan: (id) => request(`/projects/${id}/plan`, { method: 'POST' }),
  listPlans: (id) => request(`/projects/${id}/plans`),
  getPlan: (planId) => request(`/projects/plans/${planId}`),
  approvePlan: (planId) => request(`/projects/plans/${planId}/approve`, { method: 'POST' }),
  rejectPlan: (planId) => request(`/projects/plans/${planId}/reject`, { method: 'POST' }),
  approveChange: (planId, changeId) => request(`/projects/plans/${planId}/changes/${changeId}/approve`, { method: 'POST' }),
  rejectChange: (planId, changeId) => request(`/projects/plans/${planId}/changes/${changeId}/reject`, { method: 'POST' }),
  applyPlan: (planId) => request(`/projects/plans/${planId}/apply`, { method: 'POST' }),

  // Health
  health: () => request('/health'),
};

// Build preview URL for iframe (same-origin, served by the Express function)
export function getPreviewUrl(projectId, baseUrl = '') {
  return `${baseUrl}${API_BASE}/projects/${projectId}/preview/`;
}
