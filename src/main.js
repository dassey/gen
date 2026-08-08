import './style.css';
import MediaInfoFactory from 'mediainfo.js';
import mediaInfoWasmUrl from 'mediainfo.js/MediaInfoModule.wasm?url';

const LOCAL_STORAGE_KEY = 'comfyui_workflow_history';

// Helper to get history from LocalStorage
function getHistory() {
  const data = localStorage.getItem(LOCAL_STORAGE_KEY);
  return data ? JSON.parse(data) : [];
}

// Helper to save history to LocalStorage
function saveHistory(history) {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(history));
}

document.querySelector('#app').innerHTML = `
  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1em;">
    <div style="display:flex; align-items:center; gap:0.5em;">
      <button id="toggleSidebarBtn">☰ History</button>
      <span style="color: black; font-weight: bold;">ComfyUI Video Workflow Extractor</span>
    </div>
    <span style="font-size:12px;">All processing done in browser. <a href="https://github.com/gabecastello/comfyui-video-workflow-viewer" target="_blank">GitHub</a></span>
  </div>

  <div class="app-layout">
    <!-- Collapsible Sidebar -->
    <aside id="sidebar" class="sidebar">
      <div class="sidebar-header">
        <h3>Saved History</h3>
        <button id="clearAllBtn" style="font-size: 0.75rem; color: #ef4444;">Clear All</button>
      </div>
      <ul id="historyList" class="history-list"></ul>
    </aside>

    <!-- Main Workspace -->
    <main class="main-content">
      <div class="container">
        <input id="fileInput" type="file" accept=".mp4" />
        <p id="status"></p>
        <div style="display:flex; margin-bottom:1em; gap:1em;">
          <button id="copyBtn" disabled>Copy Workflow</button>
          <button id="downloadBtn" disabled>Download</button>
          <button id="saveHistoryBtn" disabled>Save to History</button>
        </div>
        <textarea id="output" style="width:100%; height:40em; font-family: monospace;"></textarea>
      </div>
    </main>

    <!-- Drop overlay -->
    <div id="dragOverlay" class="drag-overlay hidden">
      <div class="drag-overlay-message">
        📂 Drop file anywhere
      </div>
    </div>
  </div>
`;

// Elements
const fileInput = document.getElementById('fileInput');
const status = document.getElementById('status');
const output = document.getElementById('output');
const copyBtn = document.getElementById('copyBtn');
const downloadBtn = document.getElementById('downloadBtn');
const saveHistoryBtn = document.getElementById('saveHistoryBtn');
const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
const sidebar = document.getElementById('sidebar');
const historyList = document.getElementById('historyList');
const dragOverlay = document.getElementById('dragOverlay');

let currentFileName = '';

// Setup MediaInfo
const mediaInfo = await MediaInfoFactory({
  format: 'object',
  locateFile: (path, prefix) =>
    path === 'MediaInfoModule.wasm' ? mediaInfoWasmUrl : `${prefix}${path}`,
});

// Render history list from LocalStorage
function renderHistory() {
  const history = getHistory();
  historyList.innerHTML = '';

  if (history.length === 0) {
    historyList.innerHTML =
      '<li style="font-size:0.85rem; color:#888;">No saved items</li>';
    return;
  }

  history.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML = `
      <div class="history-item-info">
        <span class="history-item-name">${item.fileName}</span>
        <span class="history-item-date">${new Date(item.timestamp).toLocaleString()}</span>
      </div>
      <div class="action-buttons">
        <button class="edit-item-btn" title="Rename item">✏️</button>
        <button class="delete-item-btn" title="Delete item">🗑</button>
      </div>
    `;

    // Click on item body -> Load into editor
    li.addEventListener('click', (e) => {
      if (
        e.target.classList.contains('delete-item-btn') ||
        e.target.classList.contains('edit-item-btn')
      )
        return;

      output.value = item.data;
      status.textContent = `Loaded "${item.fileName}" from history`;
      status.style.color = 'black';
      copyBtn.disabled = false;
      downloadBtn.disabled = false;
    });

    // Click pencil icon -> Open prompt to edit name
    li.querySelector('.edit-item-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const newName = window.prompt('Enter new name:', item.fileName);
      if (newName !== null && newName.trim() !== '') {
        updateHistoryItemName(item.id, newName.trim());
      }
    });

    // Click delete button -> Remove item
    li.querySelector('.delete-item-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteHistoryItem(item.id);
    });

    historyList.appendChild(li);
  });
}

