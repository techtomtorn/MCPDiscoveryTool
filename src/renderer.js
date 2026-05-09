let servers = [];
let editingServer = null;
let currentDiscoverServer = null;
let logRefreshInterval = null;

async function loadServers() {
  servers = await window.mcpAPI.getServers();
  renderServers();
}

function renderServers() {
  const tbody = document.getElementById('servers-tbody');

  if (servers.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5">
          <div class="empty-state">
            <p>No MCP servers found</p>
            <button class="btn btn-primary" onclick="showCreateForm()">Create your first MCP Server</button>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = servers.map((server, index) => `
    <tr data-id="${server.id}">
      <td>${index + 1}</td>
      <td>${escapeHtml(server.name)}</td>
      <td>
        <button class="action-btn discover" onclick="openDiscovery('${server.id}')">Discover</button>
      </td>
      <td>
        <button class="action-btn edit" onclick="editServer('${server.id}')">Edit</button>
      </td>
      <td>
        <button class="action-btn delete" onclick="deleteServer('${server.id}')">Delete</button>
      </td>
    </tr>
  `).join('');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showCreateForm() {
  editingServer = null;
  document.getElementById('sidepanel-title').textContent = 'Create MCP Server';
  document.getElementById('server-name').value = '';
  document.getElementById('server-config').value = `{
  "transport": "stdio",
  "command": "node",
  "args": []
}`;
  showSidepanel();
}

function showSidepanel() {
  document.getElementById('sidepanel').classList.remove('hidden');
}

function hideSidepanel() {
  document.getElementById('sidepanel').classList.add('hidden');
  editingServer = null;
}

function editServer(id) {
  const server = servers.find(s => s.id === id);
  if (!server) return;

  editingServer = server;
  document.getElementById('sidepanel-title').textContent = 'Edit MCP Server';
  document.getElementById('server-name').value = server.name;
  document.getElementById('server-config').value = JSON.stringify(server.config, null, 2);
  showSidepanel();
}

async function saveServer() {
  const name = document.getElementById('server-name').value.trim();
  let configText = document.getElementById('server-config').value.trim();

  if (!name) {
    alert('Please enter a server name');
    return;
  }

  let config;
  try {
    config = JSON.parse(configText);
  } catch (e) {
    alert('Invalid JSON configuration');
    return;
  }

  if (editingServer) {
    const updated = { ...editingServer, name, config };
    await window.mcpAPI.updateServer(updated);
  } else {
    await window.mcpAPI.createServer({ name, config });
  }

  hideSidepanel();
  await loadServers();
}

async function deleteServer(id) {
  if (!confirm('Are you sure you want to delete this MCP Server?')) {
    return;
  }

  await window.mcpAPI.deleteServer(id);
  await loadServers();
}

async function openDiscovery(id) {
  const server = servers.find(s => s.id === id);
  if (!server) return;

  currentDiscoverServer = server;
  document.getElementById('discovery-title').textContent = server.name;
  document.getElementById('discovery-config').value = JSON.stringify(server.config, null, 2);

  document.getElementById('tab-discover').classList.add('active');
  document.getElementById('tab-documentation').classList.remove('active');
  document.getElementById('tab-logs').classList.remove('active');
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelector('[data-tab="discover"]').classList.add('active');

  const docContent = await window.mcpAPI.getReadme(id);
  document.getElementById('doc-content').value = docContent || 'No documentation available. Click "Discover" to generate documentation.';

  const logContent = await window.mcpAPI.getLogs(id);
  document.getElementById('log-content').value = logContent || 'No logs available.';

  showDialog();
}

async function startDiscovery() {
  if (!currentDiscoverServer) return;

  const btn = document.getElementById('btn-discover');
  btn.disabled = true;
  btn.textContent = 'Discovering...';

  try {
    const results = await window.mcpAPI.discoverServer(currentDiscoverServer);

    document.getElementById('doc-content').value = results.documentation || 'Documentation generated successfully.';

    const logContent = await window.mcpAPI.getLogs(currentDiscoverServer.id);
    document.getElementById('log-content').value = logContent;

    switchTab('documentation');
  } catch (error) {
    alert(`Discovery failed: ${error.message}`);
    const logContent = await window.mcpAPI.getLogs(currentDiscoverServer.id);
    document.getElementById('log-content').value = logContent;
    switchTab('logs');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Discover';
  }
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

  document.getElementById(`tab-${tabName}`).classList.add('active');
  document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

  if (tabName === 'logs' && currentDiscoverServer) {
    startLogRefresh();
  } else {
    stopLogRefresh();
  }
}

async function refreshLogs() {
  if (!currentDiscoverServer) return;

  const logContent = await window.mcpAPI.getLogs(currentDiscoverServer.id);
  const logTextarea = document.getElementById('log-content');
  logTextarea.value = logContent;

  logTextarea.scrollTop = logTextarea.scrollHeight;
}

function startLogRefresh() {
  refreshLogs();
  logRefreshInterval = setInterval(refreshLogs, 2000);
}

function stopLogRefresh() {
  if (logRefreshInterval) {
    clearInterval(logRefreshInterval);
    logRefreshInterval = null;
  }
}

function showDialog() {
  document.getElementById('discovery-dialog').classList.remove('hidden');
}

function hideDialog() {
  document.getElementById('discovery-dialog').classList.add('hidden');
  stopLogRefresh();
  currentDiscoverServer = null;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-create').addEventListener('click', showCreateForm);
  document.getElementById('btn-cancel').addEventListener('click', hideSidepanel);
  document.getElementById('btn-ok').addEventListener('click', saveServer);
  document.getElementById('btn-close-dialog').addEventListener('click', hideDialog);
  document.getElementById('btn-discover').addEventListener('click', startDiscovery);
  document.getElementById('btn-close-doc').addEventListener('click', hideDialog);
  document.getElementById('btn-close-log').addEventListener('click', hideDialog);

  document.getElementById('btn-load-config').addEventListener('click', () => {
    document.getElementById('file-input').click();
  });

  document.getElementById('file-input').addEventListener('change', handleFileLoad);

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  loadServers();
});

function handleFileLoad(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const content = e.target.result;
    try {
      const parsed = JSON.parse(content);
      let configToDisplay = parsed;

      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        const entries = Object.entries(parsed.mcpServers);
        if (entries.length > 0) {
          const [serverName, serverConfig] = entries[0];
          configToDisplay = serverConfig;
          if (!document.getElementById('server-name').value && serverName) {
            document.getElementById('server-name').value = serverName;
          }
          if (entries.length > 1) {
            alert(`Found ${entries.length} servers in mcpServers. Only "${serverName}" was loaded. You can load the others separately.`);
          }
        }
      }

      document.getElementById('server-config').value = JSON.stringify(configToDisplay, null, 2);
    } catch (err) {
      alert('Invalid JSON file: ' + err.message);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}