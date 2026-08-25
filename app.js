const CLIENT_ID = "936109847577-ajbaefe746dalhe6vn7ae0u2pdl26sds.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email";
const APP_PASSWORD = "6666";
const SESSION_KEY = "optp_session_v1";

let accessToken = null;
let tokenClient = null;
let userEmail = null;
let rootFolderId, currentFolderId, resignedFolderId;
let currentEmployees = [];
let resignedEmployees = [];
let view = "pinlock";
let searchQueryCurrent = "";
let searchQueryResigned = "";
let silentAttemptInProgress = false;
let silentAttemptEmail = null;

const app = document.getElementById('app');

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function uid() {
  return 'EMP-' + Date.now() + '-' + Math.floor(Math.random() * 9000 + 1000);
}

function saveSession(email, token, expiresInSeconds) {
  try {
    const expiresAt = Date.now() + (Math.max(60, (expiresInSeconds || 3300) - 120)) * 1000;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ email, token, expiresAt }));
  } catch(e) {}
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch(e) {
    return null;
  }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch(e) {}
}

function initGis() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: async (resp) => {
      const wasSilent = silentAttemptInProgress;
      const expectedEmail = silentAttemptEmail;
      silentAttemptInProgress = false;
      silentAttemptEmail = null;
      if (resp.error) {
        if (wasSilent) { view = 'login'; render(); return; }
        toast('Login failed: ' + resp.error, true);
        view = 'login';
        render();
        return;
      }
      accessToken = resp.access_token;
      await afterLogin(wasSilent, expectedEmail, resp.expires_in);
    }
  });
}

window.addEventListener('load', () => {
  const check = setInterval(() => {
    if (window.google && google.accounts && google.accounts.oauth2) {
      clearInterval(check);
      initGis();
      view = 'pinlock';
      render();
    }
  }, 100);
});

async function attemptAutoLogin() {
  const session = loadSession();

  // 1. Agar cached token abhi valid hai to direct use karein
  if (session && session.token && session.expiresAt > Date.now()) {
    view = 'loading';
    render('Restoring your session...');
    accessToken = session.token;
    await afterLogin(true, session.email, null, true);
    return;
  }

  // 2. Agar token expire ho gaya hai to background mein silent refresh karein
  const savedEmail = session ? session.email : null;
  if (!savedEmail) {
    view = 'login';
    render();
    return;
  }

  view = 'loading';
  render('Restoring your session...');
  silentAttemptInProgress = true;
  silentAttemptEmail = savedEmail;
  let settled = false;

  const fallbackTimer = setTimeout(() => {
    if (!settled) {
      settled = true;
      silentAttemptInProgress = false;
      silentAttemptEmail = null;
      view = 'login';
      render();
    }
  }, 6000);

  const originalCallback = tokenClient.callback;
  tokenClient.callback = (resp) => {
    settled = true;
    clearTimeout(fallbackTimer);
    tokenClient.callback = originalCallback;
    originalCallback(resp);
  };

  try {
    tokenClient.requestAccessToken({ prompt: 'none', hint: savedEmail });
  } catch(e) {
    if (!settled) {
      settled = true;
      clearTimeout(fallbackTimer);
      silentAttemptInProgress = false;
      silentAttemptEmail = null;
      view = 'login';
      render();
    }
  }
}

function loginWithGoogle() {
  if (!tokenClient) {
    toast('Authentication service loading...', true);
    return;
  }
  tokenClient.requestAccessToken({ prompt: 'consent' });
}

function logoutFlow() {
  askPassword('Confirm Logout', () => {
    if (accessToken) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    clearSession();
    accessToken = null;
    userEmail = null;
    currentEmployees = [];
    resignedEmployees = [];
    view = 'login';
    render();
    toast('Logged out.');
  });
}

async function afterLogin(isSilent, expectedEmail, expiresInSeconds, isFromCache) {
  view = 'loading';
  render('Verifying Google Account...');
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    if (!res.ok) {
      clearSession();
      accessToken = null;
      view = 'login';
      render();
      if (!isSilent) toast('Session expired. Please sign in again.', true);
      return;
    }
    const info = await res.json();
    if (isSilent && expectedEmail && info.email !== expectedEmail) {
      clearSession();
      accessToken = null;
      view = 'login';
      render();
      return;
    }
    userEmail = info.email;
    if (!isFromCache) saveSession(userEmail, accessToken, expiresInSeconds);
    
    view = 'loading';
    render('Configuring Storage Folders...');
    await setupDriveStructure();
    
    view = 'loading';
    render('Loading employee records...');
    await loadAllFromDrive();
    
    view = 'dashboard';
    render();
  } catch(e) {
    if (isSilent) {
      accessToken = null;
      view = 'login';
      render();
      return;
    }
    toast('Error connecting to Google Drive.', true);
    view = 'login';
    render();
  }
}

function silentRefreshToken() {
  return new Promise((resolve) => {
    if (!tokenClient || !userEmail) { resolve(false); return; }
    let settled = false;
    const fallbackTimer = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, 6000);
    const originalCallback = tokenClient.callback;
    tokenClient.callback = (resp) => {
      settled = true;
      clearTimeout(fallbackTimer);
      tokenClient.callback = originalCallback;
      if (resp.error) { resolve(false); return; }
      accessToken = resp.access_token;
      saveSession(userEmail, accessToken, resp.expires_in);
      resolve(true);
    };
    try {
      tokenClient.requestAccessToken({ prompt: 'none', hint: userEmail });
    } catch(e) {
      if (!settled) {
        settled = true;
        clearTimeout(fallbackTimer);
        tokenClient.callback = originalCallback;
        resolve(false);
      }
    }
  });
}

async function driveFetch(url, options = {}, _isRetry) {
  options.headers = Object.assign({}, options.headers || {}, {
    Authorization: 'Bearer ' + accessToken
  });
  const res = await fetch(url, options);
  if (res.status === 401) {
    if (!_isRetry) {
      const refreshed = await silentRefreshToken();
      if (refreshed) return driveFetch(url, options, true);
    }
    clearSession();
    accessToken = null;
    view = 'login';
    render();
    throw new Error('401 Unauthorized');
  }
  if (!res.ok) {
    let detail = '';
    try { const errJson = await res.clone().json(); detail = errJson?.error?.message || ''; } catch(e) {}
    throw new Error('Drive API error ' + res.status + (detail ? ': ' + detail : ''));
  }
  return res;
}

