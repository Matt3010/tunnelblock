export function parseAllowedUserIds(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map(value => value.trim())
      .filter(Boolean),
  );
}

export function isAllowedUser(allowed: Set<string>, userId?: number): boolean {
  return typeof userId === "number" && allowed.has(String(userId));
}

export function isPrivateChat(chatType?: string): boolean {
  return chatType === "private";
}
