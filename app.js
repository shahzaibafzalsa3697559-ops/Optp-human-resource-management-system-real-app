const CONFIG = Object.freeze({
  CLIENT_ID: "936109847577-ajbaefe746dalhe6vn7ae0u2pdl26sds.apps.googleusercontent.com",
  SCOPES: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email",
  APP_PIN: "6666",
  AUTHORIZED_EMAILS: ["shahzaibafzalsa3697559@gmail.com", "optpscheme3@gmail.com"],
  SESSION_STORAGE_KEY: "optp_active_session"
});

const Storage = {
  token: null,

  // Set once the Google auth client is ready. Lets a failed request try a
  // silent token refresh before giving up, so a mid-session token expiry
  // doesn't interrupt whoever is using the app.
  onUnauthorized: null,

  setToken(val) {
    this.token = val;
  },

  async request(url, options = {}, _retried = false) {
    options.headers = Object.assign({}, options.headers || {}, {
      Authorization: `Bearer ${this.token}`
    });

    const res = await fetch(url, options);

    if (res.status === 401) {
      if (!_retried && typeof this.onUnauthorized === "function") {
        const refreshed = await this.onUnauthorized();
        if (refreshed) return this.request(url, options, true);
      }
      throw new Error("UNAUTHORIZED");
    }

    if (!res.ok) {
      let message = "";
      try {
        const err = await res.json();
        message = err?.error?.message || "";
      } catch (e) {}
      throw new Error(message || `Drive request error: ${res.status}`);
    }

    return res;
  },

  async getFolderId(name, parentId = "root") {
    const safe = name.replace(/'/g, "\\'");
    const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${safe}' and '${parentId}' in parents and trashed=false`);
    const res = await this.request(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=10`);
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

  async resolveFolder(name, parentId = "root") {
    let id = await this.getFolderId(name, parentId);
    if (!id) id = await this.createFolder(name, parentId);
    return id;
  },

  async uploadFile(name, mimeType, parentId, payload, isText = false) {
    const metaRes = await this.request("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parents: [parentId] })
    });
    const meta = await metaRes.json();
    const fileId = meta.id;
    const body = isText ? payload : await (await fetch(payload)).blob();

    await this.request(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": mimeType },
      body
    });

    return fileId;
  },

  async patchFile(fileId, mimeType, payload, isText = false) {
    const body = isText ? payload : await (await fetch(payload)).blob();
    await this.request(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": mimeType },
      body
    });
  },

  async setFileName(fileId, newName) {
    await this.request(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName })
    });
  },

  async relocateFolder(folderId, fromParent, toParent) {
    await this.request(`https://www.googleapis.com/drive/v3/files/${folderId}?addParents=${toParent}&removeParents=${fromParent}`, {
      method: "PATCH"
    });
  },

  async trashEntry(folderId) {
    await this.request(`https://www.googleapis.com/drive/v3/files/${folderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true })
    });
  },

  async fetchChildren(parentId) {
    const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
    const res = await this.request(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType)&pageSize=1000`);
    const data = await res.json();
    return data.files || [];
  },

  async readTextFile(fileId) {
    const res = await this.request(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    return res.text();
  },

  async readBase64(fileId) {
    if (!fileId) return "";
    const res = await this.request(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
};

let tokenClient = null;
let currentSessionUser = null;
let folderRootId = null, folderActiveId = null, folderArchiveId = null;
let activeEmployees = [];
let archivedEmployees = [];
let currentScreen = "pinlock";
let filterCurrentQuery = "";
let filterArchiveQuery = "";
let isSilentRefreshActive = false;

const root = document.getElementById("root");

function sanitize(input) {
  return String(input == null ? "" : input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showNotification(message, isError = false) {
  const node = document.createElement("div");
  node.className = "alert-toast" + (isError ? " error" : "");
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 3200);
}

function generateId() {
  return "EMP-" + Date.now() + "-" + Math.floor(Math.random() * 9000 + 1000);
}

function isAuthError(e) {
  return !!e && e.message === "UNAUTHORIZED";
}

/* Session is kept in localStorage (not sessionStorage) so closing the
   browser and coming back later doesn't force a fresh sign-in as long as
   the saved token is still valid. */
function persistSession(email, token, expSec) {
  try {
    const expiresAt = Date.now() + Math.max(60, (expSec || 3300) - 120) * 1000;
    localStorage.setItem(CONFIG.SESSION_STORAGE_KEY, JSON.stringify({ email, token, expiresAt }));
  } catch (e) {}
}

function getStoredSession() {
  try {
    const str = localStorage.getItem(CONFIG.SESSION_STORAGE_KEY);
    return str ? JSON.parse(str) : null;
  } catch (e) {
    return null;
  }
}

function purgeSession() {
  try { localStorage.removeItem(CONFIG.SESSION_STORAGE_KEY); } catch (e) {}
}

function isEmailAuthorized(email) {
  if (!CONFIG.AUTHORIZED_EMAILS.length) return true;
  const target = String(email || "").trim().toLowerCase();
  return CONFIG.AUTHORIZED_EMAILS.some(item => String(item).trim().toLowerCase() === target);
}

function compressImageFile(file, maxDimension, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxDimension) {
          h = Math.round(h * (maxDimension / w));
          w = maxDimension;
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* --- Google Identity & Session Restore --- */

function initGoogleIdentity() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: async (res) => {
      const wasSilent = isSilentRefreshActive;
      isSilentRefreshActive = false;
      if (res.error) {
        if (wasSilent) { currentScreen = "login"; render(); return; }
        showNotification(`Authentication error: ${res.error}`, true);
        currentScreen = "login";
        render();
        return;
      }
      Storage.setToken(res.access_token);
      await postAuthentication(res.expires_in, false, wasSilent);
    }
  });
  Storage.onUnauthorized = attemptSilentRefresh;
}

window.addEventListener("load", () => {
  const timer = setInterval(() => {
    if (window.google?.accounts?.oauth2) {
      clearInterval(timer);
      initGoogleIdentity();
      currentScreen = "pinlock";
      render();
    }
  }, 100);
});

/* Used mid-session by Storage.request when a call comes back 401 - tries to
   get a fresh token quietly without dropping the user back to a login
   screen. Returns true/false rather than touching the view. */
function attemptSilentRefresh() {
  return new Promise((resolve) => {
    if (!tokenClient || !currentSessionUser) { resolve(false); return; }
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, 6000);
    const original = tokenClient.callback;
    tokenClient.callback = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tokenClient.callback = original;
      if (res.error) { resolve(false); return; }
      Storage.setToken(res.access_token);
      persistSession(currentSessionUser, res.access_token, res.expires_in);
      resolve(true);
    };
    try {
      tokenClient.requestAccessToken({ prompt: "none", hint: currentSessionUser });
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(timer); tokenClient.callback = original; resolve(false); }
    }
  });
}