async function findFolder(name, parentId) {
  const safe = name.replace(/'/g, "\\'");
  const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${safe}' and '${parentId}' in parents and trashed=false`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=10`);
  const data = await res.json();
  return (data.files && data.files.length) ? data.files[0].id : null;
}

async function createFolder(name, parentId) {
  const res = await driveFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
  });
  const data = await res.json();
  return data.id;
}

async function findOrCreateFolder(name, parentId) {
  let id = await findFolder(name, parentId);
  if (!id) id = await createFolder(name, parentId);
  return id;
}

async function setupDriveStructure() {
  rootFolderId = await findOrCreateFolder('OPTP Employee Record', 'root');
  currentFolderId = await findOrCreateFolder('Current Employees', rootFolderId);
  resignedFolderId = await findOrCreateFolder('Resigned or Retired Employees', rootFolderId);
}

async function createFileWithContent(name, mimeType, parentId, content, isText) {
  const metaRes = await driveFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: [parentId] })
  });
  const meta = await metaRes.json();
  const fileId = meta.id;
  const body = isText ? content : await (await fetch(content)).blob();
  await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'Content-Type': mimeType },
    body
  });
  return fileId;
}

async function updateFileContent(fileId, mimeType, content, isText) {
  const body = isText ? content : await (await fetch(content)).blob();
  await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'Content-Type': mimeType },
    body
  });
}

async function renameFile(fileId, newName) {
  await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName })
  });
}

async function moveFolder(folderId, fromParent, toParent) {
  await driveFetch(`https://www.googleapis.com/drive/v3/files/${folderId}?addParents=${toParent}&removeParents=${fromParent}`, { method: 'PATCH' });
}

async function trashFolder(folderId) {
  await driveFetch(`https://www.googleapis.com/drive/v3/files/${folderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true })
  });
}

async function listChildFolders(parentId) {
  const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1000`);
  const data = await res.json();
  return data.files || [];
}

