/**
 * Messages Image Resizer Hook
 *
 * Resizes large images in user messages before sending to the Anthropic API.
 * Prevents "At least one of the image dimensions exceed max allowed size
 * for many-image requests: 2000 pixels" error.
 *
 * This hook runs on "experimental.chat.messages.transform" hook point,
 * which is called before messages are sent to the API.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import type { Message, Part } from "@opencode-ai/sdk"
import { log } from "../../shared"
import { getSessionModel } from "../../shared/session-model-state"
import { calculateTargetDimensions, resizeImage } from "../read-image-resizer/image-resizer"
import { parseImageDimensions } from "../read-image-resizer/image-dimensions"

const ANTHROPIC_MULTI_IMAGE_MAX_DIMENSION = 2000
const SUPPORTED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

interface MessageWithParts {
  info: Message
  parts: Part[]
}

type MessagesTransformHook = {
  "experimental.chat.messages.transform"?: (
    input: { sessionID?: string },
    output: { messages: MessageWithParts[] }
  ) => Promise<void>
}

interface FilePart {
  type: "file"
  mime: string
  url: string
  filename?: string
}

function isFilePart(part: Part): part is Part & FilePart {
  return part.type === "file"
}

function isImageFilePart(part: Part): part is Part & FilePart {
  if (!isFilePart(part)) {
    return false
  }
  const mime = (part as FilePart).mime?.toLowerCase()
  return SUPPORTED_IMAGE_MIMES.has(mime)
}

export function createMessagesImageResizerHook(_ctx: PluginInput): MessagesTransformHook {
  return {
    "experimental.chat.messages.transform": async (input, output) => {
      const sessionID = input.sessionID
      if (sessionID) {
        const sessionModel = getSessionModel(sessionID)
        if (sessionModel?.providerID !== "anthropic") {
          return
        }
      }

      const messages = output.messages
      if (!messages || messages.length === 0) {
        return
      }

      let resizedCount = 0

      for (const message of messages) {
        if (message.info.role !== "user") {
          continue
        }

        const parts = message.parts
        if (!parts || parts.length === 0) {
          continue
        }

        for (const part of parts) {
          if (!isImageFilePart(part)) {
            continue
          }

          const filePart = part as unknown as FilePart
          const url = filePart.url
          const mime = filePart.mime

          if (!url || !url.startsWith("data:")) {
            continue
          }

          try {
            const dimensions = parseImageDimensions(url, mime)
            if (!dimensions) {
              continue
            }

            const needsResize =
              dimensions.width > ANTHROPIC_MULTI_IMAGE_MAX_DIMENSION ||
              dimensions.height > ANTHROPIC_MULTI_IMAGE_MAX_DIMENSION

            if (!needsResize) {
              continue
            }

            const targetDims = calculateTargetDimensions(
              dimensions.width,
              dimensions.height,
              ANTHROPIC_MULTI_IMAGE_MAX_DIMENSION
            )

            if (!targetDims) {
              continue
            }

            log("[messages-image-resizer] Resizing image", {
              filename: filePart.filename,
              original: `${dimensions.width}x${dimensions.height}`,
              target: `${targetDims.width}x${targetDims.height}`,
            })

            const resizedResult = await resizeImage(url, mime, targetDims)
            if (resizedResult) {
              filePart.url = resizedResult.resizedDataUrl
              resizedCount++

              log("[messages-image-resizer] Image resized successfully", {
                filename: filePart.filename,
                original: `${resizedResult.original.width}x${resizedResult.original.height}`,
                resized: `${resizedResult.resized.width}x${resizedResult.resized.height}`,
              })
            }
          } catch (error) {
            log("[messages-image-resizer] Failed to process image", {
              error: error instanceof Error ? error.message : String(error),
              filename: filePart.filename,
            })
          }
        }
      }

      if (resizedCount > 0) {
        log("[messages-image-resizer] Resized images total", { count: resizedCount })
      }
    },
  }
}