async function trySessionRestore() {
  const session = getStoredSession();
  if (session?.token && session.expiresAt > Date.now()) {
    currentScreen = "loading";
    render("Validating session...");
    Storage.setToken(session.token);
    await postAuthentication(null, true, true);
    return;
  }

  const savedUser = session ? session.email : null;
  if (!savedUser) {
    currentScreen = "login";
    render();
    return;
  }

  currentScreen = "loading";
  render("Restoring session...");
  isSilentRefreshActive = true;
  let settled = false;

  const fallback = setTimeout(() => {
    if (!settled) {
      settled = true;
      isSilentRefreshActive = false;
      currentScreen = "login";
      render();
    }
  }, 6000);

  const defaultCallback = tokenClient.callback;
  tokenClient.callback = (res) => {
    if (settled) return;
    settled = true;
    clearTimeout(fallback);
    tokenClient.callback = defaultCallback;
    defaultCallback(res);
  };

  try {
    tokenClient.requestAccessToken({ prompt: "none", hint: savedUser });
  } catch (err) {
    if (!settled) {
      settled = true;
      clearTimeout(fallback);
      isSilentRefreshActive = false;
      tokenClient.callback = defaultCallback;
      currentScreen = "login";
      render();
    }
  }
}

async function postAuthentication(expiresInSec, fromCache = false, isSilent = false) {
  currentScreen = "loading";
  render("Verifying Google credentials...");
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${Storage.token}` }
    });
    if (!res.ok) {
      purgeSession();
      Storage.setToken(null);
      currentScreen = "login";
      render();
      if (!isSilent) showNotification("Google session validation failed.", true);
      return;
    }
    const profile = await res.json();
    const email = String(profile.email || "").trim().toLowerCase();

    if (!email.endsWith("@gmail.com")) {
      purgeSession();
      Storage.setToken(null);
      currentScreen = "login";
      render();
      if (!isSilent) showNotification("Please sign in with a Gmail account.", true);
      return;
    }

    if (!isEmailAuthorized(email)) {
      purgeSession();
      Storage.setToken(null);
      currentScreen = "login";
      render();
      showNotification("This Google account is not authorized for this system.", true);
      return;
    }

    currentSessionUser = email;
    if (!fromCache) persistSession(currentSessionUser, Storage.token, expiresInSec);

    render("Configuring storage workspace...");
    await initializeDirectories();

    render("Loading employee database...");
    await syncAllRecords();

    currentScreen = "dashboard";
    render();
  } catch (err) {
    console.error(err);
    purgeSession();
    Storage.setToken(null);
    currentScreen = "login";
    if (!isSilent) {
      showNotification(isAuthError(err) ? "Session expired. Please sign in again." : "Drive storage connection failure.", true);
    }
    render();
  }
}

function performLogout() {
  promptAuth("Confirm Logout", () => {
    if (Storage.token) {
      try { google.accounts.oauth2.revoke(Storage.token, () => {}); } catch (e) {}
    }
    purgeSession();
    Storage.setToken(null);
    currentSessionUser = null;
    activeEmployees = [];
    archivedEmployees = [];
    currentScreen = "login";
    render();
    showNotification("Signed out.");
  });
}

/* --- Directory setup & data loading --- */

async function initializeDirectories() {
  folderRootId = await Storage.resolveFolder("OPTP Employee Record");
  folderActiveId = await Storage.resolveFolder("Current Employees", folderRootId);
  folderArchiveId = await Storage.resolveFolder("Resigned or Retired Employees", folderRootId);
}

async function loadDirectoryProfiles(parentId) {
  const items = await Storage.fetchChildren(parentId);
  const directories = items.filter(i => i.mimeType === "application/vnd.google-apps.folder");

  return Promise.all(directories.map(async (folder) => {
    const files = await Storage.fetchChildren(folder.id);
    const profileDoc = files.find(f => f.name === "profile.json");
    const photoDoc = files.find(f => f.name === "picture.jpg");
    const cnicFrontDoc = files.find(f => f.name === "cnic_front.jpg");
    const cnicBackDoc = files.find(f => f.name === "cnic_back.jpg");

    let record = {};
    if (profileDoc) {
      try {
        record = JSON.parse(await Storage.readTextFile(profileDoc.id));
      } catch (e) {}
    }
    record.folderId = folder.id;
    record.profileFileId = profileDoc?.id || null;
    record.pictureFileId = photoDoc?.id || null;
    record.cnicFrontFileId = cnicFrontDoc?.id || null;
    record.cnicBackFileId = cnicBackDoc?.id || null;

    if (photoDoc) {
      try {
        record.picture = await Storage.readBase64(photoDoc.id);
      } catch (e) {}
    }
    if (!record.id) record.id = folder.id;
    return record;
  }));
}

async function syncAllRecords() {
  activeEmployees = await loadDirectoryProfiles(folderActiveId);
  archivedEmployees = await loadDirectoryProfiles(folderArchiveId);
}

async function fetchFullAttachments(record) {
  if (record.pictureFileId && !record.picture) {
    try { record.picture = await Storage.readBase64(record.pictureFileId); } catch (e) {}
  }
  if (record.cnicFrontFileId && !record.cnicFront) {
    try { record.cnicFront = await Storage.readBase64(record.cnicFrontFileId); } catch (e) {}
  }
  if (record.cnicBackFileId && !record.cnicBack) {
    try { record.cnicBack = await Storage.readBase64(record.cnicBackFileId); } catch (e) {}
  }
  return record;
}

function sanitizeProfile(data) {
  const clone = Object.assign({}, data);
  delete clone.picture;
  delete clone.cnicFront;
  delete clone.cnicBack;
  delete clone._hasPicChanged;
  delete clone._hasFrontChanged;
  delete clone._hasBackChanged;
  return clone;
}

// Patches the record's profile.json, or creates one if it's somehow
// missing, so a status change never throws on an incomplete record.
async function saveProfileFile(record) {
  const payload = JSON.stringify(sanitizeProfile(record));
  if (record.profileFileId) {
    await Storage.patchFile(record.profileFileId, "application/json", payload, true);
  } else {
    record.profileFileId = await Storage.uploadFile("profile.json", "application/json", record.folderId, payload, true);
  }
}

async function insertEmployee(data) {
  const folderTitle = `${data.fullName || "Staff"} - ${data.cnic || data.id}`;
  const folderId = await Storage.createFolder(folderTitle, folderActiveId);
  data.folderId = folderId;
  data.profileFileId = await Storage.uploadFile("profile.json", "application/json", folderId, JSON.stringify(sanitizeProfile(data)), true);
  if (data.picture) data.pictureFileId = await Storage.uploadFile("picture.jpg", "image/jpeg", folderId, data.picture, false);
  if (data.cnicFront) data.cnicFrontFileId = await Storage.uploadFile("cnic_front.jpg", "image/jpeg", folderId, data.cnicFront, false);
  if (data.cnicBack) data.cnicBackFileId = await Storage.uploadFile("cnic_back.jpg", "image/jpeg", folderId, data.cnicBack, false);
  return data;
}

async function modifyEmployee(data) {
  const folderTitle = `${data.fullName || "Staff"} - ${data.cnic || data.id}`;
  await Storage.setFileName(data.folderId, folderTitle);

  if (data.profileFileId) {
    await Storage.patchFile(data.profileFileId, "application/json", JSON.stringify(sanitizeProfile(data)), true);
  } else {
    data.profileFileId = await Storage.uploadFile("profile.json", "application/json", data.folderId, JSON.stringify(sanitizeProfile(data)), true);
  }

  if (data._hasPicChanged && data.picture) {
    if (data.pictureFileId) await Storage.patchFile(data.pictureFileId, "image/jpeg", data.picture, false);
    else data.pictureFileId = await Storage.uploadFile("picture.jpg", "image/jpeg", data.folderId, data.picture, false);
  }
  if (data._hasFrontChanged && data.cnicFront) {
    if (data.cnicFrontFileId) await Storage.patchFile(data.cnicFrontFileId, "image/jpeg", data.cnicFront, false);
    else data.cnicFrontFileId = await Storage.uploadFile("cnic_front.jpg", "image/jpeg", data.folderId, data.cnicFront, false);
  }
  if (data._hasBackChanged && data.cnicBack) {
    if (data.cnicBackFileId) await Storage.patchFile(data.cnicBackFileId, "image/jpeg", data.cnicBack, false);
    else data.cnicBackFileId = await Storage.uploadFile("cnic_back.jpg", "image/jpeg", data.folderId, data.cnicBack, false);
  }
  delete data._hasPicChanged;
  delete data._hasFrontChanged;
  delete data._hasBackChanged;
}

/* --- Password gate for sensitive actions --- */

function promptAuth(label, onSuccess) {
  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.innerHTML = `
    <div class="card auth-dialog">
      <div class="sub-header">VERIFICATION</div>
      <h3 class="accent-text" style="margin:8px 0 16px;font-size:16px;">${sanitize(label)}</h3>
      <div class="field"><input type="password" id="dialog-pin" placeholder="Enter PIN" autocomplete="off"></div>
      <div id="dialog-pin-error" style="color:var(--danger);font-size:11px;min-height:14px;margin-bottom:10px;"></div>
      <div style="display:flex;gap:10px;justify-content:center;">
        <button class="btn cyan" id="dialog-abort">Cancel</button>
        <button class="btn" id="dialog-ok">Confirm</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector("#dialog-pin");
  input.focus();

  function verify() {
    if (input.value === CONFIG.APP_PIN) {
      overlay.remove();
      onSuccess();
    } else {
      overlay.querySelector("#dialog-pin-error").textContent = "Incorrect PIN.";
      input.value = "";
      input.focus();
    }
  }

  overlay.querySelector("#dialog-ok").onclick = verify;
  overlay.querySelector("#dialog-abort").onclick = () => overlay.remove();
  input.addEventListener("keydown", e => { if (e.key === "Enter") verify(); });
}

