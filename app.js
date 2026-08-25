const CONFIG = {
  CLIENT_ID: "936109847577-ajbaefe746dalhe6vn7ae0u2pdl26sds.apps.googleusercontent.com",
  SCOPES: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email",
  AUTHORIZED_EMAILS: ["shahzaibafzalsa3697559@gmail.com", "optpscheme3@gmail.com"],
  SESSION_KEY: "optp_session_active"
};

let tokenClient = null;
let userEmail = null;
let rootFolderId, currentFolderId, resignedFolderId;
let currentEmployees = [];
let resignedEmployees = [];
let view = "login";
let searchQueryCurrent = "";
let searchQueryResigned = "";
let activeModalToken = 0;

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

function isAuthorizedEmail(email) {
  if (!CONFIG.AUTHORIZED_EMAILS.length) return true;
  const normalized = String(email || '').trim().toLowerCase();
  return CONFIG.AUTHORIZED_EMAILS.some(x => String(x).trim().toLowerCase() === normalized);
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

function initGis() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: async (resp) => {
      if (resp.error) {
        toast('Login failed: ' + resp.error, true);
        view = 'login';
        render();
        return;
      }
      DriveAPI.setToken(resp.access_token);
      await afterLogin();
    }
  });
}

window.addEventListener('load', () => {
  const check = setInterval(() => {
    if (window.google?.accounts?.oauth2) {
      clearInterval(check);
      initGis();
      view = 'login';
      render();
    }
  }, 100);
});

async function afterLogin() {
  view = 'loading';
  render('Verifying Google account...');
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + DriveAPI.token }
    });
    if (!res.ok) {
      view = 'login';
      render();
      toast('Google verification failed.', true);
      return;
    }
    const info = await res.json();
    const email = String(info.email || '').trim().toLowerCase();
    if (!email || !isAuthorizedEmail(email)) {
      view = 'login';
      render();
      toast('This Google account is not authorized.', true);
      return;
    }
    userEmail = email;
    view = 'loading';
    render('Setting up Storage Folders...');
    await setupDriveStructure();
    view = 'loading';
    render('Loading employee records...');
    await loadAllFromDrive();
    view = 'dashboard';
    render();
  } catch (e) {
    toast('Error connecting to Drive.', true);
    view = 'login';
    render();
  }
}

async function setupDriveStructure() {
  rootFolderId = await DriveAPI.findOrCreateFolder('OPTP Employee Record', 'root');
  currentFolderId = await DriveAPI.findOrCreateFolder('Current Employees', rootFolderId);
  resignedFolderId = await DriveAPI.findOrCreateFolder('Resigned or Retired Employees', rootFolderId);
}

async function loadEmployeesFromFolder(parentId) {
  const items = await DriveAPI.listChildren(parentId);
  const folders = items.filter(f => f.mimeType === 'application/vnd.google-apps.folder');

  return Promise.all(folders.map(async (folder) => {
    const children = await DriveAPI.listChildren(folder.id);
    const profileFile = children.find(f => f.name === 'profile.json');
    const pictureFile = children.find(f => f.name === 'picture.jpg');
    const cnicFrontFile = children.find(f => f.name === 'cnic_front.jpg');
    const cnicBackFile = children.find(f => f.name === 'cnic_back.jpg');

    let data = {};
    if (profileFile) {
      try { data = JSON.parse(await DriveAPI.getFileText(profileFile.id)); } catch(e) {}
    }
    data.folderId = folder.id;
    data.profileFileId = profileFile ? profileFile.id : null;
    data.pictureFileId = pictureFile ? pictureFile.id : null;
    data.cnicFrontFileId = cnicFrontFile ? cnicFrontFile.id : null;
    data.cnicBackFileId = cnicBackFile ? cnicBackFile.id : null;

    if (pictureFile) {
      try { data.picture = await DriveAPI.getFileDataUrl(pictureFile.id); } catch(e) {}
    }
    if (!data.id) data.id = folder.id;
    return data;
  }));
}

async function loadAllFromDrive() {
  currentEmployees = await loadEmployeesFromFolder(currentFolderId);
  resignedEmployees = await loadEmployeesFromFolder(resignedFolderId);
}

