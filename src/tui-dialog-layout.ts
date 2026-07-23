export interface LoopDialogRows {
  maxHeight: number
  messageRows: number
  listRows: number
}

export function allocateLoopDialogRows(
  terminalRows: number,
  itemCount: number,
  taskList = false
): LoopDialogRows {
  const rows = Math.max(1, Math.floor(terminalRows))
  const available = Math.max(1, rows - 4)
  const maxHeight = Math.min(28, available, Math.max(6, Math.floor(rows * 0.7)))
  const items = Math.max(0, Math.floor(itemCount))

  if (taskList) {
    // header (1) + gaps (2) + hint bar (1) + gap (1)
    const contentRows = Math.max(1, maxHeight - 5)
    return { maxHeight, messageRows: 0, listRows: Math.min(items, contentRows) }
  }

  const contentRows = Math.max(0, maxHeight - 3)
  if (contentRows < 2) {
    return { maxHeight, messageRows: 0, listRows: contentRows }
  }

  const listRows = Math.min(
    items,
    Math.max(1, Math.min(6, Math.floor(contentRows * 0.4)))
  )

  return {
    maxHeight,
    messageRows: contentRows - listRows,
    listRows,
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