/* --- Header --- */

function renderHeaderBar() {
  return `
  <div id="nav">
    <div>
      <div class="sub-header">OPTP SCH III</div>
      <h2 class="accent-text" style="font-size:18px;">Employee Record System</h2>
    </div>
    <div style="text-align:right;">
      <div class="user-info">Signed in as <b>${sanitize(currentSessionUser)}</b></div>
      <button class="btn red" id="signout-btn" style="margin-top:8px;padding:6px 14px;font-size:11px;">Logout</button>
    </div>
  </div>`;
}

function wireLogoutButton() {
  const btn = document.getElementById("signout-btn");
  if (btn) btn.onclick = performLogout;
}

/* --- Employee Form --- */

function renderFormMarkup(emp = {}) {
  const v = (key, fallback = "") => sanitize(emp[key] !== undefined ? emp[key] : fallback);
  const raw = (key, fallback = "") => emp[key] !== undefined ? emp[key] : fallback;
  return `
    <div class="section-label">Personal Details</div>
    <div class="row">
      <div class="field"><label class="req">Position</label><input id="f-position" value="${v('position')}" placeholder="e.g. Branch Supervisor"></div>
      <div class="field"><label>Salary</label><input type="number" id="f-salary" value="${v('salary')}" placeholder="PKR"></div>
    </div>
    <div class="row">
      <div class="field"><label class="req">Full Name</label><input id="f-fullName" value="${v('fullName')}"></div>
      <div class="field"><label>Father Name</label><input id="f-fatherName" value="${v('fatherName')}"></div>
    </div>
    <div class="row">
      <div class="field"><label class="req">Date of Birth</label><input type="date" id="f-dob" value="${v('dob')}"></div>
      <div class="field"><label class="req">CNIC</label><input id="f-cnic" placeholder="xxxxx-xxxxxxx-x" maxlength="15" value="${v('cnic')}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Father CNIC</label><input id="f-fatherCnic" placeholder="xxxxx-xxxxxxx-x" maxlength="15" value="${v('fatherCnic')}"></div>
      <div class="field">
        <label>Gender</label>
        <div class="radio-group">
          ${['Male','Female','Transgender'].map(item => `<label class="radio-opt"><input type="radio" name="f-gender" value="${item}" ${raw('gender') === item ? 'checked' : ''}> ${item}</label>`).join('')}
        </div>
      </div>
    </div>
    <div class="row">
      <div class="field"><label class="req">Joining Date</label><input type="date" id="f-joiningDate" value="${v('joiningDate')}"></div>
      <div class="field">
        <label>Marital Status</label>
        <div class="radio-group">
          ${['Single','Married'].map(item => `<label class="radio-opt"><input type="radio" name="f-relStatus" value="${item}" ${raw('relationshipStatus') === item ? 'checked' : ''}> ${item}</label>`).join('')}
        </div>
      </div>
    </div>
    <div class="field ${raw('relationshipStatus') === 'Married' ? '' : 'hidden'}" id="children-wrap">
      <label>Number of Children</label><input type="number" min="0" id="f-childrenCount" value="${v('childrenCount')}">
    </div>

    <div class="section-label">Address & Contact</div>
    <div class="row">
      <div class="field"><label class="req">Permanent Address</label><textarea id="f-permAddress" rows="2">${v('permanentAddress')}</textarea></div>
      <div class="field"><label class="req">Temporary Address</label><textarea id="f-tempAddress" rows="2">${v('temporaryAddress')}</textarea></div>
    </div>
    <div class="row">
      <div class="field"><label class="req">Mobile Number</label><input type="tel" id="f-mobileNumber" placeholder="03xx-xxxxxxx" value="${v('mobileNumber')}"></div>
      <div class="field"><label class="req">Home Number (Emergency)</label><input type="tel" id="f-homeNumber" placeholder="Emergency Phone" value="${v('homeNumber')}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Email</label><input type="email" id="f-email" placeholder="staff@example.com" value="${v('email')}"></div>
    </div>

    <div class="section-label">Education</div>
    <div class="field">
      <label class="req">Qualification</label>
      <select id="f-qualification">
        <option value="">-- Select --</option>
        ${['Under Matric','Matric','Inter','Graduation','Graduation Continue','Masters'].map(o =>
          `<option value="${o}" ${raw('qualification') === o ? 'selected' : ''}>${o}</option>`).join('')}
      </select>
    </div>
    <div class="field ${raw('qualification') === 'Graduation Continue' ? '' : 'hidden'}" id="qual-detail-wrap">
      <label class="req">Department / University / Semester Detail</label>
      <textarea id="f-qualificationDetail" rows="2" placeholder="e.g. BSCS, 4th Semester">${v('qualificationDetail')}</textarea>
    </div>

    <div class="section-label">Background Check</div>
    <div class="row">
      <div class="field">
        <label>Serious Illness?</label>
        <div class="radio-group">
          ${['No','Yes'].map(o => `<label class="radio-opt"><input type="radio" name="f-illness" value="${o}" ${raw('illness') === o ? 'checked' : ''}> ${o}</label>`).join('')}
        </div>
      </div>
      <div class="field">
        <label>Crime Record?</label>
        <div class="radio-group">
          ${['No','Yes'].map(o => `<label class="radio-opt"><input type="radio" name="f-crime" value="${o}" ${raw('crimeRecord') === o ? 'checked' : ''}> ${o}</label>`).join('')}
        </div>
      </div>
    </div>
    <div class="field ${raw('illness') === 'Yes' ? '' : 'hidden'}" id="illness-detail-wrap">
      <label>Illness Detail</label><textarea id="f-illnessDetail" rows="2">${v('illnessDetail')}</textarea>
    </div>
    <div class="field ${raw('crimeRecord') === 'Yes' ? '' : 'hidden'}" id="crime-detail-wrap">
      <label>Crime Record Detail</label><textarea id="f-crimeDetail" rows="2">${v('crimeDetail')}</textarea>
    </div>

    <div class="section-label">Experience</div>
    <div class="field">
      <label class="req">Previous Experience?</label>
      <div class="radio-group">
        ${['No','Yes'].map(o => `<label class="radio-opt"><input type="radio" name="f-prevExp" value="${o}" ${raw('previousExperience') === o ? 'checked' : ''}> ${o}</label>`).join('')}
      </div>
    </div>
    <div id="prevexp-detail-wrap" class="${raw('previousExperience') === 'Yes' ? '' : 'hidden'}">
      <div class="field"><label class="req">Experience Detail</label><textarea id="f-prevExpDetail" rows="2">${v('prevExpDetail')}</textarea></div>
      <div class="row">
        <div class="field"><label class="req">Previous Salary</label><input type="number" id="f-prevSalary" value="${v('prevSalary')}"></div>
        <div class="field"><label class="req">Reason for Leaving</label><input id="f-prevReason" value="${v('prevReason')}"></div>
      </div>
    </div>

    <div class="section-label">Additional Information</div>
    <div class="row">
      <div class="field"><label>Courses</label><textarea id="f-courses" rows="2">${v('courses')}</textarea></div>
      <div class="field"><label>Skills</label><textarea id="f-skills" rows="2">${v('skills')}</textarea></div>
    </div>

    <div class="section-label">Attachments</div>
    <div class="row">
      <div class="field">
        <label class="req">Upload Picture</label>
        <div class="file-drop" id="pic-box">Select Photo<br><img class="file-thumb ${raw('picture') ? '' : 'hidden'}" id="pic-preview" src="${raw('picture') || ''}"></div>
        <input type="file" accept="image/*" id="f-picture" class="hidden">
      </div>
      <div class="field">
        <label class="req">CNIC Front</label>
        <div class="file-drop" id="cnicf-box">Select Front Side<br><img class="file-thumb ${raw('cnicFront') ? '' : 'hidden'}" id="cnicf-preview" src="${raw('cnicFront') || ''}"></div>
        <input type="file" accept="image/*" id="f-cnicFront" class="hidden">
      </div>
      <div class="field">
        <label class="req">CNIC Back</label>
        <div class="file-drop" id="cnicb-box">Select Back Side<br><img class="file-thumb ${raw('cnicBack') ? '' : 'hidden'}" id="cnicb-preview" src="${raw('cnicBack') || ''}"></div>
        <input type="file" accept="image/*" id="f-cnicBack" class="hidden">
      </div>
    </div>`;
}