async function listChildFiles(parentId) {
  const q = encodeURIComponent(`'${parentId}' in parents and trashed=false`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType)&pageSize=100`);
  const data = await res.json();
  return data.files || [];
}

async function getFileText(fileId) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  return res.text();
}

async function getFileDataUrl(fileId) {
  if (!fileId) return '';
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  const blob = await res.blob();
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

async function loadEmployeesFromFolder(parentId) {
  const folders = await listChildFolders(parentId);
  return Promise.all(folders.map(async (folder) => {
    const children = await listChildFiles(folder.id);
    const profileFile = children.find(f => f.name === 'profile.json');
    const pictureFile = children.find(f => f.name === 'picture.jpg');
    const cnicFrontFile = children.find(f => f.name === 'cnic_front.jpg');
    const cnicBackFile = children.find(f => f.name === 'cnic_back.jpg');

    let data = {};
    if (profileFile) {
      try { data = JSON.parse(await getFileText(profileFile.id)); } catch(e) {}
    }
    data.folderId = folder.id;
    data.profileFileId = profileFile ? profileFile.id : null;
    data.pictureFileId = pictureFile ? pictureFile.id : null;
    data.cnicFrontFileId = cnicFrontFile ? cnicFrontFile.id : null;
    data.cnicBackFileId = cnicBackFile ? cnicBackFile.id : null;

    if (pictureFile) {
      try { data.picture = await getFileDataUrl(pictureFile.id); } catch(e) {}
    }
    if (!data.id) data.id = folder.id;
    return data;
  }));
}

async function loadAllFromDrive() {
  currentEmployees = await loadEmployeesFromFolder(currentFolderId);
  resignedEmployees = await loadEmployeesFromFolder(resignedFolderId);
}

async function loadAssetsForDetail(emp) {
  if (emp.pictureFileId && !emp.picture) {
    try { emp.picture = await getFileDataUrl(emp.pictureFileId); } catch(e) {}
  }
  if (emp.cnicFrontFileId && !emp.cnicFront) {
    try { emp.cnicFront = await getFileDataUrl(emp.cnicFrontFileId); } catch(e) {}
  }
  if (emp.cnicBackFileId && !emp.cnicBack) {
    try { emp.cnicBack = await getFileDataUrl(emp.cnicBackFileId); } catch(e) {}
  }
  return emp;
}

function folderNameFor(data) {
  return (data.fullName || 'Unnamed') + ' - ' + (data.cnic || data.id);
}

function profileCopyOf(data) {
  const c = Object.assign({}, data);
  delete c.picture; delete c.cnicFront; delete c.cnicBack;
  delete c._pictureChanged; delete c._cnicFrontChanged; delete c._cnicBackChanged;
  return c;
}

async function createEmployeeInDrive(data) {
  const folderId = await createFolder(folderNameFor(data), currentFolderId);
  data.folderId = folderId;
  data.profileFileId = await createFileWithContent('profile.json', 'application/json', folderId, JSON.stringify(profileCopyOf(data)), true);
  if (data.picture) data.pictureFileId = await createFileWithContent('picture.jpg', 'image/jpeg', folderId, data.picture, false);
  if (data.cnicFront) data.cnicFrontFileId = await createFileWithContent('cnic_front.jpg', 'image/jpeg', folderId, data.cnicFront, false);
  if (data.cnicBack) data.cnicBackFileId = await createFileWithContent('cnic_back.jpg', 'image/jpeg', folderId, data.cnicBack, false);
  return data;
}

async function updateEmployeeInDrive(data) {
  await renameFile(data.folderId, folderNameFor(data));
  if (data.profileFileId) await updateFileContent(data.profileFileId, 'application/json', JSON.stringify(profileCopyOf(data)), true);
  else data.profileFileId = await createFileWithContent('profile.json', 'application/json', data.folderId, JSON.stringify(profileCopyOf(data)), true);

  if (data._pictureChanged && data.picture) {
    if (data.pictureFileId) await updateFileContent(data.pictureFileId, 'image/jpeg', data.picture, false);
    else data.pictureFileId = await createFileWithContent('picture.jpg', 'image/jpeg', data.folderId, data.picture, false);
  }
  if (data._cnicFrontChanged && data.cnicFront) {
    if (data.cnicFrontFileId) await updateFileContent(data.cnicFrontFileId, 'image/jpeg', data.cnicFront, false);
    else data.cnicFrontFileId = await createFileWithContent('cnic_front.jpg', 'image/jpeg', data.folderId, data.cnicFront, false);
  }
  if (data._cnicBackChanged && data.cnicBack) {
    if (data.cnicBackFileId) await updateFileContent(data.cnicBackFileId, 'image/jpeg', data.cnicBack, false);
    else data.cnicBackFileId = await createFileWithContent('cnic_back.jpg', 'image/jpeg', data.folderId, data.cnicBack, false);
  }
  delete data._pictureChanged; delete data._cnicFrontChanged; delete data._cnicBackChanged;
}

function askPassword(actionLabel, onSuccess) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="panel pw-modal-box">
      <div class="eyebrow">SECURITY CHECK</div>
      <h3 class="glow" style="margin:8px 0 16px;font-size:16px;">${esc(actionLabel)}</h3>
      <div class="field"><input type="password" id="pw-input" placeholder="Enter password" autocomplete="off"></div>
      <div id="pw-err" style="color:var(--danger);font-size:11px;min-height:14px;margin-bottom:10px;"></div>
      <div style="display:flex;gap:10px;justify-content:center;">
        <button class="btn cyan" id="pw-cancel">Cancel</button>
        <button class="btn" id="pw-confirm">Confirm</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#pw-input');
  input.focus();
  function confirmFn() {
    if (input.value === APP_PASSWORD) { overlay.remove(); onSuccess(); }
    else { overlay.querySelector('#pw-err').textContent = 'Incorrect password.'; input.value=''; input.focus(); }
  }
  overlay.querySelector('#pw-confirm').onclick = confirmFn;
  overlay.querySelector('#pw-cancel').onclick = () => overlay.remove();
  input.addEventListener('keydown', e => { if (e.key === 'Enter') confirmFn(); });
}

function compressImage(file, maxW, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxW) { h = Math.round(h * (maxW / w)); w = maxW; }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function renderLoading(msg) {
  app.innerHTML = `
    <div id="loading-screen">
      <div class="eyebrow">CONNECTING</div>
      <div class="spinner"></div>
      <div class="stat-line" style="font-size:13px;">${esc(msg || 'Working...')}</div>
    </div>`;
}

function renderPinLock() {
  app.innerHTML = `
    <div id="login-screen">
      <div class="eyebrow" style="text-align:center;">OPTP SCH III // SECURE ACCESS</div>
      <h1 class="glow" style="text-align:center;font-size:24px;margin:8px 0 26px;">EMPLOYEE RECORD SYSTEM<span class="term-cursor"></span></h1>
      <div class="panel login-box">
        <div class="stat-line" style="font-size:13px;margin-bottom:14px;">Enter the app password to continue.</div>
        <div class="field" style="text-align:left;">
          <input type="password" id="pinlock-input" placeholder="Enter password" autocomplete="off">
        </div>
        <div id="pinlock-err" style="color:var(--danger);font-size:11.5px;min-height:16px;margin:6px 0 4px;"></div>
        <button class="btn" id="pinlock-btn" style="width:100%;margin-top:8px;">Unlock</button>
      </div>
    </div>`;
  const input = document.getElementById('pinlock-input');
  input.focus();
  function tryUnlock() {
    if (input.value === APP_PASSWORD) {
      attemptAutoLogin();
    } else {
      document.getElementById('pinlock-err').textContent = 'Incorrect password.';
      input.value=''; input.focus();
    }
  }
  document.getElementById('pinlock-btn').onclick = tryUnlock;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
}

function renderLogin() {
  app.innerHTML = `
    <div id="login-screen">
      <div class="eyebrow" style="text-align:center;">OPTP SCH III // SECURE ACCESS</div>
      <h1 class="glow" style="text-align:center;font-size:24px;margin:8px 0 26px;">EMPLOYEE RECORD SYSTEM<span class="term-cursor"></span></h1>
      <div class="panel login-box">
        <div class="stat-line" style="font-size:13px;margin-bottom:10px;">Sign in with your Google account to connect Drive storage.</div>
        <div class="gsi-btn-wrap">
          <button class="btn" id="google-login-btn" style="padding:12px 26px;">Sign in with Google</button>
        </div>
      </div>
    </div>`;
  document.getElementById('google-login-btn').onclick = loginWithGoogle;
}

function topbarHTML() {
  return `
  <div id="topbar">
    <div>
      <div class="eyebrow">OPTP SCH III</div>
      <h2 class="glow" style="font-size:18px;">Employee Record System</h2>
    </div>
    <div style="text-align:right;">
      <div class="who">Signed in as <b>${esc(userEmail)}</b></div>
      <button class="btn red" id="logout-btn" style="margin-top:8px;padding:6px 14px;font-size:11px;">Logout</button>
    </div>
  </div>`;
}

function renderDashboard() {
  app.innerHTML = topbarHTML() + `
  <div id="main-wrap">
    <div class="dash-grid">
      <div class="panel dash-card" id="card-current">
        <div class="icon">🗂️</div><div class="lbl">Current Employees</div>
        <div class="count">${currentEmployees.length}</div>
        <div class="stat-line">View / search active staff</div>
      </div>
      <div class="panel dash-card" id="card-new">
        <div class="icon">➕</div><div class="lbl">New Employee</div>
        <div class="count">+</div>
        <div class="stat-line">Add a new employee record</div>
      </div>
      <div class="panel dash-card" id="card-resigned">
        <div class="icon">📁</div><div class="lbl">Resigned / Retired</div>
        <div class="count">${resignedEmployees.length}</div>
        <div class="stat-line">Past employee archive</div>
      </div>
    </div>
  </div>`;
  document.getElementById('logout-btn').onclick = logoutFlow;
  document.getElementById('card-current').onclick = () => { view = 'current'; render(); };
  document.getElementById('card-new').onclick = () => askPassword('Enter password to add a new employee', () => { view = 'new'; render(); });
  document.getElementById('card-resigned').onclick = () => { view = 'resigned'; render(); };
}

function formFieldsHTML(emp = {}) {
  const g = (k, d) => esc(emp[k] !== undefined ? emp[k] : (d || ''));
  const raw = (k, d) => emp[k] !== undefined ? emp[k] : (d || '');
  return `
    <div class="subhead">Employment & Personal Details</div>
    <div class="row">
      <div class="field"><label class="req">Position</label><input id="f-position" value="${g('position')}" placeholder="e.g. Branch Manager"></div>
      <div class="field"><label>Salary</label><input type="number" id="f-salary" value="${g('salary')}" placeholder="PKR"></div>
    </div>
    <div class="row">
      <div class="field"><label class="req">Full Name</label><input id="f-fullName" value="${g('fullName')}"></div>
      <div class="field"><label>Father Name</label><input id="f-fatherName" value="${g('fatherName')}"></div>
    </div>
    <div class="row">
      <div class="field"><label class="req">Date of Birth</label><input type="date" id="f-dob" value="${g('dob')}"></div>
      <div class="field"><label class="req">CNIC</label><input id="f-cnic" placeholder="xxxxx-xxxxxxx-x" maxlength="15" value="${g('cnic')}"></div>
    </div>
    <div class="row">
      <div class="field">
        <label>Gender</label>
        <div class="radio-group">
          ${['Male','Female','Transgender'].map(o => `<label class="radio-opt"><input type="radio" name="f-gender" value="${o}" ${raw('gender') === o ? 'checked' : ''}> ${o}</label>`).join('')}
        </div>
      </div>
      <div class="field"><label class="req">Joining Date</label><input type="date" id="f-joiningDate" value="${g('joiningDate')}"></div>
    </div>
    <div class="row">
      <div class="field">
        <label>Marital Status</label>
        <div class="radio-group">
          ${['Single','Married'].map(o => `<label class="radio-opt"><input type="radio" name="f-relStatus" value="${o}" ${raw('relationshipStatus') === o ? 'checked' : ''}> ${o}</label>`).join('')}
        </div>
      </div>
      <div class="field ${raw('relationshipStatus') === 'Married' ? '' : 'hidden'}" id="children-wrap">
        <label>Number of Children</label><input type="number" min="0" id="f-childrenCount" value="${g('childrenCount')}">
      </div>
    </div>

    <div class="subhead">Contact & Address</div>
    <div class="row">
      <div class="field"><label class="req">Permanent Address</label><textarea id="f-permAddress" rows="2">${g('permanentAddress')}</textarea></div>
      <div class="field"><label class="req">Temporary Address</label><textarea id="f-tempAddress" rows="2">${g('temporaryAddress')}</textarea></div>
    </div>
    <div class="row">
      <div class="field"><label class="req">Mobile Number</label><input type="tel" id="f-mobileNumber" placeholder="03xx-xxxxxxx" value="${g('mobileNumber')}"></div>
      <div class="field"><label class="req">Home Number (For emergency Contact)</label><input type="tel" id="f-homeNumber" placeholder="Emergency contact number" value="${g('homeNumber')}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Email</label><input type="email" id="f-email" placeholder="name@example.com" value="${g('email')}"></div>
    </div>

    <div class="subhead">Qualification</div>
    <div class="field">
      <label class="req">Qualification</label>
      <select id="f-qualification">
        <option value="">-- Select Qualification --</option>
        ${['Under Matric','Matric','Inter','Graduation','Graduation Continue','Masters'].map(o =>
          `<option value="${o}" ${raw('qualification') === o ? 'selected' : ''}>${o}</option>`).join('')}
      </select>
    </div>
    <div class="field ${raw('qualification') === 'Graduation Continue' ? '' : 'hidden'}" id="qual-detail-wrap">
      <label class="req">Department / University / Semester Detail</label>
      <textarea id="f-qualificationDetail" rows="2" placeholder="e.g. BSCS, 4th Semester">${g('qualificationDetail')}</textarea>
    </div>

    <div class="subhead">Experience</div>
    <div class="field">
      <label class="req">Previous Experience?</label>
      <div class="radio-group">
        ${['Yes','No'].map(o => `<label class="radio-opt"><input type="radio" name="f-prevExp" value="${o}" ${raw('previousExperience') === o ? 'checked' : ''}> ${o}</label>`).join('')}
      </div>
    </div>
    <div id="prevexp-detail-wrap" class="${raw('previousExperience') === 'Yes' ? '' : 'hidden'}">
      <div class="field"><label class="req">Experience Detail</label><textarea id="f-prevExpDetail" rows="2">${g('prevExpDetail')}</textarea></div>
      <div class="row">
        <div class="field"><label class="req">Previous Salary</label><input type="number" id="f-prevSalary" value="${g('prevSalary')}"></div>
        <div class="field"><label class="req">Reason for Leaving</label><input id="f-prevReason" value="${g('prevReason')}"></div>
      </div>
    </div>

    <div class="subhead">Documents</div>
    <div class="row">
      <div class="field">
        <label class="req">Upload Picture</label>
        <div class="upload-box" id="pic-box">Click to select photo<br><img class="upload-preview ${raw('picture') ? '' : 'hidden'}" id="pic-preview" src="${raw('picture') || ''}"></div>
        <input type="file" accept="image/*" id="f-picture" class="hidden">
      </div>
      <div class="field">
        <label class="req">CNIC Front Side</label>
        <div class="upload-box" id="cnicf-box">Click to select file<br><img class="upload-preview ${raw('cnicFront') ? '' : 'hidden'}" id="cnicf-preview" src="${raw('cnicFront') || ''}"></div>
        <input type="file" accept="image/*" id="f-cnicFront" class="hidden">
      </div>
      <div class="field">
        <label class="req">CNIC Back Side</label>
        <div class="upload-box" id="cnicb-box">Click to select file<br><img class="upload-preview ${raw('cnicBack') ? '' : 'hidden'}" id="cnicb-preview" src="${raw('cnicBack') || ''}"></div>
        <input type="file" accept="image/*" id="f-cnicBack" class="hidden">
      </div>
    </div>`;
}

function wireFormInteractions(store) {
  function formatCNIC(raw) {
    const digits = raw.replace(/\D/g, '').slice(0, 13);
    if (digits.length > 12) return digits.slice(0, 5) + '-' + digits.slice(5, 12) + '-' + digits.slice(12);
    if (digits.length > 5) return digits.slice(0, 5) + '-' + digits.slice(5);
    return digits;
  }

  const cnicInput = document.getElementById('f-cnic');
  if (cnicInput) {
    cnicInput.setAttribute('inputmode', 'numeric');
    cnicInput.addEventListener('input', () => {
      const pos = cnicInput.selectionStart === cnicInput.value.length;
      cnicInput.value = formatCNIC(cnicInput.value);
      if (pos) cnicInput.setSelectionRange(cnicInput.value.length, cnicInput.value.length);
    });
  }

  ['f-dob', 'f-joiningDate'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', () => {
        if (typeof el.showPicker === 'function') {
          try { el.showPicker(); } catch(e) {}
        }
      });
    }
  });

  document.getElementById('f-qualification').addEventListener('change', e => {
    document.getElementById('qual-detail-wrap').classList.toggle('hidden', e.target.value !== 'Graduation Continue');
  });

  document.querySelectorAll('input[name="f-relStatus"]').forEach(r => r.addEventListener('change', () => {
    document.getElementById('children-wrap').classList.toggle('hidden', document.querySelector('input[name="f-relStatus"]:checked')?.value !== 'Married');
  }));

  document.querySelectorAll('input[name="f-prevExp"]').forEach(r => r.addEventListener('change', () => {
    document.getElementById('prevexp-detail-wrap').classList.toggle('hidden', document.querySelector('input[name="f-prevExp"]:checked')?.value !== 'Yes');
  }));

  function wireUpload(boxId, inputId, previewId, storeKey, changedFlag, maxW, quality) {
    document.getElementById(boxId).onclick = () => document.getElementById(inputId).click();
    document.getElementById(inputId).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const dataUrl = await compressImage(file, maxW, quality);
        store[storeKey] = dataUrl;
        store[changedFlag] = true;
        const prev = document.getElementById(previewId);
        prev.src = dataUrl;
        prev.classList.remove('hidden');
      } catch(err) {
        toast('Image processing error.', true);
      }
    });
  }

  wireUpload('pic-box', 'f-picture', 'pic-preview', 'picture', '_pictureChanged', 500, 0.75);
  wireUpload('cnicf-box', 'f-cnicFront', 'cnicf-preview', 'cnicFront', '_cnicFrontChanged', 750, 0.65);
  wireUpload('cnicb-box', 'f-cnicBack', 'cnicb-preview', 'cnicBack', '_cnicBackChanged', 750, 0.65);
}

function collectFormData(existing) {
  const val = id => (document.getElementById(id) ? document.getElementById(id).value.trim() : '');
  const radio = name => document.querySelector(`input[name="${name}"]:checked`)?.value || '';
  const data = Object.assign({}, existing || {});
  data.position = val('f-position');
  data.salary = val('f-salary');
  data.fullName = val('f-fullName');
  data.fatherName = val('f-fatherName');
  data.dob = val('f-dob');
  data.cnic = val('f-cnic');
  data.gender = radio('f-gender');
  data.joiningDate = val('f-joiningDate');
  data.relationshipStatus = radio('f-relStatus');
  data.childrenCount = val('f-childrenCount');
  data.permanentAddress = val('f-permAddress');
  data.temporaryAddress = val('f-tempAddress');
  data.mobileNumber = val('f-mobileNumber');
  data.homeNumber = val('f-homeNumber');
  data.email = val('f-email');
  data.qualification = document.getElementById('f-qualification')?.value || '';
  data.qualificationDetail = val('f-qualificationDetail');
  data.previousExperience = radio('f-prevExp');
  data.prevExpDetail = val('f-prevExpDetail');
  data.prevSalary = val('f-prevSalary');
  data.prevReason = val('f-prevReason');
  return data;
}

function validateForm(data) {
  const missing = [];
  if (!data.position) missing.push('Position');
  if (!data.fullName) missing.push('Full Name');
  if (!data.dob) missing.push('Date of Birth');
  if (!data.cnic) missing.push('CNIC');
  if (!data.joiningDate) missing.push('Joining Date');
  if (!data.permanentAddress) missing.push('Permanent Address');
  if (!data.temporaryAddress) missing.push('Temporary Address');
  if (!data.mobileNumber) missing.push('Mobile Number');
  if (!data.homeNumber) missing.push('Home Number (Emergency Contact)');
  if (!data.qualification) missing.push('Qualification');
  if (data.qualification === 'Graduation Continue' && !data.qualificationDetail) missing.push('Qualification Detail');
  if (!data.previousExperience) missing.push('Previous Experience (Yes/No)');
  if (data.previousExperience === 'Yes') {
    if (!data.prevExpDetail) missing.push('Experience Detail');
    if (!data.prevSalary) missing.push('Previous Salary');
    if (!data.prevReason) missing.push('Reason for Leaving');
  }
  if (!data.picture) missing.push('Picture');
  if (!data.cnicFront) missing.push('CNIC Front');
  if (!data.cnicBack) missing.push('CNIC Back');
  return missing;
}

function renderNewEmployee() {
  const store = {};
  app.innerHTML = topbarHTML() + `
  <div id="main-wrap">
    <div class="section-title"><span class="back-link" id="back-dash">&larr; Dashboard</span></div>
    <h2 class="glow" style="margin:10px 0 4px;">New Employee Record</h2>
    <div class="stat-line">Fields with * are mandatory.</div>
    <div class="panel form-panel">
      ${formFieldsHTML({})}
      <div class="form-actions">
        <button class="btn" id="save-new-btn">Save Employee</button>
        <button class="btn cyan" id="cancel-new-btn">Cancel</button>
      </div>
    </div>
  </div>`;
  document.getElementById('logout-btn').onclick = logoutFlow;
  wireFormInteractions(store);
  document.getElementById('back-dash').onclick = () => { view = 'dashboard'; render(); };
  document.getElementById('cancel-new-btn').onclick = () => { view = 'dashboard'; render(); };
  document.getElementById('save-new-btn').onclick = async () => {
    const data = collectFormData(store);
    const missing = validateForm(data);
    if (missing.length) {
      toast('Required: ' + missing.join(', '), true);
      return;
    }
    const btn = document.getElementById('save-new-btn');
    btn.disabled = true;
    btn.textContent = 'Saving to Drive...';
    try {
      data.id = uid();
      data.status = 'current';
      const saved = await createEmployeeInDrive(data);
      currentEmployees.push(saved);
      toast('Employee saved successfully.');
      view = 'current';
      render();
    } catch(e) {
      toast('Failed to save record.', true);
      btn.disabled = false;
      btn.textContent = 'Save Employee';
    }
  };
}

function fileGridHTML(list, statusClass) {
  if (!list.length) return `<div class="empty-note panel">No records found.</div>`;
  return `<div class="file-grid">` + list.map(emp => `
    <div class="panel file-card" data-id="${esc(emp.id)}">
      ${emp.picture ? `<img class="file-thumb" src="${esc(emp.picture)}">` : `<div class="file-thumb placeholder">👤</div>`}
      <div class="file-name">${esc(emp.fullName || '(No name)')}</div>
      <div class="file-id">${esc(emp.cnic || emp.id)}</div>
      <div class="file-status ${statusClass}">${emp.status === 'current' ? 'Active' : esc(emp.exitType || 'Archived')}</div>
    </div>`).join('') + `</div>`;
}

function filterList(list, query) {
  if (!query) return list;
  const q = query.toLowerCase();
  return list.filter(e => (e.fullName || '').toLowerCase().includes(q) || (e.cnic || '').toLowerCase().includes(q));
}

function renderCurrentList() {
  const filtered = filterList(currentEmployees, searchQueryCurrent);
  app.innerHTML = topbarHTML() + `
  <div id="main-wrap">
    <div class="section-title"><span class="back-link" id="back-dash">&larr; Dashboard</span></div>
    <h2 class="glow" style="margin:10px 0 4px;">Current Employees (${currentEmployees.length})</h2>
    <div class="search-bar"><input id="search-current" placeholder="Search by name or CNIC..." value="${esc(searchQueryCurrent)}"></div>
    <div id="grid-wrap">${fileGridHTML(filtered, 'active')}</div>
  </div>`;
  document.getElementById('logout-btn').onclick = logoutFlow;
  document.getElementById('back-dash').onclick = () => { view = 'dashboard'; render(); };
  const searchInput = document.getElementById('search-current');
  searchInput.addEventListener('input', e => {
    searchQueryCurrent = e.target.value;
    document.getElementById('grid-wrap').innerHTML = fileGridHTML(filterList(currentEmployees, searchQueryCurrent), 'active');
    wireFileCardClicks('current');
  });
  wireFileCardClicks('current');
}

function renderResignedList() {
  const filtered = filterList(resignedEmployees, searchQueryResigned);
  app.innerHTML = topbarHTML() + `
  <div id="main-wrap">
    <div class="section-title"><span class="back-link" id="back-dash">&larr; Dashboard</span></div>
    <h2 class="glow" style="margin:10px 0 4px;">Resigned / Retired Archives (${resignedEmployees.length})</h2>
    <div class="search-bar"><input id="search-resigned" placeholder="Search by name or CNIC..." value="${esc(searchQueryResigned)}"></div>
    <div id="grid-wrap">${fileGridHTML(filtered, 'gone')}</div>
  </div>`;
  document.getElementById('logout-btn').onclick = logoutFlow;
  document.getElementById('back-dash').onclick = () => { view = 'dashboard'; render(); };
  const searchInput = document.getElementById('search-resigned');
  searchInput.addEventListener('input', e => {
    searchQueryResigned = e.target.value;
    document.getElementById('grid-wrap').innerHTML = fileGridHTML(filterList(resignedEmployees, searchQueryResigned), 'gone');
    wireFileCardClicks('resigned');
  });
  wireFileCardClicks('resigned');
}

function wireFileCardClicks(source) {
  document.querySelectorAll('.file-card').forEach(card => {
    card.onclick = () => openDetail(card.getAttribute('data-id'), source);
  });
}

function pfield(label, value) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  return `<div class="prow"><div class="plabel">${esc(label)}</div><div class="pvalue">${esc(value)}</div></div>`;
}

function buildPrintableHTML(emp) {
  let rows = '';
  rows += pfield('Position', emp.position);
  rows += pfield('Salary', emp.salary);
  rows += pfield('Full Name', emp.fullName);
  rows += pfield('Father Name', emp.fatherName);
  rows += pfield('Date of Birth', emp.dob);
  rows += pfield('CNIC', emp.cnic);
  rows += pfield('Gender', emp.gender);
  rows += pfield('Joining Date', emp.joiningDate);
  rows += pfield('Marital Status', emp.relationshipStatus);
  if (emp.relationshipStatus === 'Married') rows += pfield('Number of Children', emp.childrenCount);
  rows += pfield('Permanent Address', emp.permanentAddress);
  rows += pfield('Temporary Address', emp.temporaryAddress);
  rows += pfield('Mobile Number', emp.mobileNumber);
  rows += pfield('Emergency Contact', emp.homeNumber);
  rows += pfield('Email', emp.email);
  rows += pfield('Qualification', emp.qualification);
  if (emp.qualification === 'Graduation Continue') rows += pfield('Qualification Detail', emp.qualificationDetail);
  rows += pfield('Previous Experience', emp.previousExperience);
  if (emp.previousExperience === 'Yes') {
    rows += pfield('Experience Detail', emp.prevExpDetail);
    rows += pfield('Previous Salary', emp.prevSalary);
    rows += pfield('Reason for Leaving', emp.prevReason);
  }
  if (emp.status === 'resigned') {
    rows += pfield('Exit Type', emp.exitType);
    rows += pfield('Exit Date', emp.exitDate);
    rows += pfield('Exit Note', emp.exitNote);
  }
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(emp.fullName || 'Employee')} - Record</title>
  <style>
    body{ font-family: Arial, sans-serif; color:#111; padding:24px; }
    .phead{ display:flex; justify-content:space-between; align-items:flex-end; border-bottom:3px solid #00b057; padding-bottom:14px; margin-bottom:20px; }
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
      ${emp.picture ? `<img class="photo" src="${emp.picture}">` : ''}
      <div><div class="pname">${esc(emp.fullName || '')}</div><div class="pposition">${esc(emp.position || '')}</div></div>
    </div>
    <div class="pgrid">${rows}</div>
    <div class="pdocs">
      ${emp.cnicFront ? `<div><img src="${emp.cnicFront}"><div class="dlbl">CNIC Front</div></div>` : ''}
      ${emp.cnicBack ? `<div><img src="${emp.cnicBack}"><div class="dlbl">CNIC Back</div></div>` : ''}
    </div>
    <div class="pfooter">Confidential Employee Record &bull; OPTP System</div>
  </body></html>`;
}

