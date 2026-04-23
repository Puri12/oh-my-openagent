import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test"
import { createMessagesImageResizerHook } from "./hook"
import * as sessionModelState from "../../shared/session-model-state"
import * as imageResizer from "../read-image-resizer/image-resizer"
import * as imageDimensions from "../read-image-resizer/image-dimensions"

describe("messages-image-resizer hook", () => {
  let getSessionModelSpy: ReturnType<typeof spyOn>
  let calculateTargetDimensionsSpy: ReturnType<typeof spyOn>
  let resizeImageSpy: ReturnType<typeof spyOn>
  let parseImageDimensionsSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    getSessionModelSpy = spyOn(sessionModelState, "getSessionModel")
    calculateTargetDimensionsSpy = spyOn(imageResizer, "calculateTargetDimensions")
    resizeImageSpy = spyOn(imageResizer, "resizeImage")
    parseImageDimensionsSpy = spyOn(imageDimensions, "parseImageDimensions")
  })

  afterEach(() => {
    getSessionModelSpy.mockRestore()
    calculateTargetDimensionsSpy.mockRestore()
    resizeImageSpy.mockRestore()
    parseImageDimensionsSpy.mockRestore()
  })

  test("#given anthropic provider #when image exceeds 2000px #then resizes image", async () => {
    getSessionModelSpy.mockReturnValue({ providerID: "anthropic" })
    parseImageDimensionsSpy.mockReturnValue({ width: 3000, height: 2250 })
    calculateTargetDimensionsSpy.mockReturnValue({ width: 2000, height: 1500 })
    resizeImageSpy.mockResolvedValue({
      resizedDataUrl: "data:image/png;base64,resized",
      original: { width: 3000, height: 2250 },
      resized: { width: 2000, height: 1500 },
    })

    const ctx = {} as Parameters<typeof createMessagesImageResizerHook>[0]
    const hook = createMessagesImageResizerHook(ctx)
    const transform = hook["experimental.chat.messages.transform"]

    const output = {
      messages: [
        {
          info: { role: "user" } as any,
          parts: [
            {
              type: "file",
              mime: "image/png",
              url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAC7gAABdwCAYAAAA",
              filename: "screenshot.png",
            },
          ],
        },
      ],
    }

    await transform!({ sessionID: "test-session" }, output)

    expect(resizeImageSpy).toHaveBeenCalled()
    expect((output.messages[0].parts[0] as any).url).toBe("data:image/png;base64,resized")
  })

  test("#given non-anthropic provider #then skips resizing", async () => {
    getSessionModelSpy.mockReturnValue({ providerID: "openai" })

    const ctx = {} as Parameters<typeof createMessagesImageResizerHook>[0]
    const hook = createMessagesImageResizerHook(ctx)
    const transform = hook["experimental.chat.messages.transform"]

    const output = {
      messages: [
        {
          info: { role: "user" } as any,
          parts: [
            {
              type: "file",
              mime: "image/png",
              url: "data:image/png;base64,original",
            },
          ],
        },
      ],
    }

    await transform!({ sessionID: "test-session" }, output)

    expect(resizeImageSpy).not.toHaveBeenCalled()
    expect((output.messages[0].parts[0] as any).url).toBe("data:image/png;base64,original")
  })

  test("#given assistant message #then skips processing", async () => {
    getSessionModelSpy.mockReturnValue({ providerID: "anthropic" })

    const ctx = {} as Parameters<typeof createMessagesImageResizerHook>[0]
    const hook = createMessagesImageResizerHook(ctx)
    const transform = hook["experimental.chat.messages.transform"]

    const output = {
      messages: [
        {
          info: { role: "assistant" } as any,
          parts: [
            {
              type: "file",
              mime: "image/png",
              url: "data:image/png;base64,original",
            },
          ],
        },
      ],
    }

    await transform!({ sessionID: "test-session" }, output)

    expect(resizeImageSpy).not.toHaveBeenCalled()
  })

  test("#given no sessionID #then processes without provider check", async () => {
    parseImageDimensionsSpy.mockReturnValue({ width: 3000, height: 2250 })
    calculateTargetDimensionsSpy.mockReturnValue({ width: 2000, height: 1500 })
    resizeImageSpy.mockResolvedValue({
      resizedDataUrl: "data:image/png;base64,resized",
      original: { width: 3000, height: 2250 },
      resized: { width: 2000, height: 1500 },
    })

    const ctx = {} as Parameters<typeof createMessagesImageResizerHook>[0]
    const hook = createMessagesImageResizerHook(ctx)
    const transform = hook["experimental.chat.messages.transform"]

    const output = {
      messages: [
        {
          info: { role: "user" } as any,
          parts: [
            {
              type: "file",
              mime: "image/png",
              url: "data:image/png;base64,largeimage",
            },
          ],
        },
      ],
    }

    await transform!({}, output)

    expect(resizeImageSpy).toHaveBeenCalled()
  })
})