function bindFormEvents(store) {
  function formatCnic(val) {
    const digits = val.replace(/\D/g, "").slice(0, 13);
    if (digits.length > 12) return digits.slice(0, 5) + "-" + digits.slice(5, 12) + "-" + digits.slice(12);
    if (digits.length > 5) return digits.slice(0, 5) + "-" + digits.slice(5);
    return digits;
  }

  function wireCnicField(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.setAttribute("inputmode", "numeric");
    el.addEventListener("input", () => {
      const isEnd = el.selectionStart === el.value.length;
      el.value = formatCnic(el.value);
      if (isEnd) el.setSelectionRange(el.value.length, el.value.length);
    });
  }
  wireCnicField("f-cnic");
  wireCnicField("f-fatherCnic");

  ["f-dob", "f-joiningDate"].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("click", () => {
        if (typeof el.showPicker === "function") {
          try { el.showPicker(); } catch (e) {}
        }
      });
    }
  });

  document.getElementById("f-qualification").addEventListener("change", e => {
    document.getElementById("qual-detail-wrap").classList.toggle("hidden", e.target.value !== "Graduation Continue");
  });

  document.querySelectorAll('input[name="f-relStatus"]').forEach(r => r.addEventListener("change", () => {
    document.getElementById("children-wrap").classList.toggle("hidden", document.querySelector('input[name="f-relStatus"]:checked')?.value !== "Married");
  }));

  document.querySelectorAll('input[name="f-illness"]').forEach(r => r.addEventListener("change", () => {
    document.getElementById("illness-detail-wrap").classList.toggle("hidden", document.querySelector('input[name="f-illness"]:checked')?.value !== "Yes");
  }));

  document.querySelectorAll('input[name="f-crime"]').forEach(r => r.addEventListener("change", () => {
    document.getElementById("crime-detail-wrap").classList.toggle("hidden", document.querySelector('input[name="f-crime"]:checked')?.value !== "Yes");
  }));

  document.querySelectorAll('input[name="f-prevExp"]').forEach(r => r.addEventListener("change", () => {
    document.getElementById("prevexp-detail-wrap").classList.toggle("hidden", document.querySelector('input[name="f-prevExp"]:checked')?.value !== "Yes");
  }));

  function setupUploader(boxId, inputId, previewId, storeKey, changeFlag, maxDim, quality) {
    document.getElementById(boxId).onclick = () => document.getElementById(inputId).click();
    document.getElementById(inputId).addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const b64 = await compressImageFile(file, maxDim, quality);
        store[storeKey] = b64;
        store[changeFlag] = true;
        const prev = document.getElementById(previewId);
        prev.src = b64;
        prev.classList.remove("hidden");
      } catch (err) {
        showNotification("Image compression error.", true);
      }
    });
  }

  setupUploader("pic-box", "f-picture", "pic-preview", "picture", "_hasPicChanged", 500, 0.75);
  setupUploader("cnicf-box", "f-cnicFront", "cnicf-preview", "cnicFront", "_hasFrontChanged", 750, 0.65);
  setupUploader("cnicb-box", "f-cnicBack", "cnicb-preview", "cnicBack", "_hasBackChanged", 750, 0.65);
}

