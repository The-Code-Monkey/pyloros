export const LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
] as const;

export type LifecycleScript = (typeof LIFECYCLE_SCRIPTS)[number];

export function isLifecycleScript(name: string): name is LifecycleScript {
  return (LIFECYCLE_SCRIPTS as readonly string[]).includes(name);
}

export function lifecycleScripts(
  declared: readonly string[],
): LifecycleScript[] {
  return LIFECYCLE_SCRIPTS.filter((name) => declared.includes(name));
}
