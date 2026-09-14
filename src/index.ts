import { loadConfig } from './config.js';
import { createGateway } from './gateway.js';

try {
  const config = await loadConfig(process.env.MCP_GATEWAY_CONFIG ?? 'mcp-gateway.json');
  const gateway = await createGateway(config);
  const http = gateway.app.listen(config.port, config.host, () => {
    console.log(
      JSON.stringify({
        event: 'listening',
        host: config.host,
        port: (http.address() as { port: number }).port,
        publicUrl: config.publicUrl,
      }),
    );
  });
  http.requestTimeout = 15000;
  http.headersTimeout = 10000;
  http.keepAliveTimeout = 5000;
  http.on('error', async (error) => {
    console.error('HTTP server failed:', error.message);
    await gateway.close();
    process.exitCode = 1;
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10000).unref();
    http.close();
    await gateway.close();
    http.closeAllConnections();
    clearTimeout(deadline);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (error) {
  console.error('Gateway startup failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
