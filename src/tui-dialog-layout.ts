export interface LoopDialogRows {
  maxHeight: number
  messageRows: number
  actionRows: number
}

export function allocateLoopDialogRows(
  terminalRows: number,
  actionCount: number
): LoopDialogRows {
  const rows = Math.max(1, Math.floor(terminalRows))
  const available = Math.max(1, rows - 4)
  const maxHeight = Math.min(28, available, Math.max(6, Math.floor(rows * 0.7)))
  const contentRows = Math.max(0, maxHeight - 3)

  if (contentRows < 2) {
    return { maxHeight, messageRows: 0, actionRows: contentRows }
  }

  const actionRows = Math.min(
    Math.max(0, actionCount),
    Math.max(1, Math.min(6, Math.floor(contentRows * 0.4)))
  )

  return {
    maxHeight,
    messageRows: contentRows - actionRows,
    actionRows,
  }
}

export function moveLoopActionIndex(
  current: number,
  delta: number,
  count: number
): number {
  if (count <= 0) return 0
  return ((current + delta) % count + count) % count
}
