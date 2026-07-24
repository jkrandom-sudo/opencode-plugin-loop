import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"
import clipboardy from "clipboardy"
import { watch } from "node:fs"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

import {
  createLoopActionRunner,
  createLoopDialogActions,
  type LoopDialogAction,
} from "./tui-dialog-actions.js"
import {
  LoopFeedbackDialog,
  type LoopFeedbackDialogProps,
} from "./tui-dialog-view.js"
import {
  LOOP_FEEDBACK_FILE,
  loopFeedbackPath,
  readLoopFeedback,
  type LoopFeedbackPayload,
} from "./feedback-channel.js"
import {
  LOOP_COPY_TITLE,
  createLoopFeedbackModel,
  type LoopFeedbackInput,
} from "./tui-feedback-model.js"

export interface LoopDialogRenderInput extends LoopFeedbackDialogProps {
  api: TuiPluginApi
}

export interface LoopTuiDependencies {
  writeClipboard(text: string): Promise<void>
  renderDialog?(input: LoopDialogRenderInput): JSX.Element
  getDirectory?(api: TuiPluginApi): Promise<string>
  watchFeedback?(
    storageDir: string,
    onFeedback: (payload: LoopFeedbackPayload) => void
  ): () => void
}

const defaultDependencies: Required<LoopTuiDependencies> = {
  writeClipboard: (text) => clipboardy.write(text),
  renderDialog(input) {
    return LoopFeedbackDialog({
      message: input.message,
      variant: input.variant,
      tasks: input.tasks,
      actions: input.actions,
      theme: input.theme,
      onActivate: input.onActivate,
      onClose: input.onClose,
    })
  },
  async getDirectory(api) {
    try {
      const res = await api.client.path.get()
      const directory = (res as { data?: { directory?: unknown } })?.data
        ?.directory
      if (typeof directory === "string" && directory) return directory
    } catch {
      // Fall back to the TUI process working directory below.
    }
    return process.cwd()
  },
  watchFeedback(storageDir, onFeedback) {
    mkdirSync(storageDir, { recursive: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const watcher = watch(storageDir, (_event, filename) => {
      if (filename !== LOOP_FEEDBACK_FILE) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const payload = readLoopFeedback(loopFeedbackPath(storageDir))
        if (payload) onFeedback(payload)
      }, 50)
    })
    return () => {
      if (timer) clearTimeout(timer)
      watcher.close()
    }
  },
}

export function createLoopTuiPlugin(
  input: LoopTuiDependencies = defaultDependencies
): TuiPlugin {
  const dependencies: Required<LoopTuiDependencies> = {
    ...defaultDependencies,
    ...input,
  }

  return async (api) => {
    const startedAt = Date.now()
    let latestGeneration = 0
    let ownedGeneration: number | undefined

    const finishGeneration = (generation: number) => {
      if (ownedGeneration !== generation) return
      ownedGeneration = undefined
    }

    const closeGeneration = (generation: number) => {
      if (ownedGeneration !== generation) return
      try {
        api.ui.dialog.clear()
      } finally {
        finishGeneration(generation)
      }
    }

    const close = () => {
      const generation = ownedGeneration
      if (generation !== undefined) closeGeneration(generation)
    }

    const logDialogFailure = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      try {
        void api.client.app
          .log({
            service: "opencode-plugin-loop",
            level: "warn",
            message: "failed to open interactive Loop dialog",
            extra: { error: message },
          })
          .catch(() => {})
      } catch {
        // Diagnostics must never interrupt the server-side toast fallback.
      }
    }

    const notifySuccess = (description: string) => {
      api.ui.toast({
        title: LOOP_COPY_TITLE,
        message: `${description} copied to clipboard.`,
        variant: "success",
        duration: 2500,
      })
    }

    const notifyFailure = () => {
      api.ui.toast({
        title: LOOP_COPY_TITLE,
        message: "Could not copy to the system clipboard.",
        variant: "error",
        duration: 4000,
      })
    }

    const openFeedback = (feedback: LoopFeedbackInput) => {
      const generation = ++latestGeneration

      try {
        const model = createLoopFeedbackModel(feedback)

        if (ownedGeneration !== undefined) closeGeneration(ownedGeneration)

        const actions = createLoopDialogActions(model.taskIds)
        const runner = createLoopActionRunner({
          writeClipboard: dependencies.writeClipboard,
          notifySuccess,
          notifyFailure,
          closeIfCurrent: () => closeGeneration(generation),
        })

        ownedGeneration = generation
        api.ui.dialog.setSize("medium")
        api.ui.dialog.replace(
          () =>
            dependencies.renderDialog({
              api,
              message: model.message,
              variant: model.variant,
              tasks: model.tasks,
              actions,
              theme: api.theme.current,
              onActivate(action: LoopDialogAction) {
                void runner.run(action, model.message)
              },
              onClose: () => closeGeneration(generation),
            }),
          () => finishGeneration(generation)
        )
      } catch (error) {
        if (ownedGeneration === generation) {
          try {
            api.ui.dialog.clear()
          } catch {
            // Continue with local state cleanup and structured diagnostics.
          }
          finishGeneration(generation)
        }
        logDialogFailure(error)
      }
    }

    const directory = await dependencies.getDirectory(api)
    const storageDir = join(directory, ".opencode", "cache", "loop")
    const unwatch = dependencies.watchFeedback(storageDir, (payload) => {
      if (payload.ts < startedAt) return
      if (payload.directory !== directory) return
      openFeedback({ message: payload.message, variant: "info" })
    })

    api.lifecycle.onDispose(() => {
      unwatch()
      close()
    })
  }
}

export const LoopTuiPlugin = createLoopTuiPlugin()

const module: TuiPluginModule = {
  id: "opencode-plugin-loop-tui",
  tui: LoopTuiPlugin,
}

export default module
