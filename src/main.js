const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const DATA_DIR = path.join(__dirname, '..', 'data', 'mcp-servers');

function generateId() {
  return Math.random().toString(36).substring(2, 14);
}

function getServerDir(id) {
  return path.join(DATA_DIR, id);
}

function formatDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function logAction(id, action, message) {
  const logPath = path.join(getServerDir(id), 'log.txt');
  const logEntry = `[${formatDate()}] [${action}] ${message}\n`;
  fs.appendFileSync(logPath, logEntry);
}

async function ensureServerDir(id) {
  const dir = getServerDir(id);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function loadServers() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return [];
  }

  const servers = [];
  const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const dataPath = path.join(entry.path, entry.name, 'data.json');
      if (fs.existsSync(dataPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
          servers.push(data);
        } catch (e) {
          console.error(`Failed to load server ${entry.name}: ${e.message}`);
        }
      }
    }
  }

  return servers.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

async function saveServer(server) {
  await ensureServerDir(server.id);
  const dataPath = path.join(getServerDir(server.id), 'data.json');
  const configPath = path.join(getServerDir(server.id), 'config.json');

  const flatConfig = unwrapConfig(server.config);
  const serverToSave = { ...server, config: flatConfig };

  fs.writeFileSync(dataPath, JSON.stringify(serverToSave, null, 2));
  fs.writeFileSync(configPath, JSON.stringify(flatConfig, null, 2));
}

async function deleteServer(id) {
  const dir = getServerDir(id);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function unwrapConfig(config) {
  if (config.mcpServers && typeof config.mcpServers === 'object') {
    const entries = Object.entries(config.mcpServers);
    if (entries.length > 0) {
      return entries[0][1];
    }
  }
  return config;
}

async function discoverServer(server) {
  const results = {
    tools: [],
    documentation: '',
    logs: []
  };

  logAction(server.id, 'DISCOVERY', 'Starting MCP server discovery');

  try {
    let client;
    const rawConfig = server.config;
    const config = unwrapConfig(rawConfig);

    if (config.transport === 'http' || config.url) {
      logAction(server.id, 'DISCOVERY', 'Connecting via HTTP transport');
      const transport = new StreamableHTTPClientTransport({
        url: config.url
      });
      client = new Client({
        name: 'mcp-discovery',
        version: '1.0.0'
      }, {
        capabilities: {}
      });
      await client.connect(transport);
    } else {
      if (!config.command) {
        throw new Error('Config missing "command" field. For stdio transport, "command" is required. If using mcpServers format, ensure it contains a server with a "command" property.');
      }
      logAction(server.id, 'DISCOVERY', 'Starting STDIO process');
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: config.env || {}
      });
      client = new Client({
        name: 'mcp-discovery',
        version: '1.0.0'
      }, {
        capabilities: {}
      });
      await client.connect(transport);
    }

    logAction(server.id, 'DISCOVERY', 'Requesting tools list');
    const toolsResponse = await client.request({ method: 'tools/list' }, { method: 'tools/list', params: {} });
    results.tools = toolsResponse.tools || [];

    logAction(server.id, 'DISCOVERY', `Discovered ${results.tools.length} tools`);

    results.documentation = generateDocumentation(server, results.tools);
    logAction(server.id, 'DISCOVERY', 'Generated documentation');

    const readmePath = path.join(getServerDir(server.id), 'readme.md');
    fs.writeFileSync(readmePath, results.documentation);
    logAction(server.id, 'DISCOVERY', 'Saved documentation to readme.md');

    await client.close();
    logAction(server.id, 'DISCOVERY', 'Discovery completed successfully');

  } catch (error) {
    logAction(server.id, 'ERROR', `Discovery failed: ${error.message}`);
    throw error;
  }

  return results;
}

function generateDocumentation(server, tools) {
  const toolDocs = tools.map(tool => {
    let doc = `### ${tool.name}\n\n`;
    if (tool.description) {
      doc += `${tool.description}\n\n`;
    }

    if (tool.inputSchema && tool.inputSchema.properties) {
      doc += `**Parameters:**\n\n`;
      const props = tool.inputSchema.properties;
      for (const [name, prop] of Object.entries(props)) {
        const type = prop.type || 'any';
        const required = tool.inputSchema.required?.includes(name) ? ' (required)' : ' (optional)';
        doc += `- \`${name}\` (${type})${required}`;
        if (prop.description) {
          doc += `: ${prop.description}`;
        }
        doc += `\n`;
      }
    }

    return doc;
  }).join('\n');

  return `# ${server.name}\n\n` +
    `MCP Server providing tools for AI agents.\n\n` +
    `## Tools\n\n` +
    (toolDocs || '_No tools available._') +
    `\n\n---\n\n` +
    `Generated by MCP Discovery Tool on ${new Date().toISOString()}\n`;
}

function getServerLogs(id) {
  const logPath = path.join(getServerDir(id), 'log.txt');
  if (fs.existsSync(logPath)) {
    return fs.readFileSync(logPath, 'utf-8');
  }
  return '';
}

function getServerReadme(id) {
  const readmePath = path.join(getServerDir(id), 'readme.md');
  if (fs.existsSync(readmePath)) {
    return fs.readFileSync(readmePath, 'utf-8');
  }
  return '';
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-quit', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('get-servers', async () => {
  return loadServers();
});

ipcMain.handle('create-server', async (event, { name, config }) => {
  const id = generateId();
  const server = {
    id,
    name,
    config,
    createdAt: new Date().toISOString()
  };
  await saveServer(server);
  logAction(id, 'CREATED', `MCP Server "${name}" created`);
  return server;
});

ipcMain.handle('update-server', async (event, server) => {
  await saveServer(server);
  logAction(server.id, 'UPDATED', `MCP Server "${server.name}" updated`);
  return server;
});

ipcMain.handle('delete-server', async (event, id) => {
  logAction(id, 'DELETED', `MCP Server deleted`);
  await deleteServer(id);
  return { success: true };
});

ipcMain.handle('discover-server', async (event, server) => {
  return await discoverServer(server);
});

ipcMain.handle('get-logs', async (event, id) => {
  return getServerLogs(id);
});

ipcMain.handle('get-readme', async (event, id) => {
  return getServerReadme(id);
});