async function openPrintableRecord(emp) {
  await loadAssetsForDetail(emp);
  const html = buildPrintableHTML(emp);
  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) {
    toast('Popup blocked by browser. Please allow popups.', true);
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  const triggerPrint = () => { try { w.focus(); w.print(); } catch(e) {} };
  w.onload = triggerPrint;
  setTimeout(triggerPrint, 400);
}

function detailRow(k, v) {
  return `<div class="detail-item"><div class="k">${esc(k)}</div><div class="v">${(v === undefined || v === '') ? '—' : esc(v)}</div></div>`;
}

async function openDetail(id, source) {
  const list = source === 'current' ? currentEmployees : resignedEmployees;
  const emp = list.find(e => e.id === id);
  if (!emp) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="panel modal-box">
      <span class="modal-close" id="detail-close">&times;</span>
      <div class="eyebrow">${source === 'current' ? 'ACTIVE FILE' : 'ARCHIVED FILE'}</div>
      <h2 class="glow" style="margin:6px 0 4px;">${esc(emp.fullName || '(No name)')}</h2>
      <div class="stat-line">${esc(emp.position || '')}</div>
      <div id="detail-doc-thumbs" class="doc-thumbs">
        <div>${emp.picture ? `<img src="${emp.picture}">` : ''}<div class="lbl">Picture</div></div>
        <div>${emp.cnicFront ? `<img src="${emp.cnicFront}">` : ''}<div class="lbl">CNIC Front</div></div>
        <div>${emp.cnicBack ? `<img src="${emp.cnicBack}">` : ''}<div class="lbl">CNIC Back</div></div>
      </div>
      <div class="detail-grid">
        ${detailRow('Position', emp.position)}
        ${detailRow('Salary', emp.salary)}
        ${detailRow('Full Name', emp.fullName)}
        ${detailRow('Father Name', emp.fatherName)}
        ${detailRow('DOB', emp.dob)}
        ${detailRow('CNIC', emp.cnic)}
        ${detailRow('Gender', emp.gender)}
        ${detailRow('Joining Date', emp.joiningDate)}
        ${detailRow('Marital Status', emp.relationshipStatus)}
        ${detailRow('Children', emp.childrenCount)}
        ${detailRow('Permanent Address', emp.permanentAddress)}
        ${detailRow('Temporary Address', emp.temporaryAddress)}
        ${detailRow('Mobile Number', emp.mobileNumber)}
        ${detailRow('Emergency Contact', emp.homeNumber)}
        ${detailRow('Email', emp.email)}
        ${detailRow('Qualification', emp.qualification)}
        ${detailRow('Qualification Detail', emp.qualificationDetail)}
        ${detailRow('Previous Experience', emp.previousExperience)}
        ${detailRow('Experience Detail', emp.prevExpDetail)}
        ${detailRow('Previous Salary', emp.prevSalary)}
        ${detailRow('Reason for Leaving', emp.prevReason)}
        ${source === 'resigned' ? detailRow('Exit Type', emp.exitType) : ''}
        ${source === 'resigned' ? detailRow('Exit Date', emp.exitDate) : ''}
        ${source === 'resigned' ? detailRow('Exit Note', emp.exitNote) : ''}
      </div>
      <div class="modal-actions">
        <button class="btn cyan" id="print-btn">Print</button>
        <button class="btn cyan" id="pdf-btn">Save as PDF</button>
        <button class="btn cyan" id="edit-btn">Edit Record</button>
        ${source === 'current' ? `<button class="btn amber" id="resign-btn">Mark Resigned / Retired</button>` : `<button class="btn amber" id="reactivate-btn">Reactivate to Current</button>`}
        <button class="btn red" id="delete-btn">Delete Record</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  document.getElementById('detail-close').onclick = () => overlay.remove();
  document.getElementById('print-btn').onclick = () => askPassword('Enter password to print record', () => openPrintableRecord(emp));
  document.getElementById('pdf-btn').onclick = () => askPassword('Enter password to save as PDF', () => openPrintableRecord(emp));
  document.getElementById('edit-btn').onclick = () => askPassword('Enter password to edit record', async () => { overlay.remove(); await openEditForm(emp, source); });
  document.getElementById('delete-btn').onclick = () => askPassword('Enter password to delete record', () => {
    if (!confirm('This will move "' + (emp.fullName || 'this record') + '" to Google Drive Trash. Continue?')) return;
    trashFolder(emp.folderId).then(() => {
      const arr = source === 'current' ? currentEmployees : resignedEmployees;
      const idx = arr.findIndex(e => e.id === id);
      if (idx > -1) arr.splice(idx, 1);
      overlay.remove();
      toast('Record moved to Drive Trash.');
      render();
    }).catch(() => toast('Delete failed.', true));
  });

  if (source === 'current') {
    document.getElementById('resign-btn').onclick = () => askPassword('Enter password to change status', () => { overlay.remove(); openResignDialog(emp); });
  } else {
    document.getElementById('reactivate-btn').onclick = () => askPassword('Enter password to reactivate', async () => {
      try {
        await moveFolder(emp.folderId, resignedFolderId, currentFolderId);
        const idx = resignedEmployees.findIndex(e => e.id === id);
        if (idx > -1) {
          const [moved] = resignedEmployees.splice(idx, 1);
          moved.status = 'current';
          delete moved.exitType;
          delete moved.exitDate;
          delete moved.exitNote;
          await updateFileContent(moved.profileFileId, 'application/json', JSON.stringify(profileCopyOf(moved)), true);
          currentEmployees.push(moved);
        }
        overlay.remove();
        toast('Employee reactivated to Current.');
        view = 'current';
        render();
      } catch(e) {
        toast('Reactivation failed.', true);
      }
    });
  }

  // Load CNIC assets in background
  if (!emp.cnicFront || !emp.cnicBack) {
    loadAssetsForDetail(emp).then(() => {
      const thumbs = document.getElementById('detail-doc-thumbs');
      if (thumbs) {
        thumbs.innerHTML = `
          <div>${emp.picture ? `<img src="${emp.picture}">` : ''}<div class="lbl">Picture</div></div>
          <div>${emp.cnicFront ? `<img src="${emp.cnicFront}">` : ''}<div class="lbl">CNIC Front</div></div>
          <div>${emp.cnicBack ? `<img src="${emp.cnicBack}">` : ''}<div class="lbl">CNIC Back</div></div>`;
      }
    });
  }
}