async function loadFullEmployeeAssets(emp) {
  if (emp.pictureFileId && !emp.picture) {
    try { emp.picture = await DriveAPI.getFileDataUrl(emp.pictureFileId); } catch(e) {}
  }
  if (emp.cnicFrontFileId && !emp.cnicFront) {
    try { emp.cnicFront = await DriveAPI.getFileDataUrl(emp.cnicFrontFileId); } catch(e) {}
  }
  if (emp.cnicBackFileId && !emp.cnicBack) {
    try { emp.cnicBack = await DriveAPI.getFileDataUrl(emp.cnicBackFileId); } catch(e) {}
  }
  return emp;
}

function folderNameFor(data) {
  return (data.fullName || 'Unnamed') + ' - ' + (data.cnic || data.id);
}

function profileCopyOf(data) {
  const c = Object.assign({}, data);
  delete c.picture;
  delete c.cnicFront;
  delete c.cnicBack;
  delete c._pictureChanged;
  delete c._cnicFrontChanged;
  delete c._cnicBackChanged;
  return c;
}

async function createEmployeeInDrive(data) {
  const folderId = await DriveAPI.createFolder(folderNameFor(data), currentFolderId);
  data.folderId = folderId;
  data.profileFileId = await DriveAPI.uploadFile('profile.json', 'application/json', folderId, JSON.stringify(profileCopyOf(data)), true);
  if (data.picture) data.pictureFileId = await DriveAPI.uploadFile('picture.jpg', 'image/jpeg', folderId, data.picture, false);
  if (data.cnicFront) data.cnicFrontFileId = await DriveAPI.uploadFile('cnic_front.jpg', 'image/jpeg', folderId, data.cnicFront, false);
  if (data.cnicBack) data.cnicBackFileId = await DriveAPI.uploadFile('cnic_back.jpg', 'image/jpeg', folderId, data.cnicBack, false);
  return data;
}

