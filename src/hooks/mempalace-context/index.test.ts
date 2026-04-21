import { describe, it, expect, beforeEach } from "bun:test"
import { createMempalaceContextHook } from "./hook"

describe("createMempalaceContextHook", () => {
  describe("#given hook is disabled", () => {
    it("#then returns empty object", () => {
      const hook = createMempalaceContextHook("/test/project", { enabled: false })
      expect(hook).toEqual({})
    })
  })

  describe("#given hook is enabled", () => {
    describe("#when chat.message is called", () => {
      it("#then injects memory protocol on first message", async () => {
        const hook = createMempalaceContextHook("/test/my-project")
        const output = { parts: [{ type: "text", text: "Hello" }] }

        await hook["chat.message"]?.({ sessionID: "sess-1" }, output)

        expect(output.parts[0].text).toContain("<mempalace-context")
        expect(output.parts[0].text).toContain("my-project")
        expect(output.parts[0].text).toContain("Memory Protocol")
      })

      it("#then does not inject twice for same session", async () => {
        const hook = createMempalaceContextHook("/test/project")
        const output1 = { parts: [{ type: "text", text: "First" }] }
        const output2 = { parts: [{ type: "text", text: "Second" }] }

        await hook["chat.message"]?.({ sessionID: "sess-1" }, output1)
        await hook["chat.message"]?.({ sessionID: "sess-1" }, output2)

        expect(output1.parts[0].text).toContain("<mempalace-context")
        expect(output2.parts[0].text).toBe("Second")
      })

      it("#then injects for different sessions", async () => {
        const hook = createMempalaceContextHook("/test/project")
        const output1 = { parts: [{ type: "text", text: "First" }] }
        const output2 = { parts: [{ type: "text", text: "Second" }] }

        await hook["chat.message"]?.({ sessionID: "sess-1" }, output1)
        await hook["chat.message"]?.({ sessionID: "sess-2" }, output2)

        expect(output1.parts[0].text).toContain("<mempalace-context")
        expect(output2.parts[0].text).toContain("<mempalace-context")
      })
    })

    describe("#when custom config is provided", () => {
      it("#then uses custom wing name", async () => {
        const hook = createMempalaceContextHook("/test/project", { project_wing: "custom-wing" })
        const output = { parts: [{ type: "text", text: "Hello" }] }

        await hook["chat.message"]?.({ sessionID: "sess-1" }, output)

        expect(output.parts[0].text).toContain('wing="custom-wing"')
      })

      it("#then uses custom room name", async () => {
        const hook = createMempalaceContextHook("/test/project", { default_room: "architecture" })
        const output = { parts: [{ type: "text", text: "Hello" }] }

        await hook["chat.message"]?.({ sessionID: "sess-1" }, output)

        expect(output.parts[0].text).toContain('room="architecture"')
      })

      it("#then uses custom agent name", async () => {
        const hook = createMempalaceContextHook("/test/project", { agent_name: "atlas" })
        const output = { parts: [{ type: "text", text: "Hello" }] }

        await hook["chat.message"]?.({ sessionID: "sess-1" }, output)

        expect(output.parts[0].text).toContain('agent_name="atlas"')
      })
    })

    describe("#when session events occur", () => {
      it("#then clears session on session.deleted", async () => {
        const hook = createMempalaceContextHook("/test/project")
        const output1 = { parts: [{ type: "text", text: "First" }] }

        await hook["chat.message"]?.({ sessionID: "sess-1" }, output1)
        await hook.event?.({ event: { type: "session.deleted", properties: { info: { id: "sess-1" } } } })

        const output2 = { parts: [{ type: "text", text: "Second" }] }
        await hook["chat.message"]?.({ sessionID: "sess-1" }, output2)

        expect(output2.parts[0].text).toContain("<mempalace-context")
      })

      it("#then clears session on session.compacted", async () => {
        const hook = createMempalaceContextHook("/test/project")
        const output1 = { parts: [{ type: "text", text: "First" }] }

        await hook["chat.message"]?.({ sessionID: "sess-1" }, output1)
        await hook.event?.({ event: { type: "session.compacted", properties: { sessionID: "sess-1" } } })

        const output2 = { parts: [{ type: "text", text: "Second" }] }
        await hook["chat.message"]?.({ sessionID: "sess-1" }, output2)

        expect(output2.parts[0].text).toContain("<mempalace-context")
      })
    })

    describe("#when auto_search_on_start is disabled", () => {
      it("#then shows disabled message in protocol", async () => {
        const hook = createMempalaceContextHook("/test/project", { auto_search_on_start: false })
        const output = { parts: [{ type: "text", text: "Hello" }] }

        await hook["chat.message"]?.({ sessionID: "sess-1" }, output)

        expect(output.parts[0].text).toContain("auto-search disabled")
      })
    })

    describe("#when use_aaak_format is enabled", () => {
      it("#then includes AAAK format guidance", async () => {
        const hook = createMempalaceContextHook("/test/project", { use_aaak_format: true })
        const output = { parts: [{ type: "text", text: "Hello" }] }

        await hook["chat.message"]?.({ sessionID: "sess-1" }, output)

        expect(output.parts[0].text).toContain("AAAK Format")
        expect(output.parts[0].text).toContain("Pipe-separated")
      })
    })
  })
})
