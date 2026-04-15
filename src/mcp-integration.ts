/**
 * MCP (Model Context Protocol) integration for picord.
 *
 * Supports connecting to MCP servers configured in ~/.pi/mcp.json.
 * Built-in MCP servers are auto-configured:
 *   - Exa (web search): always enabled; uses MCP OAuth flow or optional API key
 *
 * Tools from MCP servers are exposed as custom tools.
 *
 * MCP support is optional. If the @modelcontextprotocol/sdk is not installed,
 * MCP functionality is silently disabled.
 */

import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";
import { Type, type TSchema, type Static } from "@sinclair/typebox";
import type { ToolDefinition, AgentToolResult } from "@mariozechner/pi-coding-agent";

// MCP SDK module references (loaded dynamically)
type MCPModule = {
  Client: new (info: { name: string; version: string }) => MCPClient;
};
type MCPStdioModule = {
  StdioClientTransport: new (params: {
    command: string;
    args: string[];
    env: Record<string, string>;
    stderr: "pipe" | "inherit" | "ignore";
    cwd: string;
  }) => MCPTransport;
};
type MCPSseModule = {
  SSEClientTransport: new (url: URL) => MCPTransport;
};
type MCPStreamableHttpModule = {
  StreamableHTTPClientTransport: new (url: URL, options?: { requestInit?: RequestInit }) => MCPTransport;
};

let mcpSdkModule: MCPModule | null | undefined;
let mcpStdioModule: MCPStdioModule | null | undefined;
let mcpSseModule: MCPSseModule | null | undefined;
let mcpStreamableHttpModule: MCPStreamableHttpModule | null | undefined;

// MCP type definitions
export interface MCPServerConfig {
  name?: string;
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface MCPConfig {
  servers: Record<string, MCPServerConfig>;
}

export interface MCPWrappedTool {
  tool: ToolDefinition;
}

type MCPClient = {
  connect(transport: MCPTransport): Promise<void>;
  listTools(): Promise<{ tools: MCPTool[] }>;
  callTool(
    request: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<MCPCallToolResult>;
  close?(): void;
};

type MCPTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type MCPCallToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string }>;
};

type MCPTransport = unknown;

/**
 * Check if MCP SDK is available.
 */
export async function isMCPSupported(): Promise<boolean> {
  if (mcpSdkModule !== undefined) return mcpSdkModule !== null;
  try {
    const sdkMod = await import("@modelcontextprotocol/sdk/client/index.js") as unknown;
    const stdioMod = await import("@modelcontextprotocol/sdk/client/stdio.js") as unknown;
    const sseMod = await import("@modelcontextprotocol/sdk/client/sse.js") as unknown;
    mcpSdkModule = sdkMod as MCPModule;
    mcpStdioModule = stdioMod as MCPStdioModule;
    mcpSseModule = sseMod as MCPSseModule;

    // Streamable HTTP transport is optional (newer SDK versions)
    try {
      const httpMod = await import("@modelcontextprotocol/sdk/client/streamableHttp.js") as unknown;
      mcpStreamableHttpModule = httpMod as MCPStreamableHttpModule;
    } catch {
      mcpStreamableHttpModule = null;
    }

    return true;
  } catch {
    mcpSdkModule = null;
    mcpStdioModule = null;
    mcpSseModule = null;
    mcpStreamableHttpModule = null;
    return false;
  }
}

/**
 * Load MCP configuration from ~/.pi/mcp.json.
 */
export function loadMCPConfig(): MCPConfig | undefined {
  const configPath = path.join(homedir(), ".pi", "mcp.json");
  if (!fs.existsSync(configPath)) {
    return undefined;
  }
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(content) as MCPConfig;
    if (!config.servers || typeof config.servers !== "object") {
      return undefined;
    }
    return config;
  } catch {
    return undefined;
  }
}

/**
 * Build built-in MCP server configurations.
 *
 * Exa is always enabled. If an API key is provided it is sent as a header;
 * otherwise the Exa hosted server handles auth via MCP OAuth flow
 * (users authenticate in-browser, no pre-existing key required).
 */
