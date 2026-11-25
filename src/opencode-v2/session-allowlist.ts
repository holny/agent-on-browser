export interface SessionGate {
  has(sessionID: string | undefined): boolean;
}

export class SessionAllowlist implements SessionGate {
  #sessions = new Set<string>();

  add(sessionID: string): void {
    this.#sessions.add(sessionID);
  }

  remove(sessionID: string): void {
    this.#sessions.delete(sessionID);
  }

  has(sessionID: string | undefined): boolean {
    return sessionID !== undefined && this.#sessions.has(sessionID);
  }

  clear(): void {
    this.#sessions.clear();
  }

  get size(): number {
    return this.#sessions.size;
  }
}
