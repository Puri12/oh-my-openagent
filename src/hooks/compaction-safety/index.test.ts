import { describe, expect, it } from "bun:test"
import { createCompactionSafetyHook } from "./hook"
import { COMPACTION_MAX_TOKENS_CAP } from "./constants"

const baseInput = (agentName: string) => ({
  sessionID: "ses_test",
  agent: { name: agentName },
  model: { providerID: "anthropic", modelID: "claude-opus-4-7" },
})

describe("createCompactionSafetyHook", () => {
  describe("#given non-compaction agent (sisyphus)", () => {
    it("#then leaves thinking, effort and maxTokens untouched", async () => {
      const hook = createCompactionSafetyHook()
      const output = {
        options: {
          thinking: { type: "adaptive", display: "summarized" },
          effort: "max",
        },
        maxTokens: 32000,
      }
      await hook["chat.params"](baseInput("sisyphus"), output)
      expect(output.options.thinking).toBeDefined()
      expect(output.options.effort).toBe("max")
      expect(output.maxTokens).toBe(32000)
    })
  })

  describe("#given compaction agent", () => {
    it("#then removes thinking option", async () => {
      const hook = createCompactionSafetyHook()
      const output = {
        options: { thinking: { type: "adaptive" } },
      }
      await hook["chat.params"](baseInput("compaction"), output)
      expect(output.options.thinking).toBeUndefined()
    })

    it("#then removes top-level effort option", async () => {
      const hook = createCompactionSafetyHook()
      const output = { options: { effort: "max" } }
      await hook["chat.params"](baseInput("compaction"), output)
      expect(output.options.effort).toBeUndefined()
    })

    it("#then removes nested output_config.effort", async () => {
      const hook = createCompactionSafetyHook()
      const output = {
        options: { output_config: { effort: "max" } },
      }
      await hook["chat.params"](baseInput("compaction"), output)
      const cfg = output.options.output_config as Record<string, unknown>
      expect(cfg).toBeDefined()
      expect(cfg.effort).toBeUndefined()
    })

    it("#then caps maxTokens at COMPACTION_MAX_TOKENS_CAP", async () => {
      const hook = createCompactionSafetyHook()
      const output = { options: {}, maxTokens: 32000 }
      await hook["chat.params"](baseInput("compaction"), output)
      expect(output.maxTokens).toBe(COMPACTION_MAX_TOKENS_CAP)
    })

    it("#then leaves maxTokens below cap untouched", async () => {
      const hook = createCompactionSafetyHook()
      const output = { options: {}, maxTokens: 4096 }
      await hook["chat.params"](baseInput("compaction"), output)
      expect(output.maxTokens).toBe(4096)
    })

    it("#then caps options.maxTokens when present", async () => {
      const hook = createCompactionSafetyHook()
      const output = { options: { maxTokens: 32000 } }
      await hook["chat.params"](baseInput("compaction"), output)
      expect(output.options.maxTokens).toBe(COMPACTION_MAX_TOKENS_CAP)
    })

    it("#then matches compaction agent name case-insensitively", async () => {
      const hook = createCompactionSafetyHook()
      const output = { options: { thinking: {}, effort: "max" } }
      await hook["chat.params"](baseInput("COMPACTION"), output)
      expect(output.options.thinking).toBeUndefined()
      expect(output.options.effort).toBeUndefined()
    })

    it("#then is a no-op when no risky options are set", async () => {
      const hook = createCompactionSafetyHook()
      const output = { options: { temperature: 0 }, maxTokens: 4096 }
      await hook["chat.params"](baseInput("compaction"), output)
      expect(output.options.temperature).toBe(0)
      expect(output.maxTokens).toBe(4096)
    })
  })

  describe("#given missing agent name", () => {
    it("#then leaves output untouched", async () => {
      const hook = createCompactionSafetyHook()
      const output = {
        options: { thinking: { type: "adaptive" }, effort: "max" },
        maxTokens: 32000,
      }
      await hook["chat.params"](
        {
          sessionID: "ses_test",
          agent: {},
          model: { providerID: "anthropic", modelID: "claude-opus-4-7" },
        },
        output,
      )
      expect(output.options.thinking).toBeDefined()
      expect(output.options.effort).toBe("max")
      expect(output.maxTokens).toBe(32000)
    })
  })
})
