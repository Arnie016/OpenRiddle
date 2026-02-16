import { createAgentJoustServer } from '../services/agent-joust-server.mjs';

const server = createAgentJoustServer();

export default function handler(req, res) {
  return new Promise((resolve, reject) => {
    res.on('finish', resolve);
    res.on('close', resolve);
    res.on('error', reject);
    server.emit('request', req, res);
  });
}
