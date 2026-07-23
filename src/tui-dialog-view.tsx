/** @jsxImportSource @opentui/solid */
import { RGBA, TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions, type JSX } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"

import type { LoopDialogAction } from "./tui-dialog-actions.js"
import type { LoopTaskInfo } from "./tui-feedback-model.js"
import {
  createLoopDialogPointerHandlers,
  handleLoopDialogKey,
  type LoopDialogInteractionController,
} from "./tui-dialog-interaction.js"
import {
  allocateLoopDialogRows,
  moveLoopActionIndex,
} from "./tui-dialog-layout.js"

export interface LoopFeedbackDialogProps {
  message: string
  variant: "info" | "success" | "warning" | "error"
  tasks: readonly LoopTaskInfo[]
  actions: readonly LoopDialogAction[]
  theme: TuiThemeCurrent
  onActivate(action: LoopDialogAction): void | Promise<void>
  onClose(): void
}

const transparent = RGBA.fromInts(0, 0, 0, 0)

function label(action: LoopDialogAction): string {
  if (action.type === "copy-id") return `Copy ID: ${action.taskId}`
  if (action.type === "copy-all") return "Copy all"
  return "Close"
}

function description(action: LoopDialogAction): string {
  if (action.type === "copy-id") return "Copy this task ID"
  if (action.type === "copy-all") return "Copy the complete Loop result"
  return "Close this Loop result"
}

function idLabel(task: LoopTaskInfo): string {
  return task.session ? `${task.id} [s:${task.session}]` : task.id
}

function intervalLabel(task: LoopTaskInfo): string {
  return task.once ? `${task.interval} · once` : task.interval
}

function padEnd(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length)
}

