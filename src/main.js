const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
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
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
}

function logAction(id, action, message) {
  const logPath = path.join(getServerDir(id), 'log.txt');
  const logEntry = `[${formatDate()}] [${action}] ${message}\n`;
  fs.appendFileSync(logPath, logEntry);
  return logEntry.trim();
}

function sendLog(id, action, message) {
  const logEntry = logAction(id, action, message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('discovery-log', { id, log: logEntry });
  }
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

function resolveConfig(config) {
  const raw = unwrapConfig(config);
  const resolved = { ...raw };

  if (raw.transport && !raw.type) {
    const t = raw.transport.toLowerCase().trim();
    if (t === 'http' || t === 'streamable http' || t === 'streamablehttp' || t === 'sse') {
      resolved.type = 'http';
    } else if (t === 'stdio' || t === 'process') {
      resolved.type = 'stdio';
    }
  }

  if (!resolved.type) {
    if (resolved.url) {
      resolved.type = 'http';
    } else if (resolved.command) {
      resolved.type = 'stdio';
    }
  }

  return resolved;
}

function waitForHttpReady(url, timeoutMs = 30000, intervalMs = 500) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const startTime = Date.now();

    const attempt = () => {
      if (Date.now() - startTime >= timeoutMs) {
        reject(new Error(`Companion process did not become ready within ${timeoutMs / 1000}s (HTTP server at ${url} not responding)`));
        return;
      }

      const req = http.request({
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: 2000
      }, (res) => {
        res.resume();
        resolve();
      });

      req.on('error', () => {
        setTimeout(attempt, intervalMs);
      });

      req.on('timeout', () => {
        req.destroy();
        setTimeout(attempt, intervalMs);
      });

      req.end();
    };

    setTimeout(attempt, 500);
  });
}

