import { describe, it, expect, beforeEach } from "bun:test"
import { createWriteErrorRecoveryHook, WRITE_ERROR_PATTERNS, WRITE_ERROR_REMINDER } from "./index"

describe("createWriteErrorRecoveryHook", () => {
  let hook: ReturnType<typeof createWriteErrorRecoveryHook>

  beforeEach(() => {
    hook = createWriteErrorRecoveryHook({} as any)
  })

  describe("tool.execute.after", () => {
    const createInput = (tool: string) => ({
      tool,
      sessionID: "test-session",
      callID: "test-call-id",
    })

    const createOutput = (outputText: string) => ({
      title: "Write",
      output: outputText,
      metadata: {},
    })

    describe("#given Write tool with file-already-exists error", () => {
      describe("#when the guard block message is detected", () => {
        it("#then should append the recovery reminder", async () => {
          const input = createInput("Write")
          const output = createOutput("Error: File already exists. Use edit tool instead.")

          await hook["tool.execute.after"](input, output)

          expect(output.output).toContain(WRITE_ERROR_REMINDER)
          expect(output.output).toContain("File already exists. Use edit tool instead.")
        })
      })

      describe("#when the guard message appears with path and remediation body", () => {
        it("#then should still detect and append reminder", async () => {
          const input = createInput("Write")
          const output = createOutput(
            "File already exists. Use edit tool instead.\n\nTarget: /tmp/foo.txt\n..."
          )

          await hook["tool.execute.after"](input, output)

          expect(output.output).toContain(WRITE_ERROR_REMINDER)
        })
      })
    })

    describe("#given Write tool with opencode FileTime stale error", () => {
      describe("#when you must read file appears", () => {
        it("#then should append the recovery reminder", async () => {
          const input = createInput("Write")
          const output = createOutput(
            "Error: You must read file /tmp/x.ts before overwriting it. Use the Read tool first"
          )

          await hook["tool.execute.after"](input, output)

          expect(output.output).toContain(WRITE_ERROR_REMINDER)
        })
      })

      describe("#when modified-since-last-read appears", () => {
        it("#then should append the recovery reminder", async () => {
          const input = createInput("Write")
          const output = createOutput(
            "File /tmp/x.ts has been modified since it was last read."
          )

          await hook["tool.execute.after"](input, output)

          expect(output.output).toContain(WRITE_ERROR_REMINDER)
        })
      })
    })

    describe("#given non-Write tool", () => {
      describe("#when tool is not Write", () => {
        it("#then should not modify output", async () => {
          const input = createInput("Read")
          const originalOutput = "File already exists. Use edit tool instead."
          const output = createOutput(originalOutput)

          await hook["tool.execute.after"](input, output)

          expect(output.output).toBe(originalOutput)
        })
      })
    })

    describe("#given Write tool with successful output", () => {
      describe("#when no error in output", () => {
        it("#then should not modify output", async () => {
          const input = createInput("Write")
          const originalOutput = "File written successfully"
          const output = createOutput(originalOutput)

          await hook["tool.execute.after"](input, output)

          expect(output.output).toBe(originalOutput)
        })
      })
    })

    describe("#given MCP tool with undefined output.output", () => {
      describe("#when output.output is undefined", () => {
        it("#then should not crash", async () => {
          const input = createInput("Write")
          const output = {
            title: "Write",
            output: undefined as unknown as string,
            metadata: {},
          }

          await hook["tool.execute.after"](input, output)

          expect(output.output).toBeUndefined()
        })
      })
    })

    describe("#given case insensitive tool name", () => {
      describe("#when tool is 'write' lowercase", () => {
        it("#then should still detect and append reminder", async () => {
          const input = createInput("write")
          const output = createOutput("File already exists. Use edit tool instead.")

          await hook["tool.execute.after"](input, output)

          expect(output.output).toContain(WRITE_ERROR_REMINDER)
        })
      })
    })
  })

  describe("WRITE_ERROR_PATTERNS", () => {
    it("#then should contain all known Write error patterns", () => {
      expect(WRITE_ERROR_PATTERNS).toContain("File already exists. Use edit tool instead.")
      expect(WRITE_ERROR_PATTERNS).toContain("You must read file")
      expect(WRITE_ERROR_PATTERNS).toContain("has been modified since it was last read")
    })
  })
})
