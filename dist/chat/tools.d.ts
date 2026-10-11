import type { AlertBus } from '../capabilities/alerts.js';
import type { McpManager } from '../mcp/manager.js';
import type { ScriptRegistry } from '../scripts/registry.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { ChatToolCall } from './types.js';
export declare const BUILTIN_TOOLS: readonly ["listScripts", "searchScripts", "readScript", "describeScript", "createScript", "updateScript", "removeScript", "runScript", "scriptStats", "webSearch", "webFetch", "listSkills", "readSkill", "createSkill", "showAlert"];
declare function asRecord(value: unknown): Record<string, unknown> | undefined;
/**
 * Extract candidate calls from a model reply.
 * Returns the calls plus the reply text with the blocks removed, so the UI can
 * show only the human-readable remainder.
 */
export declare function extractToolCalls(text: string, options?: {
    knownScripts?: readonly string[];
}): {
    calls: ChatToolCall[];
    rest: string;
};
export interface DispatchOptions {
    registry: ScriptRegistry;
    /** Allow `runScript` and script execution at all. */
    allowRun?: boolean;
    /** Skill library, used by listSkills/readSkill/createSkill. */
    skills?: SkillRegistry;
    /** Connected MCP servers, addressed as `server__tool`. */
    mcp?: McpManager;
    /** Internet capabilities (webSearch/webFetch). */
    net?: boolean;
    /** Alert display, used by showAlert. */
    alerts?: AlertBus;
}
/** Execute one parsed call against the script toolbox. */
export declare function dispatchTool(call: ChatToolCall, options: DispatchOptions): Promise<ChatToolCall>;
export { asRecord };
//# sourceMappingURL=tools.d.ts.map