function parseFormData(existing = {}) {
  const getVal = id => document.getElementById(id)?.value?.trim() || "";
  const getRadio = name => document.querySelector(`input[name="${name}"]:checked`)?.value || "";

  return Object.assign({}, existing, {
    position: getVal("f-position"),
    salary: getVal("f-salary"),
    fullName: getVal("f-fullName"),
    fatherName: getVal("f-fatherName"),
    dob: getVal("f-dob"),
    cnic: getVal("f-cnic"),
    fatherCnic: getVal("f-fatherCnic"),
    gender: getRadio("f-gender"),
    joiningDate: getVal("f-joiningDate"),
    relationshipStatus: getRadio("f-relStatus"),
    childrenCount: getVal("f-childrenCount"),
    permanentAddress: getVal("f-permAddress"),
    temporaryAddress: getVal("f-tempAddress"),
    mobileNumber: getVal("f-mobileNumber"),
    homeNumber: getVal("f-homeNumber"),
    email: getVal("f-email"),
    qualification: document.getElementById("f-qualification")?.value || "",
    qualificationDetail: getVal("f-qualificationDetail"),
    illness: getRadio("f-illness"),
    illnessDetail: getVal("f-illnessDetail"),
    crimeRecord: getRadio("f-crime"),
    crimeDetail: getVal("f-crimeDetail"),
    previousExperience: getRadio("f-prevExp"),
    prevExpDetail: getVal("f-prevExpDetail"),
    prevSalary: getVal("f-prevSalary"),
    prevReason: getVal("f-prevReason"),
    courses: getVal("f-courses"),
    skills: getVal("f-skills")
  });
}

function validateRecordForm(d) {
  const missing = [];
  if (!d.position) missing.push("Position");
  if (!d.fullName) missing.push("Full Name");
  if (!d.dob) missing.push("Date of Birth");
  if (!d.cnic) missing.push("CNIC");
  if (!d.joiningDate) missing.push("Joining Date");
  if (!d.permanentAddress) missing.push("Permanent Address");
  if (!d.temporaryAddress) missing.push("Temporary Address");
  if (!d.mobileNumber) missing.push("Mobile Number");
  if (!d.homeNumber) missing.push("Home Number (Emergency)");
  if (!d.qualification) missing.push("Qualification");
  if (d.qualification === "Graduation Continue" && !d.qualificationDetail) missing.push("Academic Details");
  if (d.previousExperience === "Yes") {
    if (!d.prevExpDetail) missing.push("Experience Details");
    if (!d.prevSalary) missing.push("Previous Salary");
    if (!d.prevReason) missing.push("Reason for Leaving");
  }
  if (!d.picture) missing.push("Picture");
  if (!d.cnicFront) missing.push("CNIC Front");
  if (!d.cnicBack) missing.push("CNIC Back");
  return missing;
}

/* --- Employee lists --- */

function renderEmployeeGrid(list, statusClass) {
  if (!list.length) return `<div class="empty-view card">No records found.</div>`;
  return `<div class="records-grid">` + list.map(emp => `
    <div class="card employee-card" data-id="${sanitize(emp.id)}">
      ${emp.picture ? `<img class="avatar" src="${sanitize(emp.picture)}">` : `<div class="avatar empty">👤</div>`}
      <div class="emp-name">${sanitize(emp.fullName || "(No name)")}</div>
      <div class="emp-id">${sanitize(emp.cnic || emp.id)}</div>
      <div class="emp-status ${statusClass}">${emp.status === "current" ? "Active" : sanitize(emp.exitType || "Archived")}</div>
    </div>`).join("") + `</div>`;
}

function filterRecords(list, q) {
  if (!q) return list;
  const target = q.toLowerCase();
  const targetDigits = q.replace(/\D/g, "");
  return list.filter(e => {
    const name = (e.fullName || "").toLowerCase();
    const cnic = (e.cnic || "").toLowerCase();
    if (name.includes(target) || cnic.includes(target)) return true;
    if (targetDigits && cnic.replace(/\D/g, "").includes(targetDigits)) return true;
    return false;
  });
}

/* --- Print document --- */