async function discoverServer(server) {
  const results = {
    tools: [],
    documentation: '',
    logs: []
  };

  const logPath = path.join(getServerDir(server.id), 'log.txt');
  if (fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '');
  }

  sendLog(server.id, 'DISCOVERY', '=== MCP Server Discovery Started ===');
  sendLog(server.id, 'DISCOVERY', `Server name: ${server.name}`);
  sendLog(server.id, 'DISCOVERY', `Server ID: ${server.id}`);

  let client = null;
  let transport = null;
  let companionProcess = null;

  try {
    const rawConfig = server.config;
    sendLog(server.id, 'CONFIG', `Raw config: ${JSON.stringify(rawConfig, null, 2)}`);

    const config = resolveConfig(rawConfig);
    sendLog(server.id, 'CONFIG', `Resolved config: ${JSON.stringify(config, null, 2)}`);

    const isHttp = config.type === 'http' || config.url;

    if (isHttp) {
      sendLog(server.id, 'TRANSPORT', 'Transport type: HTTP (Streamable HTTP)');

      if (!config.url) {
        throw new Error('HTTP transport requires a "url" field in the config.');
      }

      sendLog(server.id, 'TRANSPORT', `URL: ${config.url}`);

      const urlObj = new URL(config.url);
      sendLog(server.id, 'TRANSPORT', `Protocol: ${urlObj.protocol}`);
      sendLog(server.id, 'TRANSPORT', `Host: ${urlObj.host}`);
      sendLog(server.id, 'TRANSPORT', `Path: ${urlObj.pathname}`);

      if (config.command) {
        sendLog(server.id, 'STARTUP', 'HTTP server has a startup command - starting companion process...');
        sendLog(server.id, 'STARTUP', `Command: ${config.command} ${(config.args || []).join(' ')}`);

        const spawnEnv = { ...process.env };
        if (config.env) {
          Object.assign(spawnEnv, config.env);
          const envKeys = Object.keys(config.env);
          sendLog(server.id, 'STARTUP', `Custom env vars: ${envKeys.join(', ')}`);
          for (const key of envKeys) {
            const val = config.env[key];
            const masked = val.length > 20 ? val.substring(0, 10) + '...' + val.substring(val.length - 6) : val;
            sendLog(server.id, 'STARTUP', `  ${key}=${masked}`);
          }
        }

        // FIX 1: Use shell: true on Windows so .cmd files can be spawned correctly.
        // Without this, Node's spawn cannot execute .cmd scripts directly.
        const spawnOptions = {
          env: spawnEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: process.platform === 'win32'
        };

        if (config.cwd) {
          spawnOptions.cwd = config.cwd;
          sendLog(server.id, 'STARTUP', `Working directory: ${config.cwd}`);
        }

        sendLog(server.id, 'STARTUP', `Shell mode: ${spawnOptions.shell}`);
        sendLog(server.id, 'STARTUP', 'Spawning companion process...');
        companionProcess = spawn(config.command, config.args || [], spawnOptions);

        companionProcess.stdout?.on('data', (chunk) => {
          const text = chunk.toString().trim();
          if (text) {
            sendLog(server.id, 'COMPANION-STDOUT', text);
          }
        });

        companionProcess.stderr?.on('data', (chunk) => {
          const text = chunk.toString().trim();
          if (text) {
            sendLog(server.id, 'COMPANION-STDERR', text);
          }
        });

        companionProcess.on('error', (err) => {
          sendLog(server.id, 'COMPANION-ERROR', `Companion process error: ${err.message}`);
        });

        companionProcess.on('exit', (code, signal) => {
          if (code !== null) {
            sendLog(server.id, 'COMPANION-EXIT', `Companion process exited with code ${code}`);
          } else {
            sendLog(server.id, 'COMPANION-EXIT', `Companion process killed by signal ${signal}`);
          }
        });

        sendLog(server.id, 'STARTUP', `Companion process started (PID: ${companionProcess.pid})`);
        sendLog(server.id, 'STARTUP', `Waiting for HTTP server at ${config.url} to become ready...`);

        try {
          await waitForHttpReady(config.url);
          sendLog(server.id, 'STARTUP', 'Companion process is ready - HTTP server is responding');
        } catch (readyErr) {
          sendLog(server.id, 'ERROR', readyErr.message);
          if (companionProcess && !companionProcess.killed) {
            companionProcess.kill();
          }
          throw readyErr;
        }
      }

      sendLog(server.id, 'CONNECT', 'Creating StreamableHTTPClientTransport...');
      transport = new StreamableHTTPClientTransport(new URL(config.url));

      sendLog(server.id, 'CONNECT', 'Creating MCP Client...');
      client = new Client({
        name: 'mcp-discovery-tool',
        version: '1.0.0'
      }, {
        capabilities: {}
      });

      sendLog(server.id, 'CONNECT', 'Connecting to MCP server via HTTP...');
      const connectStart = Date.now();
      await client.connect(transport);
      const connectTime = Date.now() - connectStart;
      sendLog(server.id, 'CONNECT', `Connected successfully in ${connectTime}ms`);

    } else {
      sendLog(server.id, 'TRANSPORT', 'Transport type: STDIO (subprocess)');

      if (!config.command) {
        throw new Error('STDIO transport requires a "command" field in the config. For HTTP servers, add a "url" field or set "transport" to "http".');
      }

      sendLog(server.id, 'STARTUP', `Command: ${config.command}`);
      sendLog(server.id, 'STARTUP', `Args: ${JSON.stringify(config.args || [])}`);

      const customEnv = config.env || {};
      const envKeys = Object.keys(customEnv);
      if (envKeys.length > 0) {
        sendLog(server.id, 'STARTUP', `Custom env vars: ${envKeys.join(', ')}`);
        for (const key of envKeys) {
          const val = customEnv[key];
          const masked = val.length > 20 ? val.substring(0, 10) + '...' + val.substring(val.length - 6) : val;
          sendLog(server.id, 'STARTUP', `  ${key}=${masked}`);
        }
      } else {
        sendLog(server.id, 'STARTUP', 'No custom environment variables');
      }

      if (config.cwd) {
        sendLog(server.id, 'STARTUP', `Working directory: ${config.cwd}`);
      }

      sendLog(server.id, 'STARTUP', `System PATH: ${process.env.PATH ? process.env.PATH.substring(0, 80) + '...' : '(not set)'}`);

      const transportOptions = {
        command: config.command,
        args: config.args || [],
        env: customEnv,
        stderr: 'pipe'
      };

      if (config.cwd) {
        transportOptions.cwd = config.cwd;
      }

      sendLog(server.id, 'STARTUP', 'Creating StdioClientTransport...');
      transport = new StdioClientTransport(transportOptions);

      transport.stderr?.on('data', (chunk) => {
        const stderrText = chunk.toString().trim();
        if (stderrText) {
          sendLog(server.id, 'STDERR', stderrText);
        }
      });

      sendLog(server.id, 'STARTUP', 'Creating MCP Client...');
      client = new Client({
        name: 'mcp-discovery-tool',
        version: '1.0.0'
      }, {
        capabilities: {}
      });

      sendLog(server.id, 'CONNECT', 'Starting MCP server process and connecting...');
      const connectStart = Date.now();
      await client.connect(transport);
      const connectTime = Date.now() - connectStart;
      sendLog(server.id, 'CONNECT', `MCP server process started and connected in ${connectTime}ms`);
      sendLog(server.id, 'CONNECT', 'MCP handshake completed successfully');
    }

    const serverCapabilities = client.getServerCapabilities();
    sendLog(server.id, 'HANDSHAKE', `Server capabilities: ${JSON.stringify(serverCapabilities || {})}`);

    const serverVersion = client.getServerVersion();
    if (serverVersion) {
      sendLog(server.id, 'HANDSHAKE', `Server info: ${serverVersion.name} v${serverVersion.version || 'unknown'}`);
    }

    const instructions = client.getInstructions();
    if (instructions) {
      sendLog(server.id, 'HANDSHAKE', `Server instructions: ${instructions.substring(0, 200)}${instructions.length > 200 ? '...' : ''}`);
    }

    if (!serverCapabilities || !serverCapabilities.tools) {
      sendLog(server.id, 'WARNING', 'Server does not advertise tools capability. Attempting tools/list anyway...');
    }

    sendLog(server.id, 'DISCOVERY', 'Requesting tools list (tools/list)...');
    const toolsStart = Date.now();
    const toolsResponse = await client.listTools();
    const toolsTime = Date.now() - toolsStart;

    const tools = toolsResponse.tools || [];
    sendLog(server.id, 'DISCOVERY', `Received ${tools.length} tool(s) in ${toolsTime}ms`);

    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i];
      sendLog(server.id, 'TOOL', `[${i + 1}/${tools.length}] ${tool.name}${tool.description ? ' - ' + tool.description.substring(0, 100) : ''}`);
      if (tool.inputSchema && tool.inputSchema.properties) {
        const paramNames = Object.keys(tool.inputSchema.properties);
        const requiredParams = tool.inputSchema.required || [];
        sendLog(server.id, 'TOOL', `  Parameters: ${paramNames.map(p => p + (requiredParams.includes(p) ? '*' : '')).join(', ') || 'none'}`);
      } else {
        sendLog(server.id, 'TOOL', '  Parameters: none');
      }
    }

    if (tools.length === 0) {
      sendLog(server.id, 'WARNING', 'No tools discovered. The server may not expose any tools, or tools may require specific capabilities.');
    }

    results.tools = tools;

    results.documentation = generateDocumentation(server, tools, serverVersion, serverCapabilities);
    sendLog(server.id, 'DISCOVERY', 'Generated documentation');

    const readmePath = path.join(getServerDir(server.id), 'readme.md');
    fs.writeFileSync(readmePath, results.documentation);
    sendLog(server.id, 'DISCOVERY', 'Saved documentation to readme.md');

    const toolsDataPath = path.join(getServerDir(server.id), 'tools.json');
    fs.writeFileSync(toolsDataPath, JSON.stringify(tools, null, 2));
    sendLog(server.id, 'DISCOVERY', 'Saved tools data to tools.json');

    sendLog(server.id, 'DISCOVERY', '=== Discovery Completed Successfully ===');

  } catch (error) {
    sendLog(server.id, 'ERROR', `Discovery failed: ${error.message}`);

    if (error.stack) {
      const stackLines = error.stack.split('\n').slice(0, 5);
      for (const line of stackLines) {
        sendLog(server.id, 'ERROR', `  ${line.trim()}`);
      }
    }

    if (error.cause) {
      sendLog(server.id, 'ERROR', `Caused by: ${error.cause.message || error.cause}`);
    }

    throw error;
  } finally {
    if (client) {
      try {
        sendLog(server.id, 'CLEANUP', 'Closing MCP client connection...');
        await client.close();
        sendLog(server.id, 'CLEANUP', 'MCP client connection closed');
      } catch (closeError) {
        sendLog(server.id, 'WARNING', `Error closing client: ${closeError.message}`);
      }
    }
    if (companionProcess && !companionProcess.killed) {
      try {
        sendLog(server.id, 'CLEANUP', 'Stopping companion process...');
        companionProcess.kill();
        sendLog(server.id, 'CLEANUP', 'Companion process stopped');
      } catch (killError) {
        sendLog(server.id, 'WARNING', `Error stopping companion process: ${killError.message}`);
      }
    }
  }

  return results;
}