async function updateEmployeeInDrive(data) {
  await DriveAPI.renameFile(data.folderId, folderNameFor(data));
  if (data.profileFileId) await DriveAPI.updateFile(data.profileFileId, 'application/json', JSON.stringify(profileCopyOf(data)), true);
  else data.profileFileId = await DriveAPI.uploadFile('profile.json', 'application/json', data.folderId, JSON.stringify(profileCopyOf(data)), true);

  if (data._pictureChanged && data.picture) {
    if (data.pictureFileId) await DriveAPI.updateFile(data.pictureFileId, 'image/jpeg', data.picture, false);
    else data.pictureFileId = await DriveAPI.uploadFile('picture.jpg', 'image/jpeg', data.folderId, data.picture, false);
  }
  if (data._cnicFrontChanged && data.cnicFront) {
    if (data.cnicFrontFileId) await DriveAPI.updateFile(data.cnicFrontFileId, 'image/jpeg', data.cnicFront, false);
    else data.cnicFrontFileId = await DriveAPI.uploadFile('cnic_front.jpg', 'image/jpeg', data.folderId, data.cnicFront, false);
  }
  if (data._cnicBackChanged && data.cnicBack) {
    if (data.cnicBackFileId) await DriveAPI.updateFile(data.cnicBackFileId, 'image/jpeg', data.cnicBack, false);
    else data.cnicBackFileId = await DriveAPI.uploadFile('cnic_back.jpg', 'image/jpeg', data.folderId, data.cnicBack, false);
  }
  delete data._pictureChanged;
  delete data._cnicFrontChanged;
  delete data._cnicBackChanged;
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

function renderLogin() {
  app.innerHTML = `
    <div id="login-screen">
      <div class="eyebrow" style="text-align:center;">OPTP SCH III // AUTHENTICATION</div>
      <h1 class="glow" style="text-align:center;font-size:24px;margin:8px 0 26px;">EMPLOYEE RECORD SYSTEM<span class="term-cursor"></span></h1>
      <div class="panel login-box">
        <div class="stat-line" style="font-size:13px;margin-bottom:10px;">Sign in with authorized Google Workspace account.</div>
        <div class="gsi-btn-wrap">
          <button class="btn" id="google-login-btn" style="padding:12px 26px;">Sign in with Google</button>
        </div>
      </div>
    </div>`;
  document.getElementById('google-login-btn').onclick = () => tokenClient?.requestAccessToken({ prompt: 'consent' });
}

function renderLoading(msg) {
  app.innerHTML = `
    <div id="loading-screen">
      <div class="eyebrow">SYSTEM ACCESS</div>
      <div class="spinner"></div>
      <div class="stat-line" style="font-size:13px;">${esc(msg || 'Loading...')}</div>
    </div>`;
}

function renderDashboard() {
  app.innerHTML = topbarHTML() + `
  <div id="main-wrap">
    <div class="dash-grid">
      <div class="panel dash-card" id="card-current">
        <div class="icon">&#128194;</div><div class="lbl">Current Employees</div>
        <div class="count">${currentEmployees.length}</div>
        <div class="stat-line">Active staff members</div>
      </div>
      <div class="panel dash-card" id="card-new">
        <div class="icon">&#10133;</div><div class="lbl">New Employee</div>
        <div class="count">+</div>
        <div class="stat-line">Create employee file</div>
      </div>
      <div class="panel dash-card" id="card-resigned">
        <div class="icon">&#128193;</div><div class="lbl">Resigned / Retired</div>
        <div class="count">${resignedEmployees.length}</div>
        <div class="stat-line">Archived staff files</div>
      </div>
    </div>
  </div>`;
  document.getElementById('logout-btn').onclick = () => { DriveAPI.setToken(null); view = 'login'; render(); };
  document.getElementById('card-current').onclick = () => { view = 'current'; render(); };
  document.getElementById('card-new').onclick = () => { view = 'new'; render(); };
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
    cnicInput.addEventListener('input', () => {
      cnicInput.value = formatCNIC(cnicInput.value);
    });
  }

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
  document.getElementById('logout-btn').onclick = () => { DriveAPI.setToken(null); view = 'login'; render(); };
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
      ${emp.picture ? `<img class="file-thumb" src="${esc(emp.picture)}">` : `<div class="file-thumb placeholder">&#128100;</div>`}
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
  document.getElementById('logout-btn').onclick = () => { DriveAPI.setToken(null); view = 'login'; render(); };
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
  document.getElementById('logout-btn').onclick = () => { DriveAPI.setToken(null); view = 'login'; render(); };
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
    .phead{ display:flex; justify-content:space-between; align-items:flex-end; border-bottom:3px solid #1c8a52; padding-bottom:14px; margin-bottom:20px; }
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
  await loadFullEmployeeAssets(emp);
  const html = buildPrintableHTML(emp);
  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) { toast('Popup blocked by browser.', true); return; }
  w.document.open(); 
  w.document.write(html); 
  w.document.close();

  const triggerPrint = async () => {
    try {
      const imgs = Array.from(w.document.images);
      await Promise.all(imgs.map(img => {
        if (img.complete) return Promise.resolve();
        return new Promise(resolve => { img.onload = resolve; img.onerror = resolve; });
      }));
      w.focus();
      w.print();
    } catch(e) {
      w.focus();
      w.print();
    }
  };

  if (w.document.readyState === 'complete') triggerPrint();
  else w.onload = triggerPrint;
}

async function downloadEmployeePDF(emp) {
  try {
    toast('Generating PDF document...');
    await loadFullEmployeeAssets(emp);
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;top:0;left:0;width:794px;background:#ffffff;color:#111111;opacity:0;pointer-events:none;z-index:-999;';

    const printable = buildPrintableHTML(emp);
    const styleMatch = printable.match(/<style>([\s\S]*?)<\/style>/i);
    const bodyMatch = printable.match(/<body>([\s\S]*?)<\/body>/i);
    const style = styleMatch ? `<style>${styleMatch[1]}</style>` : '';
    const body = bodyMatch ? bodyMatch[1] : printable;

    holder.innerHTML = style + `<div class="pdf-page-content" style="padding:24px;background:#fff;">${body}</div>`;
    document.body.appendChild(holder);

    const imgs = Array.from(holder.querySelectorAll('img'));
    await Promise.all(imgs.map(img => {
      if (img.complete) return Promise.resolve();
      return new Promise(resolve => { img.onload = resolve; img.onerror = resolve; });
    }));

    const canvas = await html2canvas(holder, {scale:2, useCORS:true, backgroundColor:'#ffffff', logging:false});
    holder.remove();

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p','mm','a4');
    const pageW = 210, pageH = 297, margin = 8;
    const imgW = pageW - margin*2;
    const pxPerPage = Math.floor(canvas.width * ((pageH-margin*2) / imgW));
    let y = 0, page = 0;

    while (y < canvas.height) {
      const sliceH = Math.min(pxPerPage, canvas.height-y);
      const slice = document.createElement('canvas'); 
      slice.width = canvas.width; 
      slice.height = sliceH;
      slice.getContext('2d').drawImage(canvas,0,y,canvas.width,sliceH,0,0,canvas.width,sliceH);
      const img = slice.toDataURL('image/jpeg',0.92);
      const imgH = sliceH * imgW / canvas.width;
      if (page > 0) pdf.addPage();
      pdf.addImage(img,'JPEG',margin,margin,imgW,imgH);
      y += sliceH; 
      page++;
    }
    const safeName = (emp.fullName || 'Employee_Record').replace(/[^a-z0-9_-]+/gi,'_');
    pdf.save(`${safeName}_Record.pdf`);
    toast('PDF downloaded successfully.');
  } catch(e) {
    toast('PDF generation failed. Use Print as fallback.', true);
  }
}

