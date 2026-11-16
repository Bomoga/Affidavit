import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configFromEnv, createHttpApi } from './api-client.js';
import { createAffidavitMcpServer } from './server.js';

const api = createHttpApi(configFromEnv(process.env));
await createAffidavitMcpServer(api).connect(new StdioServerTransport());
