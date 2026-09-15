import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
const emptyId = '00000000-0000-0000-0000-000000000000';
const positiveInteger = (name, fallback) => {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
};
export const config = Object.freeze({
  tenantId: process.env.FOUNDRY_TENANT_ID || emptyId,
  account: process.env.FOUNDRY_ACCOUNT || 'learner@example.invalid',
  subscriptionId: process.env.FOUNDRY_SUBSCRIPTION_ID || emptyId,
  resourceId: process.env.FOUNDRY_RESOURCE_ID || 'not-configured',
  baseURL: process.env.FOUNDRY_BASE_URL || 'https://configure-me.openai.azure.com/openai/v1/',
  deployment: process.env.FOUNDRY_DEPLOYMENT || 'configure-me',
  requestsPerMinute: positiveInteger('FOUNDRY_RPM', 50),
  tokensPerMinute: positiveInteger('FOUNDRY_TPM', 50000),
  dataDir: path.resolve(process.env.HARNESS_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'AgentHarnessWorkshop')),
  documentsDir: path.join(root, 'data', 'documents'),
  port: positiveInteger('PORT', 4317),
});

export function validateConfiguration() {
  if (config.tenantId === emptyId || config.account.endsWith('.invalid') || config.deployment === 'configure-me') {
    throw new Error('Configure FOUNDRY_TENANT_ID, FOUNDRY_ACCOUNT, FOUNDRY_BASE_URL and FOUNDRY_DEPLOYMENT in .env before authentication.');
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(config.tenantId)) throw new Error('FOUNDRY_TENANT_ID must be a tenant GUID.');
  const endpoint = new URL(config.baseURL);
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.openai.azure.com') || endpoint.hostname === 'configure-me.openai.azure.com' || endpoint.pathname !== '/openai/v1/' || endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash) {
    throw new Error('FOUNDRY_BASE_URL must be https://YOUR-RESOURCE.openai.azure.com/openai/v1/ without credentials or query parameters.');
  }
  return true;
}