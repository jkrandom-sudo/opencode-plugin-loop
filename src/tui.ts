import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"
import clipboardy from "clipboardy"

import {
  createLoopActionRunner,
  createLoopDialogActions,
  type LoopDialogAction,
} from "./tui-dialog-actions.js"
import {
  LoopFeedbackDialog,
  type LoopFeedbackDialogProps,
  type LoopFeedbackDialogRef,
} from "./tui-dialog-view.js"
import {
  LOOP_COPY_TITLE,
  createLoopFeedbackModel,
  isLoopFeedbackToast,
  type LoopFeedbackInput,
} from "./tui-feedback-model.js"

export interface LoopDialogRenderInput extends LoopFeedbackDialogProps {
  api: TuiPluginApi
  close(): void
}

export interface LoopTuiDependencies {
  writeClipboard(text: string): Promise<void>
  renderDialog?(input: LoopDialogRenderInput): JSX.Element
}

const defaultDependencies: Required<LoopTuiDependencies> = {
  writeClipboard: (text) => clipboardy.write(text),
  renderDialog(input) {
    return LoopFeedbackDialog({
      message: input.message,
      variant: input.variant,
      actions: input.actions,
      theme: input.theme,
      onActivate: input.onActivate,
      ref: input.ref,
    })
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
    let latestGeneration = 0
    let ownedGeneration: number | undefined
    let dialogRef: LoopFeedbackDialogRef | undefined
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

    const finishGeneration = (generation: number) => {
      if (ownedGeneration !== generation) return
      ownedGeneration = undefined
      dialogRef?.dispose()
      dialogRef = undefined
      releaseCloseLayer()
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
        releaseCloseLayer()

        const actions = createLoopDialogActions(model.taskIds)
        const runner = createLoopActionRunner({
          writeClipboard: dependencies.writeClipboard,
          notifySuccess,
          notifyFailure,
          closeIfCurrent: () => closeGeneration(generation),
        })

        unregisterCloseLayer = api.keymap.registerLayer({
          priority: 1000,
          commands: [
            {
              name: "loop.dialog.previous",
              title: "Previous Loop action",
              category: "Loop",
              run: () => dialogRef?.move(-1),
            },
            {
              name: "loop.dialog.next",
              title: "Next Loop action",
              category: "Loop",
              run: () => dialogRef?.move(1),
            },
            {
              name: "loop.dialog.activate",
              title: "Activate Loop action",
              category: "Loop",
              run: () => dialogRef?.activate(),
            },
            {
              name: "loop.dialog.page-up",
              title: "Scroll Loop message up",
              category: "Loop",
              run: () => dialogRef?.pageMessage(-1),
            },
            {
              name: "loop.dialog.page-down",
              title: "Scroll Loop message down",
              category: "Loop",
              run: () => dialogRef?.pageMessage(1),
            },
            {
              name: "loop.dialog.close",
              title: "Close Loop feedback",
              category: "Loop",
              run: close,
            },
          ],
          bindings: [
            { key: "up", cmd: "loop.dialog.previous", desc: "Previous action" },
            { key: "down", cmd: "loop.dialog.next", desc: "Next action" },
            { key: "enter", cmd: "loop.dialog.activate", desc: "Activate action" },
            { key: "return", cmd: "loop.dialog.activate", desc: "Activate action" },
            { key: "space", cmd: "loop.dialog.activate", desc: "Activate action" },
            { key: "pageup", cmd: "loop.dialog.page-up", desc: "Scroll message up" },
            { key: "pagedown", cmd: "loop.dialog.page-down", desc: "Scroll message down" },
            { key: "q", cmd: "loop.dialog.close", desc: "Close Loop feedback" },
          ],
        })

        ownedGeneration = generation
        api.ui.dialog.setSize("medium")
        api.ui.dialog.replace(
          () =>
            dependencies.renderDialog({
              api,
              message: model.message,
              variant: model.variant,
              actions,
              theme: api.theme.current,
              onActivate(action: LoopDialogAction) {
                void runner.run(action, model.message)
              },
              ref(value) {
                if (ownedGeneration === generation) dialogRef = value
              },
              close: () => closeGeneration(generation),
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
        } else {
          releaseCloseLayer()
        }
        logDialogFailure(error)
      }
    }

    const unsubscribe = api.event.on("tui.toast.show", (event) => {
      if (!isLoopFeedbackToast(event)) return
      openFeedback(event.properties)
    })

    api.lifecycle.onDispose(() => {
      unsubscribe()
      close()
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
