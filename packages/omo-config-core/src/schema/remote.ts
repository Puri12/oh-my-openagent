import * as z from "zod"

export const OmoRemoteKindSchema = z.enum(["omo", "a2a"])

export const OmoRemoteWorkspaceSchema = z.object({
  repo: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
}).strict()

const OmoHttpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol
  return protocol === "http:" || protocol === "https:"
}, "url must use http or https")

const OmoRemoteNameSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/)

const OmoRemoteConfigShape = {
  url: OmoHttpUrlSchema,
  kind: OmoRemoteKindSchema,
  enabled: z.boolean(),
  description: z.string().optional(),
  tokenFile: z.string().min(1).optional(),
  bearerTokenEnv: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  capabilities: z.array(z.string().min(1)),
  slots: z.number().int().min(1),
  categories: z.array(z.string().min(1)),
  workspace: OmoRemoteWorkspaceSchema.optional(),
  tags: z.array(z.string().min(1)),
}

export const OmoRemoteConfigLayerSchema = z.object(OmoRemoteConfigShape).partial().strict()

export const OmoRemoteConfigSchema = OmoRemoteConfigLayerSchema.extend({
  url: OmoHttpUrlSchema,
  kind: OmoRemoteKindSchema.default("omo"),
  enabled: z.boolean().default(true),
  capabilities: z.array(z.string().min(1)).default([]),
  slots: z.number().int().min(1).default(1),
  categories: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().min(1)).default([]),
}).strict()

export const OmoRemotesConfigSchema = z.record(OmoRemoteNameSchema, OmoRemoteConfigSchema)
export const OmoRemotesConfigLayerSchema = z.record(OmoRemoteNameSchema, OmoRemoteConfigLayerSchema)

export type OmoRemoteKind = z.infer<typeof OmoRemoteKindSchema>
export type OmoRemoteConfig = z.infer<typeof OmoRemoteConfigSchema>
export type OmoRemotesConfig = z.infer<typeof OmoRemotesConfigSchema>
