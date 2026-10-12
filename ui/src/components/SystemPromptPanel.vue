<script setup lang="ts">
import type { RuntimePromptPreview } from '../types';

defineProps<{ preview: RuntimePromptPreview }>();
</script>

<template>
  <section class="card border border-base-300 bg-base-200/70" data-testid="system-prompt-panel">
    <div class="card-body gap-4 p-4 sm:p-5">
      <header class="flex items-start gap-3">
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/15 text-lg"
          >📝</span
        >
        <div class="min-w-0">
          <h1 class="card-title text-base">System Prompt</h1>
          <p class="text-xs opacity-65">
            Exact system message assembled for the active chat’s next reply. It updates with chat
            settings and skills attached to the current draft.
          </p>
        </div>
      </header>

      <div class="grid gap-3 rounded-box border border-base-300 bg-base-100/60 p-3 sm:grid-cols-2">
        <div class="min-w-0">
          <p class="text-[10px] font-semibold uppercase tracking-wide opacity-50">Model</p>
          <p class="truncate text-sm font-medium">{{ preview.modelLabel }}</p>
          <p class="truncate font-mono text-[10px] opacity-55">{{ preview.modelId || '—' }}</p>
        </div>
        <div>
          <p class="text-[10px] font-semibold uppercase tracking-wide opacity-50">Prompt style</p>
          <p class="text-sm font-medium">{{ preview.styleName }}</p>
          <p class="font-mono text-[10px] opacity-55">
            {{ preview.modelSource === 'local' ? preview.modelStyle : 'cloud provider adapter' }}
          </p>
        </div>
        <div>
          <p class="text-[10px] font-semibold uppercase tracking-wide opacity-50">Tools & access</p>
          <p class="text-xs">
            {{ preview.toolsEnabled ? 'Script and agent tools enabled' : 'Tools disabled' }}
            <span v-if="preview.webEnabled"> · web access on</span>
            <span v-else-if="preview.toolsEnabled"> · web access off</span>
          </p>
          <p class="mt-1 text-[11px] opacity-65">
            MCP selection:
            <template v-if="preview.modelSource === 'cloud'">not used for cloud replies</template>
            <template v-else-if="!preview.toolsEnabled">not injected (tools are off)</template>
            <template v-else>{{ preview.mcpServers.join(', ') || 'none selected' }}</template>
          </p>
        </div>
        <div>
          <p class="text-[10px] font-semibold uppercase tracking-wide opacity-50">
            Current draft skills
          </p>
          <p class="text-xs">{{ preview.skills.join(', ') || 'None attached' }}</p>
          <p v-if="preview.hasCustomPrompt" class="mt-1 text-[11px] text-warning">
            <template v-if="preview.modelSource === 'local'">
              Custom prompt replaces generated instructions; local style and skill bodies are not
              appended.
            </template>
            <template v-else>
              Custom prompt is combined with the attached skills and selected style.
            </template>
          </p>
        </div>
      </div>

      <div class="overflow-hidden rounded-box border border-base-300 bg-base-100">
        <div class="flex items-center justify-between gap-3 border-b border-base-300 px-3 py-2">
          <h2 class="text-xs font-semibold">System message sent on the next reply</h2>
          <span v-if="preview.status === 'ready'" class="badge badge-success badge-xs"
            >current</span
          >
          <span v-else-if="preview.status === 'loading'" class="badge badge-ghost badge-xs">
            updating
          </span>
          <span v-else class="badge badge-error badge-xs">unavailable</span>
        </div>

        <p
          v-if="preview.status === 'loading'"
          class="flex items-center gap-2 p-4 text-xs opacity-65"
        >
          <span class="loading loading-spinner loading-xs" /> Assembling this chat’s runtime prompt…
        </p>
        <div
          v-else-if="preview.status === 'error'"
          class="alert alert-error m-3 w-auto py-2 text-xs"
          role="alert"
        >
          {{ preview.error || 'The system prompt could not be generated.' }}
        </div>
        <pre
          v-else
          class="max-h-[65vh] overflow-auto p-4 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words"
          data-testid="runtime-system-prompt"
          >{{ preview.prompt || '(No system message is sent for this chat.)' }}</pre>
      </div>
    </div>
  </section>
</template>