function detailRow(k, v) {
  return `<div class="detail-item"><div class="k">${esc(k)}</div><div class="v">${(v === undefined || v === '') ? '—' : esc(v)}</div></div>`;
}

async function openDetail(id, source) {
  const currentModalToken = ++activeModalToken;
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
      <div id="detail-assets" class="doc-thumbs">
        <div class="empty-note" style="padding:10px;">Loading documents...</div>
      </div>
      <div class="detail-grid" id="detail-fields"></div>
      <div class="modal-actions">
        <button class="btn cyan" id="print-btn">Print</button>
        <button class="btn cyan" id="pdf-btn">Save PDF</button>
        <button class="btn cyan" id="edit-btn">Edit</button>
        ${source === 'current' ? `<button class="btn amber" id="resign-btn">Mark Resigned</button>` : `<button class="btn amber" id="reactivate-btn">Reactivate</button>`}
        <button class="btn red" id="delete-btn">Delete</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#detail-close').onclick = () => overlay.remove();

  const fields = [
    ['Position',emp.position],['Salary',emp.salary],['Full Name',emp.fullName],
    ['Father Name',emp.fatherName],['DOB',emp.dob],['CNIC',emp.cnic],
    ['Gender',emp.gender],['Joining Date',emp.joiningDate],['Marital Status',emp.relationshipStatus],
    ['Children',emp.childrenCount],['Permanent Address',emp.permanentAddress],['Temporary Address',emp.temporaryAddress],
    ['Mobile Number',emp.mobileNumber],['Emergency Contact',emp.homeNumber],['Email',emp.email],
    ['Qualification',emp.qualification],['Qualification Detail',emp.qualificationDetail],
    ['Previous Experience',emp.previousExperience],['Experience Detail',emp.prevExpDetail],
    ['Previous Salary',emp.prevSalary],['Reason for Leaving',emp.prevReason]
  ];
  if (source === 'resigned') fields.push(['Exit Type',emp.exitType],['Exit Date',emp.exitDate],['Exit Note',emp.exitNote]);
  overlay.querySelector('#detail-fields').innerHTML = fields.map(([k,v]) => detailRow(k,v)).join('');

  try {
    await loadFullEmployeeAssets(emp);
    if (activeModalToken !== currentModalToken || !document.body.contains(overlay)) return;
    overlay.querySelector('#detail-assets').innerHTML = `
      <div>${emp.picture ? `<img src="${esc(emp.picture)}">` : ''}<div class="lbl">Picture</div></div>
      <div>${emp.cnicFront ? `<img src="${esc(emp.cnicFront)}">` : ''}<div class="lbl">CNIC Front</div></div>
      <div>${emp.cnicBack ? `<img src="${esc(emp.cnicBack)}">` : ''}<div class="lbl">CNIC Back</div></div>`;
  } catch(e) {
    if (activeModalToken === currentModalToken && document.body.contains(overlay)) {
      overlay.querySelector('#detail-assets').innerHTML = `<div class="empty-note" style="padding:10px;">Some documents could not be loaded.</div>`;
    }
  }

  overlay.querySelector('#print-btn').onclick = () => openPrintableRecord(emp);
  overlay.querySelector('#pdf-btn').onclick = () => downloadEmployeePDF(emp);
  overlay.querySelector('#edit-btn').onclick = async () => { overlay.remove(); await openEditForm(emp, source); };
  overlay.querySelector('#delete-btn').onclick = async () => {
    if (!confirm(`Move "${emp.fullName || 'this file'}" to Google Drive Trash?`)) return;
    try {
      await DriveAPI.trashFolder(emp.folderId);
      const arr = source === 'current' ? currentEmployees : resignedEmployees;
      const idx = arr.findIndex(e => e.id === id);
      if (idx > -1) arr.splice(idx,1);
      overlay.remove();
      toast('Moved to Drive Trash.');
      render();
    } catch(e) {
      toast('Delete request failed.', true);
    }
  };

  if (source === 'current') {
    overlay.querySelector('#resign-btn').onclick = () => { overlay.remove(); openResignDialog(emp); };
  } else {
    overlay.querySelector('#reactivate-btn').onclick = async () => {
      try {
        await DriveAPI.moveFolder(emp.folderId, resignedFolderId, currentFolderId);
        const idx = resignedEmployees.findIndex(e => e.id === id);
        if (idx > -1) {
          const [moved] = resignedEmployees.splice(idx,1);
          moved.status='current'; delete moved.exitType; delete moved.exitDate; delete moved.exitNote;
          await DriveAPI.updateFile(moved.profileFileId, 'application/json', JSON.stringify(profileCopyOf(moved)), true);
          currentEmployees.push(moved);
        }
        overlay.remove();
        toast('Employee reactivated.');
        view='current';
        render();
      } catch(e) {
        toast('Reactivation failed.', true);
      }
    };
  }
}

