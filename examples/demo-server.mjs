import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const label = process.argv[2] ?? 'demo';
const server = new McpServer({ name: label, version: '1.0.0' });
server.registerTool(
  'echo',
  {
    description: `Echo text from ${label}`,
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({ content: [{ type: 'text', text: `${label}: ${text}` }] }),
);
await server.connect(new StdioServerTransport());
