import { createModel } from './model.mjs';
import { config } from './config.mjs';

const model = createModel();
try {
  const identity = await model.verify();
  console.log(JSON.stringify({ status: 'identity_verified', ...identity, endpoint: config.baseURL, deployment: config.deployment, dataDir: config.dataDir, note: 'No LLM call made. Run npm.cmd run test:live for a billable inference test.' }, null, 2));
} catch (error) {
  console.error(`Doctor failed: ${error.message}`);
  process.exitCode = 1;
}