function openResignDialog(emp) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="panel pw-modal-box" style="max-width:420px;text-align:left;">
      <div class="eyebrow">STATUS CHANGE</div>
      <h3 style="margin:8px 0 16px;">${esc(emp.fullName)}</h3>
      <div class="field"><label>Status Type</label>
        <div class="radio-group">
          <label class="radio-opt"><input type="radio" name="exit-type" value="Resigned" checked> Resigned</label>
          <label class="radio-opt"><input type="radio" name="exit-type" value="Retired"> Retired</label>
        </div>
      </div>
      <div class="field"><label>Exit Date</label><input type="date" id="exit-date"></div>
      <div class="field"><label>Remarks</label><textarea id="exit-note" rows="2"></textarea></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn cyan" id="exit-cancel">Cancel</button>
        <button class="btn amber" id="exit-confirm">Confirm</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#exit-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#exit-confirm').onclick = async () => {
    const type = overlay.querySelector('input[name="exit-type"]:checked').value;
    const date = overlay.querySelector('#exit-date').value.trim();
    const note = overlay.querySelector('#exit-note').value.trim();
    const btn = overlay.querySelector('#exit-confirm');
    btn.disabled = true;
    btn.textContent = 'Updating...';
    try {
      await DriveAPI.moveFolder(emp.folderId, currentFolderId, resignedFolderId);
      const idx = currentEmployees.findIndex(e => e.id === emp.id);
      if (idx > -1) {
        const [moved] = currentEmployees.splice(idx, 1);
        moved.status = 'resigned';
        moved.exitType = type;
        moved.exitDate = date;
        moved.exitNote = note;
        await DriveAPI.updateFile(moved.profileFileId, 'application/json', JSON.stringify(profileCopyOf(moved)), true);
        resignedEmployees.push(moved);
      }
      overlay.remove();
      toast('Status updated.');
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
  try { await loadFullEmployeeAssets(emp); } catch(e) {}
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
      toast('Changes saved to Drive.');
      render();
    } catch(e) {
      toast('Failed to update file.', true);
      btn.disabled = false;
      btn.textContent = 'Save Changes';
    }
  };
}

function render(loadingMsg) {
  if (view === 'login') renderLogin();
  else if (view === 'loading') renderLoading(loadingMsg);
  else if (view === 'dashboard') renderDashboard();
  else if (view === 'new') renderNewEmployee();
  else if (view === 'current') renderCurrentList();
  else if (view === 'resigned') renderResignedList();
}
render();
