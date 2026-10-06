// 入力と出来事の待ちは、子の寿命と独立して保持する。
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private wake?: () => void;
  private ended = false;
  push(value: T): void {
    if (this.ended) throw new Error("Queue is closed");
    this.values.push(value);
    this.wake?.();
    this.wake = undefined;
  }
  end(): void { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (!this.ended || this.values.length) {
      if (this.values.length) yield this.values.shift()!;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}