function buildPrintDocument(emp) {
  const row = (label, val) => (val !== undefined && val !== null && String(val).trim() !== "") ? `<div class="prow"><div class="plabel">${sanitize(label)}</div><div class="pvalue">${sanitize(val)}</div></div>` : "";

  let fields = "";
  fields += row("Position", emp.position);
  fields += row("Salary", emp.salary);
  fields += row("Full Name", emp.fullName);
  fields += row("Father Name", emp.fatherName);
  fields += row("Date of Birth", emp.dob);
  fields += row("CNIC", emp.cnic);
  fields += row("Father CNIC", emp.fatherCnic);
  fields += row("Gender", emp.gender);
  fields += row("Joining Date", emp.joiningDate);
  fields += row("Marital Status", emp.relationshipStatus);
  if (emp.relationshipStatus === "Married") fields += row("Children", emp.childrenCount);
  fields += row("Permanent Address", emp.permanentAddress);
  fields += row("Temporary Address", emp.temporaryAddress);
  fields += row("Mobile Number", emp.mobileNumber);
  fields += row("Emergency Contact", emp.homeNumber);
  fields += row("Email", emp.email);
  fields += row("Qualification", emp.qualification);
  if (emp.qualification === "Graduation Continue") fields += row("Academic Details", emp.qualificationDetail);
  fields += row("Serious Illness", emp.illness);
  if (emp.illness === "Yes") fields += row("Illness Detail", emp.illnessDetail);
  fields += row("Crime Record", emp.crimeRecord);
  if (emp.crimeRecord === "Yes") fields += row("Crime Detail", emp.crimeDetail);
  fields += row("Previous Experience", emp.previousExperience);
  if (emp.previousExperience === "Yes") {
    fields += row("Experience Detail", emp.prevExpDetail);
    fields += row("Previous Salary", emp.prevSalary);
    fields += row("Reason for Leaving", emp.prevReason);
  }
  fields += row("Courses", emp.courses);
  fields += row("Skills", emp.skills);
  if (emp.status === "resigned") {
    fields += row("Exit Type", emp.exitType);
    fields += row("Exit Date", emp.exitDate);
    fields += row("Exit Note", emp.exitNote);
  }

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${sanitize(emp.fullName || "Employee")} - Record</title>
  <style>
    body{ font-family: Arial, sans-serif; color:#111; padding:24px; }
    .phead{ display:flex; justify-content:space-between; align-items:flex-end; border-bottom:3px solid #10b981; padding-bottom:14px; margin-bottom:20px; }
    .phead h1{ font-size:20px; margin:0; }
    .ptop{ display:flex; gap:20px; margin-bottom:20px; align-items:center; }
    .ptop img.photo{ width:110px; height:110px; object-fit:cover; border:1px solid #ccc; border-radius:4px; }
    .pname{ font-size:18px; font-weight:bold; }
    .pposition{ font-size:13px; color:#555; }
    .pgrid{ display:grid; grid-template-columns:1fr 1fr; gap:0 24px; font-size:12.5px; }
    .prow{ padding:6px 0; border-bottom:1px solid #eee; break-inside:avoid; }
    .plabel{ font-size:9.5px; text-transform:uppercase; letter-spacing:0.5px; color:#777; }
    .pvalue{ margin-top:2px; }
    .pdocs{ display:flex; gap:14px; margin-top:22px; }
    .pdocs img{ width:150px; height:100px; object-fit:cover; border:1px solid #ccc; border-radius:4px; }
    .pdocs .dlbl{ font-size:10px; color:#666; text-align:center; margin-top:4px; }
    .pfooter{ margin-top:26px; font-size:10px; color:#888; border-top:1px solid #ddd; padding-top:10px; }
    @media print{ body{ padding:8mm; } }
  </style></head>
  <body>
    <div class="phead"><div><h1>OPTP Sch III</h1><div style="font-size:11px;color:#555;">Employee Record File</div></div></div>
    <div class="ptop">
      ${emp.picture ? `<img class="photo" src="${emp.picture}">` : ""}
      <div><div class="pname">${sanitize(emp.fullName || "")}</div><div class="pposition">${sanitize(emp.position || "")}</div></div>
    </div>
    <div class="pgrid">${fields}</div>
    <div class="pdocs">
      ${emp.cnicFront ? `<div><img src="${emp.cnicFront}"><div class="dlbl">CNIC Front</div></div>` : ""}
      ${emp.cnicBack ? `<div><img src="${emp.cnicBack}"><div class="dlbl">CNIC Back</div></div>` : ""}
    </div>
    <div class="pfooter">Confidential Employee Record &bull; OPTP Sch III &mdash; Only for Office Use</div>
  </body></html>`;
}

async function triggerPrint(emp) {
  await fetchFullAttachments(emp);
  const html = buildPrintDocument(emp);
  const win = window.open("", "_blank", "width=900,height=1000");
  if (!win) {
    showNotification("Popup blocked. Please permit popups.", true);
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  const printAction = () => { try { win.focus(); win.print(); } catch (e) {} };
  win.onload = printAction;
  setTimeout(printAction, 400);
}

/* --- Detail / Edit / Resign modals --- */

function renderFieldEntry(k, v) {
  return `<div class="detail-entry"><div class="prop">${sanitize(k)}</div><div class="val">${(v === undefined || v === "") ? "—" : sanitize(v)}</div></div>`;
}

async function displayDetailModal(id, source) {
  const list = source === "current" ? activeEmployees : archivedEmployees;
  const emp = list.find(e => e.id === id);
  if (!emp) return;

  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.innerHTML = `
    <div class="card modal-dialog">
      <span class="modal-dismiss" id="detail-close">&times;</span>
      <div class="sub-header">${source === "current" ? "ACTIVE FILE" : "ARCHIVED FILE"}</div>
      <h2 class="accent-text" style="margin:6px 0 4px;">${sanitize(emp.fullName || "(No name)")}</h2>
      <div class="meta-text">${sanitize(emp.position || "")}</div>
      <div id="detail-thumbs" class="document-previews">
        <div>${emp.picture ? `<img src="${emp.picture}">` : ""}<div class="tag">Picture</div></div>
        <div>${emp.cnicFront ? `<img src="${emp.cnicFront}">` : ""}<div class="tag">CNIC Front</div></div>
        <div>${emp.cnicBack ? `<img src="${emp.cnicBack}">` : ""}<div class="tag">CNIC Back</div></div>
      </div>
      <div class="details-grid">
        ${renderFieldEntry("Position", emp.position)}
        ${renderFieldEntry("Salary", emp.salary)}
        ${renderFieldEntry("Full Name", emp.fullName)}
        ${renderFieldEntry("Father Name", emp.fatherName)}
        ${renderFieldEntry("DOB", emp.dob)}
        ${renderFieldEntry("CNIC", emp.cnic)}
        ${renderFieldEntry("Father CNIC", emp.fatherCnic)}
        ${renderFieldEntry("Gender", emp.gender)}
        ${renderFieldEntry("Joining Date", emp.joiningDate)}
        ${renderFieldEntry("Marital Status", emp.relationshipStatus)}
        ${renderFieldEntry("Children", emp.childrenCount)}
        ${renderFieldEntry("Permanent Address", emp.permanentAddress)}
        ${renderFieldEntry("Temporary Address", emp.temporaryAddress)}
        ${renderFieldEntry("Mobile Number", emp.mobileNumber)}
        ${renderFieldEntry("Emergency Contact", emp.homeNumber)}
        ${renderFieldEntry("Email", emp.email)}
        ${renderFieldEntry("Qualification", emp.qualification)}
        ${renderFieldEntry("Qualification Detail", emp.qualificationDetail)}
        ${renderFieldEntry("Serious Illness", emp.illness)}
        ${renderFieldEntry("Illness Detail", emp.illness === "Yes" ? emp.illnessDetail : "")}
        ${renderFieldEntry("Crime Record", emp.crimeRecord)}
        ${renderFieldEntry("Crime Detail", emp.crimeRecord === "Yes" ? emp.crimeDetail : "")}
        ${renderFieldEntry("Previous Experience", emp.previousExperience)}
        ${renderFieldEntry("Experience Detail", emp.prevExpDetail)}
        ${renderFieldEntry("Previous Salary", emp.prevSalary)}
        ${renderFieldEntry("Reason for Leaving", emp.prevReason)}
        ${renderFieldEntry("Courses", emp.courses)}
        ${renderFieldEntry("Skills", emp.skills)}
        ${source === "resigned" ? renderFieldEntry("Exit Type", emp.exitType) : ""}
        ${source === "resigned" ? renderFieldEntry("Exit Date", emp.exitDate) : ""}
        ${source === "resigned" ? renderFieldEntry("Exit Note", emp.exitNote) : ""}
      </div>
      <div class="actions-bar">
        <button class="btn cyan" id="print-btn">Print</button>
        <button class="btn cyan" id="pdf-btn">Save as PDF</button>
        <button class="btn cyan" id="edit-btn">Edit Record</button>
        ${source === "current" ? `<button class="btn amber" id="resign-btn">Mark Resigned / Retired</button>` : `<button class="btn amber" id="reactivate-btn">Reactivate</button>`}
        <button class="btn red" id="delete-btn">Delete Record</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector("#detail-close").onclick = () => overlay.remove();
  overlay.querySelector("#print-btn").onclick = () => promptAuth("Print Authorization", () => triggerPrint(emp));
  overlay.querySelector("#pdf-btn").onclick = () => promptAuth("PDF Export Authorization", () => triggerPrint(emp));
  overlay.querySelector("#edit-btn").onclick = () => promptAuth("Edit Authorization", async () => { overlay.remove(); await displayEditModal(emp, source); });
  overlay.querySelector("#delete-btn").onclick = () => promptAuth("Delete Authorization", async () => {
    if (!confirm(`Send "${emp.fullName || "this record"}" to Google Drive Trash?`)) return;
    try {
      await Storage.trashEntry(emp.folderId);
      const arr = source === "current" ? activeEmployees : archivedEmployees;
      const idx = arr.findIndex(e => e.id === id);
      if (idx > -1) arr.splice(idx, 1);
      overlay.remove();
      showNotification("Record sent to Trash.");
      render();
    } catch (e) {
      if (isAuthError(e)) { overlay.remove(); currentScreen = "login"; showNotification("Session expired. Please sign in again.", true); render(); return; }
      showNotification("Delete operation failed.", true);
    }
  });

  if (source === "current") {
    overlay.querySelector("#resign-btn").onclick = () => promptAuth("Status Change Authorization", () => { overlay.remove(); displayResignModal(emp); });
  } else {
    overlay.querySelector("#reactivate-btn").onclick = () => promptAuth("Reactivation Authorization", async () => {
      try {
        await Storage.relocateFolder(emp.folderId, folderArchiveId, folderActiveId);
        const idx = archivedEmployees.findIndex(e => e.id === id);
        if (idx > -1) {
          const [moved] = archivedEmployees.splice(idx, 1);
          moved.status = "current";
          delete moved.exitType;
          delete moved.exitDate;
          delete moved.exitNote;
          await saveProfileFile(moved);
          activeEmployees.push(moved);
        }
        overlay.remove();
        showNotification("Employee reactivated.");
        currentScreen = "current";
        render();
      } catch (e) {
        if (isAuthError(e)) { overlay.remove(); currentScreen = "login"; showNotification("Session expired. Please sign in again.", true); render(); return; }
        showNotification("Reactivation failed.", true);
      }
    });
  }

  if (!emp.cnicFront || !emp.cnicBack) {
    fetchFullAttachments(emp).then(() => {
      const thumbs = document.getElementById("detail-thumbs");
      if (thumbs) {
        thumbs.innerHTML = `
          <div>${emp.picture ? `<img src="${emp.picture}">` : ""}<div class="tag">Picture</div></div>
          <div>${emp.cnicFront ? `<img src="${emp.cnicFront}">` : ""}<div class="tag">CNIC Front</div></div>
          <div>${emp.cnicBack ? `<img src="${emp.cnicBack}">` : ""}<div class="tag">CNIC Back</div></div>`;
      }
    });
  }
}

function displayResignModal(emp) {
  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.innerHTML = `
    <div class="card auth-dialog" style="max-width:420px;text-align:left;">
      <div class="sub-header">STATUS CHANGE</div>
      <h3 style="margin:8px 0 16px;">${sanitize(emp.fullName)}</h3>
      <div class="field"><label>Type</label>
        <div class="radio-group">
          <label class="radio-opt"><input type="radio" name="exit-type" value="Resigned" checked> Resigned</label>
          <label class="radio-opt"><input type="radio" name="exit-type" value="Retired"> Retired</label>
        </div>
      </div>
      <div class="field"><label>Date</label><input type="date" id="exit-date"></div>
      <div class="field"><label>Note (optional)</label><textarea id="exit-note" rows="2"></textarea></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn cyan" id="exit-cancel">Cancel</button>
        <button class="btn amber" id="exit-confirm">Confirm</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector("#exit-cancel").onclick = () => overlay.remove();

  const exitDate = overlay.querySelector("#exit-date");
  exitDate.addEventListener("click", () => {
    if (typeof exitDate.showPicker === "function") {
      try { exitDate.showPicker(); } catch (e) {}
    }
  });

  overlay.querySelector("#exit-confirm").onclick = async () => {
    const type = overlay.querySelector('input[name="exit-type"]:checked').value;
    const date = exitDate.value.trim();
    const note = overlay.querySelector("#exit-note").value.trim();
    const btn = overlay.querySelector("#exit-confirm");
    btn.disabled = true;
    btn.textContent = "Updating...";

    try {
      await Storage.relocateFolder(emp.folderId, folderActiveId, folderArchiveId);
      const idx = activeEmployees.findIndex(e => e.id === emp.id);
      if (idx > -1) {
        const [moved] = activeEmployees.splice(idx, 1);
        moved.status = "resigned";
        moved.exitType = type;
        moved.exitDate = date;
        moved.exitNote = note;
        await saveProfileFile(moved);
        archivedEmployees.push(moved);
      }
      overlay.remove();
      showNotification(`${emp.fullName} moved to Resigned/Retired.`);
      currentScreen = "resigned";
      render();
    } catch (e) {
      if (isAuthError(e)) { overlay.remove(); currentScreen = "login"; showNotification("Session expired. Please sign in again.", true); render(); return; }
      showNotification("Status change failed.", true);
      btn.disabled = false;
      btn.textContent = "Confirm";
    }
  };
}

async function displayEditModal(emp, source) {
  await fetchFullAttachments(emp);
  const store = Object.assign({}, emp);
  const overlay = document.createElement("div");
  overlay.className = "modal-backdrop";
  overlay.innerHTML = `
    <div class="card modal-dialog">
      <span class="modal-dismiss" id="edit-close">&times;</span>
      <div class="sub-header">EDIT RECORD</div>
      <h2 class="accent-text" style="margin:6px 0 16px;">${sanitize(emp.fullName || "(No name)")}</h2>
      ${renderFormMarkup(emp)}
      <div class="form-buttons">
        <button class="btn" id="save-edit-btn">Save Changes</button>
        <button class="btn cyan" id="cancel-edit-btn">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  bindFormEvents(store);

  overlay.querySelector("#edit-close").onclick = () => overlay.remove();
  overlay.querySelector("#cancel-edit-btn").onclick = () => overlay.remove();
  overlay.querySelector("#save-edit-btn").onclick = async () => {
    const data = parseFormData(store);
    const missing = validateRecordForm(data);
    if (missing.length) {
      showNotification(`Missing: ${missing.join(", ")}`, true);
      return;
    }
    data.id = emp.id;
    data.status = emp.status;
    data.folderId = emp.folderId;
    data.profileFileId = emp.profileFileId;
    data.pictureFileId = emp.pictureFileId;
    data.cnicFrontFileId = emp.cnicFrontFileId;
    data.cnicBackFileId = emp.cnicBackFileId;

    if (source === "resigned") {
      data.exitType = emp.exitType;
      data.exitDate = emp.exitDate;
      data.exitNote = emp.exitNote;
    }

    const btn = overlay.querySelector("#save-edit-btn");
    btn.disabled = true;
    btn.textContent = "Saving...";

    try {
      await modifyEmployee(data);
      const arr = source === "current" ? activeEmployees : archivedEmployees;
      const idx = arr.findIndex(e => e.id === emp.id);
      if (idx > -1) arr[idx] = data;
      overlay.remove();
      showNotification("Changes saved to Drive.");
      render();
    } catch (e) {
      if (isAuthError(e)) { overlay.remove(); currentScreen = "login"; showNotification("Session expired. Please sign in again.", true); render(); return; }
      showNotification("Save failed.", true);
      btn.disabled = false;
      btn.textContent = "Save Changes";
    }
  };
}

/* --- Screens --- */

function render(statusMessage = "") {
  if (currentScreen === "pinlock") {
    root.innerHTML = `
      <div class="card auth-box">
        <div class="sub-header">OPTP SCH III &bull; SECURE ACCESS</div>
        <h1 class="accent-text" style="font-size:22px;margin:8px 0 24px;">Employee Record System</h1>
        <div class="meta-text" style="font-size:13px;margin-bottom:14px;">Enter authorization PIN to unlock.</div>
        <div class="field">
          <input type="password" id="pin-input" placeholder="Enter PIN" autocomplete="off">
        </div>
        <div id="pin-error" style="color:var(--danger);font-size:11.5px;min-height:16px;margin:6px 0 4px;"></div>
        <button class="btn" id="pin-submit" style="width:100%;margin-top:8px;">Unlock</button>
      </div>`;

    const input = document.getElementById("pin-input");
    if (input) input.focus();

    function checkPin() {
      if (input.value === CONFIG.APP_PIN) {
        trySessionRestore();
      } else {
        document.getElementById("pin-error").textContent = "Incorrect PIN.";
        input.value = "";
        input.focus();
      }
    }

    document.getElementById("pin-submit").onclick = checkPin;
    input?.addEventListener("keydown", e => { if (e.key === "Enter") checkPin(); });
  }

  else if (currentScreen === "login") {
    root.innerHTML = `
      <div class="card auth-box">
        <div class="sub-header">OPTP SCH III &bull; SECURE ACCESS</div>
        <h1 class="accent-text" style="font-size:22px;margin:8px 0 24px;">Employee Record System</h1>
        <div class="meta-text" style="font-size:13px;margin-bottom:16px;">Connect with an authorized Google account to sync with Drive.</div>
        <button class="btn" id="google-auth-btn" style="padding:12px 26px;">Sign in with Google</button>
      </div>`;
    document.getElementById("google-auth-btn").onclick = () => tokenClient?.requestAccessToken({ prompt: "consent" });
  }

  else if (currentScreen === "loading") {
    root.innerHTML = `
      <div class="loading-wrap">
        <div class="sub-header">SYNCHRONIZING</div>
        <div class="spinner"></div>
        <div class="meta-text" style="font-size:13px;">${sanitize(statusMessage || "Loading...")}</div>
      </div>`;
  }

  else if (currentScreen === "dashboard") {
    root.innerHTML = renderHeaderBar() + `
      <div id="main-container">
        <div class="stats-grid">
          <div class="card stat-item" id="card-active">
            <div class="icon">🗂️</div>
            <div class="lbl">Current Employees</div>
            <div class="val">${activeEmployees.length}</div>
            <div class="meta-text">Active staff members</div>
          </div>
          <div class="card stat-item" id="card-new">
            <div class="icon">➕</div>
            <div class="lbl">New Employee</div>
            <div class="val">+</div>
            <div class="meta-text">Register new profile</div>
          </div>
          <div class="card stat-item" id="card-archived">
            <div class="icon">📁</div>
            <div class="lbl">Resigned / Retired</div>
            <div class="val">${archivedEmployees.length}</div>
            <div class="meta-text">Archived profiles</div>
          </div>
        </div>
      </div>`;

    wireLogoutButton();
    document.getElementById("card-active").onclick = () => { currentScreen = "current"; render(); };
    document.getElementById("card-new").onclick = () => promptAuth("New Registration", () => { currentScreen = "new"; render(); });
    document.getElementById("card-archived").onclick = () => { currentScreen = "resigned"; render(); };
  }

  else if (currentScreen === "new") {
    const store = {};
    root.innerHTML = renderHeaderBar() + `
      <div id="main-container">
        <div class="view-heading"><span class="nav-link" id="nav-dash">&larr; Dashboard</span></div>
        <h2 class="accent-text" style="margin:10px 0 4px;">New Employee Record</h2>
        <div class="meta-text">Mandatory fields are marked with *</div>
        <div class="card form-body">
          ${renderFormMarkup()}
          <div class="form-buttons">
            <button class="btn" id="save-new-btn">Save Employee</button>
            <button class="btn cyan" id="cancel-new-btn">Cancel</button>
          </div>
        </div>
      </div>`;

    wireLogoutButton();
    bindFormEvents(store);
    document.getElementById("nav-dash").onclick = () => { currentScreen = "dashboard"; render(); };
    document.getElementById("cancel-new-btn").onclick = () => { currentScreen = "dashboard"; render(); };

    document.getElementById("save-new-btn").onclick = async () => {
      const data = parseFormData(store);
      const errors = validateRecordForm(data);
      if (errors.length) {
        showNotification(`Missing: ${errors.join(", ")}`, true);
        return;
      }
      const btn = document.getElementById("save-new-btn");
      btn.disabled = true;
      btn.textContent = "Saving to Drive...";

      try {
        data.id = generateId();
        data.status = "current";
        const created = await insertEmployee(data);
        activeEmployees.push(created);
        showNotification("Employee saved successfully.");
        currentScreen = "current";
        render();
      } catch (err) {
        if (isAuthError(err)) { currentScreen = "login"; showNotification("Session expired. Please sign in again.", true); render(); return; }
        showNotification("Drive storage failure.", true);
        btn.disabled = false;
        btn.textContent = "Save Employee";
      }
    };
  }

  else if (currentScreen === "current" || currentScreen === "resigned") {
    const isCurrent = currentScreen === "current";
    const sourceList = isCurrent ? activeEmployees : archivedEmployees;
    const query = isCurrent ? filterCurrentQuery : filterArchiveQuery;
    const filtered = filterRecords(sourceList, query);

    root.innerHTML = renderHeaderBar() + `
      <div id="main-container">
        <div class="view-heading"><span class="nav-link" id="nav-dash">&larr; Dashboard</span></div>
        <h2 class="accent-text" style="margin:10px 0 4px;">${isCurrent ? "Current Employees" : "Resigned / Retired Archives"} (${sourceList.length})</h2>
        <div class="search-wrap"><input id="search-input" placeholder="Search by name or CNIC..." value="${sanitize(query)}"></div>
        <div id="records-wrap">${renderEmployeeGrid(filtered, isCurrent ? "active" : "archived")}</div>
      </div>`;

    wireLogoutButton();
    document.getElementById("nav-dash").onclick = () => { currentScreen = "dashboard"; render(); };
    const search = document.getElementById("search-input");

    search.addEventListener("input", e => {
      if (isCurrent) filterCurrentQuery = e.target.value;
      else filterArchiveQuery = e.target.value;

      document.getElementById("records-wrap").innerHTML = renderEmployeeGrid(
        filterRecords(sourceList, e.target.value),
        isCurrent ? "active" : "archived"
      );
      wireCards(isCurrent ? "current" : "resigned");
    });

    wireCards(isCurrent ? "current" : "resigned");
  }
}

function wireCards(source) {
  document.querySelectorAll(".employee-card").forEach(card => {
    card.onclick = () => displayDetailModal(card.getAttribute("data-id"), source);
  });
}

render();
