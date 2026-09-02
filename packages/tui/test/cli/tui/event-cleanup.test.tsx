/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Event, GlobalEvent } from "@opencode-ai/sdk/v2"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { SDKProvider } from "../../../src/context/sdk"
import { useEvent } from "../../../src/context/event"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"

// Route components (routes/session/index.tsx, component/prompt/index.tsx)
// subscribe to app-level events via `onCleanup(event.on(...))` so the
// handler dies with the owning scope. These tests pin that contract at the
// seam it depends on: while the SDKProvider (app lifetime) stays alive,
// unmounting the owning component must remove its handler from the
// app-level emitter, and mount/unmount cycles must not accumulate handlers.

const sessionID = "ses_route"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function event(payload: Event): GlobalEvent {
  return { directory, payload }
}

function partUpdated(text: string): Event {
  return {
    id: `evt_${text}`,
    type: "message.part.updated",
    properties: {
      sessionID,
      time: 1,
      part: { id: `part_${text}`, sessionID, messageID: "msg_1", type: "text", text },
    },
  }
}

// Mirrors the production subscription shape: the unsubscribe returned by
// event.on is registered with onCleanup in the component body.
function RouteProbe(props: { received: string[] }) {
  const event = useEvent()
  onCleanup(
    event.on("message.part.updated", (evt) => {
      if (evt.properties.part.type !== "text") return
      props.received.push(evt.properties.part.text)
    }),
  )
  return <box />
}

// Root-level subscription that never unmounts. When it has observed an
// event, the emitter batch has flushed, so any still-registered route
// handler would have observed it in the same pass.
function ControlProbe(props: { received: string[]; onReady: () => void }) {
  const event = useEvent()
  onCleanup(event.subscribe((evt) => props.received.push(evt.id)))
  onMount(() => props.onReady())
  return <box />
}

async function mount() {
  const events = createEventSource()
  const calls = createFetch()
  const route: string[] = []
  const control: string[] = []
  const [mounted, setMounted] = createSignal(true)
  let ready!: () => void
  const done = new Promise<void>((resolve) => {
    ready = resolve
  })

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ControlProbe received={control} onReady={ready} />
        <Show when={mounted()}>
          <RouteProbe received={route} />
        </Show>
      </SDKProvider>
    </TestTuiContexts>
  ))

  await done
  return {
    app,
    emit: (e: GlobalEvent) => events.emit(e),
    route,
    control,
    unmount: () => setMounted(false),
    remount: () => setMounted(true),
  }
}

describe("event.on cleanup", () => {
  test("unmounted component stops receiving events while the SDK provider lives", async () => {
    const { app, emit, route, control, unmount } = await mount()

    try {
      emit(event(partUpdated("before")))
      await wait(() => control.includes("evt_before"))
      expect(route).toEqual(["before"])

      unmount()
      emit(event(partUpdated("after")))
      await wait(() => control.includes("evt_after"))
      expect(route).toEqual(["before"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("mount/unmount cycles do not accumulate handlers", async () => {
    const { app, emit, route, control, unmount, remount } = await mount()

    try {
      unmount()
      remount()
      unmount()
      remount()

      emit(event(partUpdated("single")))
      await wait(() => control.includes("evt_single"))
      expect(route).toEqual(["single"])
    } finally {
      app.renderer.destroy()
    }
  })
})
