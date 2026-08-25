/**
 * Main Portal Script
 */

const CONFIG = {
  CLIENT_ID: "936109847577-ajbaefe746dalhe6vn7ae0u2pdl26sds.apps.googleusercontent.com",
  SCOPES: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email",
  AUTHORIZED_EMAILS: ["shahzaibafzalsa3697559@gmail.com", "optpscheme3@gmail.com"],
  STORAGE_KEY: "optp_user_session"
};

const State = {
  userEmail: null,
  activeView: "login",
  folders: { root: null, current: null, resigned: null },
  employees: { current: [], resigned: [] },
  search: { current: "", resigned: "" },
  tokenClient: null
};

// --- DOM & Helpers ---
const app = document.getElementById("app");

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showToast(message, isError = false) {
  const container = document.getElementById("toast-container");
  const t = document.createElement("div");
  t.className = `toast ${isError ? "error" : ""}`;
  t.textContent = message;
  container.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function sanitizeCnic(val) {
  const digits = val.replace(/\D/g, "").slice(0, 13);
  if (digits.length > 12) return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
  if (digits.length > 5) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return digits;
}

// --- Authentication ---
function initAuthClient() {
  State.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: async (resp) => {
      if (resp.error) {
        showToast(`Login failed: ${resp.error}`, true);
        return;
      }
      StorageService.setToken(resp.access_token);
      await handlePostLogin();
    }
  });
}