function generateDocumentation(server, tools, serverVersion, serverCapabilities) {
  let header = `# ${server.name}\n\n`;

  if (serverVersion) {
    header += `**Server:** ${serverVersion.name || 'Unknown'}`;
    if (serverVersion.version) {
      header += ` v${serverVersion.version}`;
    }
    header += '\n\n';
  }

  header += `MCP Server providing tools for AI agents.\n\n`;

  if (serverCapabilities) {
    const caps = [];
    if (serverCapabilities.tools) caps.push('tools');
    if (serverCapabilities.prompts) caps.push('prompts');
    if (serverCapabilities.resources) caps.push('resources');
    if (serverCapabilities.logging) caps.push('logging');
    if (serverCapabilities.completions) caps.push('completions');
    if (caps.length > 0) {
      header += `**Capabilities:** ${caps.join(', ')}\n\n`;
    }
  }

  const toolDocs = tools.map(tool => {
    let doc = `### ${tool.name}\n\n`;
    if (tool.description) {
      doc += `${tool.description}\n\n`;
    }

    if (tool.inputSchema && tool.inputSchema.properties) {
      doc += `**Parameters:**\n\n`;
      const props = tool.inputSchema.properties;
      const required = tool.inputSchema.required || [];
      for (const [name, prop] of Object.entries(props)) {
        const type = prop.type || 'any';
        const req = required.includes(name) ? ' (required)' : ' (optional)';
        doc += `- \`${name}\` (${type})${req}`;
        if (prop.description) {
          doc += `: ${prop.description}`;
        }
        if (prop.default !== undefined) {
          doc += ` [default: ${JSON.stringify(prop.default)}]`;
        }
        if (prop.enum) {
          doc += ` [enum: ${prop.enum.join(', ')}]`;
        }
        doc += `\n`;
      }
    } else {
      doc += `**Parameters:** none\n\n`;
    }

    return doc;
  }).join('\n');

  header += `## Tools\n\n` +
    (toolDocs || '_No tools available._') +
    `\n\n---\n\n` +
    `Generated by MCP Discovery Tool on ${new Date().toISOString()}\n`;

  return header;
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

function getServerTools(id) {
  const toolsPath = path.join(getServerDir(id), 'tools.json');
  if (fs.existsSync(toolsPath)) {
    try {
      return JSON.parse(fs.readFileSync(toolsPath, 'utf-8'));
    } catch (e) {
      return [];
    }
  }
  return [];
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

// FIX 2: Corrected event name from 'window-all-quit' (invalid) to 'window-all-closed'.
app.on('window-all-closed', () => {
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

ipcMain.handle('get-tools', async (event, id) => {
  return getServerTools(id);
});