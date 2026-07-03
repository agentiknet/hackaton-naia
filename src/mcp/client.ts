import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface MoulineuseClientOptions {
  url?: string;
  token?: string;
}

function resolveOptions(options?: MoulineuseClientOptions): Required<MoulineuseClientOptions> {
  const url = options?.url ?? process.env.MCP_MOULINEUSE_URL;
  const token = options?.token ?? process.env.MCP_MOULINEUSE_TOKEN;

  if (!url) {
    throw new Error("MCP_MOULINEUSE_URL is not set");
  }
  if (!token) {
    throw new Error("MCP_MOULINEUSE_TOKEN is not set");
  }

  return { url, token };
}

export class MoulineuseClient {
  private client: Client | null = null;
  private readonly options: Required<MoulineuseClientOptions>;

  constructor(options?: MoulineuseClientOptions) {
    this.options = resolveOptions(options);
  }

  async connect(): Promise<void> {
    if (this.client) return;

    const transport = new StreamableHTTPClientTransport(new URL(this.options.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${this.options.token}` },
      },
    });

    const client = new Client({ name: "naia", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  private ensureConnected(): Client {
    if (!this.client) {
      throw new Error("MoulineuseClient is not connected — call connect() first");
    }
    return this.client;
  }

  async listTools() {
    const client = this.ensureConnected();
    return client.listTools();
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const client = this.ensureConnected();
    return client.callTool({ name, arguments: args });
  }
}
