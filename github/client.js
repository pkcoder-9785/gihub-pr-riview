import { Octokit } from 'octokit';
import { createAppAuth } from '@octokit/auth-app';
export function installationClient(config, installationId) {
  return new Octokit({ authStrategy: createAppAuth, auth: { appId: config.appId, privateKey: config.privateKey, installationId }, retry: { enabled: false }, throttle: { enabled: false }, log: { debug() {}, info() {}, warn() {}, error() {} } });
}