export function buildBuiltInMCPConfig(options?: {
  exaApiKey?: string;
}): MCPConfig {
  const servers: Record<string, MCPServerConfig> = {};

  servers["exa"] = {
    name: "Exa Search",
    transport: "streamable-http",
    url: "https://mcp.exa.ai/mcp",
    ...(options?.exaApiKey ? { headers: { "x-api-key": options.exaApiKey } } : {}),
  };

  return { servers };
}

/**
 * Merge built-in and user MCP configs. Built-in servers take precedence
 * if a user configures a server with the same ID.
 */
function mergeMCPConfigs(
  builtIn: MCPConfig | undefined,
  user: MCPConfig | undefined,
): MCPConfig {
  const servers: Record<string, MCPServerConfig> = {};

  if (user?.servers) {
    Object.assign(servers, user.servers);
  }

  if (builtIn?.servers) {
    // Built-in servers override user servers with the same key
    Object.assign(servers, builtIn.servers);
  }

  return { servers };
}

/**
 * Convert a JSON Schema property to a TypeBox type.
 * Handles nested objects recursively.
 */
function jsonSchemaPropertyToTypeBox(prop: Record<string, unknown>): TSchema {
  const type = prop.type as string;

  switch (type) {
    case "string":
      if (prop.enum) {
        return Type.Union(
          (prop.enum as string[]).map((v) => Type.Literal(v)),
        );
      }
      return Type.String(
        prop.description ? { description: prop.description as string } : undefined,
      );
    case "number":
    case "integer":
      return Type.Number(
        prop.description ? { description: prop.description as string } : undefined,
      );
    case "boolean":
      return Type.Boolean();
    case "array": {
      const items = prop.items as Record<string, unknown> | undefined;
      return Type.Array(
        items ? jsonSchemaPropertyToTypeBox(items) : Type.Any(),
      );
    }
    case "object": {
      const nestedProps = prop.properties as Record<string, Record<string, unknown>> | undefined;
      if (!nestedProps) return Type.Record(Type.String(), Type.Any());
      const required = prop.required as string[] | undefined;
      const tbProps: Record<string, TSchema> = {};
      for (const [key, value] of Object.entries(nestedProps)) {
        tbProps[key] = jsonSchemaPropertyToTypeBox(value);
      }
      if (required && required.length > 0) {
        return Type.Object(tbProps, { required });
      }
      return Type.Object(tbProps);
    }
    default:
      return Type.Any();
  }
}

/**
 * Convert MCP tool inputSchema to TypeBox.
 */
function mcpSchemaToTypeBox(inputSchema?: Record<string, unknown>): TSchema {
  if (!inputSchema || inputSchema.type !== "object") {
    return Type.Object({});
  }
  return jsonSchemaPropertyToTypeBox(inputSchema);
}

/**
 * Create MCP transport for a server configuration.
 */
function createMCPTransport(config: MCPServerConfig): MCPTransport {
  if (config.transport === "streamable-http" && config.url) {
    if (!mcpStreamableHttpModule) {
      throw new Error(
        "MCP SDK does not support streamable-http transport. Update @modelcontextprotocol/sdk or use stdio/sse.",
      );
    }

    const options: { requestInit?: RequestInit } = {};
    if (config.headers && Object.keys(config.headers).length > 0) {
      options.requestInit = {
        headers: config.headers,
      };
    }

    return new mcpStreamableHttpModule.StreamableHTTPClientTransport(
      new URL(config.url),
      options,
    );
  }

  if (!mcpStdioModule || !mcpSseModule) {
    throw new Error("MCP SDK not available");
  }

  if (config.transport === "sse" && config.url) {
    return new mcpSseModule.SSEClientTransport(new URL(config.url));
  }

  if (!config.command) {
    throw new Error("MCP config missing command for stdio transport");
  }

  return new mcpStdioModule.StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: config.env ?? {},
    stderr: "pipe",
    cwd: process.cwd(),
  });
}

/**
 * Wrap MCP tool as pi-coding-agent ToolDefinition.
 */
