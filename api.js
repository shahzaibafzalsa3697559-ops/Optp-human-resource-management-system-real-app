/**
 * Drive API client and utilities
 */

const StorageService = {
  token: null,

  setToken(t) {
    this.token = t;
  },

  async request(url, options = {}) {
    options.headers = {
      ...options.headers,
      Authorization: `Bearer ${this.token}`
    };

    const res = await fetch(url, options);

    if (res.status === 401) {
      throw new Error("UNAUTHORIZED");
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || "Storage API failure");
    }

    return res;
  },

  async findFolder(name, parentId = "root") {
    const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`);
    const res = await this.request(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1`);
    const data = await res.json();
    return data.files?.[0]?.id || null;
  },

  async createFolder(name, parentId = "root") {
    const res = await this.request("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId]
      })
    });
    const data = await res.json();
    return data.id;
  },

  async ensureFolder(name, parentId = "root") {
    let folderId = await this.findFolder(name, parentId);
    if (!folderId) {
      folderId = await this.createFolder(name, parentId);
    }
    return folderId;
  },

  async listFolderChildren(folderId) {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const res = await this.request(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType)&pageSize=1000`);
    const data = await res.json();
    return data.files || [];
  },

  async saveFile(name, mimeType, parentId, content, isText = false) {
    const metaRes = await this.request("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parents: [parentId] })
    });
    const meta = await metaRes.json();

    const body = isText ? content : await (await fetch(content)).blob();

    await this.request(`https://www.googleapis.com/upload/drive/v3/files/${meta.id}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": mimeType },
      body
    });

    return meta.id;
  },

  async updateFile(fileId, mimeType, content, isText = false) {
    const body = isText ? content : await (await fetch(content)).blob();
    await this.request(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": mimeType },
      body
    });
  },

  async readText(fileId) {
    const res = await this.request(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    return res.text();
  },

  async readDataUrl(fileId) {
    const res = await this.request(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  },

  async moveToTrash(fileId) {
    await this.request(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true })
    });
  }
};

const ImageUtil = {
  compress(file, maxDimension = 800, quality = 0.75) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let w = img.width;
          let h = img.height;

          if (w > maxDimension) {
            h = Math.round((h * maxDimension) / w);
            w = maxDimension;
          }

          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
};