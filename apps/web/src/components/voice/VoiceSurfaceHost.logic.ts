export class VoiceSurfacePortalMount {
  readonly container: HTMLDivElement;
  #target: HTMLDivElement | null = null;

  constructor(container: HTMLDivElement) {
    this.container = container;
  }

  attach(target: HTMLDivElement): void {
    this.#target = target;
    target.append(this.container);
  }

  detach(target: HTMLDivElement): boolean {
    if (this.#target !== target) return false;
    this.#target = null;
    this.container.remove();
    return true;
  }

  dispose(): void {
    this.#target = null;
    this.container.remove();
  }
}
