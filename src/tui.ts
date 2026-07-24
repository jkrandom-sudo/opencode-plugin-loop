import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

// Since 0.7.0 every /loop result is presented inline by the model (Claude
// Code style), so the TUI companion no longer renders dialogs or toasts.
// The entrypoint is kept as a no-op so OpenCode installs that auto-load both
// package entrypoints keep working.
export function createLoopTuiPlugin(): TuiPlugin {
  return async () => {}
}

export const LoopTuiPlugin = createLoopTuiPlugin()

const module: TuiPluginModule = {
  id: "opencode-plugin-loop-tui",
  tui: LoopTuiPlugin,
}

export default module
