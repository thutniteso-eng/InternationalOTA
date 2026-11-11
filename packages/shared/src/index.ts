export interface PlatformInfo {
  readonly name: string;
  readonly tagline: string;
}

export function formatPlatformGreeting(info: PlatformInfo): string {
  return `${info.name} — ${info.tagline}`;
}