function openResignDialog(emp) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="panel pw-modal-box" style="max-width:420px;text-align:left;">
      <div class="eyebrow">STATUS CHANGE</div>
      <h3 style="margin:8px 0 16px;">${esc(emp.fullName)}</h3>
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
  overlay.querySelector('#exit-cancel').onclick = () => overlay.remove();
  const exitDateEl = overlay.querySelector('#exit-date');
  exitDateEl.addEventListener('click', () => {
    if (typeof exitDateEl.showPicker === 'function') {
      try { exitDateEl.showPicker(); } catch(e) {}
    }
  });
  overlay.querySelector('#exit-confirm').onclick = async () => {
    const type = overlay.querySelector('input[name="exit-type"]:checked').value;
    const date = overlay.querySelector('#exit-date').value.trim();
    const note = overlay.querySelector('#exit-note').value.trim();
    const btn = overlay.querySelector('#exit-confirm');
    btn.disabled = true;
    btn.textContent = 'Updating...';
    try {
      await moveFolder(emp.folderId, currentFolderId, resignedFolderId);
      const idx = currentEmployees.findIndex(e => e.id === emp.id);
      if (idx > -1) {
        const [moved] = currentEmployees.splice(idx, 1);
        moved.status = 'resigned';
        moved.exitType = type;
        moved.exitDate = date;
        moved.exitNote = note;
        await updateFileContent(moved.profileFileId, 'application/json', JSON.stringify(profileCopyOf(moved)), true);
        resignedEmployees.push(moved);
      }
      overlay.remove();
      toast(emp.fullName + ' moved to Resigned/Retired.');
      view = 'resigned';
      render();
    } catch(e) {
      toast('Status update failed.', true);
      btn.disabled = false;
      btn.textContent = 'Confirm';
    }
  };
}

