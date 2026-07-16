export interface LoopDialogInteractionController {
  move(delta: number): void
  select(index: number): void
  activate(): void
  activateAt(index: number): void
  pageMessage(delta: number): void
  close(): void
}

export interface LoopDialogKeyEvent {
  name: string
  shift?: boolean
  preventDefault(): void
  stopPropagation(): void
}

export function handleLoopDialogKey(
  event: LoopDialogKeyEvent,
  controller: LoopDialogInteractionController,
  enabled = true
): boolean {
  if (!enabled) return false

  let run: (() => void) | undefined

  switch (event.name) {
    case "up":
      run = () => controller.move(-1)
      break
    case "down":
      run = () => controller.move(1)
      break
    case "tab":
      run = () => controller.move(event.shift ? -1 : 1)
      break
    case "enter":
    case "return":
    case "space":
      run = () => controller.activate()
      break
    case "pageup":
      run = () => controller.pageMessage(-1)
      break
    case "pagedown":
      run = () => controller.pageMessage(1)
      break
    case "q":
      run = () => controller.close()
      break
    default:
      return false
  }

  event.preventDefault()
  event.stopPropagation()
  run()
  return true
}

export function createLoopDialogPointerHandlers(
  index: number,
  controller: LoopDialogInteractionController
) {
  return {
    onMouseOver: () => controller.select(index),
    onMouseDown: () => controller.select(index),
    onMouseUp: () => controller.activateAt(index),
  }
}