export function LoopFeedbackDialog(props: LoopFeedbackDialogProps): JSX.Element {
  const dimensions = useTerminalDimensions()
  const [selected, setSelected] = createSignal(0)
  const taskMode = createMemo(() => props.tasks.length > 0)
  const rows = createMemo(() =>
    allocateLoopDialogRows(
      dimensions().height,
      props.actions.length,
      taskMode()
    )
  )
  const idWidth = createMemo(() =>
    props.tasks.reduce((width, task) => Math.max(width, idLabel(task).length), 0)
  )
  const intervalWidth = createMemo(() =>
    props.tasks.reduce(
      (width, task) => Math.max(width, intervalLabel(task).length),
      0
    )
  )
  const taskById = createMemo(() => {
    const map = new Map<string, LoopTaskInfo>()
    for (const task of props.tasks) map.set(task.id, task)
    return map
  })
  let messageScroll: ScrollBoxRenderable | undefined
  let actionScroll: ScrollBoxRenderable | undefined
  let keyboardReady = false
  let mounted = true

  const keepSelectedVisible = () => {
    const scroll = actionScroll
    const target = scroll?.getChildren()[selected()]
    if (!scroll || !target) return

    const offset = target.y - scroll.y
    if (offset < 0) scroll.scrollBy(offset)
    if (offset >= scroll.height) scroll.scrollBy(offset - scroll.height + 1)
  }

  const controller: LoopDialogInteractionController = {
    move(delta) {
      setSelected((index) =>
        moveLoopActionIndex(index, delta, props.actions.length)
      )
    },
    select(index) {
      if (index < 0 || index >= props.actions.length) return
      setSelected(index)
    },
    activate() {
      const action = props.actions[selected()]
      if (action) void props.onActivate(action)
    },
    activateAt(index) {
      const action = props.actions[index]
      if (!action) return
      setSelected(index)
      void props.onActivate(action)
    },
    pageMessage(delta) {
      const target = taskMode() ? actionScroll : messageScroll
      if (!target) return
      target.scrollBy(delta * Math.max(1, target.height - 1))
    },
    close() {
      props.onClose()
    },
  }

  useKeyboard((event) => {
    handleLoopDialogKey(event, controller, keyboardReady)
  })
  queueMicrotask(() => {
    if (mounted) keyboardReady = true
  })
  createEffect(() => {
    selected()
    queueMicrotask(keepSelectedVisible)
  })
  onCleanup(() => {
    mounted = false
    keyboardReady = false
    messageScroll = undefined
    actionScroll = undefined
  })

  const icon = () =>
    ({ info: "ℹ", success: "✓", warning: "⚠", error: "✕" })[
      props.variant
    ]

  return (
    <box
      width="100%"
      height={rows().maxHeight}
      minHeight={rows().maxHeight}
      maxHeight={rows().maxHeight}
      flexDirection="column"
      flexShrink={0}
      gap={1}
      overflow="hidden"
    >
      <box
        paddingLeft={3}
        paddingRight={3}
        flexDirection="row"
        justifyContent="space-between"
        flexShrink={0}
      >
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text fg={props.theme.text} attributes={TextAttributes.BOLD}>
            {taskMode() ? "🔁" : icon()} Loop tasks
          </text>
          <Show when={taskMode()}>
            <text fg={props.theme.textMuted}>({props.tasks.length})</text>
          </Show>
        </box>
        <text fg={props.theme.textMuted}>esc</text>
      </box>

      <Show when={rows().messageRows > 0}>
        <scrollbox
          ref={(value: ScrollBoxRenderable) => (messageScroll = value)}
          height={rows().messageRows}
          minHeight={rows().messageRows}
          maxHeight={rows().messageRows}
          flexShrink={0}
          paddingLeft={3}
          paddingRight={3}
          scrollbarOptions={{ visible: true }}
        >
          <text fg={props.theme.text}>{props.message}</text>
        </scrollbox>
      </Show>

      <Show when={rows().listRows > 0}>
        <scrollbox
          ref={(value: ScrollBoxRenderable) => (actionScroll = value)}
          height={rows().listRows}
          minHeight={rows().listRows}
          maxHeight={rows().listRows}
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          scrollbarOptions={{ visible: false }}
        >
          <For each={props.actions}>
            {(action, index) => {
              const active = () => selected() === index()
              const pointer = createLoopDialogPointerHandlers(
                index(),
                controller
              )
              const task = () =>
                action.type === "copy-id"
                  ? taskById().get(action.taskId)
                  : undefined
              const fg = () =>
                active()
                  ? props.theme.selectedListItemText
                  : props.theme.text
              const fgMuted = () =>
                active()
                  ? props.theme.selectedListItemText
                  : props.theme.textMuted
              return (
                <Show
                  when={task()}
                  fallback={
                    <box
                      height={1}
                      minHeight={1}
                      maxHeight={1}
                      flexShrink={0}
                      overflow="hidden"
                      paddingLeft={2}
                      paddingRight={2}
                      flexDirection="row"
                      gap={1}
                      backgroundColor={
                        active() ? props.theme.primary : transparent
                      }
                      onMouseOver={pointer.onMouseOver}
                      onMouseDown={pointer.onMouseDown}
                      onMouseUp={pointer.onMouseUp}
                    >
                      <text
                        wrapMode="none"
                        truncate={true}
                        flexShrink={0}
                        fg={fg()}
                        attributes={active() ? TextAttributes.BOLD : undefined}
                      >
                        {label(action)}
                      </text>
                      <text
                        wrapMode="none"
                        truncate={true}
                        flexShrink={1}
                        fg={fgMuted()}
                      >
                        {description(action)}
                      </text>
                    </box>
                  }
                >
                  {(current: () => LoopTaskInfo) => (
                    <box
                      height={1}
                      minHeight={1}
                      maxHeight={1}
                      flexShrink={0}
                      overflow="hidden"
                      paddingLeft={2}
                      paddingRight={2}
                      flexDirection="row"
                      gap={1}
                      backgroundColor={
                        active() ? props.theme.primary : transparent
                      }
                      onMouseOver={pointer.onMouseOver}
                      onMouseDown={pointer.onMouseDown}
                      onMouseUp={pointer.onMouseUp}
                    >
                      <text
                        wrapMode="none"
                        flexShrink={0}
                        fg={
                          active()
                            ? props.theme.selectedListItemText
                            : current().status === "paused"
                              ? props.theme.warning
                              : props.theme.success
                        }
                      >
                        {current().status === "paused" ? "⏸" : "▶"}
                      </text>
                      <text wrapMode="none" flexShrink={0} fg={fgMuted()}>
                        {padEnd(idLabel(current()), idWidth())}
                      </text>
                      <text wrapMode="none" flexShrink={0} fg={fgMuted()}>
                        {padEnd(intervalLabel(current()), intervalWidth())}
                      </text>
                      <text
                        wrapMode="none"
                        truncate={true}
                        flexShrink={1}
                        fg={fg()}
                        attributes={active() ? TextAttributes.BOLD : undefined}
                      >
                        {current().prompt}
                      </text>
                    </box>
                  )}
                </Show>
              )
            }}
          </For>
        </scrollbox>
      </Show>

      <Show when={taskMode()}>
        <box paddingLeft={3} paddingRight={3} flexShrink={0}>
          <text fg={props.theme.textMuted}>
            ↑↓ move · enter copy ID · q close
          </text>
        </box>
      </Show>
    </box>
  )
}