async function openEditForm(emp, source) {
  await loadAssetsForDetail(emp);
  const store = Object.assign({}, emp);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="panel modal-box">
      <span class="modal-close" id="edit-close">&times;</span>
      <div class="eyebrow">EDIT RECORD</div>
      <h2 class="glow" style="margin:6px 0 16px;">${esc(emp.fullName || '(No name)')}</h2>
      ${formFieldsHTML(emp)}
      <div class="form-actions">
        <button class="btn" id="save-edit-btn">Save Changes</button>
        <button class="btn cyan" id="cancel-edit-btn">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  wireFormInteractions(store);
  overlay.querySelector('#edit-close').onclick = () => overlay.remove();
  overlay.querySelector('#cancel-edit-btn').onclick = () => overlay.remove();
  overlay.querySelector('#save-edit-btn').onclick = async () => {
    const data = collectFormData(store);
    const missing = validateForm(data);
    if (missing.length) {
      toast('Required: ' + missing.join(', '), true);
      return;
    }
    data.id = emp.id;
    data.status = emp.status;
    data.folderId = emp.folderId;
    data.profileFileId = emp.profileFileId;
    data.pictureFileId = emp.pictureFileId;
    data.cnicFrontFileId = emp.cnicFrontFileId;
    data.cnicBackFileId = emp.cnicBackFileId;
    if (source === 'resigned') {
      data.exitType = emp.exitType;
      data.exitDate = emp.exitDate;
      data.exitNote = emp.exitNote;
    }
    const btn = overlay.querySelector('#save-edit-btn');
    btn.disabled = true;
    btn.textContent = 'Saving Changes...';
    try {
      await updateEmployeeInDrive(data);
      const arr = source === 'current' ? currentEmployees : resignedEmployees;
      const idx = arr.findIndex(e => e.id === emp.id);
      if (idx > -1) arr[idx] = data;
      overlay.remove();
      toast('Record updated on Drive.');
      render();
    } catch(e) {
      toast('Update failed.', true);
      btn.disabled = false;
      btn.textContent = 'Save Changes';
    }
  };
}

function render(loadingMsg) {
  if (view === 'pinlock') renderPinLock();
  else if (view === 'login') renderLogin();
  else if (view === 'loading') renderLoading(loadingMsg);
  else if (view === 'dashboard') renderDashboard();
  else if (view === 'new') renderNewEmployee();
  else if (view === 'current') renderCurrentList();
  else if (view === 'resigned') renderResignedList();
}
render();
