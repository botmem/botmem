/** A replaceable browser timer with one explicit lifecycle owner. */
export class OneShotTimer {
  private timer: ReturnType<typeof setTimeout> | undefined;

  schedule(delay: number, callback: () => void): void {
    this.cancel();
    this.timer = setTimeout(callback, delay);
  }

  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
