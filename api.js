const DriveAPI = {
  token: null,

  setToken(t) {
    this.token = t;
  },

  async request(url, options = {}) {
    options.headers = Object.assign({}, options.headers || {}, {
      Authorization: 'Bearer ' + this.token
    });
    const res = await fetch(url, options);
    if (res.status === 401) {
      throw new Error('UNAUTHORIZED');
    }
    if (!res.ok) {
      let detail = '';
      try {
        const errJson = await res.json();
        detail = errJson?.error?.message || '';
      } catch (e) {}
      throw new Error('Drive API status ' + res.status + (detail ? ': ' + detail : ''));
    }
    return res;
  },

  async findFolder(name, parentId) {
    const safe = name.replace(/'/g, "\\'");
    const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${safe}' and '${parentId}' in parents and trashed=false`);
    const res = await this.request(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=10`);
    const data = await res.json();
    return (data.files && data.files.length) ? data.files[0].id : null;
  },

  async createFolder(name, parentId) {
    const res = await this.request('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
    });
    const data = await res.json();
    return data.id;
  },

  async findOrCreateFolder(name, parentId) {
    let id = await this.findFolder(name, parentId);
    if (!id) id = await this.createFolder(name, parentId);
    return id;
  },

  async uploadFile(name, mimeType, parentId, content, isText) {
    const metaRes = await this.request('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parents: [parentId] })
    });
    const meta = await metaRes.json();
    const fileId = meta.id;
    const body = isText ? content : await (await fetch(content)).blob();
    await this.request(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': mimeType },
      body
    });
    return fileId;
  },

  async updateFile(fileId, mimeType, content, isText) {
    const body = isText ? content : await (await fetch(content)).blob();
    await this.request(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': mimeType },
      body
    });
  },

  async renameFile(fileId, newName) {
    await this.request(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName })
    });
  },

  async moveFolder(folderId, fromParent, toParent) {
    await this.request(`https://www.googleapis.com/drive/v3/files/${folderId}?addParents=${toParent}&removeParents=${fromParent}`, {
      method: 'PATCH'
    });
  },

  async trashFolder(folderId) {
    await this.request(`https://www.googleapis.com/drive/v3/files/${folderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true })
    });
  },

  async listChildren(parentId) {
    const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
    const res = await this.request(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType)&pageSize=1000`);
    const data = await res.json();
    return data.files || [];
  },

  async getFileText(fileId) {
    const res = await this.request(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    return res.text();
  },

  async getFileDataUrl(fileId) {
    const res = await this.request(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    const blob = await res.blob();
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  }
};
