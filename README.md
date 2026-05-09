# MCP Discovery Tool

A desktop application for discovering and managing MCP (Model Context Protocol) servers. This tool helps you connect to MCP servers, discover their available tools, and generate documentation automatically.

## Features

- **Server Management**: Add, edit, and remove MCP server configurations
- **Auto-Discovery**: Automatically discover available tools from MCP servers
- **Documentation Generation**: Automatically generate README.md documentation for each server
- **Dual Transport Support**: Connect via HTTP or STDIO transport
- **Activity Logging**: Track all operations with detailed logs

## Prerequisites

Before installing, ensure you have the following:

- **Node.js** (v18 or higher)
- **npm** (comes with Node.js)
- **Electron** (installed automatically via npm)

## Installation

1. **Clone or download the repository**

2. **Install dependencies**
   ```bash
   npm install
   ```

   This will install:
   - `@modelcontextprotocol/sdk` - The MCP SDK for connecting to servers
   - `electron` - The desktop application framework

## Running the Application

### Development Mode
```bash
npm run dev
```
Runs the app with logging enabled for debugging.

### Production Mode
```bash
npm start
```
Runs the app in normal mode.

## Using the MCP Discovery Tool

### Adding an MCP Server

1. Launch the application
2. Click the "Add Server" button
3. Fill in the server details:

#### For HTTP Transport Servers
| Field | Description |
|-------|-------------|
| Name | A friendly name for your server |
| URL | The HTTP endpoint of the MCP server (e.g., `http://localhost:3000/mcp`) |

#### For STDIO Transport Servers
| Field | Description |
|-------|-------------|
| Name | A friendly name for your server |
| Command | The command to run the server (e.g., `npx`, `node`) |
| Arguments | Space-separated arguments (e.g., `mcp-server run`) |
| Environment Variables | Optional key-value pairs (one per line, format: `KEY=value`) |

### Discovering Server Tools

1. Select a server from the list
2. Click the "Discover" button
3. The tool will:
   - Connect to the MCP server
   - Request the list of available tools
   - Generate documentation
   - Save a `readme.md` file in the server's data directory

### Viewing Server Details

Click on any server to view:
- Server configuration
- Discovery logs
- Generated documentation
- Available tools and their parameters

### Editing a Server

1. Select the server
2. Click the "Edit" button
3. Modify the configuration
4. Click "Save"

### Deleting a Server

1. Select the server
2. Click the "Delete" button
3. Confirm the deletion

## Data Storage

The application stores data in the following structure:

```
data/mcp-servers/
└── {server-id}/
    ├── data.json      # Server metadata
    ├── config.json   # Server configuration
    ├── readme.md     # Generated documentation
    └── log.txt       # Activity logs
```

## Troubleshooting

### Connection Issues

**HTTP Connection Failed**
- Verify the server URL is correct
- Check if the MCP server is running
- Ensure there are no firewall blocking the connection

**STDIO Connection Failed**
- Verify the command and arguments are correct
- Ensure the required packages are installed
- Check the logs for specific error messages

### Common Issues

1. **"Transport not specified"**: Make sure to fill in either the URL field (for HTTP) or the command field (for STDIO).

2. **"Module not found"**: Run `npm install` again to ensure all dependencies are installed.

3. **App doesn't start**: Make sure you're in the correct directory and Node.js is properly installed:
   ```bash
   node --version
   npm --version
   ```

### Viewing Logs

Each server has its own log file in `data/mcp-servers/{server-id}/log.txt`. Check these logs for detailed information about connection attempts and errors.

## Example MCP Server Configurations

### Example 1: HTTP Server
```json
{
  "name": "My HTTP Server",
  "transport": "http",
  "url": "http://localhost:3000/mcp"
}
```

### Example 2: STDIO Server (npx)
```json
{
  "name": "My STDIO Server",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@some/mcp-server"]
}
```

### Example 3: Local Node.js Server
```json
{
  "name": "Local Server",
  "transport": "stdio",
  "command": "node",
  "args": ["/path/to/server.js"],
  "env": {
    "PORT": "3000"
  }
}
```

## Development

### Project Structure

```
mcp-discovery/
├── src/
│   ├── main.js        # Electron main process
│   ├── preload.js     # Preload script (IPC bridge)
│   ├── renderer.js    # Renderer process logic
│   ├── index.html     # Main UI
│   └── styles.css     # Styling
├── data/
│   └── mcp-servers/  # Server data storage
├── package.json       # Project dependencies
└── README.md          # This file
```

### Building for Production

To create a production build, you would need additional tools like `electron-builder`. This is not included by default but can be added:

```bash
npm install electron-builder --save-dev
npx electron-builder --win
```

## License

ISC
