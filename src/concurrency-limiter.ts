export class ConcurrencyLimiter {
  private inFlight = 0;

  constructor(private readonly max: number) {}

  tryAcquire(): boolean {
    if (this.inFlight >= this.max) return false;
    this.inFlight++;
    return true;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}