function deleteHistoryItem(id) {
  const history = getHistory().filter((item) => item.id !== id);
  saveHistory(history);
  renderHistory();
}

function updateHistoryItemName(id, newName) {
  const history = getHistory();
  const item = history.find((i) => i.id === id);
  if (item) {
    item.fileName = newName;
    saveHistory(history);
    renderHistory();
  }
}

// File Upload Handler
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  currentFileName = file.name;
  status.textContent = 'Reading metadata...';
  output.value = '';
  saveHistoryBtn.disabled = true;

  try {
    const result = await mediaInfo.analyzeData(
      file.size,
      async (chunkSize, offset) =>
        new Uint8Array(
          await file.slice(offset, offset + chunkSize).arrayBuffer(),
        ),
    );

    const workflow = findWorkflow(result);
    let pretty;
    if (workflow) {
      status.textContent = 'Workflow extracted';
      status.style.color = 'green';
      copyBtn.textContent = 'Copy Workflow';
      pretty = workflow;
    } else {
      status.textContent = 'No workflow found! Showing all metadata searched';
      status.style.color = 'red';
      copyBtn.textContent = 'Copy Metadata';
      pretty = JSON.stringify(result);
    }

    try {
      pretty = JSON.stringify(JSON.parse(pretty), null, 2);
    } catch {}

    output.value = pretty;
    copyBtn.disabled = false;
    downloadBtn.disabled = false;
    saveHistoryBtn.disabled = false;
  } catch (err) {
    status.textContent = 'Error parsing file metadata';
    status.style.color = 'red';
    console.error(err);
  }
});

// Event Listeners
copyBtn.addEventListener('click', async () => {
  copyBtn.textContent = 'Copied';
  setTimeout(() => {
    copyBtn.textContent = 'Copy Workflow';
  }, 2000);
  await navigator.clipboard.writeText(output.value);
});

downloadBtn.addEventListener('click', async () => {
  downloadBtn.textContent = 'Downloading...';
  setTimeout(() => {
    downloadBtn.textContent = 'Download';
  }, 2000);
  const blob = new Blob([output.value], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'workflow.json';
  a.click();
  URL.revokeObjectURL(url);
});

saveHistoryBtn.addEventListener('click', () => {
  if (!output.value) return;

  const history = getHistory();
  const newItem = {
    id: Date.now().toString(),
    fileName: currentFileName || 'Untitled Workflow',
    timestamp: Date.now(),
    data: output.value,
  };

  history.unshift(newItem); // Add newest item first
  saveHistory(history);
  renderHistory();
});

toggleSidebarBtn.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
});

clearAllBtn.addEventListener('click', () => {
  if (confirm('Are you sure you want to clear all saved history?')) {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
    renderHistory();
  }
});

// Initial Render
renderHistory();

function findWorkflow(obj) {
  if (!obj || typeof obj !== 'object') {
    return null;
  }

  if (typeof obj.workflow === 'string') {
    return obj.workflow;
  }

  for (const value of Object.values(obj)) {
    const found = findWorkflow(value);
    if (found) return found;
  }

  return null;
}

// Prevent default drag behaviors across the window
['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
  window.addEventListener(eventName, (e) => e.preventDefault());
  window.addEventListener(eventName, (e) => e.stopPropagation());
});

// Show signal/overlay when dragging a file over the window
let dragCounter = 0; // Helps track nested child element hover states

window.addEventListener('dragenter', (e) => {
  dragCounter++;
  if (e.dataTransfer.types.includes('Files')) {
    dragOverlay.classList.remove('hidden');
  }
});

window.addEventListener('dragleave', (e) => {
  dragCounter--;
  if (dragCounter === 0) {
    dragOverlay.classList.add('hidden');
  }
});

// Handle the dropped file anywhere on the page
window.addEventListener('drop', (e) => {
  dragCounter = 0;
  dragOverlay.classList.add('hidden');

  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    fileInput.files = files;
    fileInput.dispatchEvent(new Event('change'));
  }
});
