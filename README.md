# OPTP Employee Record System (Production Version)

A secure single-page web application designed for employee lifecycle management and personnel archiving, backed by Google Drive as a serverless database[cite: 1, 3].

## Architecture & Data Storage

* **Authentication:** Google Identity Services (OAuth 2.0 Token Client) with an email allowlist (`shahzaibafzalsa3697559@gmail.com`, `optpscheme3@gmail.com`)[cite: 1, 3].
* **Access Gate:** Multi-factor master PIN (`6666`) required before accessing and performing sensitive actions.
* **Storage Engine:** Google Drive REST API (`drive.file` scope)[cite: 3].
* **Directory Hierarchy:**
  * Root: `OPTP Employee Record`[cite: 3]
  * Subfolders: `Current Employees` and `Resigned or Retired Employees`[cite: 3]
  * Per-Employee Structure: `[FullName] - [CNIC]` containing `profile.json`, `picture.jpg`, `cnic_front.jpg`, and `cnic_back.jpg`[cite: 3].

## Key Features

* **Cloud Sync:** Reads and writes employee profiles and document assets directly to Google Drive[cite: 3].
* **Automatic Token Handling:** Silent token refresh on authorization timeouts without interrupting the active session[cite: 3].
* **Document Compression:** Client-side HTML5 Canvas image optimization before uploading to Google Drive[cite: 2, 3].
* **Lifecycle Management:** Move employee folders between Active and Archived directories on status updates[cite: 3].
* **Search & Print:** Instant search by Name or CNIC, with a dedicated printable dossier engine[cite: 3].

## Setup & Deployment

1. Make sure `index.html` includes the Google Identity Services script and loads `app.js`[cite: 1]:
   ```html
   <script src="[https://accounts.google.com/gsi/client](https://accounts.google.com/gsi/client)" async defer></script>
   <script src="app.js"></script>
