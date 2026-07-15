export type LoopDialogAction =
  | { type: "copy-id"; taskId: string }
  | { type: "copy-all" }
  | { type: "close" }

export function createLoopDialogActions(
  taskIds: readonly string[]
): readonly LoopDialogAction[] {
  return [
    ...taskIds.map((taskId) => ({ type: "copy-id" as const, taskId })),
    { type: "copy-all" as const },
    { type: "close" as const },
  ]
}

export interface LoopActionRunnerDependencies {
  writeClipboard(text: string): Promise<void>
  notifySuccess(description: string): void
  notifyFailure(): void
  closeIfCurrent(): void
}

export function createLoopActionRunner(input: LoopActionRunnerDependencies) {
  let busy = false

  return {
    get busy() {
      return busy
    },

    async run(action: LoopDialogAction, message: string): Promise<void> {
      if (action.type === "close") {
        input.closeIfCurrent()
        return
      }
      if (busy) return

      busy = true
      const text = action.type === "copy-all" ? message : action.taskId
      const description =
        action.type === "copy-all" ? "Loop result" : `Task ID ${action.taskId}`

      try {
        await input.writeClipboard(text)
        input.notifySuccess(description)
        input.closeIfCurrent()
      } catch {
        input.notifyFailure()
      } finally {
        busy = false
      }
    },
  }
}
