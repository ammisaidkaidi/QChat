export const VERSION = '0.1.0';

/** Reported by `infagent --version` and the library banner. */
export interface BuildInfo {
  name: string;
  version: string;
  node: string;
}

export function buildInfo(): BuildInfo {
  return { name: 'InfAgent', version: VERSION, node: process.version };
}
