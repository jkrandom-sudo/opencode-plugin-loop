import type {
  TuiDialogSelectOption,
  TuiPlugin,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import clipboardy from "clipboardy"

import {
  LOOP_COPY_TITLE,
  createLoopFeedbackModel,
  isLoopFeedbackToast,
  type LoopFeedbackInput,
} from "./tui-feedback-model.js"

type LoopDialogAction =
  | { type: "copy-id"; taskId: string }
  | { type: "copy-all" }
  | { type: "close" }

export interface LoopTuiDependencies {
  writeClipboard(text: string): Promise<void>
}

const defaultDependencies: LoopTuiDependencies = {
  writeClipboard: (text) => clipboardy.write(text),
}

export function createLoopTuiPlugin(
  dependencies: LoopTuiDependencies = defaultDependencies
): TuiPlugin {
  return async (api) => {
    let ownsDialog = false
    let unregisterCloseLayer: (() => void) | undefined

    const releaseCloseLayer = () => {
      const unregister = unregisterCloseLayer
      unregisterCloseLayer = undefined
      try {
        unregister?.()
      } catch {
        // Cleanup must not interrupt later Loop feedback or TUI disposal.
      }
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

    const close = () => {
      if (ownsDialog) api.ui.dialog.clear()
    }

    const copy = async (text: string, description: string) => {
      try {
        await dependencies.writeClipboard(text)
        api.ui.toast({
          title: LOOP_COPY_TITLE,
          message: `${description} copied to clipboard.`,
          variant: "success",
          duration: 2500,
        })
      } catch {
        api.ui.toast({
          title: LOOP_COPY_TITLE,
          message: "Could not copy to the system clipboard.",
          variant: "error",
          duration: 4000,
        })
      }
    }

    const openFeedback = (input: LoopFeedbackInput) => {
      try {
        const model = createLoopFeedbackModel(input)

        if (ownsDialog) api.ui.dialog.clear()
        releaseCloseLayer()

        unregisterCloseLayer = api.keymap.registerLayer({
          priority: 1000,
          commands: [
            {
              name: "loop.dialog.close",
              title: "Close Loop feedback",
              category: "Loop",
              run: close,
            },
          ],
          bindings: [
            {
              key: "q",
              cmd: "loop.dialog.close",
              desc: "Close Loop feedback",
            },
          ],
        })

        const options: TuiDialogSelectOption<LoopDialogAction>[] = [
          ...model.taskIds.map((taskId) => ({
            title: `Copy ID: ${taskId}`,
            description: "Copy this task ID",
            value: { type: "copy-id" as const, taskId },
          })),
          {
            title: "Copy all",
            description: "Copy the complete Loop result",
            value: { type: "copy-all" },
          },
          {
            title: "Close",
            description: "Close this Loop result",
            value: { type: "close" },
          },
        ]

        const status = {
          info: "ℹ",
          success: "✓",
          warning: "⚠",
          error: "✕",
        }[model.variant]

        ownsDialog = true
        api.ui.dialog.replace(
          () =>
            api.ui.DialogSelect<LoopDialogAction>({
              title: `${status} Loop\n\n${model.message}`,
              options,
              skipFilter: true,
              onSelect(option) {
                const action = option.value
                if (action.type === "close") {
                  close()
                  return
                }
                if (action.type === "copy-all") {
                  void copy(model.message, "Loop result")
                  return
                }
                void copy(action.taskId, `Task ID ${action.taskId}`)
              },
            }),
          () => {
            ownsDialog = false
            releaseCloseLayer()
          }
        )
      } catch (error) {
        if (ownsDialog) {
          try {
            api.ui.dialog.clear()
          } catch {
            // Continue with local state cleanup and structured diagnostics.
          }
        }
        ownsDialog = false
        releaseCloseLayer()
        logDialogFailure(error)
      }
    }

    const unsubscribe = api.event.on("tui.toast.show", (event) => {
      if (!isLoopFeedbackToast(event)) return
      openFeedback(event.properties)
    })

    api.lifecycle.onDispose(() => {
      unsubscribe()
      if (ownsDialog) api.ui.dialog.clear()
      releaseCloseLayer()
    })
  }
}

export const LoopTuiPlugin = createLoopTuiPlugin()

const module: TuiPluginModule = {
  id: "opencode-plugin-loop-tui",
  tui: LoopTuiPlugin,
}

export default module