async function handlePostLogin() {
  setView("loading", "Verifying access permissions...");
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${StorageService.token}` }
    });
    const info = await res.json();
    const email = (info.email || "").toLowerCase().trim();

    if (CONFIG.AUTHORIZED_EMAILS.length && !CONFIG.AUTHORIZED_EMAILS.includes(email)) {
      showToast("Unauthorized Google Account.", true);
      logout();
      return;
    }

    State.userEmail = email;
    sessionStorage.setItem(CONFIG.STORAGE_KEY, email);

    setView("loading", "Initializing Google Drive storage...");
    await initDirectories();
    
    setView("loading", "Loading employee directory...");
    await loadEmployees();

    setView("dashboard");
  } catch (e) {
    console.error(e);
    showToast("Failed to initialize Google Drive connection.", true);
    setView("login");
  }
}

async function initDirectories() {
  State.folders.root = await StorageService.ensureFolder("OPTP Employee Record");
  State.folders.current = await StorageService.ensureFolder("Current Employees", State.folders.root);
  State.folders.resigned = await StorageService.ensureFolder("Resigned or Retired Employees", State.folders.root);
}

async function loadFolderEmployees(folderId) {
  const folders = await StorageService.listFolderChildren(folderId);
  const employeeFolders = folders.filter(f => f.mimeType === "application/vnd.google-apps.folder");

  return Promise.all(employeeFolders.map(async (folder) => {
    const files = await StorageService.listFolderChildren(folder.id);
    const profileFile = files.find(f => f.name === "profile.json");
    let record = {};

    if (profileFile) {
      try {
        const text = await StorageService.readText(profileFile.id);
        record = JSON.parse(text);
      } catch (err) {
        console.warn("Corrupt profile:", folder.id);
      }
    }

    record.id = record.id || folder.id;
    record.folderId = folder.id;
    record.profileFileId = profileFile ? profileFile.id : null;
    record.pictureFileId = files.find(f => f.name === "picture.jpg")?.id || null;
    record.cnicFrontFileId = files.find(f => f.name === "cnic_front.jpg")?.id || null;
    record.cnicBackFileId = files.find(f => f.name === "cnic_back.jpg")?.id || null;

    return record;
  }));
}

async function loadEmployees() {
  State.employees.current = await loadFolderEmployees(State.folders.current);
  State.employees.resigned = await loadFolderEmployees(State.folders.resigned);
}

function logout() {
  sessionStorage.removeItem(CONFIG.STORAGE_KEY);
  StorageService.setToken(null);
  State.userEmail = null;
  State.employees = { current: [], resigned: [] };
  setView("login");
  showToast("Logged out successfully.");
}

// --- PDF & Print Generators ---
function createPrintTemplate(emp) {
  const row = (label, val) => val ? `<div style="padding:6px 0;border-bottom:1px solid #e2e8f0;"><div style="font-size:10px;text-transform:uppercase;color:#64748b;">${escapeHtml(label)}</div><div style="font-size:13px;color:#0f172a;margin-top:2px;">${escapeHtml(val)}</div></div>` : "";

  return `
    <div id="print-sheet" style="font-family:Arial,sans-serif;padding:24px;background:#fff;color:#111;">
      <div style="border-bottom:2px solid #10b981;padding-bottom:10px;margin-bottom:16px;">
        <h2 style="margin:0;font-size:18px;">OPTP Scheme III</h2>
        <div style="font-size:12px;color:#64748b;">Confidential Employee Record</div>
      </div>
      <div style="display:flex;gap:16px;margin-bottom:16px;align-items:center;">
        ${emp.picture ? `<img src="${emp.picture}" style="width:90px;height:90px;object-fit:cover;border:1px solid #cbd5e1;border-radius:4px;">` : ""}
        <div>
          <h3 style="margin:0;font-size:16px;">${escapeHtml(emp.fullName || "Staff Member")}</h3>
          <div style="font-size:13px;color:#64748b;">${escapeHtml(emp.position || "")}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 20px;">
        ${row("Position", emp.position)}
        ${row("Salary", emp.salary)}
        ${row("Full Name", emp.fullName)}
        ${row("Father Name", emp.fatherName)}
        ${row("Date of Birth", emp.dob)}
        ${row("CNIC", emp.cnic)}
        ${row("Gender", emp.gender)}
        ${row("Joining Date", emp.joiningDate)}
        ${row("Marital Status", emp.relationshipStatus)}
        ${row("Children", emp.childrenCount)}
        ${row("Permanent Address", emp.permanentAddress)}
        ${row("Temporary Address", emp.temporaryAddress)}
        ${row("Mobile Number", emp.mobileNumber)}
        ${row("Emergency Contact", emp.homeNumber)}
        ${row("Email", emp.email)}
        ${row("Qualification", emp.qualification)}
        ${row("Education Detail", emp.qualificationDetail)}
        ${row("Experience Details", emp.prevExpDetail)}
        ${row("Previous Salary", emp.prevSalary)}
        ${row("Reason for Leaving", emp.prevReason)}
      </div>
      <div style="display:flex;gap:16px;margin-top:20px;">
        ${emp.cnicFront ? `<div><img src="${emp.cnicFront}" style="width:160px;height:100px;object-fit:cover;border:1px solid #cbd5e1;border-radius:4px;"><div style="font-size:10px;text-align:center;color:#64748b;margin-top:2px;">CNIC Front</div></div>` : ""}
        ${emp.cnicBack ? `<div><img src="${emp.cnicBack}" style="width:160px;height:100px;object-fit:cover;border:1px solid #cbd5e1;border-radius:4px;"><div style="font-size:10px;text-align:center;color:#64748b;margin-top:2px;">CNIC Back</div></div>` : ""}
      </div>
    </div>`;
}

async function exportRecordAsPdf(emp) {
  showToast("Preparing document for download...");
  await loadAttachments(emp);

  const wrapper = document.createElement("div");
  wrapper.style.cssText = "position:fixed;top:0;left:0;width:794px;background:#fff;opacity:0;pointer-events:none;z-index:-999;";
  wrapper.innerHTML = createPrintTemplate(emp);
  document.body.appendChild(wrapper);

  // Wait for images
  const imgs = Array.from(wrapper.querySelectorAll("img"));
  await Promise.all(imgs.map(i => i.complete ? Promise.resolve() : new Promise(r => { i.onload = r; i.onerror = r; })));

  const canvas = await html2canvas(wrapper, { scale: 2, useCORS: true, backgroundColor: "#ffffff" });
  wrapper.remove();

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF("p", "mm", "a4");
  const margin = 10;
  const imgWidth = 210 - (margin * 2);
  const imgHeight = (canvas.height * imgWidth) / canvas.width;

  doc.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", margin, margin, imgWidth, imgHeight);
  doc.save(`${(emp.fullName || "Employee").replace(/\s+/g, "_")}_Record.pdf`);
  showToast("PDF downloaded successfully.");
}

async function triggerPrintView(emp) {
  await loadAttachments(emp);
  const win = window.open("", "_blank", "width=850,height=900");
  if (!win) {
    showToast("Popup blocked by browser.", true);
    return;
  }
  win.document.open();
  win.document.write(`<!DOCTYPE html><html><head><title>Print File</title></head><body style="margin:0;">${createPrintTemplate(emp)}</body></html>`);
  win.document.close();

  const runPrint = async () => {
    const images = Array.from(win.document.images);
    await Promise.all(images.map(img => img.complete ? Promise.resolve() : new Promise(res => { img.onload = res; img.onerror = res; })));
    win.focus();
    win.print();
  };

  if (win.document.readyState === "complete") runPrint();
  else win.onload = runPrint;
}

// --- Views & UI Rendering ---
function renderHeader() {
  return `
    <div class="header-bar">
      <div>
        <div class="brand-label">OPTP Internal</div>
        <div class="brand-title">Employee Records</div>
      </div>
      <div style="text-align:right;">
        <div class="user-tag">${escapeHtml(State.userEmail)}</div>
        <button class="btn btn-danger" id="btn-logout" style="margin-top:6px;padding:3px 10px;font-size:11px;">Logout</button>
      </div>
    </div>`;
}

function renderFormFields(emp = {}) {
  const g = k => escapeHtml(emp[k] || "");
  const chk = (k, val) => emp[k] === val ? "checked" : "";
  const sel = (k, val) => emp[k] === val ? "selected" : "";

  return `
    <div class="form-section">Employee Information</div>
    <div class="row">
      <div class="col"><label class="req">Position</label><input id="f-position" value="${g('position')}" placeholder="e.g. Branch Supervisor"></div>
      <div class="col"><label>Salary</label><input type="number" id="f-salary" value="${g('salary')}" placeholder="PKR"></div>
    </div>
    <div class="row">
      <div class="col"><label class="req">Full Name</label><input id="f-fullName" value="${g('fullName')}"></div>
      <div class="col"><label>Father Name</label><input id="f-fatherName" value="${g('fatherName')}"></div>
    </div>
    <div class="row">
      <div class="col"><label class="req">Date of Birth</label><input type="date" id="f-dob" value="${g('dob')}"></div>
      <div class="col"><label class="req">CNIC</label><input id="f-cnic" maxlength="15" placeholder="xxxxx-xxxxxxx-x" value="${g('cnic')}"></div>
    </div>
    <div class="row">
      <div class="col">
        <label>Gender</label>
        <div class="radio-group">
          <label><input type="radio" name="r-gender" value="Male" ${chk('gender','Male') || 'checked'}> Male</label>
          <label><input type="radio" name="r-gender" value="Female" ${chk('gender','Female')}> Female</label>
          <label><input type="radio" name="r-gender" value="Transgender" ${chk('gender','Transgender')}> Transgender</label>
        </div>
      </div>
      <div class="col"><label class="req">Joining Date</label><input type="date" id="f-joiningDate" value="${g('joiningDate')}"></div>
    </div>
    <div class="row">
      <div class="col">
        <label>Marital Status</label>
        <div class="radio-group">
          <label><input type="radio" name="r-marital" value="Single" ${chk('relationshipStatus','Single') || 'checked'}> Single</label>
          <label><input type="radio" name="r-marital" value="Married" ${chk('relationshipStatus','Married')}> Married</label>
        </div>
      </div>
      <div class="col ${emp.relationshipStatus === 'Married' ? '' : 'hidden'}" id="wrap-children">
        <label>Number of Children</label><input type="number" min="0" id="f-children" value="${g('childrenCount')}">
      </div>
    </div>

    <div class="form-section">Contact Details</div>
    <div class="row">
      <div class="col"><label class="req">Permanent Address</label><textarea id="f-permAddr" rows="2">${g('permanentAddress')}</textarea></div>
      <div class="col"><label class="req">Temporary Address</label><textarea id="f-tempAddr" rows="2">${g('temporaryAddress')}</textarea></div>
    </div>
    <div class="row">
      <div class="col"><label class="req">Mobile Number</label><input type="tel" id="f-mobile" placeholder="0300-1234567" value="${g('mobileNumber')}"></div>
      <div class="col"><label class="req">Home Number (Emergency)</label><input type="tel" id="f-homePhone" placeholder="Emergency contact" value="${g('homeNumber')}"></div>
    </div>
    <div class="row">
      <div class="col"><label>Email Address</label><input type="email" id="f-email" placeholder="staff@example.com" value="${g('email')}"></div>
    </div>

    <div class="form-section">Academic & Experience</div>
    <div class="row">
      <div class="col">
        <label class="req">Qualification</label>
        <select id="f-qualification">
          <option value="">-- Select --</option>
          <option value="Under Matric" ${sel('qualification','Under Matric')}>Under Matric</option>
          <option value="Matric" ${sel('qualification','Matric')}>Matric</option>
          <option value="Inter" ${sel('qualification','Inter')}>Inter</option>
          <option value="Graduation" ${sel('qualification','Graduation')}>Graduation</option>
          <option value="Graduation Continue" ${sel('qualification','Graduation Continue')}>Graduation Continue</option>
          <option value="Masters" ${sel('qualification','Masters')}>Masters</option>
        </select>
      </div>
    </div>
    <div class="row ${emp.qualification === 'Graduation Continue' ? '' : 'hidden'}" id="wrap-qual-detail">
      <div class="col"><label class="req">Program / Institution / Semester</label><textarea id="f-qualDetail" rows="2" placeholder="e.g. BSCS, 4th Semester">${g('qualificationDetail')}</textarea></div>
    </div>
    <div class="row">
      <div class="col">
        <label class="req">Previous Experience?</label>
        <div class="radio-group">
          <label><input type="radio" name="r-exp" value="No" ${chk('previousExperience','No') || 'checked'}> No</label>
          <label><input type="radio" name="r-exp" value="Yes" ${chk('previousExperience','Yes')}> Yes</label>
        </div>
      </div>
    </div>
    <div id="wrap-exp-detail" class="${emp.previousExperience === 'Yes' ? '' : 'hidden'}">
      <div class="row"><div class="col"><label class="req">Experience Summary</label><textarea id="f-expDetail" rows="2">${g('prevExpDetail')}</textarea></div></div>
      <div class="row">
        <div class="col"><label class="req">Previous Salary</label><input type="number" id="f-prevSalary" value="${g('prevSalary')}"></div>
        <div class="col"><label class="req">Reason for Leaving</label><input id="f-prevReason" value="${g('prevReason')}"></div>
      </div>
    </div>

    <div class="form-section">Identity Documents</div>
    <div class="row">
      <div class="col">
        <label class="req">Photograph</label>
        <div class="drop-zone" id="zone-pic">Choose Photo<br><img class="preview-img ${emp.picture ? '' : 'hidden'}" id="prev-pic" src="${emp.picture || ''}"></div>
        <input type="file" accept="image/*" id="file-pic" class="hidden">
      </div>
      <div class="col">
        <label class="req">CNIC Front</label>
        <div class="drop-zone" id="zone-cnicf">Choose File<br><img class="preview-img ${emp.cnicFront ? '' : 'hidden'}" id="prev-cnicf" src="${emp.cnicFront || ''}"></div>
        <input type="file" accept="image/*" id="file-cnicf" class="hidden">
      </div>
      <div class="col">
        <label class="req">CNIC Back</label>
        <div class="drop-zone" id="zone-cnicb">Choose File<br><img class="preview-img ${emp.cnicBack ? '' : 'hidden'}" id="prev-cnicb" src="${emp.cnicBack || ''}"></div>
        <input type="file" accept="image/*" id="file-cnicb" class="hidden">
      </div>
    </div>`;
}

function bindFormEvents(store) {
  const cnicInput = document.getElementById("f-cnic");
  cnicInput.addEventListener("input", () => {
    cnicInput.value = sanitizeCnic(cnicInput.value);
  });

  document.getElementById("f-qualification").addEventListener("change", (e) => {
    document.getElementById("wrap-qual-detail").classList.toggle("hidden", e.target.value !== "Graduation Continue");
  });

  document.querySelectorAll('input[name="r-marital"]').forEach(el => {
    el.addEventListener("change", () => {
      const isMarried = document.querySelector('input[name="r-marital"]:checked')?.value === "Married";
      document.getElementById("wrap-children").classList.toggle("hidden", !isMarried);
    });
  });

  document.querySelectorAll('input[name="r-exp"]').forEach(el => {
    el.addEventListener("change", () => {
      const hasExp = document.querySelector('input[name="r-exp"]:checked')?.value === "Yes";
      document.getElementById("wrap-exp-detail").classList.toggle("hidden", !hasExp);
    });
  });

  function setupUpload(zoneId, inputId, previewId, storeKey, flagKey) {
    document.getElementById(zoneId).onclick = () => document.getElementById(inputId).click();
    document.getElementById(inputId).addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const base64 = await ImageUtil.compress(file);
        store[storeKey] = base64;
        store[flagKey] = true;
        const img = document.getElementById(previewId);
        img.src = base64;
        img.classList.remove("hidden");
      } catch (err) {
        showToast("Image compression failed.", true);
      }
    });
  }

  setupUpload("zone-pic", "file-pic", "prev-pic", "picture", "_newPic");
  setupUpload("zone-cnicf", "file-cnicf", "prev-cnicf", "cnicFront", "_newFront");
  setupUpload("zone-cnicb", "file-cnicb", "prev-cnicb", "cnicBack", "_newBack");
}

function extractForm(base = {}) {
  const v = id => document.getElementById(id)?.value?.trim() || "";
  const r = name => document.querySelector(`input[name="${name}"]:checked`)?.value || "";

  return {
    ...base,
    position: v("f-position"),
    salary: v("f-salary"),
    fullName: v("f-fullName"),
    fatherName: v("f-fatherName"),
    dob: v("f-dob"),
    cnic: v("f-cnic"),
    gender: r("r-gender"),
    joiningDate: v("f-joiningDate"),
    relationshipStatus: r("r-marital"),
    childrenCount: v("f-children"),
    permanentAddress: v("f-permAddr"),
    temporaryAddress: v("f-tempAddr"),
    mobileNumber: v("f-mobile"),
    homeNumber: v("f-homePhone"),
    email: v("f-email"),
    qualification: document.getElementById("f-qualification")?.value || "",
    qualificationDetail: v("f-qualDetail"),
    previousExperience: r("r-exp"),
    prevExpDetail: v("f-expDetail"),
    prevSalary: v("f-prevSalary"),
    prevReason: v("f-prevReason")
  };
}

function validateRecord(d) {
  const missing = [];
  if (!d.position) missing.push("Position");
  if (!d.fullName) missing.push("Full Name");
  if (!d.dob) missing.push("Date of Birth");
  if (!d.cnic) missing.push("CNIC");
  if (!d.joiningDate) missing.push("Joining Date");
  if (!d.permanentAddress) missing.push("Permanent Address");
  if (!d.temporaryAddress) missing.push("Temporary Address");
  if (!d.mobileNumber) missing.push("Mobile Number");
  if (!d.homeNumber) missing.push("Home Emergency Number");
  if (!d.qualification) missing.push("Qualification");
  if (d.qualification === "Graduation Continue" && !d.qualificationDetail) missing.push("Academic Details");
  if (d.previousExperience === "Yes") {
    if (!d.prevExpDetail) missing.push("Experience Summary");
    if (!d.prevSalary) missing.push("Previous Salary");
    if (!d.prevReason) missing.push("Reason for Leaving");
  }
  if (!d.picture) missing.push("Photograph");
  if (!d.cnicFront) missing.push("CNIC Front");
  if (!d.cnicBack) missing.push("CNIC Back");
  return missing;
}

async function loadAttachments(emp) {
  if (!emp.picture && emp.pictureFileId) emp.picture = await StorageService.readDataUrl(emp.pictureFileId);
  if (!emp.cnicFront && emp.cnicFrontFileId) emp.cnicFront = await StorageService.readDataUrl(emp.cnicFrontFileId);
  if (!emp.cnicBack && emp.cnicBackFileId) emp.cnicBack = await StorageService.readDataUrl(emp.cnicBackFileId);
}

// --- Detail View ---
async function openDetailModal(id, source) {
  const list = source === "current" ? State.employees.current : State.employees.resigned;
  const emp = list.find(e => e.id === id);
  if (!emp) return;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-content">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div class="brand-label">${source === "current" ? "Active Staff" : "Archived File"}</div>
          <h2 style="font-size:18px;margin-top:2px;">${escapeHtml(emp.fullName || "Staff Member")}</h2>
          <div style="font-size:12px;color:var(--text-muted);">${escapeHtml(emp.position || "")}</div>
        </div>
        <button class="btn btn-secondary" id="m-close" style="padding:4px 10px;">&times;</button>
      </div>
      <div id="m-images" style="display:flex;gap:12px;margin:16px 0;">
        <span style="font-size:12px;color:var(--text-muted);">Loading files...</span>
      </div>
      <div class="modal-grid">
        <div><div class="item-key">Position</div><div class="item-val">${escapeHtml(emp.position || "—")}</div></div>
        <div><div class="item-key">Salary</div><div class="item-val">${escapeHtml(emp.salary || "—")}</div></div>
        <div><div class="item-key">Full Name</div><div class="item-val">${escapeHtml(emp.fullName || "—")}</div></div>
        <div><div class="item-key">Father Name</div><div class="item-val">${escapeHtml(emp.fatherName || "—")}</div></div>
        <div><div class="item-key">CNIC</div><div class="item-val">${escapeHtml(emp.cnic || "—")}</div></div>
        <div><div class="item-key">DOB</div><div class="item-val">${escapeHtml(emp.dob || "—")}</div></div>
        <div><div class="item-key">Joining Date</div><div class="item-val">${escapeHtml(emp.joiningDate || "—")}</div></div>
        <div><div class="item-key">Marital Status</div><div class="item-val">${escapeHtml(emp.relationshipStatus || "—")}</div></div>
        <div><div class="item-key">Mobile</div><div class="item-val">${escapeHtml(emp.mobileNumber || "—")}</div></div>
        <div><div class="item-key">Emergency Contact</div><div class="item-val">${escapeHtml(emp.homeNumber || "—")}</div></div>
        <div><div class="item-key">Permanent Address</div><div class="item-val">${escapeHtml(emp.permanentAddress || "—")}</div></div>
        <div><div class="item-key">Temporary Address</div><div class="item-val">${escapeHtml(emp.temporaryAddress || "—")}</div></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid var(--border);padding-top:16px;">
        <button class="btn btn-secondary" id="m-print">Print</button>
        <button class="btn btn-secondary" id="m-pdf">Save PDF</button>
        <button class="btn btn-secondary" id="m-edit">Edit</button>
        <button class="btn btn-danger" id="m-delete">Delete</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector("#m-close").onclick = () => overlay.remove();
  overlay.querySelector("#m-print").onclick = () => triggerPrintView(emp);
  overlay.querySelector("#m-pdf").onclick = () => exportRecordAsPdf(emp);

  overlay.querySelector("#m-edit").onclick = () => {
    overlay.remove();
    openEditModal(emp, source);
  };

  overlay.querySelector("#m-delete").onclick = async () => {
    if (!confirm(`Delete ${emp.fullName || "this record"} permanently?`)) return;
    try {
      await StorageService.moveToTrash(emp.folderId);
      list.splice(list.findIndex(e => e.id === id), 1);
      overlay.remove();
      showToast("Record sent to Trash.");
      setView(source === "current" ? "list-current" : "list-resigned");
    } catch (e) {
      showToast("Failed to delete record.", true);
    }
  };

  // Lazy load images
  try {
    await loadAttachments(emp);
    if (!document.body.contains(overlay)) return;
    overlay.querySelector("#m-images").innerHTML = `
      ${emp.picture ? `<img src="${emp.picture}" style="width:60px;height:60px;object-fit:cover;border-radius:4px;border:1px solid var(--border);">` : ""}
      ${emp.cnicFront ? `<img src="${emp.cnicFront}" style="width:90px;height:60px;object-fit:cover;border-radius:4px;border:1px solid var(--border);">` : ""}
      ${emp.cnicBack ? `<img src="${emp.cnicBack}" style="width:90px;height:60px;object-fit:cover;border-radius:4px;border:1px solid var(--border);">` : ""}`;
  } catch (err) {
    overlay.querySelector("#m-images").innerHTML = `<span style="font-size:12px;color:var(--text-muted);">Attachments unavailable.</span>`;
  }
}

function openEditModal(emp, source) {
  const store = { ...emp };
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-content">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h2 style="font-size:18px;">Edit: ${escapeHtml(emp.fullName || "Staff")}</h2>
        <button class="btn btn-secondary" id="ed-close" style="padding:4px 10px;">&times;</button>
      </div>
      ${renderFormFields(emp)}
      <div style="display:flex;gap:10px;margin-top:20px;">
        <button class="btn btn-primary" id="ed-save">Save Changes</button>
        <button class="btn btn-secondary" id="ed-cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  bindFormEvents(store);

  overlay.querySelector("#ed-close").onclick = () => overlay.remove();
  overlay.querySelector("#ed-cancel").onclick = () => overlay.remove();
  overlay.querySelector("#ed-save").onclick = async () => {
    const updated = extractForm(store);
    const errs = validateRecord(updated);
    if (errs.length) {
      showToast(`Missing: ${errs.join(", ")}`, true);
      return;
    }

    const btn = overlay.querySelector("#ed-save");
    btn.disabled = true;
    btn.textContent = "Updating...";

    try {
      const cleanData = { ...updated };
      delete cleanData.picture;
      delete cleanData.cnicFront;
      delete cleanData.cnicBack;
      delete cleanData._newPic;
      delete cleanData._newFront;
      delete cleanData._newBack;

      if (emp.profileFileId) {
        await StorageService.updateFile(emp.profileFileId, "application/json", JSON.stringify(cleanData), true);
      }
      if (updated._newPic) await StorageService.updateFile(emp.pictureFileId, "image/jpeg", updated.picture, false);
      if (updated._newFront) await StorageService.updateFile(emp.cnicFrontFileId, "image/jpeg", updated.cnicFront, false);
      if (updated._newBack) await StorageService.updateFile(emp.cnicBackFileId, "image/jpeg", updated.cnicBack, false);

      const list = source === "current" ? State.employees.current : State.employees.resigned;
      const idx = list.findIndex(e => e.id === emp.id);
      if (idx > -1) list[idx] = updated;

      overlay.remove();
      showToast("Record updated successfully.");
      setView(source === "current" ? "list-current" : "list-resigned");
    } catch (e) {
      showToast("Update failed.", true);
      btn.disabled = false;
      btn.textContent = "Save Changes";
    }
  };
}

// --- Controller View Switcher ---
function setView(view, msg = "") {
  State.activeView = view;

  if (view === "login") {
    app.innerHTML = `
      <div class="panel center-card">
        <h2 style="font-size:20px;margin-bottom:6px;">Staff Portal</h2>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:20px;">Google Workspace Storage Connection</p>
        <button class="btn btn-primary" id="btn-login" style="width:100%;padding:10px;">Sign in with Google</button>
      </div>`;
    document.getElementById("btn-login").onclick = () => State.tokenClient?.requestAccessToken({ prompt: "consent" });
  }

  else if (view === "loading") {
    app.innerHTML = `
      <div class="panel center-card">
        <div class="loader"></div>
        <div style="font-size:13px;color:var(--text-muted);">${escapeHtml(msg || "Loading...")}</div>
      </div>`;
  }

  else if (view === "dashboard") {
    app.innerHTML = renderHeader() + `
      <div class="stats-grid">
        <div class="card-action" id="card-current">
          <div class="card-title">Active Staff</div>
          <div class="card-value">${State.employees.current.length}</div>
          <div class="card-desc">Active employees roster</div>
        </div>
        <div class="card-action" id="card-new">
          <div class="card-title">Register Employee</div>
          <div class="card-value">+</div>
          <div class="card-desc">Add new personnel file</div>
        </div>
        <div class="card-action" id="card-resigned">
          <div class="card-title">Archived Records</div>
          <div class="card-value">${State.employees.resigned.length}</div>
          <div class="card-desc">Past staff files</div>
        </div>
      </div>`;
    document.getElementById("btn-logout").onclick = logout;
    document.getElementById("card-current").onclick = () => setView("list-current");
    document.getElementById("card-resigned").onclick = () => setView("list-resigned");
    document.getElementById("card-new").onclick = () => setView("new");
  }

  else if (view === "new") {
    const store = {};
    app.innerHTML = renderHeader() + `
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <h2 style="font-size:18px;">Register New Employee</h2>
          <button class="btn btn-secondary" id="btn-back-dash">&larr; Dashboard</button>
        </div>
        ${renderFormFields()}
        <div style="display:flex;gap:10px;margin-top:20px;">
          <button class="btn btn-primary" id="btn-save-record">Save Employee</button>
          <button class="btn btn-secondary" id="btn-cancel-record">Cancel</button>
        </div>
      </div>`;
    document.getElementById("btn-logout").onclick = logout;
    bindFormEvents(store);

    document.getElementById("btn-back-dash").onclick = () => setView("dashboard");
    document.getElementById("btn-cancel-record").onclick = () => setView("dashboard");
    document.getElementById("btn-save-record").onclick = async () => {
      const data = extractForm(store);
      const errors = validateRecord(data);
      if (errors.length) {
        showToast(`Missing: ${errors.join(", ")}`, true);
        return;
      }

      const btn = document.getElementById("btn-save-record");
      btn.disabled = true;
      btn.textContent = "Saving to Drive...";

      try {
        const folderTitle = `${data.fullName} - ${data.cnic}`;
        const folderId = await StorageService.createFolder(folderTitle, State.folders.current);
        data.folderId = folderId;

        const cleanData = { ...data };
        delete cleanData.picture;
        delete cleanData.cnicFront;
        delete cleanData.cnicBack;

        data.profileFileId = await StorageService.saveFile("profile.json", "application/json", folderId, JSON.stringify(cleanData), true);
        if (data.picture) data.pictureFileId = await StorageService.saveFile("picture.jpg", "image/jpeg", folderId, data.picture, false);
        if (data.cnicFront) data.cnicFrontFileId = await StorageService.saveFile("cnic_front.jpg", "image/jpeg", folderId, data.cnicFront, false);
        if (data.cnicBack) data.cnicBackFileId = await StorageService.saveFile("cnic_back.jpg", "image/jpeg", folderId, data.cnicBack, false);

        State.employees.current.push(data);
        showToast("Employee registered successfully.");
        setView("list-current");
      } catch (err) {
        showToast("Failed to save employee to Drive.", true);
        btn.disabled = false;
        btn.textContent = "Save Employee";
      }
    };
  }

  else if (view === "list-current" || view === "list-resigned") {
    const isCurrent = view === "list-current";
    const dataset = isCurrent ? State.employees.current : State.employees.resigned;
    const query = isCurrent ? State.search.current : State.search.resigned;
    const filtered = dataset.filter(e => (e.fullName || "").toLowerCase().includes(query.toLowerCase()) || (e.cnic || "").includes(query));

    app.innerHTML = renderHeader() + `
      <div class="panel">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h2 style="font-size:18px;">${isCurrent ? "Active Employees" : "Archived Directory"} (${dataset.length})</h2>
          <button class="btn btn-secondary" id="btn-back-home">&larr; Dashboard</button>
        </div>
        <input type="text" id="in-search" placeholder="Search by name or CNIC..." value="${escapeHtml(query)}" style="margin-bottom:12px;">
        <div class="employee-grid">
          ${filtered.length ? filtered.map(e => `
            <div class="employee-card" data-id="${escapeHtml(e.id)}">
              <div class="avatar-preview">&#128100;</div>
              <div class="emp-name">${escapeHtml(e.fullName || "Unnamed")}</div>
              <div class="emp-sub">${escapeHtml(e.cnic || e.id)}</div>
              <div style="font-size:11px;color:var(--primary);margin-top:4px;">${escapeHtml(e.position || "")}</div>
            </div>`).join("") : `<div style="grid-column:1/-1;text-align:center;padding:32px;color:var(--text-muted);">No records found.</div>`}
        </div>
      </div>`;
    document.getElementById("btn-logout").onclick = logout;
    document.getElementById("btn-back-home").onclick = () => setView("dashboard");

    document.getElementById("in-search").addEventListener("input", (e) => {
      if (isCurrent) State.search.current = e.target.value;
      else State.search.resigned = e.target.value;
      setView(view);
    });

    document.querySelectorAll(".employee-card").forEach(el => {
      el.onclick = () => openDetailModal(el.dataset.id, isCurrent ? "current" : "resigned");
    });
  }
}

// --- Initialize App on Load ---
window.addEventListener("load", () => {
  const checkGoogle = setInterval(() => {
    if (window.google?.accounts?.oauth2) {
      clearInterval(checkGoogle);
      initAuthClient();
      setView("login");
    }
  }, 100);
});