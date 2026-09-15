import OpenAI from 'openai';
import { AzureDeveloperCliCredential } from '@azure/identity';
import { setTimeout as delay } from 'node:timers/promises';
import { config, validateConfiguration } from './config.mjs';

export function validateIdentity(claims, expected = config) {
  if (claims.tid !== expected.tenantId) throw new Error('Entra tenant does not match the workshop tenant.');
  const account = (claims.upn || claims.preferred_username || '').toLowerCase();
  if (account !== expected.account.toLowerCase()) throw new Error('Entra account does not match the configured workshop account. Sign in again with the workshop account.');
  return { tenantId: claims.tid, account };
}

export function requestSpacing(estimatedTokens) {
  return Math.max(Math.ceil(60000 / config.requestsPerMinute) + 500, Math.ceil(estimatedTokens / config.tokensPerMinute * 60000));
}

export function createModel() {
  const credential = new AzureDeveloperCliCredential({ tenantId: config.tenantId, processTimeoutInMs: 30_000 });
  let identity;
  let lastRequest = 0;
  async function authenticate() {
    validateConfiguration();
    const access = await credential.getToken('https://ai.azure.com/.default');
    if (!access?.token) throw new Error('Entra did not return an access token.');
    const claims = JSON.parse(Buffer.from(access.token.split('.')[1], 'base64url').toString());
    identity = validateIdentity(claims);
    return access.token;
  }
  const client = new OpenAI({ baseURL: config.baseURL, apiKey: authenticate, maxRetries: 2, timeout: 90_000 });
  return {
    get identity() { return identity; },
    async verify() { await authenticate(); return identity; },
    async complete(messages, tools, { signal, toolChoice, onWait = () => {} } = {}) {
      const estimatedTokens = Math.ceil((JSON.stringify(messages).length + JSON.stringify(tools).length) / 3) + 2200;
      const spacing = requestSpacing(estimatedTokens);
      const waitMs = Math.max(0, spacing - (Date.now() - lastRequest));
      if (waitMs) {
        await onWait(waitMs);
        await delay(waitMs, undefined, { signal });
      }
      signal?.throwIfAborted();
      lastRequest = Date.now();
      const { data, request_id } = await client.chat.completions.create({
        model: config.deployment, messages, tools: tools.length ? tools : undefined,
        parallel_tool_calls: tools.length ? false : undefined,
        tool_choice: tools.length ? toolChoice : undefined,
        max_completion_tokens: 2200,
      }, { signal }).withResponse();
      const choice = data.choices[0];
      if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason)) {
        throw new Error(`The model stopped before completing: ${choice?.finish_reason || 'no choice'}.`);
      }
      return { message: choice.message, usage: data.usage, requestId: request_id, id: data.id, model: data.model };
    },
  };
}