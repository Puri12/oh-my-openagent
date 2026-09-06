// The omo plugin version this process runs. A remote omo advertises the same value in its agent
// card (params.pluginVersion of the omo-remote extension), and the remote runner refuses a host
// whose major differs. The literal is kept in lockstep with packages/omo-senpi/package.json by
// plugin-version.test.ts; OMO_PLUGIN_VERSION (set by the native launcher) wins when present so a
// compiled binary reports the version it was actually built from.
const PACKAGE_VERSION = "5.0.0-beta.43"

export function omoPluginVersion(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.OMO_PLUGIN_VERSION
  return fromEnv === undefined || fromEnv.length === 0 ? PACKAGE_VERSION : fromEnv
}

export { PACKAGE_VERSION as OMO_PLUGIN_PACKAGE_VERSION }
