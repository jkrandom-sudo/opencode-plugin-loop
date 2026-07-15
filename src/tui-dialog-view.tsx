/** @jsxImportSource @opentui/solid */
import { RGBA, TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions, type JSX } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"

import type { LoopDialogAction } from "./tui-dialog-actions.js"
import {
  allocateLoopDialogRows,
  moveLoopActionIndex,
} from "./tui-dialog-layout.js"

export interface LoopFeedbackDialogRef {
  move(delta: number): void
  activate(): void
  pageMessage(delta: number): void
  dispose(): void
}

export interface LoopFeedbackDialogProps {
  message: string
  variant: "info" | "success" | "warning" | "error"
  actions: readonly LoopDialogAction[]
  theme: TuiThemeCurrent
  onActivate(action: LoopDialogAction): void | Promise<void>
  ref?(value: LoopFeedbackDialogRef | undefined): void
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

export function LoopFeedbackDialog(props: LoopFeedbackDialogProps): JSX.Element {
  const dimensions = useTerminalDimensions()
  const [selected, setSelected] = createSignal(0)
  const rows = createMemo(() =>
    allocateLoopDialogRows(dimensions().height, props.actions.length)
  )
  let messageScroll: ScrollBoxRenderable | undefined
  let actionScroll: ScrollBoxRenderable | undefined

  const keepSelectedVisible = () => {
    const scroll = actionScroll
    const target = scroll?.getChildren()[selected()]
    if (!scroll || !target) return

    const offset = target.y - scroll.y
    if (offset < 0) scroll.scrollBy(offset)
    if (offset >= scroll.height) scroll.scrollBy(offset - scroll.height + 1)
  }

  const controller: LoopFeedbackDialogRef = {
    move(delta) {
      setSelected((index) =>
        moveLoopActionIndex(index, delta, props.actions.length)
      )
    },
    activate() {
      const action = props.actions[selected()]
      if (action) void props.onActivate(action)
    },
    pageMessage(delta) {
      if (!messageScroll) return
      messageScroll.scrollBy(delta * Math.max(1, messageScroll.height - 1))
    },
    dispose() {
      messageScroll = undefined
      actionScroll = undefined
    },
  }

  props.ref?.(controller)
  createEffect(() => {
    selected()
    queueMicrotask(keepSelectedVisible)
  })
  onCleanup(() => {
    controller.dispose()
    props.ref?.(undefined)
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
        <text fg={props.theme.text} attributes={TextAttributes.BOLD}>
          {icon()} Loop
        </text>
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

      <Show when={rows().actionRows > 0}>
        <scrollbox
          ref={(value: ScrollBoxRenderable) => (actionScroll = value)}
          height={rows().actionRows}
          minHeight={rows().actionRows}
          maxHeight={rows().actionRows}
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          scrollbarOptions={{ visible: false }}
        >
          <For each={props.actions}>
            {(action, index) => {
              const active = () => selected() === index()
              return (
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
                  onMouseDown={() => setSelected(index())}
                  onMouseUp={() => void props.onActivate(action)}
                >
                  <text
                    wrapMode="none"
                    truncate={true}
                    flexShrink={0}
                    fg={
                      active()
                        ? props.theme.selectedListItemText
                        : props.theme.text
                    }
                    attributes={active() ? TextAttributes.BOLD : undefined}
                  >
                    {label(action)}
                  </text>
                  <text
                    wrapMode="none"
                    truncate={true}
                    flexShrink={1}
                    fg={
                      active()
                        ? props.theme.selectedListItemText
                        : props.theme.textMuted
                    }
                  >
                    {description(action)}
                  </text>
                </box>
              )
            }}
          </For>
        </scrollbox>
      </Show>
    </box>
  )
}