function wrapMCPTool(
  client: MCPClient,
  mcpTool: MCPTool,
  serverName: string,
): MCPWrappedTool {
  const parameters = mcpSchemaToTypeBox(mcpTool.inputSchema);
  const toolName = `mcp_${serverName}_${mcpTool.name}`.replace(/[^a-zA-Z0-9_]/g, "_");

  const tool: ToolDefinition = {
    name: toolName,
    label: `${mcpTool.name} (${serverName})`,
    description: mcpTool.description || `MCP tool from ${serverName}`,
    parameters,
    promptSnippet: mcpTool.description,
    async execute(
      _toolCallId: string,
      params: Static<typeof parameters>,
      _signal: AbortSignal | undefined,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const result = await client.callTool(
          { name: mcpTool.name, arguments: params as Record<string, unknown> },
          undefined,
          _signal ? { signal: _signal } : undefined,
        );

        // Convert MCP content items to TextContent
        const content: Array<{ type: "text"; text: string }> = [];
        for (const item of result.content) {
          if (item.type === "text") {
            content.push({ type: "text", text: item.text });
          } else if (item.type === "image") {
            content.push({ type: "text", text: `[Image: ${item.mimeType}]` });
          }
        }

        return { content, details: result };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: undefined,
        };
      }
    },
  };

  return { tool };
}

/**
 * Active MCP connections for cleanup.
 */
const activeMCPConnections: { serverId: string; client: MCPClient }[] = [];

/**
 * Load MCP tools from configured servers.
 *
 * MCP support is optional. If SDK not installed, returns empty arrays.
 *
 * @param options.exaApiKey - Optional Exa API key to skip OAuth; without it Exa uses MCP OAuth flow
 */
export async function loadMCPTools(options?: {
  exaApiKey?: string;
}): Promise<{
  tools: MCPWrappedTool[];
}> {
  if (!(await isMCPSupported())) {
    return { tools: [] };
  }

  const builtInConfig = buildBuiltInMCPConfig({
    exaApiKey: options?.exaApiKey,
  });
  const userConfig = loadMCPConfig();
  const config = mergeMCPConfigs(builtInConfig, userConfig);

  const wrappedTools: MCPWrappedTool[] = [];

  const ClientClass = mcpSdkModule?.Client;
  if (!ClientClass) {
    return { tools: [] };
  }

  for (const [serverId, serverConfig] of Object.entries(config.servers)) {
    const client = new ClientClass({
      name: serverConfig.name || "picord-mcp",
      version: "1.0.0",
    });

    try {
      const transport = createMCPTransport(serverConfig);
      await client.connect(transport);
      activeMCPConnections.push({ serverId, client });

      const toolsResult = await client.listTools();
      for (const mcpTool of toolsResult.tools) {
        const wrapped = wrapMCPTool(client, mcpTool, serverId);
        wrappedTools.push(wrapped);
      }

      console.log(
        `[picord-MCP] Loaded ${toolsResult.tools.length} tools from server "${serverId}"`,
      );
    } catch (error) {
      console.error(
        `[picord-MCP] Failed to connect to server "${serverId}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { tools: wrappedTools };
}

/**
 * Get MCP diagnostics for troubleshooting.
 */
export async function getMCPDiagnostics(options?: {
  exaApiKey?: string;
}): Promise<{
  sdkInstalled: boolean;
  streamableHttpSupported: boolean;
  builtInServers: string[];
  userConfigPath: string | undefined;
  userServers: string[];
}> {
  const sdkInstalled = await isMCPSupported();
  return {
    sdkInstalled,
    streamableHttpSupported: mcpStreamableHttpModule !== null && mcpStreamableHttpModule !== undefined,
    builtInServers: Object.keys(buildBuiltInMCPConfig({ exaApiKey: options?.exaApiKey }).servers),
    userConfigPath: loadMCPConfig() ? "~/.pi/mcp.json" : undefined,
    userServers: Object.keys(loadMCPConfig()?.servers ?? {}),
  };
}

/**
 * Close all MCP connections.
 */
export function closeMCPConnections(): void {
  for (const conn of activeMCPConnections) {
    try {
      conn.client.close?.();
      console.log(`[picord-MCP] Closed connection to server "${conn.serverId}"`);
    } catch (error) {
      console.error(
        `[picord-MCP] Error closing server "${conn.serverId}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  activeMCPConnections.length = 0;
}
