import type { EmbeddingService } from './embedding.service';

/** For services that only fire embedding after a save; records the issue ids it was handed. */
export class FakeEmbeddings {
  readonly calls: string[][] = [];

  embedIssuesInBackground(issueIds: string[]): Promise<void> {
    this.calls.push(issueIds);
    return Promise.resolve();
  }

  asService(): EmbeddingService {
    return this as unknown as EmbeddingService;
  }
}
